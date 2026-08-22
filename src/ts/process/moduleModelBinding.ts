import type { RisuModule } from './modules'

/**
 * Trigger effects that issue a direct LLM request attributable to the module.
 *
 * Deliberately excludes `sendAIprompt` / `v2SendAIprompt`: those only raise a
 * flag that makes Risu send the NORMAL chat message afterwards, so the response
 * is the reply the user reads — not an auxiliary module call — and must keep
 * using the chat's own model. `runAxLLM` is declared in the trigger effect union
 * but has no case handler, so it never fires; listing it here would put modules
 * in the picker that can never be routed.
 */
const LLM_EFFECT_TYPES = new Set(['runLLM', 'v2RunLLM'])

/** Script effects. The LLM call lives inside an opaque code blob, so presence of
 * the blob is the signal — we do not scan the code for `LLMMain`/`simpleLLM`/
 * `axLLMMain`. A false positive costs one extra row that does nothing until the
 * user binds it; a false negative would silently make the feature look broken. */
const CODE_EFFECT_TYPES = new Set(['triggerlua', 'triggercode'])

/**
 * Modules that can issue an LLM request, i.e. the candidates for a per-module
 * ModelPreset binding.
 *
 * `lowLevelAccess` is a hard gate, not a heuristic: every LLM entry point checks
 * it and returns early without it — the Lua/Python APIs via `ScriptingLowLevelIds`
 * and the trigger effects via `trigger.lowLevelAccess`. So a module without it
 * provably cannot call a model, and importing such a module already required an
 * explicit user confirmation, which keeps this list short.
 */
export function listModelCallingModules(modules: RisuModule[]): RisuModule[] {
    return modules.filter((module) =>
        module?.lowLevelAccess &&
        module.trigger?.some((trigger) =>
            trigger?.effect?.some((effect) =>
                LLM_EFFECT_TYPES.has(effect?.type) || CODE_EFFECT_TYPES.has(effect?.type)
            )
        )
    )
}
