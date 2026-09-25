/**
 * Random line reader -- memory-safe selection of a single line from a text file.
 *
 * Picks one line out of a line-oriented file (proverbs, quotes, sound cues, ...)
 * without ever loading the whole file into memory. Two sequential streaming passes
 * over a file descriptor, each using one fixed-size scratch buffer:
 *
 *   pass 1  `countLines()`  -- streams the file counting newlines, tracking only a
 *            boolean for "this line holds non-whitespace bytes", so blank-line
 *            filtering never requires buffering the line itself;
 *   pass 2  `readLineAt()`  -- streams again, keeping at most one line's bytes
 *            (capped by `maxLineLength`) in memory, and returns the requested one.
 *
 * `readRandomLine()` composes the two: count, draw a uniform index, read that line.
 * Memory use is therefore O(chunkSize + maxLineLength) regardless of file size --
 * a 1 GB file costs the same working set as a 1 KB one, which is the whole point
 * of not doing `readFileSync().split('\n')` and picking from the array.
 *
 * Comment handling is opt-in per call site (`commentChar`, default null) rather
 * than baked in, so a file whose lines legitimately start with '#' still works.
 * A comment line is recognized only when the marker is the first non-whitespace
 * byte on that line.
 *
 * The module deliberately has no logging dependency: every entry point returns a
 * neutral value (`0` / `null`) for a missing, unreadable, or empty file so callers
 * choose their own degradation (and their own log context). No callbacks, no
 * globals -- the optional `random` hook is a parameter, not module state.
 *
 * @module lib/randomLine
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Scratch buffer size for both streaming passes (64 KiB). */
const DEFAULT_CHUNK_SIZE = 64 * 1024

/**
 * Cap on the bytes retained for a single line (1 MiB). Two purposes: a cap on the
 * peak working set, and a guard so a file with no newline at all cannot make the
 * reader accumulate the entire file into one "line".
 */
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024

/** Line feed -- the only line terminator recognized. */
const NEWLINE = 0x0A

/** Byte-order mark, stripped from the start of the returned line (UTF-8). */
const BOM = '\uFEFF'

/** Sentinel for "no non-whitespace byte seen yet on this line". */
const NO_MEANINGFUL_BYTE = -1

/**
 * Bytes that do not make a line "non-blank": space, tab, CR, VT, FF and LF.
 * Matches the ASCII whitespace set so blank-line filtering behaves the same for
 * a file hand-edited with trailing spaces as for a cleanly generated one.
 */
const WHITESPACE_BYTES = new Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20])

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Read up to `buffer.length` bytes at `position` into `buffer` and return the
 * byte count actually read (0 signals end of file).
 *
 * @param {number} fd - Open file descriptor
 * @param {Buffer} buffer - Scratch buffer to fill
 * @param {number} position - Byte offset to read from
 * @returns {number} Bytes read, or 0 at EOF
 */
function readChunk(fd, buffer, position) {
    return fs.readSync(fd, buffer, 0, buffer.length, position)
}

/**
 * Resolve the `commentChar` option to a single byte code, or null when disabled.
 * Only one-character markers are supported, which keeps comment detection down to
 * one byte comparison per line with no per-line buffering.
 *
 * @param {string|null|undefined} commentChar - Marker character, or null/undefined to disable
 * @returns {number|null} Byte code of the marker, or null when disabled
 */
function resolveCommentCode(commentChar) {
    if (typeof commentChar !== 'string' || commentChar.length !== 1) return null
    return commentChar.charCodeAt(0)
}

/**
 * Decide whether a completed line is a candidate callers can index into. Shared
 * by both streaming passes so counting and reading can never disagree on what
 * "line N" means.
 *
 * Order matters: a line with no bytes at all (EOF straight after a newline) is
 * never a line, a comment line is dropped even when `skipBlank` is off (it does
 * hold content), and only then does the blank-line rule apply.
 *
 * @param {{lineHasBytes: boolean, lineHasContent: boolean, firstMeaningful: number}} state - Per-line scan state
 * @param {boolean} state.lineHasBytes - Whether any bytes preceded the terminator
 * @param {boolean} state.lineHasContent - Whether a non-whitespace byte was seen
 * @param {number} state.firstMeaningful - First non-whitespace byte, or -1
 * @param {{skipBlank?: boolean, commentCode?: number|null}} options - Filter options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {number|null} [options.commentCode=null] - Byte code of the comment marker
 * @returns {boolean} True when the line counts toward the index space
 */
function isQualifyingLine(state, { skipBlank, commentCode }) {
    if (!state.lineHasBytes) return false
    if (commentCode !== null && commentCode !== undefined && state.firstMeaningful === commentCode) return false
    if (skipBlank && !state.lineHasContent) return false
    return true
}

/**
 * Finalize a collected line: truncate at `maxLineLength`, decode, drop a leading
 * BOM, strip surrounding whitespace and any trailing CR left over from CRLF endings.
 *
 * @param {Buffer[]} slices - Collected line fragments (each already copied)
 * @param {number} collectedLen - Total bytes across `slices`
 * @param {number} maxLineLength - Cap applied before decoding
 * @param {string} encoding - Text encoding used to decode the bytes
 * @returns {string} Cleaned line text
 */
function finalizeLine(slices, collectedLen, maxLineLength, encoding) {
    const keep = Math.min(collectedLen, maxLineLength)
    let line = Buffer.concat(slices, collectedLen).subarray(0, keep).toString(encoding)
    if (line.startsWith(BOM)) line = line.slice(BOM.length)
    return line.trim()
}

/**
 * Shared pass-2 driver: stream `fd` and return the `index`-th qualifying line, or
 * null when the file has fewer qualifying lines than that.
 *
 * The scratch buffer is REUSED across chunks, so every retained slice is copied
 * (`Buffer.from`) rather than subarrayed -- otherwise a later chunk would overwrite
 * the bytes of the line currently being collected.
 *
 * @param {number} fd - Open file descriptor
 * @param {number} index - Zero-based index among qualifying lines
 * @param {{skipBlank: boolean, commentCode: number|null, chunkSize: number, maxLineLength: number, encoding: string}} options - Read options
 * @returns {string|null} The requested line, or null when out of range
 */
function streamLineAt(fd, index, { skipBlank, commentCode, chunkSize, maxLineLength, encoding }) {
    const buffer = Buffer.allocUnsafe(chunkSize)
    let seen = 0
    let lineHasBytes = false
    let lineHasContent = false
    let firstMeaningful = NO_MEANINGFUL_BYTE
    let slices = []
    let collectedLen = 0
    let position = 0

    for (;;) {
        const bytesRead = readChunk(fd, buffer, position)
        if (bytesRead === 0) break
        position += bytesRead

        let searchFrom = 0
        for (;;) {
            // Clamp the search to the valid region: the scratch buffer is allocUnsafe,
            // so bytes past `bytesRead` are stale and an unclamped indexOf could report
            // a phantom newline, inventing lines that do not exist.
            const nlIndex = buffer.indexOf(NEWLINE, searchFrom)
            const hasTerminator = nlIndex !== -1 && nlIndex < bytesRead
            const end = hasTerminator ? nlIndex : bytesRead

            // Retain this line's bytes (copy: the scratch buffer is reused).
            if (end > searchFrom && collectedLen < maxLineLength) {
                const slice = Buffer.from(buffer.subarray(searchFrom, end))
                slices.push(slice)
                collectedLen += slice.length
            }
            for (let i = searchFrom; i < end; i++) {
                lineHasBytes = true
                if (!WHITESPACE_BYTES.has(buffer[i])) {
                    lineHasContent = true
                    if (firstMeaningful === NO_MEANINGFUL_BYTE) firstMeaningful = buffer[i]
                }
            }

            if (!hasTerminator) break        // no terminator inside this chunk

            // A line ends here -- does it qualify, and is it the one we want?
            if (isQualifyingLine({ lineHasBytes, lineHasContent, firstMeaningful }, { skipBlank, commentCode })) {
                if (seen === index) return finalizeLine(slices, collectedLen, maxLineLength, encoding)
                seen++
            }
            slices = []
            collectedLen = 0
            lineHasBytes = false
            lineHasContent = false
            firstMeaningful = NO_MEANINGFUL_BYTE
            searchFrom = nlIndex + 1
        }
    }

    // Trailing line with no terminating newline.
    const state = { lineHasBytes, lineHasContent, firstMeaningful }
    if (isQualifyingLine(state, { skipBlank, commentCode }) && seen === index) {
        return finalizeLine(slices, collectedLen, maxLineLength, encoding)
    }
    return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count the qualifying lines of a text file, streaming it with a fixed-size
 * scratch buffer so memory use does not scale with file size.
 *
 * A file whose last line has no terminating newline still counts that line. When
 * `skipBlank` is true (the default), whitespace-only lines are not counted --
 * which also means a trailing newline at end of file never inflates the count.
 * The count returned here is exactly the number of indices {@link readLineAt}
 * accepts, so `readLineAt(f, countLines(f) - 1)` always resolves.
 *
 * @param {string} filePath - Path to the file to inspect
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number}} [options] - Count options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @returns {number} Number of qualifying lines; 0 for a missing or empty file
 */
export function countLines(filePath, options = {}) {
    const {
        skipBlank = true,
        commentChar = null,
        chunkSize = DEFAULT_CHUNK_SIZE,
    } = options
    const commentCode = resolveCommentCode(commentChar)

    let fd
    try {
        fd = fs.openSync(filePath, 'r')
    } catch {
        return 0
    }

    try {
        const buffer = Buffer.allocUnsafe(chunkSize)
        let count = 0
        let lineHasBytes = false
        let lineHasContent = false
        let firstMeaningful = NO_MEANINGFUL_BYTE
        let position = 0

        for (;;) {
            const bytesRead = readChunk(fd, buffer, position)
            if (bytesRead === 0) break
            position += bytesRead

            let searchFrom = 0
            for (;;) {
                // Clamp the search to the valid region (see streamLineAt): stale bytes
                // past `bytesRead` must never be read as a line terminator.
                const nlIndex = buffer.indexOf(NEWLINE, searchFrom)
                const hasTerminator = nlIndex !== -1 && nlIndex < bytesRead
                const end = hasTerminator ? nlIndex : bytesRead
                for (let i = searchFrom; i < end; i++) {
                    lineHasBytes = true
                    if (!WHITESPACE_BYTES.has(buffer[i])) {
                        lineHasContent = true
                        if (firstMeaningful === NO_MEANINGFUL_BYTE) firstMeaningful = buffer[i]
                    }
                }
                if (!hasTerminator) break

                const state = { lineHasBytes, lineHasContent, firstMeaningful }
                if (isQualifyingLine(state, { skipBlank, commentCode })) count++
                lineHasBytes = false
                lineHasContent = false
                firstMeaningful = NO_MEANINGFUL_BYTE
                searchFrom = nlIndex + 1
            }
        }

        // Final line without a terminating newline.
        const tail = { lineHasBytes, lineHasContent, firstMeaningful }
        if (isQualifyingLine(tail, { skipBlank, commentCode })) count++
        return count
    } catch {
        // Unreadable for a reason other than "absent" (a directory, a permission
        // error, an I/O fault). Degrade to the neutral value like a missing file.
        return 0
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * Read one specific line of a text file by zero-based index, without loading the
 * file. The index counts the same qualifying lines {@link countLines} reports
 * (blank lines and optional comment lines skipped), so the two agree on what
 * "line 3" means.
 *
 * The line is assembled incrementally from copies of the scratch buffer, so at
 * most `maxLineLength` bytes of any one line are ever held in memory. Returned
 * text is trimmed, with a leading BOM and any trailing CR removed.
 *
 * @param {string} filePath - Path to the file to read
 * @param {number} index - Zero-based index among qualifying lines
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number, maxLineLength?: number, encoding?: string}} [options] - Read options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @param {number} [options.maxLineLength=1048576] - Cap on retained bytes per line
 * @param {string} [options.encoding='utf8'] - Text encoding to decode with
 * @returns {string|null} The line text, or null when the index is out of range
 *   or the file is missing/unreadable
 */
export function readLineAt(filePath, index, options = {}) {
    const {
        skipBlank = true,
        commentChar = null,
        chunkSize = DEFAULT_CHUNK_SIZE,
        maxLineLength = DEFAULT_MAX_LINE_LENGTH,
        encoding = 'utf8',
    } = options

    if (!Number.isInteger(index) || index < 0) return null

    let fd
    try {
        fd = fs.openSync(filePath, 'r')
    } catch {
        return null
    }

    try {
        const commentCode = resolveCommentCode(commentChar)
        return streamLineAt(fd, index, { skipBlank, commentCode, chunkSize, maxLineLength, encoding })
    } catch {
        // Same fail-soft contract as countLines(): anything unreadable is null.
        return null
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * Return one uniformly random line of a text file.
 *
 * Composes the two streaming passes: count the qualifying lines, draw an index
 * in `[0, count)`, then read exactly that line. Nothing proportional to the file
 * size is ever held in memory -- only the scratch buffer plus the single returned
 * line.
 *
 * The `random` hook is a function returning a float in `[0, 1)`, which lets tests
 * pin a deterministic line without touching global RNG state.
 *
 * @param {string} filePath - Path to the file to read
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number, maxLineLength?: number, encoding?: string, random?: () => number}} [options] - Read options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @param {number} [options.maxLineLength=1048576] - Cap on retained bytes per line
 * @param {string} [options.encoding='utf8'] - Text encoding to decode with
 * @param {() => number} [options.random=Math.random] - Source of randomness
 * @returns {string|null} A random line, or null when the file is missing,
 *   unreadable, or has no qualifying lines
 */
export function readRandomLine(filePath, options = {}) {
    const { random = Math.random, ...readOptions } = options

    const total = countLines(filePath, readOptions)
    if (total === 0) return null

    // Math.min guards against a caller-supplied random() returning exactly 1,
    // which would otherwise index past the end of the file.
    const index = Math.min(Math.floor(random() * total), total - 1)
    return readLineAt(filePath, index, readOptions)
}
