// Settings menu routing.
//
// `SettingsMenuIndex` is a numeric store consumed throughout
// `Settings.svelte`'s ~25 menu entries. Migrating to string IDs everywhere is
// a large refactor that touches every entry; instead this module exposes
// named constants for the existing numeric values so external callers can
// avoid magic numbers (and the bugs that come with reorderings).
//
// Add an entry here whenever a new settings page is added in
// `Settings.svelte`. Internal `Settings.svelte` switches still use the raw
// number — that file is the source of truth and changes there should update
// this map too.
//
// ⚠️ Settings search: a new page (or new sub-tab / hardcoded section) must
// also be registered for search — declarative SettingItem arrays go in
// src/ts/setting/searchIndex.ts (declarativeSources), hardcoded pages in
// src/ts/setting/searchManifestData.ts. Otherwise it won't be findable.

import { settingsOpen, SettingsMenuIndex, SystemSubmenuIndex, AccessibilitySubmenuIndex, ModelPresetListTabIndex } from "./stores.svelte";

export const SettingsRoute = {
    None: -1 as const,
    Migration: 0 as const,
    ChatBot: 1 as const,
    OtherBots: 2 as const,
    Display: 3 as const,
    Plugin: 4 as const,
    Files: 5 as const,
    Advanced: 6 as const,
    SoundAndNotification: 7 as const,
    GlobalLoreBook: 8 as const,
    GlobalRegex: 9 as const,
    Language: 10 as const,
    Accessibility: 11 as const,
    Persona: 12 as const,
    Prompt: 13 as const,
    Module: 14 as const,
    Hotkey: 15 as const,
    ModelPreset: 16 as const,
    PromptPreset: 17 as const,
    RemoteAccess: 21 as const,
    System: 22 as const,
    InlayImageGallery: 23 as const,
    DevPanel: 99 as const,
} as const;

export type SettingsRouteValue = (typeof SettingsRoute)[keyof typeof SettingsRoute];

/** Sub-tab indices inside the System settings page. */
export const SystemTab = {
    Dashboard: 0 as const,
    Backups: 1 as const,
    Logs: 2 as const,
    RequestLogs: 3 as const,
    Usage: 4 as const,
    PluginStorage: 5 as const,
} as const;

export type SystemTabValue = (typeof SystemTab)[keyof typeof SystemTab];

/** Sub-tab indices inside the Accessibility settings page (mirrors the tab
 *  order in AccessibilitySettings.svelte). */
export const AccessibilityTab = {
    Editing: 0 as const,
    Scroll: 1 as const,
    Sidebar: 2 as const,
    Others: 3 as const,
} as const;

export type AccessibilityTabValue = (typeof AccessibilityTab)[keyof typeof AccessibilityTab];

/** Top-level tab indices of the Model Preset page ($ModelPresetListTabIndex).
 *  Values mirror the SettingTabs list in ModelPresetSettings.svelte — note the
 *  display order there is Presets, Keys, Modules, Options while the stored
 *  values are not sequential. */
export const ModelPresetTab = {
    Presets: 0 as const,
    Keys: 1 as const,
    Options: 2 as const,
    Modules: 3 as const,
} as const;

export type ModelPresetTabValue = (typeof ModelPresetTab)[keyof typeof ModelPresetTab];

/**
 * Open the settings panel and navigate to a specific page (and optional
 * System sub-tab). Use this from anywhere in the app that needs to deep-link
 * into settings.
 */
export function openSettings(
    route: SettingsRouteValue,
    systemTab?: SystemTabValue,
    accessibilityTab?: AccessibilityTabValue,
    modelPresetTab?: ModelPresetTabValue,
) {
    SettingsMenuIndex.set(route);
    if (systemTab !== undefined) {
        SystemSubmenuIndex.set(systemTab);
    }
    if (accessibilityTab !== undefined) {
        AccessibilitySubmenuIndex.set(accessibilityTab);
    }
    if (modelPresetTab !== undefined) {
        ModelPresetListTabIndex.set(modelPresetTab);
    }
    settingsOpen.set(true);
}
