/**
 * Home Theater Automation -- Bedroom instance.
 * Per-room deployment of the shared home-theater pattern for the bedroom:
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import HomeTheaterAutomation from './homeTheaterBase.js'


const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bedroom-video.yaml')


export default class BedroomVideoAutomation extends HomeTheaterAutomation {
    /** Fixed identity constructor -- name and config path are constants of this automation. */
    constructor() {
        super({ name: 'BedroomVideoAutomation', configPath: CONFIG_PATH })
    }
}
