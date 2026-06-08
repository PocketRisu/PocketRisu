import type { ApiKeyPoolEntry, ModelPreset, ModelPresetMigrationSummary, RegistryCache } from './types'

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
// uiSchema arrays (legacy/malformed registry data). The resolve path filters
// these, but already-saved presets keep the nulls and crash every consumer that
// reads `.key`/`.mapsTo`/`.order` — the settings UI on render, and buildRequest /
// wireInvariants on send. Strip them once at the load boundary so all paths see a
// clean snapshot; the cleaned value persists with the next save.
function sanitizeModelPresetSnapshots(presets: ModelPreset[]): void {
    for (const preset of presets) {
        const snapshot = preset?.profileSnapshot
        if (!snapshot) continue
        // Only reallocate when a null is actually present, so clean snapshots
        // (the normal case) are left untouched on every load.
        if (Array.isArray(snapshot.schema) && !snapshot.schema.every(Boolean)) {
            snapshot.schema = snapshot.schema.filter(Boolean)
        }
        const uiSchema = snapshot.uiSchema
        if (uiSchema) {
            if (Array.isArray(uiSchema.groups) && !uiSchema.groups.every(Boolean)) {
                uiSchema.groups = uiSchema.groups.filter(Boolean)
            }
            if (Array.isArray(uiSchema.fields) && !uiSchema.fields.every(Boolean)) {
                uiSchema.fields = uiSchema.fields.filter(Boolean)
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
}
