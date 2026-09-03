<p align="center">
  <strong>English</strong> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI Migration Guide

There are three ways to migrate data from an existing RisuAI installation (Web RisuAI, Local RisuAI) to PocketRisu. Choose based on your source environment and data size.

- [1. Local Backup File (.bin)](#1-local-backup-file-bin) — Works in all environments. The most common method.
- [2. Save Folder Zip Upload](#2-save-folder-zip-upload) — Local RisuAI, small datasets.
- [3. Save Folder Direct Copy](#3-save-folder-direct-copy) — Local RisuAI, large datasets.


## Before You Start

> ⚠️ **Back up your existing data** before migrating. You can export a `.bin` file from RisuAI's Settings > Backup.


---

## 1. Local Backup File (.bin)

Export a `.bin` backup file from existing RisuAI, then import it into PocketRisu. Works regardless of the source environment (web / Tauri / Capacitor / local).

1. **In existing RisuAI**: Settings > Backup > "Save Local Backup" to export a `.bin` file.
2. **In PocketRisu**: Settings > Data Migration > "Import Original Risu Local Backup" to import the `.bin` file.

> ⚠️ **If you use web RisuAI logged in to an account** (your data is synced to the RisuAI server), a file made with "Save Local Backup" has an encrypted database that PocketRisu cannot read. The import is rejected with an explanation. Export it one of these ways instead:
> - **Log out, then back up** (recommended): Settings > Account > Logout moves your data into the browser (device). "Save Local Backup" then produces a normal backup, assets included.
> - **Partial Backup**: available while logged in and not encrypted, but it only includes character profile images.



---

## 2. Save Folder Zip Upload

If you were using Local RisuAI (the Node server version), you can zip your `save` folder and upload it.

1. Compress the `save` folder of your existing RisuAI project as a zip file.
2. In PocketRisu, go to Settings > Data Migration > "Import save folder from NodeOnly Risu" accordion.
3. Upload the zip via "Import from Save Folder (Zip Upload)".

> If the zip file is too large, the upload may fail. In that case, use [3. Save Folder Direct Copy](#3-save-folder-direct-copy).


---

## 3. Save Folder Direct Copy

Suitable for large datasets (several GB or more). Requires direct filesystem access to the server.

1. Stop the PocketRisu server.
2. Overwrite PocketRisu's `save` folder with the existing RisuAI's `save` folder.
3. Restart the PocketRisu server — automatic migration begins.
    - Monitor progress in the terminal or PM2 logs.
4. After migration completes, use Settings > Data Migration > "Import save folder from NodeOnly Risu" accordion > "Clean Up Migrated Save Files" to remove the original files and reclaim disk space.


---

## Which Method Should I Choose?

| Situation                                            | Recommended Method                |
| ---------------------------------------------------- | --------------------------------- |
| Migrating from Web RisuAI                            | 1. `.bin` backup                  |
| Migrating from Local RisuAI, small data              | 2. Zip upload                     |
| Migrating from Local RisuAI, large data (10GB+)      | 3. Save folder direct copy        |
| Not sure                                             | 1. `.bin` backup                  |


---

← [Back to README](../../README.md)
