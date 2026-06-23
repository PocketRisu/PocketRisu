import type {
    AdapterChatMessage,
    AdapterChatResponse,
    AdapterReasoningPart,
    AdapterToolCall,
} from './types'

// Outcome of executing one tool call. `text` is what the model sees as the tool
// result; `encoded` is the optional persisted `<tool_call>` marker that lets the
// turn round-trip on the next request (set only when rememberToolUsage is on and
// the call produced a response). The loop stays agnostic to how either is
// produced — the caller injects executeTool.
export interface ToolStepResult {
    text: string
    encoded?: string
}

export interface ToolLoopDeps {
    // Send the current conversation and return the model's structured response.
    // Tools are bound by the caller's closure (fixed across the loop).
    send: (messages: AdapterChatMessage[]) => Promise<AdapterChatResponse>
    // Execute a single tool call requested by the model.
    executeTool: (call: AdapterToolCall) => Promise<ToolStepResult>
    // Max execution rounds before stopping with a marker. Separate from any
    // network retry budget so a failed follow-up never re-runs executed tools.
    maxSteps: number
    // Optional: render a turn's reasoning for DISPLAY, prepended to that turn's
    // text segment. Injected (not hardcoded) so the loop stays free of Risu's
    // <Thoughts> convention. Returns '' to show nothing.
    formatReasoning?: (reasoning?: AdapterReasoningPart[]) => string
    // Optional: when the user cancels mid-loop, stop launching further tools.
    // Checked before EACH tool call so a parallel batch doesn't keep firing
    // write-side tools after an abort. (send() already honors abort via fetch.)
    abortSignal?: AbortSignal
}

export class ToolLoopAbortError extends Error {
    constructor(message = 'Tool loop aborted') {
        super(message)
        this.name = 'ToolLoopAbortError'
    }
}

// Drives the tool-use loop: send → if the model requested tools, execute them and
// append assistant{toolCalls} + tool{result} turns, then re-request, until the
// model stops calling tools or the step cap is hit. The returned string
// interleaves model text with persisted markers in turn order, matching the
// classic recursive path (openAI/requests.ts).
export async function runToolLoop(
    initial: AdapterChatMessage[],
    deps: ToolLoopDeps,
): Promise<string> {
    const convo = initial.slice()
    // Segments (model text + persisted markers) joined with blank lines, matching
    // the classic path's newline combining (openAI/requests.ts) rather than
    // bare concatenation.
    const parts: string[] = []
    let executedAny = false
    for (let step = 0; ; step++) {
        let response: AdapterChatResponse
        try {
            response = await deps.send(convo)
        } catch (err) {
            // A failure AFTER tools already ran must not bubble to the outer
            // retry loop (requestChatData) — that replays the prompt from scratch
            // and re-executes already-run, possibly write-side, tools. Return
            // what we have as a completed result so no re-run happens. A failure
            // on the first send (nothing executed yet) is safe to surface for
            // normal retry/fallback.
            if (!executedAny) throw err
            parts.push(err instanceof ToolLoopAbortError
                ? '[ModelPreset: aborted before completing tool calls]'
                : '[ModelPreset: follow-up request failed after tool execution]')
            return joinParts(parts)
        }
        // Prepend this turn's reasoning (for display) to its text segment, matching
        // the classic path where <Thoughts> precede the visible reply.
        const head = deps.formatReasoning?.(response.reasoning) ?? ''
        const segment = head + (response.text ?? '')
        if (segment.length > 0) parts.push(segment)
        const calls = response.toolCalls ?? []
        if (calls.length === 0) break
        if (step >= deps.maxSteps) {
            parts.push(`[ModelPreset: maximum tool steps (${deps.maxSteps}) reached]`)
            break
        }
        // Wire ordering requires the assistant tool_calls turn to precede its
        // tool results. Echo reasoning blocks too — thinking models reject a
        // tool continuation that drops their prior thoughts/signature.
        convo.push({ role: 'assistant', content: response.text, toolCalls: calls, reasoning: response.reasoning, providerEcho: response.providerEcho })
        for (const call of calls) {
            // Stop launching tools once the user cancels — otherwise the rest of a
            // parallel batch keeps firing (possibly write-side) after the abort.
            // If any tool already ran, return partial so the outer retry loop
            // (guarded by toolExecuted) won't replay the prompt and re-run them.
            if (deps.abortSignal?.aborted) {
                parts.push('[ModelPreset: aborted before completing tool calls]')
                return joinParts(parts)
            }
            // Mark BEFORE executing: executeTool causes side effects (the actual
            // tool runs inside it). Any failure from here on — including the
            // persistence write — must not bubble to the outer retry loop, or it
            // would replay the prompt and re-run already-executed tools.
            executedAny = true
            let result: ToolStepResult
            try {
                result = await deps.executeTool(call)
            } catch {
                parts.push('[ModelPreset: tool execution failed]')
                return joinParts(parts)
            }
            convo.push({ role: 'tool', content: result.text, toolCallId: call.id, name: call.name })
            if (result.encoded) parts.push(result.encoded.trim())
        }
    }
    return joinParts(parts)
}

function joinParts(parts: string[]): string {
    return parts.filter((p) => p.length > 0).join('\n\n')
}
