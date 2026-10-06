/**
 * Channel alias resolution for multi-channel devices (dual switches/dimmers).
 * The AI-facing vocabulary is positional and uniform across all multi-channel.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Canonical positional names by index into the declared channel list. */
export const POSITIONAL_NAMES = Object.freeze(['ONE', 'TWO', 'THREE', 'FOUR'])

/** Positional alias words/digits -> index into the declared channel list. */
const POSITIONAL_ALIASES = Object.freeze({
    one: 0, '1': 0,
    two: 1, '2': 1,
    three: 2, '3': 2,
    four: 3, '4': 3
})

/** Resolve a channel reference against a declared channel list.
 * @param {Array<string>} channels - Declared channel names in positional order (e.g. ['left','right'] or ['l1','l2'])
 * @param {string|null|undefined} ref - Channel reference from the caller
 * @returns {string|null} Wire channel name, or null when the reference cannot be resolved */
export function resolveChannelAlias(channels, ref) {
    if (ref === null || ref === undefined) return null
    const normalized = String(ref).trim().toLowerCase()
    if (normalized === '') return null

    const positional = POSITIONAL_ALIASES[normalized]
    if (positional !== undefined) return channels[positional] ?? null

    return channels.includes(normalized) ? normalized : null
}

/** Canonicalize a raw channel reference into the AI-facing positional.
 * @param {*} value - Raw channel value from tool arguments or parsed text
 * @returns {string|null} Canonical positional name (e.g. 'ONE'), lowercased wire name, or null */
export function normalizeChannelRef(value) {
    if (value === null || value === undefined) return null
    const normalized = String(value).trim().toLowerCase()
    if (normalized === '') return null

    const positional = POSITIONAL_ALIASES[normalized]
    if (positional !== undefined) return POSITIONAL_NAMES[positional]

    return normalized
}

/** Map a wire channel name to its positional name (ONE/TWO/...) by index.
 * @param {Array<string>} channels - Declared channel names in positional order
 * @param {string} wireName - Wire channel name (case-insensitive)
 * @returns {string|null} Positional name (e.g. 'ONE'), or null when the channel is not in the list */
export function positionalNameFor(channels, wireName) {
    const normalized = String(wireName).trim().toLowerCase()
    const idx = channels.findIndex((c) => c === normalized)
    return idx >= 0 ? POSITIONAL_NAMES[idx] ?? null : null
}