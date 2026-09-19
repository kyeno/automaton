/**
 * DualDimmer -- multi-channel wall dimmers (a DualSwitch whose channels also
 * accept brightness levels, e.g. Salon l1/l2 with zigbee2mqtt fields
 * state_l1/brightness_l1, state_l2/brightness_l2).
 *
 * Brightness semantics: callers always speak percentages (0-100), matching the
 * AI tool surface and human intuition. The percentage is mapped into the actual
 * accepted range of each channel at publish time, using the first sane source:
 *   1. explicit per-channel override from etc/device/zigbee.yaml:
 *        - name: "Salon Ambient"
 *          type: dualDimmer
 *          channels: [l1, l2]
 *          brightness_range: { l1: [54, 254], l2: [1, 254] }
 *   2. min_brightness_<ch>/max_brightness_<ch> reported by the device itself,
 *      when that pair is a valid non-degenerate Zigbee level range
 *   3. the full Zigbee level range [1, 254] as last resort
 * Degenerate reported ranges (min == max, or values outside 0..254) are treated
 * as unreliable metadata rather than hard limits -- some converters report odd
 * bounds while still accepting the wider range, so pinning to them would make
 * dimming impossible.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import DualSwitch from './dualswitch.js'

/** Full Zigbee level range used when no better bound information exists. */
const ZIGBEE_LEVEL_MIN = 1
const ZIGBEE_LEVEL_MAX = 254

export default class DualDimmer extends DualSwitch {
    /**
     * Return the log prefix label for dual dimmers.
     * @returns {string}
     */
    getLogPrefix() {
        return 'DualDimmer'
    }

    /**
     * Dimmers accept per-channel brightness in addition to state.
     * @returns {boolean} true
     */
    supportsBrightness() {
        return true
    }

    // -- Brightness mapping ---------------------------------------------------

    /**
     * Append brightness_<channel> fields for a percentage request, mapped into
     * each channel's accepted level range (see class docs for precedence rules).
     * Channels without any usable bounds fall back to the full [1, 254] range.
     *
     * @param {Object} payload - Payload being built by DualSwitch (mutated in place)
     * @param {Array<string>} targetChannels - Channels the command applies to
     * @param {number|undefined} fieldBrightness - Requested percentage 0-100, if any
     */
    _extendPayloadWithExtraFields(payload, targetChannels, fieldBrightness) {
        if (fieldBrightness === undefined) return

        const last = this.getStateLast() ?? {}
        for (const ch of targetChannels) {
            const [minLevel, maxLevel] = this.#resolveChannelRange(ch, last)
            const raw = minLevel + (fieldBrightness / 100) * (maxLevel - minLevel)
            const level = Math.min(maxLevel, Math.max(minLevel, Math.round(raw)))
            payload[`brightness_${ch}`] = level
        }
    }

    /**
     * Resolve the accepted [min,max] Zigbee level range for one channel using the
     * documented precedence: config override > sane reported bounds > [1, 254].
     *
     * @param {string} channel - Channel name (lowercase)
     * @param {Object} lastState - Last reported state payload (may be empty)
     * @returns {[number, number]} Valid inclusive level bounds with min < max
     * @private
     */
    #resolveChannelRange(channel, lastState) {
        // 1. Explicit per-channel config override wins outright.
        const cfg = this.getData()?.brightness_range?.[channel]
        if (this.#isSaneRange(cfg)) return [Number(cfg[0]), Number(cfg[1])]

        // 2. Device-reported bounds -- only when they form a usable non-degenerate
        //    range inside the Zigbee level space; odd metadata falls through.
        const repMin = Number(lastState[`min_brightness_${channel}`])
        const repMax = Number(lastState[`max_brightness_${channel}`])
        if ([repMin, repMax].every(Number.isFinite) && this.#isSaneRange([repMin, repMax])) {
            return [repMin, repMax]
        }

        // 3. Full Zigbee level range as last resort.
        return [ZIGBEE_LEVEL_MIN, ZIGBEE_LEVEL_MAX]
    }

    /**
     * Validate that an array is a usable inclusive level range: two finite numbers,
     * within 0..254, strictly increasing.
     * @param {*} value - Candidate range from config or reported state
     * @returns {boolean} true when the value can be used as [min,max] bounds
     * @private
     */
    #isSaneRange(value) {
        if (!Array.isArray(value) || value.length !== 2) return false
        const [a, b] = [Number(value[0]), Number(value[1])]
        return Number.isFinite(a) && Number.isFinite(b)
            && a >= 0 && b <= ZIGBEE_LEVEL_MAX && a < b
    }
}