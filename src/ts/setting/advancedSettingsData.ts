
import type { SettingItem } from './types';
import { loadPlugins } from '../plugins/plugins.svelte';
export const advancedSettingsItems: SettingItem[] = [
    { type: 'header', id: 'adv.warn', labelKey: 'advancedSettingsWarn', options: { level: 'warning' } },

    // LoreBook Settings
    {
        id: 'adv.lbDepth', type: 'number', labelKey: 'loreBookDepth', bindKey: 'loreBookDepth',
        helpKey: 'loreBookDepth',
        options: { min: 0, max: 20 },
        classes: 'mt-4'
    },
    {
        id: 'adv.lbToken', type: 'number', labelKey: 'loreBookToken', bindKey: 'loreBookToken',
        helpKey: 'loreBookToken',
        options: { min: 0, max: 4096 }
    },
    {
        id: 'adv.autoContinueMin', type: 'number', labelKey: 'autoContinueMinTokens', bindKey: 'autoContinueMinTokens',
        helpKey: 'autoContinueMinTokens',
        options: { min: 0 }
    },

    // Prompts
    {
        id: 'adv.addPrompt', type: 'text', labelKey: 'additionalPrompt', bindKey: 'additionalPrompt',
        helpKey: 'additionalPrompt'
    },
    {
        id: 'adv.descPrefix', type: 'text', labelKey: 'descriptionPrefix', bindKey: 'descriptionPrefix',
        helpKey: 'descriptionPrefix'
    },
    {
        id: 'adv.emoPrompt', type: 'text', labelKey: 'emotionPrompt', bindKey: 'emotionPrompt2',
        helpKey: 'emotionPrompt', options: { placeholder: 'Leave it blank to use default' }
    },
    {
        id: 'adv.presetChain', type: 'text', labelKey: 'presetChain', bindKey: 'presetChain',
        helpKey: 'presetChain', options: { placeholder: 'Leave it blank to not use' }
    },

    // Request Settings
    {
        id: 'adv.retries', type: 'number', labelKey: 'requestretrys', bindKey: 'requestRetrys',
        helpKey: 'requestretrys', options: { min: 0, max: 20 }
    },
    {
        id: 'adv.genTime', type: 'number', labelKey: 'genTimes', bindKey: 'genTime',
        helpKey: 'genTimes', options: { min: 0, max: 4096 }
    },
    {
        id: 'adv.assetAlloc', type: 'number', labelKey: 'assetMaxDifference', bindKey: 'assetMaxDifference',
        helpKey: 'assetMaxDifference'
    },

    // Vision Quality
    {
        id: 'adv.visionQual', type: 'select', fallbackLabel: 'Vision Quality', bindKey: 'gptVisionQuality',
        helpKey: 'gptVisionQuality',
        options: {
            selectOptions: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' }
            ]
        }
    },

    // Keep Session alive
    {
        id: 'adv.keepSessionAlive', type: 'select', labelKey: 'keepSessionAlive', bindKey: 'keepSessionAlive', helpKey: 'keepSessionAlive',
        options: {
            selectOptions: [
                { value: 'off', label: 'Off' },
                { value: 'sound', label: 'Via Sound' },
            ]
        }
    },
    

    // Height Mode
    {
        id: 'adv.heightMode', type: 'select', labelKey: 'heightMode', bindKey: 'heightMode',
        helpKey: 'heightMode',
        options: {
            selectOptions: [
                { value: 'normal', label: 'Normal' },
                { value: 'percent', label: 'Percent' },
                { value: 'vh', label: 'VH' },
                { value: 'dvh', label: 'DVH' },
                { value: 'svh', label: 'SVH' },
                { value: 'lvh', label: 'LVH' }
            ]
        }
    },

    // Request Location (Non-Node/Tauri)
    {
        id: 'adv.reqLoc', type: 'segmented', labelKey: 'requestLocation', bindKey: 'requestLocation',
        condition: () => false,
        options: {
            segmentOptions: [
                { value: '', label: 'Default' },
                { value: 'eu', label: 'EU (GDPR)' },
                { value: 'fedramp', label: 'US (FedRAMP)' }
            ]
        }
    },

    // Toggles
    { id: 'adv.sayNothing', type: 'check', labelKey: 'sayNothing', bindKey: 'useSayNothing', helpKey: 'sayNothing', classes: 'mt-4' },
    { id: 'adv.showUnrec', type: 'check', labelKey: 'showUnrecommended', bindKey: 'showUnrecommended', helpKey: 'showUnrecommended', classes: 'mt-4' },
    { id: 'adv.imgComp', type: 'check', labelKey: 'imageCompression', bindKey: 'imageCompression', helpKey: 'imageCompression', classes: 'mt-4' },
    { id: 'adv.useExp', type: 'check', labelKey: 'useExperimental', bindKey: 'useExperimental', helpKey: 'useExperimental', classes: 'mt-4' },
    { id: 'adv.forceProxy', type: 'check', labelKey: 'forceProxyAsOpenAI', bindKey: 'forceProxyAsOpenAI', helpKey: 'forceProxyAsOpenAI', classes: 'mt-4' },
    { id: 'adv.legacyMedia', type: 'check', labelKey: 'legacyMediaFindings', bindKey: 'legacyMediaFindings', helpKey: 'legacyMediaFindings', classes: 'mt-4' },
    { id: 'adv.autoFill', type: 'check', labelKey: 'autoFillRequestURL', bindKey: 'autofillRequestUrl', helpKey: 'autoFillRequestURL', classes: 'mt-4' },
    { id: 'adv.autoCont', type: 'check', labelKey: 'autoContinueChat', bindKey: 'autoContinueChat', helpKey: 'autoContinueChat', classes: 'mt-4' },
    { id: 'adv.remIncomp', type: 'check', labelKey: 'removeIncompleteResponse', bindKey: 'removeIncompleteResponse', helpKey: 'removeIncompleteResponse', classes: 'mt-4' },
    { id: 'adv.newOai', type: 'check', labelKey: 'newOAIHandle', bindKey: 'newOAIHandle', helpKey: 'newOAIHandle', classes: 'mt-4' },
    { id: 'adv.noWaitTrans', type: 'check', labelKey: 'noWaitForTranslate', bindKey: 'noWaitForTranslate', helpKey: 'noWaitForTranslate', classes: 'mt-4' },
    { id: 'adv.newImgBeta', type: 'check', labelKey: 'newImageHandlingBeta', bindKey: 'newImageHandlingBeta', helpKey: 'newImageHandlingBeta', classes: 'mt-4' },
    { id: 'adv.allowExt', type: 'check', fallbackLabel: 'Allow all in file select', bindKey: 'allowAllExtentionFiles', helpKey: 'allowAllExtentionFiles', classes: 'mt-4' },
    { id: 'adv.dynamicModelRegistry', type: 'check', labelKey: 'dynamicModelRegistry', bindKey: 'dynamicModelRegistry', helpKey: 'dynamicModelRegistry', classes: 'mt-4' },
    { id: 'adv.disableSeperateParameterChangeOnPresetChange', type: 'check', labelKey: 'disableSeperateParameterChangeOnPresetChange', bindKey: 'disableSeperateParameterChangeOnPresetChange', helpKey: 'disableSeperateParameterChangeOnPresetChange', classes: 'mt-4' },
    {
        id: 'adv.allowV2Plugin', type: 'check', labelKey: 'allowV2Plugin', bindKey: 'allowV2Plugin',
        helpKey: 'allowV2Plugin', helpUnrecommended: true, classes: 'mt-4',
        onChange: () => {
            void loadPlugins();
        }
    },
    // Experimental Section (visible when useExperimental is true)
    {
        id: 'adv.exp.googleToken', type: 'check', labelKey: 'googleCloudTokenization', bindKey: 'googleClaudeTokenizing',
        condition: (ctx) => ctx.db.useExperimental, helpKey: 'googleCloudTokenization', showExperimental: true, classes: 'mt-4'
    },
    {
        id: 'adv.exp.cachePoint', type: 'check', labelKey: 'automaticCachePoint', bindKey: 'automaticCachePoint',
        condition: (ctx) => ctx.db.useExperimental, helpKey: 'automaticCachePoint', showExperimental: true, classes: 'mt-4'
    },
    {
        id: 'adv.localNetworkMode', type: 'check', fallbackLabel: 'Local Network Mode (Experimental)',
        bindKey: 'localNetworkMode', helpKey: 'localNetworkModeDesc',
        condition: (ctx) => ctx.db.useExperimental, showExperimental: true, classes: 'mt-4'
    },
    {
        id: 'adv.localNetworkTimeout', type: 'number', fallbackLabel: 'Local Network Timeout (sec)',
        bindKey: 'localNetworkTimeoutSec',
        condition: (ctx) => ctx.db.useExperimental && ctx.db.localNetworkMode,
        helpKey: 'localNetworkTimeoutSec',
        classes: 'block mb-1', containerClasses: 'pl-7',
        options: { min: 30, max: 3600, inputClassName: 'w-full', marginBottom: false }
    },

    // Unrecommended Section
    {
        id: 'adv.cot', type: 'check', labelKey: 'cot', bindKey: 'chainOfThought',
        condition: (ctx) => ctx.db.showUnrecommended, helpKey: 'customChainOfThought', helpUnrecommended: true, classes: 'mt-4'
    },

    // More Toggles
    { id: 'adv.devTools', type: 'check', labelKey: 'enableDevTools', bindKey: 'enableDevTools', helpKey: 'enableDevTools', classes: 'mt-4' },
    { id: 'adv.scrollToActive', type: 'check', labelKey: 'enableScrollToActiveChar', bindKey: 'enableScrollToActiveChar', helpKey: 'enableScrollToActiveChar', classes: 'mt-4' },

    // Node/Tauri Specific
    {
        id: 'adv.promptInfo', type: 'check', labelKey: 'promptInfoInsideChat', bindKey: 'promptInfoInsideChat',
        helpKey: 'promptInfoInsideChatDesc', classes: 'mt-4'
    },
    {
        id: 'adv.promptTextInfo', type: 'check', labelKey: 'promptTextInfoInsideChat', bindKey: 'promptTextInfoInsideChat',
        condition: (ctx) => ctx.db.promptInfoInsideChat, helpKey: 'promptTextInfoInsideChat', classes: 'mt-4'
    },
    // Server-side requests toggle lives on the Model Preset page's Settings
    // tab (modelPresetOptionsData.ts) — it only affects the preset path, and
    // advanced settings buried it beyond discovery.
    // Remote saving removed — incompatible with NodeOnly server

    // Dynamic Assets & Others
    { id: 'adv.dynAssets', type: 'check', labelKey: 'dynamicAssets', bindKey: 'dynamicAssets', helpKey: 'dynamicAssets', classes: 'mt-4' },
    { id: 'adv.realmOpen', type: 'check', labelKey: 'realmDirectOpen', bindKey: 'realmDirectOpen', helpKey: 'realmDirectOpen', classes: 'mt-4' },
    { id: 'adv.cssErr', type: 'check', labelKey: 'returnCSSError', bindKey: 'returnCSSError', helpKey: 'returnCSSError', classes: 'mt-4' },
    { id: 'adv.antiOverload', type: 'check', labelKey: 'antiServerOverload', bindKey: 'antiServerOverloads', helpKey: 'antiServerOverload', classes: 'mt-4' },
    { id: 'adv.claudeCache', type: 'check', labelKey: 'claude1HourCaching', bindKey: 'claude1HourCaching', helpKey: 'claude1HourCaching', classes: 'mt-4' },
    { id: 'adv.claudeBatch', type: 'check', labelKey: 'claudeBatching', bindKey: 'claudeBatching', helpKey: 'claudeBatching', showExperimental: true, classes: 'mt-4' },
    { id: 'adv.personaNote', type: 'check', labelKey: 'personaNote', bindKey: 'personaNote', helpKey: 'personaNote', showExperimental: true, classes: 'mt-4' },
    { id: 'adv.toolUsage', type: 'check', labelKey: 'rememberToolUsage', bindKey: 'rememberToolUsage', helpKey: 'rememberToolUsage', classes: 'mt-4' },
    { id: 'adv.bookmark', type: 'check', labelKey: 'bookmark', bindKey: 'enableBookmark', helpKey: 'bookmark', classes: 'mt-4' },
    { id: 'adv.simpleTool', type: 'check', labelKey: 'simplifiedToolUse', bindKey: 'simplifiedToolUse', helpKey: 'simplifiedToolUse', classes: 'mt-4' },
    { id: 'adv.tokCache', type: 'check', labelKey: 'useTokenizerCaching', bindKey: 'useTokenizerCaching', helpKey: 'useTokenizerCaching', classes: 'mt-4' },
    { id: 'adv.devMode', type: 'check', labelKey: 'pluginDevelopMode', bindKey: 'pluginDevelopMode', helpKey: 'pluginDevelopMode', classes: 'mt-4' },

    // More Experimental (Condition: useExperimental)
    {
        id: 'adv.exp.googleTrans', type: 'check', fallbackLabel: 'New Google Translate Experimental', bindKey: 'useExperimentalGoogleTranslator',
        condition: (ctx) => ctx.db.useExperimental, helpKey: 'unrecommendedNewGoogleTrans', helpUnrecommended: true, classes: 'mt-4'
    },
    {
        id: 'adv.exp.claudeRet', type: 'check', labelKey: 'claudeCachingRetrival', bindKey: 'claudeRetrivalCaching',
        condition: (ctx) => ctx.db.useExperimental, helpKey: 'unrecommendedClaudeCachingRetrival', helpUnrecommended: true, classes: 'mt-4'
    },

    // Sync (Condition: db.account.useSync)
    {
        id: 'adv.sync.realm', type: 'check', fallbackLabel: 'Lightning Realm Import', bindKey: 'lightningRealmImport',
        condition: (ctx) => !!ctx.db.account?.useSync, helpKey: 'lightningRealmImport', showExperimental: true, classes: 'mt-4'
    },

    // Dynamic Assets Edit (Condition: dynamicAssets)
    {
        id: 'adv.dynAssetsEdit', type: 'check', labelKey: 'dynamicAssetsEditDisplay', bindKey: 'dynamicAssetsEditDisplay',
        condition: (ctx) => ctx.db.dynamicAssets, helpKey: 'dynamicAssetsEditDisplay', classes: 'mt-4'
    },

    // Unrecommended Extra (Condition: showUnrecommended)
    {
        id: 'adv.plainFetch', type: 'check', labelKey: 'forcePlainFetch', bindKey: 'usePlainFetch',
        condition: (ctx) => ctx.db.showUnrecommended, helpKey: 'forcePlainFetch', helpUnrecommended: true, classes: 'mt-4'
    },
    {
        id: 'adv.depTrig', type: 'check', labelKey: 'showDeprecatedTriggerV1', bindKey: 'showDeprecatedTriggerV1',
        condition: (ctx) => ctx.db.showUnrecommended, helpKey: 'unrecommendedTriggerV1', helpUnrecommended: true, classes: 'mt-4'
    },

    // Custom Components
    { type: 'custom', id: 'adv.banChar', componentId: 'BanCharacterSetSettings' },
    { type: 'custom', id: 'adv.export', componentId: 'SettingsExportButtons' },
];
