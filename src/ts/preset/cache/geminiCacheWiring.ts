// Impure orchestration between the googleGemini adapter and the pure context-
// cache core (geminiContextCache.ts): looks up state, runs the pre-request
// decision, swaps the request body, and after the response fires the
// create/extend/remove side effects without ever blocking or throwing into the
// request path. Any failure here degrades to an uncached request — caching can
// never take the chat down. Design: gemini-cache-keeper-internalization.md §4-4.

import type { AdapterCacheContext } from '../adapter/types'
import {
    applyGeminiCacheToBody,
    buildGeminiCacheCreateBody,
    buildGeminiCacheEntry,
    buildGeminiCacheKey,
    bumpGeminiCacheInvalidationCount,
    computeGeminiCredentialFp,
    computeGeminiPrefixHash,
    createGeminiCachedContentsClient,
    decideGeminiCacheAfterResponse,
    deriveCachedContentsUrl,
    deriveGeminiCacheModel,
    disableGeminiCacheSession,
    evaluateGeminiCacheBeforeRequest,
    getGeminiCacheEntry,
    getGeminiCacheInvalidationCount,
    isGeminiCacheSessionDisabled,
    removeGeminiCacheEntry,
    resetGeminiCacheInvalidationCount,
    resolveGeminiCacheConfig,
    setGeminiCacheEntry,
    type GeminiCachedContentsClient,
    type GeminiCachePreDecision,
    type ResolvedGeminiCacheConfig,
} from './geminiContextCache'

export interface GeminiCacheTurn {
    // Request body to send (cache applied on a hit; the input body otherwise).
    // The input body is never mutated.
    body: Record<string, unknown>
    // True when `body` carries a cachedContent reference (the 'apply' path). The
    // adapter uses this to recognise a chat failure that the applied cache may
    // have caused (server evicted it ahead of the local expiry) and fall back to
    // an uncached send — caching must never break the chat (spec §4-4).
    appliedCache: boolean
    // Drop the local cache entry that `appliedCache` referenced. Called by the
    // adapter before an uncached retry so the stale cacheName is not reused next
    // turn; the next turn recreates the cache. No-op when nothing was applied.
    invalidateAppliedCache(): void
    // Post-response hook: pass the response's usage promptTokens (undefined when
    // no usage was observed). Fire-and-forget — returns immediately and never
    // throws; cache create/extend/remove run in the background.
    finish(promptTokens: number | undefined): void
}

// Pre-request step. Returns null when caching does not participate in this
// request (off / no cache point / session disabled / unrecognized URL / empty
// suffix) — the caller then sends the original body and skips finish().
export function beginGeminiCacheTurn(args: {
    cache: AdapterCacheContext
    url: string                          // prepared chat URL (cachedContents URL is derived from it)
    headers: Record<string, string>      // prepared chat headers (same auth reused for cache calls)
    body: Record<string, unknown>        // prepared chat body (pre-cache)
    modelId: string
    credentialKey: string | undefined    // raw key, fingerprinted for rotation detection
    boundaryIndex: number | null         // last native cachePoint as a contents index
    fetchImpl?: typeof fetch
}): GeminiCacheTurn | null {
    try {
        return beginTurn(args)
    } catch (err) {
        console.warn('[gemini-cache] skipped for this request (pre-request step failed)', err)
        return null
    }
}

function beginTurn(args: Parameters<typeof beginGeminiCacheTurn>[0]): GeminiCacheTurn | null {
    const config = resolveGeminiCacheConfig(args.cache.promptCaching)
    if (!config) return null
    // No native cachePoint → caching does not participate at all (spec §4-4).
    if (args.boundaryIndex === null) return null
    // v1 never caches tool-enabled requests (request.ts already gates; this is
    // defense in depth against customBody-smuggled tools).
    if (args.body.tools !== undefined || args.body.toolConfig !== undefined) return null
    const key = buildGeminiCacheKey(args.cache.chatKey, args.cache.task, args.cache.presetId)
    if (isGeminiCacheSessionDisabled(key)) return null
    const cachedContentsUrl = deriveCachedContentsUrl(args.url)
    if (!cachedContentsUrl) return null
    // The cache resource's `model` field must match the chat call's model in the
    // endpoint's own shape (Studio "models/{id}" vs the Vertex resource path);
    // both are derived from the same chat URL the cachedContents URL came from.
    const cacheModel = deriveGeminiCacheModel(args.url, args.modelId)

    const client = createGeminiCachedContentsClient({
        cachedContentsUrl,
        headers: args.headers,
        fetchImpl: args.fetchImpl,
    })
    const now = Date.now()
    // For Vertex (google-service-account) credentialKey is the rotating OAuth
    // access token resolveAdapterCredential swapped in, not the SA identity —
    // a token refresh mid-TTL changes the fingerprint and forces a cache rebuild
    // (graceful: misses uncached, never deletes the remote cache). AI Studio keys
    // are stable, so this only affects Vertex caching effectiveness.
    const credentialFp = computeGeminiCredentialFp(args.credentialKey ?? '')
    const contents = Array.isArray(args.body.contents) ? (args.body.contents as unknown[]) : []
    const systemInstruction = args.body.systemInstruction

    const pre = evaluateGeminiCacheBeforeRequest({
        entry: getGeminiCacheEntry(key, now),
        now,
        modelId: args.modelId,
        credentialFp,
        boundaryIndex: args.boundaryIndex,
        systemInstruction,
        contents,
    })

    // Bump this chat's generation before the state mutations below, so any
    // still-running post-response from an earlier turn (which captured a lower
    // generation) skips its write rather than undoing what this turn does.
    const generation = bumpCacheKeyGeneration(key)

    let body = args.body
    let appliedCache = false
    if (pre.action === 'invalidate') {
        // Stored cache no longer matches: drop state, delete the remote cache in
        // the background, send uncached. Only prefix-mismatch counts toward the
        // consecutive-invalidation auto-off guard.
        if (pre.countsTowardGuard) bumpGeminiCacheInvalidationCount(key)
        removeGeminiCacheEntry(key)
        void client.remove(pre.staleCacheName)
    } else if (pre.action === 'apply') {
        // Empty-suffix guard: generateContent requires non-empty contents, so a
        // cache covering the entire prompt (e.g. a reroll whose cachePoint sits
        // on the last message) cannot be applied. Send uncached and keep the
        // entry — the next turn's longer prompt applies it normally.
        if (pre.boundaryIndex >= contents.length) return null
        body = applyGeminiCacheToBody(args.body, pre)
        appliedCache = true
    }

    return {
        body,
        appliedCache,
        invalidateAppliedCache: () => {
            // The applied cachedContent was rejected by the chat call (server
            // evicted it before the local expiry). Drop the local entry and the
            // remote cache so the next turn recreates it; the adapter retries
            // this turn uncached.
            if (!appliedCache || pre.action !== 'apply') return
            removeGeminiCacheEntry(key)
            void client.remove(pre.cacheName)
        },
        finish: (promptTokens) => {
            void runPostResponse({
                key,
                generation,
                pre,
                client,
                config,
                modelId: args.modelId,
                cacheModel,
                credentialFp,
                systemInstruction,
                contents,
                boundaryIndex: args.boundaryIndex,
                promptTokens,
            }).catch((err) => console.warn('[gemini-cache] post-response step failed', err))
        },
    }
}

// Per-key generation, bumped at the start of every participating turn. A detached
// post-response lifecycle captures the generation it ran under and commits cache
// state only while that generation is still current. A newer turn bumps the
// generation in its synchronous pre-request step (where it may invalidate/remove
// the cache), so a slower earlier turn's create/extend that resolves afterwards
// can neither resurrect a removed cache nor overwrite the newer turn's state.
// Unlike a simple in-flight lock this lets the NEWEST turn win, not whichever
// turn's lifecycle happened to start first.
const cacheKeyGeneration = new Map<string, number>()

function bumpCacheKeyGeneration(key: string): number {
    const next = (cacheKeyGeneration.get(key) ?? 0) + 1
    cacheKeyGeneration.set(key, next)
    return next
}

function isCacheKeyGenerationCurrent(key: string, generation: number): boolean {
    return (cacheKeyGeneration.get(key) ?? 0) === generation
}

// Test-only: drop the per-key generation map so each test starts clean.
export function resetGeminiCacheWiringRuntime(): void {
    cacheKeyGeneration.clear()
}

// Post-response side effects, driven by the pure after-response decision.
// Runs detached from the chat request; every cache API call resolves to a
// result object (the client never throws). `generation` is the value captured
// when this turn began; cache state is committed only while it stays current.
async function runPostResponse(args: {
    key: string
    generation: number
    pre: GeminiCachePreDecision
    client: GeminiCachedContentsClient
    config: ResolvedGeminiCacheConfig
    modelId: string
    cacheModel: string   // resource-name shape of modelId for the create body (Studio vs Vertex)
    credentialFp: string
    systemInstruction: unknown
    contents: readonly unknown[]
    boundaryIndex: number | null
    promptTokens: number | undefined
}): Promise<void> {
    const now = Date.now()
    const entry = getGeminiCacheEntry(args.key, now)
    const post = decideGeminiCacheAfterResponse({
        pre: args.pre,
        entry,
        now,
        promptTokens: args.promptTokens,
        boundaryIndex: args.boundaryIndex,
        consecutiveInvalidations: getGeminiCacheInvalidationCount(args.key),
        config: args.config,
    })
    if (post.resetInvalidations) resetGeminiCacheInvalidationCount(args.key)
    if (post.disableSession) disableGeminiCacheSession(args.key)
    if (post.extendTtl && entry) {
        const result = await args.client.extend(entry.cacheName, args.config.ttlSec)
        // Mirror the server's new expiry locally so the next pre-request check
        // sees the extended lifetime. Failures are ignored (next turn misses).
        // Commit only while this turn is still the newest: a later turn may have
        // removed this very entry while the PATCH was in flight — don't resurrect it.
        if (result.ok && isCacheKeyGenerationCurrent(args.key, args.generation)) {
            setGeminiCacheEntry(args.key, { ...entry, expiresAt: now + args.config.ttlSec * 1000 })
        }
    }
    if (post.create) {
        const boundaryIndex = post.create.boundaryIndex
        const result = await args.client.create(buildGeminiCacheCreateBody({
            model: args.cacheModel,
            ttlSec: args.config.ttlSec,
            systemInstruction: args.systemInstruction,
            contents: args.contents,
            boundaryIndex,
        }))
        // A newer turn superseded this one while the create was in flight — its
        // result (success OR failure) is moot. Don't touch session state; just
        // clean up any orphan cache this stale create produced. Checked BEFORE the
        // failure handling so a stale turn's 403 cannot disable the newest session
        // (which may use a different, working credential).
        if (!isCacheKeyGenerationCurrent(args.key, args.generation)) {
            if (result.ok && result.name) void args.client.remove(result.name)
            return
        }
        if (!result.ok || !result.name) {
            // The server is the authority on whether a create can succeed, so we
            // react to the failure's MEANING, not a status taxonomy: a 403 means
            // the project/key cannot use cachedContents at all → futile, disable
            // this session. Everything else is recoverable and must NOT penalize
            // the session — a "too small" 400 resolves as the prefix grows, and a
            // 5xx / 429 / timeout / network error can succeed next turn; caching
            // just skips this turn. (Prefix-mismatch invalidations are the only
            // thing that feeds the auto-off guard, handled in the pre-request step.)
            if (result.status === 403) {
                disableGeminiCacheSession(args.key, 'cache creation returned 403 (project/key cannot use cachedContents)')
            }
            console.warn('[gemini-cache] cache creation failed', result.status)
            return
        }
        setGeminiCacheEntry(args.key, buildGeminiCacheEntry({
            cacheName: result.name,
            modelId: args.modelId,
            now,
            ttlSec: args.config.ttlSec,
            expireTimeMs: result.expireTimeMs,
            boundaryIndex,
            prefixHash: computeGeminiPrefixHash(args.systemInstruction, args.contents, boundaryIndex),
            promptTokensAtCreation: args.promptTokens ?? 0,
            credentialFp: args.credentialFp,
        }))
        // One-active-cache invariant: the replaced cache is deleted only after
        // the new one is registered.
        if (post.create.replaceCacheName) void args.client.remove(post.create.replaceCacheName)
    }
}
