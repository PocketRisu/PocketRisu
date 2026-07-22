import { describe, expect, it } from 'vitest'
import {
    DEFAULT_STARTUP_DATABASE_CACHE_LIMITS,
    DEFAULT_STARTUP_DATABASE_CACHE_OPERATION_TIMEOUT_MS,
    STARTUP_DATABASE_CACHE_FORMAT_VERSION,
    StartupDatabaseCache,
    appendStartupDatabasePatch,
    createStartupDatabaseCacheNamespace,
    jsonByteLength,
    type StartupDatabaseCacheMeta,
    type StartupDatabaseCacheRecord,
    type StartupDecodedCacheStore,
    type StartupRawCacheMetadata,
    type StartupRawCacheStore,
} from './startupDatabaseCache'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function settleBeforeTestDeadline<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        sleep(250).then(() => {
            throw new Error('cache operation exceeded the test deadline')
        }),
    ])
}

class MemoryRawStore implements StartupRawCacheStore {
    metadataReads = 0
    bodyReads = 0
    clears = 0
    writes: string[] = []
    etag = ''
    bytes: Uint8Array | null = null

    constructor(readonly namespace: string) { }

    async readMetadata(): Promise<StartupRawCacheMetadata | null> {
        this.metadataReads += 1
        return this.etag ? { namespace: this.namespace, etag: this.etag } : null
    }

    async readBytes(expectedEtag: string): Promise<Uint8Array | null> {
        this.bodyReads += 1
        return this.etag === expectedEtag ? this.bytes?.slice() ?? null : null
    }

    async write(etag: string, bytes: Uint8Array): Promise<boolean> {
        this.writes.push(`start:${etag}`)
        if (etag === 'slow') await sleep(20)
        this.etag = etag
        this.bytes = bytes.slice()
        this.writes.push(`end:${etag}`)
        return true
    }

    async clear(): Promise<void> {
        this.clears += 1
        this.etag = ''
        this.bytes = null
    }
}

class MemoryDecodedStore implements StartupDecodedCacheStore {
    metaReads = 0
    recordReads = 0
    clears = 0
    meta: StartupDatabaseCacheMeta | null = null
    record: StartupDatabaseCacheRecord | null = null

    async readMeta(): Promise<StartupDatabaseCacheMeta | null> {
        this.metaReads += 1
        return this.meta ? structuredClone(this.meta) : null
    }

    async readRecord(): Promise<StartupDatabaseCacheRecord | null> {
        this.recordReads += 1
        return this.record ? structuredClone(this.record) : null
    }

    async writeBaseline(
        record: StartupDatabaseCacheRecord,
        meta: StartupDatabaseCacheMeta,
    ): Promise<boolean> {
        this.record = structuredClone(record)
        this.meta = structuredClone(meta)
        return true
    }

    async writeMeta(meta: StartupDatabaseCacheMeta): Promise<boolean> {
        this.meta = structuredClone(meta)
        return true
    }

    async clear(): Promise<void> {
        this.clears += 1
        this.meta = null
        this.record = null
    }
}

function neverSettles<T>(): Promise<T> {
    return new Promise<T>(() => { })
}

class NeverSettlingRawStore implements StartupRawCacheStore {
    readMetadata(): Promise<StartupRawCacheMetadata | null> { return neverSettles() }
    readBytes(): Promise<Uint8Array | null> { return neverSettles() }
    write(): Promise<boolean> { return neverSettles() }
    clear(): Promise<void> { return neverSettles() }
}

class NeverSettlingDecodedStore implements StartupDecodedCacheStore {
    readMeta(): Promise<StartupDatabaseCacheMeta | null> { return neverSettles() }
    readRecord(): Promise<StartupDatabaseCacheRecord | null> { return neverSettles() }
    writeBaseline(): Promise<boolean> { return neverSettles() }
    writeMeta(): Promise<boolean> { return neverSettles() }
    clear(): Promise<void> { return neverSettles() }
}

function createMemoryCache(options?: {
    appVersion?: string
    schemaEpoch?: string | number
    limits?: { maxPatches?: number, maxPatchBytes?: number }
}) {
    const appVersion = options?.appVersion ?? '1.8.1'
    const schemaEpoch = options?.schemaEpoch ?? 7
    const namespace = createStartupDatabaseCacheNamespace(appVersion, schemaEpoch)
    const raw = new MemoryRawStore(namespace)
    const decoded = new MemoryDecodedStore()
    const cache = new StartupDatabaseCache({
        appVersion,
        schemaEpoch,
        limits: options?.limits,
        rawStore: raw,
        decodedStore: decoded,
    })
    return { cache, raw, decoded, namespace }
}

function baselineMeta(namespace: string, etag = 'e1'): StartupDatabaseCacheMeta {
    return {
        formatVersion: STARTUP_DATABASE_CACHE_FORMAT_VERSION,
        namespace,
        baseEtag: etag,
        currentEtag: etag,
        patches: [],
        patchBytes: 0,
    }
}

describe('startup database cache helpers', () => {
    it('derives the namespace from app version and schema epoch', () => {
        const a = createStartupDatabaseCacheNamespace('1.8.1', 7)
        expect(a).toContain('app:1.8.1')
        expect(a).toContain('schema:7')
        expect(createStartupDatabaseCacheNamespace('1.8.2', 7)).not.toBe(a)
        expect(createStartupDatabaseCacheNamespace('1.8.1', 8)).not.toBe(a)
    })

    it('appends a bounded patch journal and advances its ETag', () => {
        const namespace = createStartupDatabaseCacheNamespace('1.8.1', 7)
        const patch = [{ op: 'replace', path: '/name', value: 'next' }]
        const result = appendStartupDatabasePatch(baselineMeta(namespace), {
            namespace,
            previousEtag: 'e1',
            nextEtag: 'e2',
            patch,
        })

        expect(result.kind).toBe('updated')
        if (result.kind !== 'updated') return
        expect(result.meta.currentEtag).toBe('e2')
        expect(result.meta.patches).toEqual([patch])
        expect(result.meta.patchBytes).toBe(jsonByteLength(patch))
    })

    it('invalidates on ETag mismatch, patch-count cap, and byte cap', () => {
        const namespace = createStartupDatabaseCacheNamespace('1.8.1', 7)
        const patch = [{ op: 'replace', path: '/name', value: 'next' }]
        const meta = baselineMeta(namespace)

        expect(appendStartupDatabasePatch(meta, {
            namespace,
            previousEtag: 'wrong',
            nextEtag: 'e2',
            patch,
        }).kind).toBe('invalidate')

        expect(appendStartupDatabasePatch(meta, {
            namespace,
            previousEtag: 'e1',
            nextEtag: 'e2',
            patch,
        }, { maxPatches: 0, maxPatchBytes: Number.MAX_SAFE_INTEGER }).kind).toBe('invalidate')

        expect(appendStartupDatabasePatch(meta, {
            namespace,
            previousEtag: 'e1',
            nextEtag: 'e2',
            patch,
        }, { maxPatches: 1, maxPatchBytes: jsonByteLength(patch) - 1 }).kind).toBe('invalidate')
    })

    it('uses the requested production caps by default', () => {
        expect(DEFAULT_STARTUP_DATABASE_CACHE_LIMITS).toEqual({
            maxPatches: 200,
            maxPatchBytes: 4 * 1024 * 1024,
        })
        expect(DEFAULT_STARTUP_DATABASE_CACHE_OPERATION_TIMEOUT_MS).toBe(1500)
    })
})

describe('StartupDatabaseCache probe and hydration', () => {
    it('probes metadata without reading decoded objects or raw bodies', async () => {
        const { cache, raw, decoded, namespace } = createMemoryCache()
        decoded.meta = baselineMeta(namespace, 'decoded-etag')
        decoded.record = {
            formatVersion: 1,
            namespace,
            baseEtag: 'decoded-etag',
            database: { name: 'cached' },
        }
        raw.etag = 'raw-etag'
        raw.bytes = new Uint8Array([1, 2, 3])

        await expect(cache.probe()).resolves.toEqual({ etag: 'decoded-etag', source: 'decoded' })
        expect(decoded.recordReads).toBe(0)
        expect(raw.bodyReads).toBe(0)
    })

    it('hydrates and replays the decoded journal only after 304', async () => {
        const { cache, decoded, namespace } = createMemoryCache()
        const patch = [{ op: 'replace', path: '/characters/0/name', value: 'after' }]
        decoded.meta = {
            ...baselineMeta(namespace, 'e1'),
            currentEtag: 'e2',
            patches: [patch],
            patchBytes: jsonByteLength(patch),
        }
        decoded.record = {
            formatVersion: 1,
            namespace,
            baseEtag: 'e1',
            database: { characters: [{ name: 'before' }] },
        }

        const probe = await cache.probe()
        expect(probe?.etag).toBe('e2')
        expect(decoded.recordReads).toBe(0)

        await expect(cache.resolveNotModified('e2')).resolves.toEqual({
            kind: 'decoded',
            etag: 'e2',
            database: { characters: [{ name: 'after' }] },
        })
        expect(decoded.recordReads).toBe(1)
    })

    it('clears corrupt decoded data and falls back to exact-ETag raw bytes', async () => {
        const { cache, raw, decoded, namespace } = createMemoryCache()
        decoded.meta = baselineMeta(namespace, 'e1')
        decoded.record = {
            formatVersion: 1,
            namespace: 'wrong-build',
            baseEtag: 'e1',
            database: { stale: true },
        }
        raw.etag = 'e1'
        raw.bytes = new Uint8Array([4, 5, 6])

        const hit = await cache.resolveNotModified('e1')
        expect(hit).toEqual({ kind: 'raw', etag: 'e1', bytes: new Uint8Array([4, 5, 6]) })
        expect(decoded.clears).toBe(1)
    })

    it('invalidates app/schema-mismatched decoded metadata', async () => {
        const { cache, decoded } = createMemoryCache({ appVersion: '1.8.2', schemaEpoch: 8 })
        decoded.meta = baselineMeta(createStartupDatabaseCacheNamespace('1.8.1', 7), 'old')

        await expect(cache.probe()).resolves.toBeNull()
        expect(decoded.clears).toBe(1)
    })

    it('clears raw bytes rejected by the caller decoder', async () => {
        const { cache, raw } = createMemoryCache()
        raw.etag = 'e1'
        raw.bytes = new Uint8Array([255])

        await expect(cache.resolveNotModified('e1', {
            validateRaw: () => false,
        })).resolves.toBeNull()
        expect(raw.clears).toBe(1)
    })
})

describe('StartupDatabaseCache mutations', () => {
    it('stores an authoritative raw body and decoded baseline', async () => {
        const { cache, raw, decoded, namespace } = createMemoryCache()
        const result = await cache.storeAuthoritative({
            etag: 'e1',
            bytes: new Uint8Array([1, 2, 3]),
            decoded: { characters: [] },
        })

        expect(result).toEqual({ rawStored: true, decodedStored: true })
        expect(raw.etag).toBe('e1')
        expect(decoded.meta).toEqual(baselineMeta(namespace, 'e1'))
        expect(decoded.record?.database).toEqual({ characters: [] })
    })

    it('serializes writes so a slow old body cannot overwrite a newer one', async () => {
        const { cache, raw } = createMemoryCache()
        const slow = cache.storeAuthoritative({ etag: 'slow', bytes: new Uint8Array([1]) })
        const fresh = cache.storeAuthoritative({ etag: 'fresh', bytes: new Uint8Array([2]) })
        await Promise.all([slow, fresh])

        expect(raw.writes).toEqual(['start:slow', 'end:slow', 'start:fresh', 'end:fresh'])
        expect(raw.etag).toBe('fresh')
        expect(raw.bytes).toEqual(new Uint8Array([2]))
    })

    it('records patches and clears the decoded cache at its configured cap', async () => {
        const { cache, decoded, namespace } = createMemoryCache({
            limits: { maxPatches: 1, maxPatchBytes: 1024 },
        })
        decoded.meta = baselineMeta(namespace, 'e1')
        decoded.record = {
            formatVersion: 1,
            namespace,
            baseEtag: 'e1',
            database: { value: 0 },
        }

        await expect(cache.recordPatch({
            previousEtag: 'e1',
            nextEtag: 'e2',
            patch: [{ op: 'replace', path: '/value', value: 1 }],
        })).resolves.toBe('recorded')
        await expect(cache.recordPatch({
            previousEtag: 'e2',
            nextEtag: 'e3',
            patch: [{ op: 'replace', path: '/value', value: 2 }],
        })).resolves.toBe('invalidated')
        expect(decoded.meta).toBeNull()
        expect(decoded.record).toBeNull()
    })

    it('treats unavailable or quota-failing stores as a cache miss', async () => {
        const failingRaw: StartupRawCacheStore = {
            async readMetadata() { throw new Error('unavailable') },
            async readBytes() { throw new Error('unavailable') },
            async write() { throw new DOMException('quota', 'QuotaExceededError') },
            async clear() { throw new Error('unavailable') },
        }
        const failingDecoded: StartupDecodedCacheStore = {
            async readMeta() { throw new Error('unavailable') },
            async readRecord() { throw new Error('unavailable') },
            async writeBaseline() { throw new DOMException('quota', 'QuotaExceededError') },
            async writeMeta() { throw new DOMException('quota', 'QuotaExceededError') },
            async clear() { throw new Error('unavailable') },
        }
        const cache = new StartupDatabaseCache({
            appVersion: '1.8.1',
            schemaEpoch: 7,
            rawStore: failingRaw,
            decodedStore: failingDecoded,
        })

        await expect(cache.probe()).resolves.toBeNull()
        await expect(cache.storeAuthoritative({
            etag: 'e1',
            bytes: new Uint8Array([1]),
            decoded: { ok: true },
        })).resolves.toEqual({ rawStored: false, decodedStored: false })
        await expect(cache.invalidate()).resolves.toBeUndefined()
    })

    it('bounds probe, resolve, and invalidate when browser storage never responds', async () => {
        const cache = new StartupDatabaseCache({
            appVersion: '1.8.1',
            schemaEpoch: 7,
            operationTimeoutMs: 10,
            rawStore: new NeverSettlingRawStore(),
            decodedStore: new NeverSettlingDecodedStore(),
        })

        await expect(settleBeforeTestDeadline(cache.probe())).resolves.toBeNull()
        await expect(settleBeforeTestDeadline(cache.resolveNotModified('e1'))).resolves.toBeNull()
        await expect(settleBeforeTestDeadline(cache.invalidate())).resolves.toBeUndefined()
    })

    it('does not let a permanently pending mutation tail block a later probe', async () => {
        const cache = new StartupDatabaseCache({
            appVersion: '1.8.1',
            schemaEpoch: 7,
            operationTimeoutMs: 10,
            rawStore: new NeverSettlingRawStore(),
            decodedStore: new MemoryDecodedStore(),
        })

        void cache.storeAuthoritative({
            etag: 'never-finishes',
            bytes: new Uint8Array([1]),
            decoded: { ok: true },
        })

        await expect(settleBeforeTestDeadline(cache.probe())).resolves.toBeNull()
    })
})
