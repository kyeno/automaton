/**
 * DualSwitch -- multi-channel wall switches (two or more independent on/off
 * outputs exposed by a single zigbee2mqtt device, e.g. "left"/"right" buttons
 * or "l1"/"l2" channels).
 *
 * Extends Mechanism so it participates in origin tracking, redundancy checks,
 * echo correlation, and the mechanism UI bucket exactly like any other actuator,
 * while translating commands into per-channel suffixed payloads that zigbee2mqtt
 * understands natively:
 *
 *   - bare string commands ("ON", "OFF", "TOGGLE") fan out to every configured
 *     channel at once:  {state_left:'ON', state_right:'ON'}
 *   - object commands may target one channel explicitly via `channel`,
 *     validated against the declared topology; unknown channels warn + no-op
 *
 * Channel references use the positional AI vocabulary (ONE/TWO, mapped by
 * declaration order -- see src/lib/channelAliases.js); raw wire names are
 * accepted as identity aliases so existing payloads keep working.
 *   - `{action: ...}` MQTT reports are routed through the InteractionContainer
 *     under this device's slugified name, preserving YAML interaction bindings
 *     (e.g. Kuchnia Wlacznik Jadalnia right button -> Kuchnia Gniazdo) without
 *     turning the switch itself into a Remote
 *
 * Channel topology is declarative, coming from etc/device/zigbee.yaml entries:
 *   mechanism:
 *     - name: "Kuchnia Wlacznik Jadalnia"
 *       type: dualSwitch
 *       channels: [left, right]
 * Devices typed as dualSwitch without `channels` degrade gracefully to plain
 * single-state Mechanism behavior instead of silently becoming dummies.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import temporal from '../../lib/date.js'
import { POSITIONAL_NAMES, resolveChannelAlias } from '../../lib/channelAliases.js'
import LoggerService from '../../service/loggerService.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'
import InteractionContainer from '../../interaction/container/interactionContainer.js'
import Mechanism from './mechanism.js'

/** Debounce window for physical button actions -- mirrors Remote's default so
 *  rapid double events from one press are not routed twice. */
const BUTTON_DEBOUNCE_WINDOW_MS = 800

export default class DualSwitch extends Mechanism {
    #lastActionTime = 0
    #debounceWindowMs = BUTTON_DEBOUNCE_WINDOW_MS

    // -- Identity -----------------------------------------------------------

    /**
     * Return the log prefix label for dual switches.
     * @returns {string}
     */
    getLogPrefix() {
        return 'DualSwitch'
    }

    /**
     * Whether this device supports per-channel brightness at all. DualSwitch is
     * on/off only; DualDimmer overrides to true.
     * @returns {boolean} false
     */
    supportsBrightness() {
        return false
    }

    // -- Channel topology ---------------------------------------------------

    /**
     * Resolve the configured channel list (e.g. ['left','right'] or ['l1','l2']).
     * Values are lowercased and trimmed; empty entries dropped. Returns null when
     * no usable `channels` array was declared in the device config, which callers
     * treat as "degrade to plain single-state mechanism behavior".
     * @returns {Array<string>|null} Configured channel names, or null
     */
    getChannels() {
        const raw = this.getData()?.channels
        if (!Array.isArray(raw)) return null

        const channels = raw
            .map((c) => String(c).trim().toLowerCase())
            .filter(Boolean)
        return channels.length > 0 ? channels : null
    }

    // -- Command translation --------------------------------------------------

    /**
     * Translate a command into zigbee2mqtt's suffixed multi-channel payload shape
     * before delegating to the base publisher. Bare ON/OFF/TOGGLE fan out across
     * all channels; object commands may narrow scope with `channel`. Commands that
     * cannot be expressed on this topology warn and are dropped instead of being
     * published as an invalid generic `{state}` payload.
     *
     * @param {string|Object} command - State string or structured payload (may carry channel/brightness/state keys; brightness may be a number or a per-channel map)
     * @param {DeviceCommandSource} [source=DeviceCommandSource.HUMAN] - Who is behind this command
     */
    receiveCommand(command, source = DeviceCommandSource.HUMAN) {
        const channels = this.getChannels()

        // No declared topology: behave exactly like a plain mechanism so devices
        // typed dualSwitch without channels keep working with legacy payloads.
        // Multi-channel-only keys are stripped so they never leak into the payload.
        if (!channels) {
            if (typeof command === 'object' && command !== null
                && ('channel' in command || 'brightness' in command)) {
                const { channel, brightness, ...rest } = command
                if (Object.keys(rest).length === 0) {
                    this.warn('channel/brightness requested but no channels configured -- command dropped')
                    return
                }
                this.warn('channel/brightness ignored -- no channels configured, using single-state behavior')
                return super.receiveCommand(rest, source)
            }
            LoggerService.debug(
                'No "channels" configured for dual switch -- falling back to single-state behavior',
                `${this.getLogPrefix()}:${this.getName()}`
            )
            return super.receiveCommand(command, source)
        }

        const resolved = this._resolveCommand(command, channels)
        if (resolved === null) return // already logged why it was dropped

        this._publishResolved(resolved, source)
    }

    /**
     * Build the state_* fields of the payload for a resolved command. Kept as a
     * separate helper so DualDimmer can compose its own brightness_* fields on top
     * and so the split-publish path can build each half independently.
     * @param {Array<string>} targetChannels - Channels the command applies to
     * @param {string|null} fieldState - ON/OFF/TOGGLE value, or null when absent
     * @returns {Object} Partial payload with one state_<channel> key per channel (empty when no state requested)
     * @protected
     */
    _buildStateFields(targetChannels, fieldState) {
        const payload = {}
        if (fieldState !== null) {
            for (const ch of targetChannels) {
                payload[`state_${ch}`] = fieldState
            }
        }
        return payload
    }

    /**
     * Build the brightness_* fields of the payload for a resolved command. Base
     * DualSwitch is on/off only, so this returns an empty object; DualDimmer
     * overrides it to map the requested percentage into per-channel level fields.
     * @param {Array<string>} targetChannels - Channels the command applies to
     * @param {number|Object<string, number>|undefined} fieldBrightness - Uniform percentage 0-100, or a per-channel percentage map, if any
     * @returns {Object} Partial payload with one brightness_<channel> key per channel (empty when none requested)
     * @protected
     */
    _buildBrightnessFields(targetChannels, fieldBrightness) {
        return {}
    }

    /**
     * Compose the full wire payload (state_* + brightness_*) for a resolved command.
     * @param {{targetChannels: Array<string>, fieldState: string|null, fieldBrightness: (number|Object<string, number>)|undefined}} resolved - Resolved command
     * @returns {Object|null} Payload ready for zigbee2mqtt, or null when empty
     * @protected
     */
    _buildPayload(resolved) {
        const { targetChannels, fieldState, fieldBrightness } = resolved
        const payload = {
            ...this._buildStateFields(targetChannels, fieldState),
            ...this._buildBrightnessFields(targetChannels, fieldBrightness)
        }
        return Object.keys(payload).length > 0 ? payload : null
    }

    /**
     * Publish a raw payload to zigbee2mqtt via the base mechanism publisher,
     * bypassing this class's command translation. Used by the split-publish path
     * so DualDimmer can emit state and brightness as separate messages without
     * re-entering the translator.
     * @param {Object} payload - Payload ready for zigbee2mqtt
     * @param {DeviceCommandSource} source - Who is behind this command
     * @protected
     */
    _publishRaw(payload, source) {
        super.receiveCommand(payload, source)
    }

    /**
     * Publish a resolved command to zigbee2mqtt. Default: a single combined
     * payload. DualDimmer overrides this to split state and brightness into two
     * sequential publishes because some converters (Tuya/AVATTO) drop combined
     * payloads.
     * @param {{targetChannels: Array<string>, fieldState: string|null, fieldBrightness: (number|Object<string, number>)|undefined}} resolved - Resolved command
     * @param {DeviceCommandSource} source - Who is behind this command
     * @protected
     */
    _publishResolved(resolved, source) {
        const payload = this._buildPayload(resolved)
        if (payload) this._publishRaw(payload, source)
    }

    /**
     * Resolve a raw command into its effective scope and fields without building
     * the wire payload. Returns null (with a warning) when the command cannot be
     * expressed on this device's topology.
     *
     * Recognizes the `SET_BRIGHTNESS` sentinel in the state/action slot: the model
     * learned that verb from our own "AI performed SET_BRIGHTNESS=NN" log lines, so
     * it is accepted as "set brightness only, leave state alone" rather than
     * rejected as an unknown state.
     *
     * @param {string|Object} command - Raw command from any caller
     * @param {Array<string>} channels - Validated channel names
     * @returns {{targetChannels: Array<string>, fieldState: string|null, fieldBrightness: (number|Object<string, number>)|undefined}|null} Resolved command, or null to drop
     * @protected
     */
    _resolveCommand(command, channels) {
        let fieldState = null              // 'ON' | 'OFF' | 'TOGGLE'
        let fieldBrightness = undefined    // percentage 0-100 (dimmers only)
        let targetChannels = channels

        if (typeof command === 'string') {
            const st = String(command).toUpperCase()
            if (!['ON', 'OFF', 'TOGGLE'].includes(st)) {
                this.warn(`Unsupported command "${command}" on dual switch -- expected ON/OFF/TOGGLE`)
                return null
            }
            fieldState = st
        } else if (command && typeof command === 'object') {
            if ('channel' in command) {
                // Positional aliases (ONE/TWO/1/2) map by declaration order; raw
                // wire names pass through as identity aliases.
                const ch = resolveChannelAlias(channels, command.channel)
                if (ch === null) {
                    this.warn(
                        `Unknown channel "${command.channel}" -- valid channels: `
                        + `${channels.map((c, i) => `${POSITIONAL_NAMES[i] ?? c} (${c})`).join(', ')}. Command dropped.`
                    )
                    return null
                }
                targetChannels = [ch]
            }

            if ('state' in command || 'action' in command) {
                const st = String(command.state ?? command.action).toUpperCase()
                if (st === 'SET_BRIGHTNESS') {
                    // Sentinel the model learned from our own log lines: means
                    // "set brightness only, leave state alone."
                    fieldState = null
                } else if (['ON', 'OFF', 'TOGGLE'].includes(st)) {
                    fieldState = st
                } else {
                    this.warn(`Unsupported state "${st}" for dual switch -- expected ON/OFF/TOGGLE. Command dropped.`)
                    return null
                }
            }

            if ('brightness' in command) {
                if (command.brightness !== null && typeof command.brightness === 'object'
                    && !Array.isArray(command.brightness)) {
                    // Per-channel map: {l1: 50, l2: 25} (wire names or ONE/TWO
                    // aliases). The mapped channels define the command's scope;
                    // any state field applies to exactly those channels.
                    if ('channel' in command) {
                        this.warn('Both "channel" and a per-channel brightness map were given -- ambiguous. Command dropped.')
                        return null
                    }
                    const map = {}
                    for (const [ref, value] of Object.entries(command.brightness)) {
                        const ch = resolveChannelAlias(channels, ref)
                        if (ch === null) {
                            this.warn(
                                `Unknown channel "${ref}" in per-channel brightness -- valid channels: `
                                + `${channels.map((c, i) => `${POSITIONAL_NAMES[i] ?? c} (${c})`).join(', ')}. Command dropped.`
                            )
                            return null
                        }
                        const b = Number(value)
                        if (!Number.isFinite(b) || b < 0 || b > 100) {
                            this.warn(`Invalid brightness "${value}" for channel "${ch}" -- expected a number between 0 and 100. Command dropped.`)
                            return null
                        }
                        map[ch] = Math.round(b)
                    }
                    if (Object.keys(map).length === 0) {
                        this.warn('Per-channel brightness map is empty. Command dropped.')
                        return null
                    }
                    fieldBrightness = map
                    targetChannels = Object.keys(map)
                } else {
                    const b = Number(command.brightness)
                    if (!Number.isFinite(b) || b < 0 || b > 100) {
                        this.warn(`Invalid brightness "${command.brightness}" -- expected a number between 0 and 100. Command dropped.`)
                        return null
                    }
                    fieldBrightness = Math.round(b)
                }
            }

            // Brightness is only meaningful on dimmable subclasses; warn instead of
            // silently publishing a field the converter may ignore or reject. Checked
            // before the "no usable fields" gate so a brightness-only command on a
            // non-dimmable device is dropped with an explanatory warning.
            if (fieldBrightness !== undefined && !this.supportsBrightness()) {
                this.warn(`Channel(s) [${targetChannels.join(', ')}] are not dimmable -- ignoring brightness`)
                fieldBrightness = undefined
            }

            if (fieldState === null && fieldBrightness === undefined) {
                this.warn('Command carries no usable state/brightness fields for this dual switch. Dropped.')
                return null
            }
        } else {
            this.warn(`Unsupported command type ${typeof command} on dual switch. Dropped.`)
            return null
        }

        return { targetChannels, fieldState, fieldBrightness }
    }

    // -- Button action passthrough -------------------------------------------

    /**
     * Override handleMqttMessage so `{action: ...}` reports from physical buttons
     * are routed through the InteractionContainer under this device's slugified
     * name -- preserving YAML interaction bindings (Jadalnia right button ->
     * Kuchnia Gniazdo) without reclassifying the switch as a Remote. The report is
     * still cached/logged via super exactly like Remote does today.
     *
     * @param {Object} data - Event data containing topic and message
     */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            parsed = data.message
        }

        if (parsed && typeof parsed === 'object' && parsed.action) {
            this.processButtonAction(parsed.action, parsed)
        }

        // Always call parent to cache and log the message (default behavior).
        super.handleMqttMessage(data)
    }

    /**
     * Route one physical button action with debounce protection, mirroring
     * Remote's semantics: 800ms window per instance, then lookup by slugified
     * friendly name in the shared interaction registry. When no interaction is
     * registered for this device the press is logged and ignored -- dual switches
     * have no legacy action-map fallback of their own.
     *
     * @param {string} action - Action identifier from zigbee2mqtt (e.g., "single_right")
     * @param {Object} [data] - Full parsed message payload for context
     */
    processButtonAction(action, data = {}) {
        if (this.#isDebounced()) return

        this.#lastActionTime = Date.now()

        const routed = InteractionContainer.routeDeviceAction(this.getName(), { action })
        if (!routed) {
            this.log(`No interaction registered for button action "${action}" -- ignored`)
        } else {
            LoggerService.debug(
                `Button action "${action}" routed via interaction registry`,
                `${this.getLogPrefix()}:${this.getName()}`
            )
        }
    }

    /**
     * Check whether a button action falls within the debounce window.
     * @returns {boolean} true when debounced (caller should ignore the event)
     * @private
     */
    #isDebounced() {
        if (!this.#lastActionTime) return false

        const elapsed = Date.now() - this.#lastActionTime
        if (elapsed < this.#debounceWindowMs) {
            this.log(
                `Debounced button press (${temporal.millisecondsToHumanReadable(elapsed)} ago, ` +
                `window ${temporal.millisecondsToHumanReadable(this.#debounceWindowMs)})`
            )
            return true
        }
        return false
    }

    // -- State reporting ------------------------------------------------------

    /**
     * Synthesize a per-channel state summary instead of reading a single top-level
     * `state` field that dual switches do not have: "ON | OFF" style output for UI
     * windows and AI context. Falls back to base behavior when no channels are
     * configured or nothing has been reported yet.
     * @returns {Promise<string|null>} Human-readable multi-channel state, or null
     */
    async getCurrentState() {
        const channels = this.getChannels()
        if (!channels) return super.getCurrentState()

        const cached = await this.getCachedState()
        const last = cached?.stateLast ?? {}
        if (typeof last !== 'object' || Object.keys(last).length === 0) {
            return super.getCurrentState()
        }

        const parts = []
        for (const ch of channels) {
            const st = last[`state_${ch}`]
            if (st === undefined) continue
            let part = String(st).toUpperCase()
            if (this.supportsBrightness()) {
                const br = last[`brightness_${ch}`]
                if (Number.isFinite(Number(br))) part += ` (${br})`
            }
            parts.push(part)
        }
        return parts.length > 0 ? parts.join(' | ') : super.getCurrentState()
    }

    // -- Subclass extension points --------------------------------------------
    //
    // DualDimmer extends this class by overriding:
    //   - _buildBrightnessFields: maps the requested percentage into per-channel
    //     brightness_* level fields (base returns an empty object).
    //   - _publishResolved: splits a combined state+brightness command into two
    //     sequential publishes (state first, then brightness) because some
    //     converters (Tuya/AVATTO) drop combined payloads.
}