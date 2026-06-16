import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { ModelPresetAdapterError } from './error'

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
        userValues: { modelId: 'demo-fast' },
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

describe('buildPreparedRequest', () => {
    test('builds body from defaults + bodyTemplate + userValues mapsTo + auth header', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false, temperature: 0.5 },
                bodyTemplate: { max_tokens: 1024 },
            }),
            userValues: { modelId: 'demo-faster', temperature: 0.9 },
        })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-test' },
        })
        expect(result.method).toBe('POST')
        expect(result.url).toBe('https://demo.test/v1/chat/completions')
        expect(result.body).toEqual({
            stream: false,
            temperature: 0.5,
            max_tokens: 1024,
            model: 'demo-faster',
        })
        expect(result.headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: 'Bearer sk-test',
        })
    })

    test('falls back to schema default when userValues lacks the key', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning Effort',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: 'low' })
    })

    test('treats an empty-string userValue as unset (combobox cleared to blank)', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning Effort',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: { reasoning: '' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).not.toHaveProperty('reasoning_effort')
    })

    test('skips fields without mapsTo and ignores auth/custom targets at body merge', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    { key: 'helpOnly', type: 'string', label: 'help only' },
                    {
                        key: 'customExt',
                        type: 'string',
                        label: 'Custom',
                        mapsTo: { target: 'custom', path: 'whatever' },
                    },
                ],
            }),
            userValues: { helpOnly: 'visible', customExt: 'ignored' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({})
    })

    test('routes header and query mapsTo targets', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'projectId',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'header', path: 'X-Project-Id' },
                    },
                    {
                        key: 'apiVersion',
                        type: 'string',
                        label: 'API Version',
                        mapsTo: { target: 'query', path: 'api-version' },
                    },
                ],
            }),
            userValues: { projectId: 'proj-123', apiVersion: '2025-05-01' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Project-Id']).toBe('proj-123')
        expect(result.url).toBe('https://demo.test/v1/chat/completions?api-version=2025-05-01')
    })

    test('writes nested body mapsTo paths', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ thinking: { budget_tokens: 1024 } })
    })

    test('customBody and customHeaders override prior merges', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false },
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
            userValues: { modelId: 'demo-fast' },
            customBody: { stream: true, model: 'demo-overridden', extra: 1 },
            customHeaders: { 'X-Custom': '1', 'Content-Type': 'application/x-custom' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ stream: true, model: 'demo-overridden', extra: 1 })
        expect(result.headers).toEqual({
            'Content-Type': 'application/x-custom',
            'X-Custom': '1',
            Authorization: 'Bearer sk',
        })
    })

    test('builds the Vertex OpenAI endpoint URL from custom-mapped project + location', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'serviceAccountJson',
                        type: 'string',
                        label: 'Service Account JSON',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'project',
                        type: 'string',
                        label: 'GCP Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Vertex Location',
                        default: 'us-central1',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'my-proj' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'ya29.token' } })
        expect(result.url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/endpoints/openapi/chat/completions',
        )
        expect(result.headers.Authorization).toBe('Bearer ya29.token')
    })

    test('falls back to schema default for Vertex location when userValues omits it', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'serviceAccountJson',
                        type: 'string',
                        label: 'SA',
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        default: 'global',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'my-proj' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when Vertex project is missing', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        default: 'us-central1',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: {},
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('defaults Vertex location to global when neither userValue nor schema default supplies it', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'p' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when static endpoint has no url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
            }),
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('does not mutate nested objects inside snapshot defaults/bodyTemplate or customBody', () => {
        const defaults = { thinking: { type: 'enabled' as const } }
        const bodyTemplate = { tools: [{ name: 'search' }] }
        const customBody = { extras: { nested: { value: 1 } } }
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults,
                bodyTemplate,
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
            customBody,
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({
            thinking: { type: 'enabled', budget_tokens: 1024 },
            tools: [{ name: 'search' }],
            extras: { nested: { value: 1 } },
        })
        // input objects must remain untouched
        expect(defaults).toEqual({ thinking: { type: 'enabled' } })
        expect(bodyTemplate).toEqual({ tools: [{ name: 'search' }] })
        expect(customBody).toEqual({ extras: { nested: { value: 1 } } })
        // body subtree must be its own reference graph
        expect(result.body.thinking).not.toBe(defaults.thinking)
        expect(result.body.tools).not.toBe(bodyTemplate.tools)
        expect((result.body.extras as Record<string, unknown>).nested)
            .not.toBe(customBody.extras.nested)
    })

    test('falls back to snapshot.modelId when modelId schema field default is backfilled', () => {
        // simulates the post-backfill snapshot resolveSnapshot produces for model-specific profiles
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: 'gpt-5',
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
                        default: 'gpt-5',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ model: 'gpt-5' })
    })

    test('resolves endpoint URL from userValues when schema has custom endpointUrl mapping', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {
                endpointUrl: 'https://my-proxy.example/v1/chat/completions',
                modelId: 'demo-fast',
            },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://my-proxy.example/v1/chat/completions')
        expect(result.body).toEqual({ model: 'demo-fast' })
    })

    test('endpoint override takes precedence over snapshot.endpoint.url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: 'https://override.example/v1' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://override.example/v1')
    })

    test('empty endpoint override throws invalid-request', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: '' },
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('userValues explicit null suppresses schema default fallback', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: { reasoning: null },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: null })
    })

    test('header mapsTo overrides a value baked into headerTemplate', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                headerTemplate: {
                    'Content-Type': 'application/json',
                    'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
                },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'sharedRequestType',
                        type: 'string',
                        label: 'Shared Request Type',
                        mapsTo: { target: 'header', path: 'X-Vertex-AI-LLM-Shared-Request-Type' },
                    },
                ],
            }),
            userValues: { sharedRequestType: 'priority' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('priority')
    })

    test('empty header mapsTo value keeps the headerTemplate default', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                headerTemplate: {
                    'Content-Type': 'application/json',
                    'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
                },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'sharedRequestType',
                        type: 'string',
                        label: 'Shared Request Type',
                        mapsTo: { target: 'header', path: 'X-Vertex-AI-LLM-Shared-Request-Type' },
                    },
                ],
            }),
            userValues: { sharedRequestType: '' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('flex')
    })
})

// Shared schema fields for the two Vertex endpoint kinds: SA JSON (auth +
// project_id source), optional project override, optional location.
function vertexSchema() {
    return [
        {
            key: 'serviceAccountJson',
            type: 'string' as const,
            label: 'Service Account JSON',
            secret: true,
            mapsTo: { target: 'auth' as const, path: 'apiKey' },
        },
        {
            key: 'projectId',
            type: 'string' as const,
            label: 'Project ID',
            mapsTo: { target: 'custom' as const, path: 'project' },
        },
        {
            key: 'location',
            type: 'string' as const,
            label: 'Location',
            default: 'global',
            mapsTo: { target: 'custom' as const, path: 'location' },
        },
        {
            key: 'endpointUrl',
            type: 'string' as const,
            label: 'Endpoint URL (override)',
            mapsTo: { target: 'custom' as const, path: 'endpointUrl' },
        },
    ]
}

const SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'sa-project',
    private_key: 'x',
    client_email: 'svc@sa-project.iam.gserviceaccount.com',
})

describe('buildPreparedRequest — Vertex project/location resolution', () => {
    function vertexPreset(kind: 'vertex-openai' | 'vertex-gemini', userValues: Record<string, unknown>) {
        return makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind },
                schema: vertexSchema(),
            }),
            userValues,
        })
    }

    test('vertex-openai: extracts project_id from SA JSON when projectId is blank', () => {
        const preset = vertexPreset('vertex-openai', { serviceAccountJson: SA_JSON })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('vertex-openai: explicit projectId overrides the SA JSON project_id', () => {
        const preset = vertexPreset('vertex-openai', {
            serviceAccountJson: SA_JSON,
            projectId: 'explicit-proj',
            location: 'us-central1',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/explicit-proj/locations/us-central1/endpoints/openapi/chat/completions',
        )
    })

    test('vertex-gemini: assembles the native base URL from SA JSON project + default location', () => {
        const preset = vertexPreset('vertex-gemini', { serviceAccountJson: SA_JSON })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/publishers/google/models',
        )
    })

    test('vertex-gemini: regional location yields the regional host', () => {
        const preset = vertexPreset('vertex-gemini', {
            serviceAccountJson: SA_JSON,
            projectId: 'p1',
            location: 'us-east5',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1/projects/p1/locations/us-east5/publishers/google/models',
        )
    })

    test('vertex-gemini: blank location falls back to global', () => {
        const preset = vertexPreset('vertex-gemini', {
            serviceAccountJson: SA_JSON,
            projectId: 'p1',
            location: '',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models',
        )
    })

    test('vertex-gemini: endpointUrl override wins over project/location assembly', () => {
        const preset = vertexPreset('vertex-gemini', {
            serviceAccountJson: SA_JSON,
            projectId: 'p1',
            location: 'us-east5',
            endpointUrl: 'https://custom.example/v1/projects/over/locations/global/publishers/google/models',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://custom.example/v1/projects/over/locations/global/publishers/google/models',
        )
    })

    test('vertex-gemini: blank endpointUrl override falls through to assembly (not an error)', () => {
        const preset = vertexPreset('vertex-gemini', {
            serviceAccountJson: SA_JSON,
            projectId: 'p1',
            endpointUrl: '',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models',
        )
    })

    test('vertex-openai: blank endpointUrl override falls through to assembly (not an error)', () => {
        const preset = vertexPreset('vertex-openai', {
            serviceAccountJson: SA_JSON,
            endpointUrl: '',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when neither projectId nor SA JSON project_id is available', () => {
        const preset = vertexPreset('vertex-gemini', { serviceAccountJson: '' })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
                expect(err.message).toMatch(/project/i)
            }
        }
    })

    test('throws invalid-request on malformed SA JSON with no explicit projectId', () => {
        const preset = vertexPreset('vertex-gemini', { serviceAccountJson: '{not valid json' })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('throws invalid-request when SA JSON parses but lacks project_id', () => {
        const preset = vertexPreset('vertex-gemini', {
            serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'x' }),
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('explicit projectId still resolves even when SA JSON is malformed (override path skips parse)', () => {
        const preset = vertexPreset('vertex-openai', {
            serviceAccountJson: '{broken',
            projectId: 'safe-proj',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/safe-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })

    // Pooled / inline credentials: the SA JSON lives in db.apiKeyPool or
    // preset.inlineCredential, so userValues.serviceAccountJson is ABSENT. The
    // raw JSON is threaded in via ctx.serviceAccountJson (prepareAdapterRequest
    // captures it from the credential chain before the OAuth swap). With Project
    // ID blank — the documented normal case — project_id must still resolve from
    // that threaded JSON instead of throwing.
    test('vertex-openai: extracts project_id from threaded credential SA JSON when userValues lacks it (pool/inline path)', () => {
        const preset = vertexPreset('vertex-openai', {})
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('vertex-gemini: extracts project_id from threaded credential SA JSON when userValues lacks it (pool/inline path)', () => {
        const preset = vertexPreset('vertex-gemini', { location: 'us-east5' })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })
        expect(result.url).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1/projects/sa-project/locations/us-east5/publishers/google/models',
        )
    })

    test('explicit projectId in userValues still wins over the threaded credential SA JSON', () => {
        const preset = vertexPreset('vertex-openai', { projectId: 'explicit-proj' })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/explicit-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when neither userValues, projectId, nor threaded SA JSON yields a project', () => {
        const preset = vertexPreset('vertex-gemini', {})
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'ya29.token' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.message).toMatch(/project/i)
            }
        }
    })
})
