import { ModelPresetAdapterError } from './error'

/**
 * Canonical `mapsTo.custom.path` identifiers consumed by the vertex-openai
 * endpoint resolver in `buildRequest.ts`. Registry profiles must use these
 * exact values to route project/location through to the URL builder.
 */
export const VERTEX_CUSTOM_PATH_PROJECT = 'project'
export const VERTEX_CUSTOM_PATH_LOCATION = 'location'

export interface VertexEndpointInput {
    project: string
    location: string
}

/**
 * Builds the Vertex AI OpenAI-compatible Chat Completions endpoint URL.
 * See https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai
 *
 * Regional locations use a `{location}-aiplatform.googleapis.com` host;
 * the `global` location uses the unprefixed `aiplatform.googleapis.com` host.
 */
export function buildVertexOpenAIEndpointUrl(input: VertexEndpointInput): string {
    return `${vertexBase(input)}/endpoints/openapi/chat/completions`
}

/**
 * Builds the Vertex AI native Gemini base endpoint URL (up to
 * `.../publishers/google/models`). The google-gemini adapter appends
 * `/{modelId}:generateContent` (or `:streamGenerateContent`) itself, so this
 * builder intentionally stops at the publisher/models segment with no trailing
 * slash — mirroring `buildVertexOpenAIEndpointUrl`'s host/projects/locations
 * rules, differing only in the path tail.
 */
export function buildVertexGeminiEndpointUrl(input: VertexEndpointInput): string {
    return `${vertexBase(input)}/publishers/google/models`
}

/**
 * Shared `https://{host}/v1/projects/{project}/locations/{location}` prefix
 * used by both Vertex endpoint builders. Regional locations use a
 * `{location}-aiplatform.googleapis.com` host; the `global` location uses the
 * unprefixed `aiplatform.googleapis.com` host.
 */
function vertexBase(input: VertexEndpointInput): string {
    const project = sanitize(input.project, 'project')
    const location = sanitize(input.location, 'location')
    const host =
        location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${location}-aiplatform.googleapis.com`
    return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}`
}

/**
 * The schema key that carries the raw Service Account JSON string in a vertex
 * preset's `userValues`. Both vertex base providers map this field to
 * `auth.apiKey`; here we read the same raw value only to recover `project_id`.
 */
export const VERTEX_SERVICE_ACCOUNT_JSON_KEY = 'serviceAccountJson'

/**
 * Resolves the GCP project for a Vertex endpoint URL.
 *
 * Precedence: an explicit, non-empty `project` wins; otherwise the
 * `project_id` field is read out of the Service Account JSON. This only parses
 * the JSON to recover the project string — credential/token exchange stays in
 * `resolveAdapterCredential` and is untouched here. A missing project with an
 * unparseable / project_id-less SA JSON throws a clear invalid-request.
 */
export function resolveVertexProject(
    explicitProject: string | undefined,
    serviceAccountJson: unknown,
): string {
    if (typeof explicitProject === 'string' && explicitProject.trim().length > 0) {
        return explicitProject.trim()
    }
    const extracted = extractProjectIdFromServiceAccount(serviceAccountJson)
    if (extracted !== undefined) return extracted
    throw invalid(
        'Could not determine the Vertex project — check the Service Account JSON (it must contain a "project_id") or set Project ID explicitly',
    )
}

function extractProjectIdFromServiceAccount(serviceAccountJson: unknown): string | undefined {
    if (typeof serviceAccountJson !== 'string' || serviceAccountJson.trim().length === 0) {
        return undefined
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(serviceAccountJson)
    } catch {
        return undefined
    }
    if (parsed === null || typeof parsed !== 'object') return undefined
    const projectId = (parsed as Record<string, unknown>).project_id
    if (typeof projectId === 'string' && projectId.trim().length > 0) {
        return projectId.trim()
    }
    return undefined
}

const ALLOWED = /^[a-z0-9][a-z0-9-]*$/iu

function sanitize(value: string, field: string): string {
    if (typeof value !== 'string') {
        throw invalid(`Vertex ${field} must be a string`)
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        throw invalid(`Vertex ${field} is required`)
    }
    if (!ALLOWED.test(trimmed)) {
        throw invalid(
            `Vertex ${field} '${trimmed}' contains invalid characters (allowed: alphanumerics and '-')`,
        )
    }
    return trimmed
}

function invalid(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('invalid-request', message, {
        retryable: false,
        fallbackEligible: false,
    })
}
