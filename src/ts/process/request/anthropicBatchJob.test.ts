import { describe, expect, test } from 'vitest'
import type { AdapterPreparedRequest } from 'src/ts/preset/adapter'
import { AnthropicBatchJob, anthropicBatchBaseUrl, submitAnthropicBatchJob, type AnthropicBatchFetchLogEntry } from './anthropicBatchJob'

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body?: unknown
    signal?: AbortSignal | null
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

function textResponse(body: string, status = 200): Response {
    return new Response(body, { status })
}

function prepared(overrides: Partial<AdapterPreparedRequest> = {}): AdapterPreparedRequest {
    return {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'sk-test',
            'anthropic-version': '2023-06-01',
        },
        body: {
            model: 'claude-test',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
            max_tokens: 100,
        },
        ...overrides,
    }
}

function captureFetch(respond: (call: CapturedCall, calls: CapturedCall[]) => Response): {
    fetchImpl: typeof fetch
    calls: CapturedCall[]
} {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const call: CapturedCall = {
            url,
            method: (init?.method ?? 'GET') as string,
            headers: (init?.headers as Record<string, string>) ?? {},
            body: init?.body ? JSON.parse(init.body as string) : undefined,
            signal: init?.signal ?? null,
        }
        calls.push(call)
        return respond(call, calls)
    }
    return { fetchImpl, calls }
}

function successJsonl(text = 'Done'): string {
    return JSON.stringify({
        result: {
            type: 'succeeded',
            message: {
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn',
            },
        },
    }) + '\n'
}

function expiredJsonl(): string {
    return JSON.stringify({ result: { type: 'expired' } }) + '\n'
}

describe('Anthropic preset batch jobs', () => {
    test('builds batch URLs from messages endpoint URLs', () => {
        expect(anthropicBatchBaseUrl('https://api.anthropic.com/v1/messages'))
            .toBe('https://api.anthropic.com/v1/messages/batches')
        expect(anthropicBatchBaseUrl('https://proxy.test/v1'))
            .toBe('https://proxy.test/v1/messages/batches')
    })

    test('submits a single-message batch request and returns a job', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ id: 'batch_123' }))
        const req = prepared()
        const submitted = await submitAnthropicBatchJob({
            prepared: req,
            fetchImpl,
            customId: 'custom-1',
            sleep: async () => {},
        })

        expect(submitted.ok).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages/batches')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].headers['x-api-key']).toBe('sk-test')
        expect(calls[0].body).toEqual({
            requests: [{ custom_id: 'custom-1', params: req.body }],
        })
    })

    test('strips batch service tier from submitted batch params', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ id: 'batch_123' }))
        await submitAnthropicBatchJob({
            prepared: prepared({ body: { ...prepared().body, service_tier: 'batch' } }),
            fetchImpl,
            customId: 'custom-1',
        })

        expect(calls[0].body).toEqual({
            requests: [{
                custom_id: 'custom-1',
                params: {
                    model: 'claude-test',
                    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
                    max_tokens: 100,
                },
            }],
        })
    })

    test('polls until ended and parses successful JSONL results', async () => {
        let statusPolls = 0
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(successJsonl('Final text'))
            statusPolls++
            return jsonResponse({ processing_status: statusPolls === 1 ? 'in_progress' : 'ended' })
        })
        const statuses: string[] = []
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait({ onStatus: (status) => statuses.push(status.state) })

        expect(result).toEqual({ type: 'success', result: 'Final text' })
        expect(statuses).toEqual(['running', 'succeeded'])
        expect(job.getStatus()).toEqual({ state: 'succeeded', message: 'Anthropic batch completed' })
    })

    test('cancel requests provider cancellation but still accepts late success', async () => {
        const abortController = new AbortController()
        abortController.abort()
        const { fetchImpl, calls } = captureFetch((call) => {
            if (call.url.endsWith('/cancel')) return jsonResponse({ id: 'batch_123', processing_status: 'canceling' })
            if (call.url.endsWith('/results')) return textResponse(successJsonl('Late success'))
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait({ signal: abortController.signal })

        expect(result).toEqual({ type: 'success', result: 'Late success' })
        expect(calls.some((call) => call.url.endsWith('/cancel') && call.method === 'POST')).toBe(true)
        const statusCall = calls.find((call) => call.url.endsWith('/batch_123') && call.method === 'GET')
        expect(statusCall?.signal).toBeNull()
    })

    test('logs submit and results bodies without consuming responses', async () => {
        const logs: AnthropicBatchFetchLogEntry[] = []
        const { fetchImpl, calls } = captureFetch((call) => {
            if (call.url.endsWith('/cancel')) return jsonResponse({ id: 'batch_123', processing_status: 'canceling' })
            if (call.url.endsWith('/results')) return textResponse(successJsonl('Logged final text'))
            if (call.url.endsWith('/batch_123')) return jsonResponse({ processing_status: 'ended' })
            return jsonResponse({ id: 'batch_123' })
        })

        const submitted = await submitAnthropicBatchJob({
            prepared: prepared(),
            fetchImpl,
            customId: 'custom-1',
            sleep: async () => {},
            logFetch: (entry) => logs.push(entry),
        })

        expect(submitted.ok).toBe(true)
        if (submitted.ok === false) return

        await submitted.job.cancel()
        const result = await submitted.job.wait()

        expect(result).toEqual({ type: 'success', result: 'Logged final text' })
        expect(logs.map((log) => log.url)).toEqual([
            'https://api.anthropic.com/v1/messages/batches',
            'https://api.anthropic.com/v1/messages/batches/batch_123/results',
        ])
        expect(calls.some((call) => call.url.endsWith('/cancel'))).toBe(true)
        expect(calls.some((call) => call.url.endsWith('/batch_123') && call.method === 'GET')).toBe(true)
        expect(logs[0].body).toContain('custom-1')
        expect(logs[0].response).toContain('batch_123')
        expect(logs[1].body).toBe('')
        expect(logs[1].response).toContain('Logged final text')
        expect(logs.every((log) => log.success === true && log.status === 200)).toBe(true)
    })

    test('logs submit and final expired results without status polling noise', async () => {
        const logs: AnthropicBatchFetchLogEntry[] = []
        const { fetchImpl, calls } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(expiredJsonl())
            if (call.url.endsWith('/batch_123')) return jsonResponse({ processing_status: 'ended' })
            return jsonResponse({ id: 'batch_123' })
        })

        const submitted = await submitAnthropicBatchJob({
            prepared: prepared(),
            fetchImpl,
            customId: 'custom-1',
            sleep: async () => {},
            logFetch: (entry) => logs.push(entry),
        })

        expect(submitted.ok).toBe(true)
        if (submitted.ok === false) return

        const result = await submitted.job.wait()

        expect(result).toEqual({ type: 'fail', result: 'Anthropic batch request expired' })
        expect(logs.map((log) => log.url)).toEqual([
            'https://api.anthropic.com/v1/messages/batches',
            'https://api.anthropic.com/v1/messages/batches/batch_123/results',
        ])
        expect(calls.some((call) => call.url.endsWith('/batch_123') && call.method === 'GET')).toBe(true)
        expect(logs[1].response).toContain('expired')
    })
})
