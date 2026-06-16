/**
 * Prompt Preset Settings Data
 *
 * Data-driven definition for the new PromptPreset menu (SettingsMenuIndex 17).
 * Four tabs: basic info / prompt / parameters / advanced settings.
 *
 * Data layer is shared with BotSettings (db.botPresets, db.mainPrompt etc.).
 * Edits in either menu reflect immediately in the other — the new menu is a
 * different view of the same active preset.
 */

import type { SettingItem } from './types';
import { allBasicParameterItems } from './botSettingsParamsData';

export const promptPresetBasicInfoItems: SettingItem[] = [
    {
        id: 'promptPreset.basicInfo',
        type: 'custom',
        componentId: 'PromptPresetBasicInfo',
        keywords: ['preset', 'name', 'icon', 'copy', 'export', 'import'],
    },
];

export const promptPresetPromptItems: SettingItem[] = [
    {
        id: 'promptPreset.editor',
        type: 'custom',
        componentId: 'PromptEditorSection',
        keywords: ['mainPrompt', 'jailbreak', 'globalNote', 'formatingOrder', 'promptPreprocess', 'promptTemplate'],
    },
];

/**
 * Parameters tab — the preset's own parameter data, shown WITHOUT the
 * model-gating conditions BotSettings uses (`ctx.modelInfo.parameters`):
 * this page edits the prompt preset standalone, independent of whichever
 * classic model happens to be selected. Items are reused from
 * botSettingsParamsData so ranges/help/bindKeys stay single-sourced.
 *
 * Scope (matches applyPromptPresetParams): the sampling set the per-chat
 * "Use Prompt Parameters" override can inject, plus maxContext/maxResponse
 * which are preset data used by the classic path. Model-specific extras
 * (seed, thinking, reasoning effort, verbosity) stay BotSettings-only —
 * they never apply through the override and depend on the active model.
 */
const PROMPT_PARAM_SOURCE_IDS = [
    'params.maxContext',
    'params.maxResponse',
    'params.temperature',
    'params.topK',
    'params.minP',
    'params.topA',
    'params.repetitionPenalty',
    'params.topP',
    'params.frequencyPenalty',
    'params.presencePenalty',
];

export const promptPresetParameterItems: SettingItem[] = allBasicParameterItems
    .filter((item) => PROMPT_PARAM_SOURCE_IDS.includes(item.id))
    .map(({ condition: _condition, ...item }) => ({
        ...item,
        id: item.id.replace('params.', 'promptPreset.params.'),
    }));

export const promptPresetAdvancedItems: SettingItem[] = [
    {
        id: 'promptPreset.advanced.template',
        type: 'accordion',
        labelKey: 'promptTemplate',
        helpKey: 'botPromptTemplate',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.template.block',
                    type: 'custom',
                    componentId: 'PromptTemplateBlock',
                },
            ],
        },
        keywords: ['template', 'prompt'],
    },
    {
        id: 'promptPreset.advanced.tools',
        type: 'accordion',
        labelKey: 'tools',
        helpKey: 'tools',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.tools.block',
                    type: 'custom',
                    componentId: 'PromptToolsBlock',
                },
            ],
        },
        keywords: ['tools', 'search', 'modelTools'],
    },
    {
        id: 'promptPreset.advanced.regex',
        type: 'accordion',
        labelKey: 'regexScript',
        helpKey: 'botRegexScript',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.regex.block',
                    type: 'custom',
                    componentId: 'PromptRegexBlock',
                },
            ],
        },
        keywords: ['regex', 'presetRegex'],
    },
    {
        id: 'promptPreset.advanced.moduleIntegration',
        type: 'accordion',
        labelKey: 'moduleIntergration',
        helpKey: 'moduleIntergration',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.moduleIntegration.value',
                    type: 'textarea',
                    bindKey: 'moduleIntergration',
                },
            ],
        },
        keywords: ['module', 'integration'],
    },
];
