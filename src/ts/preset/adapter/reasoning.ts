import type { AdapterReasoningPart } from './types'

// Render a turn's reasoning for DISPLAY, wrapped in the <Thoughts> tags the chat
// renderer already parses (mirrors the classic anthropic path). Returns '' when
// there is nothing to show, so non-reasoning models are byte-identical to before.
// redacted_thinking has no visible text — surface the same placeholder as classic.
//
// Pure leaf module: shared by the live path (request.ts) and boot-time job
// recovery (jobRecovery.ts) so recovered text stays byte-identical to what a
// live run saves.
export function formatReasoningParts(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning || reasoning.length === 0) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    if (body.trim().length === 0) return ''
    return `<Thoughts>\n${body}\n</Thoughts>\n\n`
}
