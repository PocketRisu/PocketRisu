import type { ResolvedModelProfileSnapshot } from '../types'
import { appendQuery, applyAuth } from './auth'
import { ModelPresetAdapterError } from './error'
import type { AdapterPreparedRequest, AdapterRequestContext } from './types'
import {
    buildVertexGeminiEndpointUrl,
    buildVertexOpenAIEndpointUrl,
    resolveVertexProject,
    VERTEX_CUSTOM_PATH_LOCATION,
    VERTEX_CUSTOM_PATH_PROJECT,
    VERTEX_SERVICE_ACCOUNT_JSON_KEY,
    type VertexEndpointInput,
} from './vertexEndpoint'

export function buildPreparedRequest(ctx: AdapterRequestContext): AdapterPreparedRequest {
    const snapshot = ctx.preset.profileSnapshot
    const baseUrl = resolveEndpointUrl(snapshot, ctx.preset.userValues, ctx.serviceAccountJson)

    const body: Record<string, unknown> = structuredClone({
        ...(snapshot.defaults ?? {}),
        ...(snapshot.bodyTemplate ?? {}),
    })
    const headers: Record<string, string> = { ...(snapshot.headerTemplate ?? {}) }
    const queryAdditions: Array<[string, string]> = []

    const userValues = ctx.preset.userValues
    for (const field of snapshot.schema) {
        if (!field.mapsTo) continue
        const effective = pickEffective(userValues, field.key, field.default)
        // Treat an empty string as "unset": a combobox/text field cleared back
        // to blank leaves '' in userValues, and sending e.g. reasoning_effort:''
        // is rejected by providers (no enum match). Skip it like undefined.
        if (effective === undefined || effective === '') continue
        switch (field.mapsTo.target) {
            case 'body':
                setNested(body, field.mapsTo.path, effective)
                break
            case 'header':
                headers[field.mapsTo.path] = String(effective)
                break
            case 'query':
                queryAdditions.push([field.mapsTo.path, String(effective)])
                break
            case 'auth':
            case 'custom':
                // 'auth' values flow through applyAuth via credential; 'custom' is adapter-specific.
                break
        }
    }

    if (ctx.preset.customBody) {
        Object.assign(body, structuredClone(ctx.preset.customBody))
    }
    if (ctx.preset.customHeaders) {
        Object.assign(headers, ctx.preset.customHeaders)
    }
    // Freeform "additional parameters" textarea (legacy customModels syntax).
    // Routes `header::` prefix to headers, everything else to body. Sits
    // AFTER customBody so user-typed overrides have the final say, but
    // BEFORE applyAuth so auth headers cannot be hijacked.
    const additionalText = ctx.preset.additionalParamsText
    if (typeof additionalText === 'string' && additionalText.trim().length > 0) {
        applyAdditionalParamsText(body, headers, additionalText)
    }

    let url = baseUrl
    for (const [k, v] of queryAdditions) {
        url = appendQuery(url, k, v)
    }

    const prepared: AdapterPreparedRequest = {
        method: 'POST',
        url,
        headers,
        body,
    }
    return applyAuth(prepared, snapshot.auth, ctx.credential)
}

function resolveEndpointUrl(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    serviceAccountJson?: string,
): string {
    // Endpoint override primitive: a schema field with
    // `mapsTo: { target: 'custom', path: 'endpointUrl' }` lets users plug in
    // a base URL on profiles that ship with an empty endpoint.url
    // (e.g. openai-compatible:custom). Migration analyzer writes this value
    // into `userValues.endpointUrl` for custom OpenAI-compatible providers.
    // Vertex kinds assemble their URL from project/location, so an absent or
    // blank `endpointUrl` field there means "no override → assemble", not an
    // error. For other kinds (e.g. openai-compatible:custom whose only URL
    // source IS this field) a present-but-empty override stays a hard error.
    const overrideOptional =
        snapshot.endpoint.kind === 'vertex-openai' || snapshot.endpoint.kind === 'vertex-gemini'
    const override = pickEndpointOverride(snapshot, userValues)
    if (override !== undefined && !(overrideOptional && override.trim().length === 0)) {
        if (override.length === 0) {
            throw new ModelPresetAdapterError(
                'invalid-request',
                'Endpoint URL override is empty',
                { retryable: false },
            )
        }
        return override
    }
    if (snapshot.endpoint.kind === 'static') {
        if (!snapshot.endpoint.url) {
            throw new ModelPresetAdapterError(
                'invalid-request',
                'Endpoint URL is missing in profile snapshot',
                { retryable: false },
            )
        }
        return snapshot.endpoint.url
    }
    if (snapshot.endpoint.kind === 'vertex-openai') {
        return buildVertexOpenAIEndpointUrl(
            resolveVertexEndpointInput(snapshot, userValues, serviceAccountJson),
        )
    }
    if (snapshot.endpoint.kind === 'vertex-gemini') {
        return buildVertexGeminiEndpointUrl(
            resolveVertexEndpointInput(snapshot, userValues, serviceAccountJson),
        )
    }
    throw new ModelPresetAdapterError(
        'unsupported',
        `Endpoint kind '${snapshot.endpoint.kind}' is not supported by the shared request builder yet`,
        { retryable: false },
    )
}

// Resolve the { project, location } pair for either Vertex endpoint kind.
// project: explicit custom.project wins; when blank it is recovered from the
// Service Account JSON's `project_id` (resolveVertexProject throws a clear
// invalid-request if neither is available). location: custom.location, or
// 'global' when the schema default is absent / the field was cleared to blank.
//
// SA JSON source: the direct-mode userValues field is preferred, falling back to
// `credentialServiceAccountJson` (threaded from the credential chain by
// prepareAdapterRequest). The fallback is what covers pooled / inline SA keys,
// where the JSON is stored in db.apiKeyPool / preset.inlineCredential and never
// written to userValues.serviceAccountJson. Both sources carry the same
// project_id, so preferring userValues keeps the direct-mode path unchanged.
function resolveVertexEndpointInput(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    credentialServiceAccountJson?: string,
): VertexEndpointInput {
    const explicitProject = pickCustomString(snapshot, userValues, VERTEX_CUSTOM_PATH_PROJECT)
    const rawLocation = pickCustomString(snapshot, userValues, VERTEX_CUSTOM_PATH_LOCATION)
    const location =
        typeof rawLocation === 'string' && rawLocation.trim().length > 0 ? rawLocation : 'global'
    const userValuesSaJson = userValues[VERTEX_SERVICE_ACCOUNT_JSON_KEY]
    const serviceAccountJson =
        typeof userValuesSaJson === 'string' && userValuesSaJson.trim().length > 0
            ? userValuesSaJson
            : credentialServiceAccountJson
    const project = resolveVertexProject(explicitProject, serviceAccountJson)
    return { project, location }
}

function pickEndpointOverride(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
): string | undefined {
    return pickCustomString(snapshot, userValues, 'endpointUrl')
}

function pickCustomString(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    path: string,
): string | undefined {
    for (const field of snapshot.schema) {
        if (field.mapsTo?.target !== 'custom') continue
        if (field.mapsTo.path !== path) continue
        const value = pickEffective(userValues, field.key, field.default)
        if (typeof value === 'string') return value
    }
    return undefined
}

function pickEffective(
    userValues: Record<string, unknown>,
    key: string,
    fallback: unknown,
): unknown {
    if (Object.prototype.hasOwnProperty.call(userValues, key)) {
        const value = userValues[key]
        if (value !== undefined) return value
    }
    return fallback
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
    if (path.length === 0) return
    const parts = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        const next = cur[part]
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            cur[part] = {}
        }
        cur = cur[part] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
}

// Apply the freeform textarea (one entry per line) to body+headers.
// Mirrors the legacy customModels params syntax (see process/request/shared.ts
// applyAdditionalParameters) so existing users' muscle memory carries over:
//   key=value           — body[key] = auto-typed value
//   key.path=value      — body[key][path] = value (dot-notation supported)
//   key=json::{...}     — body[key] = JSON.parse(...)
//   header::Name=value  — headers[Name] = value
//   key={{none}}        — delete body[key] (or headers if header:: prefix)
// Implemented inline (not via shared.ts import) to avoid pulling
// getDatabase into the adapter, which causes a Vite SSR cycle.
function applyAdditionalParamsText(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    text: string,
): void {
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const eqIdx = line.indexOf('=')
        if (eqIdx <= 0) continue
        const key = line.slice(0, eqIdx).trim()
        const value = line.slice(eqIdx + 1)
        if (key.length === 0) continue

        if (value === '{{none}}') {
            if (key.startsWith('header::')) delete headers[key.slice(8)]
            else delete body[key]
            continue
        }
        if (key.startsWith('header::')) {
            headers[key.slice(8)] = value
            continue
        }
        if (value.startsWith('json::')) {
            try {
                setNested(body, key, JSON.parse(value.slice(6)))
            } catch {}
            continue
        }
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            setNested(body, key, value.slice(1, -1))
            continue
        }
        if (value === 'true' || value === 'false') {
            setNested(body, key, value === 'true')
            continue
        }
        if (value === 'null') {
            setNested(body, key, null)
            continue
        }
        const num = Number(value)
        setNested(body, key, Number.isNaN(num) ? value : num)
    }
}
