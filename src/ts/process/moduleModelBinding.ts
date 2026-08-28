import type { RisuModule } from './modules'

export const MODULE_NAMESPACE_BINDING_PREFIX = 'namespace:'

/**
 * Module UUIDs are regenerated on import. A namespace is authored by the
 * module and survives a re-import, so prefer it whenever one exists.
 */
export function moduleBindingKeys(module: Pick<RisuModule, 'id' | 'namespace'>): string[] {
    return module.namespace
        ? [`${MODULE_NAMESPACE_BINDING_PREFIX}${module.namespace}`, module.id]
        : [module.id]
}

export function getModuleBindingPresetId(
    module: Pick<RisuModule, 'id' | 'namespace'> | undefined,
    bindings: Record<string, string> | undefined,
): string | undefined {
    if (!module || !bindings) return undefined
    return moduleBindingKeys(module)
        .map((key) => bindings[key])
        .find((presetId) => !!presetId)
}

/** Moves live UUID bindings to the stable namespace key without touching
 * orphaned entries. Those may reconnect if their original module is restored. */
export function migrateModuleBindingKeys(
    modules: Pick<RisuModule, 'id' | 'namespace'>[],
    bindings: Record<string, string>,
): boolean {
    let changed = false
    for (const module of modules) {
        if (!module.namespace || !bindings[module.id]) continue
        const stableKey = `${MODULE_NAMESPACE_BINDING_PREFIX}${module.namespace}`
        bindings[stableKey] ??= bindings[module.id]
        delete bindings[module.id]
        changed = true
    }
    return changed
}

const ROUTING_SIGNATURE = /(?:^|\n)\[lb-routing\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\](?=$|\n)/g

/**
 * LightBoard puts a stable routing marker in its own auxiliary prompts. Match
 * it only for an already-attributed module request, so normal chat text cannot
 * select a module preset. Multiple or unknown markers deliberately fall back
 * to the module that made the request.
 */
export function resolveModuleRoutingSignature(
    ownerModuleId: string | undefined,
    messages: readonly { content?: string }[] | undefined,
    modules: Pick<RisuModule, 'id' | 'namespace'>[],
): string | undefined {
    if (!ownerModuleId || !messages) return undefined
    const owner = modules.find((module) => module.id === ownerModuleId)
    if (owner?.namespace !== 'lightboard') return undefined

    const signatures = new Set<string>()
    for (const message of messages) {
        if (typeof message.content !== 'string') continue
        for (const match of message.content.matchAll(ROUTING_SIGNATURE)) {
            signatures.add(match[1])
        }
    }
    if (signatures.size !== 1) return undefined

    const [signature] = signatures
    const matches = modules.filter((module) => module.namespace === signature)
    return matches.length === 1 ? matches[0].id : undefined
}

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
 * LightBoard extensions delegate their LLM work to the `lightboard` backend.
 * They need a selectable slot even when they have no low-level permission or
 * direct model-call trigger of their own. Namespace is the canonical identity;
 * the name check preserves compatibility with older LightBoard packages that
 * predate namespaces.
 */
export function isLightBoardModule(module: Pick<RisuModule, 'name' | 'namespace'> | undefined): boolean {
    if (!module) return false
    return module.namespace === 'lightboard'
        || module.namespace?.startsWith('lb-') === true
        || module.name.includes('라이트보드')
        || /\blightboard\b/i.test(module.name)
}

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
export function listModelCallingModules(
    modules: RisuModule[],
    includeLightBoard = true,
): RisuModule[] {
    return modules.filter((module) => {
        if (isLightBoardModule(module)) return includeLightBoard
        return (
            module?.lowLevelAccess
            && module.trigger?.some((trigger) =>
                trigger?.effect?.some((effect) =>
                    LLM_EFFECT_TYPES.has(effect?.type) || CODE_EFFECT_TYPES.has(effect?.type)
                )
            )
        )
    })
}
