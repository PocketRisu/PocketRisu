import { getDatabase, type Chat } from 'src/ts/storage/database.svelte'
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
