import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

// --- module mocks -----------------------------------------------------------
//
// jobRecovery touches the app through four seams; everything else (adapter
// parsers, generationState, requestStatus) runs for real. The DB is a plain
// mutable fixture handed out by the mocked getDatabase, mirroring how
// util.test.ts stubs the database layer.

const mocks = vi.hoisted(() => ({
    db: { characters: [] as any[], inlayErrorResponse: true, showRequestStatus: true } as any,
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    ensureChatHydrated: vi.fn(),
    saveChatToServer: vi.fn(async () => {}),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))
vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: mocks.ensureChatHydrated,
    saveChatToServer: mocks.saveChatToServer,
}))
vi.mock('src/ts/alert', () => ({
    notifyError: mocks.notifyError,
    notifyInfo: mocks.notifyInfo,
}))

// Fresh module instances per test: recoverModelJobs is once-guarded, and the
// keyed stores (generationState / requestStatus) must not leak across tests.
async function loadModules() {
    vi.resetModules()
    const recovery = await import('./jobRecovery')
    const genState = await import('src/ts/process/generationState')
    const status = await import('src/ts/status/requestStatus')
    const pending = await import('./pendingSends')
    return { recovery, genState, status, pending }
}

// --- fixtures ---------------------------------------------------------------

function makeChat(overrides: Record<string, unknown> = {}) {
    return { id: 'chat-1', name: 'chat one', message: [] as any[], ...overrides }
}

function makeChar(chat: any) {
    return { chaId: 'cha-1', name: 'Rina', type: 'character', chatPage: 0, reloadKeys: 0, chats: [chat] }
}

function makeJob(overrides: Record<string, unknown> = {}) {
    return {
        id: 'job-1',
        chatId: 'chat-1',
        generationId: 'gen-1',
        adapterKind: 'openai-compatible',
        streaming: true,
        status: 'done',
        upstreamStatus: 200,
        ...overrides,
    }
}

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(enc.encode(chunk))
            c.close()
        },
    })
}

const OPENAI_SSE =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
    + 'data: [DONE]\n\n'

// --- fetch harness ----------------------------------------------------------

interface ServerBehavior {
    unclaimed?: any[]
    active?: any[]
    /** GET /api/pending-sends payload (default: none). */
    pendingSends?: any[]
    /** journal body per job id (string, replayed as one chunk) */
    journals?: Record<string, string>
    /** override the stream endpoint's HTTP status per job id */
    streamStatus?: Record<string, number>
    /** successive GET /api/model-jobs/:id responses (last one repeats) */
    jobStates?: Record<string, any[]>
    /** make GET /api/model-jobs/:id reject (status endpoint unreachable) */
    jobStatusUnreachable?: boolean
}

function setupServer(behavior: ServerBehavior) {
    const calls: { url: string, method: string }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url === '/api/model-jobs?unclaimed=1') {
            return new Response(JSON.stringify({ jobs: behavior.unclaimed ?? [] }), { status: 200 })
        }
        if (url === '/api/model-jobs?active=1') {
            return new Response(JSON.stringify({ jobs: behavior.active ?? [] }), { status: 200 })
        }
        if (url === '/api/pending-sends' && method === 'GET') {
            return new Response(JSON.stringify({ pendingSends: behavior.pendingSends ?? [] }), { status: 200 })
        }
        if (url.startsWith('/api/pending-sends/') && method === 'DELETE') {
            return new Response('{"success":true}', { status: 200 })
        }
        if (url.startsWith('/api/pending-sends/') && url.endsWith('/claim') && method === 'POST') {
            return new Response('{"claimed":true}', { status: 200 })
        }
        const streamMatch = url.match(/^\/api\/model-jobs\/([^/]+)\/stream$/)
        if (streamMatch) {
            const id = streamMatch[1]
            const status = behavior.streamStatus?.[id] ?? 200
            if (status !== 200) return new Response('down', { status })
            return new Response(sseStream(behavior.journals?.[id] ?? ''), {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'x-model-job-upstream-status': '200' },
            })
        }
        const claimMatch = url.match(/^\/api\/model-jobs\/([^/]+)\/claim$/)
        if (claimMatch && method === 'POST') {
            return new Response('{"success":true}', { status: 200 })
        }
        const jobMatch = url.match(/^\/api\/model-jobs\/([^/]+)$/)
        if (jobMatch && method === 'DELETE') {
            return new Response('{"success":true}', { status: 200 })
        }
        if (jobMatch && method === 'GET') {
            if (behavior.jobStatusUnreachable) throw new TypeError('Failed to fetch')
            const states = behavior.jobStates?.[jobMatch[1]]
            if (!states || states.length === 0) return new Response('{"error":"Job not found"}', { status: 404 })
            const next = states.length > 1 ? states.shift() : states[0]
            return new Response(JSON.stringify(next), { status: 200 })
        }
        throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const claims = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/claim')).map((c) => c.url)
    return { calls, claims }
}

beforeEach(() => {
    mocks.db = { characters: [], inlayErrorResponse: true, showRequestStatus: true }
    mocks.notifyError.mockReset()
    mocks.notifyInfo.mockReset()
    mocks.ensureChatHydrated.mockReset()
    mocks.saveChatToServer.mockReset()
    mocks.saveChatToServer.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

// --- journal decoding -------------------------------------------------------

describe('journal decoding', () => {
    test('openai-compatible SSE journal accumulates deltas and stops at [DONE]', async () => {
        const { recovery } = await loadModules()
        const text = await recovery.decodeStreamingJournal('openai-compatible', sseStream(OPENAI_SSE))
        expect(text).toBe('Hello')
    })

    test('anthropic SSE journal wraps thinking deltas like a live run', async () => {
        const { recovery } = await loadModules()
        const journal =
            'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n'
            + 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n'
            + 'event: message_stop\ndata: {}\n\n'
        const text = await recovery.decodeStreamingJournal('anthropic-messages', sseStream(journal))
        expect(text).toBe('<Thoughts>\nhmm\n</Thoughts>\n\nHi')
    })

    test('gemini SSE journal splits thought parts from visible text', async () => {
        const { recovery } = await loadModules()
        const journal =
            'data: {"candidates":[{"content":{"parts":[{"text":"pondering","thought":true}]}}]}\n\n'
            + 'data: {"candidates":[{"content":{"parts":[{"text":"Ga"}]}}]}\n\n'
            + 'data: {"candidates":[{"content":{"parts":[{"text":"to"}]}}]}\n\n'
        const text = await recovery.decodeStreamingJournal('google-gemini', sseStream(journal))
        expect(text).toBe('<Thoughts>\npondering\n</Thoughts>\n\nGato')
    })

    test('non-streaming JSON journals decode per kind', async () => {
        const { recovery } = await loadModules()
        expect(recovery.decodeJsonJournal(
            'openai-compatible',
            '{"choices":[{"message":{"content":"plain"}}]}',
        )).toBe('plain')
        expect(recovery.decodeJsonJournal(
            'anthropic-messages',
            '{"content":[{"type":"thinking","thinking":"deep"},{"type":"text","text":"claude says"}]}',
        )).toBe('<Thoughts>\ndeep\n</Thoughts>\n\nclaude says')
    })
})

// --- terminal job slot-in ---------------------------------------------------

describe('recoverTerminalJob', () => {
    test('done job slots exactly one char message with generationInfo, then claims', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        const char = makeChar(chat)
        mocks.db.characters = [char]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message).toHaveLength(1)
        expect(chat.message[0]).toMatchObject({
            role: 'char',
            data: 'Hello',
            saying: 'cha-1',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
        })
        expect(typeof chat.message[0].time).toBe('number')
        expect(char.reloadKeys).toBe(1)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('idempotent: a complete message with this generationId is left untouched, claim only', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'char', data: 'Hello, and then some more', generationInfo: { generationId: 'gen-1' } }] })
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].data).toBe('Hello, and then some more') // recovered 'Hello' is shorter
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('fills a partial message left by a client that died mid-stream', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'char', data: 'Hel', generationInfo: { generationId: 'gen-1' } }] })
        const char = makeChar(chat)
        mocks.db.characters = [char]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message).toHaveLength(1) // filled, not duplicated
        expect(chat.message[0].data).toBe('Hello')
        expect(char.reloadKeys).toBe(1)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('failed job with the live message already present adds no error block', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'char', data: 'partial', generationInfo: { generationId: 'gen-1' } }] })
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'upstream timeout' }) as any)

        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].data).toBe('partial')
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('failed job writes the risuerror block into the originating chat', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hi' }] })
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'upstream timeout' }) as any)

        expect(chat.message).toHaveLength(2)
        expect(chat.message[1].role).toBe('char')
        expect(chat.message[1].data).toBe('```risuerror\nupstream timeout\n```')
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('failed job never appends to an existing char message — always a new one', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'char', data: 'unrelated earlier reply' }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'boom' }) as any)

        expect(chat.message).toHaveLength(2)
        expect(chat.message[0].data).toBe('unrelated earlier reply') // untouched
        expect(chat.message[1]).toMatchObject({
            role: 'char',
            data: '```risuerror\nboom\n```',
            generationInfo: { generationId: 'gen-1' }, // future idempotency scans match it
        })
    })

    test('failed job with inlayErrorResponse off falls back to a toast naming the character', async () => {
        const { recovery } = await loadModules()
        mocks.db.inlayErrorResponse = false
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'boom' }) as any)

        expect(chat.message).toHaveLength(0)
        expect(mocks.notifyError).toHaveBeenCalledTimes(1)
        expect(String(mocks.notifyError.mock.calls[0][0])).toContain('Rina')
    })

    test('a continue-restamped message still matches its original job via message chatId', async () => {
        const { recovery } = await loadModules()
        // Mid-stream death left this g1 message; a later continue restamped
        // generationInfo to g2, but the message-level chatId keeps g1.
        const chat = makeChat({ message: [
            { role: 'user', data: 'hi' },
            { role: 'char', data: 'partial reply plus continue partial', chatId: 'gen-1', generationInfo: { generationId: 'gen-2' } },
        ] })
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any) // job carries gen-1

        expect(chat.message).toHaveLength(2) // matched → fill path, NOT a duplicate insert
        expect(chat.message[1].data).toBe('partial reply plus continue partial') // longer text kept
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('missing chat claims and skips without touching anything', async () => {
        const { recovery } = await loadModules()
        mocks.db.characters = [makeChar(makeChat({ id: 'other-chat' }))]
        const { claims } = setupServer({})

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(mocks.db.characters[0].chats[0].message).toHaveLength(0)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('done job whose journal decode fails becomes a risuerror, not a message', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({ journals: { 'job-1': 'data: {not json\n\n' } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].data).toContain('```risuerror')
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })
})

// --- persistence of the slot-in ---------------------------------------------
//
// The save loop only tracks the chat on screen, so a slot-in into any other
// chat is memory-only unless recovery saves it itself (field bug 2026-07-29:
// recovered text rendered on return and vanished on reload).

describe('recovered chat is persisted', () => {
    test('an inserted message is saved to the server before the job is claimed', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(1)
        expect(mocks.saveChatToServer).toHaveBeenCalledWith('cha-1', 0, 'chat-1', chat)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('a filled partial message is saved too', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'char', data: 'Hel', generationInfo: { generationId: 'gen-1' } }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(1)
        expect((mocks.saveChatToServer.mock.calls[0] as any)[3].message[0].data).toBe('Hello')
    })

    test('an error block inserted into the chat is saved', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hi' }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'boom' }) as any)

        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(1)
    })

    test('a chat already carrying this job\'s message is saved anyway (an earlier save may have failed)', async () => {
        const { recovery } = await loadModules()
        // Complete message already present → left untouched (idempotency), but
        // it may be the memory-only leftover of a failed save.
        const chat = makeChat({ message: [{ role: 'char', data: 'Hello, and then some more', generationInfo: { generationId: 'gen-1' } }] })
        mocks.db.characters = [makeChar(chat)]
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message[0].data).toBe('Hello, and then some more') // untouched
        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(1)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })

    test('a chat with nothing written for this job is not saved', async () => {
        const { recovery } = await loadModules()
        mocks.db.characters = [makeChar(makeChat({ id: 'other-chat' }))] // job's chat is gone
        setupServer({})

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(mocks.saveChatToServer).not.toHaveBeenCalled()
    })

    test('the toast-only failure branch touches no chat, so it does not save', async () => {
        const { recovery } = await loadModules()
        mocks.db.inlayErrorResponse = false
        mocks.db.characters = [makeChar(makeChat())]
        setupServer({})

        await recovery.recoverTerminalJob(makeJob({ status: 'failed', error: 'boom' }) as any)

        expect(mocks.saveChatToServer).not.toHaveBeenCalled()
    })

    test('a failed save leaves the job UNCLAIMED so the next boot retries', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        mocks.saveChatToServer.mockRejectedValue(new Error('saveChatContent error: 507'))
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any)

        expect(chat.message).toHaveLength(1) // memory write stands
        expect(claims()).toEqual([])         // but the job stays recoverable
    })

    test('a retry after a failed save fills instead of duplicating, and claims once saved', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        mocks.saveChatToServer.mockRejectedValueOnce(new Error('saveChatContent error: 507'))
        const { claims } = setupServer({ journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverTerminalJob(makeJob() as any) // save fails, no claim
        await recovery.recoverTerminalJob(makeJob() as any) // tab return: same job again

        expect(chat.message).toHaveLength(1) // matched on generationId → fill, no duplicate
        expect(chat.message[0].data).toBe('Hello')
        // The retry re-saves even though the fill was a no-op — otherwise the
        // text the first pass failed to save would be claimed away.
        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(2)
        expect(claims()).toEqual(['/api/model-jobs/job-1/claim'])
    })
})

// --- discovery --------------------------------------------------------------

describe('recoverModelJobs', () => {
    test('one failing job does not stop the rest', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        const jobBroken = makeJob({ id: 'job-broken' })
        const jobOk = makeJob({ id: 'job-ok', generationId: 'gen-ok' })
        setupServer({
            unclaimed: [jobBroken, jobOk],
            journals: { 'job-ok': OPENAI_SSE },
            streamStatus: { 'job-broken': 500 }, // journal unreachable → job left unclaimed
        })

        await recovery.recoverModelJobs()

        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].generationInfo.generationId).toBe('gen-ok')
    })

    test('re-runs on a later trigger without duplicating the recovered message', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        // The server still lists it as unclaimed (e.g. the claim never landed),
        // so the second pass sees the same job again.
        const { calls } = setupServer({ unclaimed: [makeJob()], journals: { 'job-1': OPENAI_SSE } })

        await recovery.recoverModelJobs()
        const callCount = calls.length
        await recovery.recoverModelJobs()

        expect(calls.length).toBeGreaterThan(callCount) // ran again, not once-guarded
        expect(chat.message).toHaveLength(1)            // filled, never duplicated
        expect(chat.message[0].data).toBe('Hello')
    })

    test('concurrent callers collapse onto one in-flight pass', async () => {
        const { recovery } = await loadModules()
        mocks.db.characters = [makeChar(makeChat())]
        const { calls } = setupServer({ unclaimed: [], active: [] })

        await Promise.all([recovery.recoverModelJobs(), recovery.recoverModelJobs()])

        expect(calls.filter((c) => c.url === '/api/model-jobs?unclaimed=1')).toHaveLength(1)
    })

    test('unreachable job API is a silent no-op', async () => {
        const { recovery } = await loadModules()
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
        await expect(recovery.recoverModelJobs()).resolves.toBeUndefined()
    })
})

// --- pending sends ----------------------------------------------------------

describe('pending-send evaluation', () => {
    // createdAt defaults past the min-age gate so scenarios evaluate.
    const record = (over: Record<string, unknown> = {}) =>
        ({ chatId: 'chat-1', generationId: 'gen-1', createdAt: Date.now() - 10 * 60 * 1000, ...over }) as any

    test('flags a chat whose send died pre-response (last message is the user turn)', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        const { calls } = setupServer({})

        await recovery.evaluatePendingSend(record(), new Set())

        expect(get(pending.resumableSends).has('chat-1')).toBe(true)
        // The record survives until the resume path CLAIMS it — a reload must
        // not evaporate the resume.
        expect(calls.some((c) => c.url === '/api/pending-sends/chat-1' && c.method === 'DELETE')).toBe(false)
    })

    test('a record younger than the min age is left alone (send may still be running)', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        const { calls } = setupServer({})

        await recovery.evaluatePendingSend(record({ createdAt: Date.now() - 30_000 }), new Set())

        expect(get(pending.resumableSends).size).toBe(0)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })

    test('a LIVE generation on the chat means the record protects an in-flight send — untouched', async () => {
        const { recovery, pending, genState } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        const { calls } = setupServer({})
        genState.startGeneration('chat-1', 'gen-1', 'live')

        await recovery.evaluatePendingSend(record(), new Set())

        expect(get(pending.resumableSends).size).toBe(0)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        genState.endGeneration('chat-1')
    })

    test('a send whose message landed (matching generationId) is concluded — no flag', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [
            { role: 'user', data: 'hello?' },
            { role: 'char', data: 'answer', generationInfo: { generationId: 'gen-1' } },
        ] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.evaluatePendingSend(record(), new Set())
        expect(get(pending.resumableSends).size).toBe(0)
    })

    test('concluded records are cleared server-side', async () => {
        const { recovery } = await loadModules()
        const chat = makeChat({ message: [
            { role: 'user', data: 'hello?' },
            { role: 'char', data: 'answer', generationInfo: { generationId: 'gen-1' } },
        ] })
        mocks.db.characters = [makeChar(chat)]
        const { calls } = setupServer({})

        await recovery.evaluatePendingSend(record(), new Set())
        // clear goes through the per-chat op chain (async) — wait for it
        await vi.waitFor(() => {
            expect(calls.some((c) => c.url === '/api/pending-sends/chat-1' && c.method === 'DELETE')).toBe(true)
        })
    })

    test('a chat with a live/unclaimed job is left to job recovery — no flag', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.evaluatePendingSend(record(), new Set(['chat-1']))
        expect(get(pending.resumableSends).size).toBe(0)
    })

    test('anything after the user turn (reply, error block) means concluded — no flag', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [
            { role: 'user', data: 'hello?' },
            { role: 'char', data: '```risuerror\nboom\n```' }, // no generationInfo
        ] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({})

        await recovery.evaluatePendingSend(record(), new Set())
        expect(get(pending.resumableSends).size).toBe(0)
    })

    test('missing chat clears silently', async () => {
        const { recovery, pending } = await loadModules()
        mocks.db.characters = []
        const { calls } = setupServer({})

        await recovery.evaluatePendingSend(record(), new Set())
        expect(get(pending.resumableSends).size).toBe(0)
        await vi.waitFor(() => {
            expect(calls.some((c) => c.url === '/api/pending-sends/chat-1' && c.method === 'DELETE')).toBe(true)
        })
    })

    test('discovery evaluates pending sends after job passes and notifies once', async () => {
        const { recovery, pending } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({ pendingSends: [record()] })

        await recovery.recoverModelJobs()

        expect(get(pending.resumableSends).has('chat-1')).toBe(true)
        expect(mocks.notifyInfo).toHaveBeenCalledTimes(1)
        expect(String(mocks.notifyInfo.mock.calls[0][0])).toContain('Rina') // names the chat

        // Second discovery (tab return): flag still unconsumed, record still
        // listed — but the user already saw the notice. No re-toast.
        await recovery.recoverModelJobs()
        expect(mocks.notifyInfo).toHaveBeenCalledTimes(1)
    })

    test('a pending send whose chat has an ACTIVE job attaches instead of flagging', async () => {
        vi.useFakeTimers()
        const { recovery, pending, genState } = await loadModules()
        const chat = makeChat({ message: [{ role: 'user', data: 'hello?' }] })
        mocks.db.characters = [makeChar(chat)]
        setupServer({
            active: [makeJob({ status: 'running' })],
            pendingSends: [record()],
        })

        await recovery.recoverModelJobs()

        expect(get(pending.resumableSends).size).toBe(0)          // job recovery owns it
        expect(genState.isChatGenerating('chat-1')).toBe(true)    // reattached as background
        vi.useRealTimers()
    })
})

// --- running jobs -----------------------------------------------------------

describe('attachRunningJob', () => {
    test('holds the send guard, shows a background status, and slots in on poll completion', async () => {
        vi.useFakeTimers()
        const { recovery, genState, status } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        setupServer({
            journals: { 'job-1': OPENAI_SSE },
            jobStates: { 'job-1': [makeJob({ status: 'running' }), makeJob({ status: 'done' })] },
        })

        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)

        // Guard held + background status published immediately.
        expect(genState.isChatGenerating('chat-1')).toBe(true)
        expect(get(status.requestStatuses).get('gen-1')?.phase).toBe('background')

        // First poll: still running.
        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_INITIAL_MS + 50)
        expect(genState.isChatGenerating('chat-1')).toBe(true)

        // Second poll: done → slot-in, guard released, status terminal.
        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_MAX_MS)
        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].data).toBe('Hello')
        expect(genState.isChatGenerating('chat-1')).toBe(false)
        expect(get(status.requestStatuses).get('gen-1')?.phase).toBe('done')
        status.stopStatusTimer()
    })

    test('a second attach of the same job does not start a second poll loop', async () => {
        vi.useFakeTimers()
        const { recovery, genState } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        setupServer({
            journals: { 'job-1': OPENAI_SSE },
            jobStates: { 'job-1': [makeJob({ status: 'done' })] },
        })

        // Two returns to the tab in a row → discovery runs twice on one job.
        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)
        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)

        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_INITIAL_MS + 50)
        expect(chat.message).toHaveLength(1) // one poll loop → one slot-in
        expect(genState.isChatGenerating('chat-1')).toBe(false)
    })

    test('skips a chat whose LIVE send still owns the generation', async () => {
        vi.useFakeTimers()
        const { recovery, genState } = await loadModules()
        const chat = makeChat()
        mocks.db.characters = [makeChar(chat)]
        setupServer({ jobStates: { 'job-1': [makeJob({ status: 'done' })] } })

        // Returning to the tab mid-generation: the live send is still streaming.
        genState.startGeneration('chat-1', 'gen-1', 'live')
        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)

        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_INITIAL_MS + 50)
        // The live generation keeps its guard; no background takeover, no slot-in.
        expect(genState.isChatGenerating('chat-1')).toBe(true)
        expect(get(genState.generationStates).get('chat-1')?.kind).toBe('live')
        expect(chat.message).toHaveLength(0)
    })

    test('a 404 during polling (job aborted elsewhere) releases the guard as aborted', async () => {
        vi.useFakeTimers()
        const { recovery, genState, status } = await loadModules()
        mocks.db.characters = [makeChar(makeChat())]
        setupServer({}) // no jobStates → GET /:id replies 404

        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)
        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_INITIAL_MS + 50)

        expect(genState.isChatGenerating('chat-1')).toBe(false)
        expect(get(status.requestStatuses).get('gen-1')?.phase).toBe('aborted')
        status.stopStatusTimer()
    })

    test('registers as background: doingChat stays false and endAllGenerations preserves the guard', async () => {
        vi.useFakeTimers()
        const { recovery, genState, status } = await loadModules()
        mocks.db.characters = [makeChar(makeChat())]
        setupServer({ jobStates: { 'job-1': [makeJob({ status: 'running' })] } })

        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)

        expect(genState.isChatGenerating('chat-1')).toBe(true)
        expect(get(genState.generationStates).get('chat-1')?.kind).toBe('background')
        expect(get(genState.doingChat)).toBe(false) // must not lock the global send UI
        genState.endAllGenerations() // DevTool/multisend cleanup writes
        expect(genState.isChatGenerating('chat-1')).toBe(true) // guard survives
        status.stopStatusTimer()
    })

    test('Stop on a reattached job DELETEs it and releases guard + status', async () => {
        vi.useFakeTimers()
        const { recovery, genState, status } = await loadModules()
        mocks.db.characters = [makeChar(makeChat())]
        const { calls } = setupServer({ jobStates: { 'job-1': [makeJob({ status: 'running' })] } })

        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)
        expect(genState.abortGeneration('chat-1')).toBe(true)
        await vi.advanceTimersByTimeAsync(0) // flush the fire-and-forget DELETE

        expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/model-jobs/job-1')).toBe(true)
        expect(genState.isChatGenerating('chat-1')).toBe(false)
        expect(get(status.requestStatuses).get('gen-1')?.phase).toBe('aborted')

        // Poll loop stopped: no further status GETs after the next interval.
        const getsBefore = calls.filter((c) => c.method === 'GET' && c.url === '/api/model-jobs/job-1').length
        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_MAX_MS * 2)
        const getsAfter = calls.filter((c) => c.method === 'GET' && c.url === '/api/model-jobs/job-1').length
        expect(getsAfter).toBe(getsBefore)
        status.stopStatusTimer()
    })

    test('poll deadline with the status endpoint unreachable gives up silently', async () => {
        vi.useFakeTimers()
        const { recovery, genState, status } = await loadModules()
        mocks.db.characters = [makeChar(makeChat())]
        const { claims } = setupServer({ jobStatusUnreachable: true })

        recovery.attachRunningJob(makeJob({ status: 'running' }) as any)
        await vi.advanceTimersByTimeAsync(recovery.JOB_POLL_DEADLINE_MS + recovery.JOB_POLL_MAX_MS * 2)

        expect(genState.isChatGenerating('chat-1')).toBe(false)          // guard released
        expect(get(status.requestStatuses).has('gen-1')).toBe(false)     // entry dismissed, no failure toast
        expect(claims()).toEqual([])                                      // not claimed → next boot recovers
        status.stopStatusTimer()
    })
})
