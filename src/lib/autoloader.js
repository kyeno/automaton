/**
 * Core library autoloader.
 *  Scans a single directory level for `.js` files and dynamically imports them,
 *  returning a key-value map where keys are the file names (without extension).
 *  Subdirectories are not scanned.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Autoloader class
// ---------------------------------------------------------------------------

/**
 * Autoloader class.
 *
 * Dynamically loads all JavaScript modules from a given directory.
 */
class Autoloader {

    // -- Public API -------------------------------------------------------

    /**
     * Preload all `.js` modules directly inside a directory (no recursion).
     *
     * Returns a plain object mapping each module's base name (without `.js`)
     * to its default export or the namespace object when no default exists.
     *
     * @param {string} dirPath - Absolute or relative path to the target directory
     * @returns {Promise<Object<string, any>>} Key-value store of loaded modules
     */
    async preloadPath(dirPath) {
        const preloaded = {}

        for (const file of await fsp.readdir(dirPath)) {
            if (!file.endsWith('.js')) continue

            const confName = file.replace(/\.js$/i, '')
            const filePath = path.join(dirPath, file)
            const fileUrl = pathToFileURL(filePath).href

            const mod = await import(fileUrl)
            preloaded[confName] = mod.default ?? mod
        }

        return preloaded
    }
}

export default Autoloader