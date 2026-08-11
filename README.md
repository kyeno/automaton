# Automaton

<div align="center">

```
    _         _                        _              
   / \  _   _| |_ ___  _ __ ___   __ _| |_ ___  _ __  
  / _ \| | | | __/ _ \| '_ ` _ \ / _` | __/ _ \| '_ \ 
 / ___ \ |_| | || (_) | | | | | | (_| | || (_) | | | |
/_/   \_\__,_|\__\___/|_| |_| |_|\__,_|\__\___/|_| |_|
```

<b>A programmatic approach to Zigbee2MQTT home automation.</b>

[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![TypeScript-Free](https://img.shields.io/badge/TypeScript-free-ff69b4?style=flat-square)

</div>

> This is a TypeScript-free project. Stop JavaScript pollution.

Automaton is a pure JavaScript Zigbee2MQTT sidekick that provides rule-based automations, device interactions triggered by Zigbee remotes, an AI-powered chat assistant with TTS support, and a terminal UI inspired by classic IRC clients. It connects to your existing Zigbee2MQTT installation via MQTT and uses Redis for state caching.

## ⚠️ Experimental Software

**This project is in early active development.** APIs, configuration formats, and architecture may change without notice between versions. Not recommended for production use yet — pin your version and test thoroughly before upgrading.

---

## Quick start

```bash
git clone https://github.com/kyeno/automaton.git && cd automaton
npm install
sh bin/automaton
```

For detailed setup instructions, see [Installation & Requirements](doc/installation/index.md).

---

## Documentation

| Document | Description |
|----------|-------------|
| [Installation & Requirements](doc/installation/index.md) | Runtime deps, system packages, first-time setup |
| [Configuration Guide](doc/configuration.md) | Every config file, environment variable, and i18n bundle explained |
| [Example Automations](doc/example-automations.md) | Included example automations and how they work |
| [Terminal UI](doc/ui/index.md) | Windows, channels, layout, input modes, slash commands |
| [Architecture](doc/architecture/index.md) | Project structure, core concepts, CLI usage, testing |
| [TODO & Roadmap](doc/TODO.md) | Planned features and known issues |

### Generated API Reference

JSDoc-based API documentation can be generated from source code comments:

```bash
npm run docs
```

This produces an HTML site in `doc/api/`. Open `doc/api/index.html` in your browser.

---

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting pull requests. Key points:

- This is a **pure JavaScript** project — no TypeScript.
- All source files use ES modules (`"type": "module"` in package.json).
- JSDoc annotations are used throughout for IDE support and self-documentation.

---

## License

Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

See the [LICENSE](LICENSE) file for the full license text.

### Commercial Licensing

If you wish to use this software in a commercial product, SaaS, or inside a closed-source ecosystem without being bound by the copyleft obligations of AGPLv3, a **Commercial License** is required.

For commercial licensing inquiries, please contact: `matt@prayam.com`