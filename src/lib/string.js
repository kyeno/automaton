/**
 * String utility functions.
 * @module lib/string
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Transforms a string by trimming, lowercasing, and replacing.
 * @param {string} str - The string to transform.
 * @returns {string} The transformed string. */
export function slugify(str) {
    return str.trim().toLowerCase().replace(/\s+/g, '_')
}

/** Derives the rule-target key used under automation `rules[].targets`
 * @param {string} str - The device name to transform.
 * @returns {string} The transformed target key. */
export function toTargetKey(str) {
    return str.trim().replace(/\s+/g, '_')
}

/** Emoji and pictograph code-point ranges: emoticons, symbols and pictographs,
 * @type {RegExp} */
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|\u{200D}/gu


/** Strips markdown formatting.
 * @param {string} str - The input string.
 * @returns {string} The cleaned string without markdown and emoji. */
export function stripMarkdown(str) {
    if (!str || typeof str !== 'string') return str

    let cleaned = str

    //  Strip fenced code blocks (``` ... ```)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '')

    //  Strip inline code (`...`) - preserve inner text.
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1')

    // Strip bold (**text** or __text__)
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1')
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1')

    // Strip italic (*text* or _text_)
    // Underscore variant requires non-word characters on both sides so that
    // snake_case identifiers (state_last_updated) are never mangled.
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1')
    cleaned = cleaned.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '$1')

    // Strip strikethrough (~~text~~)
    cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1')

    // Strip headers (# ## ### etc.)
    cleaned = cleaned.replace(/^#+\s*/gm, '')

    // Strip images ![alt](url) -> alt text only (must run before links so the
    // link rule cannot consume the bracket part and leave a stray "!")
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')

    // Strip links [text](url) -> text (lookbehind excludes leftover image syntax)
    cleaned = cleaned.replace(/(?<!!)\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Strip blockquote markers (> text)
    cleaned = cleaned.replace(/^>\s*/gm, '')

    // Strip unordered list markers (- item, * item, + item)
    cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '')

    // Strip ordered list markers (1. item)
    cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '')

    // Strip horizontal rules (---, ***, ___)
    cleaned = cleaned.replace(/^[-*_]{3,}\s*$/gm, '')

    // Strip emoji (comprehensive Unicode emoji ranges, see EMOJI_REGEX)
    cleaned = cleaned.replace(EMOJI_REGEX, '')

    return cleaned
}

// ---------------------------------------------------------------------------
// External text safety (incoming MQTT payloads, terminal input) and tokens
// ---------------------------------------------------------------------------

/**
 * Default ceiling for sanitizeText() output. Long enough for a paragraph of
 * chat, short enough that a hostile payload (a 1 MB blob published on the AI
 * bridge topic) never reaches the LLM, the log or the UI transcript intact.
 *
 * @type {number}
 */
const SANITIZE_MAX_LENGTH = 1000

/**
 * Terminal control sequences: CSI (ESC [ ... final byte), OSC (ESC ] ... ST)
 * and the charset selectors. Removed as whole sequences before the character
 * allowlist runs, so the printable guts of an escape never survive as garbage a
 * terminal would happily interpret. A lone ESC matches none of these forms and is
 * dropped by the allowlist pass itself, which is why this pattern deliberately has
 * no catch-all branch: it must never swallow the plain character after an ESC.
 *
 * @type {RegExp}
 */
const CONTROL_SEQUENCE_REGEX = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[()#][0-9A-Za-z]?)/gs

/**
 * Every code point OUTSIDE the responsible-text allowlist.
 *
 * The allowlist keeps what plain prose in the supported languages needs:
 * printable ASCII plus tab/CR/LF, Latin-1 Supplement (minus its control gap),
 * Latin Extended A and B with IPA extensions (Polish, Czech, Germanic and
 * Hispanic letters), combining diacritical marks, Greek and Greek Extended,
 * Cyrillic and its Supplement, and the general punctuation a chat transcript
 * needs (curly quotes, dashes, ellipsis, middle dot). Everything else is
 * dropped: emoji and pictographs, CJK, Arabic, Hebrew, Devanagari, box drawing
 * and block elements, zero-width and variation-selector code points, bidi
 * overrides, private-use areas and all control characters.
 *
 * @type {RegExp}
 */
const UNSAFE_TEXT_REGEX = /[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u02AF\u0300-\u036F\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u1F00-\u1FFF\u00B7\u2015\u2018\u2019\u201A\u201C\u201D\u2013\u2014\u2026]/gu

/**
 * The project-wide `{% keyword %}` token syntax, already used by the speech
 * automations. Exported so every interpolating caller shares one syntax
 * instead of re-declaring the pattern.
 *
 * @type {RegExp}
 */
export const TOKEN_INTERPOLATION_REGEX = /\{%\s*(\w+)\s*%\}/g

/**
 * Sanitize text arriving from OUTSIDE the process (an MQTT payload on the AI
 * bridge topic, text typed into a UI window) before it is handed to the LLM,
 * written to the log, rendered in the terminal UI or re-published over MQTT.
 *
 * The transform is deliberately lossy: terminal control sequences are removed
 * whole, every code point outside the language allowlist above is dropped
 * (emoji, pictographs, CJK, box drawing, zero-width and bidi trickery,
 * private-use and control characters), whitespace runs -- newlines and
 * non-breaking spaces included -- collapse to single spaces so a hostile
 * payload cannot forge extra transcript lines, and the result is capped in
 * length. Plain prose in the supported languages passes through untouched.
 *
 * Non-string input is returned unchanged so callers can sanitize optional
 * values without writing a type guard of their own.
 *
 * @param {string} str - Raw incoming text.
 * @param {Object} [options] - Options object.
 * @param {number} [options.maxLength=1000] - Hard ceiling on the returned
 *   length; a non-finite value disables the cap.
 * @returns {string} The safe text (empty when nothing survived).
 */
export function sanitizeText(str, { maxLength = SANITIZE_MAX_LENGTH } = {}) {
    if (typeof str !== 'string' || str === '') return str

    // 1. Whole terminal control sequences first -- their guts are printable.
    let text = str.replace(CONTROL_SEQUENCE_REGEX, '')

    // 2. Everything outside the language allowlist goes.
    text = text.replace(UNSAFE_TEXT_REGEX, '')

    // 3. One space per whitespace run: no forged lines, no padding games.
    text = text.replace(/\s+/g, ' ').trim()

    // 4. Length cap.
    if (Number.isFinite(maxLength) && maxLength >= 0 && text.length > maxLength) {
        text = text.slice(0, maxLength)
    }

    return text
}

/**
 * Replace `{% keyword %}` tokens in a template with values from a lookup map.
 *
 * Shared by every caller of the project's token syntax (the AI system prompt's
 * `{% name %}`, the weatherman's `{% time %}` and friends) so the syntax lives
 * in one place. A keyword with no entry passes through unchanged -- an
 * unmapped token is a configuration gap worth noticing, not a silent blank.
 * Non-string templates and empty strings are returned as-is.
 *
 * @param {string} text - Template containing `{% keyword %}` tokens.
 * @param {Object} [values={}] - Keyword to replacement value map.
 * @returns {string} Template with every known token resolved.
 */
export function interpolateTokens(text, values = {}) {
    if (typeof text !== 'string' || text === '') return text

    return text.replace(TOKEN_INTERPOLATION_REGEX, (match, keyword) => {
        const value = values[keyword]
        return (value === undefined || value === null) ? match : String(value)
    })
}
