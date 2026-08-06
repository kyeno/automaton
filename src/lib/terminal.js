/**
 * Terminal utility functions for ANSI-aware text manipulation and formatting.
 *
 * Provides string helpers that correctly handle invisible ANSI escape sequences
 * when computing visible length, padding, wrapping, and cell rendering. Also
 * exports a frozen map of common ANSI color codes to avoid duplication across
 * UI modules.
 *
 * @module lib/terminal
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import I18nLoader from '../service/i18nLoader.js'

// ---------------------------------------------------------------------------
// ANSI Color Map -- frozen singleton
// ---------------------------------------------------------------------------

/**
 * Common ANSI SGR color codes for terminal output.
 * Frozen to prevent accidental mutation at runtime.
 *
 * @type {Object<string, string>}
 */
const Colors = Object.freeze({
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  grey:    '\x1b[90m',
  white:   '\x1b[97m',
})

export { Colors }

// ---------------------------------------------------------------------------
// ANSI String Utilities
// ---------------------------------------------------------------------------

/**
 * Strip all ANSI escape sequences from a string.
 * Matches the standard CSI (Control Sequence Introducer) format: \x1b[<params>m
 *
 * @param {string} str - Input text possibly containing ANSI codes
 * @returns {string} Text with all ANSI sequences removed
 */
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Return the visible (ANSI-stripped) length of a string.
 *
 * @param {string} str - Input text possibly containing ANSI codes
 * @returns {number} Number of printable characters
 */
export function visibleLen(str) {
  return stripAnsi(str).length
}

/**
 * Pad a string to a target visible width, ignoring ANSI escapes when counting.
 *
 * @param {string} str - Input possibly containing ANSI codes
 * @param {number} width - Target visible character count
 * @param {'left'|'right'} [align='left'] - 'left' pads right, 'right' pads left
 * @returns {string} Padded string preserving original ANSI codes
 */
export function padVisible(str, width, align = 'left') {
  const vlen = visibleLen(str)
  if (vlen >= width) return str
  const spaces = ' '.repeat(width - vlen)
  return align === 'right' ? spaces + str : str + spaces
}

/**
 * Build a colored cell: apply color code, pad to the desired visible width,
 * then reset formatting. The plain-text content must not contain ANSI codes.
 *
 * @param {string} text - Plain text (no ANSI inside)
 * @param {string} color - ANSI color SGR code
 * @param {number} width - Column width in visible characters
 * @param {'left'|'right'} [align='left']
 * @returns {string} Formatted cell string with color and padding
 */
export function colCell(text, color, width, align = 'left') {
  const raw = String(text)
  const vlen = raw.length
  if (vlen >= width) {
    return color + raw + Colors.reset
  }
  const spaces = ' '.repeat(width - vlen)
  return align === 'right'
    ? color + spaces + raw + Colors.reset
    : color + raw + spaces + Colors.reset
}

// ---------------------------------------------------------------------------
// Text Wrapping Utilities
// ---------------------------------------------------------------------------

/**
 * Word-aware wrap that preserves ANSI escape sequences.
 *
 * Splits the input into "words" (sequences separated by spaces), then accumulates
 * words per line until adding the next word would exceed `maxWidth`. If a single
 * word is longer than `maxWidth` it is hard-broken at that boundary.
 *
 * ANSI codes are passed through and carried to every wrapped line prefix so color
 * formatting carries across segments. Newlines in the input text should be handled
 * BY THE CALLER (split before calling this function).
 *
 * @param {string} str - Input text possibly containing ANSI codes (no newlines)
 * @param {number} maxWidth - Maximum visible characters per line
 * @returns {string[]} Array of wrapped lines
 */
export function wrapAnsi(str, maxWidth) {
  if (!str) return ['']

  // --- Tokenize: split into words while preserving ANSI sequences attached to them ---
  const words = []
  let token = ''
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      let j = i + 2
      while (j < str.length && str[j] !== 'm') j++
      token += str.slice(i, j + 1)
      i = j
      continue
    }
    if (str[i] === ' ') {
      const trimmed = token.trimEnd()
      if (trimmed) words.push(trimmed)
      token = ''
    } else {
      token += str[i]
    }
  }
  const last = token.trimEnd()
  if (last) words.push(last)

  if (words.length === 0) return ['']

  // --- Collect any leading ANSI codes (before first visible char) so they prefix every line ---
  let leadingAnsi = ''
  {
    let idx = 0
    while (idx < str.length) {
      if (str[idx] === '\x1b' && str[idx + 1] === '[') {
        let j = idx + 2
        while (j < str.length && str[j] !== 'm') j++
        leadingAnsi += str.slice(idx, j + 1)
        idx = j + 1
      } else if (str[idx] === ' ') {
        idx++
      } else {
        break
      }
    }
  }

  // --- Accumulate words into lines using index-based loop for safe hard-break insertion ---
  const lines = []
  let currentLine = leadingAnsi
  let visibleLength = visibleLen(leadingAnsi)

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi]
    const wLen = visibleLen(word)
    const needed = (currentLine !== leadingAnsi ? 1 : 0) + wLen

    if (visibleLength + needed > maxWidth) {
      // Flush current line
      lines.push(currentLine)
      // Start new line -- carry leading ANSI codes
      currentLine = leadingAnsi
      visibleLength = visibleLen(leadingAnsi)

      // If the single word itself exceeds maxWidth, hard-break it
      if (wLen > maxWidth) {
        let segment = takeVisibleN(word, maxWidth)
        let rest = dropVisibleN(word, maxWidth)

        // Safety: if no progress was made (e.g., segment has zero visible chars, or
        // rest equals the original word), force-consume exactly one visible character
        // to guarantee forward progress and avoid an infinite splice-back loop.
        if (!visibleLen(segment) || rest === word) {
          // Find the first non-ANSI character and include it in the segment
          let consumed = 0
          for (let ci = 0; ci < word.length && consumed < 1; ci++) {
            if (word[ci] === '\x1b' && word[ci + 1] === '[') {
              let ej = ci + 2
              while (ej < word.length && word[ej] !== 'm') ej++
              segment += word.slice(ci, ej + 1)
              ci = ej
              continue
            }
            segment += word[ci]
            consumed++
          }
          rest = word.slice(segment.length)
        }

        lines.push(segment)
        if (rest && visibleLen(rest) > 0) {
          words.splice(wi, 0, rest)
        }
        continue
      }
    }

    // Append word (with space separator if not first on line)
    if (currentLine !== leadingAnsi) {
      currentLine += ' '
      visibleLength++
    }
    currentLine += word
    visibleLength += wLen
  }

  if (currentLine || lines.length === 0) {
    lines.push(currentLine)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Helpers for wrapAnsi -- visible-length aware slicing of strings with ANSI codes
// ---------------------------------------------------------------------------

/**
 * Take the first `n` visible characters from str, preserving ANSI sequences.
 */
function takeVisibleN(str, n) {
  let result = ''
  let count = 0
  for (let i = 0; i < str.length && count < n; i++) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      let j = i + 2
      while (j < str.length && str[j] !== 'm') j++
      result += str.slice(i, j + 1)
      i = j
      continue
    }
    result += str[i]
    count++
  }
  return result
}

/**
 * Drop the first `n` visible characters from str, preserving trailing ANSI sequences.
 */
function dropVisibleN(str, n) {
  let remaining = str
  let count = 0
  let idx = 0
  while (idx < remaining.length && count < n) {
    if (remaining[idx] === '\x1b' && remaining[idx + 1] === '[') {
      let j = idx + 2
      while (j < remaining.length && remaining[j] !== 'm') j++
      idx = j + 1
      continue
    }
    idx++
    count++
  }
  // Preserve any trailing ANSI codes that were after the cut point -- carry them forward
  return remaining.slice(idx)
}

/**
 * Simple word-wrap that respects a max visible width. Does NOT handle ANSI codes --
 * use {@link wrapAnsi} for colored text. Suitable for plain-text chat messages.
 *
 * @param {string} text - Plain text to wrap
 * @param {number} maxWidth - Maximum characters per line
 * @returns {string[]} Array of wrapped lines
 */
export function wrapText(text, maxWidth) {
  const words = text.split(' ')
  const lines = []
  let currentLine = ''

  for (const word of words) {
    if ((currentLine + ' ' + word).length <= maxWidth) {
      currentLine = currentLine ? `${currentLine} ${word}` : word
    } else {
      if (currentLine) lines.push(currentLine)
      currentLine = word.length > maxWidth ? word.slice(0, maxWidth) : word
    }
  }
  if (currentLine) lines.push(currentLine)
  return lines
}

// ---------------------------------------------------------------------------
// Time Formatting Helpers
// ---------------------------------------------------------------------------

/**
 * Return the current local time as an HH:mm:ss string (24-hour format).
 *
 * @returns {string} Current local time
 */
export function nowTime() {
  return formatTime(new Date())
}

/**
 * Format a Date as a plain time string respecting the global time_format setting.
 * Produces zero-padded output like "02:13:34am" or "14:05:09".
 * No ANSI codes -- just raw text suitable for any consumer.
 *
 * @param {Date|string|number} date - Date to format
 * @param {boolean} [includeSeconds=true] - Whether to render seconds
 * @returns {string} Formatted time string
 */
export function formatTime(date, includeSeconds = true) {
  const d = typeof date === 'object' && date instanceof Date ? date : new Date(date)

  // I18nLoader is imported statically but may not be .init()'d yet;
  // is12HourFormat safely returns the default (true = 12h) before initialization.
  const use12Hour = I18nLoader.is12HourFormat?.() ?? true

  let hours = d.getHours()
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')

  if (use12Hour) {
    const suffix = hours < 12 ? 'am' : 'pm'
    hours = hours % 12 || 12
    return includeSeconds
      ? `${String(hours).padStart(2, '0')}:${minutes}:${seconds}${suffix}`
      : `${String(hours).padStart(2, '0')}:${minutes}${suffix}`
  }

  return includeSeconds
    ? `${String(hours).padStart(2, '0')}:${minutes}:${seconds}`
    : `${String(hours).padStart(2, '0')}:${minutes}`
}

/**
 * Format a timestamp prefix for IRC-style display: `[02:13:34am]` in dim gray.
 * Respects the time_format setting from I18nLoader (12h vs 24h).
 *
 * @param {number|string|Date} [date] - Optional date; defaults to now
 * @returns {string} Formatted timestamp with ANSI codes
 */
export function tsPrefix(date) {
  const d = date ? (typeof date === 'object' && date instanceof Date ? date : new Date(date)) : new Date()
  return `${Colors.dim}[${formatTime(d)}]${Colors.reset}`
}
