import { describe, expect, test } from 'vitest'
import { loadBundledRegistry, resolveSnapshot } from '../registry'
import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { createServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { prepareAdapterRequest, resolveAdapterCredential } from './resolveCredential'
import { resolveWireModelId } from './wireInvariants'

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

function bundledPreset(profileId: string, userValues: Record<string, unknown>): ModelPreset {
    const registry = loadBundledRegistry()
    const snapshot = resolveSnapshot(registry, profileId)
    return {
        id: 'preset-1',
        name: 'Vertex Preset',
        profileSnapshot: snapshot,
        userValues,
        createdAt: 1,
        updatedAt: 1,
    }
}

function vertexPreset(userValues: Record<string, unknown>): ModelPreset {
    return bundledPreset('vertex-openai:standard', userValues)
}

function stubCache(accessToken: string) {
    const calls: ExchangeServiceAccountInput[] = []
    const exchange = async (input: ExchangeServiceAccountInput) => {
        calls.push(input)
        return {
            accessToken,
            tokenType: 'Bearer',
            expiresInSeconds: 3600,
            issuedAtMs: 1_000_000,
        }
    }
    return {
        cache: createServiceAccountTokenCache({ now: () => 1_000_000, exchange }),
        calls,
    }
}

describe('Vertex OpenAI end-to-end (bundled registry)', () => {
    test('resolves SA credential then builds the prepared request with bearer token + endpoint URL', async () => {
        const { cache, calls } = stubCache('ya29.integration')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            modelId: 'google/gemini-2.5-pro',
        })

        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        expect(credential?.apiKey).toBe('ya29.integration')

        const prepared = buildPreparedRequest({ preset, credential })

        expect(prepared.method).toBe('POST')
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.integration')
        expect(prepared.body.model).toBe('google/gemini-2.5-pro')

        // SA parser ran and forwarded the parsed account to the cache.
        expect(calls).toHaveLength(1)
        expect(calls[0].serviceAccount.clientEmail).toBe('svc@demo.iam.gserviceaccount.com')
    })

    test('uses global location host when userValues sets location=global', async () => {
        const { cache } = stubCache('ya29.global')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            location: 'global',
            modelId: 'google/gemini-2.5-pro',
        })
        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        const prepared = buildPreparedRequest({ preset, credential })
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })
})

describe('Vertex Gemini native end-to-end (bundled registry)', () => {
    // Pins a shipped vertex-gemini-native profile (gemini-3-flash) to the resolver
    // contract: mapsTo paths (custom.project / custom.location / serviceAccountJson
    // -> auth.apiKey) and the 'vertex-gemini' endpoint kind must all line up, or
    // the native '.../publishers/google/models' URL would not assemble. Goes
    // through prepareAdapterRequest, so the SA JSON is swapped for an OAuth token
    // BEFORE the URL is built — exercising the credential-threaded project_id
    // recovery for the pooled/inline path (Project ID blank, SA JSON NOT in
    // userValues), the documented normal case. (The legacy :flash profile is now a
    // deprecated 'static' shim, so a current native profile drives this test.)
    test('resolves a bundled native profile to the native base URL with project_id recovered from the credential SA JSON', async () => {
        const { cache, calls } = stubCache('ya29.gemini')
        const preset = bundledPreset('vertex-gemini-native:gemini-3-flash', {})

        const prepared = await prepareAdapterRequest({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })

        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.gemini')
        // The OAuth swap ran (project_id had to come from the raw SA JSON, not
        // the post-swap token credential).
        expect(calls).toHaveLength(1)
    })

    // The modelId combobox added to the base provider drives the Vertex URL path
    // the same way it does for AI Studio. resolveWireModelId is the exact helper
    // googleGemini.ts uses to pick the model that gets appended to the
    // '.../publishers/google/models' base URL; assert it directly so the test
    // needs no OAuth exchange. With no user override, the field default backfilled
    // from the profile's modelId wins; a userValues.modelId redirects it to any
    // (bare) Gemini id WITHOUT touching the adapter.
    test('profile modelId becomes the resolved wire model (gemini-35-flash default)', () => {
        const preset = bundledPreset('vertex-gemini-native:gemini-35-flash', {})
        // Snapshot resolution backfills the base modelId field default from the
        // profile's top-level modelId, so the resolver returns it with no input.
        const field = preset.profileSnapshot.schema.find((f) => f.key === 'modelId')
        expect(field?.default).toBe('gemini-3.5-flash')
        expect(resolveWireModelId(preset, { vendorName: 'Google Gemini' })).toBe('gemini-3.5-flash')
    })

    test('userValues.modelId overrides the profile default wire model', () => {
        const preset = bundledPreset('vertex-gemini-native:gemini-35-flash', {
            modelId: 'gemini-2.5-pro',
        })
        expect(resolveWireModelId(preset, { vendorName: 'Google Gemini' })).toBe('gemini-2.5-pro')
    })

    // Locks the spec contract end-to-end: a user-supplied arbitrary modelId must
    // land in the Vertex URL path 'publishers/google/models/{id}'. The base URL
    // assembles from userValues.projectId (no OAuth swap needed), and the model
    // append mirrors googleGemini.ts:240 (encodeURIComponent(resolveWireModelId)
    // + suffix) — the exact step prepareGeminiBody runs before sending. Asserting
    // the composed path here pins the base-builder + resolver to the wire shape
    // without the SSR/OAuth dependencies an adapter-level send would pull in.
    test('override modelId lands in the publishers/google/models/{id} URL path', () => {
        const preset = bundledPreset('vertex-gemini-native:gemini-35-flash', {
            projectId: 'demo',
            modelId: 'gemini-2.5-pro',
        })
        const base = buildPreparedRequest({ preset, credential: { apiKey: 'ya29.tok' } }).url
        const modelId = resolveWireModelId(preset, { vendorName: 'Google Gemini' })
        const url = `${base}/${encodeURIComponent(modelId)}:generateContent`
        expect(url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-pro:generateContent',
        )
    })

    // sharedRequestType 'priority' maps to the documented Vertex header; the base
    // URL assembles from userValues.projectId so no OAuth swap is needed. Passing
    // the bearer token directly as the credential is safe here because the SA
    // JSON is supplied separately via serviceAccountJson (unused since projectId
    // is explicit).
    test('sharedRequestType priority maps to the Vertex shared-request header', () => {
        const preset = bundledPreset('vertex-gemini-native:gemini-35-flash', {
            projectId: 'demo',
            sharedRequestType: 'priority',
        })
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.tok' },
        })
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models',
        )
        expect(prepared.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('priority')
    })
})
