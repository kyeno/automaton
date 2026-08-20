/**
 * Remote device type.
 *  Extends DeviceBase with action-to-command mapping for multi-button remotes.
 *  Uses DeviceContainer to find target Mechanism devices and call receiveCommand()
 *  instead of publishing directly to MQTT.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default debounce window in milliseconds.
 * Any action arriving within this window after a previously processed
 * action is silently ignored to prevent flash issues caused by devices
 * re-publishing their own state updates.
 * @type {number}
 */
const DEFAULT_DEBOUNCE_WINDOW_MS = 800

// ---------------------------------------------------------------------------
// Remote class
// ---------------------------------------------------------------------------

/**
 * Remote class that extends DeviceBase.
 *
 * Handles button actions and maps them to device commands via DeviceContainer.
 * Supports both single-target and multi-target action mappings, with built-in
 * debounce protection to prevent rapid duplicate actions.
 *
 * Subclasses may override {@link processAction} to intercept specific actions
 * before the default action-map lookup (e.g., custom single-click logic).
 */
export default class Remote extends DeviceBase {

    // -- Private state ----------------------------------------------------

    /**
     * Action mapping: action identifier -> { target, state, extra?, targets? }
     * @type {Object<string, Object>}
     */
    #actionMap = {}

    /**
     * Last processed action identifier (for debugging/logging).
     * @type {string|null}
     */
    #lastAction = null

    /**
     * Timestamp of last processed action in milliseconds since epoch.
     * @type {number}
     */
    #lastActionTime = 0

    /**
     * Debounce window in milliseconds.
     * @type {number}
     */
    #debounceWindow = DEFAULT_DEBOUNCE_WINDOW_MS

    // -- Constructor ------------------------------------------------------

    /**
     * Create Remote object.
     *
     * @constructor
     * @param {string} name - Device name
     * @param {string} id - Device ID
     * @param {Object} data - Device data
     * @param {Object<string, Object>} [actionMap={}] - Button action mapping
     */
    constructor(name, id, data, actionMap = {}) {
        super(name, id, data)
        this.#actionMap = actionMap
    }

    // -- Accessors --------------------------------------------------------

    /**
     * Get the current action mapping.
     *
     * @returns {Object<string, Object>}
     */
    get actionMap() {
        return this.#actionMap
    }

    /**
     * Set a new action mapping (replaces the existing one).
     *
     * @param {Object<string, Object>} map - Button action mapping
     */
    set actionMap(map) {
        this.#actionMap = map
    }

    // -- Overrides --------------------------------------------------------

    /**
     * Return the log prefix label for remotes.
     * @returns {string}
     */
    getLogPrefix() {
        return 'Remote'
    }

    /**
     * Override handleMqttMessage to conditionally process button actions.
     *
     * - IF the message contains an "action" field: process it as a button press
     *   (delegate to {@link _processAction}, which subclasses may override).
     * - Always call parent to cache and log the message (default behavior).
     *
     * @param {Object} data - Event data containing topic and message
     */
    handleMqttMessage(data) {
        let parsed
        try {
            parsed = JSON.parse(data.message)
        } catch {
            parsed = data.message
        }

        // If there's an action field, delegate to the protected hook.
        if (parsed && typeof parsed === 'object' && parsed.action) {
            this.processAction(parsed.action, parsed)
        }

        // Always call parent to cache and log the message (default behavior).
        super.handleMqttMessage(data)
    }

    // -- Protected hooks --------------------------------------------------

    /**
     * Process a button action with debounce protection.
     *
     * This is the **protected override point** for subclasses. The default
     * implementation performs debounce checks, then attempts to route the
     * action through the InteractionContainer (YAML-driven system). If no
     * matching interaction is registered, falls back to the legacy
     * action-map lookup and dispatches commands via DeviceContainer.
     *
     * Subclasses may override to intercept specific actions (e.g., "single")
     * and fall through to `super._processAction(action, data)` for the rest.
     *
     * @param {string} action - Action identifier (e.g., "single", "double")
     * @param {Object} [data] - Full parsed message data for context
     */
    processAction(action, data = {}) {
        if (this.#isDebounced(action)) return

        this.#lastAction = action
        this.#lastActionTime = Date.now()

        // Try YAML-driven interaction first (by device friendly name).
        const routed = this.#routeToInteraction(this.getName(), { action })
        if (routed) return

        // Fallback: legacy action-map dispatch.
        this.#executeAction(action, data)
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Attempt to route an action through the InteractionContainer using the
     * device's friendly name (slugified) as the interaction key. Returns true
     * if a matching interaction was found and executed, false otherwise.
     *
     * @param {string} deviceName - Device friendly name (e.g., "Garage Remote Control")
     * @param {Object} triggerData - Data including at least {action}
     * @returns {boolean} true if routed to an interaction
     * @private
     */
    #routeToInteraction(deviceName, triggerData) {
        // Interactions are registered with snake_case names from YAML config.
        // Slugify the device name to match: "Garage Remote Control" -> "garage_remote_control".
        const interactionKey = slugify(deviceName)
        const interaction = InteractionContainer.getInteraction(interactionKey)
        if (!interaction) return false

        interaction.execute(triggerData)
        return true
    }

    /**
     * Check whether an action falls within the debounce window.
     * Logs and returns true if debounced.
     *
     * @param {string} action - Action identifier
     * @returns {boolean} true if the action was debounced (ignored)
     * @private
     */
    #isDebounced(action) {
        if (!this.#lastActionTime) return false

        const elapsed = Date.now() - this.#lastActionTime
        if (elapsed < this.#debounceWindow) {
            this.log(
                `Debounced action: ${action} (` +
                `${temporal.millisecondsToHumanReadable(elapsed)} ago, ` +
                `window ${temporal.millisecondsToHumanReadable(this.#debounceWindow)})`
            )
            return true
        }

        return false
    }

    /**
     * Look up an action in the internal action-map and dispatch the command(s)
     * to target Mechanism device(s) via DeviceContainer.
     *
     * @param {string} action - Action identifier
     * @param {Object} [data] - Full parsed message data for context
     * @private
     */
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

        // Build the outgoing payload once. Legacy configs may carry extra fields in
        // `extra`; merge them alongside state so nothing ever lands in the command
        // provenance slot (the second receiveCommand argument is now an explicit
        // DeviceCommandSource enum, not a boolean that could be clobbered).
        const cmdPayload = mapping.extra && typeof mapping.extra === 'object'
            ? Object.assign({}, mapping.extra, { state: mapping.state })
            : mapping.state

        if (mapping.targets) {
            // Multiple targets -- find each and call receiveCommand.
            for (const targetName of mapping.targets) {
                const mechanism = DeviceContainer.findByName(targetName)
                if (mechanism) {
                    mechanism.receiveCommand(cmdPayload, DeviceCommandSource.HUMAN)
                } else {
                    this.log(`Target mechanism not found: ${targetName}`)
                }
            }
        } else {
            // Single target.
            const mechanism = DeviceContainer.findByName(mapping.target)
            if (mechanism) {
                mechanism.receiveCommand(cmdPayload, DeviceCommandSource.HUMAN)
            } else {
                this.log(`Target mechanism not found: ${mapping.target}`)
            }
        }
    }
}
