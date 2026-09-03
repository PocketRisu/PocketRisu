<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <strong>Español</strong> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# Guía de migración desde RisuAI

> 🌐 Esta guía está traducida por máquina. Para obtener la información más precisa, consulte la versión en [inglés](../en/migration.md) o [coreano](../ko/migration.md).

Hay tres formas de migrar datos desde una instalación existente de RisuAI (RisuAI Web, RisuAI Local) a PocketRisu. Elija según su entorno de origen y el tamaño de los datos.

- [1. Archivo de copia de seguridad local (.bin)](#1-archivo-de-copia-de-seguridad-local-bin) — Funciona en todos los entornos. El método más común.
- [2. Subida zip de la carpeta save](#2-subida-zip-de-la-carpeta-save) — RisuAI Local, datos pequeños.
- [3. Copia directa de la carpeta save](#3-copia-directa-de-la-carpeta-save) — RisuAI Local, datos grandes.


## Antes de comenzar

> ⚠️ **Haga una copia de seguridad de sus datos existentes** antes de migrar. Puede exportar un archivo `.bin` desde Configuración > Copia de seguridad en RisuAI.


---

## 1. Archivo de copia de seguridad local (.bin)

Exporte un archivo de copia de seguridad `.bin` desde RisuAI existente y luego impórtelo en PocketRisu. Funciona independientemente del entorno de origen (web / Tauri / Capacitor / local).

1. **En RisuAI existente**: Configuración > Copia de seguridad > "Guardar copia local" para exportar un archivo `.bin`.
2. **En PocketRisu**: Configuración > Migración de datos > "Importar copia local de Risu original" para importar el archivo `.bin`.

> ⚠️ **Si usa RisuAI web con una cuenta iniciada** (sus datos se sincronizan con el servidor de RisuAI), el archivo creado con "Guardar copia local" tiene la base de datos cifrada y PocketRisu no puede leerla. La importación se rechaza con una explicación. Exporte de una de estas formas:
> - **Cerrar sesión y luego hacer la copia** (recomendado): Configuración > Cuenta > Cerrar sesión mueve sus datos al navegador (dispositivo). Después, "Guardar copia local" genera una copia normal, con recursos incluidos.
> - **Copia parcial**: disponible con la sesión iniciada y sin cifrar, pero solo incluye las imágenes de perfil de los personajes.



---

## 2. Subida zip de la carpeta save

Si estaba usando RisuAI Local (la versión de servidor Node), puede comprimir su carpeta `save` y subirla.

1. Comprima la carpeta `save` de su proyecto RisuAI existente como un archivo zip.
2. En PocketRisu, vaya a Configuración > Migración de datos > acordeón "Importar carpeta save de NodeOnly Risu".
3. Suba el zip a través de "Importar desde carpeta save (Subir Zip)".

> Si el archivo zip es demasiado grande, la subida puede fallar. En ese caso, use [3. Copia directa de la carpeta save](#3-copia-directa-de-la-carpeta-save).


---

## 3. Copia directa de la carpeta save

Apropiado para grandes conjuntos de datos (varios GB o más). Requiere acceso directo al sistema de archivos del servidor.

1. Detenga el servidor PocketRisu.
2. Sobrescriba la carpeta `save` de PocketRisu con la carpeta `save` del RisuAI existente.
3. Reinicie el servidor PocketRisu — la migración automática comienza.
    - Monitoree el progreso en el terminal o en los logs de PM2.
4. Después de que se complete la migración, use Configuración > Migración de datos > acordeón "Importar carpeta save de NodeOnly Risu" > "Limpiar archivos save migrados" para eliminar los archivos originales y recuperar espacio en disco.


---

## ¿Qué método debo elegir?

| Situación                                                       | Método recomendado                       |
| --------------------------------------------------------------- | ---------------------------------------- |
| Migrar desde RisuAI Web                                         | 1. Copia `.bin`                          |
| Migrar desde RisuAI Local, datos pequeños                       | 2. Subida zip                            |
| Migrar desde RisuAI Local, datos grandes (10GB+)                | 3. Copia directa de la carpeta save      |
| No estoy seguro                                                 | 1. Copia `.bin`                          |


---

← [Volver al README](../../i18n/README.es.md)
