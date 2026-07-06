import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import pkg from './fetchJob.cjs'

const { startFetchJob, waitFetchJob, ackFetchJob, cancelFetchJob } = pkg as {
    startFetchJob: (request: {
        jobId: string
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
    }) => { jobId: string; status: string; error: string | null; response: any }
    waitFetchJob: (jobId: string, waitMs?: number) => Promise<{ jobId: string; status: string; error: string | null; response: any } | null>
    ackFetchJob: (jobId: string) => boolean
    cancelFetchJob: (jobId: string) => boolean
}

let jobCounter = 0
function freshJobId() {
    jobCounter++
    return `test-job-${Date.now()}-${jobCounter}`
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

// Controllable upstream: resolves when the test says so, so we can observe
// the 'running' state deterministically.
function deferredFetch() {
    let resolve!: (r: Response) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej })
    const mock = vi.fn(() => promise)
    return { mock, resolve, reject }
}

const realFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
})

describe('fetchJob', () => {
    it('runs the upstream request and delivers the buffered response', async () => {
        const upstream = vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 2, 3] }] }))
        globalThis.fetch = upstream as any

        const jobId = freshJobId()
        const started = startFetchJob({
            jobId,
            url: 'https://example.com/v1/embeddings',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: ['hello'] }),
        })
        expect(started.status).toBe('running')

        const snapshot = await waitFetchJob(jobId, 5000)
        expect(snapshot?.status).toBe('done')
        expect(snapshot?.response.status).toBe(200)
        const decoded = JSON.parse(Buffer.from(snapshot!.response.bodyB64, 'base64').toString('utf-8'))
        expect(decoded.data[0].embedding).toEqual([1, 2, 3])

        expect(upstream).toHaveBeenCalledTimes(1)
        const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
        expect(init.method).toBe('POST')
        expect(init.body).toBe(JSON.stringify({ input: ['hello'] }))
    })

    it('is idempotent on jobId: re-sending start does not re-fire upstream', async () => {
        const { mock, resolve } = deferredFetch()
        globalThis.fetch = mock as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/a' })
        const again = startFetchJob({ jobId, url: 'https://example.com/a' })
        expect(again.status).toBe('running')
        expect(mock).toHaveBeenCalledTimes(1)

        resolve(jsonResponse({ ok: 1 }))
        const snapshot = await waitFetchJob(jobId, 5000)
        expect(snapshot?.status).toBe('done')

        // start after completion returns the stored result without re-firing
        const afterDone = startFetchJob({ jobId, url: 'https://example.com/a' })
        expect(afterDone.status).toBe('done')
        expect(mock).toHaveBeenCalledTimes(1)
    })

    it('keeps upstream error statuses as done — the client decides ok-ness', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'invalid key' }, 401)) as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/v1/embeddings' })
        const snapshot = await waitFetchJob(jobId, 5000)
        expect(snapshot?.status).toBe('done')
        expect(snapshot?.response.status).toBe(401)
    })

    it('reports network failures as job errors', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/unreachable' })
        const snapshot = await waitFetchJob(jobId, 5000)
        expect(snapshot?.status).toBe('error')
        expect(snapshot?.error).toContain('ECONNREFUSED')
    })

    it('long-poll returns running when the job has not finished within waitMs', async () => {
        const { mock } = deferredFetch()
        globalThis.fetch = mock as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/slow' })
        const snapshot = await waitFetchJob(jobId, 50)
        expect(snapshot?.status).toBe('running')
        expect(snapshot?.response).toBeNull()

        cancelFetchJob(jobId)
    })

    it('ack removes finished jobs but refuses to drop running ones', async () => {
        const { mock, resolve } = deferredFetch()
        globalThis.fetch = mock as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/a' })
        expect(ackFetchJob(jobId)).toBe(false)

        resolve(jsonResponse({ ok: 1 }))
        await waitFetchJob(jobId, 5000)
        expect(ackFetchJob(jobId)).toBe(true)
        expect(await waitFetchJob(jobId, 0)).toBeNull()
    })

    it('cancel aborts and removes the job', async () => {
        const { mock } = deferredFetch()
        globalThis.fetch = mock as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/a' })
        expect(cancelFetchJob(jobId)).toBe(true)
        expect(await waitFetchJob(jobId, 0)).toBeNull()
        expect(cancelFetchJob(jobId)).toBe(false)
    })

    it('rejects invalid jobIds', () => {
        expect(() => startFetchJob({ jobId: 'no spaces allowed', url: 'https://example.com' })).toThrow()
        expect(() => startFetchJob({ jobId: 'short', url: 'https://example.com' })).toThrow()
        expect(() => startFetchJob({ jobId: freshJobId() })).toThrow(/url/i)
    })

    it('times out stuck upstream requests', async () => {
        // Never-resolving upstream honoring abort, with a 1s minimum job timeout.
        globalThis.fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
            init.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        })) as any

        const jobId = freshJobId()
        startFetchJob({ jobId, url: 'https://example.com/stuck', timeoutMs: 1 })
        const snapshot = await waitFetchJob(jobId, 5000)
        expect(snapshot?.status).toBe('error')
        expect(snapshot?.error).toMatch(/timed out/i)
        ackFetchJob(jobId)
    })
})
