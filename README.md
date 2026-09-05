<p align="center">
  <img src="assets/pocketrisu-banner-1024.png" alt="PocketRisu — Self-hosted AI Roleplay Chat Platform" width="900" />
</p>

<h1 align="center">PocketRisu — Self-hosted AI Roleplay Chat</h1>

<p align="center">
  <strong>English</strong> | <a href="i18n/README.ko.md">한국어</a> | <a href="i18n/README.de.md">Deutsch</a> | <a href="i18n/README.cn.md">简体中文</a> | <a href="i18n/README.es.md">Español</a> | <a href="i18n/README.vi.md">Tiếng Việt</a> | <a href="i18n/README.zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/PocketRisu/PocketRisu/releases">
    <img alt="Latest Release" src="https://img.shields.io/github/v/release/PocketRisu/PocketRisu?label=latest" />
  </a>
  <a href="LICENSE">
    <img alt="License: GPL-3.0" src="https://img.shields.io/github/license/PocketRisu/PocketRisu" />
  </a>
  <a href="https://nodejs.org/">
    <img alt="Node" src="https://img.shields.io/badge/node-≥22.12-brightgreen" />
  </a>
</p>

PocketRisu is a self-hosted AI roleplay chat platform you run on your PC or personal server and access from PC, tablet, and smartphone through a web browser.

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="assets/screenshots/screenshot-pc-chat.png" alt="PC chat" height="420" /></td>
      <td align="center"><img src="assets/screenshots/screenshot-mobile-chat.png" alt="Mobile chat" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>Mobile</b></td>
    </tr>
  </table>
</p>


## Documentation

- [Installation guide](docs/en/install.md)
- [RisuAI migration guide](docs/en/migration.md)
- [Remote access guide](docs/en/remote.md)
- [Termux installation guide (Android)](docs/en/termux.md)
- [Plugin storage guide](docs/en/plugin-storage.md)
- [Deactivating characters guide](docs/en/deactivate-characters.md)


## RisuAI Compatibility

PocketRisu is derived from [RisuAI](https://github.com/kwaroran/RisuAI) and refined for self-hosted environments. Existing RisuAI data can be migrated wholesale, and all RisuAI ecosystem assets remain usable as-is.

- RisuRealm character downloads
- Character cards (`.charx`, `.risum`, `.risup`, etc.)
- Modules, lorebooks, presets
- Backup files (`.bin`) with two-way compatibility

For migration from an existing RisuAI installation, see the [migration guide](docs/en/migration.md).


## Features

- **Multiple AI providers**: OpenAI, Claude, Gemini, DeepInfra, OpenRouter, Ollama, and more
- **Multi-device access**: Run one server, access from PC, tablet, and smartphone through a web browser
- **Server-side generation**: The server keeps generating even if your screen locks or the connection drops — reconnect and the completed response is restored automatically
- **Unified data storage**: All data (characters, chats, settings, inlay images) stored in a single SQLite database on your server (no external cloud dependency)
- **Easy server-side backup**: The server handles backup and restore directly; local `.bin` backup export and import also supported
- **Powerful dashboard**: Disk usage (per character / per module), reclaimable snapshot space, SQLite optimization, and more — all in one screen
- **Lorebook & long-term memory**: World info / memory book, HypaMemoryV3, and other context retention features
- **Automatic translation**: Auto-translate input and output for cross-language roleplay
- **Regex scripts & plugins**: Modify model output and extend functionality
- **TTS & additional assets**: Voice synthesis, embedded images / audio / video in chat
- **Self-update**: Automatic version detection; portable distributions update from the web UI
- **Mobile remote access**: Quick Tunnel (URL + QR) or Tailscale
- **Multilingual UI**: Korean, English, Japanese, Chinese, and more


## Community & Contact

- Bug reports / feature requests: [GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- Email: contact@pocketrisu.com
- Support the project: [Patreon](https://patreon.com/PocketRisu/membership) — entirely optional; supporters can have their name listed in the app, with no extra features or perks


## License

[GPL-3.0](LICENSE)
