// Gemini explicit context caching — core module (cachedContents API).
//
// Three independent pieces the adapter wiring composes per request:
//   1. Runtime state store — in-module Map mirrored to localStorage
//      ('nodeOnlyGeminiCacheState'). NEVER persisted to the db: TTL-bound
//      throwaway state must not leak into save folders or .bin backups.
//   2. Pure decision functions — evaluateGeminiCacheBeforeRequest /
//      decideGeminiCacheAfterResponse. No I/O, no module state, inputs are
//      never mutated; the impure wiring acts on the returned decisions.
//   3. cachedContents REST client — create/extend/remove against the same
//      endpoint family as the chat request. Auth headers are injected by the
//      caller (this module never resolves credentials) and every method
//      resolves to a result object instead of throwing, so fire-and-forget
//      call sites cannot take the chat down.
//
// Like the adapter layer this module must not import getDatabase (SSR cycle):
// chat identity, config and credentials all arrive as arguments.
// Design: .agent/notes/gemini-cache-keeper-internalization.md §4-3/§4-4.

const STORAGE_KEY = 'nodeOnlyGeminiCacheState'

// Consecutive prefix-hash invalidations before caching auto-disables for the
// chat session (dynamic-prompt guard: a prefix that changes every turn would
// only ever pay creation cost without hitting). Only genuine prefix mismatches
// count — cache-API failures never do (the server is the authority on whether a
// create can succeed; a transient failure must not disable a healthy session).
export const GEMINI_CACHE_INVALIDATION_LIMIT = 3

export const GEMINI_CACHE_DEFAULTS = {
    ttlSec: 600,
    extendTtlOnHit: true,
    minPromptTokens: 4096,
    growthTokens: 4096,
} as const

// Shape of ModelPreset.promptCaching (additive optional preset field).
export interface GeminiPromptCachingConfig {
    enabled: boolean
    ttlSec?: number
    extendTtlOnHit?: boolean
    minPromptTokens?: number
    growthTokens?: number
}

export interface ResolvedGeminiCacheConfig {
    ttlSec: number
    extendTtlOnHit: boolean
    minPromptTokens: number
    growthTokens: number
}

// null = caching off. Non-finite / non-positive overrides fall back to defaults.
export function resolveGeminiCacheConfig(
    config: GeminiPromptCachingConfig | undefined | null,
): ResolvedGeminiCacheConfig | null {
    if (!config?.enabled) return null
    return {
        ttlSec: positiveOr(config.ttlSec, GEMINI_CACHE_DEFAULTS.ttlSec),
        extendTtlOnHit: config.extendTtlOnHit ?? GEMINI_CACHE_DEFAULTS.extendTtlOnHit,
        minPromptTokens: positiveOr(config.minPromptTokens, GEMINI_CACHE_DEFAULTS.minPromptTokens),
        growthTokens: positiveOr(config.growthTokens, GEMINI_CACHE_DEFAULTS.growthTokens),
    }
}

function positiveOr(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

// ─── runtime state store ────────────────────────────────────────────────────

export interface GeminiCacheStateEntry {
    cacheName: string               // "cachedContents/..."
    modelId: string
    createdAt: number
    expiresAt: number
    boundaryIndex: number           // contents count covered by the cache (= cachePoint position at creation)
    prefixHash: string              // hash(JSON({systemInstruction, contents[0..boundary)}))
    promptTokensAtCreation: number
    credentialFp: string            // key fingerprint — detects key-pool rotation
}

export function buildGeminiCacheKey(chatKey: string, task: string, presetId: string): string {
    return `${chatKey}::${task}::${presetId}`
}

let entries: Map<string, GeminiCacheStateEntry> | null = null
const invalidationCounts = new Map<string, number>()
const disabledSessions = new Set<string>()

function loadEntries(): Map<string, GeminiCacheStateEntry> {
    if (entries) return entries
    entries = new Map()
    const now = Date.now()
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (raw) {
            const parsed: unknown = JSON.parse(raw)
            if (isPlainObject(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (!isValidEntry(value) || value.expiresAt <= now) continue
                    entries.set(key, value)
                    // The consecutive-invalidation guard is in-memory only and
                    // resets on reload by design (see the session-guards block) —
                    // nothing about it is restored here.
                }
            }
        }
    } catch {
        // unreadable / corrupt mirror → start empty
    }
    return entries
}

function persistEntries(): void {
    if (!entries) return
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {
        // storage full / unavailable — in-memory Map stays authoritative
    }
}

function isValidEntry(value: unknown): value is GeminiCacheStateEntry {
    if (!isPlainObject(value)) return false
    return typeof value['cacheName'] === 'string'
        && typeof value['modelId'] === 'string'
        && typeof value['createdAt'] === 'number'
        && typeof value['expiresAt'] === 'number'
        && typeof value['boundaryIndex'] === 'number'
        && typeof value['prefixHash'] === 'string'
        && typeof value['promptTokensAtCreation'] === 'number'
        && typeof value['credentialFp'] === 'string'
}

// Expired entries are pruned on read so callers never see a stale cacheName.
export function getGeminiCacheEntry(key: string, now: number = Date.now()): GeminiCacheStateEntry | undefined {
    const store = loadEntries()
    const entry = store.get(key)
    if (entry && entry.expiresAt <= now) {
        store.delete(key)
        persistEntries()
        return undefined
    }
    return entry
}

export function setGeminiCacheEntry(key: string, entry: GeminiCacheStateEntry): void {
    loadEntries().set(key, entry)
    persistEntries()
}

export function removeGeminiCacheEntry(key: string): void {
    const store = loadEntries()
    if (store.delete(key)) persistEntries()
}

// State entry constructor for a freshly created cache. expiresAt prefers the
// server-reported expireTime over the locally computed ttl.
export function buildGeminiCacheEntry(args: {
    cacheName: string
    modelId: string
    now: number
    ttlSec: number
    expireTimeMs?: number
    boundaryIndex: number
    prefixHash: string
    promptTokensAtCreation: number
    credentialFp: string
}): GeminiCacheStateEntry {
    return {
        cacheName: args.cacheName,
        modelId: args.modelId,
        createdAt: args.now,
        expiresAt: args.expireTimeMs ?? args.now + args.ttlSec * 1000,
        boundaryIndex: args.boundaryIndex,
        prefixHash: args.prefixHash,
        promptTokensAtCreation: args.promptTokensAtCreation,
        credentialFp: args.credentialFp,
    }
}

// ─── session guards (in-memory only — reset on reload) ─────────────────────

export function getGeminiCacheInvalidationCount(key: string): number {
    loadEntries()
    return invalidationCounts.get(key) ?? 0
}

export function bumpGeminiCacheInvalidationCount(key: string): number {
    const next = getGeminiCacheInvalidationCount(key) + 1
    invalidationCounts.set(key, next)
    return next
}

export function resetGeminiCacheInvalidationCount(key: string): void {
    invalidationCounts.delete(key)
}

export function isGeminiCacheSessionDisabled(key: string): boolean {
    return disabledSessions.has(key)
}

// Disables caching for the rest of this chat session. Two callers: the
// dynamic-prompt guard (GEMINI_CACHE_INVALIDATION_LIMIT consecutive prefix
// mismatches) and a 403 on cache creation (the project/key cannot use
// cachedContents at all). Both are futile to keep retrying.
export function disableGeminiCacheSession(key: string, reason = 'unrecoverable cache state'): void {
    if (disabledSessions.has(key)) return
    disabledSessions.add(key)
    console.warn(`[gemini-cache] context caching disabled for this chat session — ${reason} (${key}).`)
}

// Test-only: drop all in-memory state and force a localStorage reload.
export function resetGeminiContextCacheRuntime(): void {
    entries = null
    invalidationCounts.clear()
    disabledSessions.clear()
}

// ─── hashing ────────────────────────────────────────────────────────────────

// FNV-1a 32-bit over the UTF-16 code units — non-cryptographic, stable, and
// cheap enough to run on every request. 8 hex chars.
function fnv1a32(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

// Identity of the cached prefix: systemInstruction + contents up to (excluding)
// the boundary. systemInstruction normalizes to null so absent vs undefined
// serialize identically.
export function computeGeminiPrefixHash(
    systemInstruction: unknown,
    contents: readonly unknown[],
    boundaryIndex: number,
): string {
    return fnv1a32(JSON.stringify({
        systemInstruction: systemInstruction ?? null,
        contents: contents.slice(0, boundaryIndex),
    }))
}

// Caches are bound to the key/project that created them; the fingerprint
// detects key-pool rotation without storing the credential itself.
export function computeGeminiCredentialFp(credential: string): string {
    return fnv1a32(credential)
}

// ─── pure decisions: before request ─────────────────────────────────────────

export interface GeminiCachePreRequestInput {
    entry: GeminiCacheStateEntry | undefined
    now: number
    modelId: string
    credentialFp: string
    // Last native message.cachePoint position in the current contents
    // (count of contents before the boundary); null = no cache point.
    boundaryIndex: number | null
    systemInstruction: unknown      // body.systemInstruction (undefined when absent)
    contents: readonly unknown[]    // body.contents
}

export type GeminiCachePreDecision =
    // No cache point in the prompt → caching does not participate at all.
    | { action: 'bypass'; reason: 'no-cache-point' }
    // Send uncached; the post-response decision may create a cache.
    | { action: 'miss'; reason: 'no-state' | 'expired' | 'model-mismatch' | 'credential-mismatch' }
    // Stored cache no longer matches this prompt: remove state, DELETE the
    // remote cache (fire-and-forget), send uncached. countsTowardGuard is true
    // only for prefix-mismatch (the consecutive-invalidation auto-off guard).
    | {
        action: 'invalidate'
        reason: 'boundary-out-of-range' | 'prefix-mismatch'
        staleCacheName: string
        countsTowardGuard: boolean
    }
    // Valid cache → apply cachedContent + send only the suffix.
    | { action: 'apply'; cacheName: string; boundaryIndex: number }

export function evaluateGeminiCacheBeforeRequest(
    input: GeminiCachePreRequestInput,
): GeminiCachePreDecision {
    if (input.boundaryIndex === null) {
        return { action: 'bypass', reason: 'no-cache-point' }
    }
    const entry = input.entry
    if (!entry) return { action: 'miss', reason: 'no-state' }
    if (entry.expiresAt <= input.now) return { action: 'miss', reason: 'expired' }
    if (entry.modelId !== input.modelId) return { action: 'miss', reason: 'model-mismatch' }
    if (entry.credentialFp !== input.credentialFp) {
        return { action: 'miss', reason: 'credential-mismatch' }
    }
    if (entry.boundaryIndex > input.contents.length) {
        return {
            action: 'invalidate',
            reason: 'boundary-out-of-range',
            staleCacheName: entry.cacheName,
            countsTowardGuard: false,
        }
    }
    const prefixHash = computeGeminiPrefixHash(input.systemInstruction, input.contents, entry.boundaryIndex)
    if (prefixHash !== entry.prefixHash) {
        return {
            action: 'invalidate',
            reason: 'prefix-mismatch',
            staleCacheName: entry.cacheName,
            countsTowardGuard: true,
        }
    }
    return { action: 'apply', cacheName: entry.cacheName, boundaryIndex: entry.boundaryIndex }
}

// ─── pure decisions: after response ─────────────────────────────────────────

export interface GeminiCachePostResponseInput {
    pre: GeminiCachePreDecision
    // Entry as it stands AFTER pre-request handling (undefined when the pre
    // decision was 'invalidate' and the wiring removed it).
    entry: GeminiCacheStateEntry | undefined
    now: number
    promptTokens: number | undefined        // response usage (undefined = no usage observed)
    boundaryIndex: number | null            // last cachePoint of THIS request
    consecutiveInvalidations: number        // count after any pre-request bump
    config: ResolvedGeminiCacheConfig
}

export interface GeminiCachePostDecision {
    resetInvalidations: boolean             // confirmed hit
    disableSession: boolean                 // invalidation guard fired
    extendTtl: boolean                      // PATCH the current entry's ttl
    create: { boundaryIndex: number; replaceCacheName?: string } | null
    reason:
        | 'hit-fresh' | 'hit-extend' | 'hit-regrow'
        | 'no-usage' | 'below-min-tokens' | 'invalidation-guard' | 'no-cache-point' | 'create'
}

export function decideGeminiCacheAfterResponse(
    input: GeminiCachePostResponseInput,
): GeminiCachePostDecision {
    const { pre, entry, now, promptTokens, boundaryIndex, config } = input
    if (pre.action === 'apply' && entry) {
        // Confirmed hit. Recreate ONLY when the cacheable prefix actually
        // advanced (a deeper cachePoint) AND the prompt grew past the threshold —
        // folding the larger prefix into a fresh cache is worthwhile. A fixed
        // cachePoint whose suffix merely grows must NOT regrow: the prefix is
        // identical, so re-caching it wastes a creation. Otherwise extend the TTL
        // when less than half of it remains.
        const boundaryAdvanced = boundaryIndex !== null && boundaryIndex > entry.boundaryIndex
        const grown = boundaryAdvanced
            && promptTokens !== undefined
            && promptTokens - entry.promptTokensAtCreation >= config.growthTokens
        if (grown && boundaryIndex !== null) {
            return {
                resetInvalidations: true,
                disableSession: false,
                extendTtl: false,
                create: { boundaryIndex, replaceCacheName: entry.cacheName },
                reason: 'hit-regrow',
            }
        }
        const extendTtl = config.extendTtlOnHit && entry.expiresAt - now < (config.ttlSec * 1000) / 2
        return {
            resetInvalidations: true,
            disableSession: false,
            extendTtl,
            create: null,
            reason: extendTtl ? 'hit-extend' : 'hit-fresh',
        }
    }
    // Bypass / miss / invalidated — consider creating a cache for next turn.
    if (promptTokens === undefined) return noCreate('no-usage')
    // Cheap lower-bound filter on the observed whole-prompt tokens: if even the
    // full prompt is below the minimum, the cached prefix (a subset) certainly
    // is, so skip. We deliberately do NOT estimate the prefix's own token count —
    // the server is the authority on the prefix minimum, and a create whose
    // prefix turns out too small fails recoverably (caching just skips that turn).
    if (promptTokens < config.minPromptTokens) return noCreate('below-min-tokens')
    if (input.consecutiveInvalidations >= GEMINI_CACHE_INVALIDATION_LIMIT) {
        return {
            resetInvalidations: false,
            disableSession: true,
            extendTtl: false,
            create: null,
            reason: 'invalidation-guard',
        }
    }
    if (boundaryIndex === null) return noCreate('no-cache-point')
    return {
        resetInvalidations: false,
        disableSession: false,
        extendTtl: false,
        create: { boundaryIndex, replaceCacheName: entry?.cacheName },
        reason: 'create',
    }
}

function noCreate(reason: 'no-usage' | 'below-min-tokens' | 'no-cache-point'): GeminiCachePostDecision {
    return { resetInvalidations: false, disableSession: false, extendTtl: false, create: null, reason }
}

// ─── body transforms (pure — inputs are not mutated) ────────────────────────

// Wire constraints with cachedContent set: contents must be the suffix past
// the cached boundary, and systemInstruction/tools/toolConfig must NOT repeat
// what the cache already holds.
export function applyGeminiCacheToBody(
    body: Record<string, unknown>,
    plan: { cacheName: string; boundaryIndex: number },
): Record<string, unknown> {
    const contents = Array.isArray(body['contents']) ? body['contents'] : []
    const next: Record<string, unknown> = { ...body }
    next['cachedContent'] = plan.cacheName
    next['contents'] = contents.slice(plan.boundaryIndex)
    delete next['systemInstruction']
    delete next['tools']
    delete next['toolConfig']
    return next
}

// Creation payload: the cache owns systemInstruction + contents up to the
// boundary. v1 never caches tools (tool-enabled requests skip caching).
// `model` is the full resource name in the shape the endpoint expects:
// "models/{id}" for AI Studio, the "projects/.../models/{id}" path for Vertex
// (computed by the caller via deriveGeminiCacheModel from the chat URL).
export function buildGeminiCacheCreateBody(args: {
    model: string
    ttlSec: number
    systemInstruction?: unknown
    contents: readonly unknown[]
    boundaryIndex: number
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: args.model,
        ttl: `${args.ttlSec}s`,
        contents: args.contents.slice(0, args.boundaryIndex),
    }
    if (args.systemInstruction !== undefined) {
        body['systemInstruction'] = args.systemInstruction
    }
    return body
}

// ─── cachedContents REST client ─────────────────────────────────────────────

// Marker that distinguishes the Vertex AI native URL family from AI Studio.
// Vertex chat URLs are ".../v1/projects/{p}/locations/{l}/publishers/google/
// models/{id}:generateContent" (host is global aiplatform.googleapis.com or
// regional {loc}-aiplatform.googleapis.com — both end up in the path the same
// way, so this works off the path alone, never a hardcoded host).
const VERTEX_PUBLISHER_MARKER = '/publishers/google/models'

// Derives the cachedContents collection URL from the prepared chat URL.
//   AI Studio: ".../v1beta/models/{id}:generateContent" (or the bare
//              ".../v1beta/models" base) → ".../v1beta/cachedContents".
//   Vertex:    ".../v1/projects/{p}/locations/{l}/publishers/google/models/
//              {id}:..." → ".../v1/projects/{p}/locations/{l}/cachedContents"
//              (cachedContents is rooted at the location, not the publisher).
// null = unrecognized shape, caller skips caching.
export function deriveCachedContentsUrl(preparedUrl: string): string | null {
    // Vertex must be checked first: its path also contains "/models/", so the
    // Studio marker below would mis-cut it at the publisher segment.
    const vertexIdx = preparedUrl.indexOf(VERTEX_PUBLISHER_MARKER)
    if (vertexIdx >= 0) return `${preparedUrl.slice(0, vertexIdx)}/cachedContents`
    const marker = '/models/'
    const idx = preparedUrl.lastIndexOf(marker)
    if (idx >= 0) return `${preparedUrl.slice(0, idx)}/cachedContents`
    if (preparedUrl.endsWith('/models')) {
        return `${preparedUrl.slice(0, preparedUrl.length - '/models'.length)}/cachedContents`
    }
    return null
}

// Derives the `model` field for a cachedContents creation body from the prepared
// chat URL. The cache resource must name the same model the chat call targets,
// in the shape that endpoint family expects:
//   AI Studio: "models/{id}"
//   Vertex:    "projects/{p}/locations/{l}/publishers/google/models/{id}"
//              (the full resource path that lives in the chat URL).
// Falls back to "models/{modelId}" for the Studio shape so behavior there is
// unchanged. The id is taken from the URL for Vertex (it already carries the
// percent-encoded model id) and from modelId otherwise.
export function deriveGeminiCacheModel(preparedUrl: string, modelId: string): string {
    const vertexIdx = preparedUrl.indexOf(VERTEX_PUBLISHER_MARKER)
    if (vertexIdx >= 0) {
        // The resource name starts at "projects/" (the segment just before the
        // publisher marker) and runs to the ":generateContent"/":streamGenerateContent"
        // (and any "?alt=sse") suffix. Keying off "/projects/" — not a literal
        // "/v1/" — keeps this version-agnostic, matching deriveCachedContentsUrl
        // (Vertex historically also exposes /v1beta1/).
        const projectsIdx = preparedUrl.lastIndexOf('/projects/', vertexIdx)
        if (projectsIdx >= 0) {
            const afterSlash = preparedUrl.slice(projectsIdx + 1)
            const colonIdx = afterSlash.indexOf(':')
            const resource = colonIdx >= 0 ? afterSlash.slice(0, colonIdx) : afterSlash
            if (resource.length > 0) return resource
        }
    }
    return `models/${modelId}`
}

export interface GeminiCacheClientResult {
    ok: boolean
    status?: number
}

export interface GeminiCacheCreateResult extends GeminiCacheClientResult {
    name?: string           // "cachedContents/..."
    expireTimeMs?: number   // parsed from the RFC3339 expireTime, when present
}

export interface GeminiCachedContentsClient {
    create(body: Record<string, unknown>): Promise<GeminiCacheCreateResult>
    extend(cacheName: string, ttlSec: number): Promise<GeminiCacheClientResult>
    remove(cacheName: string): Promise<GeminiCacheClientResult>
}

// All methods resolve (never throw) so fire-and-forget call sites stay safe.
// `headers` is the caller-injected auth + content type (typically the prepared
// request headers of the chat call); this module never resolves credentials.
export function createGeminiCachedContentsClient(opts: {
    cachedContentsUrl: string
    headers: Record<string, string>
    fetchImpl?: typeof fetch
}): GeminiCachedContentsClient {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch
    // Vertex vs AI Studio: the PATCH below needs different query params (see
    // extend()). Detect by the resource PATH (".../locations/{l}/cachedContents",
    // the Vertex shape) rather than the host — a supported endpointUrl override
    // can route Vertex through a proxy / PSC domain that isn't aiplatform.*.
    const isVertex = /\/locations\/[^/]+\/cachedContents/.test(opts.cachedContentsUrl)
    const resourceUrl = (cacheName: string): string => {
        const id = cacheName.slice(cacheName.lastIndexOf('/') + 1)
        return `${opts.cachedContentsUrl}/${encodeURIComponent(id)}`
    }
    const call = async (url: string, method: string, body?: Record<string, unknown>): Promise<Response | null> => {
        try {
            return await fetchImpl(url, {
                method,
                headers: opts.headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch {
            return null
        }
    }
    return {
        async create(body) {
            const response = await call(opts.cachedContentsUrl, 'POST', body)
            if (!response) return { ok: false }
            if (!response.ok) return { ok: false, status: response.status }
            let raw: unknown
            try {
                raw = await response.json()
            } catch {
                return { ok: false, status: response.status }
            }
            if (!isPlainObject(raw) || typeof raw['name'] !== 'string') {
                return { ok: false, status: response.status }
            }
            const expireTime = typeof raw['expireTime'] === 'string' ? Date.parse(raw['expireTime']) : NaN
            return {
                ok: true,
                status: response.status,
                name: raw['name'],
                expireTimeMs: Number.isNaN(expireTime) ? undefined : expireTime,
            }
        },
        async extend(cacheName, ttlSec) {
            // Vertex's cachedContents.patch REQUIRES ?updateMask=ttl (returns 400
            // without it); AI Studio's patch does not need it. Append only for
            // Vertex so the Studio request stays byte-identical.
            const url = isVertex
                ? `${resourceUrl(cacheName)}?updateMask=ttl`
                : resourceUrl(cacheName)
            const response = await call(url, 'PATCH', { ttl: `${ttlSec}s` })
            if (!response) return { ok: false }
            return { ok: response.ok, status: response.status }
        },
        async remove(cacheName) {
            const response = await call(resourceUrl(cacheName), 'DELETE')
            if (!response) return { ok: false }
            return { ok: response.ok, status: response.status }
        },
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
