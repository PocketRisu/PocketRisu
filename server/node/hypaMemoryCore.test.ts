import { describe, it, expect, vi, afterEach } from 'vitest'
import pkg from './hypaMemoryCore.cjs'

const {
    runHypaMemoryPipeline,
    spliceMemoryText,
    splitBySeparator,
    simpleCC,
    childToParentRRF,
    countSummaryTokens,
} = pkg as any

const realFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

// Deterministic fake embeddings: vectors chosen so cosine similarity is
// predictable. "cat"-family texts align on axis 0, "dog" on axis 1.
function fakeVector(text: string): number[] {
    if (text.includes('cat')) return [1, 0, 0]
    if (text.includes('dog')) return [0, 1, 0]
    return [0, 0, 1]
}

function installFakeUpstream(counters: { embeds: number; summaries: number }) {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        if (String(url).includes('/embeddings')) {
            counters.embeds++
            return jsonResponse({
                data: body.input.map((text: string) => ({ embedding: fakeVector(text) })),
            })
        }
        counters.summaries++
        return jsonResponse({
            choices: [{
                message: { content: `<Thoughts>\nhidden\n</Thoughts>\nSummary of: ${body.messages?.[0]?.content?.slice(0, 20) ?? ''}` },
                finish_reason: 'stop',
            }],
        })
    }) as any
}

function baseMemory(overrides: Record<string, any> = {}) {
    return {
        placeholder: '[[hypa-backend-memory:test]]',
        memoryPromptTag: 'Past Events Summary',
        chatAdditionalTokens: 3,
        chunkSeparator: '\\n\\n',
        summarizationConcurrency: 1,
        summarizationTasks: [],
        existingSummaries: [],
        queries: [],
        budgets: { availableMemoryTokens: 1000, recentMemoryRatio: 0, similarMemoryRatio: 0 },
        embedding: { url: 'https://embed.example/v1/embeddings', key: 'k', model: 'm' },
        baseData: {},
        ...overrides,
    }
}

describe('hypaMemoryCore helpers', () => {
    it('splitBySeparator supports plain and /regex/ separators', () => {
        expect(splitBySeparator('a\n\nb', '\\n\\n')).toEqual(['a', 'b'])
        expect(splitBySeparator('a--b--c', '/-+/')).toEqual(['a', 'b', 'c'])
    })

    it('counts tokens (tiktoken or estimator) with the chat overhead', () => {
        const n = countSummaryTokens('hello world', 3)
        expect(n).toBeGreaterThan(3)
    })

    it('simpleCC fuses weighted scored lists; childToParentRRF ranks parents', () => {
        const a = { name: 'a' }
        const b = { name: 'b' }
        const ranked = simpleCC(
            [
                [[a, 1.0], [b, 0.1]],
                [[b, 0.9], [a, 0.2]],
            ],
            [0.1, 0.9]
        )
        expect(ranked[0]).toBe(b)

        const parents = childToParentRRF([{ p: a }, { p: b }, { p: b }], (c: any) => c.p)
        expect(parents[0]).toBe(b)
    })

    it('spliceMemoryText replaces string and part contents, throws when missing', () => {
        const body = {
            messages: [
                { role: 'system', content: 'before [[X]] after' },
                { role: 'user', content: [{ type: 'text', text: 'also [[X]]' }] },
            ],
        }
        spliceMemoryText(body, '[[X]]', 'MEMORY')
        expect(body.messages[0].content).toBe('before MEMORY after')
        expect((body.messages[1].content as any)[0].text).toBe('also MEMORY')

        expect(() => spliceMemoryText({ messages: [{ role: 'user', content: 'no marker' }] }, '[[X]]', 'M'))
            .toThrow(/placeholder not found/)
    })
})

describe('runHypaMemoryPipeline', () => {
    it('runs summarization tasks, strips thoughts, and appends new summaries', async () => {
        const counters = { embeds: 0, summaries: 0 }
        installFakeUpstream(counters)

        const memory = baseMemory({
            summarizationTasks: [
                {
                    url: 'https://llm.example/v1/chat/completions',
                    headers: {},
                    body: { messages: [{ role: 'user', content: 'summarize the cat story' }] },
                    chatMemos: ['m1', 'm2'],
                },
            ],
            baseData: { categories: [{ id: 'c1', name: 'keep' }] },
        })

        const result = await runHypaMemoryPipeline(memory, {})
        expect(counters.summaries).toBe(1)
        expect(result.updatedMemory.summaries).toHaveLength(1)
        expect(result.updatedMemory.summaries[0].text).not.toContain('<Thoughts>')
        expect(result.updatedMemory.summaries[0].chatMemos).toEqual(['m1', 'm2'])
        expect(result.updatedMemory.categories).toEqual([{ id: 'c1', name: 'keep' }])
        expect(result.memoryText).toContain('<Past Events Summary>')
        expect(result.memoryText).toContain('Summary of:')
    })

    it('selects recent summaries within the reserved budget', async () => {
        const counters = { embeds: 0, summaries: 0 }
        installFakeUpstream(counters)

        const memory = baseMemory({
            // similar ratio fills the remainder so no random bucket exists,
            // but with no queries the similar stage is skipped entirely.
            budgets: { availableMemoryTokens: 100, recentMemoryRatio: 0.5, similarMemoryRatio: 0.5 },
            existingSummaries: [
                { text: 'old one', chatMemos: [], isImportant: false, tags: [], tokens: 30 },
                { text: 'newer one', chatMemos: [], isImportant: false, tags: [], tokens: 30 },
            ],
        })

        // reservedRecent = 50 → only the LAST summary (30 tokens) fits; adding
        // the previous one (60 total) would exceed it.
        const result = await runHypaMemoryPipeline(memory, {})
        expect(result.memoryText).toContain('newer one')
        expect(result.memoryText).not.toContain('old one')
        expect(result.updatedMemory.metrics.lastRecentSummaries).toEqual([1])
    })

    it('similar selection embeds chunks + queries and prefers matching summaries', async () => {
        const counters = { embeds: 0, summaries: 0 }
        installFakeUpstream(counters)

        // Unique per run: the embedding cache persists in SQLite across runs.
        const tag = `t${Date.now()}-${Math.random().toString(36).slice(2)}`
        const memory = baseMemory({
            budgets: { availableMemoryTokens: 100, recentMemoryRatio: 0, similarMemoryRatio: 1 },
            existingSummaries: [
                { text: `the cat slept ${tag}`, chatMemos: [], isImportant: false, tags: [], tokens: 40 },
                { text: `the dog barked ${tag}`, chatMemos: [], isImportant: false, tags: [], tokens: 40 },
            ],
            queries: [{ content: `what did the cat do? ${tag}`, weight: 1 }],
        })

        const result = await runHypaMemoryPipeline(memory, {})
        expect(counters.embeds).toBeGreaterThan(0)
        // Budget (100) fits both, but the cat summary must rank first;
        // metrics record similar picks in rank order.
        expect(result.updatedMemory.metrics.lastSimilarSummaries[0]).toBe(0)
        expect(result.memoryText).toContain(`the cat slept ${tag}`)
    })

    it('important summaries are always selected first', async () => {
        const counters = { embeds: 0, summaries: 0 }
        installFakeUpstream(counters)

        const memory = baseMemory({
            budgets: { availableMemoryTokens: 35, recentMemoryRatio: 1, similarMemoryRatio: 0 },
            existingSummaries: [
                { text: 'crucial fact', chatMemos: [], isImportant: true, tags: [], tokens: 30 },
                { text: 'recent noise', chatMemos: [], isImportant: false, tags: [], tokens: 30 },
            ],
        })

        const result = await runHypaMemoryPipeline(memory, {})
        expect(result.memoryText).toContain('crucial fact')
        // Only 5 tokens left after important → recent one cannot fit.
        expect(result.memoryText).not.toContain('recent noise')
    })

    it('runs the correction task and uses its output as an extra query', async () => {
        const counters = { embeds: 0, summaries: 0 }
        globalThis.fetch = vi.fn(async (url: any, init: any) => {
            const body = JSON.parse(init.body)
            if (String(url).includes('/embeddings')) {
                counters.embeds++
                return jsonResponse({ data: body.input.map((t: string) => ({ embedding: fakeVector(t) })) })
            }
            counters.summaries++
            return jsonResponse({ choices: [{ message: { content: 'the cat correction' } }] })
        }) as any

        const memory = baseMemory({
            budgets: { availableMemoryTokens: 100, recentMemoryRatio: 0, similarMemoryRatio: 1 },
            existingSummaries: [
                { text: 'the cat slept', chatMemos: [], isImportant: false, tags: [], tokens: 40 },
                { text: 'unrelated topic', chatMemos: [], isImportant: false, tags: [], tokens: 40 },
            ],
            queries: [{ content: 'neutral question', weight: 0.33 }],
            correctionTask: { url: 'https://llm.example/v1/chat/completions', headers: {}, body: { messages: [] } },
            correctionWeight: 0.67,
        })

        const result = await runHypaMemoryPipeline(memory, {})
        expect(counters.summaries).toBe(1)
        expect(result.updatedMemory.metrics.lastSimilarSummaries[0]).toBe(0)
    })

    it('fails the pipeline when a summarization request fails', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as any
        const memory = baseMemory({
            summarizationTasks: [{ url: 'https://llm.example/v1/chat/completions', headers: {}, body: { messages: [] }, chatMemos: [] }],
        })
        await expect(runHypaMemoryPipeline(memory, {})).rejects.toThrow(/HTTP 500/)
    })

    it('caches embeddings across runs (second run makes no embed calls)', async () => {
        const counters = { embeds: 0, summaries: 0 }
        installFakeUpstream(counters)

        // Unique per run: the embedding cache persists in SQLite across runs.
        const tag = `t${Date.now()}-${Math.random().toString(36).slice(2)}`
        const makeMemory = () => baseMemory({
            budgets: { availableMemoryTokens: 100, recentMemoryRatio: 0, similarMemoryRatio: 1 },
            existingSummaries: [
                { text: `the cat slept on the cached mat ${tag}`, chatMemos: [], isImportant: false, tags: [], tokens: 40 },
            ],
            queries: [{ content: `cached cat query? ${tag}`, weight: 1 }],
        })

        await runHypaMemoryPipeline(makeMemory(), {})
        const embedsAfterFirst = counters.embeds
        expect(embedsAfterFirst).toBeGreaterThan(0)

        await runHypaMemoryPipeline(makeMemory(), {})
        expect(counters.embeds).toBe(embedsAfterFirst)
    })
})
