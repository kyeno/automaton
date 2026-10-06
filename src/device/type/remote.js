/**
 * Remote device type.
 *  Extends DeviceBase with action-to-command mapping for multi-button remotes.
 *  Uses DeviceContainer to find target Mechanism devices and call receiveCommand()
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import temporal from '../../lib/date.js'
import { slugify } from '../../lib/string.js'

import LoggerService from '../../service/loggerService.js'

import DeviceContainer from '../container/deviceContainer.js'
import InteractionContainer from '../../interaction/container/interactionContainer.js'

import DeviceBase from '../base/deviceBase.js'
import DeviceCommandSource from '../../enum/deviceCommandSource.js'


/** Default debounce window in milliseconds.
 * @type {number} */
const DEFAULT_DEBOUNCE_WINDOW_MS = 800

/** Debounce scope: any action inside the window is ignored.
 * @type {string} */
const DEBOUNCE_ANY_ACTION = 'any_action'

/** Debounce scope: only a repeat of the *same* action inside the window is
 * @type {string} */
const DEBOUNCE_SAME_ACTION = 'same_action'


/** Remote class that extends DeviceBase. */
export default class Remote extends DeviceBase {

    //  -- Private state ----------------------------------------------------

    /** Action mapping: action identifier -> { target, state, extra?, targets? }
     * @type {Object<string, Object>} */
    #actionMap = {}

    /** Last processed action identifier (for debugging/logging).
     * @type {string|null} */
    #lastAction = null

    /** Timestamp of last processed action in milliseconds since epoch.
     * @type {number} */
    #lastActionTime = 0

    /** Debounce window in milliseconds.
     * @type {number} */
    #debounceWindow = DEFAULT_DEBOUNCE_WINDOW_MS

    /** Which actions the debounce window applies to: DEBOUNCE_ANY_ACTION
     * @type {string} */
    #debounceScope = DEBOUNCE_ANY_ACTION

    //  -- Constructor ------------------------------------------------------

    /** Create Remote object.
     * @constructor
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @param {Object} data - Device data
     * @param {Object<string, Object>} [actionMap={}] - Button action mapping */
    constructor(name, id, data, actionMap = {}) {
        super(name, id, data)
        this.#actionMap = actionMap

        //  Opt-in, per-device debounce scoping. Declared in etc/device/zigbee.yaml.
        if (data?.debounce_scope === DEBOUNCE_SAME_ACTION) {
            this.#debounceScope = DEBOUNCE_SAME_ACTION
        }
    }

    //  -- Accessors --------------------------------------------------------

    /** Get the current action mapping.
     * @returns {Object<string, Object>} */
    get actionMap() {
        return this.#actionMap
    }

    /** Set a new action mapping (replaces the existing one).
     * @param {Object<string, Object>} map - Button action mapping */
    set actionMap(map) {
        this.#actionMap = map
    }

    //  -- Overrides --------------------------------------------------------

    /** Return the log prefix label for remotes.
     * @returns {string} */
    getLogPrefix() {
        return 'Remote'
    }

    /** Override handleMqttMessage to conditionally process button actions.
     * @param {Object} data - Event data containing topic and message */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            parsed = data.message
        }

        //  If there's an action field, delegate to the protected hook.
        if (parsed && typeof parsed === 'object' && parsed.action) {
            this.processAction(parsed.action, parsed)
        }

        //  Always call parent to cache and log the message (default behavior).
        super.handleMqttMessage(data)
    }

    //  -- Protected hooks --------------------------------------------------

    /** Process a button action with debounce protection.
     * @param {string} action - Action identifier (e.g., "single", "double")
     * @param {Object} [data] - Full parsed message data for context */
    processAction(action, data = {}) {
        if (this.#isDebounced(action)) return

        this.#lastAction = action
        this.#lastActionTime = Date.now()

        //  Try YAML-driven interaction first (by device friendly name).
        const routed = this.#routeToInteraction(this.getName(), { action })
        if (routed) return

        //  Fallback: legacy action-map dispatch.
        this.#executeAction(action, data)
    }

    //  Private helpers.

    /** Attempt to route an action through the InteractionContainer.
     * @param {string} deviceName - Device friendly name (e.g., "Garage Remote Control")
     * @param {Object} triggerData - Data including at least {action}
     * @returns {boolean} true if routed to an interaction
     * @private */
    #routeToInteraction(deviceName, triggerData) {
        //  Interactions are registered with snake_case names from YAML config.
        const interactionKey = slugify(deviceName)
        const interaction = InteractionContainer.getInteraction(interactionKey)
        if (!interaction) return false

        interaction.execute(triggerData)
        return true
    }

    /** Check whether an action falls within the debounce window.
     * @param {string} action - Action identifier
     * @returns {boolean} true if the action was debounced (ignored)
     * @private */
    #isDebounced(action) {
        if (!this.#lastActionTime) return false

        const elapsed = Date.now() - this.#lastActionTime
        if (elapsed >= this.#debounceWindow) return false

        //  Scoped debounce: a different action is a distinct user intent.
        if (this.#debounceScope === DEBOUNCE_SAME_ACTION && this.#lastAction !== action) {
            return false
        }

        this.log(
            `Debounced action: ${action} (` +
            `${temporal.millisecondsToHumanReadable(elapsed)} ago, ` +
            `window ${temporal.millisecondsToHumanReadable(this.#debounceWindow)})`
        )
        return true
    }

    /** Look up an action in the internal action-map and dispatch the command(s)
     * @param {string} action - Action identifier
     * @param {Object} [data] - Full parsed message data for context
     * @private */
    #executeAction(action, data = {}) {
        const mapping = this.#actionMap[action]
        if (!mapping) {
            this.log(`Unknown action: ${action}`)
            return
        }

        const targetLabel = mapping.targets
            ? mapping.targets.join(', ')
            : (mapping.target || 'unknown')

        LoggerService.info(
            `Action: ${action} -> ${mapping.state} on ${targetLabel}`,
            `${this.getLogPrefix()}:${this.getName()}`
        )

        //  Build the outgoing payload once. Legacy configs may carry extra fields.
        const cmdPayload = mapping.extra && typeof mapping.extra === 'object'
            ? Object.assign({}, mapping.extra, { state: mapping.state })
            : mapping.state

        if (mapping.targets) {
            //  Multiple targets -- find each and call receiveCommand.
            for (const targetName of mapping.targets) {
                const mechanism = DeviceContainer.findByName(targetName)
                if (mechanism) {
                    mechanism.receiveCommand(cmdPayload, DeviceCommandSource.HUMAN)
                } else {
                    this.log(`Target mechanism not found: ${targetName}`)
                }
            }
        } else {
            //  Single target.
            const mechanism = DeviceContainer.findByName(mapping.target)
            if (mechanism) {
                mechanism.receiveCommand(cmdPayload, DeviceCommandSource.HUMAN)
            } else {
                this.log(`Target mechanism not found: ${mapping.target}`)
            }
        }
    }
}
