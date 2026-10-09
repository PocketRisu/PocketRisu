<p align="center">
  <strong>English</strong> | <a href="../ko/plugin-storage.md">한국어</a>
</p>

# Plugin Storage and Sharing Data Between Plugins

This guide explains where plugin data (`pluginCustomStorage`) lives since PocketRisu v1.11.0 and how a plugin reads another plugin's data. It is written for plugin authors and for users deciding whether to enable the "Provide all plugin data" option.

- [1. What changed](#1-what-changed) : plugin data moved to the server store
- [2. For users](#2-for-users) : when a plugin cannot read other plugins' data
- [3. For plugin authors](#3-for-plugin-authors) : recommended API and compatibility
- [4. Cost and caveats](#4-cost-and-caveats) : why the full-access option is heavy
- [5. Backups and compatibility](#5-backups-and-compatibility)


## 1. What changed

In upstream RisuAI every plugin's data sits in one `pluginCustomStorage` object inside `database.bin`. Once long-term-memory plugins accumulate hundreds of MB, that single object freezes the browser or makes saves fail.

Since PocketRisu v1.11.0 plugin values are stored **per key in the server database**, and the browser reads only the keys it needs. Consequences:

- Plugin data no longer sits in `database.bin` or in the app's main in-memory database, so the app keeps working with very large plugin data. (V2 preloads and the full-access option below do bring values into memory; see section 4.)
- V2 / V2.1 plugins use a synchronous API, so every key is preloaded right before the first enabled V2 plugin runs. Same behaviour as before, fetched once per plugin load.
- The `pluginCustomStorage` field of the snapshot a V3 plugin gets from `getDatabase()` is **empty by default**, because copying every value into the plugin is expensive.

That last point is where PocketRisu differs from upstream. A V3 plugin that reads another plugin's data through `getDatabase().pluginCustomStorage[...]` receives an empty object on PocketRisu.


## 2. For users

If a plugin needs another plugin's data to work (for example, a plugin that combines the contents of several memory plugins) and that part does not work on PocketRisu:

1. Check whether the plugin offers a PocketRisu-compatible version. If the author adopted one of the methods in section 3, no setting is needed.
2. Otherwise open **Settings > Plugins**, click the plugin to open its details, and enable **"Provide all plugin data (RisuAI compatible)"**. That plugin then receives the same data shape as on upstream RisuAI.

Enable this **only for plugins that really need it**. Every time such a plugin reads the database, the entire plugin storage is copied (see section 4). The option's description shows the current storage size.

If you are unsure whether a plugin needs it, check the browser developer console (F12). A plugin that received empty data logs `[RisuAI Plugin: name] getDatabase() returns an empty pluginCustomStorage on PocketRisu`.


## 3. For plugin authors

A V3 plugin has two ways to read a stored value of another plugin (or its own).

### Option A. `pluginStorage.getItem(key)` (recommended)

```js
const value = await risuai.pluginStorage.getItem('other-plugin-key')
```

Reads just that one key from the server. Cheapest by far, and the cost stays flat no matter how large the store grows. The key space is shared across plugins, so pass the key name the other plugin used.

### Option B. The user option

If the code cannot be changed, the user can enable the option from section 2 and `getDatabase()` returns the full values. Since this requires instructing users, option A is preferred.

`getDatabase(['pluginCustomStorage'])` does **not** fill the field on its own. Naming the key in `includeOnly` is common in plugins that never use the values (Plugin Manager, for one), so it cannot be treated as a request for the whole store; only the user option turns it on.

### Writing

`setDatabase({ pluginCustomStorage: {...} })` **merges** the keys you pass. Missing keys are not deleted, so reading a subset and writing it back never wipes other plugins' data. Use `pluginStorage.removeItem(key)` to delete.


## 4. Cost and caveats

Plugin storage is not partitioned per plugin. "Provide all plugin data" therefore does not hand over one plugin's slice; it fetches **every installed plugin's stored values** from the server and copies them into the plugin's execution environment.

- With long-term-memory plugins the store can reach hundreds of MB.
- V3 plugins run in an isolated environment, so the result of `getDatabase()` is copied on every call. Enabling the option for a plugin that calls `getDatabase()` per message copies hundreds of MB per message.
- The option shows a warning when the store exceeds 100 MB.

If the app becomes slow or unresponsive, disable the option for that plugin and ask its author for an option A implementation.


## 5. Backups and compatibility

- Full `.bin` backups reassemble plugin data on export, so they open in upstream RisuAI and older PocketRisu versions. Settings-only exports leave the field empty.
- The "Provide all plugin data" setting is stored on the plugin entry and ignored by upstream RisuAI.
- PocketRisu v1.10.x and older cannot read plugin data from the server store. Before downgrading, restore the pre-update snapshot from Settings > DB backup list.


## 6. Browser-local plugin storage

`risuai.getLocalPluginStorage()` is separate from `risuai.pluginStorage` above. It uses upstream RisuAI's localForage database `plugin`, store `plugin`, and key prefix `safe_plugin_`. With the IndexedDB driver, values such as Blob and ArrayBuffer retain their native types. Values and ownership metadata live in the accessing browser's origin.

On first use, existing PocketRisu server values are copied once. Existing browser values are preserved, and server originals are never deleted. After copying succeeds, reads, writes, deletions, and clears use browser storage exclusively; later server changes are not reimported. A failed copy remains incomplete and is retried on the next call.

These values are not shared across devices, browsers, or origins, and are excluded from `.bin` backups. The storage API's `clear()` retains the migration marker, preventing deleted values from being reimported. Clearing all browser site data also clears this marker, making the next access a first use again. Binary contents previously lost through JSON serialization cannot be recovered by copying.

Safe first-use copying requires IndexedDB or Web Locks. If neither is available and values still need importing, migration reports an error without changing existing data. A `saveAsset()` path stored only in the browser is invisible to server asset cleanup; store the Blob itself for local audio or image retention.

← [Back to README](../../README.md)
