/**
 * Abstract base class for all Zigbee devices.
 *
 * Provides Origin-based state provenance (`unknown` -> `automation` | `human`).
 * Policy: ONLY autonomous rule-engine actions are attributed as "automation";
 * every other actor -- physical remotes, YAML interactions, Home Assistant /
 * zigbee2mqtt UI, unmodeled wall switches, AND AI chat commands (a person gave
 * the AI the order) -- counts as "human" interaction. Attribution is driven by
 * {@link CommandCorrelator} causality tokens plus a motion-stall watchdog; the
 * origin is persisted alongside cached state so it survives restarts. Also
 * provides MQTT subscription lifecycle management and unified logging helpers.
 *
 * Subclasses: {@link ../type/sensor.js}, {@link ../type/mechanism.js},
 *   {@link ../type/remote.js}, {@link ../type/bridge.js}, {@link ../type/dummy.js}
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import CacheService from '../../service/cacheService.js'
import ConfigService from '../../service/configService.js'
import EventBus from '../../service/eventBus.js'
import LoggerService from '../../service/loggerService.js'
import DeviceStateOrigin from '../../enum/deviceStateOrigin.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'
import { slugify } from '../../lib/string.js'
import temporal from '../../lib/date.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default echo window (ms) for instant commands (ON/OFF/TOGGLE).
 * Zigbee2MQTT state confirmations typically arrive within 500ms-3s; this covers
 * network latency and broker reconnects while keeping the attribution window
 * short enough that a later manual toggle is not mistaken for our own
 * confirmation. Override with `ai_echo_window_instant_ms` in main config.
 * @type {number}
 */
const INSTANT_ECHO_WINDOW_DEFAULT_MS = 15_000

/**
 * Default echo window (ms) for travel commands (OPEN/CLOSE/POS:N/STOP).
 * Roller shutters take ~40-60 seconds to complete full travel, so the token
 * must outlive the whole motion -- forward-progress reports keep refreshing it
 * until the target is reached or an external override is detected. Override
 * with `ai_echo_window_travel_ms` in main config.
 * @type {number}
 */
const TRAVEL_ECHO_WINDOW_DEFAULT_MS = 90_000

/**
 * Watchdog timeout (ms): if a commanded OPEN/CLOSE/POS:N motion shows no
 * forward progress for this long, the movement is presumed to have been stopped
 * externally (e.g., wall-switch STOP on an unmodeled device) and origin flips
 * to human immediately. Forward-progress reports re-arm the watchdog. Override
 * with `ai_motion_stall_timeout_ms` in main config.
 * @type {number}
 */
const MOTION_STALL_TIMEOUT_DEFAULT_MS = 20_000

/**
 * Settle-absorption window (ms): after an echo confirms a travel outcome, follow-up
 * reports belonging to the SAME physical event (motor-status label churn such as
 * OPEN -> STOP as the motor idles, small overshoot wobble around the achieved point)
 * are absorbed instead of being misread as external input. Any motion beyond the
 * settle-wobble tolerance exits absorption immediately and is classified normally,
 * so a genuine human action right after completion is still caught in one report.
 * Override with `ai_settle_absorb_window_ms` in main config.
 * @type {number}
 */
const SETTLE_ABSORB_WINDOW_DEFAULT_MS = 10_000

/**
 * Backoff (ms) before re-dispatching the identical automated command after it
 * produced no observable response at all (offline/faulty device). Prevents hammering
 * a dead actuator every tick while never giving up permanently -- any real state
 * change on the device clears the backoff early. Override with
 * `ai_failed_command_backoff_ms` in main config.
 * @type {number}
 */
const FAILED_COMMAND_BACKOFF_DEFAULT_MS = 10 * 60_000

/**
 * Hard cap (ms) on total lifetime of any causality token, even while
 * continuation reports keep refreshing it. Prevents indefinite automation
 * attribution when a faulty motor keeps reporting micro-movements forever.
 * @type {number}
 */
const MAX_TOKEN_LIFETIME_MS = 600_000

/**
 * Maximum position (%) still considered "fully open" for echo matching.
 * @type {number}
 */
const OPEN_ECHO_POSITION_MIN = 90

/**
 * Minimum position (%) still considered "fully closed" for echo matching.
 * @type {number}
 */
const CLOSED_ECHO_POSITION_MAX = 10

/**
 * Maximum drift from the stop anchor position (%) still attributable to motor
 * inertia after an automated STOP command; beyond this something else moved
 * the device without our say-so.
 * @type {number}
 */
const STOP_DRIFT_TOLERANCE = 5

/**
 * Maximum positional deviation (%) from a just-confirmed travel outcome still
 * attributable to motor settling/inertia rather than an external actor. Larger
 * deviations exit settle-absorption immediately and are classified normally.
 * @type {number}
 */
const SETTLE_WOBBLE_TOLERANCE = 5

/**
 * Suffix appended to the device cache key for the persisted in-flight
 * automation marker that survives restarts.
 * @type {string}
 */
const PENDING_MARKER_KEY_SUFFIX = ':pending'

/**
 * Fallback duration (seconds) for the human-interaction cooldown applied to a
 * device, used only when main config omits or misconfigures
 * `human_interaction_cooldown_ms`. Mirrors DEFAULT_HUMAN_INTERACTION_COOLDOWN_MS
 * from AutomationBase (15 minutes). Written as the Redis cooldown key TTL so
 * automations can check remaining time via getHumanCooldownRemaining().
 * @type {number}
 */
const HUMAN_INTERACTION_COOLDOWN_SECONDS = 15 * 60

/**
 * Position tolerance threshold for matching roller shutter positions.
 * @type {number}
 */
const POSITION_MATCH_TOLERANCE = 2

/**
 * Threshold for "nearly fully open" roller shutter position comparison.
 * @type {number}
 */
const POSITION_NEARLY_OPEN_THRESHOLD = 98

/**
 * Threshold for "nearly fully closed" roller shutter position comparison.
 * @type {number}
 */
const POSITION_NEARLY_CLOSED_THRESHOLD = 2

/**
 * Minimum meaningful illuminance change (lux).
 * @type {number}
 */
const ILLUMINANCE_CHANGE_THRESHOLD = 500

/**
 * Minimum meaningful temperature change (degrees Celsius).
 * @type {number}
 */
const TEMPERATURE_CHANGE_THRESHOLD = 0.5

/**
 * Minimum meaningful humidity change (%).
 * @type {number}
 */
const HUMIDITY_CHANGE_THRESHOLD = 1

/**
 * Maximum length for truncated log summaries.
 * @type {number}
 */
const SUMMARY_TRUNCATE_LENGTH = 80

// ---------------------------------------------------------------------------
// CommandCorrelator -- causality tokens for outgoing rule-engine commands
// ---------------------------------------------------------------------------

/**
 * Tracks at most one in-flight expectation per device -- the most recent
 * command issued by the RULE ENGINE -- and classifies incoming MQTT reports
 * against it.
 *
 * Policy: only autonomous rule-engine actions are attributed to automation.
 * Human-directed commands (remotes, interactions, AI chat) never register a
 * token here; they cancel any pending token instead. A live token is therefore
 * unambiguous evidence that the current motion was started by an automation,
 * and anything contradicting it is by definition external (human) intervention.
 *
 * Verdicts returned by {@link matchEcho}:
 *   'echo'         - report confirms the commanded outcome; token consumed
 *   'continuation' - report shows the commanded motion still progressing;
 *                    token kept alive (expiry refreshed up to MAX_TOKEN_LIFETIME_MS)
 *   'conflict'     - report contradicts the commanded motion (reversal or large
 *                    drift after STOP); token discarded
 *   null           - no live token, or the token has no opinion on this report
 */
class CommandCorrelator {

    /**
     * Active expectation, if any.
     * @type {{token: string, expectedState: string, kind: ('instant'|'travel'|'wildcard'), direction: (number|null), anchorPosition: (number|null), anchorState: (string|null), lastSeenPosition: (number|null), settleCount: number, ttlMs: number, issuedAt: number, expiresAt: number}|null}
     */
    #active = null

    /** Monotonic counter for unique token ids. @type {number} */
    #counter = 0

    /**
     * Short-lived settling snapshot started when a positional echo confirms a travel
     * outcome; absorbs tail reports of the same physical event so motor-status churn
     * at a fixed point is not misread as external input.
     * @type {{position: number, expiresAt: number}|null}
     */
    #settling = null

    // -- Public API -------------------------------------------------------

    /**
     * Register an outgoing rule-engine command as the new active expectation,
     * replacing any previous one (the latest command defines what we expect).
     *
     * @param {string} expectedState - Normalized description: ON/OFF/OPEN/CLOSE/STOP/TOGGLE or "POS:N"
     * @param {Object} [options] - Registration context captured at dispatch time
     * @param {'instant'|'travel'|'wildcard'} [options.kind='instant'] - Command family
     * @param {number|null} [options.anchorPosition=null] - Device position (%) at registration time
     * @param {string|null} [options.anchorState=null] - State label at registration time (used by wildcard)
     * @param {number} ttlMs - Lifetime of the expectation in milliseconds
     * @returns {string} A unique correlation token id
     */
    register(expectedState, options = {}, ttlMs) {
        const now = Date.now()
        const lifetime = Math.max(1_000, Number(ttlMs) || 0)
        this.#active = {
            token: `cmd-${now}-${++this.#counter}`,
            expectedState: String(expectedState ?? '').toUpperCase(),
            kind: options?.kind ?? 'instant',
            direction: null, // computed below once the anchor is normalized
            anchorPosition: Number.isFinite(options?.anchorPosition) ? options.anchorPosition : null,
            anchorState: options?.anchorState != null ? String(options.anchorState).toUpperCase() : null,
            lastSeenPosition: null,
            settleCount: 0,
            ttlMs: lifetime,
            issuedAt: now,
            expiresAt: now + lifetime
        }
        this.#active.direction = this.#directionFor(this.#active.expectedState, this.#active.anchorPosition)
        return this.#active.token
    }

    /**
     * Classify an incoming MQTT payload against the active expectation.
     *
     * Side effects: 'echo' and 'conflict' discard the token; 'continuation'
     * refreshes its expiry (capped at MAX_TOKEN_LIFETIME_MS from issuance) and
     * advances its progress reference point.
     *
     * @param {*} payload - Parsed MQTT message payload (object or raw string)
     * @returns {'echo'|'continuation'|'conflict'|null} Verdict for the caller's decision tree
     */
    matchEcho(payload) {
        if (!this.hasActive()) return null

        const verdict = this.#evaluate(this.#active, payload)
        switch (verdict) {
            case 'echo':
                this.#active = null
                break
            case 'conflict':
                this.#active = null
                break
            case 'continuation': {
                // Refresh lifetime while motion genuinely continues, but never beyond the hard cap.
                const now = Date.now()
                this.#active.expiresAt = Math.min(now + this.#active.ttlMs, this.#active.issuedAt + MAX_TOKEN_LIFETIME_MS)
                break
            }
            default:
                break
        }
        return verdict
    }

    /**
     * Is there a non-expired active expectation? Expired tokens are dropped lazily.
     * @returns {boolean}
     */
    hasActive() {
        if (!this.#active) return false
        if (Date.now() > this.#active.expiresAt) {
            this.#active = null
            return false
        }
        return true
    }

    /**
     * Kind of the live token without consuming or mutating it.
     * @returns {'instant'|'travel'|'wildcard'|null}
     */
    getActiveKind() {
        return this.hasActive() ? this.#active.kind : null
    }

    /**
     * Snapshot of the live token for logging and watchdog decisions.
     * `progressObserved` tells whether any forward-motion report was ever seen since
     * dispatch -- the stall watchdog uses it to distinguish "someone stopped our
     * motion" (flip to human) from "the device never responded at all" (do NOT blame
     * a person).
     * @returns {{expectedState: string, kind: ('instant'|'travel'|'wildcard'), progressObserved: boolean}|null}
     */
    getActiveToken() {
        return this.hasActive()
            ? { expectedState: this.#active.expectedState, kind: this.#active.kind, progressObserved: this.#active.lastSeenPosition != null }
            : null
    }

    /**
     * Discard any pending expectation -- called when a human-directed command is
     * dispatched so stale automation echoes can no longer be misattributed.
     */
    cancelAll() {
        this.#active = null
    }

    // -----------------------------------------------------------------------
    // Settle absorption (post-completion tail handling)
    // -----------------------------------------------------------------------

    /**
     * Start a short-lived settling snapshot after an echo confirmed a travel outcome.
     * Only positional echoes should start it -- label-only outcomes keep legacy rules.
     * @param {number} position - achieved/settled position (%) from the confirming report
     * @param {number} windowMs - how long tail reports are absorbed (lazy expiry, no timer)
     */
    beginSettling(position, windowMs) {
        const ms = Number(windowMs) > 0 ? Math.min(Number(windowMs), MAX_TOKEN_LIFETIME_MS) : SETTLE_ABSORB_WINDOW_DEFAULT_MS
        this.#settling = { position, expiresAt: Date.now() + ms }
    }

    /**
     * Whether the settle-absorption window is still active (lazily expired).
     * @returns {boolean} true while post-completion tail reports may be absorbed
     */
    isSettling() {
        if (!this.#settling) return false
        if (Date.now() > this.#settling.expiresAt) {
            this.#settling = null
            return false
        }
        return true
    }

    /**
     * Attempt to absorb a follow-up report as part of the just-confirmed outcome's tail.
     * Returns true when the report belongs to our own event and must NOT change
     * attribution: label-only churn at a known settled point, or positional wobble
     * within SETTLE_WOBBLE_TOLERANCE around it. Any larger motion returns false so the
     * caller classifies normally (and clears settling via markHumanInteraction).
     * @param {*} payload - parsed state report
     * @returns {boolean} true when the report was classified as settling-tail noise
     */
    absorbPostCompletionReport(payload) {
        if (!this.isSettling()) return false
        const pos = payload && typeof payload === 'object' && Number.isFinite(payload.position) ? payload.position : null
        if (pos == null) return true // settled position is known; pure label/status churn -> absorb
        return Math.abs(pos - this.#settling.position) <= SETTLE_WOBBLE_TOLERANCE
    }

    /** Drop any active settling snapshot (e.g., after an external actor moved the device). */
    clearSettling() {
        this.#settling = null
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Expected direction of travel implied by the commanded state relative to
     * the anchor position. +1 = position must increase, -1 = decrease,
     * null = no directional expectation (STOP, instant, unknown).
     *
     * @param {string} state - Normalized expected state
     * @param {number|null} anchorPosition - Position at registration time
     * @returns {number|null}
     * @private
     */
    #directionFor(state, anchorPosition) {
        if (state === 'OPEN') return 1
        if (state === 'CLOSE') return -1
        if (state.startsWith('POS:') && Number.isFinite(anchorPosition)) {
            const target = parseInt(state.substring(4), 10)
            if (!isNaN(target)) {
                if (target > anchorPosition + POSITION_MATCH_TOLERANCE) return 1
                if (target < anchorPosition - POSITION_MATCH_TOLERANCE) return -1
            }
        }
        return null
    }

    /**
     * Evaluate one payload against the active token.
     *
     * @param {{expectedState: string, kind: ('instant'|'travel'|'wildcard'), direction: (number|null), anchorPosition: (number|null)}} token
     * @param {*} payload - Parsed MQTT payload
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private
     */
    #evaluate(token, payload) {
        if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null

        const reportedState = payload.state != null ? String(payload.state).toUpperCase() : null
        const position = Number.isFinite(payload.position) ? payload.position : null

        switch (token.kind) {
            case 'wildcard':
                return this.#matchWildcard(token, reportedState, position)
            case 'travel':
                return token.expectedState === 'STOP'
                    ? this.#matchStop(token, reportedState, position)
                    : this.#matchTravel(token, reportedState, position)
            default: // instant (ON/OFF)
                return reportedState === token.expectedState ? 'echo' : null
        }
    }

    /**
     * TOGGLE wildcard: consumed by the first report that actually differs from
     * the pre-command snapshot. Identical periodic reports do NOT consume it.
     *
     * @param {{anchorPosition: (number|null), anchorState: (string|null)}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|null}
     * @private
     */
    #matchWildcard(token, reportedState, position) {
        if (reportedState == null && position == null) return null
        if (position != null && Number.isFinite(token.anchorPosition)) {
            return Math.abs(position - token.anchorPosition) > POSITION_MATCH_TOLERANCE ? 'echo' : null
        }
        if (reportedState != null) {
            return token.anchorState == null || reportedState !== token.anchorState ? 'echo' : null
        }
        return null
    }

    /**
     * OPEN/CLOSE/POS:N travel matching with directional progress detection.
     * Positional evidence takes precedence over label aliases so a contradictory
     * position can never be papered over by a stale state label.
     *
     * @param {{expectedState: string, direction: (number|null), anchorPosition: (number|null), lastSeenPosition: (number|null)}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private
     */
    #matchTravel(token, reportedState, position) {
        const expected = token.expectedState
        const targetPos = expected.startsWith('POS:') ? parseInt(expected.substring(4), 10) : null

        if (position != null) {
            // Terminal / exact-target matches first.
            if (targetPos != null && !isNaN(targetPos) && Math.abs(position - targetPos) <= POSITION_MATCH_TOLERANCE) {
                return 'echo'
            }
            if (expected === 'CLOSE' && position <= CLOSED_ECHO_POSITION_MAX) return 'echo'
            if (expected === 'OPEN' && position >= OPEN_ECHO_POSITION_MIN) return 'echo'

            const reference = token.lastSeenPosition ?? token.anchorPosition
            if (reference != null && token.direction != null) {
                const signedDelta = token.direction * (position - reference)
                if (signedDelta > POSITION_MATCH_TOLERANCE) {
                    this.#noteProgress(token, position)
                    return 'continuation'
                }
                if (signedDelta < -POSITION_MATCH_TOLERANCE) return 'conflict'
                if (this.#isCloserToTarget(token, position, reference)) {
                    // Slow creep: each step stays within jitter tolerance but the device is
                    // steadily approaching its target -- still our motion.
                    this.#noteProgress(token, position)
                    return 'continuation'
                }
            }
            // Jitter around a fixed point -- no opinion; the watchdog decides later
            // whether the motion truly stalled without progress.
            return null
        }

        // Label-only report: accept direct or aliased terminal labels.
        //   CLOSE command -> device may echo {state:'OFF'}
        //   OPEN  command -> device may echo {state:'ON'}
        if (reportedState == null) return null
        if (reportedState === expected) return 'echo'
        if ((expected === 'CLOSE' && reportedState === 'OFF') || (expected === 'OPEN' && reportedState === 'ON')) return 'echo'
        return null
    }

    /**
     * STOP matching: an explicit state='STOP' confirms it; otherwise small drift
     * from the stop anchor is motor inertia ('continuation'), two consecutive
     * settled reports mean the stop achieved as intended ('echo'), and any
     * significant movement means something else drove the device ('conflict').
     *
     * @param {{anchorPosition: (number|null), lastSeenPosition: (number|null), settleCount: number}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private
     */
    #matchStop(token, reportedState, position) {
        if (reportedState === 'STOP') return 'echo'
        if (position != null && Number.isFinite(token.anchorPosition)) {
            const drift = Math.abs(position - token.anchorPosition)
            if (drift > STOP_DRIFT_TOLERANCE) return 'conflict'

            const reference = token.lastSeenPosition ?? token.anchorPosition
            const step = Math.abs(position - reference)
            token.lastSeenPosition = position
            if (step <= POSITION_MATCH_TOLERANCE) {
                token.settleCount += 1
                if (token.settleCount >= 2) return 'echo' // settled -- stop achieved
            } else {
                token.settleCount = 1 // still decelerating
            }
            return 'continuation'
        }
        return null
    }

    /**
     * Record forward progress: advance the reference point so subsequent deltas
     * are measured from here.
     *
     * @param {{lastSeenPosition: (number|null), settleCount: number}} token
     * @param {number} position
     * @private
     */
    #noteProgress(token, position) {
        token.lastSeenPosition = position
        token.settleCount = 0
    }

    /**
     * Is `position` strictly closer to the commanded end state than `reference`?
     * Used for slow-creep detection when per-step deltas stay within jitter tolerance.
     *
     * @param {{expectedState: string}} token
     * @param {number} position
     * @param {number} reference
     * @returns {boolean}
     * @private
     */
    #isCloserToTarget(token, position, reference) {
        const expected = token.expectedState
        if (expected === 'OPEN') return position > reference
        if (expected === 'CLOSE') return position < reference
        if (expected.startsWith('POS:')) {
            const target = parseInt(expected.substring(4), 10)
            if (isNaN(target)) return false
            return Math.abs(position - target) < Math.abs(reference - target)
        }
        return false
    }
}

// ---------------------------------------------------------------------------
// DeviceBase (abstract)
// ---------------------------------------------------------------------------

/**
 * Device defaults. All device types extend this class.
 */
export default class DeviceBase {

    // -- Private state ----------------------------------------------------

    /** Device display name (e.g., `"Living Room Light"`) */
    #name = ''
    /** Zigbee2MQTT device ID or friendly-name slug */
    #id = ''
    /** Raw device configuration data from zigbee.yaml */
    #data = {}
    /** Last known state payload from MQTT (e.g., `{state: 'ON', position: 45}`) */
    #stateLast = {}
    /** Provenance of current state: `unknown`, `automation`, or `human` */
    #stateOrigin = DeviceStateOrigin.UNKNOWN
    /** ISO-8601 timestamp of last state change, or `null` on first boot */
    #stateLastAt = null
    /** Tracks the single in-flight rule-engine expectation for override detection */
    #correlator = new CommandCorrelator()
    /** Watchdog timer handle detecting externally-stalled automated motion */
    #stallTimer = null

    /**
     * Retry-backoff metadata for the last automated command that produced no observable
     * response; receiveCommand suppresses identical descriptions until `until` or until a
     * real state change clears it.
     * @type {{description: string, positionAtFailure: (number|null), until: number}|null}
     */
    #failedCommand = null
    /** Redis cache key: `"zigbeedevice:<slug>:<id>"` */
    #cacheKey = ''
    /** Reference to shared {@link ../../service/mqttService.js} singleton */
    #mqttService = null
    /** Array of unsubscribe functions returned by MqttService.subscribe() */
    #subscriptions = []
    /** Set of already-subscribed topic strings (prevents double-subscription) */
    #subscribedTopics = new Set()
    /** Custom event listeners map (eventType -> callback[]) */
    #eventListeners = new Map()

    // -- Constructor ------------------------------------------------------

    /**
     * Construct a device instance.
     *
     * @param {string} name - Device display name from zigbee.yaml config
     * @param {string} id - Zigbee2MQTT friendly-name or device ID
     * @param {Record<string, unknown>} [data] - Raw device configuration object
     */
    constructor(name, id, data) {
        if (this.constructor === DeviceBase) {
            throw new Error('Abstract classes cannot be instantiated.')
        }

        this.#name = name
        this.#id = id
        this.#data = data
        this.#cacheKey = this.#generateCacheKey(name, id)
    }

    // -- Lifecycle --------------------------------------------------------

    /**
     * Async initialization called after construction.
     * Loads cached state from Redis into local variables.
     * Subclasses may override to add their own init logic.
     */
    async init() {
        const cached = await this.getCachedState()
        if (cached) {
            this.#stateLast = cached.stateLast ?? {}
            this.#stateLastAt = cached.stateLastAt ?? null
            this.#stateOrigin = cached.stateOrigin ?? DeviceStateOrigin.UNKNOWN
            LoggerService.debug(
                `Restored state from cache (origin=${this.#stateOrigin})`,
                `${this.getLogPrefix()}:${this.#name}`
            )
        }

        // Restore an in-flight automation expectation that survived a restart so
        // echoes of a pre-restart rule-engine command keep their attribution and
        // external overrides remain detectable. Devices that do not track origin
        // never persist one; expired markers self-clean via Redis TTL.
        if (this.shouldTrackOrigin()) {
            const marker = await CacheService.get(this.#pendingMarkerKey())
            if (marker && typeof marker.expectedState === 'string' && Number.isFinite(marker.expiresAt) && marker.expiresAt > Date.now()) {
                const ttlMs = Math.max(1_000, marker.expiresAt - Date.now())
                this.#correlator.register(marker.expectedState, {
                    kind: marker.kind ?? 'instant',
                    anchorPosition: marker.anchorPosition ?? null,
                    anchorState: marker.anchorState ?? null
                }, ttlMs)
                LoggerService.debug(`Restored in-flight automation token (${marker.expectedState})`, `${this.getLogPrefix()}:${this.#name}`)
                this.#armMotionWatchdog()
            }
        }
    }

    // -- Identity accessors -----------------------------------------------

    /**
     * Get device name.
     * @returns {string}
     */
    getName() {
        return this.#name
    }

    /**
     * Get device ID.
     * @returns {string}
     */
    getId() {
        return this.#id
    }

    // -- Cache accessors --------------------------------------------------

    /**
     * Generate a unique cache key for this device.
     * Uses slugify for consistent naming and prefixes with "zigbeedevice".
     *
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @returns {string} Cache key
     * @private
     */
    #generateCacheKey(name, id) {
        return `zigbeedevice:${slugify(name)}:${id}`
    }

    /**
     * Get the cache key for this device.
     * @returns {string}
     */
    getCacheKey() {
        return this.#cacheKey
    }

    /**
     * Retrieve persisted device state from Redis cache.
     *
     * @returns {Promise<{stateLast: Record<string,unknown>, stateLastAt: string|null, stateOrigin: string}|undefined>}
     */
    async getCachedState() {
        return await CacheService.get(this.#cacheKey)
    }

    /**
     * Persist device state to Redis cache.
     *
     * @param {Record<string, unknown>} state - Latest MQTT payload or computed state object
     * @param {object} [options] - Optional overrides
     * @param {string} [options.stateLastAt] - Explicit ISO-8601 timestamp (defaults to `now`)
     * @param {'unknown'|'automation'|'human'} [options.origin] - Explicit provenance override
     * @returns {Promise<boolean>} `true` on success
     */
    async setCachedState(state, options = {}) {
        this.#stateLast = state
        this.#stateLastAt = options.stateLastAt || new Date().toISOString()

        if (options.origin) {
            this.#stateOrigin = options.origin
        }

        const payload = {
            stateLast: this.#stateLast,
            stateLastAt: this.#stateLastAt,
            stateOrigin: this.#stateOrigin
        }
        return await CacheService.set(this.#cacheKey, payload)
    }

    // -- State tracking accessors -----------------------------------------

    /**
     * Retrieve the most recent MQTT payload for this device.
     *
     * @returns {Record<string, unknown>} Last known state object
     */
    getStateLast() {
        return this.#stateLast
    }

    /**
     * Get the timestamp of the last state change (by anyone).
     * @returns {string|null} ISO timestamp or null if unknown
     */
    getStateLastAt() {
        return this.#stateLastAt
    }

    /**
     * Get the origin of the current state.
     * Returns 'unknown', 'automation', or 'human'.
     *
     * This is the single source of truth for determining who caused the
     * current device state. Unlike the old timestamp-comparison approach,
     * this is explicit, deterministic, and survives restarts.
     *
     * @returns {string} One of DeviceStateOrigin.UNKNOWN, .AUTOMATION, .HUMAN
     */
    getStateOrigin() {
        return this.#stateOrigin
    }

    /**
     * Whether this device participates in origin classification at all. Only
     * actuator devices whose state can be driven by both automations and humans
     * need it; sensors/remotes/bridges just cache payloads. Subclasses override
     * to opt in (see Mechanism).
     * @returns {boolean} false by default
     */
    shouldTrackOrigin() {
        return false
    }

    // -- Origin classification tuning --------------------------------------

    /**
     * Echo window for instant commands (ON/OFF/TOGGLE), read live from main config
     * (`ai_echo_window_instant_ms`) so the value can be tuned without code changes.
     * Missing values silently use INSTANT_ECHO_WINDOW_DEFAULT_MS; present but
     * invalid ones log a warning and fall back to that same default (fail-open).
     * @returns {number} Window in milliseconds (> 0)
     */
    getInstantEchoWindowMs() {
        return this.#durationFromConfig('ai_echo_window_instant_ms', INSTANT_ECHO_WINDOW_DEFAULT_MS)
    }

    /**
     * Echo window for travel commands (OPEN/CLOSE/POS:N/STOP); see
     * {@link getInstantEchoWindowMs} for resolution rules. Config key:
     * `ai_echo_window_travel_ms`.
     * @returns {number} Window in milliseconds (> 0)
     */
    getTravelEchoWindowMs() {
        return this.#durationFromConfig('ai_echo_window_travel_ms', TRAVEL_ECHO_WINDOW_DEFAULT_MS)
    }

    /**
     * Motion-stall watchdog timeout; see {@link getInstantEchoWindowMs} for
     * resolution rules. Config key: `ai_motion_stall_timeout_ms`.
     * @returns {number} Timeout in milliseconds (> 0)
     */
    getMotionStallTimeoutMs() {
        return this.#durationFromConfig('ai_motion_stall_timeout_ms', MOTION_STALL_TIMEOUT_DEFAULT_MS)
    }

    /**
     * Settle-absorption window (ms): how long follow-up reports of a just-confirmed travel
     * outcome are absorbed as the same physical event instead of being classified anew.
     * @returns {number} Window in milliseconds
     */
    getSettleAbsorbWindowMs() {
        return this.#durationFromConfig('ai_settle_absorb_window_ms', SETTLE_ABSORB_WINDOW_DEFAULT_MS)
    }

    /**
     * Backoff (ms) before re-dispatching an automated command that produced no observable
     * response, while the device state stays unchanged.
     * @returns {number} Backoff in milliseconds
     */
    getFailedCommandBackoffMs() {
        return this.#durationFromConfig('ai_failed_command_backoff_ms', FAILED_COMMAND_BACKOFF_DEFAULT_MS)
    }

    /**
     * Shared duration-config reader: accepts plain milliseconds or a human-readable
     * string ("30s", "25m", "1h") via temporal.parseDurationMs(). Missing values use
     * the default silently; invalid ones warn and fall back to it (fail-open).
     *
     * @private
     * @param {string} key - Main config key name
     * @param {number} defaultMs - Fallback value in milliseconds
     * @returns {number} Duration in milliseconds (> 0)
     */
    #durationFromConfig(key, defaultMs) {
        const raw = ConfigService.get(key)
        if (raw == null || raw === '') return defaultMs
        const ms = temporal.parseDurationMs(raw)
        if (ms == null || ms <= 0) {
            LoggerService.warn(
                `Invalid ${key} ${JSON.stringify(raw)} (expected e.g. "30s" or plain milliseconds); using default ${defaultMs}ms`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            return defaultMs
        }
        return Math.round(ms)
    }

    // -- Event emission ---------------------------------------------------

    /**
     * Emit an event with optional data.
     *
     * @param {string} eventType - The type of event to emit
     * @param {Object} [data={}] - Optional data to pass with the event
     */
    emit(eventType, data = {}) {
        if (eventType === 'mqttMessage') {
            this.handleMqttMessage(data)
        }

        const listeners = this.#eventListeners.get(eventType)
        if (listeners) {
            listeners.forEach(callback => callback(data))
        }
    }

    /**
     * Resolve the human-interaction cooldown duration in whole seconds for the
     * Redis cooldown key TTL. Reads `human_interaction_cooldown_ms` from main
     * config -- either legacy plain milliseconds or a human-readable duration
     * ("25m", "1h") via temporal.parseDurationMs(). Missing values silently fall back
     * to HUMAN_INTERACTION_COOLDOWN_SECONDS; present but invalid ones log a warning
     * and use the same fallback; an explicit zero disables the cooldown entirely
     * (returns 0, caller skips writing the key).
     * @private
     * @returns {number} Cooldown in whole seconds (>= 0)
     */
    #humanCooldownSeconds() {
        const raw = ConfigService.get('human_interaction_cooldown_ms')
        if (raw == null) return HUMAN_INTERACTION_COOLDOWN_SECONDS
        const ms = temporal.parseDurationMs(raw)
        if (ms == null || ms < 0) {
            LoggerService.warn(
                `Invalid human_interaction_cooldown_ms ${JSON.stringify(raw)} (expected e.g. "25m" or plain milliseconds); using default ${HUMAN_INTERACTION_COOLDOWN_SECONDS}s`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            return HUMAN_INTERACTION_COOLDOWN_SECONDS
        }
        return Math.max(0, Math.round(ms / 1000))
    }

    /**
     * Mark the device as human-controlled for a given payload: flip origin to
     * HUMAN (timestamped now), persist it, cancel any automation expectation and
     * watchdog, clear the persisted marker, and start the Redis cooldown so
     * automations back off from this device.
     * @private
     * @param {*} parsed - New state payload from MQTT
     * @param {string} reason - Why this is attributed to a human (for logs)
     * @param {'debug'|'warn'} [level='debug'] - Log level for the attribution line
     */
    #markHumanInteraction(parsed, reason, level = 'debug') {
        this.#stateLast = parsed
        this.#stateOrigin = DeviceStateOrigin.HUMAN
        if (level === 'warn') {
            LoggerService.warn(`Origin -> human (${reason})`, `${this.getLogPrefix()}:${this.#name}`)
        } else {
            LoggerService.debug(`Origin -> human (${reason})`, `${this.getLogPrefix()}:${this.#name}`)
        }
        this.setCachedState(parsed, {
            origin: DeviceStateOrigin.HUMAN
        }).catch(err => {
            this.log(`Failed to cache state: ${err.message}`, 'error')
        })
        this.#clearMotionWatchdog()
        this.#correlator.cancelAll()
        this.#correlator.clearSettling()
        // A genuine external change means the device moved -- allow ineffective-command retries again.
        this.#failedCommand = null
        this.#clearPendingCommandMarker()
        this.#writeHumanCooldown(reason)
    }

    /**
     * Start the Redis human-interaction cooldown for this device. Failures are
     * logged loudly -- a silent miss here means automations may fight the user.
     * A configured zero disables the cooldown entirely.
     * @private
     * @param {string} reason - Why the cooldown is starting (for logs)
     */
    #writeHumanCooldown(reason) {
        const cooldownSec = this.#humanCooldownSeconds()
        if (cooldownSec <= 0) {
            LoggerService.debug('Human interaction detected but cooldown disabled by config', `${this.getLogPrefix()}:${this.#name}`)
            return
        }
        CacheService.setHumanCooldown(slugify(this.#name), cooldownSec)
            .then(ok => {
                if (!ok) {
                    LoggerService.warn(
                        `Could not persist human cooldown (${reason}) -- Redis unavailable? Automations may not back off`,
                        `${this.getLogPrefix()}:${this.#name}`
                    )
                } else {
                    LoggerService.info(`Human interaction (${reason}) -- cooldown ${temporal.secondsToHumanReadable(cooldownSec)} started`, `${this.getLogPrefix()}:${this.#name}`)
                }
            })
            .catch(err => {
                LoggerService.error(`Failed to write human cooldown: ${err.message}`, `${this.getLogPrefix()}:${this.#name}`)
            })
    }

    /**
     * Redis key for the persisted in-flight automation expectation.
     * @private
     * @returns {string}
     */
    #pendingMarkerKey() {
        return this.#cacheKey + PENDING_MARKER_KEY_SUFFIX
    }

    /**
     * Persist the active correlator token so a restart mid-motion does not lose
     * attribution context. Best-effort with loud failure logging; the TTL mirrors
     * the token lifetime so markers self-clean even if never explicitly cleared.
     * @private
     * @param {string} description - Normalized command description (ON/OFF/OPEN/CLOSE/STOP/TOGGLE or "POS:N")
     * @param {'instant'|'travel'|'wildcard'} kind - Command family
     * @param {number} ttlMs - Token lifetime in milliseconds
     */
    #persistPendingCommandMarker(description, kind, ttlMs) {
        const marker = {
            expectedState: String(description ?? '').toUpperCase(),
            kind,
            anchorPosition: Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : null,
            anchorState: typeof this.#stateLast?.state === 'string' ? String(this.#stateLast.state).toUpperCase() : null,
            expiresAt: Date.now() + Math.max(1_000, Number(ttlMs) || 0)
        }
        CacheService.set(this.#pendingMarkerKey(), marker, Math.ceil(marker.expiresAt / 1000))
            .catch(err => {
                LoggerService.warn(`Could not persist in-flight automation marker: ${err.message}`, `${this.getLogPrefix()}:${this.#name}`)
            })
    }

    /**
     * Remove any persisted in-flight automation marker (best-effort cleanup; the
     * key may simply not exist yet).
     * @private
     */
    #clearPendingCommandMarker() {
        CacheService.delete(this.#pendingMarkerKey())
            .catch(err => {
                LoggerService.debug(`Could not clear in-flight automation marker: ${err.message}`, `${this.getLogPrefix()}:${this.#name}`)
            })
    }

    // -- Motion watchdog ----------------------------------------------------

    /**
     * Arm (or re-arm) the stall watchdog for an active travel expectation. Only
     * OPEN/CLOSE/POS:N commands expect continued motion; STOP/instant/wildcard do
     * not arm it. If the timer fires while the same expectation is still unresolved,
     * the outcome depends on whether ANY forward progress was observed since dispatch:
     *   - progress then halt -> something external stopped our motion (e.g., wall
     *     switch), so origin flips to human + cooldown.
     *   - zero progress      -> the device never responded at all (offline/faulty).
     *     Nothing a person could have stopped, so attribution is preserved and NO
     *     human cooldown is written; identical retries are backed off instead.
     * Forward-progress reports call this again to reset the clock.
     * @private
     */
    #armMotionWatchdog() {
        this.#clearMotionWatchdog()
        const token = this.#correlator.getActiveToken()
        if (!token || token.kind !== 'travel' || token.expectedState === 'STOP') return

        const timeoutMs = this.getMotionStallTimeoutMs()
        this.#stallTimer = setTimeout(() => {
            this.#stallTimer = null
            const live = this.#correlator.getActiveToken()
            if (!live || live.kind !== 'travel' || live.expectedState === 'STOP') return
            if (live.progressObserved) {
                this.#markHumanInteraction(
                    this.#stateLast,
                    `automated motion stalled before reaching target (${live.expectedState})`,
                    'warn'
                )
            } else {
                this.#handleNoResponseStall(live.expectedState)
            }
        }, timeoutMs)
        // Do not keep the process alive just for a watchdog.
        this.#stallTimer.unref?.()
    }

    /**
     * Handle an automated travel command that produced no observable response at all:
     * the device never moved, so there is nothing to attribute to a person. Discard the
     * token and pending marker WITHOUT touching origin or cooldowns, log a distinct
     * warning, and record retry-backoff metadata so receiveCommand can suppress identical
     * re-dispatches while the state stays unchanged.
     * @private
     * @param {string} expectedState - the commanded description (OPEN/CLOSE/POS:N)
     */
    #handleNoResponseStall(expectedState) {
        LoggerService.warn(
            `Automated command ${expectedState} produced no observable response -- possible offline/faulty device; backing off identical retries`,
            `${this.getLogPrefix()}:${this.#name}`
        )
        this.#correlator.cancelAll()
        this.#clearPendingCommandMarker()
        const pos = Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : null
        this.#failedCommand = {
            description: expectedState,
            positionAtFailure: pos,
            until: Date.now() + this.getFailedCommandBackoffMs()
        }
    }

    /**
     * Clear any armed stall watchdog.
     * @private
     */
    #clearMotionWatchdog() {
        if (this.#stallTimer != null) {
            clearTimeout(this.#stallTimer)
            this.#stallTimer = null
        }
    }

    /**
     * Map a normalized command description to its correlator family.
     * @private
     * @param {string} description - Normalized description (ON/OFF/OPEN/CLOSE/STOP/TOGGLE or "POS:N")
     * @returns {'instant'|'travel'|'wildcard'}
     */
    #commandKindFor(description) {
        const state = String(description ?? '').toUpperCase()
        if (state === 'OPEN' || state === 'CLOSE' || state === 'STOP' || state.startsWith('POS:')) return 'travel'
        if (state === 'TOGGLE') return 'wildcard'
        return 'instant'
    }

    // -- MQTT message handling --------------------------------------------

    /**
     * Handle incoming MQTT messages.
     *
     * Classification policy: a live causality token -- registered ONLY by
     * rule-engine commands in receiveCommand() -- is the sole evidence that
     * current activity is automation-driven. Everything else (unmatched changes,
     * contradictions of an active command, motion stalling mid-travel) is human
     * interaction and starts the Redis cooldown so automations back off.
     *
     * Decision tree for origin-tracking devices ({@link shouldTrackOrigin}):
     *   matchEcho -> 'echo'         : confirmed outcome of our own command; keep AUTOMATION
     *   matchEcho -> 'continuation' : commanded motion still progressing; keep AUTOMATION
     *   matchEcho -> 'conflict'     : external override detected; flip to HUMAN + cooldown
     *   no verdict + no change      : periodic report; cache payload only
     *   no verdict + changed        : HUMAN unless a travel expectation is still alive
     *
     * Non-origin-tracking devices (sensors, remotes, bridges) just refresh their
     * cached payload -- they are never automation targets, so classifying them as
     * "human" would be noise.
     *
     * @param {Object} data - Event data containing topic and message
     */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            LoggerService.debug(`Malformed JSON payload: ${data.message}`, `${this.getLogPrefix()}:${this.#name}`)
            parsed = data.message
        }

        if (!this.shouldTrackOrigin()) {
            // Payload-only refresh for non-actuator devices (sensors, remotes,
            // bridges): they are never automation targets, so classifying their
            // reports would only add noise. Origin stays untouched.
            const hadChange = this.#didStateChange(parsed)
            this.#stateLast = parsed
            this.setCachedState(parsed, {
                stateLastAt: hadChange ? new Date().toISOString() : this.#stateLastAt,
                origin: this.#stateOrigin
            }).catch(err => {
                this.log(`Failed to cache state: ${err.message}`, 'error')
            })
        } else {
            const verdict = this.#correlator.matchEcho(parsed)

            switch (verdict) {
                case 'echo': {
                    // Confirmed outcome of our own rule-engine command: keep AUTOMATION.
                    // Do NOT update stateLastAt -- it was set when the command was sent.
                    LoggerService.debug('Automation echo matched -- origin=automation', `${this.getLogPrefix()}:${this.#name}`)
                    this.#clearMotionWatchdog()
                    this.#clearPendingCommandMarker()
                    // Begin short settle-absorption so tail reports of this same physical event
                    // (motor-status label churn, small overshoot wobble) are not misread as
                    // external input once the token is consumed above. Only positional echoes
                    // start it -- label-only outcomes keep legacy classification rules.
                    if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.position)) {
                        this.#correlator.beginSettling(parsed.position, this.getSettleAbsorbWindowMs())
                    }
                    this.#stateLast = parsed
                    this.setCachedState(parsed, {
                        stateLastAt: this.#stateLastAt,
                        origin: DeviceStateOrigin.AUTOMATION
                    }).catch(err => {
                        this.log(`Failed to cache state: ${err.message}`, 'error')
                    })
                    break
                }
                case 'continuation': {
                    // Commanded motion still in progress (slow shutters etc.): keep
                    // AUTOMATION and re-arm the watchdog from fresh forward progress.
                    LoggerService.debug('Commanded motion continuing -- origin preserved as automation', `${this.getLogPrefix()}:${this.#name}`)
                    this.#armMotionWatchdog()
                    this.#stateLast = parsed
                    this.setCachedState(parsed, {
                        stateLastAt: this.#stateLastAt,
                        origin: DeviceStateOrigin.AUTOMATION
                    }).catch(err => {
                        this.log(`Failed to cache state: ${err.message}`, 'error')
                    })
                    break
                }
                case 'conflict': {
                    // Reported motion contradicts our active command: someone else moved it.
                    this.#markHumanInteraction(parsed, 'external override detected during automated motion', 'warn')
                    break
                }
                default: {
                    const hadStateChange = this.#didStateChange(parsed)
                    if (!hadStateChange) {
                        // Periodic report / no meaningful change -- payload only, origin untouched.
                        // This prevents zigbee2mqtt's periodic state advertisements from being
                        // misclassified as human input.
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else if (this.#correlator.hasActive()) {
                        // Unmatched change while an expectation is still alive (e.g., label-only
                        // reports mid-motion): preserve current attribution; the watchdog decides
                        // later if the motion truly stalled without progress.
                        LoggerService.debug('Unmatched change inside active command window -- preserving origin', `${this.getLogPrefix()}:${this.#name}`)
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else if (this.#correlator.absorbPostCompletionReport(parsed)) {
                        // Small positional wobble around a just-confirmed outcome (motor
                        // overshoot/settle bounce): same physical event we already attributed
                        // to automation -- absorb without changing origin or cooldowns. A real
                        // human action moves beyond the wobble tolerance and falls through.
                        LoggerService.debug('Post-completion settling report absorbed -- origin preserved', `${this.getLogPrefix()}:${this.#name}`)
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else {
                        // Changed with no automation explanation -> human interaction.
                        this.#markHumanInteraction(parsed, 'unmatched state change with no pending automation command')
                    }
                }
            }
        }

        const summary = this.#extractMessageSummary(data.message)
        if (summary.startsWith('Temperature:') || summary.startsWith('Illuminance:') || summary.startsWith('Humidity:')) {
            LoggerService.info(summary, `${this.getLogPrefix()}:${this.#name}`)
        } else {
            this.log(summary)
        }

        EventBus.publish(`zigbee:${this.#name}`)
    }

    /**
     * Receive a command from another device (e.g., a Remote) or from automation.
     * This is the unified interface for device-to-device communication
     * via DeviceContainer, replacing direct MQTT publishing.
     * Subclasses may override for custom behavior.
     *
     * The origin and correlator token are deferred until MqttService actually
     * publishes the message (via an onPublish callback). This eliminates the race
     * condition where a pending correlator token survives longer than the queue
     * latency window and misclassifies a human-initiated echo as our own AI command.
     *
     * The `source` parameter makes provenance explicit (see DeviceCommandSource):
     *   - AUTOMATION: rule-engine action. Registers a causality token at publish
     *     time so the resulting MQTT echoes are attributed as automation, persists
     *     an in-flight marker that survives restarts, and arms the motion-stall
     *     watchdog for travel commands.
     *   - HUMAN: any person-directed action -- physical remote presses routed
     *     through interactions, YAML interaction targets, Home Assistant / z2m UI
     *     actions, or AI chat tool calls (a human gave the AI the order). Cancels
     *     any pending automation expectation immediately, marks origin human NOW
     *     (not when the echo arrives), and starts the Redis cooldown so automations
     *     back off even before motion is visible on MQTT.
     *
     * Supports both simple string commands ("ON", "OFF", "OPEN", "CLOSE") and
     * structured JSON payloads ({position: 12}, {state: 'OPEN'}, etc.).
     *
     * Before publishing to zigbee2mqtt, the command is compared against the cached
     * device state. If the device is already in (or very close to) the requested
     * state, the MQTT publish is suppressed to avoid unnecessary traffic and
     * redundant physical actuation.
     *
     * @param {string|Object} command - Command to send. Either a state string
     *   ("ON", "OFF", "TOGGLE", "OPEN", "CLOSE", "STOP") or a payload object
     *   like {position: 12} or {state: 'OPEN'}.
     * @param {DeviceCommandSource} [source=DeviceCommandSource.HUMAN] - Who is behind this command
     */
    receiveCommand(command, source = DeviceCommandSource.HUMAN) {
        let finalPayload
        let description

        // Build payload -- no extra fields merged, just the command itself.
        if (typeof command === 'object' && command !== null) {
            finalPayload = { ...command }
            if ('state' in command) {
                description = command.state
            } else if ('position' in command) {
                description = `POS:${command.position}`
            } else {
                description = JSON.stringify(command)
            }
        } else {
            finalPayload = { state: command }
            description = String(command).toUpperCase()
        }

        LoggerService.info(`Received command: ${description}`, `${this.getLogPrefix()}:${this.#name}`)

        const isAutomation = source === DeviceCommandSource.AUTOMATION

        // --- Suppress redundant commands ---
        if (this.#isCommandRedundant(finalPayload, description)) {
            LoggerService.info(
                `Command "${description}" suppressed: device already at target state`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            const origin = isAutomation ? DeviceStateOrigin.AUTOMATION : DeviceStateOrigin.HUMAN
            this.#stateOrigin = origin
            this.#stateLastAt = new Date().toISOString()
            this.setCachedState(this.#stateLast, {
                stateLastAt: this.#stateLastAt,
                origin: origin
            }).catch(err => {
                this.log(`Failed to cache state: ${err.message}`, 'error')
            })
            if (!isAutomation) {
                // The person still expressed intent even though nothing moved.
                this.#writeHumanCooldown('redundant human command suppressed -- intent still counts')
            }
            return
        }

        // --- Suppress retries of ineffective automation commands ---
        // If our last attempt at this exact description produced zero observable response,
        // do not hammer the device again while its state is unchanged: the failure was
        // already logged once and will be retried when something else moves the device or
        // the backoff elapses. Human-directed commands are never suppressed here.
        if (isAutomation && this.#failedCommand != null) {
            const fc = this.#failedCommand
            if (Date.now() < fc.until && fc.description === description) {
                const posNow = Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : null
                const unchanged = fc.positionAtFailure == null || posNow == null
                    || Math.abs(posNow - fc.positionAtFailure) <= POSITION_MATCH_TOLERANCE
                if (unchanged) {
                    LoggerService.debug(
                        `Suppressed ${description} -- no observable response since previous attempt; retrying after state change or backoff`,
                        `${this.getLogPrefix()}:${this.#name}`
                    )
                    return
                }
            }
        }

        if (!this.#mqttService) {
            this.log('MqttService not available', 'warn')
            return
        }

        const prefix = process.env['MQTT_PREFIX'] || 'zigbee2mqtt'
        const topic = `${prefix}/${this.#name}/set`
        const self = this

        // Defer correlator registration and origin assignment until the message
        // is actually published by MqttService so a queued but never-sent command
        // cannot leave stale attribution behind.
        const _onPublish = () => {
            const now = new Date().toISOString()
            self.#stateLastAt = now

            if (isAutomation) {
                // Rule-engine action: register the expectation so its echoes are
                // recognized as automation and external overrides stay detectable.
                const kind = self.#commandKindFor(description)
                const ttlMs = kind === 'travel' ? self.getTravelEchoWindowMs() : self.getInstantEchoWindowMs()
                self.#correlator.register(description, {
                    kind,
                    anchorPosition: Number.isFinite(self.#stateLast?.position) ? self.#stateLast.position : null,
                    anchorState: typeof self.#stateLast?.state === 'string' ? String(self.#stateLast.state).toUpperCase() : null
                }, ttlMs)
                self.#stateOrigin = DeviceStateOrigin.AUTOMATION
                self.#persistPendingCommandMarker(description, kind, ttlMs)
                self.#armMotionWatchdog()
            } else {
                // Human-directed command: invalidate any stale automation expectations NOW --
                // before their echoes can arrive -- and start the cooldown immediately.
                self.#clearMotionWatchdog()
                self.#correlator.cancelAll()
                self.#stateOrigin = DeviceStateOrigin.HUMAN
                self.#writeHumanCooldown('human-directed command dispatched')
                self.#clearPendingCommandMarker()
            }

            self.setCachedState(self.#stateLast, {
                stateLastAt: now,
                origin: self.#stateOrigin
            }).catch(err => {
                self.log(`Failed to cache state: ${err.message}`, 'error')
            })
        }

        this.#mqttService.publish(topic, JSON.stringify(finalPayload), { meta: { onPublish: _onPublish } })
        LoggerService.info(
            `Command "${description}" sent to topic ${topic}`,
            `${this.getLogPrefix()}:${this.#name}`
        )
    }

    // -- MQTT subscription management -------------------------------------

    /**
     * Set MQTT service for this device to use for subscriptions and publishing.
     * Triggers initial topic subscription if the broker is connected.
     *
     * @param {Object} mqttService - The MQTT service instance
     */
    setMqttService(mqttService) {
        this.#mqttService = mqttService
        this.#subscribeToTopics()
    }

    /**
     * Publish a message to an arbitrary MQTT topic.
     *
     * @protected
     * @param {string} topic - MQTT topic to publish to
     * @param {string} payload - Message payload (already stringified)
     */
    publish(topic, payload) {
        if (!this.#mqttService) {
            LoggerService.warn(`Cannot publish to "${topic}": MqttService not available`, `${this.getLogPrefix()}:${this.#name}`)
            return
        }
        this.#mqttService.publish(topic, payload)
    }

    /**
     * Return the list of MQTT topics this device should subscribe to.
     * Subclasses may override to add or change topics.
     *
     * Default: subscribes to <prefix>/<name> -- state updates reported by
     * zigbee2mqtt for this specific device. The /set topic is NOT included
     * since it carries our own outgoing command echoes.
     *
     * @param {string} prefix - MQTT topic prefix (e.g., "zigbee2mqtt")
     * @returns {string[]} Array of topic strings to subscribe to
     */
    getSubscribedTopics(prefix) {
        return [`${prefix}/${this.getName()}`]
    }

    /**
     * Idempotent re-subscription called after MQTT reconnect.
     * The Set-based guard prevents double-subscribing to already-active topics.
     */
    reconnect() {
        this.#subscribeToTopics()
    }

    /**
     * Clean up all MQTT subscriptions for this device.
     * Called during graceful shutdown to free broker resources.
     */
    cleanup() {
        for (const unsub of this.#subscriptions) {
            try {
                unsub()
            } catch (e) {
                this.error(`Error during subscription cleanup: ${e.message}`)
            }
        }
        this.#subscriptions = []
        this.#subscribedTopics.clear()
        LoggerService.debug('All subscriptions cleaned up', `${this.getLogPrefix()}:${this.#name}`)
    }

    // -- Private helpers --------------------------------------------------

    /**
     * Subscribe to all topics returned by getSubscribedTopics().
     * Uses a Set to prevent double-subscription on reconnect.
     * @private
     */
    #subscribeToTopics() {
        if (!this.#mqttService || !this.#mqttService.isConnected()) {
            LoggerService.debug('MQTT not ready yet, skipping subscription', `${this.getLogPrefix()}:${this.#name}`)
            return
        }

        const prefix = this.#mqttService.getPrefix()
        const topics = this.getSubscribedTopics(prefix)

        for (const topic of topics) {
            if (!this.#subscribedTopics.has(topic)) {
                const unsubscribe = this.#mqttService.subscribe(
                    topic,
                    (t, payload) => this.handleMqttMessage({ topic: t, message: payload })
                )
                if (unsubscribe) {
                    this.#subscriptions.push(unsubscribe)
                    this.#subscribedTopics.add(topic)
                    LoggerService.info(`Subscribed to "${topic}"`, `${this.getLogPrefix()}:${this.#name}`)
                }
            }
        }
    }

    /**
     * Detect whether an incoming MQTT payload represents a genuine state change
     * compared to the last known cached state.
     *
     * Compares only meaningful fields: state, position, temperature, illuminance, humidity.
     * If none of these changed meaningfully, it's treated as a periodic report rather than
     * a human interaction.
     *
     * @param {Object} newPayload - Parsed MQTT message payload
     * @returns {boolean} true if the payload represents a meaningful state change
     * @private
     */
    #didStateChange(newPayload) {
        if (typeof newPayload !== 'object' || newPayload === null) return true

        const old = this.#stateLast
        // Cold start or empty baseline: treat incoming data as calibration, not a
        // state change. Prevents zigbee2mqtt's initial calibration reports from being
        // misclassified as human interactions after a restart or Redis wipe.
        if (!old || typeof old !== 'object' || Object.keys(old).length === 0) {
            return false
        }

        // Positional telemetry is ground truth for mechanisms like roller shutters: when
        // both payloads carry positions within jitter tolerance of each other, a difference
        // confined to the `state` label is motor-status churn at a fixed point (e.g., z2m
        // flipping OPEN -> STOP as the motor idles right after our own completed travel),
        // not an input event -- it must not change attribution. Non-positional devices
        // (lights etc.) never satisfy this gate and keep strict label comparison.
        const stableNewPos = Number(newPayload.position)
        const stableOldPos = Number(old.position)
        const positionUnchanged = Number.isFinite(stableNewPos) && Number.isFinite(stableOldPos)
            && Math.abs(stableNewPos - stableOldPos) <= POSITION_MATCH_TOLERANCE

        // Compare state field (ON/OFF/OPEN/CLOSE/STOP) -- unless positional data shows the
        // device has not moved (see above).
        if (!positionUnchanged) {
            if ('state' in newPayload && 'state' in old) {
                if (String(newPayload.state) !== String(old.state)) return true
            } else if ('state' in newPayload || 'state' in old) {
                return true
            }
        }

        // Compare position field with tolerance for roller shutters
        if ('position' in newPayload && 'position' in old) {
            const newPos = Number(newPayload.position)
            const oldPos = Number(old.position)
            if (!isNaN(newPos) && !isNaN(oldPos) && Math.abs(newPos - oldPos) > POSITION_MATCH_TOLERANCE) return true
        } else if ('position' in newPayload || 'position' in old) {
            return true
        }

        // Compare illuminance with threshold
        if ('illuminance' in newPayload && 'illuminance' in old) {
            const diff = Math.abs(Number(newPayload.illuminance) - Number(old.illuminance))
            if (diff > ILLUMINANCE_CHANGE_THRESHOLD) return true
        } else if ('illuminance' in newPayload || 'illuminance' in old) {
            return true
        }

        // Compare temperature with threshold
        if ('temperature' in newPayload && 'temperature' in old) {
            const diff = Math.abs(Number(newPayload.temperature) - Number(old.temperature))
            if (diff > TEMPERATURE_CHANGE_THRESHOLD) return true
        } else if ('temperature' in newPayload || 'temperature' in old) {
            return true
        }

        // Compare humidity with threshold
        if ('humidity' in newPayload && 'humidity' in old) {
            const diff = Math.abs(Number(newPayload.humidity) - Number(old.humidity))
            if (diff > HUMIDITY_CHANGE_THRESHOLD) return true
        } else if ('humidity' in newPayload || 'humidity' in old) {
            return true
        }

        return false
    }

    /**
     * Determine whether an outgoing command would be redundant given the cached state.
     *
     * Expands semantic commands into their expected state values and compares
     * against `#stateLast` with appropriate tolerances:
     *
     *   - `{state: 'ON'}`      -> suppressed if cached state === 'ON'
     *   - `{state: 'OFF'}`     -> suppressed if cached state === 'OFF'
     *   - `{state: 'OPEN'}`    -> suppressed if cached position >= 98
     *   - `{state: 'CLOSE'}`   -> suppressed if cached position <= 2
     *   - `{position: 12}`     -> suppressed if cached position within +2 of target
     *   - Plain strings like "ON", "OFF" are expanded to `{state: 'ON'}` etc.
     *
     * Commands that cannot be meaningfully compared (e.g., TOGGLE, STOP with no
     * cached state) are NEVER suppressed -- they always pass through.
     *
     * @param {Object} finalPayload - The resolved payload object ({state: ...} or {position: ...})
     * @param {string} description - Human-readable description (e.g., "POS:12", "OPEN")
     * @returns {boolean} true if the command is redundant and should be suppressed
     * @private
     */
    #isCommandRedundant(finalPayload, description) {
        const cached = this.#stateLast

        // No cached state -> we can't compare, so always send.
        if (!cached || typeof cached !== 'object' || Object.keys(cached).length === 0) {
            return false
        }

        const descUpper = String(description).toUpperCase()

        // --- Position-based commands ---
        if ('position' in finalPayload && typeof finalPayload.position === 'number') {
            const targetPos = finalPayload.position
            const cachedPos = cached.position

            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                return Math.abs(cachedPos - targetPos) <= POSITION_MATCH_TOLERANCE
            }
            return false
        }

        // --- State-based commands ---
        if ('state' in finalPayload) {
            const cmdState = String(finalPayload.state).toUpperCase()

            // TOGGLE has no deterministic target -- always send.
            if (cmdState === 'TOGGLE') return false

            // Direct state comparison for ON/OFF devices (lights, switches).
            if (cmdState === 'ON' || cmdState === 'OFF') {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                return cachedState === cmdState
            }

            // Roller shutter semantic commands: compare against cached position.
            const cachedPos = cached.position
            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                if (cmdState === 'OPEN' && cachedPos >= POSITION_NEARLY_OPEN_THRESHOLD) return true
                if (cmdState === 'CLOSE' && cachedPos <= POSITION_NEARLY_CLOSED_THRESHOLD) return true
            }

            // Fallback: when no reliable position data is available, use cached state field.
            // BUT when position IS available, it is authoritative -- do NOT trust state
            // for roller shutters because zigbee2mqtt may report state=OPEN while position=45.
            if ((cachedPos === undefined || typeof cachedPos !== 'number') && (cmdState === 'OPEN' || cmdState === 'CLOSE')) {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                if (cachedState && cachedState === cmdState) return true
            }
        }

        return false
    }

    /**
     * Extract a meaningful summary from a JSON payload.
     * Prioritizes the "state" field (ON/OFF/etc.), falls back to a truncated raw payload.
     *
     * @param {string} message - Raw message string
     * @returns {string} Human-readable summary
     * @private
     */
    #extractMessageSummary(message) {
        try {
            const parsed = JSON.parse(message)
            if (parsed && typeof parsed === 'object') {
                if ('illuminance' in parsed) {
                    return `Illuminance: ${parsed.illuminance}`
                }
                if ('temperature' in parsed) {
                    let summary = `Temperature: ${parsed.temperature}`
                    if ('humidity' in parsed) {
                        summary += `, Humidity: ${parsed.humidity}`
                    }
                    return summary
                }
                if ('state' in parsed) {
                    return `State: ${parsed.state}`
                }
                if ('action' in parsed) {
                    return `Action: ${parsed.action}`
                }
                const truncated = JSON.stringify(parsed)
                return truncated.length > SUMMARY_TRUNCATE_LENGTH ? truncated.substring(0, SUMMARY_TRUNCATE_LENGTH) + '...' : truncated
            }
        } catch {
            return message.length > SUMMARY_TRUNCATE_LENGTH ? message.substring(0, SUMMARY_TRUNCATE_LENGTH) + '...' : message
        }
        return String(message)
    }

    // -- Logging helpers --------------------------------------------------

    /**
     * Return the label used in log prefixes.
     * Subclasses override to return their type name (e.g. "Sensor", "Mechanism", "Remote").
     * Defaults to "Device" for unknown or generic types.
     * @returns {string} Log prefix label
     */
    getLogPrefix() {
        return 'Device'
    }

    /**
     * Unified logging helper with device prefix. Default level is debug.
     * Subclasses (e.g. Sensor) may override this method to use info level.
     *
     * @param {string} message - Message to log
     */
    log(message) {
        LoggerService.debug(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /**
     * Log a warning message with device prefix.
     *
     * @param {string} message - Message to log
     */
    warn(message) {
        LoggerService.warn(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /**
     * Log an error message with device prefix.
     *
     * @param {string} message - Message to log
     */
    error(message) {
        LoggerService.error(message, `${this.getLogPrefix()}:${this.#name}`)
    }
}