/**
 * Abstract base class for all Zigbee devices.
 * Provides Origin-based state provenance (`unknown` -> `automation` | `human`).
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
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


/** Default echo window (ms) for instant commands (ON/OFF/TOGGLE).
 * @type {number} */
const INSTANT_ECHO_WINDOW_DEFAULT_MS = 15_000

/** Default echo window (ms) for travel commands (OPEN/CLOSE/POS:N/STOP).
 * @type {number} */
const TRAVEL_ECHO_WINDOW_DEFAULT_MS = 90_000

/** Watchdog timeout (ms): if a commanded OPEN/CLOSE/POS:N motion shows no
 * @type {number} */
const MOTION_STALL_TIMEOUT_DEFAULT_MS = 20_000

/** Settle-absorption window (ms): after an echo confirms a travel outcome, follow-up
 * @type {number} */
const SETTLE_ABSORB_WINDOW_DEFAULT_MS = 10_000

/** Pre-motion grace (ms): a positional terminal match arriving within this window of
 * @type {number} */
const TRAVEL_ECHO_GRACE_DEFAULT_MS = 2_000

/** Backoff (ms) before re-dispatching the identical automated command after it
 * @type {number} */
const FAILED_COMMAND_BACKOFF_DEFAULT_MS = 10 * 60_000

/** Hard cap (ms) on total lifetime of any causality token, even while
 * @type {number} */
const MAX_TOKEN_LIFETIME_MS = 600_000

/** Maximum position (%) still considered "fully open" for echo matching.
 * @type {number} */
const OPEN_ECHO_POSITION_MIN = 90

/** Minimum position (%) still considered "fully closed" for echo matching.
 * @type {number} */
const CLOSED_ECHO_POSITION_MAX = 10

/** Maximum drift from the stop anchor position (%) still attributable to motor
 * @type {number} */
const STOP_DRIFT_TOLERANCE = 5

/** Maximum positional deviation (%) from a just-confirmed travel outcome still
 * @type {number} */
const SETTLE_WOBBLE_TOLERANCE = 5

/** Suffix appended to the device cache key for the persisted in-flight
 * @type {string} */
const PENDING_MARKER_KEY_SUFFIX = ':pending'

/** Fallback duration (seconds) for the human-interaction cooldown applied to a
 * @type {number} */
const HUMAN_INTERACTION_COOLDOWN_SECONDS = 15 * 60

/** Position tolerance threshold for matching roller shutter positions.
 * @type {number} */
const POSITION_MATCH_TOLERANCE = 2

/** Threshold for "nearly fully open" roller shutter position comparison.
 * @type {number} */
const POSITION_NEARLY_OPEN_THRESHOLD = 98

/** Threshold for "nearly fully closed" roller shutter position comparison.
 * @type {number} */
const POSITION_NEARLY_CLOSED_THRESHOLD = 2

/** Minimum meaningful illuminance change (lux).
 * @type {number} */
const ILLUMINANCE_CHANGE_THRESHOLD = 500

/** Minimum meaningful temperature change (degrees Celsius).
 * @type {number} */
const TEMPERATURE_CHANGE_THRESHOLD = 0.5

/** Minimum meaningful humidity change (%).
 * @type {number} */
const HUMIDITY_CHANGE_THRESHOLD = 1

/** Maximum length for truncated log summaries.
 * @type {number} */
const SUMMARY_TRUNCATE_LENGTH = 80

//  CommandCorrelator -- causality tokens for outgoing rule-engine commands.

/** Tracks at most one in-flight expectation per device -- the most recent. */
class CommandCorrelator {

    /** Active expectation, if any.
     * @type {{token: string, expectedState: string, expectedChannels: Array<{key:string,type:'state'|'number',value:(string|number)}>|null, kind: ('instant'|'travel'|'wildcard'), direction: (number|null), anchorPosition: (number|null), anchorState: (string|null), lastSeenPosition: (number|null), settleCount: number, ttlMs: number, issuedAt: number, expiresAt: number, echoGraceMs: (number|null)}|null} */
    #active = null

    /** Monotonic counter for unique token ids. @type {number} */
    #counter = 0

    /** Log-context label supplied by the owning device (e.g., `"ZigbeeDevice:<name>"`). @type {string} */
    #logContext = 'CommandCorrelator'

    /** Short-lived settling snapshot started when a positional echo confirms a travel
     * @type {{position: number, expiresAt: number}|null} */
    #settling = null

    /** Most recent automation command that expired without confirmation. Cleared once it
     *  stops being ambiguous: a new command is registered, an echo/conflict is classified,
     *  a genuine state change is observed, or a human-directed command supersedes it.
     * @type {{token: string, expectedState: string, expiredAt: number}|null} */
    #unconfirmed = null

    //  -- Public API -------------------------------------------------------

    /** Register an outgoing rule-engine command as the new active expectation.
     * @param {string} expectedState - Normalized description: ON/OFF/OPEN/CLOSE/STOP/TOGGLE, "POS:N", or a JSON object of suffixed channel fields (e.g. {"state_l1":"ON"})
     * @param {Object} [options] - Registration context captured at dispatch time
     * @param {'instant'|'travel'|'wildcard'} [options.kind='instant'] - Command family
     * @param {number|null} [options.anchorPosition=null] - Device position (%) at registration time
     * @param {string|null} [options.anchorState=null] - State label at registration time (used by wildcard)
     * @param {number|null} [options.echoGraceMs=null] - Pre-motion grace (ms); near-target reports inside it cannot confirm completion
     * @param {number} ttlMs - Lifetime of the expectation in milliseconds
     * @returns {string} A unique correlation token id */
    register(expectedState, options = {}, ttlMs) {
        const now = Date.now()
        const lifetime = Math.max(1_000, Number(ttlMs) || 0)
        //  A new command supersedes whatever the previous one left unresolved.
        this.#unconfirmed = null
        this.#active = {
            token: `cmd-${now}-${++this.#counter}`,
            expectedState: String(expectedState ?? '').toUpperCase(),
            expectedChannels: this.#channelExpectationsFrom(String(expectedState ?? '')),
            kind: options?.kind ?? 'instant',
            direction: null, // computed below once the anchor is normalized
            anchorPosition: Number.isFinite(options?.anchorPosition) ? options.anchorPosition : null,
            anchorState: options?.anchorState != null ? String(options.anchorState).toUpperCase() : null,
            lastSeenPosition: null,
            settleCount: 0,
            echoGraceMs: Number.isFinite(options?.echoGraceMs) ? Math.max(0, Math.round(Number(options.echoGraceMs))) : null,
            ttlMs: lifetime,
            issuedAt: now,
            expiresAt: now + lifetime
        }
        this.#active.direction = this.#directionFor(this.#active.expectedState, this.#active.anchorPosition)
        this.#trace(
            `token registered ${this.#active.token} expectedState=${this.#active.expectedState} kind=${this.#active.kind}` +
                ` direction=${this.#active.direction ?? 'null'} anchorPosition=${this.#active.anchorPosition ?? 'null'}` +
                ` echoGraceMs=${this.#active.echoGraceMs ?? 'null'} ttlMs=${lifetime}`
        )
        return this.#active.token
    }

    /** Classify an incoming MQTT payload against the active expectation.
     * @param {*} payload - Parsed MQTT message payload (object or raw string)
     * @returns {'echo'|'continuation'|'conflict'|null} Verdict for the caller's decision tree */
    matchEcho(payload) {
        if (!this.hasActive()) return null

        const verdict = this.#evaluate(this.#active, payload)
        switch (verdict) {
            case 'echo':
                this.#trace(`token ${this.#active.token} consumed as echo`)
                this.#unconfirmed = null
                this.#active = null
                break
            case 'conflict':
                this.#trace(`token ${this.#active.token} discarded on conflict`)
                this.#unconfirmed = null
                this.#active = null
                break
            case 'continuation': {
                //  Refresh lifetime while motion genuinely continues, but never beyond the hard cap.
                const now = Date.now()
                this.#active.expiresAt = Math.min(now + this.#active.ttlMs, this.#active.issuedAt + MAX_TOKEN_LIFETIME_MS)
                break
            }
            default:
                break
        }
        return verdict
    }

    /** Is there a non-expired active expectation? Expired tokens are dropped lazily; a
     *  dropped token is remembered as unconfirmed so callers can treat the cached state as
     *  unverified (the device may well have executed the command and simply never reported it).
     * @returns {boolean} */
    hasActive() {
        if (!this.#active) return false
        if (Date.now() > this.#active.expiresAt) {
            this.#trace(`token ${this.#active.token} expired without confirmation`)
            this.#unconfirmed = {
                token: this.#active.token,
                expectedState: this.#active.expectedState,
                expiredAt: Date.now()
            }
            this.#warn(
                `Automated command ${this.#active.expectedState} produced no observable response --` +
                ' cached device state stays unverified until the device confirms or changes state'
            )
            this.#active = null
            return false
        }
        return true
    }

    /** Kind of the live token without consuming or mutating it.
     * @returns {'instant'|'travel'|'wildcard'|null} */
    getActiveKind() {
        return this.hasActive() ? this.#active.kind : null
    }

    /** Snapshot of the live token for logging and watchdog decisions.
     * @returns {{expectedState: string, kind: ('instant'|'travel'|'wildcard'), progressObserved: boolean}|null} */
    getActiveToken() {
        return this.hasActive()
            ? { expectedState: this.#active.expectedState, kind: this.#active.kind, progressObserved: this.#active.lastSeenPosition != null }
            : null
    }

    /** Last automation command that expired without confirmation, if any. Its presence means
     *  the cached device state may still describe the pre-command world, so it cannot be used
     *  to prove that a new command would be a no-op.
     * @returns {{token: string, expectedState: string, expiredAt: number}|null} */
    getUnconfirmed() {
        //  Lazy expiry: surface a token that ran out while nothing was polling the device.
        this.hasActive()
        return this.#unconfirmed
    }

    /** Clear the unconfirmed marker -- called once the device state is observed to change,
     *  which is independent evidence about where the device actually is.
     * @returns {void} */
    noteObservedChange() {
        this.#unconfirmed = null
    }

    /** Discard any pending expectation -- called when a human-directed command. */
    cancelAll() {
        if (this.#active) {
            this.#trace(`token ${this.#active.token} cancelled by human-directed command`)
        }
        this.#active = null
        this.#unconfirmed = null
    }


    /** Set the log-context label used by file-only TRACE diagnostics so token
     * @param {string} context - Context string from the owning DeviceBase instance */
    setLogContext(context) {
        this.#logContext = String(context || 'CommandCorrelator')
    }

    /** Emit a file-only TRACE diagnostic line (never reaches console/UI transports).
     * @param {string} message - Diagnostic detail to record
     * @private */
    #trace(message) {
        LoggerService.trace(message, this.#logContext)
    }

    /** Emit a WARN line under the same context -- reserved for outcomes the operator needs to
     *  see, e.g. an automated command that produced no observable response at all.
     * @param {string} message - Warning text to record
     * @private */
    #warn(message) {
        LoggerService.warn(message, this.#logContext)
    }

    //  Settle absorption (post-completion tail handling)

    /** Start a short-lived settling snapshot after an echo confirmed a travel outcome.
     * @param {number} position - achieved/settled position (%) from the confirming report
     * @param {number} windowMs - how long tail reports are absorbed (lazy expiry, no timer) */
    beginSettling(position, windowMs) {
        const ms = Number(windowMs) > 0 ? Math.min(Number(windowMs), MAX_TOKEN_LIFETIME_MS) : SETTLE_ABSORB_WINDOW_DEFAULT_MS
        this.#settling = { position, expiresAt: Date.now() + ms }
    }

    /** Whether the settle-absorption window is still active (lazily expired).
     * @returns {boolean} true while post-completion tail reports may be absorbed */
    isSettling() {
        if (!this.#settling) return false
        if (Date.now() > this.#settling.expiresAt) {
            this.#settling = null
            return false
        }
        return true
    }

    /** Attempt to absorb a follow-up report as part of the just-confirmed outcome's tail.
     * @param {*} payload - parsed state report
     * @returns {boolean} true when the report was classified as settling-tail noise */
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

    //  -- Private helpers --------------------------------------------------

    /** Expected direction of travel implied by the commanded state relative.
     * @param {string} state - Normalized expected state
     * @param {number|null} anchorPosition - Position at registration time
     * @returns {number|null}
     * @private */
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

    /** Derive per-channel expectations from a serialized multi-channel command so an echo can be
     *  matched against suffixed report fields (`state_l1`, `brightness_l2`, ...). Single-state
     *  descriptions ("ON", "POS:50") carry no channels and yield null -- those keep using the legacy
     *  `payload.state` comparison untouched. Keys are lowercased to mirror wire reports; state values
     *  are uppercased for case-insensitive comparison.
     * @param {string} rawExpectedState - The un-normalized expected-state description as registered
     * @returns {Array<{key:string,type:'state'|'number',value:(string|number)}>|null} Channel map, or null when none
     * @private */
    #channelExpectationsFrom(rawExpectedState) {
        const s = String(rawExpectedState ?? '')
        if (!s.startsWith('{')) return null
        let obj
        try {
            obj = JSON.parse(s)
        } catch {
            return null
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
        const out = []
        for (const [k, v] of Object.entries(obj)) {
            const key = k.toLowerCase()
            if (/^(state|position|brightness)_/.test(key)) {
                if (typeof v === 'number') out.push({ key, type: 'number', value: v })
                else out.push({ key, type: 'state', value: String(v).toUpperCase() })
            }
        }
        return out.length > 0 ? out : null
    }

    /** Match a multi-channel instant command against a report. STATE channels are the reliable echo
     *  signal on multi-channel devices, so they drive confirmation; numeric channels (brightness/
     *  position) only decide when the command carried no state at all. A partial report that omits any
     *  commanded channel cannot confirm yet and yields null rather than a false positive.
     * @param {{token: string, expectedChannels: Array<{key:string,type:'state'|'number',value:(string|number)}>}} token - Active token with its channel map
     * @param {*} payload - Parsed MQTT report
     * @returns {'echo'|null}
     * @private */
    #matchInstantChannels(token, payload) {
        const exps = token.expectedChannels ?? []
        const states = exps.filter(e => e.type === 'state')
        const pool = states.length > 0 ? states : exps
        for (const e of pool) {
            const raw = payload[e.key]
            if (raw == null) return null // partial report -> cannot confirm yet
            if (e.type === 'state') {
                if (String(raw).toUpperCase() !== e.value) return null
            } else {
                const reported = Number(raw)
                if (!Number.isFinite(reported)) return null
                const tolerance = e.key.startsWith('position_') ? POSITION_MATCH_TOLERANCE : 1
                if (Math.abs(reported - Number(e.value)) > tolerance) return null
            }
        }
        return 'echo'
    }

    /** Evaluate one payload against the active token.
     * @param {{expectedState: string, kind: ('instant'|'travel'|'wildcard'), direction: (number|null), anchorPosition: (number|null)}} token
     * @param {*} payload - Parsed MQTT payload
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private */
    #evaluate(token, payload) {
        if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null

        const reportedState = payload.state != null ? String(payload.state).toUpperCase() : null
        const position = Number.isFinite(payload.position) ? payload.position : null

        let verdict
        switch (token.kind) {
            case 'wildcard':
                verdict = this.#matchWildcard(token, reportedState, position)
                break
            case 'travel':
                verdict = token.expectedState === 'STOP'
                    ? this.#matchStop(token, reportedState, position)
                    : this.#matchTravel(token, reportedState, position)
                break
            default: // instant (ON/OFF / multi-channel state)
                verdict = token.expectedChannels?.length
                    ? this.#matchInstantChannels(token, payload)
                    : (reportedState === token.expectedState ? 'echo' : null)
        }

        //  File-only TRACE decision record -- makes every verdict explainable post-hoc.
        this.#trace(
            `eval ${token.token} kind=${token.kind} expectedState=${token.expectedState}` +
                ` channels=${token.expectedChannels?.length ?? 0}` +
                ` input={state:${reportedState ?? 'null'}, position:${position ?? 'null'}} -> ${verdict ?? 'null'}`
        )
        return verdict
    }

    /** TOGGLE wildcard: consumed by the first report that actually differs.
     * @param {{anchorPosition: (number|null), anchorState: (string|null)}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|null}
     * @private */
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

    /** OPEN/CLOSE/POS:N travel matching with directional progress detection.
     * @param {{expectedState: string, direction: (number|null), anchorPosition: (number|null), lastSeenPosition: (number|null)}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private */
    #matchTravel(token, reportedState, position) {
        const expected = token.expectedState
        const targetPos = expected.startsWith('POS:') ? parseInt(expected.substring(4), 10) : null

        if (position != null) {
            //  Terminal / exact-target matches first.
            const terminalMatch =
                (targetPos != null && !isNaN(targetPos) && Math.abs(position - targetPos) <= POSITION_MATCH_TOLERANCE) ||
                (expected === 'CLOSE' && position <= CLOSED_ECHO_POSITION_MAX) ||
                (expected === 'OPEN' && position >= OPEN_ECHO_POSITION_MIN)
            if (terminalMatch) {
                //  Stale/optimistic re-advertisement guard: a terminal match with NO observed.
                const graceMs = Number.isFinite(token.echoGraceMs) ? token.echoGraceMs : TRAVEL_ECHO_GRACE_DEFAULT_MS
                if (token.lastSeenPosition == null && Date.now() - token.issuedAt < graceMs) {
                    const ageMs = Date.now() - token.issuedAt
                    this.#trace(`travel guard held ${token.token}: terminal match position=${position}, no progress yet, ageMs=${ageMs} < graceMs=${graceMs} -- yielding no verdict`)
                    return null
                }
                return 'echo'
            }

            const reference = token.lastSeenPosition ?? token.anchorPosition
            if (reference != null && token.direction != null) {
                const signedDelta = token.direction * (position - reference)
                this.#trace(`${token.token} directional check reference=${reference} signedDelta=${signedDelta} tolerance=+/-${POSITION_MATCH_TOLERANCE}`)
                if (signedDelta > POSITION_MATCH_TOLERANCE) {
                    this.#noteProgress(token, position)
                    return 'continuation'
                }
                if (signedDelta < -POSITION_MATCH_TOLERANCE) return 'conflict'
                if (this.#isCloserToTarget(token, position, reference)) {
                    //  Slow creep: each step stays within jitter tolerance but the device.
                    this.#noteProgress(token, position)
                    return 'continuation'
                }
            }
            //  Jitter around a fixed point -- no opinion; the watchdog decides later.
            return null
        }

        //  Label-only report: accept direct or aliased terminal labels.
        if (reportedState == null) return null
        if (reportedState === expected) return 'echo'
        if ((expected === 'CLOSE' && reportedState === 'OFF') || (expected === 'OPEN' && reportedState === 'ON')) return 'echo'
        return null
    }

    /** STOP matching: an explicit state='STOP' confirms it; otherwise small drift.
     * @param {{anchorPosition: (number|null), lastSeenPosition: (number|null), settleCount: number}} token
     * @param {string|null} reportedState
     * @param {number|null} position
     * @returns {'echo'|'continuation'|'conflict'|null}
     * @private */
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

    /** Record forward progress: advance the reference point so subsequent deltas.
     * @param {{lastSeenPosition: (number|null), settleCount: number}} token
     * @param {number} position
     * @private */
    #noteProgress(token, position) {
        token.lastSeenPosition = position
        token.settleCount = 0
        this.#trace(`progress noted ${token.token} position=${position}`)
    }

    /** Is `position` strictly closer to the commanded end state than `reference`?
     * @param {{expectedState: string}} token
     * @param {number} position
     * @param {number} reference
     * @returns {boolean}
     * @private */
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

//  DeviceBase (abstract)

/** Device defaults. All device types extend this class. */
export default class DeviceBase {

    //  -- Private state ----------------------------------------------------

    /** Device display name (e.g., `"Living Room Light"`) */
    #name = ''
    /** Zigbee2MQTT device ID or friendly-name slug. */
    #id = ''
    /** Raw device configuration data from zigbee.yaml. */
    #data = {}
    /** Last known state payload from MQTT (e.g., `{state: 'ON', position: 45}`) */
    #stateLast = {}
    /** Provenance of current state: `unknown`, `automation`, or `human` */
    #stateOrigin = DeviceStateOrigin.UNKNOWN
    /** ISO-8601 timestamp of last state change, or `null` on first boot */
    #stateLastAt = null
    /** Tracks the single in-flight rule-engine expectation for override detection. */
    #correlator = new CommandCorrelator()
    /** Watchdog timer handle detecting externally-stalled automated motion. */
    #stallTimer = null

    /** Retry-backoff metadata for the last automated command that produced no observable
     * @type {{description: string, positionAtFailure: (number|null), until: number}|null} */
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

    //  -- Constructor ------------------------------------------------------

    /** Construct a device instance.
     * @param {string} name - Device display name from zigbee.yaml config
     * @param {string} id - Zigbee2MQTT friendly-name or device ID
     * @param {Record<string, unknown>} [data] - Raw device configuration object */
    constructor(name, id, data) {
        if (this.constructor === DeviceBase) {
            throw new Error('Abstract classes cannot be instantiated.')
        }

        this.#name = name
        this.#id = id
        this.#data = data
        this.#cacheKey = this.#generateCacheKey(name, id)
        //  Attribute correlator TRACE diagnostics to this device in the trace log.
        this.#correlator.setLogContext(`${this.getLogPrefix()}:${name}`)
    }

    //  -- Lifecycle --------------------------------------------------------

    /** Async initialization called after construction. */
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

        //  Restore an in-flight automation expectation that survived a restart.
        if (this.shouldTrackOrigin()) {
            const marker = await CacheService.get(this.#pendingMarkerKey())
            if (marker && typeof marker.expectedState === 'string' && Number.isFinite(marker.expiresAt) && marker.expiresAt > Date.now()) {
                const ttlMs = Math.max(1_000, marker.expiresAt - Date.now())
                this.#correlator.register(marker.expectedState, {
                    kind: marker.kind ?? 'instant',
                    anchorPosition: marker.anchorPosition ?? null,
                    anchorState: marker.anchorState ?? null,
                    echoGraceMs: this.getTravelEchoGraceMs()
                }, ttlMs)
                LoggerService.debug(`Restored in-flight automation token (${marker.expectedState})`, `${this.getLogPrefix()}:${this.#name}`)
                this.#armMotionWatchdog()
            }
        }
    }

    //  -- Identity accessors -----------------------------------------------

    /** Get device name.
     * @returns {string} */
    getName() {
        return this.#name
    }

    /** Get device ID.
     * @returns {string} */
    getId() {
        return this.#id
    }

    /** Return the raw configuration data bag this instance was constructed with
     * @returns {Object|null} Constructor-provided data object, or null when none given */
    getData() {
        return this.#data
    }

    //  -- Cache accessors --------------------------------------------------

    /** Generate a unique cache key for this device.
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @returns {string} Cache key
     * @private */
    #generateCacheKey(name, id) {
        return `zigbeedevice:${slugify(name)}:${id}`
    }

    /** Get the cache key for this device.
     * @returns {string} */
    getCacheKey() {
        return this.#cacheKey
    }

    /** Retrieve persisted device state from Redis cache.
     * @returns {Promise<{stateLast: Record<string,unknown>, stateLastAt: string|null, stateOrigin: string}|undefined>} */
    async getCachedState() {
        return await CacheService.get(this.#cacheKey)
    }

    /** Persist device state to Redis cache.
     * @param {Record<string, unknown>} state - Latest MQTT payload or computed state object
     * @param {object} [options] - Optional overrides
     * @param {string} [options.stateLastAt] - Explicit ISO-8601 timestamp (defaults to `now`)
     * @param {'unknown'|'automation'|'human'} [options.origin] - Explicit provenance override
     * @returns {Promise<boolean>} `true` on success */
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

    //  -- State tracking accessors -----------------------------------------

    /** Retrieve the most recent MQTT payload for this device.
     * @returns {Record<string, unknown>} Last known state object */
    getStateLast() {
        return this.#stateLast
    }

    /** Get the timestamp of the last state change (by anyone).
     * @returns {string|null} ISO timestamp or null if unknown */
    getStateLastAt() {
        return this.#stateLastAt
    }

    /** Get the origin of the current state.
     * @returns {string} One of DeviceStateOrigin.UNKNOWN, .AUTOMATION, .HUMAN */
    getStateOrigin() {
        return this.#stateOrigin
    }

    /** Whether this device participates in origin classification at all. Only
     * @returns {boolean} false by default */
    shouldTrackOrigin() {
        return false
    }

    //  -- Origin classification tuning --------------------------------------

    /** Echo window for instant commands (ON/OFF/TOGGLE), read live from main config
     * @returns {number} Window in milliseconds (> 0) */
    getInstantEchoWindowMs() {
        return this.#durationFromConfig('automation.echo_window_instant_ms', INSTANT_ECHO_WINDOW_DEFAULT_MS)
    }

    /** Echo window for travel commands (OPEN/CLOSE/POS:N/STOP); see
     * @returns {number} Window in milliseconds (> 0) */
    getTravelEchoWindowMs() {
        return this.#durationFromConfig('automation.echo_window_travel_ms', TRAVEL_ECHO_WINDOW_DEFAULT_MS)
    }

    /** Motion-stall watchdog timeout; see {@link getInstantEchoWindowMs} for
     * @returns {number} Timeout in milliseconds (> 0) */
    getMotionStallTimeoutMs() {
        return this.#durationFromConfig('automation.motion_stall_timeout_ms', MOTION_STALL_TIMEOUT_DEFAULT_MS)
    }

    /** Settle-absorption window (ms): how long follow-up reports of a just-confirmed travel
     * @returns {number} Window in milliseconds */
    getSettleAbsorbWindowMs() {
        return this.#durationFromConfig('automation.settle_absorb_window_ms', SETTLE_ABSORB_WINDOW_DEFAULT_MS)
    }

    /** Pre-motion grace during which near-target travel reports cannot confirm completion;
     * @returns {number} Grace window in milliseconds (> 0) */
    getTravelEchoGraceMs() {
        return this.#durationFromConfig('automation.travel_echo_grace_ms', TRAVEL_ECHO_GRACE_DEFAULT_MS)
    }

    /** Backoff (ms) before re-dispatching an automated command that produced no observable
     * @returns {number} Backoff in milliseconds */
    getFailedCommandBackoffMs() {
        return this.#durationFromConfig('automation.failed_command_backoff_ms', FAILED_COMMAND_BACKOFF_DEFAULT_MS)
    }

    /** Shared duration-config reader: accepts plain milliseconds or a human-readable.
     * @private
     * @param {string} key - Main config key name
     * @param {number} defaultMs - Fallback value in milliseconds
     * @returns {number} Duration in milliseconds (> 0) */
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

    //  -- Event emission ---------------------------------------------------

    /** Emit an event with optional data.
     * @param {string} eventType - The type of event to emit
     * @param {Object} [data={}] - Optional data to pass with the event */
    emit(eventType, data = {}) {
        if (eventType === 'mqttMessage') {
            this.handleMqttMessage(data)
        }

        const listeners = this.#eventListeners.get(eventType)
        if (listeners) {
            listeners.forEach(callback => callback(data))
        }
    }

    /** Resolve the human-interaction cooldown duration in whole seconds.
     * @private
     * @returns {number} Cooldown in whole seconds (>= 0) */
    #humanCooldownSeconds() {
        const raw = ConfigService.get('automation.human_interaction_cooldown_ms')
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

    /** Mark the device as human-controlled for a given payload: flip origin.
     * @private
     * @param {*} parsed - New state payload from MQTT
     * @param {string} reason - Why this is attributed to a human (for logs)
     * @param {'debug'|'warn'} [level='debug'] - Log level for the attribution line */
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
        //  A genuine external change means the device moved -- allow ineffective-command retries again.
        this.#failedCommand = null
        this.#clearPendingCommandMarker()
        this.#writeHumanCooldown(reason)
    }

    /** Start the Redis human-interaction cooldown for this device.
     * @private
     * @param {string} reason - Why the cooldown is starting (for logs) */
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

    /** Redis key for the persisted in-flight automation expectation.
     * @private
     * @returns {string} */
    #pendingMarkerKey() {
        return this.#cacheKey + PENDING_MARKER_KEY_SUFFIX
    }

    /** Persist the active correlator token so a restart mid-motion does not lose.
     * @private
     * @param {string} description - Normalized command description (ON/OFF/OPEN/CLOSE/STOP/TOGGLE or "POS:N")
     * @param {'instant'|'travel'|'wildcard'} kind - Command family
     * @param {number} ttlMs - Token lifetime in milliseconds */
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

    /** Remove any persisted in-flight automation marker (best-effort cleanup; the
     * @private */
    #clearPendingCommandMarker() {
        CacheService.delete(this.#pendingMarkerKey())
            .catch(err => {
                LoggerService.debug(`Could not clear in-flight automation marker: ${err.message}`, `${this.getLogPrefix()}:${this.#name}`)
            })
    }

    //  -- Motion watchdog ----------------------------------------------------

    /** Arm (or re-arm) the stall watchdog for an active travel expectation. Only
     * @private */
    #armMotionWatchdog() {
        this.#clearMotionWatchdog()
        const token = this.#correlator.getActiveToken()
        if (!token || token.kind !== 'travel' || token.expectedState === 'STOP') return

        const timeoutMs = this.getMotionStallTimeoutMs()
        this.#stallTimer = setTimeout(() => {
            this.#stallTimer = null
            const live = this.#correlator.getActiveToken()
            if (!live || live.kind !== 'travel' || live.expectedState === 'STOP') return
            LoggerService.trace(
                `watchdog fired expectedState=${live.expectedState} progressObserved=${live.progressObserved}` +
                    ` lastKnownPosition=${Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : 'null'}` +
                    ` -> ${live.progressObserved ? 'stalled-after-progress (human)' : 'no-response (backoff)'}`,
                `${this.getLogPrefix()}:${this.#name}`
            )
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
        //  Do not keep the process alive just for a watchdog.
        this.#stallTimer.unref?.()
    }

    /** Handle an automated travel command that showed no progress within its motion.
     * @private
     * @param {string} expectedState - the commanded description (OPEN/CLOSE/POS:N) */
    #handleNoResponseStall(expectedState) {
        LoggerService.warn(
            `Automated command ${expectedState} produced no observable response -- possible offline/faulty device; backing off identical retries`,
            `${this.getLogPrefix()}:${this.#name}`
        )
        const pos = Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : null
        this.#failedCommand = {
            description: expectedState,
            positionAtFailure: pos,
            until: Date.now() + this.getFailedCommandBackoffMs()
        }
        LoggerService.trace(
            `no-response stall recorded description=${expectedState} positionAtFailure=${pos ?? 'null'} backoffMs=${this.getFailedCommandBackoffMs()}`,
            `${this.getLogPrefix()}:${this.#name}`
        )
    }

    /** Clear any armed stall watchdog.
     * @private */
    #clearMotionWatchdog() {
        if (this.#stallTimer != null) {
            clearTimeout(this.#stallTimer)
            this.#stallTimer = null
        }
    }

    /** Map a normalized command description to its correlator family.
     * @private
     * @param {string} description - Normalized description (ON/OFF/OPEN/CLOSE/STOP/TOGGLE or "POS:N")
     * @returns {'instant'|'travel'|'wildcard'} */
    #commandKindFor(description) {
        const state = String(description ?? '').toUpperCase()
        if (state === 'OPEN' || state === 'CLOSE' || state === 'STOP' || state.startsWith('POS:')) return 'travel'
        if (state === 'TOGGLE') return 'wildcard'
        return 'instant'
    }

    /** Serialize an object payload for correlation ONLY when it carries multi-channel (suffixed)
     *  fields; otherwise return null so callers fall back to the scalar description. This keeps
     *  single-state devices on their existing code path untouched.
     * @private
     * @param {*} payload - Candidate command payload
     * @returns {string|null} JSON of the payload when it has at least one suffixed field, else null */
    #multiChannelJson(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
        const hasSuffixed = Object.keys(payload).some(k => /^(state|position|brightness)_/i.test(String(k)))
        return hasSuffixed ? JSON.stringify(payload) : null
    }

    //  -- MQTT message handling --------------------------------------------

    /** Handle incoming MQTT messages.
     * @param {Object} data - Event data containing topic and message */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            LoggerService.debug(`Malformed JSON payload: ${data.message}`, `${this.getLogPrefix()}:${this.#name}`)
            parsed = data.message
        }

        //  File-only TRACE intake record: raw payload plus live-token context.
        const activeSnapshot = this.#correlator.getActiveToken()
        LoggerService.trace(
            `MQTT intake topic="${data.topic}" payload=${JSON.stringify(parsed)}` +
                (activeSnapshot
                    ? ` token={expectedState:${activeSnapshot.expectedState}, kind:${activeSnapshot.kind}, progressObserved:${activeSnapshot.progressObserved}}`
                    : ' token=null'),
            `${this.getLogPrefix()}:${this.#name}`
        )

        if (!this.shouldTrackOrigin()) {
            // Payload-only refresh for non-actuator devices.
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
                    //  Confirmed outcome of our own rule-engine command: keep AUTOMATION.
                    LoggerService.debug('Automation echo matched -- origin=automation', `${this.getLogPrefix()}:${this.#name}`)
                    this.#clearMotionWatchdog()
                    this.#clearPendingCommandMarker()
                    //  Begin short settle-absorption so tail reports of this same physical event.
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
                    //  Commanded motion still in progress (slow shutters etc.)
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
                    //  Reported motion contradicts our active command: someone else moved it.
                    this.#markHumanInteraction(parsed, 'external override detected during automated motion', 'warn')
                    break
                }
                default: {
                    const hadStateChange = this.#didStateChange(parsed)
                    if (hadStateChange) {
                        //  Observed reality moved: independent evidence about where the device
                        //  actually is, so any doubt left by an unconfirmed command is resolved.
                        this.#correlator.noteObservedChange()
                    }
                    if (!hadStateChange) {
                        //  Periodic report / no meaningful change -- payload only, origin untouched.
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else if (this.#correlator.hasActive()) {
                        // Unmatched change while an expectation is still alive.
                        LoggerService.debug('Unmatched change inside active command window -- preserving origin', `${this.getLogPrefix()}:${this.#name}`)
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else if (this.#correlator.absorbPostCompletionReport(parsed)) {
                        // Small positional wobble around a just-confirmed outcome.
                        LoggerService.debug('Post-completion settling report absorbed -- origin preserved', `${this.getLogPrefix()}:${this.#name}`)
                        this.#stateLast = parsed
                        this.setCachedState(parsed, {
                            stateLastAt: this.#stateLastAt,
                            origin: this.#stateOrigin
                        }).catch(err => {
                            this.log(`Failed to cache state: ${err.message}`, 'error')
                        })
                    } else {
                        //  Changed with no automation explanation -> human interaction.
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

    /** Receive a command from another device (e.g., a Remote) or from automation.
     * @param {string|Object} command - Command to send. Either a state string
     * @param {DeviceCommandSource} [source=DeviceCommandSource.HUMAN] - Who is behind this command
     * @param {Object} [options] - Dispatch modifiers
     * @param {boolean} [options.bypassNoOpSuppression=false] - Send even when the cached state
     *   already matches the commanded state. Reserved for hand-off/restore dispatches, where the
     *   cache may be a stale pre-command snapshot and the command MUST reach the device. */
    receiveCommand(command, source = DeviceCommandSource.HUMAN, options = {}) {
        let finalPayload
        let description

        //  Build payload -- no extra fields merged, just the command itself.
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

        //  --- Suppress redundant commands ---
        if (options?.bypassNoOpSuppression === true) {
            LoggerService.debug(
                `No-op suppression bypassed for "${description}" (re-assert requested)`,
                `${this.getLogPrefix()}:${this.#name}`
            )
        } else if (this.#isCommandRedundant(finalPayload, description)) {
            LoggerService.info(
                `Command "${description}" suppressed: device already at target state`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            LoggerService.trace(
                `redundancy check hit description=${description} cachedPosition=${Number.isFinite(this.#stateLast?.position) ? this.#stateLast.position : 'null'} tolerance=+/-${POSITION_MATCH_TOLERANCE}`,
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
                //  The person still expressed intent even though nothing moved.
                this.#writeHumanCooldown('redundant human command suppressed -- intent still counts')
            }
            return
        }

        //  --- Suppress retries of ineffective automation commands ---
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
                    LoggerService.trace(
                        `backoff suppressed ${description} failure={pos:${fc.positionAtFailure ?? 'null'}, untilInMs:${Math.max(0, fc.until - Date.now())}} posNow=${posNow ?? 'null'}`,
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

        //  Defer correlator registration and origin assignment until the message.
        const _onPublish = () => {
            const now = new Date().toISOString()
            self.#stateLastAt = now

            if (isAutomation) {
                //  Rule-engine action: register the expectation so its echoes are.
                //  Multi-channel devices (dual switch/dimmer) publish suffixed payloads whose scalar
                //  description is a JSON blob; correlate them on the STATE channels -- the reliable
                //  echo signal -- so their instant tokens confirm via real echoes instead of always
                //  expiring unconfirmed. DualDimmer passes options.correlateAs to unify its split
                //  state+brightness messages onto one state-based expectation (see doc/ht-lights-bug.md).
                const corrSource = options?.correlateAs && typeof options.correlateAs === 'object'
                    ? options.correlateAs
                    : finalPayload
                const corrDescription = self.#multiChannelJson(corrSource) ?? description
                const kind = self.#commandKindFor(corrDescription)
                const ttlMs = kind === 'travel' ? self.getTravelEchoWindowMs() : self.getInstantEchoWindowMs()
                self.#correlator.register(corrDescription, {
                    kind,
                    anchorPosition: Number.isFinite(self.#stateLast?.position) ? self.#stateLast.position : null,
                    anchorState: typeof self.#stateLast?.state === 'string' ? String(self.#stateLast.state).toUpperCase() : null,
                    echoGraceMs: self.getTravelEchoGraceMs()
                }, ttlMs)
                self.#stateOrigin = DeviceStateOrigin.AUTOMATION
                self.#persistPendingCommandMarker(corrDescription, kind, ttlMs)
                self.#armMotionWatchdog()
            } else {
                //  Human-directed command: invalidate any stale automation expectations NOW --
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

        LoggerService.trace(`publish source=${source} topic="${topic}" payload=${JSON.stringify(finalPayload)}`, `${this.getLogPrefix()}:${this.#name}`)
        this.#mqttService.publish(topic, JSON.stringify(finalPayload), { meta: { onPublish: _onPublish } })
        LoggerService.info(
            `Command "${description}" sent to topic ${topic}`,
            `${this.getLogPrefix()}:${this.#name}`
        )
    }

    //  -- MQTT subscription management -------------------------------------

    /** Set MQTT service for this device to use for subscriptions and publishing.
     * @param {Object} mqttService - The MQTT service instance */
    setMqttService(mqttService) {
        this.#mqttService = mqttService
        this.#subscribeToTopics()
    }

    /** Publish a message to an arbitrary MQTT topic.
     * @protected
     * @param {string} topic - MQTT topic to publish to
     * @param {string} payload - Message payload (already stringified) */
    publish(topic, payload) {
        if (!this.#mqttService) {
            LoggerService.warn(`Cannot publish to "${topic}": MqttService not available`, `${this.getLogPrefix()}:${this.#name}`)
            return
        }
        this.#mqttService.publish(topic, payload)
    }

    /** Return the list of MQTT topics this device should subscribe to.
     * @param {string} prefix - MQTT topic prefix (e.g., "zigbee2mqtt")
     * @returns {string[]} Array of topic strings to subscribe to */
    getSubscribedTopics(prefix) {
        return [`${prefix}/${this.getName()}`]
    }

    /** Idempotent re-subscription called after MQTT reconnect. */
    reconnect() {
        this.#subscribeToTopics()
    }

    /** Clean up all MQTT subscriptions for this device. */
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

    //  -- Private helpers --------------------------------------------------

    /** Subscribe to all topics returned by getSubscribedTopics().
     * @private */
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

    /** Detect whether an incoming MQTT payload represents a genuine state change.
     * @param {Object} newPayload - Parsed MQTT message payload
     * @returns {boolean} true if the payload represents a meaningful state change
     * @private */
    #didStateChange(newPayload) {
        if (typeof newPayload !== 'object' || newPayload === null) return true

        const old = this.#stateLast
        //  Cold start or empty baseline: treat incoming data as calibration.
        if (!old || typeof old !== 'object' || Object.keys(old).length === 0) {
            return false
        }

        //  Positional telemetry is ground truth for mechanisms like roller shutters.
        const stableNewPos = Number(newPayload.position)
        const stableOldPos = Number(old.position)
        const positionUnchanged = Number.isFinite(stableNewPos) && Number.isFinite(stableOldPos)
            && Math.abs(stableNewPos - stableOldPos) <= POSITION_MATCH_TOLERANCE

        //  Compare state field (ON/OFF/OPEN/CLOSE/STOP)
        if (!positionUnchanged) {
            if ('state' in newPayload && 'state' in old) {
                if (String(newPayload.state) !== String(old.state)) return true
            } else if ('state' in newPayload || 'state' in old) {
                return true
            }
        }

        //  Compare position field with tolerance for roller shutters.
        if ('position' in newPayload && 'position' in old) {
            const newPos = Number(newPayload.position)
            const oldPos = Number(old.position)
            if (!isNaN(newPos) && !isNaN(oldPos) && Math.abs(newPos - oldPos) > POSITION_MATCH_TOLERANCE) return true
        } else if ('position' in newPayload || 'position' in old) {
            return true
        }

        //  Multi-channel devices (DualSwitch/DualDimmer) report per-channel fields such.
        const SUFFIXED_FIELD_RE = /^(?:state|position|brightness)_/
        const suffixedUnion = [...new Set([
            ...Object.keys(newPayload).filter(k => SUFFIXED_FIELD_RE.test(k)),
            ...Object.keys(old).filter(k => SUFFIXED_FIELD_RE.test(k))
        ])]
        for (const k of suffixedUnion) {
            if ((k in newPayload) !== (k in old)) return true
            const a = newPayload[k]
            const b = old[k]
            if (typeof a === 'number' || typeof b === 'number') {
                const na = Number(a)
                const nb = Number(b)
                if (!Number.isFinite(na) || !Number.isFinite(nb)) continue
                if (Math.abs(na - nb) > POSITION_MATCH_TOLERANCE) return true
            } else if (String(a) !== String(b)) {
                return true
            }
        }

        //  Compare illuminance with threshold.
        if ('illuminance' in newPayload && 'illuminance' in old) {
            const diff = Math.abs(Number(newPayload.illuminance) - Number(old.illuminance))
            if (diff > ILLUMINANCE_CHANGE_THRESHOLD) return true
        } else if ('illuminance' in newPayload || 'illuminance' in old) {
            return true
        }

        //  Compare temperature with threshold.
        if ('temperature' in newPayload && 'temperature' in old) {
            const diff = Math.abs(Number(newPayload.temperature) - Number(old.temperature))
            if (diff > TEMPERATURE_CHANGE_THRESHOLD) return true
        } else if ('temperature' in newPayload || 'temperature' in old) {
            return true
        }

        //  Compare humidity with threshold.
        if ('humidity' in newPayload && 'humidity' in old) {
            const diff = Math.abs(Number(newPayload.humidity) - Number(old.humidity))
            if (diff > HUMIDITY_CHANGE_THRESHOLD) return true
        } else if ('humidity' in newPayload || 'humidity' in old) {
            return true
        }

        return false
    }

    /** Determine whether an outgoing command would be redundant given the cached state.
     * @param {Object} finalPayload - The resolved payload object ({state: ...} or {position: ...})
     * @param {string} description - Human-readable description (e.g., "POS:12", "OPEN")
     * @returns {boolean} true if the command is redundant and should be suppressed
     * @private */
    #isCommandRedundant(finalPayload, description) {
        const cached = this.#stateLast

        //  No cached state -> we can't compare, so always send.
        if (!cached || typeof cached !== 'object' || Object.keys(cached).length === 0) {
            return false
        }

        //  A no-op is only provable from a CONFIRMED state. When our own last automation command
        //  expired without confirmation, the cached value may still describe the pre-command
        //  world -- a plug can execute a command and never report it -- so suppressing a later
        //  command would freeze that stale value in place. This is exactly how the home-theater
        //  ambient restore silently failed (see doc/ht-lights-bug.md). Self-limiting: dispatching
        //  the replacement command registers a fresh token and clears the marker, so this adds at
        //  most one extra publish per unconfirmed command.
        const unconfirmed = this.#correlator.getUnconfirmed()
        if (unconfirmed != null) {
            LoggerService.trace(
                `redundancy check skipped -- state unverified after unconfirmed ${unconfirmed.expectedState}`,
                `${this.getLogPrefix()}:${this.#name}`
            )
            return false
        }

        const descUpper = String(description).toUpperCase()

        //  --- Position-based commands ---
        if ('position' in finalPayload && typeof finalPayload.position === 'number') {
            const targetPos = finalPayload.position
            const cachedPos = cached.position

            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                return Math.abs(cachedPos - targetPos) <= POSITION_MATCH_TOLERANCE
            }
            return false
        }

        //  --- Multi-channel commands ({state_l1,...}, {brightness_l1,...}, {position_l1,...}) ---
        //  Dual switches/dimmers report per-channel suffixed fields; a command is redundant only
        //  when EVERY commanded channel already matches the cache (exact for state, within tolerance
        //  for numeric levels/positions). Without this, healthy multi-channel devices could never be
        //  proven no-ops and sticky automations would spam them every tick.
        const mcKeys = Object.keys(finalPayload).filter(k => /^(state|brightness|position)_/.test(String(k)))
        if (mcKeys.length > 0) {
            return mcKeys.every(ch => {
                const cmdVal = finalPayload[ch]
                const cachedVal = cached[ch]
                if (/^state_/.test(ch)) {
                    return typeof cachedVal === 'string' && cachedVal.toUpperCase() === String(cmdVal).toUpperCase()
                }
                const cNum = Number(cachedVal)
                const vNum = Number(cmdVal)
                if (!Number.isFinite(cNum) || !Number.isFinite(vNum)) return false
                const tol = /^position_/.test(ch) ? POSITION_MATCH_TOLERANCE : 1
                return Math.abs(cNum - vNum) <= tol
            })
        }

        //  --- State-based commands ---
        if ('state' in finalPayload) {
            const cmdState = String(finalPayload.state).toUpperCase()

            //  TOGGLE has no deterministic target -- always send.
            if (cmdState === 'TOGGLE') return false

            //  Direct state comparison for ON/OFF devices (lights, switches).
            if (cmdState === 'ON' || cmdState === 'OFF') {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                return cachedState === cmdState
            }

            //  Roller shutter semantic commands: compare against cached position.
            const cachedPos = cached.position
            if (typeof cachedPos === 'number' && !isNaN(cachedPos)) {
                if (cmdState === 'OPEN' && cachedPos >= POSITION_NEARLY_OPEN_THRESHOLD) return true
                if (cmdState === 'CLOSE' && cachedPos <= POSITION_NEARLY_CLOSED_THRESHOLD) return true
            }

            //  Fallback: when no reliable position data is available, use cached state field.
            if ((cachedPos === undefined || typeof cachedPos !== 'number') && (cmdState === 'OPEN' || cmdState === 'CLOSE')) {
                const cachedState = typeof cached.state === 'string' ? cached.state.toUpperCase() : null
                if (cachedState && cachedState === cmdState) return true
            }
        }

        return false
    }

    /** Extract a meaningful summary from a JSON payload.
     * @param {string} message - Raw message string
     * @returns {string} Human-readable summary
     * @private */
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

    //  -- Logging helpers --------------------------------------------------

    /** Return the label used in log prefixes.
     * @returns {string} Log prefix label */
    getLogPrefix() {
        return 'Device'
    }

    /** Unified logging helper with device prefix. Default level is debug.
     * @param {string} message - Message to log */
    log(message) {
        LoggerService.debug(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /** Log a warning message with device prefix.
     * @param {string} message - Message to log */
    warn(message) {
        LoggerService.warn(message, `${this.getLogPrefix()}:${this.#name}`)
    }

    /** Log an error message with device prefix.
     * @param {string} message - Message to log */
    error(message) {
        LoggerService.error(message, `${this.getLogPrefix()}:${this.#name}`)
    }
}