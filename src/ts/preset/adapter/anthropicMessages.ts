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
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'

// `anthropic` base provider v2+ supplies `max_tokens: 4096` via `defaultBody`,
// so freshly-resolved snapshots already carry the value. But presets persisted
// under an older snapshot (v1, `defaults: {}`) won't pick up the new default
// until they are re-resolved against the registry — and the profile version
// did not change (only the base provider did), so the profile-update detection
// will not flag them. Keep an adapter-side safety net for stale snapshots so
// existing chats keep working. `=== undefined` preserves any explicit 0 or
// negative override.
const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096

type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicWireMessage {
    role: 'user' | 'assistant'
    content: AnthropicContentBlock[]
}

interface AnthropicWireTool {
    name: string
    description?: string
    input_schema: unknown
}

export async function sendAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareAnthropicBody(preset, options, credential, false)
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
        throw new ModelPresetAdapterError('parse', 'Failed to parse Anthropic JSON response', {
            cause: err,
        })
    }

    return parseAnthropicMessage(raw)
}

export async function* streamAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareAnthropicBody(preset, options, credential, true)
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
        throw new ModelPresetAdapterError('parse', 'Anthropic stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.event === 'ping') continue
            if (event.event === 'message_stop') return
            if (event.event === 'error') {
                throw deriveStreamError(event.data)
            }
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Anthropic stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseAnthropicStreamDelta(event.event, raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

// Build the request without sending it (previewBody).
export function previewAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareAnthropicBody(preset, options, credential, false)
}

export function prepareAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    return prepareAnthropicBody(preset, options, credential, stream)
}

async function prepareAnthropicBody(
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
    // Wire invariants overwrite any customBody collisions (plan §4-5):
    //   - messages / system  → adapter owns the prompt structure
    //   - model              → adapter selects the wire model id
    //   - stream             → adapter controls the transport mode
    const modelId = resolveWireModelId(preset, { vendorName: 'Anthropic' })
    const { system, chat } = collectSystemAndChat(options.messages)
    prepared.body.messages = toAnthropicWireMessages(chat)
    if (system.length > 0) {
        prepared.body.system = system
    } else {
        delete prepared.body.system
    }
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = options.tools.map(toAnthropicTool)
    } else {
        // Tools are gated by the request, not customBody / additionalParams:
        // strip the whole tool-control surface when off so the OFF toggle is a
        // hard text-only gate (a lingering tool_choice would 400).
        delete prepared.body.tools
        delete prepared.body.tool_choice
    }
    prepared.body.model = modelId
    if (prepared.body.max_tokens === undefined) {
        prepared.body.max_tokens = ANTHROPIC_FALLBACK_MAX_TOKENS
    }
    prepared.body.stream = stream
    return prepared
}

function toAnthropicTool(tool: AdapterToolDef): AnthropicWireTool {
    return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    chat: AdapterChatMessage[]
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    for (const message of messages) {
        if (message.role === 'system') {
            systems.push(message.content)
        } else {
            // tool / user / assistant are all carried into the wire builder,
            // which groups tool results onto a user turn (Anthropic shape).
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), chat }
}

// Build the Anthropic message array. Consecutive tool-role messages are merged
// into ONE user message carrying multiple `tool_result` blocks (Anthropic
// requires every tool_use to be answered in the immediately following user
// turn). Assistant turns emit thinking blocks first, then text, then tool_use —
// the order Anthropic requires when thinking is enabled.
function toAnthropicWireMessages(chat: AdapterChatMessage[]): AnthropicWireMessage[] {
    const out: AnthropicWireMessage[] = []
    let pendingToolResults: AnthropicContentBlock[] = []

    const flushToolResults = () => {
        if (pendingToolResults.length > 0) {
            out.push({ role: 'user', content: pendingToolResults })
            pendingToolResults = []
        }
    }

    for (const message of chat) {
        if (message.role === 'tool') {
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: message.toolCallId ?? '',
                content: message.content,
            })
            continue
        }
        flushToolResults()
        if (message.role === 'assistant') {
            // Verbatim re-send of the model's own turn (thinking signatures intact)
            // when captured this request; reconstruct for history-restored turns.
            const content = Array.isArray(message.providerEcho)
                ? (message.providerEcho as AnthropicContentBlock[])
                : toAssistantBlocks(message)
            out.push({ role: 'assistant', content })
        } else {
            out.push({ role: 'user', content: toUserBlocks(message) })
        }
    }
    flushToolResults()
    return out
}

// A user turn: the text block (always present, even empty, so a pure-image turn
// still carries the field) followed by one image block per attachment. Anthropic
// wants the raw base64 + media_type split out of the data URL.
function toUserBlocks(message: AdapterChatMessage): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = [{ type: 'text', text: message.content }]
    for (const img of message.images ?? []) {
        blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mime ?? 'image/png', data: img.base64 },
        })
    }
    return blocks
}

function toAssistantBlocks(message: AdapterChatMessage): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = []
    for (const part of message.reasoning ?? []) {
        if (part.redactedData !== undefined) {
            blocks.push({ type: 'redacted_thinking', data: part.redactedData })
        } else if (part.text !== undefined) {
            blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature })
        }
    }
    if (message.content.length > 0) {
        blocks.push({ type: 'text', text: message.content })
    }
    for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolArgs(call.arguments) })
    }
    // Anthropic rejects an assistant message with an empty content array.
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    return blocks
}

function parseToolArgs(args: string): unknown {
    if (!args) return {}
    try {
        return JSON.parse(args)
    } catch {
        return {}
    }
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

function deriveStreamError(data: string): ModelPresetAdapterError {
    let message = 'Anthropic stream error'
    try {
        const parsed = JSON.parse(data) as { error?: { message?: unknown; type?: unknown } }
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message
    } catch {
        // fall through with default message
    }
    return new ModelPresetAdapterError('server', message)
}

export function parseAnthropicMessage(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Anthropic response is not an object')
    }
    const content = raw['content']
    let text = ''
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    if (Array.isArray(content)) {
        for (const block of content) {
            if (!isPlainObject(block)) continue
            const type = block['type']
            if (type === 'text' && typeof block['text'] === 'string') {
                text += block['text'] as string
            } else if (type === 'tool_use' && typeof block['name'] === 'string') {
                toolCalls.push({
                    id: typeof block['id'] === 'string' ? (block['id'] as string) : '',
                    name: block['name'] as string,
                    arguments: JSON.stringify(block['input'] ?? {}),
                })
            } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
                reasoning.push({
                    text: block['thinking'] as string,
                    signature: typeof block['signature'] === 'string' ? (block['signature'] as string) : undefined,
                })
            } else if (type === 'redacted_thinking' && typeof block['data'] === 'string') {
                reasoning.push({ redactedData: block['data'] as string })
            }
        }
    }
    const finishReason = typeof raw['stop_reason'] === 'string'
        ? (raw['stop_reason'] as string)
        : undefined
    return {
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        // Keep the raw content blocks so a tool follow-up resends the assistant
        // turn verbatim (thinking signatures must come back byte-for-byte).
        providerEcho: Array.isArray(content) ? content : undefined,
        finishReason,
        usage: parseAnthropicUsage(raw['usage']),
        raw,
    }
}

function parseAnthropicStreamDelta(eventName: string | undefined, raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    if (eventName === 'content_block_delta') {
        const delta = raw['delta']
        if (isPlainObject(delta) && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            return { textDelta: delta['text'] as string, raw }
        }
        // thinking_delta carries the model's reasoning — keep it separate so it is
        // displayed as <Thoughts>, not concatenated into the visible answer.
        if (isPlainObject(delta) && delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            return { textDelta: '', reasoningDelta: delta['thinking'] as string, raw }
        }
        return null
    }
    if (eventName === 'message_delta') {
        const delta = raw['delta']
        const finishReason = isPlainObject(delta) && typeof delta['stop_reason'] === 'string'
            ? (delta['stop_reason'] as string)
            : undefined
        const usage = parseAnthropicUsage(raw['usage'])
        if (finishReason === undefined && usage === undefined) return null
        return { textDelta: '', finishReason, usage, raw }
    }
    return null
}

function parseAnthropicUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['input_tokens'] === 'number') usage.promptTokens = raw['input_tokens'] as number
    if (typeof raw['output_tokens'] === 'number') usage.completionTokens = raw['output_tokens'] as number
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
    ) {
        return undefined
    }
    if (usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
