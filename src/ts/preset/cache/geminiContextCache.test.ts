import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
    GEMINI_CACHE_DEFAULTS,
    GEMINI_CACHE_INVALIDATION_LIMIT,
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
    resetGeminiContextCacheRuntime,
    resolveGeminiCacheConfig,
    setGeminiCacheEntry,
    type GeminiCachePreRequestInput,
    type GeminiCacheStateEntry,
    type ResolvedGeminiCacheConfig,
} from './geminiContextCache'
import { beginGeminiCacheTurn, resetGeminiCacheWiringRuntime } from './geminiCacheWiring'
import type { AdapterCacheContext } from '../adapter/types'

const STORAGE_KEY = 'nodeOnlyGeminiCacheState'
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const NOW = 1_750_000_000_000

function makeContents(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'model',
        parts: [{ text: `turn ${i}` }],
    }))
}

function makeEntry(overrides: Partial<GeminiCacheStateEntry> = {}): GeminiCacheStateEntry {
    const contents = makeContents(6)
    return {
        cacheName: 'cachedContents/abc123',
        modelId: 'gemini-demo',
        createdAt: NOW - 60_000,
        expiresAt: NOW + 300_000,
        boundaryIndex: 4,
        prefixHash: computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, contents, 4),
        promptTokensAtCreation: 10_000,
        credentialFp: 'fp-aaaa',
        ...overrides,
    }
}

function makePreInput(overrides: Partial<GeminiCachePreRequestInput> = {}): GeminiCachePreRequestInput {
    return {
        entry: makeEntry(),
        now: NOW,
        modelId: 'gemini-demo',
        credentialFp: 'fp-aaaa',
        boundaryIndex: 4,
        systemInstruction: { parts: [{ text: 'sys' }] },
        contents: makeContents(6),
        ...overrides,
    }
}

function makeConfig(overrides: Partial<ResolvedGeminiCacheConfig> = {}): ResolvedGeminiCacheConfig {
    return {
        ttlSec: 600,
        extendTtlOnHit: true,
        minPromptTokens: 4096,
        growthTokens: 4096,
        ...overrides,
    }
}

beforeEach(() => {
    localStorage.clear()
    resetGeminiContextCacheRuntime()
    resetGeminiCacheWiringRuntime()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('resolveGeminiCacheConfig', () => {
    test('disabled or missing config resolves to null', () => {
        expect(resolveGeminiCacheConfig(undefined)).toBeNull()
        expect(resolveGeminiCacheConfig(null)).toBeNull()
        expect(resolveGeminiCacheConfig({ enabled: false, ttlSec: 999 })).toBeNull()
    })

    test('enabled config fills defaults', () => {
        expect(resolveGeminiCacheConfig({ enabled: true })).toEqual({ ...GEMINI_CACHE_DEFAULTS })
    })

    test('overrides apply; non-positive values fall back to defaults', () => {
        expect(resolveGeminiCacheConfig({
            enabled: true,
            ttlSec: 1200,
            extendTtlOnHit: false,
            minPromptTokens: 0,
            growthTokens: -5,
        })).toEqual({
            ttlSec: 1200,
            extendTtlOnHit: false,
            minPromptTokens: GEMINI_CACHE_DEFAULTS.minPromptTokens,
            growthTokens: GEMINI_CACHE_DEFAULTS.growthTokens,
        })
    })
})

describe('hashing', () => {
    test('prefix hash is stable and 8 hex chars', () => {
        const contents = makeContents(6)
        const a = computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, contents, 4)
        const b = computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, makeContents(6), 4)
        expect(a).toBe(b)
        expect(a).toMatch(/^[0-9a-f]{8}$/)
    })

    test('prefix hash ignores contents past the boundary', () => {
        const short = makeContents(4)
        const long = [...makeContents(4), { role: 'user', parts: [{ text: 'new turn' }] }]
        expect(computeGeminiPrefixHash(undefined, short, 4)).toBe(computeGeminiPrefixHash(undefined, long, 4))
    })

    test('prefix hash changes when systemInstruction or a prefix message changes', () => {
        const contents = makeContents(6)
        const base = computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, contents, 4)
        expect(computeGeminiPrefixHash({ parts: [{ text: 'SYS!' }] }, contents, 4)).not.toBe(base)
        const edited = makeContents(6)
        ;(edited[1] as { parts: { text: string }[] }).parts[0].text = 'edited'
        expect(computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, edited, 4)).not.toBe(base)
    })

    test('credential fingerprint differs per key and is 8 hex chars', () => {
        const a = computeGeminiCredentialFp('key-one')
        const b = computeGeminiCredentialFp('key-two')
        expect(a).toMatch(/^[0-9a-f]{8}$/)
        expect(a).not.toBe(b)
        expect(computeGeminiCredentialFp('key-one')).toBe(a)
    })
})

describe('evaluateGeminiCacheBeforeRequest', () => {
    test('no cachePoint in the request bypasses caching entirely', () => {
        expect(evaluateGeminiCacheBeforeRequest(makePreInput({ boundaryIndex: null })))
            .toEqual({ action: 'bypass', reason: 'no-cache-point' })
    })

    test('no stored state is a miss', () => {
        expect(evaluateGeminiCacheBeforeRequest(makePreInput({ entry: undefined })))
            .toEqual({ action: 'miss', reason: 'no-state' })
    })

    test('expiry boundary: expiresAt == now misses, one ms earlier applies', () => {
        const expired = makePreInput({ entry: makeEntry({ expiresAt: NOW }) })
        expect(evaluateGeminiCacheBeforeRequest(expired)).toEqual({ action: 'miss', reason: 'expired' })
        const alive = makePreInput({ entry: makeEntry({ expiresAt: NOW + 1 }) })
        expect(evaluateGeminiCacheBeforeRequest(alive).action).toBe('apply')
    })

    test('model mismatch misses', () => {
        expect(evaluateGeminiCacheBeforeRequest(makePreInput({ modelId: 'gemini-other' })))
            .toEqual({ action: 'miss', reason: 'model-mismatch' })
    })

    test('credential rotation misses', () => {
        expect(evaluateGeminiCacheBeforeRequest(makePreInput({ credentialFp: 'fp-bbbb' })))
            .toEqual({ action: 'miss', reason: 'credential-mismatch' })
    })

    test('stored boundary beyond current contents invalidates without counting toward the guard', () => {
        const input = makePreInput({ contents: makeContents(3) })
        expect(evaluateGeminiCacheBeforeRequest(input)).toEqual({
            action: 'invalidate',
            reason: 'boundary-out-of-range',
            staleCacheName: 'cachedContents/abc123',
            countsTowardGuard: false,
        })
    })

    test('boundary == contents length still applies (empty suffix)', () => {
        const contents = makeContents(4)
        const entry = makeEntry({
            boundaryIndex: 4,
            prefixHash: computeGeminiPrefixHash({ parts: [{ text: 'sys' }] }, contents, 4),
        })
        const decision = evaluateGeminiCacheBeforeRequest(makePreInput({ entry, contents }))
        expect(decision).toEqual({ action: 'apply', cacheName: 'cachedContents/abc123', boundaryIndex: 4 })
    })

    test('prefix hash mismatch invalidates and counts toward the guard', () => {
        const input = makePreInput({ systemInstruction: { parts: [{ text: 'changed sys' }] } })
        expect(evaluateGeminiCacheBeforeRequest(input)).toEqual({
            action: 'invalidate',
            reason: 'prefix-mismatch',
            staleCacheName: 'cachedContents/abc123',
            countsTowardGuard: true,
        })
    })

    test('valid state applies with the stored cacheName and boundary', () => {
        expect(evaluateGeminiCacheBeforeRequest(makePreInput())).toEqual({
            action: 'apply',
            cacheName: 'cachedContents/abc123',
            boundaryIndex: 4,
        })
    })

    test('does not mutate its input', () => {
        const input = makePreInput()
        const snapshot = JSON.parse(JSON.stringify(input))
        evaluateGeminiCacheBeforeRequest(input)
        expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
    })
})

describe('decideGeminiCacheAfterResponse', () => {
    const apply = { action: 'apply', cacheName: 'cachedContents/abc123', boundaryIndex: 4 } as const
    const miss = { action: 'miss', reason: 'no-state' } as const

    test('fresh hit: reset invalidations, no extend while more than half the TTL remains', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ expiresAt: NOW + 300_001 }),
            now: NOW,
            promptTokens: 11_000,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision).toEqual({
            resetInvalidations: true,
            disableSession: false,
            extendTtl: false,
            create: null,
            reason: 'hit-fresh',
        })
    })

    test('hit extends only when remaining TTL drops below half', () => {
        const config = makeConfig()
        const atHalf = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ expiresAt: NOW + 300_000 }),
            now: NOW,
            promptTokens: 11_000,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config,
        })
        expect(atHalf.extendTtl).toBe(false)
        const belowHalf = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ expiresAt: NOW + 299_999 }),
            now: NOW,
            promptTokens: 11_000,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config,
        })
        expect(belowHalf.extendTtl).toBe(true)
        expect(belowHalf.reason).toBe('hit-extend')
    })

    test('hit never extends when extendTtlOnHit is off', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ expiresAt: NOW + 1000 }),
            now: NOW,
            promptTokens: 11_000,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig({ extendTtlOnHit: false }),
        })
        expect(decision.extendTtl).toBe(false)
        expect(decision.reason).toBe('hit-fresh')
    })

    test('hit past the growth threshold recreates at the current boundary', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ promptTokensAtCreation: 10_000 }),
            now: NOW,
            promptTokens: 14_096,
            boundaryIndex: 6,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision).toEqual({
            resetInvalidations: true,
            disableSession: false,
            extendTtl: false,
            create: { boundaryIndex: 6, replaceCacheName: 'cachedContents/abc123' },
            reason: 'hit-regrow',
        })
    })

    test('hit past the growth threshold does NOT recreate when the cachePoint did not advance', () => {
        // Fixed cachePoint (boundary stays at the cached entry's 4) with a growing
        // suffix: the prefix is identical, so re-caching it is wasteful. Must fall
        // through to a plain hit, never a regrow — even well past the token threshold.
        const decision = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ promptTokensAtCreation: 10_000, boundaryIndex: 4, expiresAt: NOW + 400_000 }),
            now: NOW,
            promptTokens: 20_000,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toBeNull()
        expect(decision.reason).toBe('hit-fresh')
    })

    test('hit just below the growth threshold does not recreate', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: apply,
            entry: makeEntry({ promptTokensAtCreation: 10_000, expiresAt: NOW + 400_000 }),
            now: NOW,
            promptTokens: 14_095,
            boundaryIndex: 6,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toBeNull()
        expect(decision.reason).toBe('hit-fresh')
    })

    test('miss without usage does nothing', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: miss,
            entry: undefined,
            now: NOW,
            promptTokens: undefined,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toBeNull()
        expect(decision.reason).toBe('no-usage')
    })

    test('miss below minPromptTokens does not create', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: miss,
            entry: undefined,
            now: NOW,
            promptTokens: 4095,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toBeNull()
        expect(decision.reason).toBe('below-min-tokens')
        const atMin = decideGeminiCacheAfterResponse({
            pre: miss,
            entry: undefined,
            now: NOW,
            promptTokens: 4096,
            boundaryIndex: 4,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(atMin.reason).toBe('create')
    })

    test('invalidation guard fires at the limit instead of creating', () => {
        const below = decideGeminiCacheAfterResponse({
            pre: miss,
            entry: undefined,
            now: NOW,
            promptTokens: 10_000,
            boundaryIndex: 4,
            consecutiveInvalidations: GEMINI_CACHE_INVALIDATION_LIMIT - 1,
            config: makeConfig(),
        })
        expect(below.disableSession).toBe(false)
        expect(below.reason).toBe('create')
        const atLimit = decideGeminiCacheAfterResponse({
            pre: miss,
            entry: undefined,
            now: NOW,
            promptTokens: 10_000,
            boundaryIndex: 4,
            consecutiveInvalidations: GEMINI_CACHE_INVALIDATION_LIMIT,
            config: makeConfig(),
        })
        expect(atLimit).toEqual({
            resetInvalidations: false,
            disableSession: true,
            extendTtl: false,
            create: null,
            reason: 'invalidation-guard',
        })
    })

    test('miss without a cachePoint does not create', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: { action: 'bypass', reason: 'no-cache-point' },
            entry: undefined,
            now: NOW,
            promptTokens: 10_000,
            boundaryIndex: null,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toBeNull()
        expect(decision.reason).toBe('no-cache-point')
    })

    test('miss with surviving entry replaces its cacheName on create', () => {
        const decision = decideGeminiCacheAfterResponse({
            pre: { action: 'miss', reason: 'credential-mismatch' },
            entry: makeEntry(),
            now: NOW,
            promptTokens: 10_000,
            boundaryIndex: 5,
            consecutiveInvalidations: 0,
            config: makeConfig(),
        })
        expect(decision.create).toEqual({ boundaryIndex: 5, replaceCacheName: 'cachedContents/abc123' })
    })
})

describe('body transforms', () => {
    test('applyGeminiCacheToBody sets cachedContent, slices the suffix, strips cached fields', () => {
        const contents = makeContents(6)
        const body: Record<string, unknown> = {
            contents,
            systemInstruction: { parts: [{ text: 'sys' }] },
            tools: [{ functionDeclarations: [] }],
            toolConfig: { mode: 'AUTO' },
            generationConfig: { temperature: 1 },
        }
        const next = applyGeminiCacheToBody(body, { cacheName: 'cachedContents/abc123', boundaryIndex: 4 })
        expect(next['cachedContent']).toBe('cachedContents/abc123')
        expect(next['contents']).toEqual(contents.slice(4))
        expect(next).not.toHaveProperty('systemInstruction')
        expect(next).not.toHaveProperty('tools')
        expect(next).not.toHaveProperty('toolConfig')
        expect(next['generationConfig']).toEqual({ temperature: 1 })
    })

    test('applyGeminiCacheToBody does not mutate the original body', () => {
        const body: Record<string, unknown> = {
            contents: makeContents(6),
            systemInstruction: { parts: [{ text: 'sys' }] },
        }
        const snapshot = JSON.parse(JSON.stringify(body))
        applyGeminiCacheToBody(body, { cacheName: 'cachedContents/abc123', boundaryIndex: 4 })
        expect(JSON.parse(JSON.stringify(body))).toEqual(snapshot)
    })

    test('boundary == contents length yields an empty suffix', () => {
        const next = applyGeminiCacheToBody(
            { contents: makeContents(4) },
            { cacheName: 'cachedContents/abc123', boundaryIndex: 4 },
        )
        expect(next['contents']).toEqual([])
    })

    test('buildGeminiCacheCreateBody shapes the creation payload', () => {
        const contents = makeContents(6)
        const body = buildGeminiCacheCreateBody({
            model: 'models/gemini-demo',
            ttlSec: 600,
            systemInstruction: { parts: [{ text: 'sys' }] },
            contents,
            boundaryIndex: 4,
        })
        expect(body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'sys' }] },
            contents: contents.slice(0, 4),
        })
        expect(contents).toHaveLength(6)
    })

    test('buildGeminiCacheCreateBody passes a Vertex resource-name model through verbatim', () => {
        const body = buildGeminiCacheCreateBody({
            model: 'projects/my-proj/locations/global/publishers/google/models/gemini-3-flash-preview',
            ttlSec: 600,
            contents: makeContents(4),
            boundaryIndex: 4,
        })
        expect(body['model']).toBe(
            'projects/my-proj/locations/global/publishers/google/models/gemini-3-flash-preview',
        )
    })

    test('buildGeminiCacheCreateBody omits systemInstruction when absent', () => {
        const body = buildGeminiCacheCreateBody({
            model: 'models/gemini-demo',
            ttlSec: 600,
            contents: makeContents(4),
            boundaryIndex: 4,
        })
        expect(body).not.toHaveProperty('systemInstruction')
    })
})

describe('deriveCachedContentsUrl', () => {
    test('converts generateContent and stream URLs', () => {
        expect(deriveCachedContentsUrl('https://demo.test/v1beta/models/gemini-demo:generateContent'))
            .toBe('https://demo.test/v1beta/cachedContents')
        expect(deriveCachedContentsUrl('https://demo.test/v1beta/models/gemini-demo:streamGenerateContent?alt=sse'))
            .toBe('https://demo.test/v1beta/cachedContents')
    })

    test('converts the bare models base', () => {
        expect(deriveCachedContentsUrl('https://demo.test/v1beta/models'))
            .toBe('https://demo.test/v1beta/cachedContents')
    })

    test('returns null for unrecognized shapes', () => {
        expect(deriveCachedContentsUrl('https://demo.test/v1/chat/completions')).toBeNull()
    })

    test('roots a global Vertex URL at the location, not the publisher', () => {
        const url = 'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global'
            + '/publishers/google/models/gemini-3-flash-preview:generateContent'
        expect(deriveCachedContentsUrl(url))
            .toBe('https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/cachedContents')
    })

    test('handles a regional Vertex host and the stream suffix', () => {
        const url = 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1'
            + '/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse'
        expect(deriveCachedContentsUrl(url))
            .toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/cachedContents')
    })

    test('converts the bare Vertex publisher base', () => {
        const url = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models'
        expect(deriveCachedContentsUrl(url))
            .toBe('https://aiplatform.googleapis.com/v1/projects/p/locations/global/cachedContents')
    })
})

describe('deriveGeminiCacheModel', () => {
    test('Studio shape returns models/{id}', () => {
        expect(deriveGeminiCacheModel('https://demo.test/v1beta/models/gemini-demo:generateContent', 'gemini-demo'))
            .toBe('models/gemini-demo')
        expect(deriveGeminiCacheModel('https://demo.test/v1beta/models', 'gemini-demo'))
            .toBe('models/gemini-demo')
    })

    test('Vertex shape returns the full resource path from the URL', () => {
        const url = 'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global'
            + '/publishers/google/models/gemini-3-flash-preview:generateContent'
        expect(deriveGeminiCacheModel(url, 'gemini-3-flash-preview'))
            .toBe('projects/my-proj/locations/global/publishers/google/models/gemini-3-flash-preview')
    })

    test('Vertex stream suffix and regional host still yield the resource path', () => {
        const url = 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1'
            + '/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse'
        expect(deriveGeminiCacheModel(url, 'gemini-3.1-pro-preview'))
            .toBe('projects/p/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview')
    })

    test('falls back to models/{id} when the Vertex path lacks a /projects/ segment', () => {
        // Defensive: a publisher marker without a parseable resource root must
        // not produce a broken resource path — degrade to the Studio shape.
        const url = 'https://aiplatform.googleapis.com/publishers/google/models/gemini-demo:generateContent'
        expect(deriveGeminiCacheModel(url, 'gemini-demo')).toBe('models/gemini-demo')
    })

    test('Vertex resource path is version-agnostic (v1beta1 still parses)', () => {
        // The derivation keys off "/projects/", not a literal "/v1/", so a
        // user-edited endpoint on a different API version still yields the full
        // resource name (matching deriveCachedContentsUrl's invariant).
        const url = 'https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global'
            + '/publishers/google/models/gemini-3-flash-preview:generateContent'
        expect(deriveGeminiCacheModel(url, 'gemini-3-flash-preview'))
            .toBe('projects/my-proj/locations/global/publishers/google/models/gemini-3-flash-preview')
    })
})

describe('state store', () => {
    test('set/get roundtrip mirrors to localStorage', () => {
        const key = buildGeminiCacheKey('chat-1', 'model', 'preset-1')
        const entry = makeEntry()
        setGeminiCacheEntry(key, entry)
        expect(getGeminiCacheEntry(key, NOW)).toEqual(entry)
        const mirrored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
        expect(mirrored[key]).toEqual(entry)
    })

    test('remove deletes the entry and the mirror copy', () => {
        const key = buildGeminiCacheKey('chat-1', 'model', 'preset-1')
        setGeminiCacheEntry(key, makeEntry())
        removeGeminiCacheEntry(key)
        expect(getGeminiCacheEntry(key, NOW)).toBeUndefined()
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({})
    })

    test('expired entry is pruned on read', () => {
        const key = buildGeminiCacheKey('chat-1', 'model', 'preset-1')
        setGeminiCacheEntry(key, makeEntry({ expiresAt: NOW }))
        expect(getGeminiCacheEntry(key, NOW)).toBeUndefined()
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({})
    })

    test('mirror load skips expired and malformed entries', () => {
        const live = makeEntry({ expiresAt: Date.now() + 600_000 })
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            'chat-live::model::p1': live,
            'chat-expired::model::p1': makeEntry({ expiresAt: 1 }),
            'chat-bad::model::p1': { cacheName: 42 },
        }))
        resetGeminiContextCacheRuntime()
        expect(getGeminiCacheEntry('chat-live::model::p1')).toEqual(live)
        expect(getGeminiCacheEntry('chat-expired::model::p1')).toBeUndefined()
        expect(getGeminiCacheEntry('chat-bad::model::p1')).toBeUndefined()
    })

    test('corrupt mirror JSON is ignored without throwing', () => {
        localStorage.setItem(STORAGE_KEY, 'not json{{')
        resetGeminiContextCacheRuntime()
        expect(getGeminiCacheEntry('any::model::p1')).toBeUndefined()
    })

    test('localStorage write failure is harmless', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })
        const key = buildGeminiCacheKey('chat-1', 'model', 'preset-1')
        const entry = makeEntry()
        expect(() => setGeminiCacheEntry(key, entry)).not.toThrow()
        // in-memory map stays authoritative
        expect(getGeminiCacheEntry(key, NOW)).toEqual(entry)
    })

    test('buildGeminiCacheEntry prefers server expireTime over local ttl', () => {
        const base = {
            cacheName: 'cachedContents/new',
            modelId: 'gemini-demo',
            now: NOW,
            ttlSec: 600,
            boundaryIndex: 4,
            prefixHash: 'deadbeef',
            promptTokensAtCreation: 9000,
            credentialFp: 'fp-aaaa',
        }
        expect(buildGeminiCacheEntry(base).expiresAt).toBe(NOW + 600_000)
        expect(buildGeminiCacheEntry({ ...base, expireTimeMs: NOW + 123_000 }).expiresAt).toBe(NOW + 123_000)
    })

    test('buildGeminiCacheKey joins with ::', () => {
        expect(buildGeminiCacheKey('chat-1', 'model', 'preset-1')).toBe('chat-1::model::preset-1')
    })
})

describe('session guards', () => {
    test('invalidation count bumps, reads, and resets', () => {
        const key = 'chat-1::model::p1'
        expect(getGeminiCacheInvalidationCount(key)).toBe(0)
        expect(bumpGeminiCacheInvalidationCount(key)).toBe(1)
        expect(bumpGeminiCacheInvalidationCount(key)).toBe(2)
        expect(getGeminiCacheInvalidationCount(key)).toBe(2)
        resetGeminiCacheInvalidationCount(key)
        expect(getGeminiCacheInvalidationCount(key)).toBe(0)
    })

    test('invalidation count is in-memory only: a reload starts the guard at zero', () => {
        // The guard lives only in memory, so a restart cannot resurrect a stale
        // count and disable caching early. Nothing about it is persisted.
        const key = 'chat-1::model::p1'
        bumpGeminiCacheInvalidationCount(key)
        bumpGeminiCacheInvalidationCount(key)
        expect(getGeminiCacheInvalidationCount(key)).toBe(2)
        resetGeminiContextCacheRuntime()
        expect(getGeminiCacheInvalidationCount(key)).toBe(0)
    })

    test('disableGeminiCacheSession warns once per key', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const key = 'chat-1::model::p1'
        expect(isGeminiCacheSessionDisabled(key)).toBe(false)
        disableGeminiCacheSession(key)
        disableGeminiCacheSession(key)
        expect(isGeminiCacheSessionDisabled(key)).toBe(true)
        expect(warn).toHaveBeenCalledTimes(1)
    })
})

describe('cachedContents REST client', () => {
    interface CapturedCall {
        url: string
        method: string
        headers: Record<string, string>
        body: Record<string, unknown> | undefined
    }

    function captureFetch(response: Response | (() => Response)): {
        fetchImpl: typeof fetch
        calls: CapturedCall[]
    } {
        const calls: CapturedCall[] = []
        const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            calls.push({
                url,
                method: (init?.method ?? 'GET') as string,
                headers: (init?.headers ?? {}) as Record<string, string>,
                body: init?.body != null ? JSON.parse(init.body as string) : undefined,
            })
            return typeof response === 'function' ? response() : response
        }
        return { fetchImpl, calls }
    }

    function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status })
    }

    const clientOpts = {
        cachedContentsUrl: 'https://demo.test/v1beta/cachedContents',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'secret' },
    }

    test('create POSTs the body with injected headers and parses name/expireTime', async () => {
        const { fetchImpl, calls } = captureFetch(jsonResponse({
            name: 'cachedContents/new1',
            expireTime: new Date(NOW + 600_000).toISOString(),
        }))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        const result = await client.create({ model: 'models/gemini-demo', ttl: '600s', contents: [] })
        expect(result).toEqual({
            ok: true,
            status: 200,
            name: 'cachedContents/new1',
            expireTimeMs: NOW + 600_000,
        })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://demo.test/v1beta/cachedContents')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].headers['x-goog-api-key']).toBe('secret')
        expect(calls[0].body).toEqual({ model: 'models/gemini-demo', ttl: '600s', contents: [] })
    })

    test('create without expireTime omits expireTimeMs', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ name: 'cachedContents/new1' }))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        const result = await client.create({})
        expect(result.ok).toBe(true)
        expect(result.expireTimeMs).toBeUndefined()
    })

    test('create surfaces HTTP failure as ok:false with status', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ error: { message: 'too small' } }, 400))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        expect(await client.create({})).toEqual({ ok: false, status: 400 })
    })

    test('create never throws on network failure', async () => {
        const fetchImpl: typeof fetch = async () => {
            throw new Error('network down')
        }
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        expect(await client.create({})).toEqual({ ok: false })
    })

    test('create with a malformed response body is ok:false', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ unexpected: true }))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        expect(await client.create({})).toEqual({ ok: false, status: 200 })
    })

    test('extend PATCHes the resource URL with the ttl body', async () => {
        const { fetchImpl, calls } = captureFetch(jsonResponse({ name: 'cachedContents/abc123' }))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        const result = await client.extend('cachedContents/abc123', 900)
        expect(result).toEqual({ ok: true, status: 200 })
        expect(calls[0].url).toBe('https://demo.test/v1beta/cachedContents/abc123')
        expect(calls[0].method).toBe('PATCH')
        expect(calls[0].body).toEqual({ ttl: '900s' })
    })

    test('extend appends ?updateMask=ttl on Vertex (required) but not on AI Studio', async () => {
        const vertexUrl = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/cachedContents'
        const { fetchImpl, calls } = captureFetch(jsonResponse({}))
        const client = createGeminiCachedContentsClient({
            ...clientOpts,
            cachedContentsUrl: vertexUrl,
            fetchImpl,
        })
        await client.extend('cachedContents/abc123', 600)
        // Vertex cachedContents.patch 400s without updateMask.
        expect(calls[0].url).toBe(`${vertexUrl}/abc123?updateMask=ttl`)
        expect(calls[0].method).toBe('PATCH')
    })

    test('extend detects Vertex by path so a proxy/PSC endpoint host still gets updateMask', async () => {
        // endpointUrl override can route Vertex through a non-aiplatform host;
        // the Vertex resource PATH (/locations/.../cachedContents) is what counts.
        const proxyUrl = 'https://vertex.internal.example/v1/projects/p/locations/global/cachedContents'
        const { fetchImpl, calls } = captureFetch(jsonResponse({}))
        const client = createGeminiCachedContentsClient({
            ...clientOpts,
            cachedContentsUrl: proxyUrl,
            fetchImpl,
        })
        await client.extend('cachedContents/abc123', 600)
        expect(calls[0].url).toBe(`${proxyUrl}/abc123?updateMask=ttl`)
    })

    test('remove DELETEs the resource URL without a body', async () => {
        const { fetchImpl, calls } = captureFetch(jsonResponse({}))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        const result = await client.remove('cachedContents/abc123')
        expect(result).toEqual({ ok: true, status: 200 })
        expect(calls[0].url).toBe('https://demo.test/v1beta/cachedContents/abc123')
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].body).toBeUndefined()
    })

    test('extend/remove surface 404 status for expired-cache classification', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ error: {} }, 404))
        const client = createGeminiCachedContentsClient({ ...clientOpts, fetchImpl })
        expect(await client.extend('cachedContents/gone', 600)).toEqual({ ok: false, status: 404 })
        expect(await client.remove('cachedContents/gone')).toEqual({ ok: false, status: 404 })
    })
})

// Reproduces the stale-write race the in-flight lock could not prevent: an
// earlier turn's detached create/extend resolves AFTER a newer turn has already
// invalidated/removed the cache. The per-key generation guard must make the
// newer turn win — no resurrection, no double count, no orphan left behind.
describe('beginGeminiCacheTurn — stale-write race (generation guard)', () => {
    const CHAT_URL = 'https://demo.test/v1beta/models/gemini-demo:generateContent'
    const sys = { parts: [{ text: 'sys' }] }

    function makeCache(chatKey: string): AdapterCacheContext {
        return { promptCaching: { enabled: true, ttlSec: 600 }, chatKey, task: 'model', presetId: 'preset-1' }
    }
    function startTurn(chatKey: string, contents: unknown[], fetchImpl: typeof fetch) {
        return beginGeminiCacheTurn({
            cache: makeCache(chatKey),
            url: CHAT_URL,
            headers: { 'x-goog-api-key': 'secret' },
            body: { systemInstruction: sys, contents },
            modelId: 'gemini-demo',
            credentialKey: 'key1',
            boundaryIndex: 2,
            fetchImpl,
        })
    }

    test('a late TTL-extend from an earlier turn does not resurrect a cache a newer turn removed', async () => {
        const key = buildGeminiCacheKey('chat-race-1', 'model', 'preset-1')
        const contents1 = makeContents(4)
        // Seed a valid, near-expiry cache matching turn 1's prefix → forces extend.
        setGeminiCacheEntry(key, {
            cacheName: 'cachedContents/A',
            modelId: 'gemini-demo',
            createdAt: Date.now() - 10_000,
            expiresAt: Date.now() + 100_000,   // < ttl/2 → extend on hit
            boundaryIndex: 2,
            prefixHash: computeGeminiPrefixHash(sys, contents1, 2),
            promptTokensAtCreation: 10_000,
            credentialFp: computeGeminiCredentialFp('key1'),
        })

        // Hold the PATCH (extend) open until we release it.
        let releaseExtend!: () => void
        const extendGate = new Promise<void>((r) => { releaseExtend = r })
        const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'PATCH') await extendGate
            return new Response('{}', { status: 200 })
        }) as typeof fetch

        const turn1 = startTurn('chat-race-1', contents1, fetchImpl)
        expect(turn1?.appliedCache).toBe(true)           // hit on A
        turn1!.finish(10_000)                            // kicks off the held extend
        await Promise.resolve()

        // Turn 2: a DIFFERENT prefix → mismatch → removes A, counts the guard once.
        const contents2 = [{ role: 'user', parts: [{ text: 'CHANGED' }] }, ...contents1.slice(1)]
        const turn2 = startTurn('chat-race-1', contents2, fetchImpl)
        expect(turn2?.appliedCache).toBe(false)          // miss (A was removed)
        expect(getGeminiCacheEntry(key)).toBeUndefined()
        expect(getGeminiCacheInvalidationCount(key)).toBe(1)

        // Earlier turn's PATCH finally resolves — must NOT re-write A.
        releaseExtend()
        await flushMicrotasks()
        expect(getGeminiCacheEntry(key)).toBeUndefined()      // not resurrected
        expect(getGeminiCacheInvalidationCount(key)).toBe(1)  // not double-counted
    })

    test('a late create from a superseded turn is discarded and its orphan deleted', async () => {
        const key = buildGeminiCacheKey('chat-race-2', 'model', 'preset-1')
        const contents1 = makeContents(4)

        let releaseCreate!: () => void
        const createGate = new Promise<void>((r) => { releaseCreate = r })
        const seen: { method: string; url: string }[] = []
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            seen.push({ method, url: String(input) })
            if (method === 'POST') await createGate
            return new Response(JSON.stringify({ name: 'cachedContents/B' }), { status: 200 })
        }) as typeof fetch

        const turn1 = startTurn('chat-race-2', contents1, fetchImpl)
        expect(turn1?.appliedCache).toBe(false)          // miss → will create
        turn1!.finish(10_000)                            // 10k ≥ minPromptTokens → create (held)
        await Promise.resolve()

        // A newer turn starts (bumps the generation); we don't finish it.
        startTurn('chat-race-2', contents1, fetchImpl)

        releaseCreate()
        await flushMicrotasks()
        // Turn 1's create resolved stale → no entry, and B is deleted remotely.
        expect(getGeminiCacheEntry(key)).toBeUndefined()
        expect(seen.some((c) => c.method === 'DELETE' && c.url.includes('B'))).toBe(true)
    })

    test('a late 403 from a superseded turn does not disable the newest session', async () => {
        const key = buildGeminiCacheKey('chat-race-3', 'model', 'preset-1')
        const contents1 = makeContents(4)

        let release403!: () => void
        const gate = new Promise<void>((r) => { release403 = r })
        const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'POST') { await gate; return new Response('{}', { status: 403 }) }
            return new Response('{}', { status: 200 })
        }) as typeof fetch

        const turn1 = startTurn('chat-race-3', contents1, fetchImpl)
        turn1!.finish(10_000)                            // miss → create (held, will 403)
        await Promise.resolve()
        startTurn('chat-race-3', contents1, fetchImpl)   // newer turn bumps the generation

        release403()
        await flushMicrotasks()
        // The 403 belongs to the superseded turn — it must NOT kill the newest
        // session (which may use a different, working credential).
        expect(isGeminiCacheSessionDisabled(key)).toBe(false)
    })
})
