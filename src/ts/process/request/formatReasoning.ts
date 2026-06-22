import type { AdapterReasoningPart } from 'src/ts/preset/adapter'

// Render reasoning for DISPLAY, wrapped in the tags the chat renderer already parses.
export function formatPresetReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning || reasoning.length === 0) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    if (body.trim().length === 0) return ''
    return `<Thoughts>\n${body}\n</Thoughts>\n\n`
}
