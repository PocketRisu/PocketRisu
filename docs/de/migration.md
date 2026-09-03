<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI-Migrationsleitfaden

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/migration.md) oder [koreanische](../ko/migration.md) Version.

Es gibt drei Möglichkeiten, Daten von einer bestehenden RisuAI-Installation (Web-RisuAI, Lokales RisuAI) zu PocketRisu zu migrieren. Wählen Sie je nach Quellumgebung und Datenmenge.

- [1. Lokale Backup-Datei (.bin)](#1-lokale-backup-datei-bin) — Funktioniert in allen Umgebungen. Die häufigste Methode.
- [2. Save-Ordner Zip-Upload](#2-save-ordner-zip-upload) — Lokales RisuAI, kleine Datenmengen.
- [3. Save-Ordner direkt kopieren](#3-save-ordner-direkt-kopieren) — Lokales RisuAI, große Datenmengen.


## Bevor Sie beginnen

> ⚠️ **Sichern Sie Ihre vorhandenen Daten** vor der Migration. Sie können eine `.bin`-Datei aus den Einstellungen > Backup von RisuAI exportieren.


---

## 1. Lokale Backup-Datei (.bin)

Exportieren Sie eine `.bin`-Backup-Datei aus dem bestehenden RisuAI und importieren Sie sie dann in PocketRisu. Funktioniert unabhängig von der Quellumgebung (Web / Tauri / Capacitor / lokal).

1. **Im bestehenden RisuAI**: Einstellungen > Backup > "Lokales Backup speichern", um eine `.bin`-Datei zu exportieren.
2. **In PocketRisu**: Einstellungen > Datenmigration > "Original Risu Local Backup importieren", um die `.bin`-Datei zu importieren.

> ⚠️ **Wenn Sie Web-RisuAI mit einem angemeldeten Konto nutzen** (Ihre Daten werden mit dem RisuAI-Server synchronisiert), ist die Datenbank in einer mit "Lokales Backup speichern" erstellten Datei verschlüsselt und kann von PocketRisu nicht gelesen werden. Der Import wird mit einer Erklärung abgelehnt. Exportieren Sie stattdessen auf eine dieser Arten:
> - **Abmelden, dann sichern** (empfohlen): Einstellungen > Konto > Abmelden verschiebt Ihre Daten in den Browser (Gerät). "Lokales Backup speichern" erzeugt danach ein normales Backup inklusive Assets.
> - **Teilweises Backup**: auch angemeldet verfügbar und nicht verschlüsselt, enthält aber nur die Profilbilder der Charaktere.



---

## 2. Save-Ordner Zip-Upload

Wenn Sie Lokales RisuAI (die Node-Server-Version) verwendet haben, können Sie Ihren `save`-Ordner zippen und hochladen.

1. Komprimieren Sie den `save`-Ordner Ihres bestehenden RisuAI-Projekts als Zip-Datei.
2. Öffnen Sie in PocketRisu Einstellungen > Datenmigration > "Save-Ordner von NodeOnly Risu importieren"-Akkordeon.
3. Laden Sie die Zip über "Aus Save-Ordner importieren (Zip-Upload)" hoch.

> Wenn die Zip-Datei zu groß ist, kann der Upload fehlschlagen. Verwenden Sie in diesem Fall [3. Save-Ordner direkt kopieren](#3-save-ordner-direkt-kopieren).


---

## 3. Save-Ordner direkt kopieren

Geeignet für große Datenmengen (mehrere GB oder mehr). Erfordert direkten Dateisystemzugriff auf den Server.

1. Stoppen Sie den PocketRisu-Server.
2. Überschreiben Sie den `save`-Ordner von PocketRisu mit dem `save`-Ordner des bestehenden RisuAI.
3. Starten Sie den PocketRisu-Server neu — die automatische Migration beginnt.
    - Überwachen Sie den Fortschritt im Terminal oder in den PM2-Logs.
4. Nach Abschluss der Migration verwenden Sie Einstellungen > Datenmigration > "Save-Ordner von NodeOnly Risu importieren"-Akkordeon > "Migrierte Save-Dateien aufräumen", um die Originaldateien zu entfernen und Speicherplatz freizugeben.


---

## Welche Methode soll ich wählen?

| Situation                                                  | Empfohlene Methode                |
| ---------------------------------------------------------- | --------------------------------- |
| Migration von Web-RisuAI                                   | 1. `.bin`-Backup                  |
| Migration von Lokalem RisuAI, kleine Datenmenge            | 2. Zip-Upload                     |
| Migration von Lokalem RisuAI, große Datenmenge (10GB+)     | 3. Save-Ordner direkt kopieren    |
| Unsicher                                                   | 1. `.bin`-Backup                  |


---

← [Zurück zur README](../../i18n/README.de.md)
