import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { ModelPresetAdapterError } from './error'
import {
    getDefaultServiceAccountTokenCache,
    type ServiceAccountTokenCache,
} from './googleServiceAccount/cache'
import { parseServiceAccountJson } from './googleServiceAccount/serviceAccount'
import type { AdapterCredential, AdapterPreparedRequest, AdapterRequestContext } from './types'

export interface ResolveCredentialInput {
    preset: ModelPreset
    credential?: AdapterCredential
    scope?: string
    abortSignal?: AbortSignal
    tokenCache?: ServiceAccountTokenCache
}

/**
 * Resolves a raw adapter credential into one that is ready for the synchronous
 * `applyAuth` step. For most auth kinds this is a no-op pass-through. For
 * `google-service-account` the SA JSON in `credential.apiKey` is exchanged for
 * a fresh access token via the token cache, and the returned credential carries
 * the bearer token in `apiKey`.
 */
export async function resolveAdapterCredential(
    input: ResolveCredentialInput,
): Promise<AdapterCredential | undefined> {
    const authKind = input.preset.profileSnapshot.auth.kind
    if (authKind !== 'google-service-account') {
        return input.credential
    }

    const saJson = input.credential?.apiKey
    if (typeof saJson !== 'string' || saJson.length === 0) {
        throw new ModelPresetAdapterError(
            'auth',
            "Auth kind 'google-service-account' requires the service account JSON in credential.apiKey",
            { retryable: false, fallbackEligible: false },
        )
    }

    const serviceAccount = parseServiceAccountJson(saJson)
    const cache = input.tokenCache ?? getDefaultServiceAccountTokenCache()
    const token = await cache.getAccessToken({
        serviceAccount,
        scope: input.scope,
        abortSignal: input.abortSignal,
    })

    return {
        apiKey: token.accessToken,
        inlineCredential: {
            kind: 'google-service-account',
            tokenType: token.tokenType,
            expiresAtMs: token.expiresAtMs,
            clientEmail: serviceAccount.clientEmail,
        },
    }
}

export interface PrepareAdapterRequestInput extends AdapterRequestContext {
    scope?: string
    tokenCache?: ServiceAccountTokenCache
}

/**
 * Async entrypoint for adapters: resolve the credential (exchanging SA JSON
 * for an access token when needed) and then build the prepared request. This
 * is the only callsite shape that's safe for `google-service-account` profiles
 * — calling `buildPreparedRequest` directly with a raw SA JSON credential
 * would send the SA JSON itself as a bearer token.
 */
export async function prepareAdapterRequest(
    input: PrepareAdapterRequestInput,
): Promise<AdapterPreparedRequest> {
    // Capture the raw SA JSON BEFORE the swap below replaces credential.apiKey
    // with an OAuth token. buildModelPresetCredential already collapses the
    // pool / inline / userValues sources into credential.apiKey, so this is the
    // one place where the SA JSON is available for ALL credential modes — the
    // Vertex endpoint builder needs it to recover project_id when the preset
    // uses a pooled/inline key and leaves Project ID blank (the JSON is then
    // absent from userValues.serviceAccountJson). See vertexEndpoint.ts.
    const serviceAccountJson =
        input.preset.profileSnapshot.auth.kind === 'google-service-account' &&
        typeof input.credential?.apiKey === 'string'
            ? input.credential.apiKey
            : undefined
    const credential = await resolveAdapterCredential({
        preset: input.preset,
        credential: input.credential,
        scope: input.scope,
        abortSignal: input.abortSignal,
        tokenCache: input.tokenCache,
    })
    return buildPreparedRequest({ ...input, credential, serviceAccountJson })
}
