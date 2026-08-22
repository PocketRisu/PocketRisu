<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu — Selbst gehostete KI-Rollenspiel-Chat-Plattform" width="900" />
</p>

<h1 align="center">PocketRisu — Selbst gehostete KI-Rollenspiel-Chat-Plattform</h1>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <strong>Deutsch</strong> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/PocketRisu/PocketRisu/releases">
    <img alt="Latest Release" src="https://img.shields.io/github/v/release/PocketRisu/PocketRisu?label=latest" />
  </a>
  <a href="../LICENSE">
    <img alt="License: GPL-3.0" src="https://img.shields.io/github/license/PocketRisu/PocketRisu" />
  </a>
  <a href="https://nodejs.org/">
    <img alt="Node" src="https://img.shields.io/badge/node-≥22.12-brightgreen" />
  </a>
</p>

> 🌐 Diese README wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../README.md) oder [koreanische](README.ko.md) Version. Beiträge willkommen.

PocketRisu ist eine selbstgehostete KI-Rollenspiel-Chat-Plattform, die Sie auf Ihrem PC oder persönlichen Server betreiben und über einen Webbrowser von PC, Tablet und Smartphone aus nutzen.

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="../assets/screenshots/screenshot-pc-chat.png" alt="PC-Chat" height="420" /></td>
      <td align="center"><img src="../assets/screenshots/screenshot-mobile-chat.png" alt="Mobiler Chat" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>Mobil</b></td>
    </tr>
  </table>
</p>


## Dokumentation

- [Installationsanleitung](../docs/de/install.md)
- [RisuAI-Migrationsleitfaden](../docs/de/migration.md)
- [Fernzugriff](../docs/de/remote.md)
- [Termux-Installationsanleitung (Android)](../docs/de/termux.md)


## RisuAI-Kompatibilität

PocketRisu ist von [RisuAI](https://github.com/kwaroran/RisuAI) abgeleitet und für selbstgehostete Umgebungen optimiert. Bestehende RisuAI-Daten können vollständig migriert werden, und alle RisuAI-Ökosystem-Assets bleiben unverändert nutzbar.

- RisuRealm-Charakter-Downloads
- Charakterkarten (`.charx`, `.risum`, `.risup` usw.)
- Module, Lorebooks, Presets
- Backup-Dateien (`.bin`) mit bidirektionaler Kompatibilität

Für die Migration von einer bestehenden RisuAI-Installation siehe den [Migrationsleitfaden](../docs/de/migration.md).


## Funktionen

- **Mehrere KI-Anbieter**: OpenAI, Claude, Gemini, DeepInfra, OpenRouter, Ollama und mehr
- **Mehrgerätezugriff**: Einen Server betreiben und von PC, Tablet und Smartphone über einen Webbrowser zugreifen
- **Serverseitige Generierung**: Der Server generiert weiter, auch wenn der Bildschirm ausgeht oder die Verbindung abbricht — nach dem erneuten Verbinden wird die fertige Antwort automatisch wiederhergestellt
- **Vereinheitlichte Datenspeicherung**: Alle Daten (Charaktere, Chats, Einstellungen, Inlay-Bilder) werden in einer einzigen SQLite-Datenbank auf Ihrem Server gespeichert (keine externe Cloud-Abhängigkeit)
- **Einfaches serverseitiges Backup**: Der Server verwaltet Backup und Wiederherstellung direkt; lokaler `.bin`-Backup-Export und -Import werden ebenfalls unterstützt
- **Leistungsstarkes Dashboard**: Festplattennutzung (pro Charakter / pro Modul), wiederherstellbarer Snapshot-Speicher, SQLite-Optimierung und mehr — alles in einem Bildschirm
- **Lorebook & Langzeitgedächtnis**: World Info / Memory Book, HypaMemoryV3 und andere Kontext-Erhaltungsfunktionen
- **Automatische Übersetzung**: Automatische Übersetzung von Ein- und Ausgabe für sprachübergreifendes Rollenspiel
- **Regex-Skripte & Plugins**: Modellausgabe ändern und Funktionalität erweitern
- **TTS & zusätzliche Assets**: Sprachsynthese, eingebettete Bilder / Audio / Video im Chat
- **Selbstaktualisierung**: Automatische Versionserkennung; portable Distributionen aktualisieren sich über die Web-UI
- **Mobiler Fernzugriff**: Quick Tunnel (URL + QR) oder Tailscale
- **Mehrsprachige UI**: Koreanisch, Englisch, Japanisch, Chinesisch und mehr


## Community & Kontakt

- Fehlerberichte / Funktionswünsche: [GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- E-Mail: contact@pocketrisu.com


## Lizenz

[GPL-3.0](../LICENSE)
