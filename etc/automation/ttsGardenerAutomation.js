/**
 * TTS Gardener Automation.
 * Watches soil-moisture flower sensors and announces plant hydration.
 * status by voice, with sentences chosen from moisture thresholds tuned in YAML.
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument as yamlParseDocument } from 'yaml'

import RuleBasedAutomationBase from '../../src/automation/base/ruleBasedAutomationBase.js'
import DeviceContainer from '../../src/device/container/deviceContainer.js'
import AiAssistant from '../../src/ai/aiAssistant.js'
import ChatMessageOrigin from '../../src/enum/aiChatMessageOrigin.js'
import EventBus from '../../src/service/eventBus.js'
import I18nLoader from '../../src/service/i18nLoader.js'
import TtsService from '../../src/service/ttsService.js'
import TtsProfiles from '../../src/lib/ttsProfiles.js'
import { PROJECT_ROOT } from '../../src/lib/projectRoot.js'


/** Path to this automation's YAML config file. */
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-gardener.yaml')

/** Root directory containing per-locale i18n subdirectories. */
const I18N_ROOT = path.join(PROJECT_ROOT, 'etc', 'i18n')

/** Grace window (minutes) after a configured announce slot during which the next tick. */
const SLOT_GRACE_MINUTES = 5

export default class TtsGardenerAutomation extends RuleBasedAutomationBase {

    /** @type {Record<string, unknown>|null} Cached gardener i18n bundle; reloaded on every run. */
    #bundle = null

    /** flower name -> last announced severity index (higher = worse). In-memory only:
     * @type {Map<string, number>} */
    #lastAnnouncedSeverity = new Map()

    /** "HHmm" slot key -> local date ("YYYY-MM-DD") of the day that slot was last spoken. */
    #slotLastSpokenDate = new Map()

    //  -- Construction & lifecycle ------------------------------------------

    /** Fixed identity constructor -- name and config path are constants of this automation. */
    constructor() {
        super({ name: 'TtsGardenerAutomation', configPath: CONFIG_PATH })
    }

    /** Lifecycle hook -- loads the gardener i18n bundle once on top of the base init; */
    async init() {
        await super.init()
        this.#bundle = this.#loadBundle()
    }

    //  -- Public API ----------------------------------------------------------

    /** Main execution flow. Classifies the trigger into one of three kinds and routes:
     * @param {{trigger?: string, force?: boolean}|null} [triggerData] - Trigger info; */
    async execute(triggerData = null) {
        const triggerSource = String(triggerData?.trigger ?? 'unknown')
        this.log(`Triggered by: ${triggerSource}`, 'info')

        //  Off-guard: if neither the AI pipeline nor the TTS server is available there.
        if (!AiAssistant.isAvailable() && !TtsService.isEnabled()) {
            this.log('Both AI and TTS unavailable -- skipping gardener run', 'debug')
            return
        }

        //  Suppress execution during configured silent period (before any work begins)
        if (this.isInSilentPeriod()) {
            if (triggerData?.force === true) {
                this.log(`Forced run -- silent period bypassed (${triggerSource})`, 'info')
            } else {
                this.log(`Suppressed during silent period (${triggerSource})`, 'debug')
                return
            }
        }

        //  Reload bundle fresh each run (interpolation is runtime, not cached).
        this.#bundle = this.#loadBundle()
        if (!this.#bundle) {
            this.log('No gardener i18n bundle loaded, skipping', 'warn')
            return
        }

        const kind = this.#runKind(triggerSource)
        let dueSlot = null
        if (kind === 'slot') {
            dueSlot = this.dueAnnounceSlot(new Date())
            if (!dueSlot) {
                this.log('Timer tick with no announce slot due -- staying quiet', 'debug')
                return
            }
            this.log(`Scheduled status report for slot ${dueSlot}`, 'info')
        }

        const readings = this.readFlowerMoisture()
        if (readings.length === 0) {
            this.log('No readable flower sensors (device missing or non-numeric value) -- nothing to report', 'warn')
            return
        }

        const rules = this.rules()
        if (rules.length === 0) {
            this.log('No usable moisture rules configured -- nothing to evaluate', 'warn')
            return
        }

        //  Per-flower band + severity; the overall announcement follows the WORST plant.
        const severities = new Map()
        let worstIdx = rules.length - 1
        for (const reading of readings) {
            const idx = await this.bandIndexFor(reading.moisture, rules)
            const sev = idx == null ? 0 : rules.length - 1 - idx
            severities.set(reading.name, sev)
            if (idx != null && idx < worstIdx) worstIdx = idx
        }

        // Event gating: react only to worsening since the last announced state.
        if (kind === 'event') {
            const worsened = readings.some(r =>
                (severities.get(r.name) ?? 0) > (this.#lastAnnouncedSeverity.get(r.name) ?? 0))
            if (!worsened) {
                //  Baseline tracking even when staying quiet: record current severities.
                this.#recordSeverities(readings, severities)
                this.log('No plant worsened since the last announcement -- staying quiet', 'debug')
                return
            }
        }

        const tokens = this.#tokensFor(readings, severities)
        const spoken = await this.speakBucket(rules[worstIdx].section, tokens)
        if (!spoken) return   // missing template already warned; do not consume any state below

        //  Record current severities AFTER successful speech so repeats of the same state.
        this.#recordSeverities(readings, severities)
        if (dueSlot != null) {
            this.#slotLastSpokenDate.set(dueSlot, this.#dayKey(new Date()))
        }
    }

    /** Store per-flower severity baselines for this evaluation. Private helper shared.
     * @private
     * @param {Array<{name: string}>} readings - Readings evaluated this run
     * @param {Map<string, number>} severities - Computed severities to record */
    #recordSeverities(readings, severities) {
        for (const reading of readings) {
            this.#lastAnnouncedSeverity.set(reading.name, severities.get(reading.name) ?? 0)
        }
    }

    /** No device targets for this automation -- returns empty Map so parent's flow
     * @returns {Map<string, never>} Empty map */
    loadDevices() {
        return new Map()
    }

    /** Not used by ttsGardener (no device commands). Required abstract method kept.
     * @param {*} _device - Unused in this override (kept for signature parity)
     * @param {string} _targetKey - Unused in this override
     * @param {Array<Object>} _matchingRules - Unused in this override
     * @returns {null} Always null */
    resolveCommand(_device, _targetKey, _matchingRules) {
        return null
    }

    //  -- Testable seams ------------------------------------------------------

    /** Read the current moisture value from every configured flower sensor via the live
     * @returns {Array<{name: string, moisture: number}>} Usable readings (possibly empty) */
    readFlowerMoisture() {
        const out = []
        const property = typeof this.config?.moisture_property === 'string' && this.config.moisture_property.trim()
            ? this.config.moisture_property.trim()
            : 'moisture'

        for (const name of this.#configuredFlowers()) {
            let device = null
            try {
                device = DeviceContainer.findByName(name)
            } catch (error) {
                this.log(`Error looking up "${name}": ${error.message}`, 'warn')
                continue
            }
            if (!device) {
                this.log(`Sensor "${name}" not found in container`, 'warn')
                continue
            }
            const state = typeof device.getStateLast === 'function' ? device.getStateLast() ?? {} : {}
            const value = state[property]
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                this.log(`Could not read numeric "${property}" from "${name}" -- skipping`, 'warn')
                continue
            }
            out.push({ name, moisture: value })
        }
        return out
    }

    /** Index of the first rule (top-down) whose conditions match a given moisture value.
     * @param {number} value - Moisture reading to classify
     * @param {Array<{conditions?: Record<string, unknown>}>} [rules=this.rules()] - Normalized rules
     * @returns {Promise<number|null>} Matching rule index, or null */
    async bandIndexFor(value, rules = this.rules()) {
        for (let i = 0; i < rules.length; i++) {
            try {
                if (await this.conditionsMatch(rules[i].conditions, { moisture: value })) return i
            } catch (error) {
                this.log(`Error evaluating rule "${rules[i].name}": ${error.message}`, 'error')
            }
        }
        return null
    }

    /** Which announce slot (if any) is due at `now`: inside its grace window.
     * @param {Date} [now=new Date()] - Moment to evaluate
     * @returns {string|null} Due slot key ("HHmm"), or null when no slot is due */
    dueAnnounceSlot(now = new Date()) {
        const dayKey = this.#dayKey(now)
        const nowMin = now.getHours() * 60 + now.getMinutes()
        for (const slot of this.#announceSlots()) {
            if (this.#slotLastSpokenDate.get(slot.key) === dayKey) continue
            if (nowMin >= slot.minutes && nowMin < slot.minutes + SLOT_GRACE_MINUTES) {
                return slot.key
            }
        }
        return null
    }

    /** Resolve one configured bucket section, fill its runtime placeholders.
     * @param {string} sectionKey - Dotted i18n key from a rule's "sentence" (e.g., 'gardener.dry')
     * @param {Record<string, string>} tokens - Placeholder values ({% affected_flowers %}, ...)
     * @returns {Promise<boolean>} Whether speech went out */
    async speakBucket(sectionKey, tokens) {
        const section = this.#resolveSection(sectionKey)
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            this.log(`Gardener bucket "${sectionKey}" not found in active bundle -- check rules[].sentence`, 'warn')
            return false
        }

        const plainText = this.#fillTemplate(section.tts, tokens, `${sectionKey}.tts`)
        if (!plainText) {
            this.log(`No TTS sentence for "${sectionKey}.tts" in active bundle -- skipping`, 'warn')
            return false
        }

        //  Framing (intro/outro/spacing) resolved once per report from this automation's.
        const ttsOptions = TtsProfiles.resolve(this.config, (message) => this.log(message, 'warn'))

        if (this.config.use_ai === true && AiAssistant.isAvailable()) {
            const instruction = this.#fillTemplate(section.ai, tokens, `${sectionKey}.ai`)
            if (!instruction) {
                this.log(`No AI instruction for "${sectionKey}.ai" -- speaking the plain TTS sentence instead`, 'warn')
            } else {
                //  Emit system input to UI with exactly what goes to the model.
                if (EventBus.hasSubscribers('ai:systemMessage')) {
                    EventBus.emit('ai:systemMessage', { text: instruction })
                }
                if (await this.routeThroughAi(instruction, ttsOptions)) return true
                //  routeThroughAi already logged why.
            }
        } else if (this.config.use_ai === true) {
            this.log('use_ai enabled but AI unavailable -- speaking the plain TTS sentence instead', 'warn')
        }

        TtsProfiles.speak(plainText, ttsOptions)
        this.log(`Gardener report (${sectionKey}) sent via direct TTS`, 'debug')
        return true
    }

    /** Send one built garden report through the AI -> TTS pipeline with graceful degradation.
     * @param {string} aiInstruction - Full instruction sent to the model
     * @param {{intro?: string, outro?: string, intro_spacing?: number}} [ttsOptions={}] - Framing forwarded to the model's own speech
     * @returns {Promise<boolean>} true when the AI voiced the report, false on fallback */
    async routeThroughAi(aiInstruction, ttsOptions = {}) {
        let spoken = ''
        try {
            const response = await AiAssistant.processMessage(aiInstruction, { origin: ChatMessageOrigin.SYSTEM, tts: ttsOptions })
            spoken = typeof response === 'string' ? response.trim() : ''
        } catch (error) {
            this.log(`AI processing failed: ${error.message}`, 'warn')
            return false
        }

        if (!spoken) {
            this.log('AI reply was empty -- falling back to direct TTS', 'warn')
            return false
        }

        //  Emit the AI's response back to UI for rendering with <AI> prefix.
        if (EventBus.hasSubscribers('ai:periodicResponse')) {
            EventBus.emit('ai:periodicResponse', { text: spoken })
        }
        this.log(`Gardener report sent via AI -> TTS pipeline (${spoken.length} chars)`, 'debug')
        return true
    }

    /** Clear in-memory announcement state (per-flower severities + consumed slots) */
    resetState() {
        this.#lastAnnouncedSeverity.clear()
        this.#slotLastSpokenDate.clear()
    }

    //  -- Config & bundle helpers ---------------------------------------------

    /** Classify a trigger into an execution kind. Batched event triggers arrive.
     * @private
     * @param {string} triggerSource - Trigger identifier from execute()
     * @returns {'event'|'slot'|'immediate'} Execution kind */
    #runKind(triggerSource) {
        const src = String(triggerSource ?? '')
        if (/^zigbee:/i.test(src)) return 'event'
        if (src === 'timer') return 'slot'
        return 'immediate'
    }

    /** Normalized list of flower sensors to watch from config.triggers_zigbee.
     * @private
     * @returns {string[]} Flower sensor names */
    #configuredFlowers() {
        const raw = this.config?.triggers_zigbee
        if (Array.isArray(raw)) return raw.map((n) => String(n).trim()).filter(Boolean)
        if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
        return []
    }

    /** Parsed announce slots in YAML order: "HHmm" strings or numbers, validated to 0-2359;
     * @private
     * @returns {Array<{key: string, minutes: number}>} Usable slots */
    #announceSlots() {
        const out = []
        const seen = new Set()
        const raw = this.config?.announce_times
        const list = Array.isArray(raw) ? raw : (raw != null ? [raw] : [])
        for (const entry of list) {
            let hhmm = typeof entry === 'number' ? Math.trunc(entry) : parseInt(String(entry ?? '').trim(), 10)
            if (!Number.isFinite(hhmm) || hhmm < 0 || hhmm > 2359) {
                this.log(`announce_times entry ${JSON.stringify(entry)} is not a valid HHmm time -- ignoring`, 'warn')
                continue
            }
            const key = String(hhmm).padStart(4, '0')
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ key, minutes: Math.floor(hhmm / 100) * 60 + (hhmm % 100) })
        }
        return out
    }

    /** Normalized rules in YAML order (most severe first by convention): name.
     * @private
     * @returns {Array<{name: string, conditions: Record<string, unknown>, section: string}>} Usable rules */
    rules() {
        const out = []
        const raw = this.config?.rules
        if (!Array.isArray(raw)) return out
        raw.forEach((rule, index) => {
            if (!rule || typeof rule !== 'object') {
                this.log(`rules[${index}] is not an object -- skipping`, 'warn')
                return
            }
            const section = typeof rule.sentence === 'string' && rule.sentence.trim() ? rule.sentence.trim() : null
            if (!section) {
                this.log(`rules[${index}] has no "sentence" bundle key -- skipping`, 'warn')
                return
            }
            out.push({
                name: String(rule.name ?? `rule-${index + 1}`),
                conditions: (rule.conditions && typeof rule.conditions === 'object') ? rule.conditions : {},
                section
            })
        })
        return out
    }

    /** Local calendar-day key ("YYYY-MM-DD") used to scope once-per-day slot consumption.
     * @private
     * @param {Date} date - Moment to key on
     * @returns {string} Day key */
    #dayKey(date) {
        const m = String(date.getMonth() + 1).padStart(2, '0')
        const d = String(date.getDate()).padStart(2, '0')
        return `${date.getFullYear()}-${m}-${d}`
    }

    /** Runtime placeholder values for sentence interpolation.
     * @private
     * @param {Array<{name: string, moisture: number}>} readings - Live readings this run
     * @param {Map<string, number>} severities - Per-flower severity from execute()
     * @returns {Record<string, string>} Token map */
    #tokensFor(readings, severities) {
        const fmt = (v) => Number.isFinite(v) ? String(Number(v.toFixed(1))) : ''
        const sorted = [...readings].sort((a, b) => a.moisture - b.moisture)
        const affected = sorted.filter(r => (severities.get(r.name) ?? 0) > 0)
            .map(r => `${r.name} (${fmt(r.moisture)})`)
        return {
            affected_flowers: affected.join(', '),
            driest_flower: sorted.length > 0 ? sorted[0].name : '',
            driest_moisture: sorted.length > 0 ? fmt(sorted[0].moisture) : ''
        }
    }

    /** Load the gardener i18n bundle for the active locale.
     * @private
     * @returns {Record<string, unknown>|null} Parsed bundle object */
    #loadBundle() {
        try {
            const localeDir = I18nLoader.getLocale()
            const filePath = path.join(I18N_ROOT, localeDir, 'gardener.yaml')
            if (!fs.existsSync(filePath)) return null
            const doc = yamlParseDocument(fs.readFileSync(filePath, 'utf8'))
            return doc.contents?.toJSON() ?? null
        } catch (error) {
            this.log(`Failed to load gardener bundle: ${error.message}`, 'warn')
            return null
        }
    }

    /** Resolve a dotted i18n key against the loaded bundle. The first segment is treated.
     * @private
     * @param {string} key - Dot-separated key from a rule's "sentence"
     * @returns {*} Resolved value or undefined when not found */
    #resolveSection(key) {
        if (!this.#bundle || !key) return undefined
        const parts = String(key).split('.')
        if (parts.length < 2) return this.#bundle[key]
        let current = this.#bundle
        for (let i = 1; i < parts.length; i++) {
            if (current == null || typeof current !== 'object') return undefined
            current = current[parts[i]]
        }
        return current
    }

    /** Fill {% token %} placeholders in a raw template from a flat token map.
     * @private
     * @param {*} template - Raw YAML template line (must be a string to succeed)
     * @param {Record<string, unknown>} tokens - Token name to replacement string
     * @param {string} label - Bundle path used in warning messages
     * @returns {string} Interpolated text, or '' when unresolvable */
    #fillTemplate(template, tokens, label) {
        if (typeof template !== 'string' || !template.trim()) return ''
        let unresolved = false
        const text = String(template).replace(/\{%\s*([a-z_]+)\s*%}/g, (_match, key) => {
            const value = tokens?.[key]
            if (typeof value === 'string' && value.trim() !== '') return value
            unresolved = true
            return _match
        })
        if (unresolved) {
            this.log(`Sentence "${label}" has an unresolvable placeholder -- check the active i18n bundle`, 'warn')
            return ''
        }
        return text
    }
}
