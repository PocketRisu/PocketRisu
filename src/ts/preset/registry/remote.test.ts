import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable test doubles created before vi.mock factories run.
const { mockDb, state } = vi.hoisted(() => ({
    mockDb: { db: {} as any },
    state: { responders: {} as Record<string, () => unknown>, fetchCount: 0 },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(async (url: string) => {
        state.fetchCount++
        const key = url.split('?')[0] // ignore the ?h=<hash> cache-bust query
        const responder = state.responders[key]
        if (!responder) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => responder() }
    }),
}))

vi.mock('src/ts/stores.svelte', () => ({ DBState: mockDb }))

import { getOfficialRegistry, isEntryCorrupted, isRefetchGuarded, syncRemoteRegistry } from './remote'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const BASE = 'https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/'

// Wire up index.json + catalog.json responders for a given base + hash.
function setup(
    base: string,
    hash: string,
    opts: { schemaVersion?: number; catalogHash?: string; profiles?: Record<string, any> } = {},
) {
    const profiles = opts.profiles ?? {
        'openai:gpt': { id: 'openai:gpt', providerBaseId: 'openai', displayName: 'GPT', updatedAt: 1 },
    }
    state.responders[base + 'index.json'] = () => ({ schemaVersion: opts.schemaVersion ?? 4, hash })
    state.responders[base + 'catalog.json'] = () => ({
        schemaVersion: 4,
        hash: opts.catalogHash ?? hash,
        baseProviders: { openai: { id: 'openai', adapterKind: 'openaiCompatible' } },
        profiles,
        baseProviderHashes: { openai: 'bh' },
        profileHashes: Object.fromEntries(Object.keys(profiles).map((id) => [id, `ph:${id}`])),
    })
}

function officialEntry() {
    return mockDb.db.modelProfileRegistryCache?.registries?.[getBundledRegistryId()]
}

beforeEach(() => {
    mockDb.db = {}
    state.responders = {}
    state.fetchCount = 0
})

describe('syncRemoteRegistry', () => {
    it('downloads the catalog on first sync and stores hash + source', async () => {
        setup(BASE, 'h1')
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.changed).toBe(true)
        expect(res.downloaded).toBe(true)
        const entry = officialEntry()
        expect(entry?.contentHash).toBe('h1')
        expect(entry?.source).toBe(BASE)
        expect(entry?.profiles?.['openai:gpt']).toBeTruthy()
        expect(entry?.profileHashes?.['openai:gpt']).toBe('ph:openai:gpt')
    })

    it('skips the catalog download when hash + source are unchanged', async () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: { [getBundledRegistryId()]: { fetchedAt: 1, source: BASE, contentHash: 'h1', profiles: { 'openai:gpt': { id: 'openai:gpt' } } } },
        }
        setup(BASE, 'h1')
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.changed).toBe(false)
        expect(res.downloaded).toBe(false)
        expect(state.fetchCount).toBe(1) // only index.json
    })

    it('re-downloads when the hash changed', async () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: { [getBundledRegistryId()]: { fetchedAt: 1, source: BASE, contentHash: 'h1', profiles: { 'sentinel': { id: 'sentinel' } } } },
        }
        setup(BASE, 'h2')
        const res = await syncRemoteRegistry()
        expect(res.changed).toBe(true)
        expect(res.downloaded).toBe(true)
        expect(officialEntry()?.contentHash).toBe('h2')
        expect(officialEntry()?.profiles?.['openai:gpt']).toBeTruthy()
        expect(officialEntry()?.profiles?.['sentinel']).toBeUndefined()
    })

    it('re-downloads + resets the seen baseline when the source changes (even if hash matches)', async () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: { [getBundledRegistryId()]: { fetchedAt: 1, source: BASE, contentHash: 'h1', profiles: { 'sentinel': { id: 'sentinel' } } } },
        }
        mockDb.db.modelRegistrySeen = { 'sentinel': 1 }
        const CUSTOM = 'https://example.com/fork/develop/'
        mockDb.db.useCustomModelRegistry = true
        mockDb.db.modelProfileRegistryBaseUrl = CUSTOM
        setup(CUSTOM, 'h1') // same hash value, different source
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.downloaded).toBe(true)
        expect(officialEntry()?.source).toBe(CUSTOM)
        expect(officialEntry()?.profiles?.['openai:gpt']).toBeTruthy()
        expect(mockDb.db.modelRegistrySeen).toBeUndefined()
    })

    it('re-downloads a null-corrupted cache even when hash + source are unchanged', async () => {
        // Old normalizeJSON bug: a base provider's requestSchema holds [null].
        // Hash still matches the published catalog, so the gate would normally
        // skip — but corruption must force a re-fetch of the clean data.
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: {
                [getBundledRegistryId()]: {
                    fetchedAt: 1, source: BASE, contentHash: 'h1',
                    profiles: { 'sentinel': { id: 'sentinel' } },
                    baseProviders: { openai: { id: 'openai', requestSchema: [null] } },
                },
            },
        }
        setup(BASE, 'h1') // same hash + same source as the cache
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.downloaded).toBe(true)
        expect(state.fetchCount).toBe(2) // index.json + catalog.json
        // Replaced by the freshly fetched (clean) catalog.
        expect(officialEntry()?.profiles?.['openai:gpt']).toBeTruthy()
        expect(officialEntry()?.profiles?.['sentinel']).toBeUndefined()
        expect(isEntryCorrupted(officialEntry())).toBe(false)
    })

    it('keeps the old cache on an index/catalog hash mismatch (CDN race)', async () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: { [getBundledRegistryId()]: { fetchedAt: 1, source: BASE, contentHash: 'h1', profiles: { 'sentinel': { id: 'sentinel' } } } },
        }
        setup(BASE, 'h2', { catalogHash: 'h1' }) // index says h2, catalog still h1
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/mismatch/)
        // unchanged
        expect(officialEntry()?.contentHash).toBe('h1')
        expect(officialEntry()?.profiles?.['sentinel']).toBeTruthy()
    })

    it('rejects a malformed catalog without throwing', async () => {
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, hash: 'h9' })
        state.responders[BASE + 'catalog.json'] = () => ({ schemaVersion: 4, hash: 'h9', profiles: 'nope' })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/malformed/)
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()
    })

    it('rejects a non-https custom URL up front (no fetch, no silent fallback)', async () => {
        mockDb.db.useCustomModelRegistry = true
        mockDb.db.modelProfileRegistryBaseUrl = 'http://insecure.example.com/'
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/https/)
        expect(state.fetchCount).toBe(0)
    })

    it('fetches from an https custom base when opted in', async () => {
        const CUSTOM = 'https://example.com/fork/main/'
        mockDb.db.useCustomModelRegistry = true
        mockDb.db.modelProfileRegistryBaseUrl = CUSTOM
        setup(CUSTOM, 'hc')
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(officialEntry()?.source).toBe(CUSTOM)
        expect(officialEntry()?.profiles?.['openai:gpt']).toBeTruthy()
    })

    it('debounces a recent fetch', async () => {
        mockDb.db.modelProfileRegistryLastFetched = Date.now()
        setup(BASE, 'h1')
        const res = await syncRemoteRegistry()
        expect(res.downloaded).toBe(false)
        expect(state.fetchCount).toBe(0)
    })

    it('reports failure without throwing on a bad index schema', async () => {
        setup(BASE, 'h1', { schemaVersion: 9 })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()
    })

    it('rejects an old-format index that has no content hash', async () => {
        // schemaVersion 4 but no top-level `hash` (pre-catalog index).
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, contentVersion: 14, updatedAt: 123 })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/content hash|old format/)
        expect(state.fetchCount).toBe(1) // index only — no catalog fetch
    })

    it('reports failure (never throws) when the index fetch fails', async () => {
        // no responders → index.json 404 → fetchJson throws → caught
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/index fetch failed/)
    })

    it('rejects an empty custom URL (no silent official fallback)', async () => {
        mockDb.db.useCustomModelRegistry = true
        mockDb.db.modelProfileRegistryBaseUrl = '   '
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/empty/)
        expect(state.fetchCount).toBe(0)
    })

    it('rejects a catalog whose profiles is an array (not a plain object)', async () => {
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, hash: 'h' })
        state.responders[BASE + 'catalog.json'] = () => ({ schemaVersion: 4, hash: 'h', baseProviders: {}, profiles: [] })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/malformed/)
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()
    })

    it('rejects a profile whose base provider is missing from the catalog', async () => {
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, hash: 'h' })
        state.responders[BASE + 'catalog.json'] = () => ({
            schemaVersion: 4, hash: 'h',
            baseProviders: {},
            profiles: { 'openai:gpt': { id: 'openai:gpt', providerBaseId: 'openai' } },
        })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/base provider/)
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()
    })

    it('rejects a profile whose id does not match its key', async () => {
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, hash: 'h' })
        state.responders[BASE + 'catalog.json'] = () => ({
            schemaVersion: 4, hash: 'h',
            baseProviders: { openai: { id: 'openai' } },
            profiles: { 'openai:gpt': { id: 'WRONG', providerBaseId: 'openai' } },
        })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/malformed catalog profile/)
    })

    it('a debounced concurrent call does not cancel an in-flight download', async () => {
        // A's catalog download is parked on a manual gate; B is called while A is
        // mid-download and returns via the debounce — it must not bump the token
        // and cancel A's write.
        let release: () => void = () => {}
        const gate = new Promise<void>((r) => { release = r })
        state.responders[BASE + 'index.json'] = () => ({ schemaVersion: 4, hash: 'h1' })
        state.responders[BASE + 'catalog.json'] = async () => {
            await gate
            return {
                schemaVersion: 4, hash: 'h1',
                baseProviders: { openai: { id: 'openai', adapterKind: 'openaiCompatible' } },
                profiles: { 'openai:gpt': { id: 'openai:gpt', providerBaseId: 'openai', displayName: 'GPT', updatedAt: 1 } },
                profileHashes: {}, baseProviderHashes: {},
            }
        }
        const pA = syncRemoteRegistry() // parks at the catalog download
        await new Promise((r) => setTimeout(r, 0)) // let A set lastFetched + reach the gate
        const resB = await syncRemoteRegistry() // debounced — returns immediately
        expect(resB.downloaded).toBe(false)
        release()
        const resA = await pA
        expect(resA.ok).toBe(true)
        expect(resA.downloaded).toBe(true) // A's write was NOT cancelled by B
        expect(officialEntry()?.contentHash).toBe('h1')
    })
})

describe('isRefetchGuarded', () => {
    it('is false when never fetched', () => {
        expect(isRefetchGuarded(undefined)).toBe(false)
    })
    it('is true within the guard window, false outside', () => {
        expect(isRefetchGuarded(Date.now() - 1000)).toBe(true)
        expect(isRefetchGuarded(Date.now() - 60_000)).toBe(false)
    })
})

describe('isEntryCorrupted', () => {
    const entry = (baseProviders: Record<string, any>) => ({ fetchedAt: 1, baseProviders } as any)

    it('flags a base provider whose requestSchema contains a null element', () => {
        expect(isEntryCorrupted(entry({ openai: { id: 'openai', requestSchema: [{ key: 'apiKey' }, null] } }))).toBe(true)
    })

    it('returns false for all-clean base providers', () => {
        expect(isEntryCorrupted(entry({
            openai: { id: 'openai', requestSchema: [{ key: 'apiKey' }], uiSchema: { fields: [{ key: 'apiKey' }], groups: [] } },
            claude: { id: 'claude', requestSchema: [], uiSchema: { fields: [], groups: [] } },
        }))).toBe(false)
    })

    it('flags a null element inside uiSchema.fields', () => {
        expect(isEntryCorrupted(entry({
            openai: { id: 'openai', requestSchema: [{ key: 'apiKey' }], uiSchema: { fields: [null], groups: [] } },
        }))).toBe(true)
    })

    it('ignores a missing/non-array requestSchema (no false positive)', () => {
        expect(isEntryCorrupted(entry({ openai: { id: 'openai' } }))).toBe(false)
        expect(isEntryCorrupted(undefined)).toBe(false)
        expect(isEntryCorrupted({ fetchedAt: 1 } as any)).toBe(false)
    })

    it('flags a null element inside a PROFILE schema (the common shared-ref case)', () => {
        // A field object shared between a base provider and a profile is nulled in
        // whichever serializes second (profiles) — so base may look clean while the
        // profile is corrupt. The detector must scan profiles too.
        expect(isEntryCorrupted({
            fetchedAt: 1,
            baseProviders: { openai: { id: 'openai', requestSchema: [{ key: 'apiKey' }] } },
            profiles: { 'openai:gpt': { id: 'openai:gpt', schema: [{ key: 'modelId' }, null] } },
        } as any)).toBe(true)
    })

    it('flags a null element inside a profile uiSchema.fields', () => {
        expect(isEntryCorrupted({
            fetchedAt: 1,
            profiles: { 'openai:gpt': { id: 'openai:gpt', schema: [{ key: 'modelId' }], uiSchema: { fields: [null], groups: [] } } },
        } as any)).toBe(true)
    })
})

describe('getOfficialRegistry', () => {
    it('falls back to the bundled registry when no remote cache', () => {
        const reg = getOfficialRegistry()
        const profiles = reg.registries[getBundledRegistryId()]?.profiles ?? {}
        expect(Object.keys(profiles).length).toBe(
            Object.keys(loadBundledRegistry().registries[getBundledRegistryId()]?.profiles ?? {}).length,
        )
    })

    it('returns the remote entry (scoped) when present', () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: {
                [getBundledRegistryId()]: { fetchedAt: 1, contentHash: 'h1', profiles: { 'openai:gpt': { id: 'openai:gpt' } }, baseProviders: {} },
                custom: { fetchedAt: 0, profiles: { 'custom::x': { id: 'custom::x' } } },
            },
        }
        const reg = getOfficialRegistry()
        expect(Object.keys(reg.registries)).toEqual([getBundledRegistryId()])
        expect(reg.registries[getBundledRegistryId()]?.profiles?.['openai:gpt']).toBeTruthy()
    })
})
