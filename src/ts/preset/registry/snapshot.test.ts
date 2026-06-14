import { describe, expect, test } from 'vitest'
import type { BaseProviderDefinition, ModelProfile, RegistryCache } from '../types'
import { loadBundledRegistry } from './loader'
import { RegistryProfileNotFoundError, resolveSnapshot } from './snapshot'

describe('resolveSnapshot', () => {
    const registry = loadBundledRegistry()

    test('returns the openai:gpt-55 snapshot with merged base schema', () => {
        const snapshot = resolveSnapshot(registry, 'openai:gpt-55')
        expect(snapshot).toMatchObject({
            profileId: 'openai:gpt-55',
            profileVersion: 2,
            providerBaseId: 'openai',
            adapterKind: 'openai-compatible',
            auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://api.openai.com/v1/chat/completions' },
            modelId: 'gpt-5.5',
        })
        expect(snapshot.schema.map((f) => f.key)).toEqual(expect.arrayContaining(['apiKey', 'modelId']))
        expect(snapshot.schema.find((f) => f.key === 'apiKey')).toBeDefined()
        expect(snapshot.schema.find((f) => f.key === 'modelId')).toBeDefined()
        expect(snapshot.headerTemplate).toEqual({ 'Content-Type': 'application/json' })
        expect(snapshot.capabilities).toContain('streaming')
    })

    test('returns the anthropic:sonnet-46 snapshot with anthropic-messages adapter', () => {
        const snapshot = resolveSnapshot(registry, 'anthropic:sonnet-46')
        expect(snapshot.adapterKind).toBe('anthropic-messages')
        expect(snapshot.auth).toEqual({ kind: 'x-api-key', fields: ['apiKey'] })
        expect(snapshot.endpoint.url).toBe('https://api.anthropic.com/v1/messages')
        expect(snapshot.headerTemplate?.['anthropic-version']).toBe('2023-06-01')
    })

    test('returns the google:gemini-35-flash snapshot with x-goog-api-key auth', () => {
        const snapshot = resolveSnapshot(registry, 'google:gemini-35-flash')
        expect(snapshot.adapterKind).toBe('google-gemini')
        expect(snapshot.auth.kind).toBe('x-goog-api-key')
    })

    test('returns the ollama:openai-compatible-local snapshot with none auth', () => {
        const snapshot = resolveSnapshot(registry, 'ollama:openai-compatible-local')
        expect(snapshot.auth.kind).toBe('none')
        expect(snapshot.endpoint.url).toBe('http://localhost:11434/v1/chat/completions')
    })

    test('returns the vertex-openai:standard snapshot with vertex-openai endpoint kind', () => {
        const snapshot = resolveSnapshot(registry, 'vertex-openai:standard')
        expect(snapshot.adapterKind).toBe('openai-compatible')
        expect(snapshot.endpoint.kind).toBe('vertex-openai')
        expect(snapshot.auth.kind).toBe('google-service-account')
        // location default lives on the base-provider schema field, not in body defaults.
        const locationField = snapshot.schema.find((f) => f.key === 'location')
        expect(locationField?.default).toBe('global')
        expect(locationField?.mapsTo).toEqual({ target: 'custom', path: 'location' })
        const projectField = snapshot.schema.find((f) => f.key === 'projectId')
        expect(projectField?.mapsTo).toEqual({ target: 'custom', path: 'project' })
        const saField = snapshot.schema.find((f) => f.key === 'serviceAccountJson')
        expect(saField?.mapsTo).toEqual({ target: 'auth', path: 'apiKey' })
    })

    test('backfills modelId schema field default from profile.modelId when missing', () => {
        const baseProvider: BaseProviderDefinition = {
            id: 'demo',
            version: 1,
            displayName: 'Demo',
            adapterKind: 'openai-compatible',
            authKinds: ['bearer'],
            endpointKinds: ['static'],
            requestSchema: [
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
            limits: {
                known: false,
                contextWindowTokens: 65536,
                sourceUrls: ['https://example.test/base-limits'],
            },
            sourceUrls: ['https://example.test'],
        }
        const profile: ModelProfile = {
            id: 'demo:gpt-5',
            version: 1,
            displayName: 'GPT-5',
            providerBaseId: 'demo',
            profileStatus: 'current',
            modelId: 'gpt-5',
            endpoint: { kind: 'static', url: 'https://demo.test/v1' },
            auth: { kind: 'bearer', fields: ['apiKey'] },
            defaults: {},
            schema: [],
            uiSchema: { groups: [], fields: [] },
            limits: {
                known: true,
                maxOutputTokens: 8192,
                sourceUrls: ['https://example.test/profile-limits'],
            },
            sourceUrls: [],
        }
        const cache: RegistryCache = {
            schemaVersion: 4,
            registries: {
                synthetic: {
                    fetchedAt: 0,
                    baseProviders: { demo: baseProvider },
                    profiles: { 'demo:gpt-5': profile },
                },
            },
        }
        const snapshot = resolveSnapshot(cache, 'demo:gpt-5')
        const modelIdField = snapshot.schema.find((f) => f.key === 'modelId')
        expect(modelIdField?.default).toBe('gpt-5')
        expect(snapshot.limits).toEqual({
            known: true,
            contextWindowTokens: 65536,
            maxOutputTokens: 8192,
            sourceUrls: ['https://example.test/profile-limits'],
        })
    })

    test('does not overwrite explicit modelId default and skips empty profile.modelId', () => {
        const baseProvider: BaseProviderDefinition = {
            id: 'demo',
            version: 1,
            displayName: 'Demo',
            adapterKind: 'openai-compatible',
            authKinds: ['bearer'],
            endpointKinds: ['static'],
            requestSchema: [
                {
                    key: 'modelId',
                    type: 'string',
                    label: 'Model ID',
                    default: 'explicit-default',
                    mapsTo: { target: 'body', path: 'model' },
                },
            ],
            uiSchema: { groups: [], fields: [] },
            sourceUrls: [],
        }
        const profileExplicit: ModelProfile = {
            id: 'demo:a',
            version: 1,
            displayName: 'A',
            providerBaseId: 'demo',
            profileStatus: 'current',
            modelId: 'profile-model',
            endpoint: { kind: 'static', url: 'https://demo.test/v1' },
            auth: { kind: 'bearer', fields: ['apiKey'] },
            defaults: {},
            schema: [],
            uiSchema: { groups: [], fields: [] },
            sourceUrls: [],
        }
        const profileEmptyModel: ModelProfile = {
            ...profileExplicit,
            id: 'demo:custom',
            modelId: '',
        }
        const cache: RegistryCache = {
            schemaVersion: 4,
            registries: {
                synthetic: {
                    fetchedAt: 0,
                    baseProviders: { demo: baseProvider },
                    profiles: {
                        'demo:a': profileExplicit,
                        'demo:custom': profileEmptyModel,
                    },
                },
            },
        }
        const explicitSnap = resolveSnapshot(cache, 'demo:a')
        expect(explicitSnap.schema.find((f) => f.key === 'modelId')?.default)
            .toBe('explicit-default')
        const customSnap = resolveSnapshot(cache, 'demo:custom')
        expect(customSnap.schema.find((f) => f.key === 'modelId')?.default)
            .toBe('explicit-default')
    })

    test('throws RegistryProfileNotFoundError for unknown profile ids', () => {
        expect(() => resolveSnapshot(registry, 'unknown:profile')).toThrowError(RegistryProfileNotFoundError)
    })

    test('covers every analyzer-emitted profile id', () => {
        const analyzerProfileIds = [
            'openai:gpt-55',
            'anthropic:sonnet-46',
            'google:gemini-35-flash',
            'openai-compatible:custom',
            'openai-compatible:custom-noauth',
            'openrouter:openai-compatible',
            'nanogpt:openai-compatible',
            'ollama:openai-compatible-local',
            'deepseek:v4-flash',
            'deepinfra:openai-compatible',
            'vercel:openai-compatible',
        ]
        for (const profileId of analyzerProfileIds) {
            const snapshot = resolveSnapshot(registry, profileId)
            expect(snapshot.profileId).toBe(profileId)
        }
    })

    test('returns the openai-compatible:custom-noauth snapshot with auth.kind=none and hidden apiKey field', () => {
        const snapshot = resolveSnapshot(registry, 'openai-compatible:custom-noauth')
        expect(snapshot.auth).toEqual({ kind: 'none', fields: [] })
        expect(snapshot.adapterKind).toBe('openai-compatible')
        expect(snapshot.endpoint).toEqual({ kind: 'static', url: '' })
        const apiKeyField = snapshot.uiSchema.fields.find((f) => f.key === 'apiKey')
        expect(apiKeyField?.visibility).toBe('hidden')
        // endpointUrl + modelId remain visible for user input
        const visibleKeys = snapshot.uiSchema.fields
            .filter((f) => f.visibility === 'basic')
            .map((f) => f.key)
        expect(visibleKeys).toContain('endpointUrl')
        expect(visibleKeys).toContain('modelId')
    })

    test('merges profile schema/uiSchema on top of base provider fields', () => {
        const baseProvider: BaseProviderDefinition = {
            id: 'demo',
            version: 1,
            displayName: 'Demo',
            adapterKind: 'openai-compatible',
            authKinds: ['bearer'],
            endpointKinds: ['static'],
            defaultHeaders: { 'Content-Type': 'application/json' },
            defaultBody: { base: 'value' },
            requestSchema: [
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
            uiSchema: {
                groups: [{ id: 'credentials', label: 'Credentials', order: 1 }],
                fields: [
                    { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                    { key: 'modelId', widget: 'text', visibility: 'basic', group: 'credentials' },
                ],
            },
            capabilities: ['streaming'],
            sourceUrls: ['https://example.test'],
        }
        const profile: ModelProfile = {
            id: 'demo:override',
            version: 2,
            displayName: 'Demo Override',
            providerBaseId: 'demo',
            profileStatus: 'current',
            modelId: 'demo-fast',
            endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
            auth: { kind: 'bearer', fields: ['apiKey'] },
            defaults: { profile: 'value' },
            schema: [
                {
                    key: 'modelId',
                    type: 'string',
                    label: 'Model ID (override)',
                    description: 'profile-level override',
                    mapsTo: { target: 'body', path: 'model' },
                },
                {
                    key: 'reasoning',
                    type: 'string',
                    label: 'Reasoning',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
            uiSchema: {
                groups: [{ id: 'reasoning', label: 'Reasoning' }],
                fields: [
                    { key: 'reasoning', widget: 'select', visibility: 'advanced', group: 'reasoning' },
                ],
            },
            capabilities: ['streaming', 'reasoning'],
            sourceUrls: ['https://example.test/profile'],
        }
        const cache: RegistryCache = {
            schemaVersion: 4,
            registries: {
                synthetic: {
                    fetchedAt: 0,
                    baseProviders: { demo: baseProvider },
                    profiles: { 'demo:override': profile },
                },
            },
        }

        const snapshot = resolveSnapshot(cache, 'demo:override')

        const modelIdField = snapshot.schema.find((f) => f.key === 'modelId')
        expect(modelIdField?.description).toBe('profile-level override')
        expect(snapshot.schema.map((f) => f.key)).toEqual(['apiKey', 'modelId', 'reasoning'])

        expect(snapshot.uiSchema.groups.map((g) => g.id)).toEqual(['credentials', 'reasoning'])
        expect(snapshot.uiSchema.fields.map((f) => f.key)).toEqual(['apiKey', 'modelId', 'reasoning'])

        expect(snapshot.defaults).toEqual({ base: 'value', profile: 'value' })
        expect(snapshot.headerTemplate).toEqual({ 'Content-Type': 'application/json' })
        expect(snapshot.capabilities).toEqual(['streaming', 'reasoning'])
    })
})
