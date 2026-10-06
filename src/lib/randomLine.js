/**
 * Random line reader -- memory-safe selection of a single line from a text file.
 * Picks one line out of a line-oriented file (proverbs, quotes, sound cues, ...)
 * @module lib/randomLine
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'


/** Scratch buffer size for both streaming passes (64 KiB). */
const DEFAULT_CHUNK_SIZE = 64 * 1024

/** Cap on the bytes retained for a single line (1 MiB). Two purposes: a cap. */
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024

/** Line feed -- the only line terminator recognized. */
const NEWLINE = 0x0A

/** Byte-order mark, stripped from the start of the returned line (UTF-8). */
const BOM = '\uFEFF'

/** Sentinel for "no non-whitespace byte seen yet on this line". */
const NO_MEANINGFUL_BYTE = -1

/** Bytes that do not make a line "non-blank": space, tab, CR, VT, FF and LF. */
const WHITESPACE_BYTES = new Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20])

//  Private helpers.

/** Read up to `buffer.length` bytes at `position` into `buffer`
 * @param {number} fd - Open file descriptor
 * @param {Buffer} buffer - Scratch buffer to fill
 * @param {number} position - Byte offset to read from
 * @returns {number} Bytes read, or 0 at EOF */
function readChunk(fd, buffer, position) {
    return fs.readSync(fd, buffer, 0, buffer.length, position)
}

/** Resolve the `commentChar` option to a single byte code, or null when disabled.
 * @param {string|null|undefined} commentChar - Marker character, or null/undefined to disable
 * @returns {number|null} Byte code of the marker, or null when disabled */
function resolveCommentCode(commentChar) {
    if (typeof commentChar !== 'string' || commentChar.length !== 1) return null
    return commentChar.charCodeAt(0)
}

/** Decide whether a completed line is a candidate callers can index into.
 * @param {{lineHasBytes: boolean, lineHasContent: boolean, firstMeaningful: number}} state - Per-line scan state
 * @param {boolean} state.lineHasBytes - Whether any bytes preceded the terminator
 * @param {boolean} state.lineHasContent - Whether a non-whitespace byte was seen
 * @param {number} state.firstMeaningful - First non-whitespace byte, or -1
 * @param {{skipBlank?: boolean, commentCode?: number|null}} options - Filter options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {number|null} [options.commentCode=null] - Byte code of the comment marker
 * @returns {boolean} True when the line counts toward the index space */
function isQualifyingLine(state, { skipBlank, commentCode }) {
    if (!state.lineHasBytes) return false
    if (commentCode !== null && commentCode !== undefined && state.firstMeaningful === commentCode) return false
    if (skipBlank && !state.lineHasContent) return false
    return true
}

/** Finalize a collected line: truncate at `maxLineLength`, decode, drop a leading.
 * @param {Buffer[]} slices - Collected line fragments (each already copied)
 * @param {number} collectedLen - Total bytes across `slices`
 * @param {number} maxLineLength - Cap applied before decoding
 * @param {string} encoding - Text encoding used to decode the bytes
 * @returns {string} Cleaned line text */
function finalizeLine(slices, collectedLen, maxLineLength, encoding) {
    const keep = Math.min(collectedLen, maxLineLength)
    let line = Buffer.concat(slices, collectedLen).subarray(0, keep).toString(encoding)
    if (line.startsWith(BOM)) line = line.slice(BOM.length)
    return line.trim()
}

/** Shared pass-2 driver: stream `fd` and return the `index`-th qualifying line.
 * @param {number} fd - Open file descriptor
 * @param {number} index - Zero-based index among qualifying lines
 * @param {{skipBlank: boolean, commentCode: number|null, chunkSize: number, maxLineLength: number, encoding: string}} options - Read options
 * @returns {string|null} The requested line, or null when out of range */
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
            //  Clamp the search to the valid region: the scratch buffer is allocUnsafe.
            const nlIndex = buffer.indexOf(NEWLINE, searchFrom)
            const hasTerminator = nlIndex !== -1 && nlIndex < bytesRead
            const end = hasTerminator ? nlIndex : bytesRead

            //  Retain this line's bytes (copy: the scratch buffer is reused).
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

            //  A line ends here -- does it qualify, and is it the one we want?
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

    //  Trailing line with no terminating newline.
    const state = { lineHasBytes, lineHasContent, firstMeaningful }
    if (isQualifyingLine(state, { skipBlank, commentCode }) && seen === index) {
        return finalizeLine(slices, collectedLen, maxLineLength, encoding)
    }
    return null
}


/** Count the qualifying lines of a text file, streaming it with a fixed-size.
 * @param {string} filePath - Path to the file to inspect
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number}} [options] - Count options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @returns {number} Number of qualifying lines; 0 for a missing or empty file */
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
                //  Clamp the search to the valid region (see streamLineAt): stale bytes.
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

        //  Final line without a terminating newline.
        const tail = { lineHasBytes, lineHasContent, firstMeaningful }
        if (isQualifyingLine(tail, { skipBlank, commentCode })) count++
        return count
    } catch {
        // Unreadable for a reason other than "absent"
        return 0
    } finally {
        fs.closeSync(fd)
    }
}

/** Read one specific line of a text file by zero-based index.
 * @param {string} filePath - Path to the file to read
 * @param {number} index - Zero-based index among qualifying lines
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number, maxLineLength?: number, encoding?: string}} [options] - Read options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @param {number} [options.maxLineLength=1048576] - Cap on retained bytes per line
 * @param {string} [options.encoding='utf8'] - Text encoding to decode with
 * @returns {string|null} The line text, or null when the index is out of range */
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
        //  Same fail-soft contract as countLines(): anything unreadable is null.
        return null
    } finally {
        fs.closeSync(fd)
    }
}

/** Return one uniformly random line of a text file.
 * @param {string} filePath - Path to the file to read
 * @param {{skipBlank?: boolean, commentChar?: string|null, chunkSize?: number, maxLineLength?: number, encoding?: string, random?: () => number}} [options] - Read options
 * @param {boolean} [options.skipBlank=true] - Ignore whitespace-only lines
 * @param {string|null} [options.commentChar=null] - Single-char marker; lines starting with it are ignored
 * @param {number} [options.chunkSize=65536] - Scratch buffer size in bytes
 * @param {number} [options.maxLineLength=1048576] - Cap on retained bytes per line
 * @param {string} [options.encoding='utf8'] - Text encoding to decode with
 * @param {() => number} [options.random=Math.random] - Source of randomness
 * @returns {string|null} A random line, or null when the file is missing, */
export function readRandomLine(filePath, options = {}) {
    const { random = Math.random, ...readOptions } = options

    const total = countLines(filePath, readOptions)
    if (total === 0) return null

    //  Math.min guards against a caller-supplied random() returning exactly 1.
    const index = Math.min(Math.floor(random() * total), total - 1)
    return readLineAt(filePath, index, readOptions)
}
