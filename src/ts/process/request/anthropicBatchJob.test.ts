import { describe, expect, test } from 'vitest'
import type { AdapterPreparedRequest } from 'src/ts/preset/adapter'
import { AnthropicBatchJob, anthropicBatchBaseUrl, previewAnthropicBatchRequest, submitAnthropicBatchJob, type AnthropicBatchFetchLogEntry } from './anthropicBatchJob'

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

function erroredJsonl(): string {
    return JSON.stringify({ result: { type: 'errored', error: { error: { message: 'Bad request' } } } }) + '\n'
}

function canceledJsonl(): string {
    return JSON.stringify({ result: { type: 'canceled' } }) + '\n'
}

function toolUseJsonl(): string {
    return JSON.stringify({
        result: {
            type: 'succeeded',
            message: {
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'Dice', input: { sides: 6 } }],
                stop_reason: 'tool_use',
            },
        },
    }) + '\n'
}

describe('Anthropic preset batch jobs', () => {
    test('builds batch URLs from messages endpoint URLs', () => {
        expect(anthropicBatchBaseUrl('https://api.anthropic.com/v1/messages'))
            .toBe('https://api.anthropic.com/v1/messages/batches')
        expect(anthropicBatchBaseUrl('https://proxy.test/v1'))
            .toBe('https://proxy.test/v1/messages/batches')
    })

    test('builds preview batch request body from prepared Anthropic messages request', () => {
        const req = prepared({
            body: {
                ...prepared().body,
                service_tier: 'batch',
                stream: true,
            },
        })

        const preview = previewAnthropicBatchRequest(req)

        expect(preview).toEqual({
            url: 'https://api.anthropic.com/v1/messages/batches',
            body: {
                requests: [{
                    custom_id: 'preview',
                    params: {
                        model: 'claude-test',
                        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
                        max_tokens: 100,
                    },
                }],
            },
            headers: req.headers,
        })
        expect(preview.headers).toBe(req.headers)
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

    test('preserves tool fields in submitted batch params', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ id: 'batch_123' }))
        await submitAnthropicBatchJob({
            prepared: prepared({
                body: {
                    ...prepared().body,
                    tools: [{ name: 'Dice', input_schema: { type: 'object' } }],
                    tool_choice: { type: 'tool', name: 'Dice' },
                },
            }),
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
                    tools: [{ name: 'Dice', input_schema: { type: 'object' } }],
                    tool_choice: { type: 'tool', name: 'Dice' },
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

    test('checks status before the first poll sleep', async () => {
        let sleepCalls = 0
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(successJsonl('Already done'))
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, {
            sleep: async () => { sleepCalls++ },
        })

        const result = await job.wait()

        expect(result).toEqual({ type: 'success', result: 'Already done' })
        expect(sleepCalls).toBe(0)
    })

    test('parses tool_use JSONL results for batch follow-ups', async () => {
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(toolUseJsonl())
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.waitForResponse()

        expect(result.type).toBe('success')
        if (result.type !== 'success') return
        expect(result.response.toolCalls).toEqual([{ id: 'toolu_1', name: 'Dice', arguments: '{"sides":6}' }])
        expect(result.response.providerEcho).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'Dice', input: { sides: 6 } }])
    })

    test.each([
        ['malformed JSON', () => textResponse('{')],
        ['missing processing_status', () => jsonResponse({ id: 'batch_123' })],
    ])('fails fast when status response has %s', async (_case, responseFactory) => {
        const { fetchImpl, calls } = captureFetch(() => responseFactory())
        const statuses: string[] = []
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait({ onStatus: (status) => statuses.push(status.state) })

        expect(result).toEqual({ type: 'fail', result: 'Invalid Anthropic batch status response' })
        expect(job.getStatus()).toEqual({ state: 'failed', message: 'Invalid Anthropic batch status response' })
        expect(statuses).toEqual(['failed'])
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages/batches/batch_123')
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

    test('formats errored JSONL result without undefined type prefix', async () => {
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(erroredJsonl())
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait()

        expect(result).toEqual({ type: 'fail', result: 'Bad request' })
        expect(job.getStatus()).toEqual({ state: 'failed', message: 'Bad request' })
    })

    test('returns canceled result from canceled JSONL result', async () => {
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse(canceledJsonl())
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait()

        expect(result).toEqual({ type: 'canceled', result: 'Anthropic batch canceled' })
        expect(job.getStatus()).toEqual({ state: 'canceled', message: 'Anthropic batch canceled' })
    })

    test('fails when results JSONL contains no batch result', async () => {
        const { fetchImpl } = captureFetch((call) => {
            if (call.url.endsWith('/results')) return textResponse('{"not_result":true}\n')
            return jsonResponse({ processing_status: 'ended' })
        })
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, { sleep: async () => {} })

        const result = await job.wait()

        expect(result).toEqual({ type: 'fail', result: 'No Anthropic batch result found' })
    })

    test('fails when timeout is exceeded', async () => {
        let nowCalls = 0
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ processing_status: 'in_progress' }))
        const job = new AnthropicBatchJob('custom-1', prepared(), 'batch_123', fetchImpl, {
            timeoutMs: 10,
            now: () => nowCalls++ < 2 ? 0 : 20,
            sleep: async () => {},
        })

        const result = await job.wait()

        expect(result).toEqual({ type: 'fail', result: 'Anthropic batch request timed out' })
        expect(calls).toHaveLength(0)
    })

    test('surfaces submit failures', async () => {
        const transport = await submitAnthropicBatchJob({
            prepared: prepared(),
            fetchImpl: async () => { throw new Error('network down') },
            customId: 'custom-1',
        })
        expect(transport).toEqual({ ok: false, error: 'network down' })

        const http = await submitAnthropicBatchJob({
            prepared: prepared(),
            fetchImpl: async () => textResponse('bad key', 401),
            customId: 'custom-1',
        })
        expect(http).toEqual({ ok: false, error: 'bad key' })

        const missingId = await submitAnthropicBatchJob({
            prepared: prepared(),
            fetchImpl: async () => jsonResponse({ id: '' }),
            customId: 'custom-1',
        })
        expect(missingId).toEqual({ ok: false, error: 'No batch id returned from Anthropic batch request' })
    })
})
