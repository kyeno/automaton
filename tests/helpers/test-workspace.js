/** Disposable, template-based test checkout; never reads active configuration or secrets. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// These implementations ship as source rather than opt-in .dist scripts. Local scripts
// must not enter discovery tests; add new shipped implementations here when needed.
const AUTOMATIONS = [
    'ambientLightsAutomation.js', 'bedroomRollersAutomation.js', 'bedroomVideoAutomation.js',
    'homeOfficeRollersAutomation.js', 'homeOfficeVideoAutomation.js', 'homeTheaterBase.js',
    'ttsGardenerAutomation.js', 'ttsGreeterAutomation.js', 'ttsTwilightAutomation.js',
    'ttsWeatherManAutomation.js',
]

/** Create a disposable checkout from current source and shipped configuration templates. */
export function createTestWorkspace(sourceRoot) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-tests-'))
    try {
        for (const dir of ['src', 'tests', 'bin']) fs.cpSync(path.join(sourceRoot, dir), path.join(root, dir), { recursive: true })
        for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file))
        fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')
        const copyTemplates = (dir, relative = '') => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const rel = path.join(relative, entry.name)
                if (entry.isDirectory()) copyTemplates(path.join(dir, entry.name), rel)
                else if (entry.name.endsWith('.dist') || /^i18n\/[^/]+\/date\.yaml$/.test(rel)
                    || (relative === 'automation' && AUTOMATIONS.includes(entry.name))) {
                    const dest = path.join(root, 'etc', rel)
                    fs.mkdirSync(path.dirname(dest), { recursive: true })
                    fs.copyFileSync(path.join(dir, entry.name), dest)
                }
            }
        }
        copyTemplates(path.join(sourceRoot, 'etc'))
        const templates = path.join(root, 'etc')
        const resetConfig = () => {
            // Each child starts with fresh fixtures, even when a preceding test fails mid-edit.
            const activate = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const file = path.join(dir, entry.name)
                    if (entry.isDirectory()) activate(file)
                    else if (entry.name.endsWith('.dist')) fs.copyFileSync(file, file.slice(0, -5))
                }
            }
            activate(templates)
        }
        resetConfig()
        fs.cpSync(templates, path.join(root, '.test-etc'), { recursive: true })
        fs.mkdirSync(path.join(root, 'var', 'log'), { recursive: true })
        return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
    } catch (error) {
        fs.rmSync(root, { recursive: true, force: true })
        throw error
    }
}

/** Fixed offline environment: inherited deployment URLs, credentials and locale are excluded. */
export function testEnvironment(root) {
    const env = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key]
    return {
        ...env, TZ: 'Europe/Warsaw', LANG: 'C.UTF-8', AUTOMATON_TEST_WORKSPACE: '1',
        MQTT_URL: 'mqtt://127.0.0.1:1', MQTT_PREFIX: 'zigbee2mqtt',
        REDIS_URL: 'redis://127.0.0.1:1/15', CONFIG_PATH: path.join(root, 'etc', 'automaton.yaml'),
        AI_API_URL: 'http://127.0.0.1:1', AI_API_KEY: 'test-key',
        TTS_API_URL: 'http://127.0.0.1:1/tts', TTS_TCP_ENDPOINT: '127.0.0.1:1',
    }
}

/** Restore the template checkout before each test process, including after a failed test. */
export function resetTestConfig(root) {
    const snapshot = path.join(root, '.test-etc')
    if (!fs.existsSync(snapshot)) throw new Error('Missing isolated test configuration snapshot')
    fs.rmSync(path.join(root, 'etc'), { recursive: true, force: true })
    fs.cpSync(snapshot, path.join(root, 'etc'), { recursive: true })
    fs.rmSync(path.join(root, 'var'), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'var', 'log'), { recursive: true })
}
