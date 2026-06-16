import { getDatabase, type Chat, type Database } from 'src/ts/storage/database.svelte'
import type { AdapterCredential } from 'src/ts/preset/adapter'
import type { ModelPreset } from 'src/ts/preset/types'
import type { ModelModeExtended } from './shared'

/**
 * P4 dual-regime resolution (plan v6 §7, model-preset-p4-task).
 *
 * `resolveChatModelBinding` is the single chokepoint that decides, per request
 * mode, whether a chat dispatches via the ModelPreset adapter path or the
 * classic global-model path. It is inserted in `requestChatDataMain` BEFORE the
 * legacy `db.seperateModelsForAxModels` block so a binding chat never reads the
 * global aux-model settings (no cross-regime leak).
 *
 * Resolution rules:
 *  - regime gate: global `nodeOnlyModelModeLock` ('legacy'/'preset') forces the
 *    regime; 'none' uses the chat's own `chat.useModelPreset` only (the new-chat
 *    default is snapshotted at creation, not read here). Classic → 'classic'.
 *    Preset regime with no bundle → block (under a preset lock the global
 *    default binding is the fallback; under 'none' there is no live fallback).
 *  - mode 'model'    → main slot.  unresolved → block (main is often expensive;
 *                      never silently fall back to a different model).
 *  - mode 'submodel' → sub slot.   unresolved → block.
 *  - aux modes (memory/emotion/translate/otherAx):
 *      separateAux on + slot resolves → that preset
 *      otherwise → fall back to sub slot ("use default sub model").
 *
 * "Unresolved" = the id is undefined OR dangling (points at a preset that no
 * longer exists). Both are treated identically; dangling ids are never
 * auto-cleared so a re-imported preset reconnects.
 */
export type ResolvedBinding =
    | { kind: 'classic' }
    | { kind: 'modelPreset'; preset: ModelPreset }
    | { kind: 'block'; reason: 'main-unset' | 'sub-unset' }

function findPreset(id: string | undefined, presets: ModelPreset[]): ModelPreset | undefined {
    if (!id) return undefined
    return presets.find((p) => p.id === id)
}

export function resolveChatModelBinding(
    chat: Chat | null | undefined,
    mode: ModelModeExtended,
): ResolvedBinding {
    const db = getDatabase()
    const lock = db.nodeOnlyModelModeLock ?? 'none'

    // Effective regime. A global lock forces every chat into one regime; 'none'
    // defers to the chat's OWN stored choice only. The new-chat default
    // (useModelPresetByDefault) is snapshotted into chats at creation
    // (newChatModelDefaults), never read here — reading it here would
    // retroactively flip every existing undecided chat.
    const usePreset =
        lock === 'preset' ? true :
        lock === 'legacy' ? false :
        (chat?.useModelPreset ?? false)

    if (!usePreset) {
        return { kind: 'classic' }
    }

    // Preset regime. Use the chat's own bundle. Under a global preset lock, a
    // pre-existing chat may have no bundle yet (it predates the lock); fall back
    // to the global default for that deliberate global case only. Under 'none'
    // there is no live fallback — a 'none' preset chat always carries its own
    // snapshot (seeded at creation / on sidebar open). No bundle → block.
    const set = chat?.modelBinding ?? (lock === 'preset' ? db.defaultModelBinding : undefined)
    if (!set) {
        return { kind: 'block', reason: mode === 'model' ? 'main-unset' : 'sub-unset' }
    }

    const presets = db.modelPresets ?? []

    if (mode === 'model') {
        const main = findPreset(set.main, presets)
        return main
            ? { kind: 'modelPreset', preset: main }
            : { kind: 'block', reason: 'main-unset' }
    }

    // submodel + all aux modes resolve against the sub slot, with aux slots
    // overriding when separateAux is on (mirrors classic: db.subModel default,
    // db.seperateModels[task] override).
    const sub = findPreset(set.sub, presets)

    if (mode !== 'submodel' && set.separateAux) {
        const auxPreset = findPreset(set.aux?.[mode], presets)
        if (auxPreset) return { kind: 'modelPreset', preset: auxPreset }
    }

    return sub
        ? { kind: 'modelPreset', preset: sub }
        : { kind: 'block', reason: 'sub-unset' }
}

/**
 * Effective max OUTPUT-token cap declared by a ModelPreset, read from its own
 * schema/userValues/defaults — the field that maps to the provider's
 * output-token body path (`max_tokens` for most providers, `maxOutputTokens`
 * for Gemini-native).
 *
 * Token-budget math must use THIS, not the legacy global `db.maxResponse`: that
 * is a separate "[채팅 봇]" setting that can carry an unrelated value (e.g. a
 * stray 65535 imported from a shared prompt preset) which would eat the entire
 * context window and make even the first message fail with a false "too much
 * token" error.
 *
 * Resolution order: user-set value → schema default → profileSnapshot.defaults
 * (the provider body default). The defaults pass matters for older preset
 * snapshots created before the schema gained a max_tokens field — e.g. Anthropic
 * profiles ship `defaults: { max_tokens: 4096 }`, and the Anthropic adapter
 * further injects 4096 on the wire — so without it such presets would wrongly
 * reserve db.maxResponse and re-trigger the false "too much token" error.
 *
 * Returns undefined when the preset declares no output-token value anywhere, so
 * the caller falls back to db.maxResponse.
 *
 * NOTE: a power user who overrides max_tokens via the preset's customBody /
 * additional-params textarea is not reflected here (the budget may then slightly
 * over/under-reserve); the actual wire request still honors that override.
 * Mirroring the full buildRequest merge was deliberately left out to keep this
 * off the request-builder path.
 */
const OUTPUT_TOKEN_KEYS = ['max_tokens', 'maxOutputTokens', 'max_output_tokens', 'max_completion_tokens']

export function resolvePresetMaxOutputTokens(preset: ModelPreset): number | undefined {
    const schema = preset.profileSnapshot?.schema ?? []
    const userValues = preset.userValues ?? {}

    // Body paths that can carry the cap: the bare keys, plus any nested path a
    // schema output field maps to (e.g. generationConfig.maxOutputTokens).
    const outputPaths: string[] = [...OUTPUT_TOKEN_KEYS]

    for (const field of schema) {
        const path = field.mapsTo?.path
        const isOutputField =
            OUTPUT_TOKEN_KEYS.includes(field.key) ||
            (typeof path === 'string' && OUTPUT_TOKEN_KEYS.some((k) => path === k || path.endsWith('.' + k)))
        if (!isOutputField) continue
        if (typeof path === 'string' && !outputPaths.includes(path)) outputPaths.push(path)
        const raw = userValues[field.key] ?? field.default
        if (isPositiveNumber(raw)) return raw
    }

    // Fall back to the provider body defaults (covers legacy snapshots whose
    // schema has no output field but whose defaults — or adapter — set the cap).
    const defaults = preset.profileSnapshot?.defaults
    if (defaults && typeof defaults === 'object') {
        for (const path of outputPaths) {
            const raw = getNested(defaults as Record<string, unknown>, path)
            if (isPositiveNumber(raw)) return raw
        }
    }
    return undefined
}

function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
    if (!path.includes('.')) return obj[path]
    let cur: unknown = obj
    for (const part of path.split('.')) {
        if (typeof cur !== 'object' || cur === null) return undefined
        cur = (cur as Record<string, unknown>)[part]
    }
    return cur
}

/**
 * Effective output-token reservation for a chat's main request: the bound
 * ModelPreset's own max-output cap, falling back to the legacy global
 * db.maxResponse for classic chats (or presets that declare no output field).
 *
 * This is the single source so that the reservation ADDED to the context budget
 * (process/index.svelte.ts) and any later correction that SUBTRACTS it
 * (memory/hypav3.ts) always use the same value.
 */
export function resolveChatMaxResponseTokens(chat: Chat | null | undefined): number {
    const db = getDatabase()
    const binding = resolveChatModelBinding(chat, 'model')
    if (binding.kind === 'modelPreset') {
        const presetOut = resolvePresetMaxOutputTokens(binding.preset)
        if (presetOut !== undefined) return presetOut
    }
    return db.maxResponse
}

/**
 * Per-chat prompt-preset parameter override (chat.usePromptPresetParams).
 *
 * The classic path reads sampling parameters from the active prompt preset
 * (mirrored into db.temperature / db.top_p / ... by setPreset); the ModelPreset
 * path ignores them entirely and uses preset.userValues. When the user opts in
 * on a chat, inject the prompt preset's sampling values into a COPY of the
 * preset's userValues so they override the editor's values.
 *
 * Priority: sits ABOVE userValues but BELOW customBody / additionalParamsText —
 * buildPreparedRequest applies those after userValues, so explicit power-user
 * overrides keep the final say (same ordering the classic path gives its
 * "additional parameters" textarea).
 *
 * Scope guards:
 *  - main request only (mode 'model') — aux/sub requests keep their preset values.
 *  - schema-gated: only field keys the snapshot declares are injected, so a
 *    profile without e.g. top_k (or without temperature at all, like newer
 *    Anthropic profiles) is never sent an unsupported parameter. Field keys are
 *    wire-flavored per provider (top_p vs topP), hence the alias entries.
 *  - sampling only: output-token caps (max_tokens) and thinking config stay on
 *    the model preset — overriding them would desync the token-budget math in
 *    resolvePresetMaxOutputTokens.
 *  - -1000 is the classic "slider disabled" sentinel; treated as unset.
 */
const PROMPT_PARAM_READERS: Record<string, (db: Database) => number | undefined> = {
    temperature: (db) => hundredScale(db.temperature),
    top_p: (db) => db.top_p,
    topP: (db) => db.top_p,
    top_k: (db) => db.top_k,
    topK: (db) => db.top_k,
    frequency_penalty: (db) => hundredScale(db.frequencyPenalty),
    frequencyPenalty: (db) => hundredScale(db.frequencyPenalty),
    presence_penalty: (db) => hundredScale(db.PresensePenalty),
    presencePenalty: (db) => hundredScale(db.PresensePenalty),
    repetition_penalty: (db) => db.repetition_penalty,
    min_p: (db) => db.min_p,
    top_a: (db) => db.top_a,
}

// Classic sliders store hundredths (0–200 => 0–2.0); -1000 means disabled.
function hundredScale(value: number | undefined): number | undefined {
    if (value === undefined || value === -1000) return undefined
    return value / 100
}

export function applyPromptPresetParams(
    preset: ModelPreset,
    chat: Chat | null | undefined,
    mode: ModelModeExtended,
): ModelPreset {
    if (mode !== 'model') return preset
    if (!chat?.usePromptPresetParams) return preset
    const schema = preset.profileSnapshot?.schema
    if (!schema || schema.length === 0) return preset

    const db = getDatabase()
    const overrides: Record<string, unknown> = {}
    for (const field of schema) {
        if (field.mapsTo?.target !== 'body') continue
        const read = PROMPT_PARAM_READERS[field.key]
        if (!read) continue
        const value = read(db)
        if (value === undefined || value === null || Number.isNaN(value) || value === -1000) continue
        overrides[field.key] = value
    }
    if (Object.keys(overrides).length === 0) return preset

    // Shallow copy on purpose: the stored preset (db state) must not be mutated,
    // and adapters only read. profileSnapshot stays shared by reference.
    return { ...preset, userValues: { ...(preset.userValues ?? {}), ...overrides } }
}

/**
 * Build the adapter credential for a ModelPreset.
 *
 * The key the user types in the preset editor is a schema field whose
 * `mapsTo.target === 'auth'` (e.g. provider `apiKey`), stored in
 * `preset.userValues`. `buildPreparedRequest` deliberately SKIPS auth-target
 * fields ("auth values flow through applyAuth via credential"), so they must be
 * lifted into the credential here. For `google-service-account` the auth field
 * holds the SA JSON, which the async `resolveAdapterCredential` step later swaps
 * for an access token.
 *
 * Resolution order: apiKeyRef → db.apiKeyPool (pooled keys, future UI) →
 * inlineCredential → schema-driven auth userValue (the editor's key field).
 */
export function buildModelPresetCredential(preset: ModelPreset): AdapterCredential | undefined {
    const db = getDatabase()
    if (preset.apiKeyRef) {
        const entry = db.apiKeyPool?.[preset.apiKeyRef]
        if (entry?.key) return { apiKey: entry.key }
    }
    if (typeof preset.inlineCredential === 'string' && preset.inlineCredential.length > 0) {
        return { apiKey: preset.inlineCredential }
    }
    if (preset.inlineCredential && typeof preset.inlineCredential === 'object') {
        return preset.inlineCredential as AdapterCredential
    }
    for (const field of preset.profileSnapshot.schema) {
        if (field.mapsTo?.target !== 'auth') continue
        const value = preset.userValues?.[field.key]
        if (typeof value === 'string' && value.length > 0) {
            return { apiKey: value }
        }
    }
    return undefined
}
