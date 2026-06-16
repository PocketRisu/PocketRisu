import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetGeminiContextCacheRuntime } from '../cache/geminiContextCache'
import { loadBundledRegistry } from '../registry/loader'
import { resolveSnapshot } from '../registry/snapshot'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import * as serviceAccountCache from './googleServiceAccount/cache'
import { sendGoogleChatRequest, streamGoogleChatRequest } from './googleGemini'
import type { AdapterCacheContext, AdapterChatMessage } from './types'

// Minimal SA JSON that parseServiceAccountJson accepts; the token exchange is
// stubbed (see stubServiceAccountToken) so no signing/network happens.
const VERTEX_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'my-proj',
    private_key_id: 'kid-1',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@my-proj.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

// Replaces the default SA token cache so google-service-account profiles resolve
// to a fixed bearer token without a JWT-signing / OAuth round trip.
function stubServiceAccountToken(accessToken: string): void {
    vi.spyOn(serviceAccountCache, 'getDefaultServiceAccountTokenCache').mockReturnValue({
        getAccessToken: async () => ({
            accessToken,
            tokenType: 'Bearer',
            expiresAtMs: Date.now() + 3_600_000,
        }),
        clear() {},
    })
}

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:google',
        profileVersion: 1,
        providerBaseId: 'google',
        providerBaseVersion: 1,
        adapterKind: 'google-gemini',
        auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1beta/models' },
        modelId: 'gemini-demo',
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
                default: 'gemini-demo',
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
        id: 'preset-google',
        name: 'Gemini',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

const messagesWithSystem: AdapterChatMessage[] = [
    { role: 'system', content: 'You are factual.' },
    { role: 'user', content: 'Hi' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
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
        })
        return typeof response === 'function' ? response() : response
    }
    return { fetchImpl, calls }
}

describe('sendGoogleChatRequest (non-stream)', () => {
    test('embeds modelId in URL path, uses x-goog-api-key, and sends contents + systemInstruction', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: { parts: [{ text: 'hello' }], role: 'model' },
                        finishReason: 'STOP',
                    },
                ],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'goog-test' },
        )
        expect(result.text).toBe('hello')
        expect(result.finishReason).toBe('STOP')
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })

        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:generateContent')
        expect(calls[0].headers['x-goog-api-key']).toBe('goog-test')
        expect(calls[0].body.model).toBeUndefined() // moved into URL path
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hi' }] },
        ])
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('maps assistant role to model and merges multi-part text in candidate content', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'a ' }, { text: 'b' }],
                            role: 'model',
                        },
                    },
                ],
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'r' },
                    { role: 'user', content: 'q2' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('a b')
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'q' }] },
            { role: 'model', parts: [{ text: 'r' }] },
            { role: 'user', parts: [{ text: 'q2' }] },
        ])
    })

    test('omits systemInstruction when no system messages', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'x' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toBeUndefined()
    })

    test('serializes tool turns: functionCall on model, grouped functionResponse on user', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [
                        { id: 'c1', name: 'a', arguments: '{"x":1}', signature: 'sig-1' },
                        { id: 'c2', name: 'b', arguments: '{}' },
                    ] },
                    { role: 'tool', content: 'r1', toolCallId: 'c1', name: 'a' },
                    { role: 'tool', content: 'r2', toolCallId: 'c2', name: 'b' },
                ],
                tools: [{ name: 'a', description: 'A', parameters: { type: 'object' } }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        // model turn carries functionCall parts (id echoed); first has its signature.
        expect(contents[1]).toEqual({
            role: 'model',
            parts: [
                { functionCall: { id: 'c1', name: 'a', args: { x: 1 } }, thoughtSignature: 'sig-1' },
                { functionCall: { id: 'c2', name: 'b', args: {} } },
            ],
        })
        // both tool results collapse into one user turn of functionResponse parts (id echoed).
        expect(contents[2]).toEqual({
            role: 'user',
            parts: [
                { functionResponse: { id: 'c1', name: 'a', response: { result: 'r1' } } },
                { functionResponse: { id: 'c2', name: 'b', response: { result: 'r2' } } },
            ],
        })
        expect(calls[0].body.tools).toEqual([
            { functionDeclarations: [{ name: 'a', description: 'A', parameters: { type: 'object' } }] },
        ])
    })

    test('parses functionCall (with thoughtSignature) and thought parts from response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                candidates: [{
                    content: {
                        parts: [
                            { text: 'reasoning', thought: true, thoughtSignature: 'TS' },
                            { text: 'visible' },
                            { functionCall: { name: 'search', args: { q: 'x' } }, thoughtSignature: 'FS' },
                        ],
                    },
                }],
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('visible')
        // Gemini omits call ids; the adapter synthesizes a unique one (id asserted
        // separately below).
        expect(result.toolCalls).toMatchObject([{ name: 'search', arguments: '{"q":"x"}', signature: 'FS' }])
        expect(result.reasoning).toEqual([{ text: 'reasoning', signature: 'TS' }])
    })

    test('leaves call id empty when Gemini omits one (KV uniqueness handled downstream)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: {} } }] } }] }),
        )
        const r = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'a', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(r.toolCalls![0].id).toBe('')
    })

    test('round-trips Gemini provider call id on both functionCall and functionResponse', async () => {
        // Parse keeps the real id.
        const { fetchImpl } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { id: 'fc-7', name: 'a', args: {} } }] } }] }),
        )
        const r = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'a', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(r.toolCalls![0].id).toBe('fc-7')

        // Serialize echoes it on both sides (id matching for same-name parallel calls).
        const { fetchImpl: f2, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [{ id: 'fc-7', name: 'a', arguments: '{}' }] },
                    { role: 'tool', content: 'r', toolCallId: 'fc-7', name: 'a' },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl: f2,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { id: 'fc-7', name: 'a', args: {} } }] })
        expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'fc-7', name: 'a', response: { result: 'r' } } }] })
    })

    test('strips customBody.tools/toolConfig when the request carries no tools (off = hard gate)', async () => {
        const preset = makePreset({ customBody: { tools: [{ functionDeclarations: [{ name: 'sneaky' }] }], toolConfig: { functionCallingConfig: { mode: 'ANY' } } } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(preset, { messages: [{ role: 'user', content: 'q' }], fetchImpl }, { apiKey: 'k' })
        expect(calls[0].body.tools).toBeUndefined()
        expect(calls[0].body.toolConfig).toBeUndefined()
    })

    test('resends model parts verbatim via providerEcho (preserves text-part thoughtSignature)', async () => {
        // Gemini can attach a signature to a plain text part; it must come back exactly.
        const rawParts = [
            { text: 'visible answer', thoughtSignature: 'TS-on-text' },
            { functionCall: { name: 'a', args: {} }, thoughtSignature: 'FS' },
        ]
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'visible answer', toolCalls: [{ id: '', name: 'a', arguments: '{}', signature: 'FS' }], providerEcho: rawParts },
                    { role: 'tool', content: 'r', toolCallId: '', name: 'a' },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[1]).toEqual({ role: 'model', parts: rawParts })
    })

    test('URL-encodes modelId', async () => {
        const preset = makePreset({ userValues: { modelId: 'gemini/2.5-pro' } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini%2F2.5-pro:generateContent')
    })

    test('throws invalid-request when modelId is missing', async () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: '',
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
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
        })
        const { fetchImpl } = captureFetch(jsonResponse({}))
        await expect(
            sendGoogleChatRequest(preset, { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('customBody cannot inject systemInstruction when user provided no system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] }, extra: 'kept' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: [{ role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toBeUndefined()
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.systemInstruction cannot override user-provided system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('customBody.model cannot redirect the URL path modelId', async () => {
        const preset = makePreset({
            userValues: { modelId: 'gemini-real' },
            customBody: { model: 'HIJACK', generationConfig: { temperature: 0.5 } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-real:generateContent')
        expect(calls[0].body.model).toBeUndefined()
        expect(calls[0].body.generationConfig).toEqual({ temperature: 0.5 })
    })

    test('non-stream promptFeedback.blockReason throws invalid-request (non-retryable, non-eligible)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                promptFeedback: {
                    blockReason: 'SAFETY',
                    blockReasonMessage: 'Blocked due to safety policy.',
                },
            }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('non-stream promptFeedback.blockReason without message falls back to the reason code', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            message: 'Gemini blocked the prompt: SAFETY',
        })
    })

    test('classifies HTTP 400 with parsed message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse(
                { error: { code: 400, message: 'invalid argument', status: 'INVALID_ARGUMENT' } },
                { status: 400 },
            ),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            status: 400,
            message: 'invalid argument',
        })
    })
})

describe('streamGoogleChatRequest', () => {
    test('yields accumulating textDelta from candidates parts and captures finishReason+usage', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'data: {"candidates":[{"content":{"parts":[{"text":"He"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"llo"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
            ]),
        )
        const deltas: string[] = []
        let finishReason: string | undefined
        let usage: { promptTokens?: number } | undefined
        for await (const delta of streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) finishReason = delta.finishReason
            if (delta.usage) usage = delta.usage
        }
        expect(deltas.join('')).toBe('Hello')
        expect(finishReason).toBe('STOP')
        expect(usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 })
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:streamGenerateContent?alt=sse')
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('routes thought parts to reasoningDelta, never into the visible textDelta', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"answer"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }
        expect(text.join('')).toBe('answer')
        expect(reasoning.join('')).toBe('thinking...')
    })

    test('throws parse error on non-JSON SSE data', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: not json\n\n']))
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })

    test('stream promptFeedback.blockReason throws invalid-request mid-stream', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"Blocked due to safety policy."}}\n\n',
            ]),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('classifies HTTP 429 before streaming starts', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'limited' } }, { status: 429 }),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('normalizes AbortError during stream body read', async () => {
        const abort = new Error('cancel')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
                ))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        const collect = async () => {
            const out: string[] = []
            for await (const delta of gen) {
                if (delta.textDelta) out.push(delta.textDelta)
            }
            return out
        }
        await expect(collect()).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    })
})

describe('bundled google:gemini-35-flash profile integration', () => {
    test('google:gemini-35-flash routes to generateContent under the bundled base URL', async () => {
        const registry = loadBundledRegistry()
        const snapshot = resolveSnapshot(registry, 'google:gemini-35-flash')
        const preset: ModelPreset = {
            id: 'preset-gemini',
            name: 'Gemini',
            profileSnapshot: snapshot,
            userValues: { modelId: 'gemini-3.5-flash' },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    { content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
                ],
            }),
        )
        await sendGoogleChatRequest(preset, { messages: messagesWithSystem, fetchImpl }, { apiKey: 'gk' })
        expect(calls[0].url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
        )
        expect(calls[0].headers['x-goog-api-key']).toBe('gk')
    })
})

describe('vision (Stage 3)', () => {
    test('appends an inlineData part (raw base64 + mimeType) to the user turn', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [{ role: 'user', content: 'look', images: [{ kind: 'image', base64: 'CCCC', mime: 'image/webp' }] }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({
            role: 'user',
            parts: [
                { text: 'look' },
                { inlineData: { mimeType: 'image/webp', data: 'CCCC' } },
            ],
        })
    })

    test('a pure-image user turn (empty text) omits the empty text part', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: '', images: [{ kind: 'image', base64: 'DD', mime: 'image/png' }] }], fetchImpl },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'DD' } }] })
    })

    test('a text-only user turn keeps a single text part (no regression)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'plain' }], fetchImpl },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'plain' }] })
    })
})

describe('error class identity', () => {
    test('thrown error is ModelPresetAdapterError', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({}, { status: 500 }))
        try {
            await sendGoogleChatRequest(
                makePreset(),
                { messages: messagesWithSystem, fetchImpl },
                { apiKey: 'k' },
            )
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
        }
    })
})

describe('context caching wiring', () => {
    beforeEach(() => {
        localStorage.clear()
        resetGeminiContextCacheRuntime()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    function makeCacheContext(): AdapterCacheContext {
        return { promptCaching: { enabled: true }, chatKey: 'chat-1', task: 'model', presetId: 'preset-google' }
    }

    // Routes chat calls to `chatResponse` and answers the cachedContents API
    // (POST create / PATCH extend / DELETE remove) like the real endpoint, with
    // sequential cache names so assertions can pin them down.
    function routedFetch(chatResponse: () => Response): {
        fetchImpl: typeof fetch
        calls: CapturedCall[]
    } {
        const calls: CapturedCall[] = []
        let created = 0
        const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            calls.push({
                url,
                method: (init?.method ?? 'GET') as string,
                headers: (init?.headers as Record<string, string>) ?? {},
                body: init?.body != null ? JSON.parse(init.body as string) : {},
            })
            if (url.includes('/cachedContents')) {
                if (init?.method === 'POST') {
                    created++
                    return jsonResponse({ name: `cachedContents/created-${created}` })
                }
                return jsonResponse({})
            }
            return chatResponse()
        }
        return { fetchImpl, calls }
    }

    function chatJson(promptTokenCount: number): () => Response {
        return () => jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount, candidatesTokenCount: 2, totalTokenCount: promptTokenCount + 2 },
        })
    }

    // system + cachePoint on the first user turn → wire boundary = 1 content.
    const turnOneMessages: AdapterChatMessage[] = [
        { role: 'system', content: 'You are factual.' },
        { role: 'user', content: 'turn 1', cachePoint: true },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'turn 2' },
    ]

    test('first turn sends uncached, then creates the cache for the boundary prefix in the background', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        // The chat request itself is untouched (full contents + systemInstruction).
        expect(calls[0].body.cachedContent).toBeUndefined()
        expect(calls[0].body.contents).toHaveLength(3)
        expect(calls[0].body.systemInstruction).toBeDefined()
        // Fire-and-forget creation lands after the response returned.
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
        expect(calls[1].headers['x-goog-api-key']).toBe('k')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    // Vertex native: same google-gemini adapter, but service-account auth and a
    // publisher-rooted chat URL. The cache layer must derive the location-rooted
    // cachedContents URL and the full "projects/.../models/{id}" resource name
    // from that URL (host is never hardcoded), and reuse the Bearer auth.
    function makeVertexPreset(): ModelPreset {
        // The wire model id resolves from the snapshot schema default
        // ('gemini-demo'), so the publisher URL carries that id.
        return makePreset({
            profileSnapshot: makeSnapshot({
                providerBaseId: 'vertex-gemini-native',
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: {
                    kind: 'static',
                    url: 'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models',
                },
            }),
        })
    }

    test('Vertex: cachedContents URL is location-rooted and the create model is the full resource path', async () => {
        stubServiceAccountToken('ya29.access-token')
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        // Chat call hits the Vertex publisher URL with Bearer auth.
        expect(calls[0].url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global'
            + '/publishers/google/models/gemini-demo:generateContent',
        )
        expect(calls[0].headers['Authorization']).toBe('Bearer ya29.access-token')
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        expect(calls[1].method).toBe('POST')
        // cachedContents is rooted at the location, not the publisher segment.
        expect(calls[1].url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/cachedContents',
        )
        expect(calls[1].headers['Authorization']).toBe('Bearer ya29.access-token')
        expect(calls[1].body).toEqual({
            model: 'projects/my-proj/locations/global/publishers/google/models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    test('Vertex: second turn applies the cache (cachedContent + suffix), Bearer auth reused', async () => {
        stubServiceAccountToken('ya29.access-token')
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        const turnTwoMessages: AdapterChatMessage[] = [
            ...turnOneMessages,
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3' },
        ]
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.systemInstruction).toBeUndefined()
        expect(calls[2].headers['Authorization']).toBe('Bearer ya29.access-token')
    })

    test('second turn applies the cache: cachedContent + suffix only, systemInstruction stripped', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        const turnTwoMessages: AdapterChatMessage[] = [
            ...turnOneMessages,
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.contents).toEqual([
            { role: 'model', parts: [{ text: 'reply 1' }] },
            { role: 'user', parts: [{ text: 'turn 2' }] },
            { role: 'model', parts: [{ text: 'reply 2' }] },
            { role: 'user', parts: [{ text: 'turn 3' }] },
        ])
        expect(calls[2].body.systemInstruction).toBeUndefined()
        // Fresh hit (full TTL remaining, no growth) → no extend/recreate calls.
        await new Promise((r) => setTimeout(r, 20))
        expect(calls).toHaveLength(3)
    })

    test('a prefix edit invalidates: stale cache deleted, request uncached, cache recreated', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        const editedMessages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.' },
            { role: 'user', content: 'turn 1 EDITED', cachePoint: true },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: editedMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        // Recreation is also fire-and-forget: wait for DELETE + chat + POST.
        await vi.waitFor(() => expect(calls).toHaveLength(5))
        const remove = calls.find((c) => c.method === 'DELETE')
        expect(remove?.url).toBe('https://demo.test/v1beta/cachedContents/created-1')
        const chat = calls.find((c, i) => i >= 2 && c.url.includes(':generateContent'))
        expect(chat?.body.cachedContent).toBeUndefined()
        expect(chat?.body.contents).toHaveLength(3)
        const recreate = calls.find((c, i) => i >= 2 && c.method === 'POST' && c.url.endsWith('/cachedContents'))
        expect(recreate?.body.contents).toEqual([{ role: 'user', parts: [{ text: 'turn 1 EDITED' }] }])
    })

    test('a cache covering the whole prompt is never applied (empty-suffix guard)', async () => {
        const messages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.' },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2', cachePoint: true },
        ]
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        // Reroll: identical prompt — the cache boundary equals the contents
        // length, so applying would leave contents empty. Must send uncached.
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[2].body.cachedContent).toBeUndefined()
        expect(calls[2].body.contents).toHaveLength(3)
        await new Promise((r) => setTimeout(r, 20))
        expect(calls).toHaveLength(3)
    })

    test('no cachePoint in the prompt → caching never engages', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await new Promise((r) => setTimeout(r, 20))
        expect(calls).toHaveLength(1)
        expect(calls[0].body.cachedContent).toBeUndefined()
    })

    // A cachePoint carried only by a system message (cache card landing on the
    // system role) used to be dropped when system → systemInstruction, silently
    // disabling caching. It now folds into a boundary-0 (systemInstruction-only)
    // cache: the create POST holds an empty contents prefix + systemInstruction.
    const systemOnlyCachePoint: AdapterChatMessage[] = [
        { role: 'system', content: 'You are factual.', cachePoint: true },
        { role: 'user', content: 'turn 1' },
    ]

    test('a system-only cachePoint caches the systemInstruction (boundary 0)', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: systemOnlyCachePoint, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        // Turn 1 sends uncached (full contents + systemInstruction).
        expect(calls[0].body.cachedContent).toBeUndefined()
        expect(calls[0].body.systemInstruction).toBeDefined()
        // Fire-and-forget creation: cache the systemInstruction only (no contents).
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [],
        })
    })

    test('second turn applies the systemInstruction-only cache: cachedContent + full contents, systemInstruction stripped', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: systemOnlyCachePoint, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        const turnTwo: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.', cachePoint: true },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnTwo, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        // boundary 0 → the cache holds only the systemInstruction; the chat call
        // strips systemInstruction and sends the FULL contents as the suffix.
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.systemInstruction).toBeUndefined()
        expect(calls[2].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'turn 1' }] },
            { role: 'model', parts: [{ text: 'reply 1' }] },
            { role: 'user', parts: [{ text: 'turn 2' }] },
        ])
    })

    test('a chat cachePoint wins over a system cachePoint (deeper boundary)', async () => {
        const messages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.', cachePoint: true },
            { role: 'user', content: 'turn 1', cachePoint: true },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        // The chat cachePoint (boundary 1) is the larger cacheable prefix: the
        // create body holds systemInstruction + the first user turn, not just
        // the systemInstruction.
        expect(calls[1].method).toBe('POST')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    test('stream completion drives cache creation from the last chunk usage', async () => {
        const { fetchImpl, calls } = routedFetch(() => sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10000,"candidatesTokenCount":2,"totalTokenCount":10002}}\n\n',
        ]))
        for await (const _ of streamGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )) { /* drain */ }
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
    })

    test('a cache-API failure never disturbs the chat (creation POST fails, response still resolves)', async () => {
        // Chat call always 200; the cachedContents POST fails. The first turn must
        // resolve normally and the failed create must not surface on the chat path.
        const calls: CapturedCall[] = []
        const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            calls.push({
                url,
                method: (init?.method ?? 'GET') as string,
                headers: (init?.headers as Record<string, string>) ?? {},
                body: init?.body != null ? JSON.parse(init.body as string) : {},
            })
            if (url.includes('/cachedContents')) return jsonResponse({}, { status: 403 })
            return chatJson(10_000)()
        }
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('ok')
        // chat (1) + failed create POST (2). No retry, no extra chat call.
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        await new Promise((r) => setTimeout(r, 20))
        expect(calls).toHaveLength(2)
        const chatCalls = calls.filter((c) => c.url.includes(':generateContent'))
        expect(chatCalls).toHaveLength(1)
    })

    test('an applied cache the server evicted falls back to an uncached chat (no thrown error)', async () => {
        // Turn 1 creates the cache; turn 2 applies it but the server has evicted
        // it → 404 on the cached chat call. The adapter must drop the cache and
        // retry uncached so the turn succeeds.
        let createdName = ''
        const calls: CapturedCall[] = []
        const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            const body = init?.body != null ? JSON.parse(init.body as string) : {}
            calls.push({ url, method: (init?.method ?? 'GET') as string, headers: (init?.headers as Record<string, string>) ?? {}, body })
            if (url.includes('/cachedContents')) {
                if (init?.method === 'POST') {
                    createdName = 'cachedContents/evicted-1'
                    return jsonResponse({ name: createdName })
                }
                return jsonResponse({})
            }
            // A chat call carrying the evicted cachedContent → 404. Uncached → 200.
            if (body.cachedContent) return jsonResponse({ error: { message: 'cache not found' } }, { status: 404 })
            return chatJson(10_000)()
        }
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
        const turnTwoMessages: AdapterChatMessage[] = [
            ...turnOneMessages,
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3' },
        ]
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        // The turn succeeds via the uncached retry rather than throwing the 404.
        expect(result.text).toBe('ok')
        // The cached attempt (404) then an uncached retry (200) both fired.
        const turn2Chats = calls.filter((c, i) => i >= 2 && c.url.includes(':generateContent'))
        expect(turn2Chats).toHaveLength(2)
        expect(turn2Chats[0].body.cachedContent).toBe(createdName)
        expect(turn2Chats[1].body.cachedContent).toBeUndefined()
    })

    test('parses cachedContentTokenCount into usage.cachedTokens', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 7 },
        }))
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 7 })
    })
})
