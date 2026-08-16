/**
 * String utility functions.
 *
 * @module lib/string
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/**
 * Transforms a string by trimming, lowercasing, and replacing
 * all whitespace characters with underscores.
 *
 * @param {string} str - The string to transform.
 * @returns {string} The transformed string.
 */
export function slugify(str) {
    return str.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Strips markdown formatting (bold, italic, code blocks, headers, links,
 * images, blockquotes, list markers, horizontal rules) and emoji characters
 * from a string.
 *
 * Useful for cleaning AI responses before passing them to TTS or terminal UI
 * that does not render markdown or emoji well.
 *
 * @param {string} str - The input string.
 * @returns {string} The cleaned string without markdown and emoji.
 */
export function stripMarkdown(str) {
    if (!str || typeof str !== 'string') return str

    let cleaned = str

    // Strip fenced code blocks (``` ... ```)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '')

    // Strip inline code (`...`) - preserve inner text
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

    // Strip emoji (comprehensive Unicode emoji ranges)
    // Includes: emoticons, symbols & pictographs, transport & map,
    // alchemical symbols, geometric shapes, arrows, supplemental symbols,
    // chess/dominoes, symbolic icons, misc symbols, dingbats,
    // variation selectors, mahjong tiles, playing cards, zero-width joiner
    cleaned = cleaned.replace(
        /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|\u{200D}/gu,
        ''
    )

    return cleaned
}