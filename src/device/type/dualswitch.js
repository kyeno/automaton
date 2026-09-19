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
     * @param {string|Object} command - State string or structured payload (may carry channel/brightness/state keys)
     * @param {DeviceCommandSource} [source=DeviceCommandSource.HUMAN] - Who is behind this command
     */
    receiveCommand(command, source = DeviceCommandSource.HUMAN) {
        const channels = this.getChannels()

        // No declared topology: behave exactly like a plain mechanism so devices
        // typed dualSwitch without channels keep working with legacy payloads.
        if (!channels) {
            LoggerService.debug(
                'No "channels" configured for dual switch -- falling back to single-state behavior',
                `${this.getLogPrefix()}:${this.getName()}`
            )
            return super.receiveCommand(command, source)
        }

        const translated = this.#translateToChannelPayload(command, channels)
        if (translated === null) return // already logged why it was dropped

        super.receiveCommand(translated, source)
    }

    /**
     * Build the state_* fields of the payload for a resolved command. Kept as a
     * separate helper so DualDimmer can compose its own brightness_* fields on top.
     * @param {Array<string>} targetChannels - Channels the command applies to
     * @param {string|null} fieldState - ON/OFF/TOGGLE value, or null when absent
     * @returns {Object} Partial payload with one state_<channel> key per channel (empty when no state requested)
     * @private
     */
    #buildBaseStateFields(targetChannels, fieldState) {
        const payload = {}
        if (fieldState !== null) {
            for (const ch of targetChannels) {
                payload[`state_${ch}`] = fieldState
            }
        }
        return payload
    }

    /**
     * Translate a raw command into the suffixed multi-channel payload shape, or
     * null when it cannot be expressed on this device's topology (with warning).
     * Subclasses extend via {@link _extendPayloadWithExtraFields}.
     *
     * @param {string|Object} command - Raw command from any caller
     * @param {Array<string>} channels - Validated channel names
     * @returns {Object|null} Payload ready for zigbee2mqtt, or null to drop
     * @private
     */
    #translateToChannelPayload(command, channels) {
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
                const ch = String(command.channel).trim().toLowerCase()
                if (!channels.includes(ch)) {
                    this.warn(
                        `Unknown channel "${command.channel}" -- valid channels: ${channels.join(', ')}. Command dropped.`
                    )
                    return null
                }
                targetChannels = [ch]
            }

            if ('state' in command || 'action' in command) {
                const st = String(command.state ?? command.action).toUpperCase()
                if (!['ON', 'OFF', 'TOGGLE'].includes(st)) {
                    this.warn(`Unsupported state "${st}" for dual switch -- expected ON/OFF/TOGGLE. Command dropped.`)
                    return null
                }
                fieldState = st
            }

            if ('brightness' in command) {
                const b = Number(command.brightness)
                if (!Number.isFinite(b) || b < 0 || b > 100) {
                    this.warn(`Invalid brightness "${command.brightness}" -- expected a number between 0 and 100. Command dropped.`)
                    return null
                }
                fieldBrightness = Math.round(b)
            }

            if (fieldState === null && fieldBrightness === undefined) {
                this.warn('Command carries no usable state/brightness fields for this dual switch. Dropped.')
                return null
            }
        } else {
            this.warn(`Unsupported command type ${typeof command} on dual switch. Dropped.`)
            return null
        }

        // Brightness is only meaningful on dimmable subclasses; warn instead of
        // silently publishing a field the converter may ignore or reject.
        if (fieldBrightness !== undefined && !this.supportsBrightness()) {
            this.warn(`Channel(s) [${targetChannels.join(', ')}] are not dimmable -- ignoring brightness`)
            fieldBrightness = undefined
        }

        const payload = this.#buildBaseStateFields(targetChannels, fieldState)
        if (Object.keys(payload).length === 0 && fieldBrightness === undefined) return null

        // Subclasses append their own suffixed fields (brightness_*) here.
        this._extendPayloadWithExtraFields(payload, targetChannels, fieldBrightness)

        return Object.keys(payload).length > 0 ? payload : null
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

    // -- Subclass extension point ---------------------------------------------

    /**
     * Hook for subclasses to append extra per-channel fields (e.g. brightness_*)
     * onto the translated payload. Base DualSwitch adds nothing; DualDimmer maps
     * the requested percentage into its own suffixed keys here.
     * @param {Object} payload - Payload being built (mutated in place)
     * @param {Array<string>} targetChannels - Channels the command applies to
     * @param {number|undefined} fieldBrightness - Requested percentage, if any
     */
    _extendPayloadWithExtraFields(payload, targetChannels, fieldBrightness) {}
}