<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu — Plataforma de Chat de Roleplay con IA Autoalojada" width="900" />
</p>

<h1 align="center">PocketRisu — Chat de Roleplay con IA Autoalojado</h1>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <strong>Español</strong> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
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

> 🌐 Este README está traducido por máquina. Para obtener la información más precisa, consulte la versión en [inglés](../README.md) o [coreano](README.ko.md). Las contribuciones son bienvenidas.

PocketRisu es una plataforma de chat de roleplay con IA autoalojada que se ejecuta en tu PC o servidor personal y se accede desde PC, tablet y smartphone a través de un navegador web.

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="../assets/screenshots/screenshot-pc-chat.png" alt="Chat en PC" height="420" /></td>
      <td align="center"><img src="../assets/screenshots/screenshot-mobile-chat.png" alt="Chat móvil" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>Móvil</b></td>
    </tr>
  </table>
</p>


## Documentación

- [Guía de instalación](../docs/es/install.md)
- [Guía de migración desde RisuAI](../docs/es/migration.md)
- [Acceso remoto](../docs/es/remote.md)
- [Guía de instalación de Termux (Android)](../docs/es/termux.md)


## Compatibilidad con RisuAI

PocketRisu deriva de [RisuAI](https://github.com/kwaroran/RisuAI) y está adaptado para entornos autoalojados. Los datos existentes de RisuAI se pueden migrar por completo, y todos los recursos del ecosistema de RisuAI siguen siendo utilizables tal cual.

- Descargas de personajes de RisuRealm
- Tarjetas de personaje (`.charx`, `.risum`, `.risup`, etc.)
- Módulos, lorebooks, presets
- Archivos de copia de seguridad (`.bin`) con compatibilidad bidireccional

Para migrar desde una instalación existente de RisuAI, consulta la [guía de migración](../docs/es/migration.md).


## Funciones

- **Múltiples proveedores de IA**: OpenAI, Claude, Gemini, DeepInfra, OpenRouter, Ollama y más
- **Acceso multidispositivo**: Ejecuta un servidor y accede desde PC, tablet y smartphone a través de un navegador web
- **Generación en el servidor**: El servidor sigue generando aunque la pantalla se apague o se pierda la conexión; al reconectarte, la respuesta completada se restaura automáticamente
- **Almacenamiento unificado de datos**: Todos los datos (personajes, chats, ajustes, imágenes inlay) se guardan en una única base de datos SQLite en tu servidor (sin dependencias de la nube externa)
- **Copia de seguridad fácil desde el servidor**: El servidor gestiona directamente la copia de seguridad y restauración; también se admite la exportación e importación de copias locales `.bin`
- **Panel potente**: Uso del disco (por personaje / por módulo), espacio de snapshot recuperable, optimización de SQLite y más — todo en una pantalla
- **Lorebook y memoria a largo plazo**: World info / memory book, HypaMemoryV3 y otras funciones de retención de contexto
- **Traducción automática**: Traducción automática de entrada y salida para roleplay multilingüe
- **Scripts regex y plugins**: Modifica la salida del modelo y extiende la funcionalidad
- **TTS y recursos adicionales**: Síntesis de voz, imágenes / audio / video integrados en el chat
- **Autoactualización**: Detección automática de versiones; las distribuciones portátiles se actualizan desde la interfaz web
- **Acceso remoto móvil**: Quick Tunnel (URL + QR) o Tailscale
- **Interfaz multilingüe**: Coreano, inglés, japonés, chino y más


## Comunidad y contacto

- Reportes de errores / solicitudes de funciones: [GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- Correo electrónico: contact@pocketrisu.com


## Licencia

[GPL-3.0](../LICENSE)
