// Runtime registry fetch — pulls the combined catalog from GitHub and overlays
// it on the build-time bundled snapshot.
//
// Flow:
//  1. Fetch index.json (tiny: { schemaVersion, hash }) on every menu entry.
//  2. If its hash differs from the cached entry's contentHash (or the source
//     URL changed, or forced), download catalog.json — the whole registry in
//     one file (no per-file fan-out).
//  3. Verify catalog.hash === index.hash (guards a CDN serving a stale half of
//     the pair), then atomically swap the cache entry
//     { source, contentHash, hash maps, baseProviders, profiles }.
//
// The gate is a content hash — "different ⇒ adopt the published version". Any
// failure leaves the cache/bundle untouched and never throws to the UI.

import { DBState } from 'src/ts/stores.svelte'
import { fetchNative } from 'src/ts/globalApi.svelte'
import type { BaseProviderDefinition, ModelPreset, ModelProfile, RegistryCache } from '../types'
import { getProfileUpdateStatus, type ProfileUpdateStatus } from '../customProfiles'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const OFFICIAL_BASE = 'https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/'
// Skip a re-fetch if one ran this recently (menu re-entry debounce).
const REFETCH_GUARD_MS = 5_000

type RegistryEntry = RegistryCache['registries'][string]

interface RegistryIndexFile {
    schemaVersion: number
    hash: string
}

interface CatalogFile {
    schemaVersion: number
    hash: string
    baseProviders: Record<string, BaseProviderDefinition>
    profiles: Record<string, ModelProfile>
    baseProviderHashes?: Record<string, string>
    profileHashes?: Record<string, string>
}

// Monotonic token so a slow sync can't clobber a newer one's result.
let syncToken = 0

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetchNative(url, { method: 'GET' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
}

// https-only custom base (dev branch / fork), else official. Trailing slash so
// `base + 'index.json'` resolves.
function getRegistryBase(): string {
    const db = DBState.db
    const custom = db.useCustomModelRegistry ? db.modelProfileRegistryBaseUrl?.trim() : undefined
    if (custom && /^https:\/\//i.test(custom)) return custom.endsWith('/') ? custom : custom + '/'
    return OFFICIAL_BASE
}

// Non-empty when the custom registry is enabled but its URL is empty or not
// https. We fail loudly rather than silently using the official URL.
function customUrlError(): string | undefined {
    const db = DBState.db
    if (!db.useCustomModelRegistry) return undefined
    const raw = db.modelProfileRegistryBaseUrl?.trim()
    if (!raw) return 'custom registry URL is empty'
    if (!/^https:\/\//i.test(raw)) return 'custom registry URL must use https://'
    return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Reject a catalog that would crash snapshot resolution: every profile must be
// a plain object whose id matches its key and whose providerBaseId resolves to
// a base provider present in the catalog. All-or-nothing — a single bad entry
// rejects the whole download (we never store a half-valid catalog).
function validateCatalogShape(catalog: CatalogFile): string | undefined {
    if (catalog.schemaVersion !== 4) return `unsupported catalog schemaVersion ${catalog.schemaVersion}`
    if (!isPlainObject(catalog.profiles) || !isPlainObject(catalog.baseProviders)) return 'malformed catalog'
    if (Object.keys(catalog.profiles).length === 0) return 'empty catalog'
    for (const [id, profile] of Object.entries(catalog.profiles)) {
        if (!isPlainObject(profile) || (profile as { id?: unknown }).id !== id) return `malformed catalog profile "${id}"`
        const baseId = (profile as { providerBaseId?: unknown }).providerBaseId
        if (typeof baseId !== 'string') return `catalog profile "${id}": missing providerBaseId`
        if (!isPlainObject(catalog.baseProviders[baseId])) return `catalog profile "${id}": base provider "${baseId}" missing`
    }
    for (const [id, base] of Object.entries(catalog.baseProviders)) {
        if (!isPlainObject(base) || (base as { id?: unknown }).id !== id) return `malformed catalog base provider "${id}"`
    }
    return undefined
}

export function isRefetchGuarded(lastFetched: number | undefined): boolean {
    return lastFetched !== undefined && Date.now() - lastFetched < REFETCH_GUARD_MS
}

// A null element inside an array means nothing legitimately — only the old
// normalizeJSON bug produced it. Treat any null/undefined element in a present
// array as the unambiguous corruption signature.
function hasNullElement(value: unknown): boolean {
    return Array.isArray(value) && value.some((el) => el === null || el === undefined)
}

// True when a base provider OR profile in the cached entry carries a null-corrupted
// array (requestSchema/schema, or uiSchema.fields/groups) — the signature of the
// now-fixed normalizeJSON bug. Such a cache must be re-downloaded even when its
// hash still matches the published catalog, since the corruption is local. The
// profile side matters most: a field object shared between a base provider and a
// profile gets nulled in whichever is serialized SECOND (profiles), so scanning
// only baseProviders would miss the common case.
function hasCorruptSchemaArrays(holder: { requestSchema?: unknown; schema?: unknown; uiSchema?: unknown }): boolean {
    if (hasNullElement(holder.requestSchema)) return true
    if (hasNullElement(holder.schema)) return true
    const uiSchema = holder.uiSchema
    if (isPlainObject(uiSchema)) {
        if (hasNullElement(uiSchema.fields)) return true
        if (hasNullElement(uiSchema.groups)) return true
    }
    return false
}

export function isEntryCorrupted(entry: RegistryEntry | undefined): boolean {
    for (const collection of [entry?.baseProviders, entry?.profiles]) {
        if (!isPlainObject(collection)) continue
        for (const item of Object.values(collection)) {
            if (isPlainObject(item) && hasCorruptSchemaArrays(item)) return true
        }
    }
    return false
}

export interface SyncResult {
    ok: boolean
    /** True when the catalog content hash changed (a new catalog was adopted). */
    changed: boolean
    /** True when the catalog was actually downloaded (vs a hash/debounce skip). */
    downloaded?: boolean
    error?: string
}

function entryFromCatalog(base: string, catalog: CatalogFile): RegistryEntry {
    return {
        fetchedAt: Date.now(),
        source: base,
        contentHash: catalog.hash,
        profileHashes: catalog.profileHashes,
        baseProviderHashes: catalog.baseProviderHashes,
        baseProviders: catalog.baseProviders,
        profiles: catalog.profiles,
    }
}

// Fetch the index gate, and download the combined catalog only when its hash
// differs from the cached entry (or the source changed, or forced). Persists
// atomically into the DB cache. Never throws.
export async function syncRemoteRegistry(force = false): Promise<SyncResult> {
    const db = DBState.db
    try {
        const urlError = customUrlError()
        if (urlError) return { ok: false, changed: false, downloaded: false, error: urlError }

        if (!force && isRefetchGuarded(db.modelProfileRegistryLastFetched)) {
            return { ok: true, changed: false, downloaded: false }
        }

        const base = getRegistryBase()
        let index: RegistryIndexFile
        try {
            index = await fetchJson<RegistryIndexFile>(base + 'index.json')
        } catch (e) {
            return { ok: false, changed: false, downloaded: false, error: `index fetch failed: ${(e as Error).message}` }
        }
        db.modelProfileRegistryLastFetched = Date.now()
        if (index.schemaVersion !== 4) {
            return { ok: false, changed: false, downloaded: false, error: `unsupported index schemaVersion ${index.schemaVersion}` }
        }
        if (typeof index.hash !== 'string') {
            return { ok: false, changed: false, downloaded: false, error: 'index has no content hash (registry may be an old format — rebuild with scripts/build.mjs)' }
        }

        // Gate-skip: same source + same content hash + a populated cache. Source
        // and hash live together in the entry, so they can't drift apart. A
        // null-corrupted entry (old normalizeJSON bug) is never skipped — its
        // hash still matches the catalog, so we must fall through to re-download
        // the clean data and replace it.
        const cached = db.modelProfileRegistryCache?.registries?.[getBundledRegistryId()]
        const cacheUsable = !!cached?.profiles && Object.keys(cached.profiles).length > 0
        if (!force && cacheUsable && cached?.source === base && cached?.contentHash === index.hash && !isEntryCorrupted(cached)) {
            return { ok: true, changed: false, downloaded: false }
        }

        // We've decided to download — claim the latest token now (not at entry,
        // so a debounced/skipped concurrent call can't cancel this download).
        const token = ++syncToken

        // Download the whole catalog (one request). Cache-bust by the expected
        // hash so a CDN edge can't keep handing back a stale copy.
        let catalog: CatalogFile
        try {
            catalog = await fetchJson<CatalogFile>(`${base}catalog.json?h=${encodeURIComponent(index.hash)}`)
        } catch (e) {
            return { ok: false, changed: false, downloaded: false, error: `catalog fetch failed: ${(e as Error).message}` }
        }
        const shapeError = validateCatalogShape(catalog)
        if (shapeError) {
            return { ok: false, changed: false, downloaded: false, error: shapeError }
        }
        // index and catalog can be served from different CDN edges mid-propagation.
        // Adopt only a matching pair; otherwise keep the old cache and retry next time.
        if (catalog.hash !== index.hash) {
            return { ok: false, changed: false, downloaded: false, error: 'index/catalog hash mismatch (CDN propagating) — retry' }
        }

        // A newer sync started while we were downloading — discard this result.
        if (token !== syncToken) {
            return { ok: true, changed: false, downloaded: false }
        }

        const prevHash = cached?.contentHash
        const sourceChanged = cached?.source !== undefined && cached.source !== base

        // Atomic swap: source + hash + data move together. Assign a brand-new
        // object so the async write triggers Svelte reactivity. Preserve 'custom'.
        db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: {
                ...(db.modelProfileRegistryCache?.registries ?? {}),
                [getBundledRegistryId()]: entryFromCatalog(base, catalog),
            },
        }

        // A source switch invalidates the notice baseline (seen-map keys the
        // previous source's catalog) — drop it so it reseeds against the new one.
        if (sourceChanged) db.modelRegistrySeen = undefined

        return { ok: true, changed: prevHash !== catalog.hash, downloaded: true }
    } catch (e) {
        // Honour the "never throws" contract — keep the bundled/cached fallback.
        return { ok: false, changed: false, downloaded: false, error: `sync failed: ${(e as Error).message}` }
    }
}

// The official registry to read from: remote cache if present, else bundled.
// Scoped to just the official entry so custom profiles never leak in.
export function getOfficialRegistry(): RegistryCache {
    const remote = DBState.db.modelProfileRegistryCache?.registries?.[getBundledRegistryId()]
    if (remote?.profiles && Object.keys(remote.profiles).length > 0) {
        return { schemaVersion: 4, registries: { [getBundledRegistryId()]: remote } }
    }
    return loadBundledRegistry()
}

// Per-preset update status against its source registry (official=remote-or-bundled,
// else the custom cache). Unchanged: still compares the snapshot's
// profileUpdatedAt against the current profile's updatedAt.
export function getPresetUpdateStatus(preset: ModelPreset): ProfileUpdateStatus {
    const sp = preset.sourceProfile
    if (!sp?.registryId) return 'none'
    const cache = sp.registryId === getBundledRegistryId()
        ? getOfficialRegistry()
        : DBState.db.modelProfileRegistryCache
    const current = cache?.registries?.[sp.registryId]?.profiles?.[sp.profileId]
    return getProfileUpdateStatus(current, sp.profileUpdatedAt)
}
