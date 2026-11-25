// Best-effort "origin plugin" tagging for plugin storage.
//
// Plugin data lives in a single global namespace with no record of which
// plugin wrote which key. We cannot reconstruct ownership for existing data,
// but for NEW writes the V3 API does know the calling plugin. This module
// stores that origin as a SIDECAR — a separate map keyed by storage key —
// alongside the value, never wrapping the value itself. Reads of the actual
// value are untouched, so existing plugins keep working.
//
// The sidecar must live in the SAME backend as the data it describes, so its
// lifecycle/travel matches (save → travels with the save file; local/idb →
// device-local). Hence one store per backend:
//   - save  → db.pluginStorageMeta (persisted in the save's ROOT block)
//   - local → a single localStorage JSON blob (not safe_plugin_* prefixed, so
//             it never shows up in the viewer's local listing)
//   - idb   → persistentKv under a dedicated prefix (separate from the data
//             prefix, so it never shows up in the viewer's idb listing)

import { getDatabase } from "../storage/database.svelte";
import {
    listPersistentKeys,
    makeEncodedStorageKey,
    decodeStorageKeyComponent,
    readPersistentJson,
    writePersistentJson,
    removePersistentKey,
    clearPersistentPrefix,
} from "../storage/persistentKv";

export type PluginStorageBackend = "save" | "local" | "idb";
export interface PluginOwnerRecord {
    plugin: string;
    updatedAt: number;
}

const LOCAL_META_KEY = "risu_plugin_storage_owners";
const IDB_META_PREFIX = "cache/plugin-storage-meta/";

// ── local backend blob helpers ──────────────────────────────────────────────
function readLocalMeta(): Record<string, PluginOwnerRecord> {
    try {
        return JSON.parse(localStorage.getItem(LOCAL_META_KEY) || "{}");
    } catch {
        return {};
    }
}

function writeLocalMeta(map: Record<string, PluginOwnerRecord>): void {
    try {
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(map));
    } catch {}
}

// ── write side (called from V3 storage wrappers) ────────────────────────────
// Only an owner change is written. updatedAt is never read, and rewriting it
// on every plugin write changed the root key pluginStorageMeta each time, so
// every save carried it (and the whole local map was rewritten).
export function recordOwner(backend: PluginStorageBackend, key: string, plugin: string): void | Promise<void> {
    if (!plugin) return;
    const record: PluginOwnerRecord = { plugin, updatedAt: Date.now() };
    if (backend === "save") {
        const db = getDatabase();
        if (db.pluginStorageMeta?.[key]?.plugin === plugin) return;
        db.pluginStorageMeta ??= {};
        db.pluginStorageMeta[key] = record;
        return;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        if (map[key]?.plugin === plugin) return;
        map[key] = record;
        writeLocalMeta(map);
        return;
    }
    return writePersistentJson(makeEncodedStorageKey(IDB_META_PREFIX, key), record);
}

export function removeOwner(backend: PluginStorageBackend, key: string): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
        return;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        delete map[key];
        writeLocalMeta(map);
        return;
    }
    return removePersistentKey(makeEncodedStorageKey(IDB_META_PREFIX, key));
}

export function clearOwners(backend: PluginStorageBackend): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        db.pluginStorageMeta = {};
        return;
    }
    if (backend === "local") {
        writeLocalMeta({});
        return;
    }
    return clearPersistentPrefix(IDB_META_PREFIX);
}

// ── read side (called from the viewer) ──────────────────────────────────────
// Returns a { storageKey → plugin name } map for the given backend.
export async function getOwners(backend: PluginStorageBackend): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (backend === "save") {
        const meta = getDatabase({ snapshot: true }).pluginStorageMeta ?? {};
        for (const key of Object.keys(meta)) {
            if (meta[key]?.plugin) out[key] = meta[key].plugin;
        }
        return out;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        for (const key of Object.keys(map)) {
            if (map[key]?.plugin) out[key] = map[key].plugin;
        }
        return out;
    }
    const storageKeys = await listPersistentKeys(IDB_META_PREFIX);
    for (const fullKey of storageKeys) {
        const encoded = fullKey.slice(IDB_META_PREFIX.length, -".json".length);
        const rawKey = decodeStorageKeyComponent(encoded);
        const record = await readPersistentJson<PluginOwnerRecord>(fullKey);
        if (record?.plugin) out[rawKey] = record.plugin;
    }
    return out;
}
