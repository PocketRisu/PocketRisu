import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise: Promise<void> | null = null;

async function ensureStorageReady() {
    if (!initPromise) {
        initPromise = forageStorage.Init();
    }
    await initPromise;
}

function encodeKeyComponent(value: string) {
    return Buffer.from(value, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeKeyComponent(value: string) {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
}

export async function readPersistentJson<T>(storageKey: string): Promise<T | null> {
    await ensureStorageReady();
    const data = await forageStorage.getItem(storageKey);
    if (!data) {
        return null;
    }
    return JSON.parse(decoder.decode(data)) as T;
}

export async function readPersistentBytes(storageKey: string): Promise<Uint8Array | null> {
    await ensureStorageReady();
    return await forageStorage.getItem(storageKey);
}

// Many keys in one round trip per chunk (bulk read); absent keys are left out
// of the result. A remote link pays one request instead of one per key.
export async function readPersistentJsonMany<T>(storageKeys: string[]): Promise<Map<string, T>> {
    await ensureStorageReady();
    const out = new Map<string, T>();
    const CHUNK = 500;
    for (let i = 0; i < storageKeys.length; i += CHUNK) {
        const rows = await forageStorage.getItems(storageKeys.slice(i, i + CHUNK));
        for (const row of rows) {
            if (!row?.value) continue;
            try {
                out.set(row.key, JSON.parse(decoder.decode(row.value)) as T);
            } catch {
                // unreadable entry: treat as absent, like a cache miss
            }
        }
    }
    return out;
}

export async function writePersistentJson<T>(storageKey: string, value: T): Promise<void> {
    await ensureStorageReady();
    await forageStorage.setItem(storageKey, encoder.encode(JSON.stringify(value)));
}

export async function removePersistentKey(storageKey: string): Promise<void> {
    await ensureStorageReady();
    await forageStorage.removeItem(storageKey);
}

export async function listPersistentKeys(prefix = ""): Promise<string[]> {
    await ensureStorageReady();
    return await forageStorage.keys(prefix);
}

export async function clearPersistentPrefix(prefix: string): Promise<void> {
    const keys = await listPersistentKeys(prefix);
    await Promise.all(keys.map((key) => removePersistentKey(key)));
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}

export function decodeStorageKeyComponent(encodedKey: string): string {
    return decodeKeyComponent(encodedKey);
}

// Shared with the server's plugin-storage kv key scheme (no `.json` suffix).
export function encodeStorageKeyComponent(rawKey: string): string {
    return encodeKeyComponent(rawKey);
}
