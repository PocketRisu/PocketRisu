<p align="center">
  <strong>English</strong> | <a href="../ko/deactivate-characters.md">한국어</a>
</p>

# Deactivating Characters

Since PocketRisu v1.12.0 you can **deactivate** a character you are not using right now. The character and all of its chats leave the main database (`database.bin`) and are kept on the server; the character stays in your lists, dimmed, and can be activated again with one click.

- [1. Why](#1-why)
- [2. How to deactivate and activate](#2-how-to-deactivate-and-activate)
- [3. What changes while a character is deactivated](#3-what-changes-while-a-character-is-deactivated)
- [4. Backups, snapshots and older versions](#4-backups-snapshots-and-older-versions)
- [5. Storage dashboard](#5-storage-dashboard)
- [6. Troubleshooting](#6-troubleshooting)


## 1. Why

Everything in `database.bin` is loaded on every start and re-encoded on every save. A collection of hundreds of downloaded bots — most of them with lorebooks, trigger scripts and long chats — makes start-up slower, saves heavier and the browser use more memory even when only a few of those bots are in use.

Deactivating moves a bot's full body (character card, lorebook, scripts, every chat) out of that database into its own server-side row. Only a small stub (name, image, tags, chat count) stays behind so the lists can still show it.


## 2. How to deactivate and activate

**Deactivate**: either

- open the **Character Manager** with the button at the top of the sidebar (below the menu button) and choose **Deactivate Character** from a row's ⋯ menu — turn on **Select** to deactivate several characters at once; or
- open the character, go to the character settings tab, scroll to the bottom and press **Deactivate Character** (right above *Move to trash*).

After confirming, the character is deselected and its entry in the lists turns dimmed with a small box icon.

**Activate**: click the dimmed entry in the sidebar, the character manager or the storage dashboard. PocketRisu asks *"… is deactivated. Activate it?"*; confirm and the character opens as usual. **Activate Character** in the manager's ⋯ menu activates without opening.

**Hide deactivated characters** in Settings → Accessibility → **Character** removes them from the sidebar. The character manager and the storage dashboard always show them (use the manager's **Deactivated only** filter).

**Trash**: moving a character to the trash deactivates it the same way and only adds a trash marker. Trashed characters are never deleted automatically and cost nothing at runtime. Restore them (they come back deactivated) or delete them permanently from the manager's **Trash** tab. Characters left in the trash by an older version are migrated to this form automatically on the first start after updating.


## 3. What changes while a character is deactivated

- It cannot be opened, edited, exported, converted to a module or copied. Activate it first. Moving it to the trash works while deactivated.
- **Plugins, scripts, search and dataset export treat it as if it had been deleted.** The plugin API does not see it at all. A plugin that keeps per-character data keyed by character id may clean that data up, exactly as it would after you delete a bot. Activate the character before using plugin features on it.
- Its images and other assets are **not** orphaned: the orphan-media cleanup and the "unreferenced" filter of the inlay gallery both know about deactivated characters.
- Its chat drafts are kept.
- Drag-and-drop, folders and name search keep working on the dimmed entry.


## 4. Backups, snapshots and older versions

- **Backup export (`.bin`)** always contains deactivated characters as complete, normal characters. A backup imported into original RisuAI or into an older PocketRisu shows them as active characters. Trashed characters carry their trash marker, so they land in the trash there too (original RisuAI purges its trash after three days).
- **Backup import** starts with every character active. Server-side data of characters you had deactivated before the import is kept as "unreferenced deactivated-character data" until you purge it from the dashboard (section 5).
- **Snapshot restore** is safe in any order: each deactivation writes its own row, rows are never overwritten or deleted automatically, so a restored snapshot always opens exactly the chats it was taken with.
- **Downgrading** to a PocketRisu version older than v1.12.0 hides deactivated characters from the lists. Nothing is deleted; they reappear when you upgrade again. If you need them on the old version, activate them first or go through a `.bin` backup.


## 5. Storage dashboard

Settings → System → Storage shows:

- a **Deactivated characters** row in the disk chart (bodies and index of all deactivated characters);
- a *deactivated* badge on the per-character list, and a *data missing* badge if the stored body cannot be found;
- **Unreferenced deactivated-character data**: rows that no character in the database points at any more (activated again, deleted, or replaced by a backup import). They are kept on purpose so older snapshots can still be restored. Press **Purge stored data** to delete them — after that, an old snapshot that still points at them cannot open those characters.


## 6. Troubleshooting

- *"The stored character data could not be found"* when activating: the server row is gone (for example after a purge followed by a snapshot restore). PocketRisu offers to remove the entry from the list; nothing else is deleted. The character can be recovered only from a `.bin` backup made while it was active or deactivated.
- *"Some chats are not saved on the server yet"* when deactivating: wait a moment for autosave to finish and try again.
- The orphan-media count on the dashboard reads *unavailable* and purge is refused: a deactivated character's index or body is missing. Fix the character first (activate it, or remove its entry as above); the cleanup deliberately refuses to run on a partial view.
