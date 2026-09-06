import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeJobFetch, ModelJobBusyError, ModelJobConnectionLostError, type JobFetchOptions } from './jobFetch'

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))

// --- harness ----------------------------------------------------------------
//
// makeJobFetch talks to exactly four server endpoints plus a fallback fetch.
// The harness stubs global fetch with a tiny in-memory server so each test
// declares only the behavior it cares about (creation outcome, stream bytes,
// final job status).

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(enc.encode(chunk))
            c.close()
        },
    })
}

interface ServerBehavior {
    create?: { status: number, body?: unknown }
    createReject?: Error
    streamChunks?: string[]
    /** Per-attach chunk sets: successive GET /stream calls consume successive
     *  entries (the last repeats) — for reconnect tests. Overrides streamChunks. */
    streamChunksQueue?: string[][]
    /** Defaults to a healthy stream (content-type + upstream-status 200). */
    streamHeaders?: Record<string, string>
    /** Body of the never-closing kind for abort tests. */
    streamNeverEnds?: boolean
    /** Reject this many GET /stream fetches (network-level) before serving.
     *  Infinity = reject every attach — for retry-exhaustion tests. */
    streamRejectTimes?: number
    /** HTTP status of the GET /stream response itself (default 200). */
    streamHttpStatus?: number
    /** Answer this many GET /stream fetches with a middlebox 504 (no
     *  x-model-job-* headers) before serving — for gateway-timeout tests. */
    streamIntermediaryTimes?: number
    /** GET /api/model-jobs/:id after the stream ends. */
    job?: { status: string, error?: string }
    /** Successive GET /api/model-jobs/:id responses (last repeats). Overrides job. */
    jobQueue?: { status: string, error?: string }[]
    jobReject?: Error
}

function setupServer(behavior: ServerBehavior) {
    const calls: { url: string, init?: RequestInit }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({ url, init })
        const method = init?.method ?? 'GET'
        if (url === '/api/model-jobs' && method === 'POST') {
            if (behavior.createReject) throw behavior.createReject
            const c = behavior.create ?? { status: 200, body: { jobId: 'job-1' } }
            return new Response(JSON.stringify(c.body ?? {}), { status: c.status })
        }
        if (url === '/api/model-jobs/job-1/stream') {
            if (behavior.streamRejectTimes && behavior.streamRejectTimes > 0) {
                behavior.streamRejectTimes -= 1
                throw new TypeError('Failed to fetch')
            }
            if (behavior.streamIntermediaryTimes && behavior.streamIntermediaryTimes > 0) {
                behavior.streamIntermediaryTimes -= 1
                // A reverse proxy's own error page: no x-model-job-* headers.
                return new Response('<html>504 Gateway Time-out</html>', { status: 504, headers: { 'content-type': 'text/html' } })
            }
            const headers = behavior.streamHeaders ?? {
                'content-type': 'text/event-stream',
                'x-model-job-id': 'job-1',
                'x-model-job-upstream-status': '200',
            }
            let chunks = behavior.streamChunks ?? []
            if (behavior.streamChunksQueue) {
                chunks = behavior.streamChunksQueue.length > 1
                    ? behavior.streamChunksQueue.shift()!
                    : behavior.streamChunksQueue[0] ?? []
            }
            const body = behavior.streamNeverEnds
                ? new ReadableStream<Uint8Array>({ start() { /* never closes */ } })
                : streamOf(...chunks)
            return new Response(body, { status: behavior.streamHttpStatus ?? 200, headers })
        }
        if (url === '/api/model-jobs/job-1' && method === 'DELETE') {
            return new Response('{"success":true}', { status: 200 })
        }
        if (url === '/api/model-jobs/job-1' && method === 'GET') {
            if (behavior.jobReject) throw behavior.jobReject
            let job = behavior.job ?? { status: 'done' }
            if (behavior.jobQueue && behavior.jobQueue.length > 0) {
                job = behavior.jobQueue.length > 1 ? behavior.jobQueue.shift()! : behavior.jobQueue[0]
            }
            return new Response(JSON.stringify(job), { status: 200 })
        }
        if (url === '/api/model-jobs/job-1/claim' && method === 'POST') {
            return new Response('{"success":true}', { status: 200 })
        }
        throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls }
}

function makeOpts(overrides: Partial<JobFetchOptions> = {}): JobFetchOptions {
    return {
        realChatId: 'chat-1',
        generationId: 'gen-1',
        adapterKind: 'openai-compatible',
        model: 'provider/model-id',
        modelLabel: 'My Preset',
        inputTokens: 1234,
        outputTokens: 512,
        maxContext: 32768,
        streaming: true,
        timeoutMs: 60_000,
        fallbackFetch: vi.fn(async () => new Response('fallback')) as unknown as typeof fetch,
        ...overrides,
    }
}

function callsFor(calls: { url: string, init?: RequestInit }[], url: string, method = 'GET') {
    return calls.filter((c) => c.url === url && (c.init?.method ?? 'GET') === method)
}

// Drain the response the way the streaming adapters do (body reader), so
// stream errors surface with their original class. (happy-dom's text()/json()
// wrap stream errors in a DOMException, unlike real browsers.)
async function drain(res: Response): Promise<string> {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let out = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) return out
        out += dec.decode(value, { stream: true })
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

// --- tests ------------------------------------------------------------------

describe('makeJobFetch', () => {
    test('streams journal bytes through and claims after a clean done', async () => {
        const { calls } = setupServer({ streamChunks: ['hel', 'lo ', 'world'], job: { status: 'done' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-x' },
            body: '{"model":"m"}',
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('text/event-stream')
        expect(await res.text()).toBe('hello world')

        // Job creation carried the request + job metadata and the app auth header.
        const [create] = callsFor(calls, '/api/model-jobs', 'POST')
        expect((create.init?.headers as Record<string, string>)['risu-auth']).toBe('test-auth')
        expect(JSON.parse(create.init?.body as string)).toMatchObject({
            targetUrl: 'https://provider.example/v1/chat',
            method: 'POST',
            headers: { authorization: 'Bearer sk-x' },
            body: '{"model":"m"}',
            chatId: 'chat-1',
            generationId: 'gen-1',
            adapterKind: 'openai-compatible',
            model: 'provider/model-id',
            modelLabel: 'My Preset',
            inputTokens: 1234,
            outputTokens: 512,
            maxContext: 32768,
            streaming: true,
            timeoutMs: 60_000,
        })
        // Claim is fire-and-forget after the verified-done close.
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('mirrors the upstream status onto the returned Response', async () => {
        setupServer({
            streamChunks: ['{"error":"rate limited"}'],
            streamHeaders: { 'content-type': 'application/json', 'x-model-job-upstream-status': '429' },
            job: { status: 'done' },
        })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(res.status).toBe(429)
        expect(res.headers.get('content-type')).toBe('application/json')
        expect(await res.json()).toEqual({ error: 'rate limited' })
    })

    test('missing upstream-status header throws TypeError like a network failure', async () => {
        setupServer({ streamHeaders: { 'content-type': 'text/plain' } })
        await expect(makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(TypeError)
    })

    test('initial stream attach retries a rejected fetch and then delivers (send-then-background resume)', async () => {
        // The tab froze right after job creation; on resume the in-flight
        // attach rejects while the radio is still down. The retry must attach
        // once the network is back — the job kept running server-side.
        const { calls } = setupServer({
            streamRejectTimes: 2,
            streamChunks: ['hello world'],
            job: { status: 'done' },
        })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('hello world')
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(3)
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('initial stream attach exhaustion throws ModelJobConnectionLostError, never the raw TypeError or fallback', async () => {
        const opts = makeOpts({ reconnectBaseDelayMs: 1 })
        setupServer({ streamRejectTimes: Infinity })
        await expect(makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(ModelJobConnectionLostError)
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
    })

    test('an HTTP error from the stream endpoint is definitive — no attach retry', async () => {
        // Only network-level rejections retry; a served response (even an
        // error) is the server's answer and takes the existing path unchanged.
        const { calls } = setupServer({ streamHttpStatus: 500 })
        await expect(makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(TypeError)
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(1)
    })

    test('abort during initial attach retry surfaces the abort', async () => {
        setupServer({ streamRejectTimes: Infinity })
        const controller = new AbortController()
        const pending = makeJobFetch(makeOpts({ reconnectBaseDelayMs: 50 }))('https://provider.example/v1/chat', {
            method: 'POST', body: '{}', signal: controller.signal,
        })
        setTimeout(() => controller.abort(), 5)
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })

    test('reattaches after a dropped tail and resumes without duplicating bytes', async () => {
        const { calls } = setupServer({
            // First attach delivers a prefix then the connection "drops"; the
            // reattach replays the journal from byte 0 with more appended.
            streamChunksQueue: [['hel'], ['hello world']],
            jobQueue: [{ status: 'running' }, { status: 'done' }],
        })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('hello world') // replayed prefix skipped, not duplicated
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(2)
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('reattach cycles without progress eventually error the body (끊김 ≠ 완료), no claim', async () => {
        // Server accepts every reattach but the job never progresses nor
        // finishes — the no-progress cap must break the loop.
        const { calls } = setupServer({ streamChunks: ['partial tex'], job: { status: 'running' } })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow(ModelJobConnectionLostError)
        expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(0)
    })

    test('unreachable status check after stream end also counts as connection lost', async () => {
        setupServer({ streamChunks: ['partial'], jobReject: new TypeError('network down') })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        // Asserted by type, not text: the message is localized (language.errors).
        await expect(drain(res)).rejects.toThrow(ModelJobConnectionLostError)
    })

    test('aux jobs forward kind and their own unique key', async () => {
        const { calls } = setupServer({ streamChunks: ['{"ok":true}'], job: { status: 'done' } })
        await makeJobFetch(makeOpts({ jobKind: 'aux', realChatId: 'aux-gen-9' }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        const [create] = callsFor(calls, '/api/model-jobs', 'POST')
        expect(JSON.parse(create.init?.body as string)).toMatchObject({ kind: 'aux', chatId: 'aux-gen-9' })
    })

    test('stream end with failed job errors the body with the job error and claims it', async () => {
        const { calls } = setupServer({ streamChunks: ['par'], job: { status: 'failed', error: 'upstream timeout' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow('upstream timeout')
        // The user saw this failure live — claim so the next boot's discovery
        // doesn't insert a duplicate error into the chat.
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('stream end with aborted job does not claim', async () => {
        const { calls } = setupServer({ streamChunks: ['par'], job: { status: 'aborted' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow('model job aborted')
        await new Promise((r) => setTimeout(r, 10))
        expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(0)
    })

    test('abort fires a job DELETE', async () => {
        const { calls } = setupServer({ streamNeverEnds: true })
        const controller = new AbortController()
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
        })
        void res.body!.getReader().read().catch(() => {})
        controller.abort()
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1', 'DELETE')).toHaveLength(1)
        })
    })

    test('creation 409 for another generation throws ModelJobBusyError and never falls back', async () => {
        setupServer({ create: { status: 409, body: { error: 'busy', jobId: 'job-1', generationId: 'gen-other' } } })
        const opts = makeOpts()
        await expect(makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(ModelJobBusyError)
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
    })

    test('creation 409 without a generationId (older server) still throws ModelJobBusyError', async () => {
        setupServer({ create: { status: 409, body: { error: 'busy', jobId: 'job-1' } } })
        await expect(makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(ModelJobBusyError)
    })

    test('creation 409 for this generation\'s own job reattaches to it instead of failing (issue #87)', async () => {
        // The send pipeline retried after the first attempt lost its stream;
        // the server still holds our job → resume it, no new job, no busy error.
        const { calls } = setupServer({
            create: { status: 409, body: { error: 'busy', jobId: 'job-1', generationId: 'gen-1' } },
            streamChunks: ['resumed'],
            job: { status: 'done' },
        })
        const opts = makeOpts()
        const res = await makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('resumed')
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(1)
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('a gateway error page on the initial attach retries like a network failure (issue #87)', async () => {
        // The reverse proxy in front of the server gave up on the pre-header
        // wait (thinking model, slow first byte). Its 504 carries no
        // x-model-job-* headers, so it is a transport failure, not our answer.
        const { calls } = setupServer({
            streamIntermediaryTimes: 2,
            streamChunks: ['hello'],
            job: { status: 'done' },
        })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('hello')
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(3)
    })

    test('a headerless 500 on the initial attach stays definitive (server-side auth/handler error, not a gateway)', async () => {
        const { calls } = setupServer({ streamHttpStatus: 500, streamHeaders: { 'content-type': 'application/json' } })
        await expect(makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(TypeError)
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(1)
    })

    test('gateway errors on every initial attach end in ModelJobConnectionLostError, job left running', async () => {
        const { calls } = setupServer({ streamIntermediaryTimes: Infinity })
        await expect(makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(ModelJobConnectionLostError)
        expect(callsFor(calls, '/api/model-jobs/job-1', 'DELETE')).toHaveLength(0)
    })

    test('creation network failure falls back to the direct fetch with the same args', async () => {
        setupServer({ createReject: new TypeError('Failed to fetch') })
        const opts = makeOpts()
        const init = { method: 'POST', body: '{}' }
        const res = await makeJobFetch(opts)('https://provider.example/v1/chat', init)
        expect(await res.text()).toBe('fallback')
        expect(opts.fallbackFetch).toHaveBeenCalledWith('https://provider.example/v1/chat', init)
    })

    test('creation 5xx (misbehaving/older server) falls back to the direct fetch', async () => {
        setupServer({ create: { status: 500, body: {} } })
        const opts = makeOpts()
        const res = await makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('fallback')
        expect(opts.fallbackFetch).toHaveBeenCalledTimes(1)
    })

    test('creation abort surfaces the abort instead of falling back', async () => {
        setupServer({ createReject: new DOMException('The operation was aborted.', 'AbortError') })
        const controller = new AbortController()
        controller.abort()
        const opts = makeOpts()
        await expect(makeJobFetch(opts)('https://provider.example/v1/chat', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
        })).rejects.toThrow('aborted')
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
    })
})
