import { afterEach, describe, expect, test, vi } from 'vitest'
import { loadBundledRegistry, resolveSnapshot } from '../registry'
import type { ModelPreset } from '../types'
import * as cacheModule from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { sendChatRequest } from './openaiCompatible'

const VALID_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function vertexPreset(): ModelPreset {
    const registry = loadBundledRegistry()
    const snapshot = resolveSnapshot(registry, 'vertex-openai:standard')
    return {
        id: 'preset-vertex',
        name: 'Vertex Preset',
        profileSnapshot: snapshot,
        userValues: {
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            modelId: 'google/gemini-2.5-pro',
        },
        createdAt: 1,
        updatedAt: 1,
    }
}

interface CapturedFetch {
    url: string
    init: RequestInit
}

function captureFetch(response: Response): { fetchImpl: typeof fetch; calls: CapturedFetch[] } {
    const calls: CapturedFetch[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
        return response
    }) as typeof fetch
    return { fetchImpl, calls }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('openai-compatible adapter — Vertex google-service-account integration', () => {
    test('exchanges SA JSON for an access token before sending the chat request', async () => {
        const exchangeCalls: ExchangeServiceAccountInput[] = []
        const stubCache = cacheModule.createServiceAccountTokenCache({
            now: () => 1_000_000,
            exchange: async (input) => {
                exchangeCalls.push(input)
                return {
                    accessToken: 'ya29.e2e-token',
                    tokenType: 'Bearer',
                    expiresInSeconds: 3600,
                    issuedAtMs: 1_000_000,
                }
            },
        })
        vi.spyOn(cacheModule, 'getDefaultServiceAccountTokenCache').mockReturnValue(stubCache)

        const chatResponse = new Response(
            JSON.stringify({
                choices: [{ message: { content: 'hello back' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
        const { fetchImpl, calls } = captureFetch(chatResponse)

        const result = await sendChatRequest(
            vertexPreset(),
            {
                messages: [{ role: 'user', content: 'hi' }],
                fetchImpl,
            },
            // Caller supplies the raw SA JSON; the adapter MUST exchange it
            // for an access token before talking to Vertex.
            { apiKey: VALID_SA_JSON },
        )

        expect(result.text).toBe('hello back')

        // Token exchange happened exactly once and was given the parsed SA.
        expect(exchangeCalls).toHaveLength(1)
        expect(exchangeCalls[0].serviceAccount.clientEmail).toBe(
            'svc@demo.iam.gserviceaccount.com',
        )

        // Outbound request: Vertex endpoint URL, bearer is the FRESH token, not
        // the raw SA JSON. This is the regression guard for the wiring gap that
        // would otherwise put the SA private key in the Authorization header.
        expect(calls).toHaveLength(1)
        const headers = calls[0].init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer ya29.e2e-token')
        expect(headers.Authorization).not.toContain('private_key')
        expect(headers.Authorization).not.toContain('BEGIN PRIVATE KEY')
        expect(calls[0].url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )

        // Body carries the model id but no SA-related fields.
        const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
        expect(body.model).toBe('google/gemini-2.5-pro')
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
        expect(body.stream).toBe(false)
    })

    test('does not call the token cache for non-SA auth kinds', async () => {
        const exchange = vi.fn()
        const stubCache = cacheModule.createServiceAccountTokenCache({
            now: () => 1_000_000,
            exchange,
        })
        vi.spyOn(cacheModule, 'getDefaultServiceAccountTokenCache').mockReturnValue(stubCache)

        const chatResponse = new Response(
            JSON.stringify({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
        const { fetchImpl, calls } = captureFetch(chatResponse)

        // openai:gpt-55 uses bearer auth — no SA exchange should happen.
        const registry = loadBundledRegistry()
        const preset: ModelPreset = {
            id: 'preset-bearer',
            name: 'OpenAI',
            profileSnapshot: resolveSnapshot(registry, 'openai:gpt-55'),
            userValues: { modelId: 'gpt-5.5' },
            createdAt: 1,
            updatedAt: 1,
        }

        await sendChatRequest(
            preset,
            { messages: [{ role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'sk-test' },
        )

        expect(exchange).not.toHaveBeenCalled()
        const headers = calls[0].init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer sk-test')
    })
})
