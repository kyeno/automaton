/** Verify that deployment edits, disabled rules and credentials never enter the test checkout. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestWorkspace, resetTestConfig, testEnvironment } from './helpers/test-workspace.js'

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-isolation-fixture-'))
const write = (name, text) => {
    const file = path.join(source, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}
let workspace
try {
    for (const dir of ['src', 'tests', 'bin', 'node_modules']) fs.mkdirSync(path.join(source, dir))
    write('package.json', '{"type":"module"}')
    write('package-lock.json', '{}')
    write('etc/automaton.yaml.dist', 'locale: { language: en_US }\n')
    write('etc/automaton.yaml', 'invalid local config: [\n')
    write('etc/automation/example.yaml.dist', 'rules: [{ name: template-rule }]\n')
    write('etc/automation/example.yaml', 'rules: []\n')
    write('etc/automation/privateAutomation.js', 'throw new Error("local code")')
    write('etc/automation/exampleAutomation.js.dist', 'export default class Example {}')
    write('etc/i18n/en_US/date.yaml', 'period: morning\n')
    write('.env', 'SMTP_PASS=deployment-secret\n')
    workspace = createTestWorkspace(source)
    const read = (name) => fs.readFileSync(path.join(workspace.root, name), 'utf8')
    assert.equal(read('etc/automaton.yaml'), read('etc/automaton.yaml.dist'))
    assert.match(read('etc/automation/example.yaml'), /template-rule/)
    assert.equal(fs.existsSync(path.join(workspace.root, '.env')), false)
    assert.equal(fs.existsSync(path.join(workspace.root, 'etc/automation/privateAutomation.js')), false)
    assert.match(read('etc/automation/exampleAutomation.js'), /class Example/)
    assert.match(read('etc/i18n/en_US/date.yaml'), /morning/)

    // A failed child may edit/delete config, create scripts, or alter a template.
    fs.writeFileSync(path.join(workspace.root, 'etc/automation/example.yaml.dist'), 'corrupted')
    fs.rmSync(path.join(workspace.root, 'etc/automation/example.yaml'))
    fs.writeFileSync(path.join(workspace.root, 'etc/automation/leaked.js'), 'corrupted')
    resetTestConfig(workspace.root)
    assert.match(read('etc/automation/example.yaml'), /template-rule/)
    assert.match(read('etc/automation/example.yaml.dist'), /template-rule/)
    assert.equal(fs.existsSync(path.join(workspace.root, 'etc/automation/leaked.js')), false)

    assert.equal(fs.readFileSync(path.join(source, 'etc/automaton.yaml'), 'utf8'), 'invalid local config: [\n')
    assert.equal(fs.readFileSync(path.join(source, 'etc/automation/example.yaml'), 'utf8'), 'rules: []\n')

    // A fresh clone with no active files produces exactly the same test configuration.
    fs.rmSync(path.join(source, 'etc/automaton.yaml'))
    fs.rmSync(path.join(source, 'etc/automation/example.yaml'))
    const fresh = createTestWorkspace(source)
    try {
        assert.equal(fs.readFileSync(path.join(fresh.root, 'etc/automaton.yaml'), 'utf8'), read('etc/automaton.yaml'))
        assert.equal(fs.readFileSync(path.join(fresh.root, 'etc/automation/example.yaml'), 'utf8'), read('etc/automation/example.yaml'))
    } finally { fresh.cleanup() }

    const env = testEnvironment(workspace.root)
    assert.equal(env.TZ, 'Europe/Warsaw')
    assert.equal(env.SMTP_PASS, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.REDIS_URL, 'redis://127.0.0.1:1/15')
    assert.equal(fs.readFileSync(path.join(source, '.env'), 'utf8'), 'SMTP_PASS=deployment-secret\n')
    console.log('Test isolation checks passed (customized, disabled and missing local configuration).')
} finally {
    workspace?.cleanup()
    fs.rmSync(source, { recursive: true, force: true })
}
