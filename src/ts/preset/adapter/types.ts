import type { GeminiPromptCachingConfig } from '../cache/geminiContextCache'
import type { ModelPreset } from '../types'

export interface AdapterCredential {
    apiKey?: string
    inlineCredential?: unknown
}

export interface AdapterRequestContext {
    preset: ModelPreset
    credential?: AdapterCredential
    abortSignal?: AbortSignal
    stream?: boolean
    // Raw Service Account JSON string as it stood BEFORE `resolveAdapterCredential`
    // swapped it for an OAuth access token. Threaded through by
    // `prepareAdapterRequest` so the Vertex endpoint builder can recover the GCP
    // `project_id` for pooled / inline SA credentials (where the JSON never lands
    // in `userValues.serviceAccountJson`). Only populated for the
    // google-service-account auth kind; ignored by every other endpoint kind.
    serviceAccountJson?: string
}

export interface AdapterPreparedRequest {
    method: 'POST'
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
}

export type AdapterErrorKind =
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'auth'
    | 'rate-limit'
    | 'invalid-request'
    | 'not-found'
    | 'server'
    | 'parse'
    | 'unsupported'
    | 'unknown'

export interface AdapterError {
    kind: AdapterErrorKind
    message: string
    status?: number
    retryable: boolean
    fallbackEligible: boolean
    cause?: unknown
}

export interface AdapterStreamEvent {
    event?: string
    data: string
    id?: string
}

export type AdapterChatRole = 'system' | 'user' | 'assistant' | 'tool'

// A single function/tool invocation requested by the model. `arguments` is the
// raw JSON string the model emitted (matches OpenAI's wire shape and the classic
// `toolCallData.call.arg`), so it round-trips without lossy re-encoding.
export interface AdapterToolCall {
    id: string
    name: string
    arguments: string
    // Opaque continuity token Gemini attaches to a functionCall part
    // (thoughtSignature). Must be echoed back on the follow-up request or
    // thinking-enabled Gemini models reject the tool turn. Other providers leave
    // this undefined.
    signature?: string
}

// A reasoning ("thinking") block emitted by the model. Carried opaquely so the
// follow-up request in a tool loop can echo it back — thinking-enabled models
// require their prior reasoning (with its signature) to continue a tool turn.
// `text` is the human-visible thought; `signature` / `redactedData` are opaque
// provider tokens (Anthropic thinking.signature / redacted_thinking.data,
// Gemini thought part signature).
export interface AdapterReasoningPart {
    text?: string
    signature?: string
    redactedData?: string
}

// Image attachment on a user message (Stage 3 vision). `base64` is the RAW
// base64 payload (no `data:` prefix); `mime` is the media type. Anthropic/Gemini
// require the mime wire-side and it cannot be inferred from raw base64, so the
// message builder parses it out of the classic `data:` URL when present and
// callers default it otherwise.
export interface AdapterImagePart {
    kind: 'image'
    base64: string
    mime?: string
}

export interface AdapterChatMessage {
    role: AdapterChatRole
    content: string
    name?: string
    toolCallId?: string                 // role:'tool' — which call this answers
    toolCalls?: AdapterToolCall[]        // role:'assistant' — calls the model made
    reasoning?: AdapterReasoningPart[]   // role:'assistant' — thinking blocks to echo back
    // role:'assistant' — the provider's raw assistant payload (OpenAI message /
    // Anthropic content blocks / Gemini parts). When present, the adapter resends
    // it VERBATIM instead of reconstructing the turn from the parsed fields.
    // Both OpenRouter (reasoning_details) and Google (thoughtSignature on any
    // part) require the exact bytes back on the in-request follow-up. In-memory
    // only — never persisted (history-restored turns reconstruct from fields).
    providerEcho?: unknown
    images?: AdapterImagePart[]          // role:'user' — image attachments (vision)
    // Native prompt-cache boundary flag, preserved from OpenAIChat.cachePoint
    // (cache prompt card / automaticCachePoint — the same infra Anthropic
    // caching consumes). The google-gemini adapter folds the LAST flagged
    // position into its single explicit-cache boundary.
    cachePoint?: boolean
}

// A tool the model may call. `parameters` is a JSON schema already simplified by
// the caller for the target provider (simplifySchema lives in util.ts, which
// pulls getDatabase + Svelte components — importing it here would create the SSR
// cycle the adapter layer deliberately avoids). Adapters only reshape the
// envelope around it.
export interface AdapterToolDef {
    name: string
    description?: string
    parameters: unknown
}

export interface AdapterUsage {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    // Prompt tokens served from a context cache (Gemini usageMetadata
    // .cachedContentTokenCount). Basis for the hit/savings display.
    cachedTokens?: number
}

export interface AdapterChatResponse {
    text: string
    toolCalls?: AdapterToolCall[]        // calls the model requested this turn
    reasoning?: AdapterReasoningPart[]   // thinking blocks emitted this turn (echo + display)
    providerEcho?: unknown               // raw assistant payload for verbatim re-send (see AdapterChatMessage)
    finishReason?: string
    usage?: AdapterUsage
    raw: unknown
}

export interface AdapterChatStreamDelta {
    textDelta: string
    // Reasoning (thinking) text for this chunk, kept SEPARATE from textDelta so it
    // can be wrapped in <Thoughts> for display instead of leaking into the answer.
    reasoningDelta?: string
    finishReason?: string
    usage?: AdapterUsage
    raw: unknown
}

// Context for Gemini explicit context caching. Supplied by request.ts only when
// the request is cache-eligible (main chat, google-gemini adapter, AI Studio key
// auth, caching enabled, no tools); adapters other than googleGemini ignore it.
// Carries everything the cache layer needs so the adapter never reads the
// database (SSR rule). See .agent/notes/gemini-cache-keeper-internalization.md.
export interface AdapterCacheContext {
    promptCaching: GeminiPromptCachingConfig
    chatKey: string      // chat.id — cache state key component
    task: string         // request mode ('model' in v1)
    presetId: string
    // The request's generationId, so the cache layer can key a future
    // hit/savings badge to this exact request (request-status channel).
    generationId?: string
}

export interface AdapterChatOptions {
    messages: AdapterChatMessage[]
    tools?: AdapterToolDef[]             // when present, enables tool use on the request
    abortSignal?: AbortSignal
    fetchImpl?: typeof fetch
    // Per-request identifier (= the message generationId issued in sendChat).
    // Threaded through so request-status / context-cache consumers can key
    // status and badges to this exact request. Optional and side-effect free:
    // adapters that ignore it behave identically. See
    // .agent/notes/generation-state-keying.md.
    generationId?: string
    // Gemini context caching (see AdapterCacheContext). Absent => caching off,
    // the request is byte-identical to before.
    cache?: AdapterCacheContext
}
