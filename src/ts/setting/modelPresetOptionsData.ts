// Data-driven items for the Model Preset page's "Settings" tab.
// Rendered with SettingRenderer layout="row" (see ui.md "Setting 행 레이아웃").

import type { Database } from '../storage/database.svelte'
import type { SettingItem } from './types'

// Switching registry source (toggle / URL) should take effect on the next menu
// entry, not 5s later. Clearing last-fetched bypasses the debounce; the sync
// itself detects the source change (the cached entry's `source` no longer
// matches) and re-downloads, resetting the notice baseline accordingly.
function triggerRegistryResync(db: Database): void {
    db.modelProfileRegistryLastFetched = 0
}

export const modelPresetOptionsItems: SettingItem[] = [
    {
        // Which model system chats use. Lives here rather than accessibility
        // because it decides whether the model preset system is in play at all.
        id: 'modelPreset.modelModeLock',
        type: 'radio',
        labelKey: 'modelModeLockLabel',
        bindKey: 'nodeOnlyModelModeLock',
        helpKey: 'modelModeLock',
        options: {
            selectOptions: [
                { value: 'legacy', labelKey: 'modelModeLockLegacy', descriptionKey: 'modelModeLockLegacyDesc' },
                { value: 'preset', labelKey: 'modelModeLockPreset', descriptionKey: 'modelModeLockPresetDesc' },
                { value: 'none', labelKey: 'modelModeLockNone', descriptionKey: 'modelModeLockNoneDesc' },
            ],
        },
        keywords: ['model', 'mode', 'legacy', 'preset', 'binding', 'lock', 'sidebar'],
    },
    {
        id: 'modelPreset.newChatModelMode',
        type: 'select',
        labelKey: 'newChatModelModeLabel',
        helpKey: 'newChatModelMode',
        condition: (ctx) => (ctx.db.nodeOnlyModelModeLock ?? 'none') === 'none',
        // Backed by the existing boolean useModelPresetByDefault (preset=true).
        getValue: (db) => (db.useModelPresetByDefault ? 'preset' : 'legacy'),
        setValue: (db, val) => { db.useModelPresetByDefault = val === 'preset'; },
        options: {
            selectOptions: [
                { value: 'legacy', labelKey: 'modelModeLegacy' },
                { value: 'preset', labelKey: 'modelModePreset' },
            ],
        },
        keywords: ['model', 'mode', 'new', 'chat', 'default', 'legacy', 'preset'],
    },
    {
        // Default ON (database defaults). Kill switch for the server-side
        // request relay — placed here (not advanced settings) because it only
        // affects the model-preset path and needs to be discoverable.
        id: 'modelPreset.serverSideRequests',
        type: 'check',
        labelKey: 'nodeOnlyServerSideRequests',
        helpKey: 'nodeOnlyServerSideRequests',
        bindKey: 'nodeOnlyServerSideRequests',
    },
    {
        // Global display setting (applies to every streamed response, not
        // per-preset) — surfaced here instead of advanced settings so users
        // actually find it.
        id: 'modelPreset.streamingDisplayOpt',
        type: 'radio',
        labelKey: 'streamingDisplayOptimizationMode',
        bindKey: 'streamingDisplayOptimizationMode',
        helpKey: 'streamingDisplayOptimizationMode',
        options: {
            // Intensity-ordered; the NodeOnly default is 'balanced'
            // (set in setDatabase), diverging from the first-option convention.
            selectOptions: [
                { value: 'off', labelKey: 'streamingDisplayOptimizationOff', descriptionKey: 'streamingDisplayOptimizationOffDesc' },
                { value: 'balanced', labelKey: 'streamingDisplayOptimizationBalanced', descriptionKey: 'streamingDisplayOptimizationBalancedDesc' },
                { value: 'strong', labelKey: 'streamingDisplayOptimizationStrong', descriptionKey: 'streamingDisplayOptimizationStrongDesc' }
            ]
        }
    },
    {
        id: 'modelPreset.visibilityLevel',
        type: 'select',
        labelKey: 'profileVisibilityLevel',
        helpKey: 'profileVisibilityLevel',
        bindKey: 'modelProfileVisibilityLevel',
        options: {
            // First option is the convention default (see SettingSelect reset
            // fallback) — keep it aligned with dbDefaults' 'currentOnly'.
            selectOptions: [
                { value: 'currentOnly', labelKey: 'profileVisibilityCurrentOnly' },
                { value: 'hideDeprecated', labelKey: 'profileVisibilityHideDeprecated' },
                { value: 'all', labelKey: 'profileVisibilityAll' },
            ],
        },
    },
    {
        id: 'modelPreset.useCustomRegistry',
        type: 'check',
        labelKey: 'useCustomRegistry',
        helpKey: 'useCustomRegistry',
        bindKey: 'useCustomModelRegistry',
        onChange: (_v, ctx) => triggerRegistryResync(ctx.db),
    },
    {
        id: 'modelPreset.customRegistryUrl',
        type: 'text',
        labelKey: 'customRegistryUrl',
        helpKey: 'customRegistryUrl',
        bindKey: 'modelProfileRegistryBaseUrl',
        condition: (ctx) => !!ctx.db.useCustomModelRegistry,
        options: { placeholder: 'https://raw.githubusercontent.com/<user>/<repo>/<branch>/' },
        onChange: (_v, ctx) => triggerRegistryResync(ctx.db),
    },
    {
        id: 'modelPreset.customRegistryWarning',
        type: 'custom',
        componentId: 'CustomizationWarning',
        componentProps: { messageKey: 'customRegistryWarning' },
        condition: (ctx) => !!ctx.db.useCustomModelRegistry,
    },
    {
        id: 'modelPreset.registryRefresh',
        type: 'custom',
        componentId: 'ModelRegistryRefresh',
    },
]
