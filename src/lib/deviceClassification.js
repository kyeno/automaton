/**
 * Bridge-driven device classification.
 * Pure helpers that derive a device type category from the definition the zigbee2mqtt
 * bridge reports, used only when etc/device/zigbee.yaml has no entry for a device.
 *
 * Why this exists: an unmapped device used to become a DummyDevice, which answers
 * power_on/power_off by faking a state change and shows up in the UI as a mechanism.
 * A soil-moisture probe renamed in zigbee2mqtt (so its friendly name stopped matching
 * the config entry) landed there silently. A measurement-only device must never be
 * presented as an actuator, so the bridge definition -- the source of truth the
 * container already receives -- decides.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

/** Properties that only ever report a measurement.
 * @type {Set<string>} */
const SENSOR_HINT_PROPERTIES = Object.freeze(new Set([
    'temperature', 'humidity', 'soil_moisture', 'illuminance', 'illuminance_l1',
    'pressure', 'battery', 'battery_low', 'voltage', 'power', 'energy', 'current',
    'occupancy', 'presence', 'contact', 'water_leak', 'smoke', 'gas', 'co2',
    'pm25', 'pm10', 'formaldehyde', 'voc', 'noise', 'tamper', 'local_temperature',
]))

/** Properties that prove the device actuates something.
 * @type {Set<string>} */
const ACTUATOR_HINT_PROPERTIES = Object.freeze(new Set([
    'state', 'state_left', 'state_right', 'position', 'brightness', 'color_temp',
    'color_xy', 'color', 'cover_position', 'tilt', 'fan_mode', 'mode', 'preset',
    'running_state', 'lock', 'switch', 'switch_state', 'dimmer', 'curtain_position',
]))

/** Categories a definition may decide on its own. Remote and mechanism need command
 *  semantics a definition cannot prove, so they stay config-only.
 * @type {string[]} */
const AUTO_ASSIGNABLE_CATEGORIES = Object.freeze(['sensor'])

/** Distinct sensor features required before a definition is called a sensor. A lone
 *  battery report is not a sensor; a probe reporting soil_moisture + battery is.
 * @type {number} */
const AUTO_SENSOR_MIN_FEATURES = 2

/**
 * Collect every property name a zigbee2mqtt device definition exposes.
 *
 * The bridge reports features under a few shapes across versions (definition.features,
 * definition.options, nested expose groups); every feature carries a "property" and/or
 * "name" key. Unknown shapes are ignored, so a device the bridge has not interviewed
 * yields an empty list and classification stays neutral.
 *
 * @param {Object|null} definition - One entry of the zigbee2mqtt bridge device list
 * @returns {string[]} Exposed property names (lowercased)
 */
export function exposedProperties(definition) {
    const found = []
    if (!definition || typeof definition !== 'object') return found

    const lists = [
        definition.definition?.features,
        definition.definition?.options,
        definition.definition?.exposes,
        definition.features,
        definition.options,
    ]

    for (const list of lists) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
            if (typeof entry === 'string') {
                found.push(entry.toLowerCase())
                continue
            }
            if (!entry || typeof entry !== 'object') continue
            if (typeof entry.property === 'string') found.push(entry.property.toLowerCase())
            if (typeof entry.name === 'string') found.push(entry.name.toLowerCase())
            //  Composite exposes nest their own feature list one level deeper.
            if (Array.isArray(entry.features)) {
                found.push(...exposedProperties({ features: entry.features }))
            }
        }
    }

    return found
}

/**
 * Derive a type category from the bridge definition alone.
 *
 * Deliberately conservative: any actuating property keeps the existing DummyDevice
 * fallback (the safe status quo for switches and covers), and a device needs at least
 * AUTO_SENSOR_MIN_FEATURES distinct measurement properties before it is called a sensor.
 *
 * @param {Object|null} definition - One entry of the zigbee2mqtt bridge device list
 * @param {Object} [options] - Options
 * @param {string[]} [options.availableCategories] - Categories the caller can instantiate
 * @param {number} [options.minSensorFeatures] - Distinct sensor features required
 * @returns {string|null} Category key, or null when the definition is not decisive
 */
export function categoryFromDefinition(definition, options = {}) {
    const {
        availableCategories = AUTO_ASSIGNABLE_CATEGORIES,
        minSensorFeatures = AUTO_SENSOR_MIN_FEATURES,
    } = options

    const props = exposedProperties(definition)
    if (props.length === 0) return null

    //  Anything that actuates stays with the config-driven DummyDevice fallback.
    if (props.some(prop => ACTUATOR_HINT_PROPERTIES.has(prop))) return null

    const measurements = new Set(props.filter(prop => SENSOR_HINT_PROPERTIES.has(prop)))
    if (measurements.size < minSensorFeatures) return null

    return AUTO_ASSIGNABLE_CATEGORIES.find(cat => availableCategories.includes(cat)) ?? null
}

export {
    SENSOR_HINT_PROPERTIES,
    ACTUATOR_HINT_PROPERTIES,
    AUTO_ASSIGNABLE_CATEGORIES,
    AUTO_SENSOR_MIN_FEATURES,
}
