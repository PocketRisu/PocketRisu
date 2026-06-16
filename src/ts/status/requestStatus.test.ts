import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
    addBadge,
    appendText,
    clearStatus,
    computeTokPerSec,
    endStatus,
    isTerminalPhase,
    markPhase,
    recomputeEntry,
    requestStatuses,
    setStatusTokenCounter,
    startStatus,
    startStatusTimer,
    stopStatusTimer,
    trimSamples,
    type RequestStatusEntry,
    STALL_THRESHOLD_MS,
    TOK_PER_SEC_WINDOW_MS,
    STATUS_ABANDON_MS,
} from './requestStatus'

beforeEach(() => {
    requestStatuses.set(new Map())
    setStatusTokenCounter(null)
})
afterEach(() => {
    stopStatusTimer()
    setStatusTokenCounter(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function makeEntry(over: Partial<RequestStatusEntry> = {}): RequestStatusEntry {
    return {
        id: 'g1',
        kind: 'main',
        label: 'preset',
        phase: 'responding',
        thinkingTokens: 0,
        responseTokens: 0,
        tokPerSec: 0,
        startedAt: 0,
        lastChunkAt: 0,
        badges: [],
        thinkingText: '',
        responseText: '',
        textDirty: false,
        tokenSamples: [],
        ...over,
    }
}

describe('computeTokPerSec', () => {
    it('returns 0 with fewer than two in-window samples', () => {
        expect(computeTokPerSec([], 1000)).toBe(0)
        expect(computeTokPerSec([{ at: 1000, tokens: 5 }], 1000)).toBe(0)
    })

    it('averages over the trailing window', () => {
        // 100 tokens gained over 2s → 50 tok/s
        const samples = [{ at: 0, tokens: 0 }, { at: 2000, tokens: 100 }]
        expect(computeTokPerSec(samples, 2000)).toBe(50)
    })

    it('ignores samples older than the window', () => {
        const samples = [
            { at: 0, tokens: 0 },       // outside a 3s window at now=5000
            { at: 3000, tokens: 30 },
            { at: 5000, tokens: 130 },
        ]
        // in-window = [3000:30, 5000:130] → 100 tokens / 2s = 50
        expect(computeTokPerSec(samples, 5000, TOK_PER_SEC_WINDOW_MS)).toBe(50)
    })

    it('returns 0 when token count did not grow (e.g. paused)', () => {
        const samples = [{ at: 0, tokens: 50 }, { at: 1000, tokens: 50 }]
        expect(computeTokPerSec(samples, 1000)).toBe(0)
    })
})

describe('trimSamples', () => {
    it('drops out-of-window samples', () => {
        const samples = [{ at: 0, tokens: 0 }, { at: 4000, tokens: 40 }]
        expect(trimSamples(samples, 5000, 3000)).toEqual([{ at: 4000, tokens: 40 }])
    })

    it('keeps the latest sample even if everything is out of window', () => {
        const samples = [{ at: 0, tokens: 0 }, { at: 100, tokens: 10 }]
        expect(trimSamples(samples, 10000, 3000)).toEqual([{ at: 100, tokens: 10 }])
    })

    it('returns empty for empty input', () => {
        expect(trimSamples([], 1000)).toEqual([])
    })
})

describe('recomputeEntry', () => {
    it('does not mutate the input entry', () => {
        const e = makeEntry({ tokenSamples: [{ at: 0, tokens: 0 }, { at: 1000, tokens: 50 }] })
        const snapshot = JSON.parse(JSON.stringify(e))
        recomputeEntry(e, 1000)
        expect(e).toEqual(snapshot)
    })

    it('flips a live receiving phase to stalled after the threshold', () => {
        const e = makeEntry({ phase: 'responding', lastChunkAt: 0 })
        const re = recomputeEntry(e, STALL_THRESHOLD_MS + 1)
        expect(re.phase).toBe('stalled')
    })

    it('does not flip connecting to stalled (no chunk expected yet)', () => {
        const e = makeEntry({ phase: 'connecting', lastChunkAt: 0 })
        const re = recomputeEntry(e, STALL_THRESHOLD_MS + 1)
        expect(re.phase).toBe('connecting')
    })

    it('leaves terminal entries frozen', () => {
        const e = makeEntry({ phase: 'done', lastChunkAt: 0, tokPerSec: 42 })
        const re = recomputeEntry(e, STALL_THRESHOLD_MS + 9999)
        expect(re).toBe(e)
    })
})

describe('isTerminalPhase', () => {
    it('classifies terminal vs live', () => {
        expect(isTerminalPhase('done')).toBe(true)
        expect(isTerminalPhase('failed')).toBe(true)
        expect(isTerminalPhase('aborted')).toBe(true)
        expect(isTerminalPhase('connecting')).toBe(false)
        expect(isTerminalPhase('stalled')).toBe(false)
    })
})

describe('publish API', () => {
    it('startStatus creates an entry', () => {
        startStatus('g1', { kind: 'main', label: 'gpt', chatId: 'c1', now: 100 })
        const e = get(requestStatuses).get('g1')!
        expect(e.phase).toBe('connecting')
        expect(e.label).toBe('gpt')
        expect(e.chatId).toBe('c1')
        expect(e.startedAt).toBe(100)
    })

    it('markPhase increments retryAttempt only on retrying', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        markPhase('g1', 'thinking', 10)
        expect(get(requestStatuses).get('g1')!.retryAttempt).toBeUndefined()
        markPhase('g1', 'retrying', 20)
        markPhase('g1', 'retrying', 30)
        expect(get(requestStatuses).get('g1')!.retryAttempt).toBe(2)
    })

    it('appendText accumulates thinking and response text separately', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { thinking: 'ab' }, 10)
        appendText('g1', { response: 'cd' }, 20)
        appendText('g1', { response: 'ef' }, 30)
        const e = get(requestStatuses).get('g1')!
        expect(e.thinkingText).toBe('ab')
        expect(e.responseText).toBe('cdef')
        expect(e.textDirty).toBe(true)
    })

    it('appendText sets phase from the kind of text (thinking → responding)', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { thinking: 'a' }, 10)
        expect(get(requestStatuses).get('g1')!.phase).toBe('thinking')
        appendText('g1', { response: 'b' }, 20)
        expect(get(requestStatuses).get('g1')!.phase).toBe('responding')
    })

    it('appendText recovers from stalled when a chunk resumes', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { response: 'a' }, 10)
        // Simulate the tick flipping it to stalled on a quiet gap.
        markPhase('g1', 'stalled', 20)
        expect(get(requestStatuses).get('g1')!.phase).toBe('stalled')
        // Next chunk must restore the live phase.
        appendText('g1', { response: 'b' }, 30)
        expect(get(requestStatuses).get('g1')!.phase).toBe('responding')
    })

    it('appendText is a no-op on a terminal entry', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        endStatus('g1', 'done', { now: 10 })
        appendText('g1', { response: 'late' }, 20)
        const e = get(requestStatuses).get('g1')!
        expect(e.phase).toBe('done')
        expect(e.responseText).toBe('')
    })

    it('addBadge replaces a badge with the same key', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        addBadge('g1', { key: 'cache', text: 'hit 1k' })
        addBadge('g1', { key: 'cache', text: 'hit 12k' })
        const e = get(requestStatuses).get('g1')!
        expect(e.badges).toHaveLength(1)
        expect(e.badges[0].text).toBe('hit 12k')
    })

    it('endStatus sets terminal phase and reconciles usage', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { response: 'hi' }, 10)
        endStatus('g1', 'done', { now: 100, usage: { responseTokens: 999, thinkingTokens: 3 } })
        const e = get(requestStatuses).get('g1')!
        expect(e.phase).toBe('done')
        expect(e.responseTokens).toBe(999)
        expect(e.thinkingTokens).toBe(3)
    })

    it('markPhase does not regress out of a terminal phase', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        endStatus('g1', 'done', { now: 10 })
        markPhase('g1', 'responding', 20)
        expect(get(requestStatuses).get('g1')!.phase).toBe('done')
    })

    it('helpers are no-ops on an unknown id (no throw)', () => {
        expect(() => markPhase('nope', 'thinking', 0)).not.toThrow()
        expect(() => appendText('nope', { response: 'x' }, 0)).not.toThrow()
        expect(() => addBadge('nope', { key: 'k', text: 't' })).not.toThrow()
        expect(() => endStatus('nope', 'failed', { now: 0 })).not.toThrow()
        expect(get(requestStatuses).size).toBe(0)
    })

    it('clearStatus removes an entry', () => {
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        clearStatus('g1')
        expect(get(requestStatuses).has('g1')).toBe(false)
    })
})

describe('tick-time tokenization', () => {
    it('recounts accumulated text with the injected tokenizer on tick', async () => {
        // A fake tokenizer: 1 token per 2 chars (distinct from the char/4
        // fallback) so we can prove the injected counter is used.
        // Realistic startedAt: the real tick's Date.now() must not exceed the
        // abandon cap, which a now:0 startedAt would trigger immediately.
        const t0 = Date.now()
        setStatusTokenCounter(async (text) => Math.ceil(text.length / 2))
        startStatus('g1', { kind: 'main', label: 'x', now: t0 })
        appendText('g1', { thinking: 'aaaa', response: 'bbbbbb' }, t0) // 4 / 6 chars

        // Drive the async tokenize pass directly (the timer would call it).
        startStatusTimer()
        await vi.waitFor(() => {
            const e = get(requestStatuses).get('g1')!
            expect(e.thinkingTokens).toBe(2)  // 4/2
            expect(e.responseTokens).toBe(3)  // 6/2
            expect(e.textDirty).toBe(false)
        })
    })

    it('falls back to char/4 estimate when no tokenizer is registered', async () => {
        const t0 = Date.now()
        setStatusTokenCounter(null)
        startStatus('g1', { kind: 'main', label: 'x', now: t0 })
        appendText('g1', { response: 'abcdefgh' }, t0) // 8 chars → 8/4 = 2
        startStatusTimer()
        await vi.waitFor(() => {
            expect(get(requestStatuses).get('g1')!.responseTokens).toBe(2)
        })
    })

    it('endStatus does a final recount when no usage is provided', async () => {
        setStatusTokenCounter(async (text) => text.length) // 1 token/char
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { response: 'hello' }, 10)
        endStatus('g1', 'done', { now: 20 }) // no usage → final recount
        await vi.waitFor(() => {
            expect(get(requestStatuses).get('g1')!.responseTokens).toBe(5)
        })
    })

    it('endStatus usage wins over the final recount', async () => {
        setStatusTokenCounter(async (text) => text.length)
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { response: 'hello' }, 10)
        endStatus('g1', 'done', { now: 20, usage: { responseTokens: 42 } })
        const e = get(requestStatuses).get('g1')!
        expect(e.responseTokens).toBe(42)
    })

    it('final recount does not clobber a restarted request (retry reuses id)', async () => {
        // Slow tokenizer so the recount is still in flight when the retry restarts.
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        setStatusTokenCounter(async (text) => { await gate; return text.length })
        startStatus('g1', { kind: 'main', label: 'x', now: 0 })
        appendText('g1', { response: 'aaaaa' }, 10)  // 5 chars
        endStatus('g1', 'done', { now: 20 })          // triggers finalRecount (pending on gate)
        // Retry reuses the same id: restart, accumulate different text.
        startStatus('g1', { kind: 'main', label: 'x', now: 30 })
        appendText('g1', { response: 'bb' }, 40)
        release()                                      // stale recount resolves now
        await new Promise((r) => setTimeout(r, 0))
        // The stale recount (5) must NOT overwrite the live restarted entry.
        const e = get(requestStatuses).get('g1')!
        expect(e.phase).toBe('responding')
        expect(e.responseText).toBe('bb')
        expect(e.responseTokens).not.toBe(5)
    })
})

describe('render timer', () => {
    it('starts on startStatus and self-stops once entries are terminal', () => {
        vi.useFakeTimers()
        const setSpy = vi.spyOn(globalThis, 'setInterval')
        const clearSpy = vi.spyOn(globalThis, 'clearInterval')

        startStatus('g1', { kind: 'main', label: 'x', now: Date.now() })
        expect(setSpy).toHaveBeenCalledTimes(1)

        // Idempotent: a second start does not arm a second timer.
        startStatusTimer()
        expect(setSpy).toHaveBeenCalledTimes(1)

        endStatus('g1', 'done', { now: Date.now() })
        vi.advanceTimersByTime(500) // one tick: sees no live entries → stops
        expect(clearSpy).toHaveBeenCalled()
    })

    it('drops a never-ending (hung) non-terminal entry past the abandon cap, so the timer stops', () => {
        vi.useFakeTimers()
        const clearSpy = vi.spyOn(globalThis, 'clearInterval')
        const start = Date.now()
        startStatus('g1', { kind: 'main', label: 'x', now: start })
        markPhase('g1', 'responding', start)
        // No further chunks, no endStatus, no abort — simulate a hung request.
        vi.advanceTimersByTime(STATUS_ABANDON_MS + 1000)
        expect(get(requestStatuses).has('g1')).toBe(false) // entry dropped
        expect(clearSpy).toHaveBeenCalled()                // timer self-stopped
    })
})
