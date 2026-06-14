import type { ApiKeyPoolEntry, ModelPreset, ModelPresetMigrationSummary, RegistryCache, ResolvedModelProfileSnapshot } from './types'
import { resolveSnapshot } from './registry/snapshot'
import { loadBundledRegistry, getBundledRegistryId } from './registry/loader'

export interface ModelPresetDefaultsTarget {
    modelPresets?: ModelPreset[]
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelProfileRegistryCache?: RegistryCache
    modelProfileRegistryLastFetched?: number
    modelProfileVisibilityLevel?: 'all' | 'hideDeprecated' | 'currentOnly'
}

export function createEmptyRegistryCache(): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {},
    }
}

// A persisted profileSnapshot can carry null/undefined elements in its schema /
// uiSchema arrays, or — for a degenerate snapshot — a missing / non-array schema
// or uiSchema altogether (legacy/malformed registry data). The resolve path
// filters these, but already-saved presets keep them and crash every consumer
// that reads `.key`/`.map()`/`.fields` — the settings UI on render, buildRequest /
// wireInvariants on send, and the heal path below (applyProfileSnapshotUpdate
// calls `.schema.map()`). Normalize once at the load boundary so all paths see a
// snapshot whose schema / uiSchema.groups / uiSchema.fields are always (possibly
// empty) arrays; the cleaned value persists with the next save.
function sanitizeModelPresetSnapshots(presets: ModelPreset[]): void {
    for (const preset of presets) {
        const snapshot = preset?.profileSnapshot as any
        if (!snapshot) continue
        // schema → array; only reallocate when it isn't already a null-free array
        // so clean snapshots (the normal case) are left untouched on every load.
        if (!Array.isArray(snapshot.schema)) {
            snapshot.schema = []
        } else if (!snapshot.schema.every(Boolean)) {
            snapshot.schema = snapshot.schema.filter(Boolean)
        }
        // uiSchema → object with array groups/fields.
        if (!snapshot.uiSchema || typeof snapshot.uiSchema !== 'object') {
            snapshot.uiSchema = { groups: [], fields: [] }
        }
        const uiSchema = snapshot.uiSchema
        if (!Array.isArray(uiSchema.groups)) {
            uiSchema.groups = []
        } else if (!uiSchema.groups.every(Boolean)) {
            uiSchema.groups = uiSchema.groups.filter(Boolean)
        }
        if (!Array.isArray(uiSchema.fields)) {
            uiSchema.fields = []
        } else if (!uiSchema.fields.every(Boolean)) {
            uiSchema.fields = uiSchema.fields.filter(Boolean)
        }
    }
}

// A snapshot is degenerate when it lost the data a settings form / request needs:
// null auth/endpoint, or an empty schema / uiSchema.fields. Such a snapshot
// renders a blank form (hiding the API key) — see the "vercel:openai-compatible"
// report (issues.md). It happens when a preset is resolved against an incomplete
// base provider at creation (the generic passthrough profile carries no fields of
// its own, so it's only as complete as the base at that moment).
//
// A second, subtler shape: the profile's own fields resolve fine (non-empty
// schema / uiSchema.fields), but the base-provided credential field was dropped —
// auth.fields still declares e.g. ['apiKey'] yet NO schema field maps to auth
// (mapsTo.target === 'auth'), so the user has no way to enter the API key. The
// openai presets hit this (13 profile fields present, apiKey missing). Flag these
// too so heal re-resolves the credential field from the current registry.
function isDegenerateSnapshot(s: ResolvedModelProfileSnapshot | undefined): boolean {
    if (!s) return true
    if (!s.auth || !s.endpoint) return true
    if (!Array.isArray(s.schema) || s.schema.length === 0) return true
    if (!Array.isArray(s.uiSchema?.fields) || s.uiSchema.fields.length === 0) return true
    const authFields = s.auth.fields
    if (Array.isArray(authFields) && authFields.length > 0) {
        const hasAuthField = s.schema.some((f) => f?.mapsTo?.target === 'auth')
        if (!hasAuthField) return true
    }
    return false
}

// Re-take a frozen-degenerate snapshot from the current registry. When we still
// know which profile a broken preset came from (sourceProfile), resolve a fresh
// snapshot from the best registry available and migrate userValues onto it via
// the normal profile-update path (type-changed values move to orphans). Applied
// only when the fresh snapshot is actually complete, so heal never makes a preset
// worse — a degenerate-but-unhealable preset falls through to the SchemaFormRenderer
// schema fallback instead. Runs at the load boundary so the repair persists with
// the next save (mirrors sanitizeModelPresetSnapshots).
function healDegenerateSnapshots(data: ModelPresetDefaultsTarget): void {
    const presets = data.modelPresets
    if (!Array.isArray(presets)) return
    // Candidate registries, best first: the persisted official cache (matches the
    // live resolution path), then the build-time bundled registry as a
    // guaranteed-complete fallback.
    const registries: RegistryCache[] = []
    const officialEntry = data.modelProfileRegistryCache?.registries?.[getBundledRegistryId()]
    if (officialEntry?.profiles && Object.keys(officialEntry.profiles).length > 0) {
        registries.push({ schemaVersion: 4, registries: { [getBundledRegistryId()]: officialEntry } })
    }
    registries.push(loadBundledRegistry())

    for (let i = 0; i < presets.length; i++) {
        const preset = presets[i]
        if (!preset || !isDegenerateSnapshot(preset.profileSnapshot)) continue
        const profileId = preset.sourceProfile?.profileId
        if (!profileId) continue
        const sourceProfile = preset.sourceProfile
        for (const registry of registries) {
            // Isolate the whole attempt: resolveSnapshot reads arrays off a
            // (possibly still-malformed) snapshot, so a throw must never abort app
            // load — it just skips this preset (stays degenerate; render fallback
            // covers display). userValues migration is done inline rather than via
            // applyProfileSnapshotUpdate: that path diffs the OLD snapshot, which
            // throws on a degenerate one (null auth/endpoint → authEqual reads
            // `.kind` of null). Heal doesn't need the diff — keep userValues whose
            // key survives in the fresh schema, orphan the rest.
            try {
                const fresh = resolveSnapshot(registry, profileId)
                if (isDegenerateSnapshot(fresh)) continue
                // Mirror applyProfileSnapshotUpdate's userValues contract: keep a
                // value only if its key survives in the fresh schema AND its type
                // didn't change; otherwise move it to orphanValues. (sanitize has
                // already coerced the old schema to a null-free array.)
                const freshByKey = new Map(fresh.schema.map((f) => [f.key, f]))
                const currentByKey = new Map(
                    (preset.profileSnapshot?.schema ?? []).filter(Boolean).map((f) => [f.key, f]),
                )
                const nextUserValues: Record<string, unknown> = {}
                const orphanValues: Record<string, unknown> = { ...(preset.orphanValues ?? {}) }
                for (const [k, v] of Object.entries(preset.userValues ?? {})) {
                    const latestField = freshByKey.get(k)
                    if (!latestField) { orphanValues[k] = v; continue }            // removed
                    const currentField = currentByKey.get(k)
                    if (currentField && currentField.type !== latestField.type) {  // type-changed
                        orphanValues[k] = v
                        continue
                    }
                    nextUserValues[k] = v
                }
                // Re-stamp sourceProfile to the resolved profile so an update badge
                // doesn't immediately re-appear: version AND profileUpdatedAt both
                // advance to what we just healed to.
                const profileUpdatedAt = registry.registries?.[getBundledRegistryId()]?.profiles?.[profileId]?.updatedAt
                    ?? sourceProfile.profileUpdatedAt
                presets[i] = {
                    ...preset,
                    profileSnapshot: fresh,
                    sourceProfile: {
                        ...sourceProfile,
                        profileId: fresh.profileId,
                        profileVersion: fresh.profileVersion,
                        providerBaseVersion: fresh.providerBaseVersion,
                        fetchedAt: Date.now(),
                        profileUpdatedAt,
                    },
                    userValues: nextUserValues,
                    orphanValues: Object.keys(orphanValues).length > 0 ? orphanValues : undefined,
                    updatedAt: Date.now(),
                }
                break
            } catch {
                continue
            }
        }
    }
}

export function applyModelPresetDefaults(data: ModelPresetDefaultsTarget): void {
    if (!Array.isArray(data.modelPresets)) {
        data.modelPresets = []
    }
    sanitizeModelPresetSnapshots(data.modelPresets)
    if (!data.apiKeyPool || typeof data.apiKeyPool !== 'object' || Array.isArray(data.apiKeyPool)) {
        data.apiKeyPool = {}
    }
    if (!data.modelProfileRegistryCache || data.modelProfileRegistryCache.schemaVersion !== 4) {
        data.modelProfileRegistryCache = createEmptyRegistryCache()
    }
    data.modelProfileRegistryLastFetched ??= 0
    // Default to current-only: most users want just the latest models; outdated
    // /deprecated profiles stay downloaded but hidden until opted into.
    data.modelProfileVisibilityLevel ??= 'currentOnly'
    // After the registry cache is normalized above, repair any preset whose
    // snapshot froze degenerate (empty fields) against the now-current registry.
    healDegenerateSnapshots(data)
}
