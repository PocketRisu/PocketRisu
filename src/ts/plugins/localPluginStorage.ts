import localforage from "localforage";
import { decodeStorageKeyComponent, listPersistentKeys, readPersistentBytes } from "../storage/persistentKv";

// Match upstream RisuAI's database, object store, and driver selection exactly.
export const localPluginStorage = localforage.createInstance({
    name: 'plugin',
    storeName: 'plugin',
});

// Unprefixed internal records are excluded by upstream's safe_plugin_* filter.
export const pluginOwnerPrefix = '__pocketrisu_owner__/';
const migrationKey = '__pocketrisu_server_migrated_v1__';
let migration: Promise<void> | undefined;

async function readLegacyEntries(prefix: string, destinationPrefix: string): Promise<[string, unknown][]> {
    const entries: [string, unknown][] = [];
    for (const key of await listPersistentKeys(prefix)) {
        const bytes = await readPersistentBytes(key);
        // A server key can disappear between listing and reading. Stored JSON
        // null still has bytes and must be copied as an existing key.
        if (bytes === null) continue;
        const encoded = key.slice(prefix.length, -'.json'.length);
        entries.push([destinationPrefix + decodeStorageKeyComponent(encoded), JSON.parse(new TextDecoder().decode(bytes))]);
    }
    return entries;
}

// Copy and mark completion in one IndexedDB transaction. Two tabs may fetch
// legacy data concurrently, but only the first transaction imports it. add()
// preserves existing values, including keys whose stored value is null.
async function importIndexedDb(entries: [string, unknown][], owners: Map<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open(localPluginStorage.config('name'));
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const db = opening.result;
            let failure: unknown;
            let transaction: IDBTransaction;
            try { transaction = db.transaction(localPluginStorage.config('storeName'), 'readwrite'); }
            catch (error) { db.close(); reject(error); return; }
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onabort = () => { db.close(); reject(failure ?? transaction.error); };
            const store = transaction.objectStore(localPluginStorage.config('storeName'));
            const marker = store.get(migrationKey);
            marker.onsuccess = () => {
                if (marker.result === true) return;
                try {
                    const addIfMissing = (key: string, value: unknown) => {
                        const add = store.add(value, key);
                        add.onerror = (event) => {
                            if (add.error?.name === 'ConstraintError') event.preventDefault();
                        };
                        return add;
                    };
                    for (const [key, value] of entries) {
                        const add = addIfMissing(key, value);
                        add.onsuccess = () => {
                            const rawKey = key.slice('safe_plugin_'.length);
                            // A conflicting browser value keeps its own origin,
                            // including an unknown origin. Import owners only
                            // for values this transaction actually inserted.
                            if (owners.has(rawKey)) addIfMissing(pluginOwnerPrefix + rawKey, owners.get(rawKey));
                        };
                    }
                    store.put(true, migrationKey);
                } catch (error) { failure = error; transaction.abort(); }
            };
        };
    });
}

async function migrate(): Promise<void> {
    if (await localPluginStorage.getItem(migrationKey) === true) return;
    const entries = await readLegacyEntries('cache/plugin-storage/', 'safe_plugin_');
    const owners = new Map(await readLegacyEntries('cache/plugin-storage-meta/', ''));
    if (localPluginStorage.driver() === localforage.INDEXEDDB) {
        await importIndexedDb(entries, owners);
    } else {
        // Keep upstream's fallback drivers for browsers without IndexedDB.
        if (await localPluginStorage.getItem(migrationKey) === true) return;
        const existing = new Set(await localPluginStorage.keys());
        if (entries.some(([key]) => !existing.has(key))
            && !(typeof navigator !== 'undefined' && navigator.locks)) {
            // These drivers have no atomic add/merge. Without a cross-tab lock,
            // importing could overwrite newer data or resurrect a cleared key.
            throw new Error('Legacy plugin storage migration requires IndexedDB or Web Locks');
        }
        for (const [key, value] of entries) {
            if (existing.has(key)) continue;
            await localPluginStorage.setItem(key, value);
            const rawKey = key.slice('safe_plugin_'.length);
            if (owners.has(rawKey) && !existing.has(pluginOwnerPrefix + rawKey)) {
                await localPluginStorage.setItem(pluginOwnerPrefix + rawKey, owners.get(rawKey));
            }
        }
        await localPluginStorage.setItem(migrationKey, true);
    }
}

export function ensureLocalPluginStorageMigrated(): Promise<void> {
    if (!migration) {
        const run = () => migrate();
        // Also serialize migration in fallback drivers when Web Locks exist.
        const copying = (async () => {
            if (typeof navigator !== 'undefined' && navigator.locks) {
                await navigator.locks.request('pocketrisu-local-plugin-storage-migration', run);
            } else await run();
        })();
        migration = copying.catch((error) => {
            migration = undefined;
            throw error;
        });
    }
    return migration;
}
