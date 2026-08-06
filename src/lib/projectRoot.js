/**
 * Project Root Resolution.
 *
 * Provides a single, cached reference to the project root directory.
 * All code that needs to resolve paths relative to the project root
 * should import this module instead of computing it inline.
 *
 * This file lives at src/lib/ so going up two levels reaches project root.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the project root directory.
 * Computed once at module load time and cached.
 * @type {string}
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export { PROJECT_ROOT }
export default PROJECT_ROOT
