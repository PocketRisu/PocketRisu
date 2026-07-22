import { applyPatch } from 'fast-json-patch'

export const STARTUP_DATABASE_CACHE_FORMAT_VERSION = 1

export const DEFAULT_STARTUP_DATABASE_CACHE_LIMITS = Object.freeze({
    maxPatches: 200,
    maxPatchBytes: 4 * 1024 * 1024,
})

export const DEFAULT_STARTUP_DATABASE_CACHE_OPERATION_TIMEOUT_MS = 1500

export interface JsonPatchOperation {
    op: string
    path: string
    from?: string
    value?: unknown
}

export interface StartupDatabaseCacheLimits {
    maxPatches: number
    maxPatchBytes: number
}

export interface StartupDatabaseCacheMeta {
    formatVersion: 1
    namespace: string
    baseEtag: string
    currentEtag: string
    patches: JsonPatchOperation[][]
    patchBytes: number
}

export interface StartupDatabaseCacheRecord {
    formatVersion: 1
    namespace: string
    baseEtag: string
    database: unknown
}

export interface StartupRawCacheMetadata {
    namespace: string
    etag: string
}

export interface StartupRawCacheStore {
    readMetadata(): Promise<StartupRawCacheMetadata | null>
    readBytes(expectedEtag: string): Promise<Uint8Array | null>
    write(etag: string, bytes: Uint8Array): Promise<boolean>
    clear(): Promise<void>
}

export interface StartupDecodedCacheStore {
    readMeta(): Promise<StartupDatabaseCacheMeta | null>
    readRecord(): Promise<StartupDatabaseCacheRecord | null>
    writeBaseline(record: StartupDatabaseCacheRecord, meta: StartupDatabaseCacheMeta): Promise<boolean>
    writeMeta(meta: StartupDatabaseCacheMeta): Promise<boolean>
    clear(): Promise<void>
}

export interface StartupDatabaseCacheOptions {
    appVersion: string
    schemaEpoch: string | number
    /**
     * Maximum time a startup-critical cache operation may delay the
     * authoritative server path. Primarily exposed so tests can use a much
     * shorter bound.
     */
    operationTimeoutMs?: number
    origin?: string
    limits?: Partial<StartupDatabaseCacheLimits>
    cacheStorage?: CacheStorage | null
    indexedDB?: IDBFactory | null
    rawStore?: StartupRawCacheStore | null
    decodedStore?: StartupDecodedCacheStore | null
}

export interface StartupDatabaseCacheProbe {
    etag: string
    source: 'decoded' | 'raw'
}

export type StartupDatabaseCacheHit =
    | { kind: 'decoded', etag: string, database: unknown }
    | { kind: 'raw', etag: string, bytes: Uint8Array }

export interface StoreAuthoritativeDatabaseInput {
    etag: string
    bytes: Uint8Array
    decoded?: unknown
}

export interface StoreAuthoritativeDatabaseResult {
    rawStored: boolean
    decodedStored: boolean
}

export type RecordStartupDatabasePatchResult = 'recorded' | 'invalidated' | 'skipped'

export type AppendPatchJournalResult =
    | { kind: 'updated', meta: StartupDatabaseCacheMeta }
    | { kind: 'invalidate', reason: 'namespace' | 'etag' | 'shape' | 'limit' }

const RAW_CACHE_NAME = 'pocketrisu-startup-database-cache-v1'
const RAW_CACHE_PATH_PREFIX = '/__pocketrisu-cache__/database/'
const RAW_ETAG_HEADER = 'x-db-etag'
const RAW_NAMESPACE_HEADER = 'x-pocketrisu-cache-namespace'
const RAW_FORMAT_HEADER = 'x-pocketrisu-cache-format'
const DECODED_CACHE_DB_NAME = 'pocketrisu-startup-database-cache-v1'
const DECODED_CACHE_STORE_NAME = 'startup-database'
const DECODED_CACHE_META_KEY = 'meta'
const DECODED_CACHE_RECORD_KEY = 'record'

function normalizeNamespacePart(value: string | number): string {
    const normalized = String(value).trim()
    return normalized || 'unknown'
}

/**
 * Cache identity deliberately includes both the application build and the
 * decoder/schema epoch. A new decoder must never hydrate an object produced by
 * an older build merely because the authoritative bytes still have the same
 * ETag.
 */
export function createStartupDatabaseCacheNamespace(
    appVersion: string,
    schemaEpoch: string | number,
): string {
    return [
        `format:${STARTUP_DATABASE_CACHE_FORMAT_VERSION}`,
        `schema:${normalizeNamespacePart(schemaEpoch)}`,
        `app:${normalizeNamespacePart(appVersion)}`,
    ].join('|')
}

export function jsonByteLength(value: unknown): number {
    try {
        const encoded = JSON.stringify(value)
        if (encoded === undefined) return Number.POSITIVE_INFINITY
        return new TextEncoder().encode(encoded).byteLength
    } catch {
        return Number.POSITIVE_INFINITY
    }
}

function isJsonPatchArray(value: unknown): value is JsonPatchOperation[][] {
    return Array.isArray(value) && value.every((patch) =>
        Array.isArray(patch) && patch.every((operation) =>
            !!operation
            && typeof operation === 'object'
            && typeof (operation as JsonPatchOperation).op === 'string'
            && typeof (operation as JsonPatchOperation).path === 'string'
        )
    )
}

export function isStartupDatabaseCacheMeta(
    value: unknown,
    namespace: string,
): value is StartupDatabaseCacheMeta {
    if (!value || typeof value !== 'object') return false
    const meta = value as StartupDatabaseCacheMeta
    if (
        meta.formatVersion !== STARTUP_DATABASE_CACHE_FORMAT_VERSION
        || meta.namespace !== namespace
        || typeof meta.baseEtag !== 'string'
        || !meta.baseEtag
        || typeof meta.currentEtag !== 'string'
        || !meta.currentEtag
        || !isJsonPatchArray(meta.patches)
        || !Number.isSafeInteger(meta.patchBytes)
        || meta.patchBytes < 0
    ) {
        return false
    }
    return jsonByteLength(meta.patches) <= meta.patchBytes + meta.patches.length * 2
        || meta.patches.length === 0
}

export function isStartupDatabaseCacheRecord(
    value: unknown,
    namespace: string,
    baseEtag: string,
): value is StartupDatabaseCacheRecord {
    if (!value || typeof value !== 'object') return false
    const record = value as StartupDatabaseCacheRecord
    return record.formatVersion === STARTUP_DATABASE_CACHE_FORMAT_VERSION
        && record.namespace === namespace
        && record.baseEtag === baseEtag
        && record.database !== null
        && typeof record.database === 'object'
}

export function appendStartupDatabasePatch(
    meta: StartupDatabaseCacheMeta,
    input: {
        namespace: string
        previousEtag: string
        nextEtag: string
        patch: JsonPatchOperation[]
    },
    limits: StartupDatabaseCacheLimits = DEFAULT_STARTUP_DATABASE_CACHE_LIMITS,
): AppendPatchJournalResult {
    if (!isStartupDatabaseCacheMeta(meta, input.namespace)) {
        return { kind: 'invalidate', reason: 'namespace' }
    }
    if (!input.previousEtag || !input.nextEtag || meta.currentEtag !== input.previousEtag) {
        return { kind: 'invalidate', reason: 'etag' }
    }
    if (!isJsonPatchArray([input.patch])) {
        return { kind: 'invalidate', reason: 'shape' }
    }

    const bytes = jsonByteLength(input.patch)
    if (!Number.isFinite(bytes)) {
        return { kind: 'invalidate', reason: 'shape' }
    }
    if (
        meta.patches.length + 1 > limits.maxPatches
        || meta.patchBytes + bytes > limits.maxPatchBytes
    ) {
        return { kind: 'invalidate', reason: 'limit' }
    }

    return {
        kind: 'updated',
        meta: {
            ...meta,
            currentEtag: input.nextEtag,
            patches: [...meta.patches, input.patch],
            patchBytes: meta.patchBytes + bytes,
        },
    }
}

function quoteHttpEtag(etag: string): string {
    return `"${etag.replaceAll('"', '')}"`
}

function cloneForCache(value: unknown): { ok: true, value: unknown } | { ok: false } {
    try {
        if (typeof structuredClone === 'function') {
            return { ok: true, value: structuredClone(value) }
        }
        return { ok: true, value: JSON.parse(JSON.stringify(value)) }
    } catch {
        return { ok: false }
    }
}

class NullRawCacheStore implements StartupRawCacheStore {
    async readMetadata() { return null }
    async readBytes() { return null }
    async write() { return false }
    async clear() { }
}

class NullDecodedCacheStore implements StartupDecodedCacheStore {
    async readMeta() { return null }
    async readRecord() { return null }
    async writeBaseline() { return false }
    async writeMeta() { return false }
    async clear() { }
}

export class BrowserStartupRawCacheStore implements StartupRawCacheStore {
    private readonly request: Request

    constructor(
        private readonly namespace: string,
        origin: string,
        private readonly cacheStorage: CacheStorage | null,
    ) {
        const path = `${RAW_CACHE_PATH_PREFIX}${encodeURIComponent(namespace)}.bin`
        this.request = new Request(new URL(path, origin).toString())
    }

    private async open(): Promise<Cache | null> {
        if (!this.cacheStorage) return null
        try {
            return await this.cacheStorage.open(RAW_CACHE_NAME)
        } catch {
            return null
        }
    }

    private metadata(response: Response | undefined): StartupRawCacheMetadata | null {
        if (!response) return null
        const namespace = response.headers.get(RAW_NAMESPACE_HEADER) ?? ''
        const etag = response.headers.get(RAW_ETAG_HEADER) ?? ''
        const format = response.headers.get(RAW_FORMAT_HEADER)
        if (
            namespace !== this.namespace
            || !etag
            || format !== String(STARTUP_DATABASE_CACHE_FORMAT_VERSION)
        ) {
            return null
        }
        return { namespace, etag }
    }

    async readMetadata(): Promise<StartupRawCacheMetadata | null> {
        const cache = await this.open()
        if (!cache) return null
        try {
            const response = await cache.match(this.request)
            const metadata = this.metadata(response)
            if (!metadata && response) await cache.delete(this.request)
            return metadata
        } catch {
            return null
        }
    }

    async readBytes(expectedEtag: string): Promise<Uint8Array | null> {
        const cache = await this.open()
        if (!cache) return null
        try {
            const response = await cache.match(this.request)
            const metadata = this.metadata(response)
            if (!response || metadata?.etag !== expectedEtag) return null
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.byteLength === 0) {
                await cache.delete(this.request)
                return null
            }
            return bytes
        } catch {
            return null
        }
    }

    async write(etag: string, bytes: Uint8Array): Promise<boolean> {
        if (!etag || bytes.byteLength === 0) return false
        const cache = await this.open()
        if (!cache) return false
        try {
            const response = new Response(bytes.slice() as BodyInit, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'etag': quoteHttpEtag(etag),
                    [RAW_ETAG_HEADER]: etag,
                    [RAW_NAMESPACE_HEADER]: this.namespace,
                    [RAW_FORMAT_HEADER]: String(STARTUP_DATABASE_CACHE_FORMAT_VERSION),
                },
            })
            await cache.put(this.request, response)
            return true
        } catch {
            return false
        }
    }

    async clear(): Promise<void> {
        const cache = await this.open()
        if (!cache) return
        try {
            await cache.delete(this.request)
        } catch { }
    }
}

export class BrowserStartupDecodedCacheStore implements StartupDecodedCacheStore {
    constructor(private readonly factory: IDBFactory | null) { }

    private async openDatabase(): Promise<IDBDatabase | null> {
        if (!this.factory) return null
        return new Promise((resolve) => {
            let settled = false
            const finish = (database: IDBDatabase | null) => {
                if (settled) {
                    database?.close()
                    return
                }
                settled = true
                resolve(database)
            }
            try {
                const request = this.factory.open(DECODED_CACHE_DB_NAME, 1)
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(DECODED_CACHE_STORE_NAME)) {
                        request.result.createObjectStore(DECODED_CACHE_STORE_NAME)
                    }
                }
                request.onsuccess = () => finish(request.result)
                request.onerror = () => finish(null)
                request.onblocked = () => finish(null)
            } catch {
                finish(null)
            }
        })
    }

    private requestValue<T>(request: IDBRequest<T>): Promise<T | null> {
        return new Promise((resolve) => {
            request.onsuccess = () => resolve(request.result ?? null)
            request.onerror = () => resolve(null)
        })
    }

    private waitForTransaction(transaction: IDBTransaction): Promise<boolean> {
        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve(true)
            transaction.onerror = () => resolve(false)
            transaction.onabort = () => resolve(false)
        })
    }

    private async read<T>(key: string): Promise<T | null> {
        const database = await this.openDatabase()
        if (!database) return null
        try {
            const transaction = database.transaction(DECODED_CACHE_STORE_NAME, 'readonly')
            return await this.requestValue<T>(transaction.objectStore(DECODED_CACHE_STORE_NAME).get(key))
        } catch {
            return null
        } finally {
            database.close()
        }
    }

    async readMeta(): Promise<StartupDatabaseCacheMeta | null> {
        return this.read<StartupDatabaseCacheMeta>(DECODED_CACHE_META_KEY)
    }

    async readRecord(): Promise<StartupDatabaseCacheRecord | null> {
        return this.read<StartupDatabaseCacheRecord>(DECODED_CACHE_RECORD_KEY)
    }

    async writeBaseline(
        record: StartupDatabaseCacheRecord,
        meta: StartupDatabaseCacheMeta,
    ): Promise<boolean> {
        const database = await this.openDatabase()
        if (!database) return false
        try {
            const transaction = database.transaction(DECODED_CACHE_STORE_NAME, 'readwrite')
            const store = transaction.objectStore(DECODED_CACHE_STORE_NAME)
            store.put(record, DECODED_CACHE_RECORD_KEY)
            store.put(meta, DECODED_CACHE_META_KEY)
            return await this.waitForTransaction(transaction)
        } catch {
            return false
        } finally {
            database.close()
        }
    }

    async writeMeta(meta: StartupDatabaseCacheMeta): Promise<boolean> {
        const database = await this.openDatabase()
        if (!database) return false
        try {
            const transaction = database.transaction(DECODED_CACHE_STORE_NAME, 'readwrite')
            transaction.objectStore(DECODED_CACHE_STORE_NAME).put(meta, DECODED_CACHE_META_KEY)
            return await this.waitForTransaction(transaction)
        } catch {
            return false
        } finally {
            database.close()
        }
    }

    async clear(): Promise<void> {
        const database = await this.openDatabase()
        if (!database) return
        try {
            const transaction = database.transaction(DECODED_CACHE_STORE_NAME, 'readwrite')
            // Clear the object store instead of deleteDatabase. The latter can
            // remain blocked forever while another PocketRisu tab is open.
            transaction.objectStore(DECODED_CACHE_STORE_NAME).clear()
            await this.waitForTransaction(transaction)
        } catch { } finally {
            database.close()
        }
    }
}

export class StartupDatabaseCache {
    readonly namespace: string
    readonly limits: StartupDatabaseCacheLimits
    private readonly rawStore: StartupRawCacheStore
    private readonly decodedStore: StartupDecodedCacheStore
    private readonly operationTimeoutMs: number
    private mutationTail: Promise<void> = Promise.resolve()

    constructor(options: StartupDatabaseCacheOptions) {
        this.namespace = createStartupDatabaseCacheNamespace(options.appVersion, options.schemaEpoch)
        this.limits = {
            maxPatches: Math.max(1, options.limits?.maxPatches ?? DEFAULT_STARTUP_DATABASE_CACHE_LIMITS.maxPatches),
            maxPatchBytes: Math.max(1, options.limits?.maxPatchBytes ?? DEFAULT_STARTUP_DATABASE_CACHE_LIMITS.maxPatchBytes),
        }
        this.operationTimeoutMs = Number.isFinite(options.operationTimeoutMs)
            ? Math.max(1, Math.floor(options.operationTimeoutMs!))
            : DEFAULT_STARTUP_DATABASE_CACHE_OPERATION_TIMEOUT_MS

        const origin = options.origin
            ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost')
        const cacheStorage = options.cacheStorage === undefined
            ? (typeof caches !== 'undefined' ? caches : null)
            : options.cacheStorage
        const indexedDbFactory = options.indexedDB === undefined
            ? (typeof indexedDB !== 'undefined' ? indexedDB : null)
            : options.indexedDB

        this.rawStore = options.rawStore === undefined
            ? new BrowserStartupRawCacheStore(this.namespace, origin, cacheStorage)
            : (options.rawStore ?? new NullRawCacheStore())
        this.decodedStore = options.decodedStore === undefined
            ? new BrowserStartupDecodedCacheStore(indexedDbFactory)
            : (options.decodedStore ?? new NullDecodedCacheStore())
    }

    private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.mutationTail.then(operation, operation)
        this.mutationTail = run.then(() => undefined, () => undefined)
        return run
    }

    /**
     * Browser storage implementations can occasionally never dispatch their
     * completion event (notably on mobile WebViews). A cache is optional, so a
     * stuck operation must degrade to the supplied miss value instead of
     * blocking startup forever. The original promise may still finish later;
     * its rejection is observed by this handler.
     */
    private settleWithin<T>(operation: Promise<T>, fallback: T): Promise<T> {
        return new Promise((resolve) => {
            let settled = false
            let timer: ReturnType<typeof globalThis.setTimeout> | undefined
            const finish = (value: T) => {
                if (settled) return
                settled = true
                if (timer !== undefined) globalThis.clearTimeout(timer)
                resolve(value)
            }
            timer = globalThis.setTimeout(() => finish(fallback), this.operationTimeoutMs)
            operation.then(finish, () => finish(fallback))
        })
    }

    private async waitForMutations(): Promise<void> {
        await this.mutationTail.catch(() => undefined)
    }

    private async clearDecodedBestEffort(): Promise<void> {
        await this.settleWithin(this.enqueueMutation(async () => {
            try { await this.decodedStore.clear() } catch { }
        }), undefined)
    }

    private isUsableMeta(value: unknown): value is StartupDatabaseCacheMeta {
        return isStartupDatabaseCacheMeta(value, this.namespace)
            && value.patches.length <= this.limits.maxPatches
            && value.patchBytes <= this.limits.maxPatchBytes
    }

    /**
     * Reads only cache metadata. Callers should send the returned ETag to the
     * server and call resolveNotModified only after an authenticated 304.
     */
    async probe(): Promise<StartupDatabaseCacheProbe | null> {
        return this.settleWithin(this.probeWithoutTimeout(), null)
    }

    private async probeWithoutTimeout(): Promise<StartupDatabaseCacheProbe | null> {
        await this.waitForMutations()
        const [decodedMeta, rawMeta] = await Promise.all([
            this.decodedStore.readMeta().catch(() => null),
            this.rawStore.readMetadata().catch(() => null),
        ])

        if (decodedMeta) {
            if (this.isUsableMeta(decodedMeta)) {
                return { etag: decodedMeta.currentEtag, source: 'decoded' }
            }
            await this.clearDecodedBestEffort()
        }
        if (rawMeta?.namespace === this.namespace && rawMeta.etag) {
            return { etag: rawMeta.etag, source: 'raw' }
        }
        return null
    }

    /**
     * Hydrates cached content only after the server confirmed the exact ETag
     * with 304. Invalid decoded data is cleared before trying the raw fallback.
     */
    async resolveNotModified(
        etag: string,
        options?: {
            validateDecoded?: (database: unknown) => boolean | Promise<boolean>
            validateRaw?: (bytes: Uint8Array) => boolean | Promise<boolean>
        },
    ): Promise<StartupDatabaseCacheHit | null> {
        if (!etag) return null
        return this.settleWithin(this.resolveNotModifiedWithoutTimeout(etag, options), null)
    }

    private async resolveNotModifiedWithoutTimeout(
        etag: string,
        options?: {
            validateDecoded?: (database: unknown) => boolean | Promise<boolean>
            validateRaw?: (bytes: Uint8Array) => boolean | Promise<boolean>
        },
    ): Promise<StartupDatabaseCacheHit | null> {
        await this.waitForMutations()

        const meta = await this.decodedStore.readMeta().catch(() => null)
        if (meta) {
            let decodedIsCorrupt = !this.isUsableMeta(meta)
                || meta.currentEtag !== etag
            if (!decodedIsCorrupt) {
                const record = await this.decodedStore.readRecord().catch(() => null)
                if (isStartupDatabaseCacheRecord(record, this.namespace, meta.baseEtag)) {
                    try {
                        let database = record.database
                        for (const patch of meta.patches) {
                            database = applyPatch(database as object, patch as any, true, false, true).newDocument
                        }
                        const valid = options?.validateDecoded
                            ? await options.validateDecoded(database)
                            : true
                        if (valid) return { kind: 'decoded', etag, database }
                    } catch { }
                }
                decodedIsCorrupt = true
            }
            if (decodedIsCorrupt) await this.clearDecodedBestEffort()
        }

        const bytes = await this.rawStore.readBytes(etag).catch(() => null)
        if (!bytes || bytes.byteLength === 0) return null
        let rawValid = true
        if (options?.validateRaw) {
            try {
                rawValid = await options.validateRaw(bytes)
            } catch {
                rawValid = false
            }
        }
        if (!rawValid) {
            await this.settleWithin(this.enqueueMutation(async () => {
                try { await this.rawStore.clear() } catch { }
            }), undefined)
            return null
        }
        return { kind: 'raw', etag, bytes }
    }

    async storeAuthoritative(
        input: StoreAuthoritativeDatabaseInput,
    ): Promise<StoreAuthoritativeDatabaseResult> {
        if (!input.etag || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
            return { rawStored: false, decodedStored: false }
        }
        const bytes = input.bytes.slice()
        const decodedClone = input.decoded === undefined ? null : cloneForCache(input.decoded)

        return this.enqueueMutation(async () => {
            let rawStored = false
            let decodedStored = false
            try { rawStored = await this.rawStore.write(input.etag, bytes) } catch { }

            if (!decodedClone || !decodedClone.ok) {
                try { await this.decodedStore.clear() } catch { }
                return { rawStored, decodedStored }
            }

            const record: StartupDatabaseCacheRecord = {
                formatVersion: STARTUP_DATABASE_CACHE_FORMAT_VERSION,
                namespace: this.namespace,
                baseEtag: input.etag,
                database: decodedClone.value,
            }
            const meta: StartupDatabaseCacheMeta = {
                formatVersion: STARTUP_DATABASE_CACHE_FORMAT_VERSION,
                namespace: this.namespace,
                baseEtag: input.etag,
                currentEtag: input.etag,
                patches: [],
                patchBytes: 0,
            }
            try { decodedStored = await this.decodedStore.writeBaseline(record, meta) } catch { }
            if (!decodedStored) {
                try { await this.decodedStore.clear() } catch { }
            }
            return { rawStored, decodedStored }
        })
    }

    async recordPatch(input: {
        previousEtag: string
        nextEtag: string
        patch: JsonPatchOperation[]
    }): Promise<RecordStartupDatabasePatchResult> {
        if (!input.previousEtag || !input.nextEtag || !Array.isArray(input.patch)) return 'skipped'

        return this.enqueueMutation(async () => {
            const meta = await this.decodedStore.readMeta().catch(() => null)
            if (!meta) return 'skipped'
            const appended = appendStartupDatabasePatch(meta, {
                namespace: this.namespace,
                ...input,
            }, this.limits)
            if (appended.kind === 'invalidate') {
                try { await this.decodedStore.clear() } catch { }
                return 'invalidated'
            }
            const saved = await this.decodedStore.writeMeta(appended.meta).catch(() => false)
            if (!saved) {
                try { await this.decodedStore.clear() } catch { }
                return 'invalidated'
            }
            return 'recorded'
        })
    }

    async invalidate(): Promise<void> {
        await this.settleWithin(this.enqueueMutation(async () => {
            await Promise.all([
                this.rawStore.clear().catch(() => undefined),
                this.decodedStore.clear().catch(() => undefined),
            ])
        }), undefined)
    }
}
