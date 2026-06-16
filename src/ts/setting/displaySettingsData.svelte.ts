/**
 * Display Settings Data
 *
 * Data-driven definition for DisplaySettings page.
 */

import type { SettingItem } from './types';
import { changeFullscreen } from '../util';
import { updateAnimationSpeed } from '../gui/animation';
import { updateGuisize } from '../gui/guisize';
import { updateTextThemeAndCSS } from '../gui/colorscheme';
export const displayThemeSettingsItems: SettingItem[] = [
    {
        id: 'display.theme',
        type: 'select',
        labelKey: 'theme',
        helpKey: 'theme',
        bindKey: 'theme',
        classes: 'mt-4',
        options: {
            selectOptions: [
                { value: '', label: 'PocketRisu Standard' },
                { value: 'standardRisu', label: 'Standard Risu' },
                { value: 'waifu', label: 'Waifulike' },
                { value: 'mobilechat', label: 'Mobile Chat' },
                { value: 'cardboard', label: 'CardBoard' },
                { value: 'customHTML', label: 'Custom HTML' },
            ],
        },
        keywords: ['theme', 'gui', 'layout'],
    },
    {
        id: 'display.guiHTML',
        type: 'textarea',
        labelKey: 'chatHTML',
        helpKey: 'chatHTML',
        bindKey: 'guiHTML',
        condition: (ctx) => ctx.db.theme === 'customHTML',
        keywords: ['custom', 'html', 'chat'],
    },
    {
        id: 'display.guiHTML.warning',
        type: 'custom',
        componentId: 'CustomizationWarning',
        componentProps: { messageKey: 'customHTMLWarning' },
        condition: (ctx) => ctx.db.theme === 'customHTML',
        keywords: ['custom', 'html', 'warning'],
    },
    {
        id: 'display.nodeOnlyStandardChatWidth',
        type: 'select',
        labelKey: 'nodeOnlyStandardChatWidth',
        helpKey: 'nodeOnlyStandardChatWidth',
        bindKey: 'nodeOnlyStandardChatWidth',
        classes: 'mt-4',
        condition: (ctx) => ctx.db.theme === '',
        options: {
            selectOptions: [
                { value: 'standard', labelKey: 'chatWidthStandard' },
                { value: 'wide', labelKey: 'chatWidthWide' },
                { value: 'full', labelKey: 'chatWidthFull' },
            ],
        },
        keywords: ['chat', 'width', 'nodeonly', 'standard'],
    },
    {
        id: 'display.customCSS',
        type: 'textarea',
        labelKey: 'customCSS',
        helpKey: 'customCSS',
        bindKey: 'customCSS',
        classes: 'mt-4',
        onChange: () => updateTextThemeAndCSS(),
        keywords: ['custom', 'css'],
    },
    {
        id: 'display.customCSS.warning',
        type: 'custom',
        componentId: 'CustomizationWarning',
        componentProps: { messageKey: 'customCSSWarning' },
        keywords: ['custom', 'css', 'warning'],
    },
    {
        id: 'display.waifuWidth',
        type: 'slider',
        labelKey: 'waifuWidth',
        helpKey: 'waifuWidth',
        bindKey: 'waifuWidth',
        condition: (ctx) => ctx.db.theme === 'waifu',
        options: {
            min: 50,
            max: 200,
            customText: (value) => `${value}%`,
        },
        classes: 'mt-4',
        keywords: ['waifu', 'width'],
    },
    {
        id: 'display.waifuWidth2',
        type: 'slider',
        labelKey: 'waifuWidth2',
        helpKey: 'waifuWidth2',
        bindKey: 'waifuWidth2',
        condition: (ctx) => ctx.db.theme === 'waifu',
        options: {
            min: 20,
            max: 150,
            customText: (value) => `${value}%`,
        },
        classes: 'mt-4',
        keywords: ['waifu', 'width'],
    },
    {
        id: 'display.colorScheme',
        type: 'custom',
        componentId: 'ColorSchemeSelect',
        keywords: ['color', 'scheme', 'theme'],
    },
    {
        id: 'display.customColorScheme',
        type: 'custom',
        componentId: 'CustomColorSchemeEditor',
        condition: (ctx) => ctx.db.colorSchemeName === 'custom',
        keywords: ['custom', 'color', 'scheme'],
    },
    {
        id: 'display.textTheme',
        type: 'select',
        labelKey: 'textColor',
        helpKey: 'textColor',
        bindKey: 'textTheme',
        classes: 'mt-4',
        onChange: () => updateTextThemeAndCSS(),
        options: {
            selectOptions: [
                { value: 'standard', labelKey: 'classicRisu' },
                { value: 'highcontrast', labelKey: 'highcontrast' },
                { value: 'custom', label: 'Custom' },
            ],
        },
        keywords: ['text', 'color', 'theme'],
    },
    {
        id: 'display.customTextTheme',
        type: 'custom',
        componentId: 'CustomTextThemeEditor',
        condition: (ctx) => ctx.db.textTheme === 'custom',
        keywords: ['custom', 'text', 'color', 'theme'],
    },
    {
        id: 'display.font',
        type: 'select',
        labelKey: 'font',
        helpKey: 'font',
        bindKey: 'font',
        classes: 'mt-4',
        onChange: () => updateTextThemeAndCSS(),
        options: {
            selectOptions: [
                { value: 'default', label: 'Default' },
                { value: 'timesnewroman', label: 'Times New Roman' },
                { value: 'custom', label: 'Custom' },
            ],
        },
        keywords: ['font', 'typeface'],
    },
    {
        id: 'display.customFont',
        type: 'text',
        fallbackLabel: '',
        helpKey: 'customFont',
        bindKey: 'customFont',
        condition: (ctx) => ctx.db.font === 'custom',
        onChange: () => updateTextThemeAndCSS(),
        keywords: ['font', 'custom'],
    },
];

export const displaySizeSettingsItems: SettingItem[] = [
    {
        id: 'display.zoomsize',
        type: 'slider',
        labelKey: 'UISize',
        helpKey: 'UISize',
        bindKey: 'zoomsize',
        classes: 'mt-4',
        options: { min: 50, max: 200 },
        keywords: ['ui', 'size', 'zoom'],
    },
    {
        id: 'display.lineHeight',
        type: 'slider',
        labelKey: 'lineHeight',
        helpKey: 'lineHeight',
        bindKey: 'lineHeight',
        options: { min: 0.5, max: 3, step: 0.05, fixed: 2 },
        keywords: ['line', 'height', 'spacing'],
    },
    {
        id: 'display.iconsize',
        type: 'slider',
        labelKey: 'iconSize',
        helpKey: 'iconSize',
        bindKey: 'iconsize',
        options: { min: 50, max: 200 },
        keywords: ['icon', 'size'],
    },
    {
        id: 'display.textAreaSize',
        type: 'slider',
        labelKey: 'textAreaSize',
        helpKey: 'textAreaSize',
        bindKey: 'textAreaSize',
        onChange: () => updateGuisize(),
        options: {
            min: -5,
            max: 5,
            customText: (value) => '×' + (1 + value * 0.1).toFixed(1),
        },
        keywords: ['textarea', 'input', 'size'],
    },
    {
        id: 'display.textAreaTextSize',
        type: 'select',
        labelKey: 'textAreaTextSize',
        helpKey: 'textAreaTextSize',
        getValue: (db) => String(db.textAreaTextSize),
        setValue: (db, v) => { db.textAreaTextSize = Number(v); },
        onChange: () => updateGuisize(),
        options: {
            selectOptions: [
                { value: '0', label: '×1.0' },
                { value: '1', label: '×1.25' },
                { value: '2', label: '×1.5' },
                { value: '3', label: '×1.75' },
            ],
        },
        keywords: ['textarea', 'text', 'size'],
    },
    {
        id: 'display.sideBarSize',
        type: 'select',
        labelKey: 'sideBarSize',
        helpKey: 'sideBarSize',
        getValue: (db) => String(db.sideBarSize),
        setValue: (db, v) => { db.sideBarSize = Number(v); },
        onChange: () => updateGuisize(),
        options: {
            selectOptions: [
                { value: '0', label: '×1.0' },
                { value: '1', label: '×1.25' },
                { value: '2', label: '×1.5' },
                { value: '3', label: '×1.75' },
            ],
        },
        keywords: ['sidebar', 'size'],
    },
    {
        id: 'display.assetWidth',
        type: 'slider',
        labelKey: 'assetWidth',
        helpKey: 'assetWidth',
        bindKey: 'assetWidth',
        options: {
            min: -1,
            max: 40,
            step: 1,
            customText: (value) =>
                value === -1 ? 'Unlimited' : value === 0 ? 'Hidden' : `${value} rem`,
        },
        keywords: ['asset', 'width'],
    },
    {
        id: 'display.animationSpeed',
        type: 'slider',
        labelKey: 'animationSpeed',
        helpKey: 'animationSpeed',
        bindKey: 'animationSpeed',
        onChange: () => updateAnimationSpeed(),
        options: { min: 0, max: 1, step: 0.05, fixed: 2 },
        keywords: ['animation', 'speed'],
    },
    {
        id: 'display.memoryLimitThickness',
        type: 'slider',
        labelKey: 'memoryLimitThickness',
        helpKey: 'memoryLimitThickness',
        bindKey: 'memoryLimitThickness',
        condition: (ctx) => ctx.db.showMemoryLimit,
        options: { min: 1, max: 500, step: 1 },
        keywords: ['memory', 'limit', 'thickness'],
    },
    {
        id: 'display.settingsCloseButtonSize',
        type: 'slider',
        labelKey: 'settingsCloseButtonSize',
        helpKey: 'settingsCloseButtonSize',
        bindKey: 'settingsCloseButtonSize',
        options: { min: 16, max: 48, step: 1 },
        keywords: ['settings', 'close', 'button', 'size'],
    },
];

export const displayOtherHomeItems: SettingItem[] = [
    { id: 'display.hideRealm', type: 'check', labelKey: 'hideRealm', helpKey: 'hideRealm', bindKey: 'hideRealm', keywords: ['realm', 'hide'] },
    { id: 'display.showFolderName', type: 'check', labelKey: 'showFolderNameInIcon', helpKey: 'showFolderNameInIcon', bindKey: 'showFolderName', keywords: ['folder', 'name', 'icon'] },
    { id: 'display.roundIcons', type: 'check', labelKey: 'roundIcons', helpKey: 'roundIcons', bindKey: 'roundIcons', keywords: ['round', 'icons'] },
    { id: 'display.hideMessagePageCount', type: 'check', labelKey: 'hideMessagePageCount', helpKey: 'hideMessagePageCountDesc', bindKey: 'hideMessagePageCount', keywords: ['message', 'page', 'count', 'hide'] },
];

export const displayOtherChatItems: SettingItem[] = [
    { id: 'display.showRequestStatus', type: 'check', labelKey: 'showRequestStatus', helpKey: 'showRequestStatus', bindKey: 'showRequestStatus', keywords: ['request', 'status', 'toast', 'token', 'thinking'] },
    { id: 'display.customBackground', type: 'custom', componentId: 'CustomBackgroundToggle', keywords: ['custom', 'background'] },
    { id: 'display.hideAllImages', type: 'check', labelKey: 'hideAllImages', helpKey: 'hideAllImagesDesc', bindKey: 'hideAllImages', keywords: ['images', 'hide'] },
    { id: 'display.useAdditionalAssetsPreview', type: 'check', labelKey: 'useAdditionalAssetsPreview', helpKey: 'useAdditionalAssetsPreview', bindKey: 'useAdditionalAssetsPreview', keywords: ['additional', 'assets', 'preview'] },
    { id: 'display.showMemoryLimit', type: 'check', labelKey: 'showMemoryLimit', helpKey: 'showMemoryLimit', bindKey: 'showMemoryLimit', keywords: ['memory', 'limit'] },
    { id: 'display.showSavingIcon', type: 'check', labelKey: 'showSavingIcon', helpKey: 'showSavingIcon', bindKey: 'showSavingIcon', keywords: ['saving', 'icon'] },
];

export const displayOtherBubbleItems: SettingItem[] = [
    {
        id: 'display.textScreenColor',
        type: 'custom',
        componentId: 'NullableTextColorToggle',
        componentProps: {
            field: 'textScreenColor',
            labelKey: 'textBackgrounds',
            defaultColor: '#121212',
            helpKey: 'textScreenColor',
        },
        keywords: ['text', 'background', 'color'],
    },
    {
        id: 'display.textScreenBorder',
        type: 'custom',
        componentId: 'NullableTextColorToggle',
        componentProps: {
            field: 'textScreenBorder',
            labelKey: 'textScreenBorder',
            defaultColor: '#121212',
            helpKey: 'textScreenBorder',
        },
        keywords: ['text', 'screen', 'border', 'color'],
    },
    { id: 'display.textScreenRounded', type: 'check', labelKey: 'textScreenRound', helpKey: 'textScreenRound', bindKey: 'textScreenRounded', keywords: ['text', 'round'] },
    { id: 'display.textBorder', type: 'check', labelKey: 'textBorder', helpKey: 'textBorder', bindKey: 'textBorder', keywords: ['text', 'border'] },
];

export const displayOtherQuoteItems: SettingItem[] = [
    { id: 'display.unformatQuotes', type: 'check', labelKey: 'unformatQuotes', helpKey: 'unformatQuotes', bindKey: 'unformatQuotes', keywords: ['quotes'] },
    { id: 'display.blockquoteStyling', type: 'check', labelKey: 'blockquoteStyling', helpKey: 'blockquoteStyling', bindKey: 'blockquoteStyling', keywords: ['blockquote', 'quote'] },
    { id: 'display.customQuotes', type: 'check', labelKey: 'customQuotes', helpKey: 'customQuotes', bindKey: 'customQuotes', keywords: ['custom', 'quotes'] },
    {
        id: 'display.leadingDoubleQuote',
        type: 'text',
        labelKey: 'leadingDoubleQuote',
        helpKey: 'customQuotesDoubleLeading',
        condition: (ctx) => ctx.db.customQuotes,
        getValue: (db) => db.customQuotesData?.[0] ?? '',
        setValue: (db, value: string) => {
            db.customQuotesData ??= ['"', '"', "'", "'"];
            db.customQuotesData[0] = value;
        },
        keywords: ['quote', 'double', 'leading'],
    },
    {
        id: 'display.trailingDoubleQuote',
        type: 'text',
        labelKey: 'trailingDoubleQuote',
        helpKey: 'customQuotesDoubleTrailing',
        condition: (ctx) => ctx.db.customQuotes,
        getValue: (db) => db.customQuotesData?.[1] ?? '',
        setValue: (db, value: string) => {
            db.customQuotesData ??= ['"', '"', "'", "'"];
            db.customQuotesData[1] = value;
        },
        keywords: ['quote', 'double', 'trailing'],
    },
    {
        id: 'display.leadingSingleQuote',
        type: 'text',
        labelKey: 'leadingSingleQuote',
        helpKey: 'customQuotesSingleLeading',
        condition: (ctx) => ctx.db.customQuotes,
        getValue: (db) => db.customQuotesData?.[2] ?? '',
        setValue: (db, value: string) => {
            db.customQuotesData ??= ['"', '"', "'", "'"];
            db.customQuotesData[2] = value;
        },
        keywords: ['quote', 'single', 'leading'],
    },
    {
        id: 'display.trailingSingleQuote',
        type: 'text',
        labelKey: 'trailingSingleQuote',
        helpKey: 'customQuotesSingleTrailing',
        condition: (ctx) => ctx.db.customQuotes,
        getValue: (db) => db.customQuotesData?.[3] ?? '',
        setValue: (db, value: string) => {
            db.customQuotesData ??= ['"', '"', "'", "'"];
            db.customQuotesData[3] = value;
        },
        keywords: ['quote', 'single', 'trailing'],
    },
];

export const displayOtherAdvancedItems: SettingItem[] = [
    { id: 'display.hideApiKey', type: 'check', labelKey: 'hideApiKeys', helpKey: 'hideApiKeys', bindKey: 'hideApiKey', keywords: ['api', 'key', 'hide'] },
    { id: 'display.showPromptComparison', type: 'check', labelKey: 'showPromptComparison', helpKey: 'showPromptComparison', bindKey: 'showPromptComparison', keywords: ['prompt', 'comparison'] },
    {
        id: 'display.fullScreen',
        type: 'check',
        labelKey: 'fullscreen',
        helpKey: 'fullscreen',
        bindKey: 'fullScreen',
        onChange: () => changeFullscreen(),
        keywords: ['fullscreen'],
    },
    { id: 'display.menuSideBar', type: 'check', labelKey: 'menuSideBar', helpKey: 'menuSideBar', bindKey: 'menuSideBar', keywords: ['menu', 'sidebar'] },
    { id: 'display.betaMobileGUI', type: 'check', labelKey: 'betaMobileGUI', helpKey: 'betaMobileGUI', bindKey: 'betaMobileGUI', keywords: ['beta', 'mobile', 'gui'] },
    {
        id: 'display.useChatSticker',
        type: 'check',
        labelKey: 'useChatSticker',
        helpKey: 'unrecommendedChatSticker',
        helpUnrecommended: true,
        bindKey: 'useChatSticker',
        condition: (ctx) => ctx.db.showUnrecommended,
        keywords: ['chat', 'sticker'],
    },
];

export const displaySettingsItems: SettingItem[] = [
    ...displayThemeSettingsItems,
    ...displaySizeSettingsItems,
    ...displayOtherHomeItems,
    ...displayOtherChatItems,
    ...displayOtherBubbleItems,
    ...displayOtherQuoteItems,
    ...displayOtherAdvancedItems,
];
