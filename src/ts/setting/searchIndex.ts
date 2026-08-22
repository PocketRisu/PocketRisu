/**
 * Settings Search Index
 *
 * Builds a flat, searchable list of settings from two sources:
 *  1. Declarative SettingItem arrays (the data files in this folder) —
 *    indexed automatically at item granularity, registered in
 *    `declarativeSources` below.
 *  2. `searchManifestData.ts` — hand-written entries for hardcoded pages
 *    (page / sub-tab granularity).
 *
 * ⚠️ MAINTENANCE:
 *  - New declarative data file → add it to `declarativeSources`.
 *  - New hardcoded page/sub-tab/provider → add it to searchManifestData.ts.
 *  - New settings page in Settings.svelte → also needs a SettingsRoute entry
 *    in src/ts/routing.ts and (if tabbed) a submenu store in stores.svelte.
 *
 * The index is rebuilt per query (a few hundred items — cheap), because
 * labels depend on the current UI locale and visibility conditions depend
 * on live DB state.
 */

import type { SettingItem, SettingContext } from './types';
import { checkCondition, getLabel } from './utils';
import { language } from 'src/lang';
import { languageEnglish } from 'src/lang/en';
import { SettingsRoute, openSettings, type SettingsRouteValue } from '../routing';
import {
    DisplaySubmenuIndex,
    BotSubmenuIndex,
    PromptPresetSubmenuIndex,
    OtherBotsSubmenuIndex,
    InlayGallerySubmenuIndex,
    ModelPresetListTabIndex,
    SystemSubmenuIndex,
    AccessibilitySubmenuIndex,
} from '../stores.svelte';
import type { Writable } from 'svelte/store';

import {
    displayThemeSettingsItems,
    displaySizeSettingsItems,
    displayOtherHomeItems,
    displayOtherChatItems,
    displayOtherBubbleItems,
    displayOtherQuoteItems,
    displayOtherAdvancedItems,
} from './displaySettingsData.svelte';
import {
    accessibilityEditingItems,
    accessibilityScrollItems,
    accessibilitySidebarItems,
    accessibilityOtherItems,
} from './accessibilitySettingsData';
import { advancedSettingsItems } from './advancedSettingsData';
import { allBasicParameterItems } from './botSettingsParamsData';
import { languageSettingsItems } from './languageSettingsData.svelte';
import { inlayImageSettingsItems } from './inlayImageSettingsData';
import { modelPresetOptionsItems } from './modelPresetOptionsData';
import { moduleModelBindingItems } from './moduleModelBindingData';
import {
    promptPresetBasicInfoItems,
    promptPresetPromptItems,
    promptPresetParameterItems,
    promptPresetAdvancedItems,
} from './promptPresetSettingsData.svelte';
import { searchManifestEntries } from './searchManifestData';

// Intentionally NOT indexed:
//  - chatFormatSettingsItems: rendered conditionally per model backend
//    (Ooba/Openrouter sub-pages) — no stable navigation target.

interface DeclarativeSource {
    items: SettingItem[];
    route: SettingsRouteValue;
    subTab?: number;
    /** Lazy tab label — shown as the result's location breadcrumb */
    tabLabel?: () => string;
    /** Lazy section header label (e.g. Display > Others sections) */
    sectionLabel?: () => string;
}

const declarativeSources: DeclarativeSource[] = [
    { items: displayThemeSettingsItems, route: SettingsRoute.Display, subTab: 0, tabLabel: () => language.theme },
    { items: displaySizeSettingsItems, route: SettingsRoute.Display, subTab: 1, tabLabel: () => language.sizeAndSpeed },
    { items: displayOtherHomeItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionHomeList },
    { items: displayOtherChatItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionChatView },
    { items: displayOtherBubbleItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionBubble },
    { items: displayOtherQuoteItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionQuotes },
    { items: displayOtherAdvancedItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionAdvanced },
    { items: accessibilityEditingItems, route: SettingsRoute.Accessibility, subTab: 0, tabLabel: () => language.accTabEditing },
    { items: accessibilityScrollItems, route: SettingsRoute.Accessibility, subTab: 1, tabLabel: () => language.accTabScroll },
    { items: accessibilitySidebarItems, route: SettingsRoute.Accessibility, subTab: 2, tabLabel: () => language.accTabSidebar },
    { items: accessibilityOtherItems, route: SettingsRoute.Accessibility, subTab: 3, tabLabel: () => language.others },
    { items: advancedSettingsItems, route: SettingsRoute.Advanced },
    { items: allBasicParameterItems, route: SettingsRoute.ChatBot, subTab: 1, tabLabel: () => language.parameters },
    { items: languageSettingsItems, route: SettingsRoute.Language },
    { items: inlayImageSettingsItems, route: SettingsRoute.InlayImageGallery, subTab: 1, tabLabel: () => language.settings },
    // Model Preset list-view Options tab (list view shows when no preset is
    // being edited, which is the state a fresh navigation lands in)
    { items: modelPresetOptionsItems, route: SettingsRoute.ModelPreset, subTab: 2, tabLabel: () => language.modelPresetTabOptions },
    { items: moduleModelBindingItems, route: SettingsRoute.ModelPreset, subTab: 3, tabLabel: () => language.modelPresetTabModules },
    { items: promptPresetBasicInfoItems, route: SettingsRoute.PromptPreset, subTab: 0, tabLabel: () => language.basicInfo },
    { items: promptPresetPromptItems, route: SettingsRoute.PromptPreset, subTab: 1, tabLabel: () => language.prompt },
    { items: promptPresetParameterItems, route: SettingsRoute.PromptPreset, subTab: 2, tabLabel: () => language.parameters },
    { items: promptPresetAdvancedItems, route: SettingsRoute.PromptPreset, subTab: 3, tabLabel: () => language.advancedSettings },
];

/** Page title per route, for the result breadcrumb. */
function routeLabel(route: SettingsRouteValue): string {
    switch (route) {
        case SettingsRoute.Migration: return language.migration;
        case SettingsRoute.ChatBot: return language.chatBot;
        case SettingsRoute.OtherBots: return language.otherBots;
        case SettingsRoute.Display: return language.display;
        case SettingsRoute.Plugin: return language.plugin;
        case SettingsRoute.Advanced: return language.advancedSettings;
        case SettingsRoute.SoundAndNotification: return language.soundAndNotification;
        case SettingsRoute.GlobalLoreBook: return language.loreBook;
        case SettingsRoute.GlobalRegex: return language.regexScript;
        case SettingsRoute.Language: return language.language;
        case SettingsRoute.Accessibility: return language.accessibility;
        case SettingsRoute.Persona: return language.persona;
        case SettingsRoute.Prompt: return language.promptTemplate;
        case SettingsRoute.Module: return language.modules;
        case SettingsRoute.Hotkey: return language.hotkey;
        case SettingsRoute.ModelPreset: return language.modelPresetMenu;
        case SettingsRoute.PromptPreset: return language.promptPresetMenu;
        case SettingsRoute.RemoteAccess: return language.remoteAccess;
        case SettingsRoute.System: return language.system;
        case SettingsRoute.InlayImageGallery: return language.playground.inlayImageGallery;
        default: return '';
    }
}

export interface SettingSearchResult {
    /** Unique key for {#each} */
    key: string;
    label: string;
    /** "Page · Tab · Section" location breadcrumb */
    location: string;
    /** Inline help text (truncated by the UI) */
    help?: string;
    route: SettingsRouteValue;
    subTab?: number;
    /** data-setting-id anchor to scroll to after navigation */
    itemId?: string;
    /** Match rank, lower = better (0 label, 1 keyword, 2 help) */
    rank: number;
}

function flattenItems(items: SettingItem[], ctx: SettingContext): SettingItem[] {
    const out: SettingItem[] = [];
    for (const item of items) {
        if (!checkCondition(item, ctx)) continue;
        if (item.type === 'accordion') {
            out.push(...flattenItems(item.options?.children ?? [], ctx));
            continue;
        }
        // headers are section decoration, not navigable settings
        if (item.type === 'header') continue;
        out.push(item);
    }
    return out;
}

function helpText(item: SettingItem): string | undefined {
    if (!item.helpKey) return undefined;
    return (language.help as any)[item.helpKey];
}

// English is the merge base of every locale, so its labels always exist —
// index them alongside the current locale so e.g. "streaming" matches on a
// Korean UI. Other locales are NOT indexed (cross-language noise).
function englishLabel(item: SettingItem): string | undefined {
    if (item.labelKey) return (languageEnglish as any)[item.labelKey];
    return undefined;
}

function englishHelp(item: SettingItem): string | undefined {
    if (!item.helpKey) return undefined;
    return (languageEnglish.help as any)[item.helpKey];
}

function matchRank(query: string, labels: (string | undefined)[], keywords: string[] | undefined, helps: (string | undefined)[]): number {
    if (labels.some(l => l?.toLowerCase().includes(query))) return 0;
    if (keywords?.some(k => k.toLowerCase().includes(query))) return 1;
    if (helps.some(h => h?.toLowerCase().includes(query))) return 2;
    return -1;
}

const MAX_RESULTS = 30;

/**
 * Search all settings. `query` is matched case-insensitively against
 * label, keywords, then help text. Items hidden by their `condition`
 * (e.g. model-specific parameters) are excluded — navigating to them
 * would show nothing.
 */
export function searchSettings(rawQuery: string, ctx: SettingContext): SettingSearchResult[] {
    const query = rawQuery.trim().toLowerCase();
    if (query.length < 1) return [];

    const results: SettingSearchResult[] = [];

    for (const src of declarativeSources) {
        for (const item of flattenItems(src.items, ctx)) {
            const label = getLabel(item);
            if (!label) continue;
            const help = helpText(item);
            const rank = matchRank(query, [label, englishLabel(item)], item.keywords, [help, englishHelp(item)]);
            if (rank < 0) continue;
            results.push({
                key: `${src.route}:${src.subTab ?? ''}:${item.id}`,
                label,
                location: [routeLabel(src.route), src.tabLabel?.(), src.sectionLabel?.()]
                    .filter(Boolean).join(' · '),
                help,
                route: src.route,
                subTab: src.subTab,
                itemId: item.id,
                rank,
            });
        }
    }

    for (const entry of searchManifestEntries) {
        const label = entry.label();
        const help = entry.help?.();
        // Manifest entries carry no labelKey to resolve in English — their
        // hand-written keywords already include the English terms.
        const rank = matchRank(query, [label], entry.keywords, [help]);
        if (rank < 0) continue;
        const pageLabel = routeLabel(entry.route);
        results.push({
            key: entry.id,
            label,
            // Page-name entries would read "Display · Display" — drop the
            // breadcrumb when it adds nothing.
            location: pageLabel === label ? '' : pageLabel,
            help,
            route: entry.route,
            subTab: entry.subTab,
            rank,
        });
    }

    results.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    return results.slice(0, MAX_RESULTS);
}

/** Sub-tab store per tabbed settings page. */
const submenuStores: Partial<Record<SettingsRouteValue, Writable<number>>> = {
    [SettingsRoute.Display]: DisplaySubmenuIndex,
    [SettingsRoute.ChatBot]: BotSubmenuIndex,
    [SettingsRoute.PromptPreset]: PromptPresetSubmenuIndex,
    [SettingsRoute.OtherBots]: OtherBotsSubmenuIndex,
    [SettingsRoute.InlayImageGallery]: InlayGallerySubmenuIndex,
    [SettingsRoute.ModelPreset]: ModelPresetListTabIndex,
    [SettingsRoute.System]: SystemSubmenuIndex,
    [SettingsRoute.Accessibility]: AccessibilitySubmenuIndex,
};

/**
 * Navigate to a search result: open the page, switch its sub-tab, then
 * scroll to the item anchor (if any) once it has rendered.
 */
export function navigateToSearchResult(result: SettingSearchResult) {
    openSettings(result.route);
    if (result.subTab !== undefined) {
        submenuStores[result.route]?.set(result.subTab);
    }
    if (result.itemId) {
        scrollToSettingAnchor(result.itemId);
    }
}

/**
 * Retry-scroll to `[data-setting-id]`: the target page mounts asynchronously
 * after the store updates, so poll a few frames before giving up. Falling
 * back silently is fine — page + tab navigation already happened.
 */
function scrollToSettingAnchor(itemId: string, attempt = 0) {
    if (typeof document === 'undefined') return;
    const el = document.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(itemId)}"]`);
    if (el) {
        el.scrollIntoView({ block: 'center' });
        el.animate(
            [
                { boxShadow: '0 0 0 3px var(--risu-theme-primary, #fbbf24)', offset: 0.1 },
                { boxShadow: '0 0 0 3px transparent' },
            ],
            { duration: 1600, easing: 'ease-out' },
        );
        return;
    }
    if (attempt < 40) {
        requestAnimationFrame(() => scrollToSettingAnchor(itemId, attempt + 1));
    }
}
