import { describe, expect, test } from 'vitest'
import { loadBundledRegistry } from '../registry/loader'
import { resolveSnapshot } from '../registry/snapshot'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import { sendChatRequest, streamChatRequest, previewChatRequest } from './openaiCompatible'
import type { AdapterChatMessage } from './types'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        profileVersion: 1,
        providerBaseId: 'demo',
        providerBaseVersion: 1,
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                default: 'demo-fast',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo Preset',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

const userMessages: AdapterChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
    signal: AbortSignal | null | undefined
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(encoder.encode(chunks[i]))
                i++
            } else {
                controller.close()
            }
        },
    })
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    })
}

function captureFetch(response: Response | (() => Response)): {
    fetchImpl: typeof fetch
    calls: CapturedCall[]
} {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = init?.headers as Record<string, string> | undefined
        const body = init?.body != null ? JSON.parse(init.body as string) : {}
        calls.push({
            url,
            method: (init?.method ?? 'GET') as string,
            headers: headers ?? {},
            body,
            signal: init?.signal,
        })
        return typeof response === 'function' ? response() : response
    }
    return { fetchImpl, calls }
}

describe('sendChatRequest (non-stream)', () => {
    test('builds OpenAI-compatible body and parses choices/usage', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                choices: [
                    {
                        message: { role: 'assistant', content: 'hi there' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk-test' },
        )
        expect(result.text).toBe('hi there')
        expect(result.finishReason).toBe('stop')
        expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 2, totalTokens: 11 })

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://demo.test/v1/chat/completions')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
        expect(calls[0].headers['Content-Type']).toBe('application/json')
        expect(calls[0].body).toEqual({
            model: 'demo-fast',
            stream: false,
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
            ],
        })
    })

    test('customBody cannot override messages or stream', async () => {
        const preset = makePreset({
            customBody: {
                messages: [{ role: 'system', content: 'hijacked' }],
                stream: true,
                extra: 'kept',
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.messages).toEqual([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
        ])
        expect(calls[0].body.stream).toBe(false)
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.model cannot override the wire model id', async () => {
        // body.model is a wire invariant per plan §4-5. resolveWireModelId
        // reads modelId from userValues / schema / snapshot directly, so a
        // customBody key collision must lose.
        const preset = makePreset({
            userValues: { modelId: 'demo-fast' },
            customBody: { model: 'hijacked-model' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.model).toBe('demo-fast')
    })

    test('throws invalid-request when userValues.modelId is an empty string', async () => {
        // Explicit empty modelId is treated as a configuration error rather
        // than silently falling back to the schema default (otherwise
        // corrupted UI/migration data would call the wrong endpoint).
        const preset = makePreset({ userValues: { modelId: '' } })
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await expect(
            sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('throws auth error on 401 with provider error message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'invalid key', type: 'auth' } }, { status: 401 }),
        )
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'auth',
            status: 401,
            retryable: false,
            fallbackEligible: false,
            message: 'invalid key',
        })
    })

    test('throws server error on 500 with parsed message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'upstream down' } }, { status: 500 }),
        )
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'server', status: 500, fallbackEligible: true })
    })

    test('throws parse error when response is missing choices', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ choices: [] }))
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'parse' })
    })

    test('passes through abort signal and normalizes AbortError', async () => {
        const controller = new AbortController()
        const abort = new Error('user cancelled')
        abort.name = 'AbortError'
        const fetchImpl: typeof fetch = async (_input, init) => {
            expect(init?.signal).toBe(controller.signal)
            throw abort
        }
        await expect(
            sendChatRequest(
                makePreset(),
                { messages: userMessages, fetchImpl, abortSignal: controller.signal },
                { apiKey: 'sk' },
            ),
        ).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    })

    test('network errors are normalized to retryable network kind', async () => {
        const fetchImpl: typeof fetch = async () => {
            throw new TypeError('fetch failed')
        }
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'network', retryable: true, fallbackEligible: true })
    })

    test('translates AdapterChatMessage fields to wire format (name, tool_call_id)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    {
                        role: 'tool',
                        content: '{"result":42}',
                        name: 'calc',
                        toolCallId: 'call_1',
                    },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        expect(calls[0].body.messages).toEqual([
            { role: 'tool', content: '{"result":42}', name: 'calc', tool_call_id: 'call_1' },
        ])
    })
})

describe('streamChatRequest', () => {
    test('yields textDelta chunks and stops at [DONE]', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        const deltas: string[] = []
        let lastFinish: string | undefined
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) lastFinish = delta.finishReason
        }
        expect(deltas.join('')).toBe('Hello')
        expect(lastFinish).toBe('stop')
        expect(calls[0].body.stream).toBe(true)
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('routes reasoning / reasoning_content deltas to reasoningDelta, not textDelta', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"reasoning":"step "}}]}\n\n',
                'data: {"choices":[{"delta":{"reasoning_content":"two"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }
        expect(text.join('')).toBe('answer')
        expect(reasoning.join('')).toBe('step two')
    })

    test('captures usage emitted in the final chunk', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.usage) usage = delta.usage
        }
        expect(usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 })
    })

    test('throws parse error on non-JSON SSE data', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: {not json}\n\n']))
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })

    test('classifies HTTP errors before streaming starts', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'limited' } }, { status: 429 }),
        )
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('normalizes AbortError thrown during stream body read', async () => {
        const abort = new Error('user cancelled mid stream')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        const collect = async () => {
            const out: string[] = []
            for await (const delta of gen) {
                if (delta.textDelta) out.push(delta.textDelta)
            }
            return out
        }
        await expect(collect()).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'aborted',
            retryable: false,
        })
    })

    test('normalizes network errors thrown during stream body read', async () => {
        const networkErr = new TypeError('connection reset')
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(networkErr)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'network',
            retryable: true,
            fallbackEligible: true,
        })
    })

    test('lets domain parse errors pass through the stream wrapper', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: not-json\n\n']))
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })
})

describe('bundled OpenAI-compatible profiles', () => {
    const registry = loadBundledRegistry()

    test.each([
        ['openai:gpt-55', 'https://api.openai.com/v1/chat/completions'],
        ['openrouter:openai-compatible', 'https://openrouter.ai/api/v1/chat/completions'],
        ['ollama:openai-compatible-local', 'http://localhost:11434/v1/chat/completions'],
    ])('builds the right URL and auth header for %s', async (profileId, expectedUrl) => {
        const snapshot = resolveSnapshot(registry, profileId)
        const preset: ModelPreset = {
            id: `preset-${profileId}`,
            name: profileId,
            profileSnapshot: snapshot,
            userValues: { modelId: 'demo-model' },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk-test' })
        expect(calls[0].url).toBe(expectedUrl)
        if (snapshot.auth.kind === 'bearer') {
            expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
        } else if (snapshot.auth.kind === 'none') {
            expect(calls[0].headers.Authorization).toBeUndefined()
        }
    })

    test('openai-compatible:custom resolves endpoint URL from userValues', async () => {
        const snapshot = resolveSnapshot(registry, 'openai-compatible:custom')
        const preset: ModelPreset = {
            id: 'preset-custom',
            name: 'Custom Provider',
            profileSnapshot: snapshot,
            userValues: {
                endpointUrl: 'https://my-llm.example.com/v1/chat/completions',
                modelId: 'my-llm-7b',
            },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await sendChatRequest(
            preset,
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk-custom' },
        )
        expect(calls[0].url).toBe('https://my-llm.example.com/v1/chat/completions')
        expect(calls[0].body.model).toBe('my-llm-7b')
        expect(calls[0].headers.Authorization).toBe('Bearer sk-custom')
    })

    test('openai-compatible:custom-noauth calls endpoint without Authorization header', async () => {
        const snapshot = resolveSnapshot(registry, 'openai-compatible:custom-noauth')
        const preset: ModelPreset = {
            id: 'preset-custom-noauth',
            name: 'Local vLLM',
            profileSnapshot: snapshot,
            userValues: {
                endpointUrl: 'http://localhost:8000/v1/chat/completions',
                modelId: 'llama3-8b',
            },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl })
        expect(calls[0].url).toBe('http://localhost:8000/v1/chat/completions')
        expect(calls[0].body.model).toBe('llama3-8b')
        expect(calls[0].headers.Authorization).toBeUndefined()
    })

    test('openai-compatible:custom with missing endpointUrl throws invalid-request', async () => {
        const snapshot = resolveSnapshot(registry, 'openai-compatible:custom')
        const preset: ModelPreset = {
            id: 'preset-custom-blank',
            name: 'Custom Provider',
            profileSnapshot: snapshot,
            userValues: { modelId: 'my-llm' },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl } = captureFetch(jsonResponse({}))
        await expect(
            sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('ollama profile works without credential under auth.none', async () => {
        const snapshot = resolveSnapshot(registry, 'ollama:openai-compatible-local')
        const preset: ModelPreset = {
            id: 'preset-ollama',
            name: 'Ollama',
            profileSnapshot: snapshot,
            userValues: { modelId: 'llama3' },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl })
        expect(calls[0].body.model).toBe('llama3')
        expect(calls[0].headers.Authorization).toBeUndefined()
    })
})

describe('error class identity', () => {
    test('thrown error is ModelPresetAdapterError instance', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({}, { status: 403 }))
        try {
            await sendChatRequest(
                makePreset(),
                { messages: userMessages, fetchImpl },
                { apiKey: 'sk' },
            )
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
        }
    })
})

describe('tool use (Stage 1)', () => {
    const toolDef = {
        name: 'search',
        description: 'web search',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }

    test('declares tools as function envelopes in the request body', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(calls[0].body.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'search',
                    description: 'web search',
                    parameters: { type: 'object', properties: { q: { type: 'string' } } },
                },
            },
        ])
    })

    test('serializes assistant toolCalls and tool results onto the wire', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'final' } }] }),
        )
        const convo: AdapterChatMessage[] = [
            { role: 'user', content: 'find x' },
            { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }] },
            { role: 'tool', content: 'result text', toolCallId: 'c1', name: 'search' },
        ]
        await sendChatRequest(
            makePreset(),
            { messages: convo, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual({
            role: 'assistant',
            content: 'checking',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        })
        expect(wire[2]).toEqual({ role: 'tool', content: 'result text', name: 'search', tool_call_id: 'c1' })
    })

    test('parses tool_calls (including parallel) from the response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            { id: 'a', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
                            { id: 'b', type: 'function', function: { name: 'beta', arguments: '{}' } },
                        ],
                    },
                    finish_reason: 'tool_calls',
                }],
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(result.toolCalls).toEqual([
            { id: 'a', name: 'alpha', arguments: '{"n":1}' },
            { id: 'b', name: 'beta', arguments: '{}' },
        ])
    })

    test('omits tools and tool-coupled fields on tool-less requests', async () => {
        const preset = makePreset({ customBody: { parallel_tool_calls: true, tool_choice: 'auto' } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.tools).toBeUndefined()
        expect(calls[0].body.parallel_tool_calls).toBeUndefined()
        expect(calls[0].body.tool_choice).toBeUndefined()
    })

    test('strips customBody.tools when the request carries no tools (off = hard gate)', async () => {
        const preset = makePreset({ customBody: { tools: [{ type: 'function', function: { name: 'sneaky' } }] } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.tools).toBeUndefined()
    })

    test('resends an assistant turn verbatim via providerEcho (preserves reasoning_details)', async () => {
        const rawAssistant = {
            role: 'assistant',
            content: 'thinking out loud',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } }],
            reasoning_details: [{ type: 'reasoning.text', text: 'chain', id: 'r1' }],
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'thinking out loud', toolCalls: [{ id: 't1', name: 'a', arguments: '{}' }], providerEcho: rawAssistant },
                    { role: 'tool', content: 'r', toolCallId: 't1', name: 'a' },
                ],
                tools: [toolDef],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual(rawAssistant) // byte-for-byte, incl. reasoning_details
    })

    test('round-trips Gemini thought signature via extra_content (OpenRouter)', async () => {
        // Parse: signature lifted from extra_content.google.thought_signature.
        const { fetchImpl } = captureFetch(
            jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'g1',
                            type: 'function',
                            function: { name: 'search', arguments: '{}' },
                            extra_content: { google: { thought_signature: 'SIG-XYZ' } },
                        }],
                    },
                }],
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(result.toolCalls).toEqual([{ id: 'g1', name: 'search', arguments: '{}', signature: 'SIG-XYZ' }])

        // Serialize: signature written back to the same extension on the wire.
        const { fetchImpl: fetchImpl2, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'search', arguments: '{}', signature: 'SIG-XYZ' }] },
                    { role: 'tool', content: 'r', toolCallId: 'g1', name: 'search' },
                ],
                tools: [toolDef],
                fetchImpl: fetchImpl2,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1].tool_calls).toEqual([{
            id: 'g1',
            type: 'function',
            function: { name: 'search', arguments: '{}' },
            extra_content: { google: { thought_signature: 'SIG-XYZ' } },
        }])
    })
})

describe('vision (Stage 3)', () => {
    test('serializes a user image as a content-part array with text + image_url', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'what is this', images: [{ kind: 'image', base64: 'AAAA', mime: 'image/jpeg' }] },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'what is this' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            ],
        })
    })

    test('a text-only user turn stays a plain string (no regression)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual({ role: 'user', content: 'Hello' })
    })

    test('defaults mime to image/png when omitted', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: '', images: [{ kind: 'image', base64: 'ZZ' }] }], fetchImpl },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZZ' } }])
    })
})

describe('reasoning display (Stage 4a)', () => {
    test('parses the OpenRouter `reasoning` string into a reasoning part', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'answer', reasoning: 'because' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toEqual([{ text: 'because' }])
    })

    test('falls back to `reasoning_content` (DeepSeek-style)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'a', reasoning_content: 'step' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toEqual([{ text: 'step' }])
    })

    test('no reasoning field → undefined (non-reasoning models unchanged)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'a' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toBeUndefined()
    })
})

describe('previewChatRequest (no network)', () => {
    test('returns the prepared body without fetching', async () => {
        let fetched = false
        const fetchImpl: typeof fetch = async () => { fetched = true; return jsonResponse({}) }
        const prepared = await previewChatRequest(
            makePreset(),
            { messages: userMessages, tools: [{ name: 'a', parameters: { type: 'object' } }], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(fetched).toBe(false)
        expect(prepared.url).toBe('https://demo.test/v1/chat/completions')
        expect((prepared.body.tools as unknown[]).length).toBe(1)
    })
})

describe('streaming usage opt-in', () => {
    const drain = async (gen: AsyncGenerator<unknown>) => { for await (const _ of gen) { /* drain */ } }

    test('does not send stream_options by default', async () => {
        const { fetchImpl, calls } = captureFetch(() => sseResponse(['data: [DONE]\n\n']))
        await drain(streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk-test' },
        ) as AsyncGenerator<unknown>)
        // A strict OpenAI-compatible server can 400 on an unknown field, so the
        // default request must stay byte-identical to before the feature.
        expect(calls[0].body.stream_options).toBeUndefined()
        expect(calls[0].body.stream).toBe(true)
    })

    test('asks for usage when the caller opted in', async () => {
        const { fetchImpl, calls } = captureFetch(() => sseResponse(['data: [DONE]\n\n']))
        await drain(streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl, collectStreamUsage: true },
            { apiKey: 'sk-test' },
        ) as AsyncGenerator<unknown>)
        expect(calls[0].body.stream_options).toEqual({ include_usage: true })
    })

    test('never sends it on a non-streaming request', async () => {
        const { fetchImpl, calls } = captureFetch(jsonResponse({
            choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        }))
        await sendChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl, collectStreamUsage: true },
            { apiKey: 'sk-test' },
        )
        expect(calls[0].body.stream_options).toBeUndefined()
    })
})
