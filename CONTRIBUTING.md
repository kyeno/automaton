# Contributing to Automaton

Thank you for your interest in contributing! This document outlines the conventions, expectations, and processes for contributing to Automaton.

## Project Philosophy

Automaton is a **pure JavaScript** project. We intentionally do not use TypeScript — this is a design decision that keeps the codebase accessible and avoids build-step complexity. Pull requests adding TypeScript, transpilation steps, or type-checking tooling will be declined.

That said, we value good documentation of types and interfaces. All public APIs use JSDoc annotations so IDEs can provide autocomplete and inline type hints without any compilation step.

## Code Conventions

### General Style

- **ES Modules only** — The project uses `"type": "module"` in `package.json`. All imports/exports are ESM (`import ... from '...'`, `export default`).
- **`'use strict'`** — Every source file begins with `'use strict'` after the JSDoc block.
- **4-space indentation** — No tabs. Configure your editor accordingly.
- **Single quotes** — Prefer single quotes for strings unless double quotes are needed to avoid escaping.
- **No fancy Unicode punctuation** — Em-dashes (`—`, `–`), curly/smart quotes (`"` `"` `'` `'`), ellipsis characters (`…`), bullets, and other decorative Unicode punctuation must not appear in code or comments. Use ASCII equivalents instead: regular dashes (`-`), straight quotes (`'`, `"`), three dots (`...`), etc.
- **Natural language text exception** — UTF-8 diacritics in natural language content are preserved and expected: Polish characters (ą, ć, ę, ł, ń, ó, ś, ź, ż), accented letters in other languages, Cyrillic, etc. This applies to i18n bundles, user-facing strings, device descriptions, AI system prompts, TTS templates, and any content that represents actual human language. Code identifiers, variable names, configuration keys, log messages, and technical comments remain ASCII-only.

### File Structure

```javascript
#!/usr/bin/env node        // Shebang for executable scripts (optional)
/**
 * Module description.
 *
 * @author Your Name
 * @license AGPL-3.0-only
 */
'use strict'

// Imports (external first, then internal, grouped logically)
import fs from 'node:fs'
import path from 'node:path'

import LoggerService from './service/loggerService.js'

// --- Constants / Schema -----------------------------------------------

// --- Class Definition -------------------------------------------------

class MyClass {
    #privateField           // Private fields use hash prefix

    /**
     * JSDoc for public methods.
     * @param {string} name - Description
     * @returns {boolean}
     */
    publicMethod(name) {
        // Implementation
    }

    /** Private method. */
    #privateMethod() {}
}

// --- Singleton Export --------------------------------------------------

const MyClass = Object.freeze(new SMyClass())
export default MyClass
```

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Source files | camelCase | `mqttService.js` |
| Classes | PascalCase | `MqttService`, `DeviceContainer` |
| Module-level singletons | PascalCase, prefixed with `S` internally | `SConfigService` class → `ConfigService` export |
| Functions/methods | camelCase | `initService`, `gracefulDeath` |
| Private fields/methods | `#` prefix (ES private) | `#config`, `#validate()` |
| Constants | UPPER_SNAKE_CASE | `CONFIG_SCHEMA`, `REQUIRED_ENV_VARS` |
| Config YAML filenames | lowercase with hyphens | `ambient-lights.yaml` |
| Custom automation JS | PascalCase matching YAML prefix | `salon-rolety.yaml` → `salonRoletyAutomation.js` |
| Custom interaction JS | PascalCase matching interaction name | `balkonWlacznikInteraction.js` |

### JSDoc Requirements

All public classes and methods should include JSDoc comments:

- **Classes** — Brief description, author, license.
- **Methods** — Description, `@param` for each parameter (with type), `@returns` if applicable.
- **Typedefs** — Use `@typedef` for complex object shapes used across the codebase.

Example:

```javascript
/**
 * Initialize a single service and track its lifecycle state.
 * @param {string} name - Human-readable service name
 * @param {Function} initFn - Async initialization function
 * @param {boolean} [optional=false] - If true, log warning instead of crashing on failure
 */
async function initService(name, initFn, optional = false) {}
```

## Autoloader Naming Convention

Custom automations, interactions, and devices are discovered by an autoloader that scans `etc/automation/`, `etc/interaction/`, and similar directories. The naming convention is strict:

1. A YAML file defines configuration: `my-feature.yaml`
2. An optional JavaScript class provides custom logic: `myFeatureClassName.js`
3. The JS filename uses **PascalCase** derived from the YAML prefix (hyphens removed, words capitalized)

Examples:
```
salon-rolety.yaml        → salonRoletyAutomation.js
ambient-lights.yaml     → ambientLightsAutomation.js
balkon-wlacznik          → balkonWlacznikInteraction.js  (referenced by name in interaction.yaml)
```

Deviations from this pattern result in files being silently ignored by the autoloader.

## Testing

Run the full test suite before submitting a PR:

```bash
npm test
```

The test runner performs:
1. Syntax checks (`node --check`) on every `.js` file under `src/`
2. Instantiation tests for services, devices, automations, and configurations

Tests currently verify that modules load without errors. Business-logic assertions are planned for future iterations. If you add new functionality, please add corresponding tests to `tests/`.

## Commit Messages

Use clear, imperative commit messages:

- ✅ `Added network presence detection for automation triggers`
- ✅ `FIX race condition in MQTT reconnection handler`
- ❌ `FIX stuff`, `updated things`, `wip`

Prefix with a scope when helpful:
```
feat(ai): add conversation TTL cleanup
fix(mqtt): handle disconnected state during unsubscribe
docs(config): document i18n bundle structure
```

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Make your changes**, following the conventions above.
3. **Test locally** — run `npm test` and ensure all checks pass.
4. **Update documentation** if your change affects configuration, CLI usage, or public APIs. Update `README.md` and/or `doc/configuration.md` as appropriate.
5. **Submit a PR** with a clear description of what changed and why.
6. A maintainer will review and merge once approved.

## What We're Looking For

Contributions in these areas are especially welcome:

- **Bug fixes** — Found something broken? Fix it!
- **Tests** — The current suite only verifies instantiation. Behavioral and integration tests would be invaluable.
- **Documentation** — Improvements to README, configuration guide, or inline JSDoc.
- **New device types** — Additional abstractions beyond mechanism/remote/sensor.
- **i18n bundles** — Translations for new languages (see [Adding a New Language](doc/configuration.md#adding-a-new-language)).

## What Not to Submit

- TypeScript conversions or `.ts` files.
- Changes that break the existing configuration format without a migration path.
- Personal home automation configurations (device names, room labels, IP addresses).

## Contributor License & Grant of Rights

By submitting a Pull Request or contributing code to the Automaton project, you agree to the following terms:

1. **License Grant:** You grant Ratan M. Kyeno a non-exclusive, perpetual, worldwide, royalty-free, transferable, and sublicensable license to use, modify, adapt, publish, distribute, and display your contributions.
2. **Relicensing & Dual-Licensing Rights:** You acknowledge and agree that Ratan M. Kyeno retains the sole right and authority to license, relicense, or dual-license the codebase—including your contributions—under alternative terms, including commercial or proprietary licenses, without further restriction or obligation to contributors.
3. **Originality & Ownership:** You represent and warrant that your contributions are your original creation, or that you have full legal authority to submit them under these terms, free of any third-party restrictions or obligations.