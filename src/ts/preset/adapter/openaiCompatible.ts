import type { ModelPreset } from '../types'
import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import { prepareAdapterRequest } from './resolveCredential'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterImagePart,
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'

interface WireToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
    // OpenRouter passes Gemini's thought signature through this OpenAI-compatible
    // extension. It must round-trip or thinking-enabled Gemini (via OpenRouter)
    // rejects the follow-up tool turn.
    extra_content?: { google?: { thought_signature?: string } }
}

// Content is a plain string for text turns, or the OpenAI multimodal content-part
// array `[{type:'text'...}, {type:'image_url'...}]` when a user turn carries images.
type WireContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }

interface WireMessage {
    role: AdapterChatMessage['role']
    content: string | WireContentPart[]
    name?: string
    tool_call_id?: string
    tool_calls?: WireToolCall[]
}

export async function sendChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareOpenAiBody(preset, options, credential, false)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    let raw: unknown
    try {
        raw = await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', 'Failed to parse OpenAI-compatible JSON response', {
            cause: err,
        })
    }

    return parseChatCompletion(raw)
}

export async function* streamChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareOpenAiBody(preset, options, credential, true)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: { ...prepared.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    if (!response.body) {
        throw new ModelPresetAdapterError('parse', 'OpenAI-compatible stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.data === '[DONE]') return
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse OpenAI-compatible stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseChatStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        // Intentional domain errors (parse, etc.) pass through;
        // fetch/abort/network failures during stream body read get normalized.
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

// Build the request without sending it (previewBody). Must never hit the network
// or the tool loop.
export function previewChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareOpenAiBody(preset, options, credential, false)
}

async function prepareOpenAiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({
        preset,
        credential,
        abortSignal: options.abortSignal,
    })
    // messages, model, and stream are wire invariants per plan §4-5 and must
    // not be overridden by customBody. Resolve modelId from the preset's user
    // values / schema (not the customBody-merged body), then overwrite the
    // body fields after the shared merge so customBody collisions lose.
    const modelId = resolveWireModelId(preset, { vendorName: 'OpenAI-compatible' })
    prepared.body.messages = options.messages.map(toWireMessage)
    prepared.body.model = modelId
    prepared.body.stream = stream
    // Streaming responses carry no usage unless it is requested. Only set when
    // the user opted in: a strict OpenAI-compatible server can 400 on an
    // unknown field, and that would break the generation, not just the stats.
    // Left untouched when off, so a customBody-provided value still applies.
    if (stream && options.collectStreamUsage) {
        prepared.body.stream_options = { include_usage: true }
    }
    // `tools` is a wire invariant when the caller supplies them: the request
    // builder must own tool declaration so customBody cannot smuggle a
    // conflicting list. When absent, leave any profile-declared tools untouched.
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = options.tools.map(toWireToolDef)
    } else {
        // Tools are gated by the request, not customBody. With no tools on the
        // request (toggle off), strip any customBody-provided tools so the OFF
        // state is a hard gate — otherwise the model could emit tool calls the
        // inactive text path would silently drop.
        delete prepared.body.tools
    }
    // Tool-coupled fields are rejected by OpenAI-compatible APIs when no tools
    // are present ("parallel_tool_calls is only allowed when tools are
    // specified"). Profiles may default these (e.g. gpt-5.5 ships
    // parallel_tool_calls: true), so strip them on tool-less (text) requests.
    const hasTools = Array.isArray(prepared.body.tools) && prepared.body.tools.length > 0
    if (!hasTools) {
        delete prepared.body.parallel_tool_calls
        delete prepared.body.tool_choice
    }
    return prepared
}

function toWireToolDef(tool: AdapterToolDef): Record<string, unknown> {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }
}

function toWireMessage(message: AdapterChatMessage): WireMessage {
    // Verbatim re-send of the model's own assistant turn (reasoning_details,
    // tool_calls, etc.) when we captured it this request. Reconstruction below is
    // the fallback for history-restored turns (no providerEcho).
    if (message.role === 'assistant' && isPlainObject(message.providerEcho)) {
        return message.providerEcho as unknown as WireMessage
    }
    const wire: WireMessage = {
        role: message.role,
        // A user turn with images becomes a content-part array; otherwise the
        // plain string (unchanged from text-only behavior).
        content: message.role === 'user' && message.images && message.images.length > 0
            ? toContentParts(message.content, message.images)
            : message.content,
    }
    if (message.name !== undefined) wire.name = message.name
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    if (message.toolCalls && message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => {
            const wireCall: WireToolCall = {
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
            }
            if (call.signature) {
                wireCall.extra_content = { google: { thought_signature: call.signature } }
            }
            return wireCall
        })
    }
    return wire
}

// Build the OpenAI multimodal content array: the text part (when non-empty)
// followed by one image_url part per image. The image_url URL is the `data:` URL
// reconstructed from the raw base64 + mime (OpenAI accepts data URLs directly).
function toContentParts(text: string, images: AdapterImagePart[]): WireContentPart[] {
    const parts: WireContentPart[] = []
    if (text.length > 0) parts.push({ type: 'text', text })
    for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: toDataUrl(img) } })
    }
    return parts
}

function toDataUrl(img: AdapterImagePart): string {
    return `data:${img.mime ?? 'image/png'};base64,${img.base64}`
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // ignore body read failures; status alone is enough to classify
    }
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    return normalizeHttpStatus(response.status, message)
        ?? new ModelPresetAdapterError('unknown', message, { status: response.status })
}

// Exported (pure) for job-journal recovery replay (process/request/jobRecovery.ts).
export function parseChatCompletion(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'OpenAI-compatible response is not an object')
    }
    const choices = raw['choices']
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            'OpenAI-compatible response has no choices',
        )
    }
    const first = choices[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First choice is not an object')
    }
    const message = first['message']
    const text = isPlainObject(message) && typeof message['content'] === 'string'
        ? (message['content'] as string)
        : ''
    const toolCalls = isPlainObject(message) ? parseToolCalls(message['tool_calls']) : undefined
    const reasoning = isPlainObject(message) ? parseReasoning(message) : undefined
    const finishReason = typeof first['finish_reason'] === 'string'
        ? (first['finish_reason'] as string)
        : undefined
    return {
        text,
        toolCalls,
        reasoning,
        // Keep the raw assistant message so a tool follow-up resends it verbatim
        // (preserves reasoning_details / any provider extension OpenRouter requires).
        providerEcho: isPlainObject(message) ? message : undefined,
        finishReason,
        usage: parseUsage(raw['usage']),
        raw,
    }
}

// Surface the model's reasoning text for display only. OpenRouter exposes it as
// `reasoning`, some OpenAI-compatible servers (DeepSeek etc.) as
// `reasoning_content`. The opaque signature payload needed to ECHO reasoning back
// on a tool follow-up rides in providerEcho (reasoning_details), so this string
// is purely for the <Thoughts> display and need not round-trip.
function parseReasoning(message: Record<string, unknown>): AdapterReasoningPart[] | undefined {
    const raw = typeof message['reasoning'] === 'string'
        ? (message['reasoning'] as string)
        : typeof message['reasoning_content'] === 'string'
            ? (message['reasoning_content'] as string)
            : ''
    return raw.length > 0 ? [{ text: raw }] : undefined
}

function parseToolCalls(raw: unknown): AdapterToolCall[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const calls: AdapterToolCall[] = []
    for (const entry of raw) {
        if (!isPlainObject(entry)) continue
        const fn = entry['function']
        if (!isPlainObject(fn) || typeof fn['name'] !== 'string') continue
        const args = typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : ''
        const id = typeof entry['id'] === 'string' ? (entry['id'] as string) : ''
        const signature = extractThoughtSignature(entry['extra_content'])
        calls.push({ id, name: fn['name'] as string, arguments: args, signature })
    }
    return calls.length > 0 ? calls : undefined
}

// OpenRouter relays Gemini's thoughtSignature here. Returns undefined for the
// common (non-Gemini-via-OpenRouter) case.
function extractThoughtSignature(extraContent: unknown): string | undefined {
    if (!isPlainObject(extraContent)) return undefined
    const google = extraContent['google']
    if (!isPlainObject(google)) return undefined
    const sig = google['thought_signature']
    return typeof sig === 'string' ? sig : undefined
}

// Exported (pure) for job-journal recovery replay (process/request/jobRecovery.ts).
export function parseChatStreamDelta(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    const choices = raw['choices']
    let textDelta = ''
    let reasoningDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(choices) && choices.length > 0 && isPlainObject(choices[0])) {
        const first = choices[0] as Record<string, unknown>
        const delta = first['delta']
        if (isPlainObject(delta)) {
            if (typeof delta['content'] === 'string') {
                textDelta = delta['content'] as string
            }
            // OpenRouter streams reasoning as `reasoning`, DeepSeek-style servers as
            // `reasoning_content`. Keep it separate from the visible answer.
            if (typeof delta['reasoning'] === 'string') {
                reasoningDelta = delta['reasoning'] as string
            } else if (typeof delta['reasoning_content'] === 'string') {
                reasoningDelta = delta['reasoning_content'] as string
            }
        }
        if (typeof first['finish_reason'] === 'string') {
            finishReason = first['finish_reason'] as string
        }
    }
    const usage = parseUsage(raw['usage'])
    if (textDelta.length === 0 && reasoningDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, reasoningDelta: reasoningDelta.length > 0 ? reasoningDelta : undefined, finishReason, usage, raw }
}

function parseUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['prompt_tokens'] === 'number') usage.promptTokens = raw['prompt_tokens'] as number
    if (typeof raw['completion_tokens'] === 'number') {
        usage.completionTokens = raw['completion_tokens'] as number
    }
    if (typeof raw['total_tokens'] === 'number') usage.totalTokens = raw['total_tokens'] as number
    // Cached prompt tokens and reasoning tokens are reported in detail objects
    // and are already counted inside prompt_tokens / completion_tokens.
    const promptDetails = raw['prompt_tokens_details']
    if (isPlainObject(promptDetails) && typeof promptDetails['cached_tokens'] === 'number') {
        usage.cachedTokens = promptDetails['cached_tokens'] as number
    }
    const completionDetails = raw['completion_tokens_details']
    if (isPlainObject(completionDetails) && typeof completionDetails['reasoning_tokens'] === 'number') {
        usage.reasoningTokens = completionDetails['reasoning_tokens'] as number
    }
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
        && usage.totalTokens === undefined
    ) {
        return undefined
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
