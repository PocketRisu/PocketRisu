import { describe, it, expect, beforeEach, vi } from 'vitest'

// The collector reaches globalApi only for the auth header; stub it so the
// test doesn't drag the whole storage graph in.
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('./globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/log', () => ({ getClientId: () => 'test' }))
vi.mock('./log', () => ({ getClientId: () => 'test' }))

let loggingEnabled = true
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({ requestLogEnabled: loggingEnabled }),
}))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => ({ requestLogEnabled: loggingEnabled }),
}))

const { createRequestLogScope } = await import('./requestLog')

// Captures what the collector POSTs to /api/request-logs.
let posted: any[][]

beforeEach(() => {
    loggingEnabled = true
    posted = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        if (typeof url === 'string' && url.startsWith('/api/request-logs')) {
            posted.push(JSON.parse(init.body))
            return new Response('{"success":true}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
    }))
})

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c))
            controller.close()
        },
    })
}

function jsonResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

describe('createRequestLogScope', () => {
    it('records url, body, status and duration of a plain request', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main', chatId: 'gen-1' })
        const wrapped = scope.wrap(async () => jsonResponse('{"ok":true}'))

        const res = await wrapped('https://api.example.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"messages":[]}',
        })
        expect(await res.text()).toBe('{"ok":true}')
        await scope.close()

        expect(posted).toHaveLength(1)
        const [entry] = posted[0]
        expect(entry.url).toBe('https://api.example.com/v1/chat')
        expect(entry.category).toBe('llm')
        expect(entry.source).toBe('main')
        expect(entry.chatId).toBe('gen-1')
        expect(entry.status).toBe(200)
        expect(entry.success).toBe(true)
        expect(entry.requestBody).toBe('{"messages":[]}')
        expect(entry.responseBody).toBe('{"ok":true}')
        expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('assembles a streamed response instead of a placeholder', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main', streaming: true })
        const wrapped = scope.wrap(async () => new Response(
            streamOf(['data: one\n\n', 'data: two\n\n', 'data: [DONE]\n\n']),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ))

        const res = await wrapped('https://api.example.com/v1/chat', { method: 'POST', body: '{}' })
        // The consumer must still receive the full, untouched stream.
        expect(await res.text()).toBe('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
        await scope.close()

        const [entry] = posted[0]
        expect(entry.responseBody).toBe('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
        expect(entry.streaming).toBe(true)
        expect(entry.firstTokenMs).toBeGreaterThanOrEqual(0)
    })

    it('attaches adapter usage to the entry', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        await (await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).text()

        scope.setUsage({ inputTokens: 120, outputTokens: 30, cachedTokens: 100, reasoningTokens: 8 })
        await scope.close()

        const [entry] = posted[0]
        expect(entry.inputTokens).toBe(120)
        expect(entry.outputTokens).toBe(30)
        expect(entry.cachedTokens).toBe(100)
        expect(entry.reasoningTokens).toBe(8)
    })

    it('records a failed status as unsuccessful', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{"error":"bad"}', 429))
        await (await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).text()
        await scope.close()

        const [entry] = posted[0]
        expect(entry.success).toBe(false)
        expect(entry.status).toBe(429)
    })

    it('records a thrown transport error and rethrows it', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => { throw new TypeError('network down') })

        await expect(wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).rejects.toThrow('network down')
        await scope.close()

        const [entry] = posted[0]
        expect(entry.success).toBe(false)
        expect(entry.errorMessage).toBe('network down')
    })

    it('marks an aborted request', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => {
            throw new DOMException('The operation was aborted.', 'AbortError')
        })
        await expect(wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).rejects.toThrow()
        await scope.close()

        expect(posted[0][0].aborted).toBe(true)
    })

    it('strips inlined base64 media from the request body', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        const body = JSON.stringify({ image: `data:image/png;base64,${'A'.repeat(4000)}` })
        await (await wrapped('https://x.test/v1', { method: 'POST', body })).text()
        await scope.close()

        const [entry] = posted[0]
        expect(entry.requestBody).not.toContain('AAAA')
        expect(entry.requestBody).toContain('image/png')
        expect(entry.requestBody).toContain('omitted')
    })

    it('lets a later real body override what the caller handed in', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        await (await wrapped('https://x.test/v1', { method: 'POST', body: '{"pre":1}' })).text()

        scope.setRequestBody('{"post-interceptor":1}')
        await scope.close()

        expect(posted[0][0].requestBody).toBe('{"post-interceptor":1}')
    })

    it('batches every request of a scope into one POST', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        await (await wrapped('https://x.test/1', { method: 'POST', body: '{}' })).text()
        await (await wrapped('https://x.test/2', { method: 'POST', body: '{}' })).text()
        await scope.close()

        expect(posted).toHaveLength(1)
        expect(posted[0]).toHaveLength(2)
        expect(posted[0][1].url).toBe('https://x.test/2')
    })

    it('applies usage only to the last request of a tool loop', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        await (await wrapped('https://x.test/1', { method: 'POST', body: '{}' })).text()
        await (await wrapped('https://x.test/2', { method: 'POST', body: '{}' })).text()
        scope.setUsage({ inputTokens: 5, outputTokens: 2 })
        await scope.close()

        expect(posted[0][0].inputTokens).toBeUndefined()
        expect(posted[0][1].inputTokens).toBe(5)
    })

    it('sends nothing twice when close is called more than once', async () => {
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => jsonResponse('{}'))
        await (await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).text()
        await scope.close()
        await scope.close()

        expect(posted).toHaveLength(1)
    })


    // Regression: close() used to cap its wait at 5s, so any generation longer
    // than that was posted with no response body at all — the exact defect this
    // system exists to fix. fetchNative calls close() from a `finally` that runs
    // as soon as headers arrive, which is what this reproduces.
    it('waits for a slow stream instead of posting an empty body', async () => {
        let push: (chunk: string) => void = () => {}
        let finish: () => void = () => {}
        const encoder = new TextEncoder()
        const slow = new ReadableStream<Uint8Array>({
            start(controller) {
                push = (c) => controller.enqueue(encoder.encode(c))
                finish = () => controller.close()
            },
        })

        const scope = createRequestLogScope({ category: 'llm', source: 'main', streaming: true })
        const wrapped = scope.wrap(async () => new Response(slow, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        }))

        const res = await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })
        // close() fires while the provider is still generating, as fetchNative does.
        const closing = scope.close()

        const consumed = res.text()
        push('data: chunk-one\n\n')
        await new Promise(r => setTimeout(r, 30))
        push('data: chunk-two\n\n')
        finish()

        expect(await consumed).toBe('data: chunk-one\n\ndata: chunk-two\n\n')
        await closing

        expect(posted).toHaveLength(1)
        const [entry] = posted[0]
        expect(entry.responseBody).toBe('data: chunk-one\n\ndata: chunk-two\n\n')
        expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    })

    // Regression: a cancelled generation returned HTTP 200, so it was filed as a
    // success and its usage counted as a completed request.
    it('marks a stream the caller aborted mid-flight as aborted, not successful', async () => {
        const controller = new AbortController()
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(encoder.encode('partial')) },
            // never closes — the abort is what ends it
        })

        const scope = createRequestLogScope({ category: 'llm', source: 'main', streaming: true })
        const wrapped = scope.wrap(async () => new Response(stream, { status: 200 }))
        await wrapped('https://x.test/v1', {
            method: 'POST', body: '{}', signal: controller.signal,
        })

        await new Promise(r => setTimeout(r, 10))
        controller.abort()
        await scope.close()

        const [entry] = posted[0]
        expect(entry.aborted).toBe(true)
        expect(entry.success).toBe(false)
        expect(entry.responseBody).toBe('partial')
    })

    it('passes a non-Response transport result through untouched', async () => {
        const fake = { status: 200, weird: true } as unknown as Response
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const wrapped = scope.wrap(async () => fake)

        // A userscript-supplied fetch may return a duck-typed object; logging
        // must not throw into the request path.
        const res = await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })
        expect(res).toBe(fake)
        await scope.close()
        expect(posted).toHaveLength(1)
    })


    // Audio (TTS) and images must be recorded as metadata only: decoding them
    // into a string would store megabytes of noise and evict real logs.
    it('records metadata but not the body for a binary response', async () => {
        const scope = createRequestLogScope({ category: 'tts', source: 'tts' })
        const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
        const wrapped = scope.wrap(async () => new Response(audio, {
            status: 200, headers: { 'content-type': 'audio/mpeg' },
        }))

        const res = await wrapped('https://tts.test/v1/speech', { method: 'POST', body: '{"text":"hi"}' })
        // The caller still gets the real bytes.
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(audio)
        await scope.close()

        const [entry] = posted[0]
        expect(entry.status).toBe(200)
        expect(entry.requestBody).toBe('{"text":"hi"}')
        expect(entry.responseBody).toContain('not recorded')
        expect(entry.responseBody).toContain('audio/mpeg')
    })

    it('still assembles json and event-stream responses', async () => {
        for (const type of ['application/json', 'text/event-stream', 'text/plain']) {
            posted = []
            const scope = createRequestLogScope({ category: 'llm', source: 'main' })
            const wrapped = scope.wrap(async () => new Response('payload', {
                status: 200, headers: { 'content-type': type },
            }))
            await (await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).text()
            await scope.close()
            expect(posted[0][0].responseBody).toBe('payload')
        }
    })

    it('strips base64 media out of the response too', async () => {
        // Image providers return base64 inside JSON; unstripped, one generated
        // image would eat the whole byte budget.
        const scope = createRequestLogScope({ category: 'image', source: 'image' })
        const body = JSON.stringify({ image: `data:image/png;base64,${'B'.repeat(5000)}` })
        const wrapped = scope.wrap(async () => new Response(body, {
            status: 200, headers: { 'content-type': 'application/json' },
        }))
        await (await wrapped('https://img.test/gen', { method: 'POST', body: '{}' })).text()
        await scope.close()

        const [entry] = posted[0]
        expect(entry.responseBody).not.toContain('BBBB')
        expect(entry.responseBody).toContain('omitted')
    })

    it('is a pass-through no-op when logging is disabled', async () => {
        loggingEnabled = false
        const scope = createRequestLogScope({ category: 'llm', source: 'main' })
        const base = vi.fn(async () => jsonResponse('{"ok":1}'))
        const wrapped = scope.wrap(base as unknown as typeof fetch)

        // The transport must be handed back untouched, not merely bypassed.
        expect(wrapped).toBe(base)
        await (await wrapped('https://x.test/v1', { method: 'POST', body: '{}' })).text()
        await scope.close()

        expect(posted).toHaveLength(0)
    })
})
