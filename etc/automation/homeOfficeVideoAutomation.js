/**
 * Home Theater Automation -- Home Office (HTPC / Salon) instance.
 * Per-room deployment of the shared home-theater pattern for the HTPC.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import HomeTheaterAutomation from './homeTheaterBase.js'


const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'home-office-video.yaml')


export default class HomeOfficeVideoAutomation extends HomeTheaterAutomation {
    /** Fixed identity constructor -- name and config path are constants of this automation. */
    constructor() {
        super({ name: 'HomeOfficeVideoAutomation', configPath: CONFIG_PATH })
    }
}
