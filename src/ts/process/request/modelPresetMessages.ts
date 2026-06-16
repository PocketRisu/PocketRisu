import type { AdapterChatMessage, AdapterImagePart } from 'src/ts/preset/adapter'
import type { OpenAIChat } from '../index.svelte'
import type { toolCallData } from '../mcp/mcp'
import type { RPCToolCallContent } from '../mcp/mcplib'

// Restores a persisted tool-call marker into its full record. Injected so this
// module stays free of the mcp → database import graph (and is unit-testable).
export type DecodeToolCall = (text: string) => Promise<toolCallData | undefined>

// Convert the classic OpenAIChat[] history into adapter messages.
//
// This is a 1→N async expansion (capabilities Stage 1): assistant turns that
// persisted their tool use as `<tool_call>` markers (the regime-agnostic format
// from mcp.ts encode/decodeToolCall) are restored into structured
// assistant{toolCalls} + tool{toolCallId} pairs, so both the classic and preset
// paths read the same history without corruption. Multimodal / thought
// restoration is deferred to Stage 3 / Stage 4.
export async function expandAdapterMessages(
    formated: OpenAIChat[],
    decode: DecodeToolCall,
    includeImages = false,
): Promise<AdapterChatMessage[]> {
    const out: AdapterChatMessage[] = []
    for (const m of formated) {
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('<tool_call>')) {
            // Tool-call assistant turns carry no image attachments; expand as-is.
            out.push(...await expandToolCallMessage(m, decode))
            continue
        }
        out.push(toAdapterMessage(m, includeImages))
    }
    return out
}

// Parse the classic `data:<mime>;base64,<payload>` URL into the raw payload +
// mime the adapters need. Falls back to treating the whole string as raw base64
// (mime unknown) for the rare non-data-URL case.
function parseImageData(src: string): AdapterImagePart {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(src)
    if (match) return { kind: 'image', base64: match[2], mime: match[1] }
    return { kind: 'image', base64: src }
}

// Collect image attachments from a message's multimodals (vision). Only images
// are mapped; video/audio/signature multimodals are out of Stage 3 scope and
// left untouched.
function extractImages(m: OpenAIChat): AdapterImagePart[] | undefined {
    if (!m.multimodals || m.multimodals.length === 0) return undefined
    const images: AdapterImagePart[] = []
    for (const mm of m.multimodals) {
        if (mm.type === 'image' && typeof mm.base64 === 'string' && mm.base64.length > 0) {
            images.push(parseImageData(mm.base64))
        }
    }
    return images.length > 0 ? images : undefined
}

// Split an assistant message that embeds `<tool_call>` markers into the
// structured assistant/tool sequence the wire expects. Mirrors the classic
// processToolCalls (openAI/requests.ts) so both regimes round-trip identically.
// A marker that fails to decode is left as literal text (no data invented).
async function expandToolCallMessage(
    m: OpenAIChat,
    decode: DecodeToolCall,
): Promise<AdapterChatMessage[]> {
    const segments = (m.content ?? '').split(/(<tool_call>.*?<\/tool_call>)/gms)
    const out: AdapterChatMessage[] = []
    let pending = ''
    for (const segment of segments) {
        if (/^<tool_call>.*<\/tool_call>$/s.test(segment)) {
            const decoded = await decode(segment)
            if (!decoded) { pending += segment; continue }
            out.push({
                role: 'assistant',
                content: pending,
                toolCalls: [{
                    id: decoded.call.id,
                    name: decoded.call.name,
                    arguments: typeof decoded.call.arg === 'string' ? decoded.call.arg : JSON.stringify(decoded.call.arg),
                }],
            })
            out.push({
                role: 'tool',
                content: toolResponseText(decoded.response),
                toolCallId: decoded.call.id,
                name: decoded.call.name,
            })
            pending = ''
        } else {
            pending += segment
        }
    }
    if (pending.trim().length > 0) {
        out.push({ role: 'assistant', content: pending })
    }
    // A cachePoint on the source message covers everything through it, so the
    // boundary lands after the LAST message it expanded into.
    if (m.cachePoint && out.length > 0) {
        out[out.length - 1].cachePoint = true
    }
    return out
}

export function toolResponseText(response: RPCToolCallContent[]): string {
    const texts: string[] = []
    for (const c of response) {
        if (c.type === 'text') texts.push(c.text)
    }
    return texts.join('\n')
}

export function toAdapterMessage(m: OpenAIChat, includeImages = false): AdapterChatMessage {
    const role: AdapterChatMessage['role'] = m.role === 'function' ? 'tool' : m.role
    const msg: AdapterChatMessage = { role, content: m.content ?? '' }
    if (m.name) msg.name = m.name
    // Preserve the native prompt-cache boundary flag (cache card /
    // automaticCachePoint) so the google-gemini adapter can consume it.
    if (m.cachePoint) msg.cachePoint = true
    // Vision: classic only attaches images to user turns (openAI/requests.ts),
    // so mirror that — assistant/system image parts are dropped.
    if (includeImages && role === 'user') {
        const images = extractImages(m)
        if (images) msg.images = images
    }
    return msg
}
