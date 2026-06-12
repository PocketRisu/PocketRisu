/**
 * Accessibility Settings Data
 * 
 * Data-driven definition of all settings in AccessibilitySettings page.
 */

import type { SettingItem } from './types';
import { getCurrentChat, getDatabase, loadTogglesFromChat } from '../storage/database.svelte';

export const accessibilitySettingsItems: SettingItem[] = [
    // Checkboxes
    {
        id: 'acc.confirmReroll',
        type: 'check',
        labelKey: 'confirmReroll',
        bindKey: 'confirmReroll',
        helpKey: 'confirmReroll',
        keywords: ['reroll', 'regenerate', 'confirm', 'message']
    },
    {
        id: 'acc.sendKeyPC',
        type: 'radio',
        labelKey: 'sendKeyPC',
        bindKey: 'sendKeyPC',
        helpKey: 'sendKeyPC',
        options: {
            selectOptions: [
                { value: 'enter', labelKey: 'sendKeyEnter' },
                { value: 'ctrl-enter', labelKey: 'sendKeyCtrlEnter' },
                { value: 'shift-enter', labelKey: 'sendKeyShiftEnter' },
                { value: 'button', labelKey: 'sendKeyButton' },
            ],
        },
        keywords: ['send', 'enter', 'keyboard', 'submit', 'pc', 'desktop']
    },
    {
        id: 'acc.sendKeyMobile',
        type: 'radio',
        labelKey: 'sendKeyMobile',
        bindKey: 'sendKeyMobile',
        helpKey: 'sendKeyMobile',
        options: {
            selectOptions: [
                { value: 'button', labelKey: 'sendKeyButton' },
                { value: 'enter', labelKey: 'sendKeyEnter' },
            ],
        },
        keywords: ['send', 'enter', 'keyboard', 'submit', 'mobile']
    },
    {
        id: 'acc.fixedChatTextarea',
        type: 'check',
        labelKey: 'fixedChatTextarea',
        bindKey: 'fixedChatTextarea',
        helpKey: 'fixedChatTextarea',
        keywords: ['fixed', 'chat', 'textarea', 'input']
    },
    {
        id: 'acc.clickToEdit',
        type: 'check',
        labelKey: 'clickToEdit',
        bindKey: 'clickToEdit',
        helpKey: 'clickToEdit',
        keywords: ['click', 'edit', 'message']
    },
    {
        id: 'acc.enableBlockPartialEdit',
        type: 'check',
        labelKey: 'enableBlockPartialEdit',
        bindKey: 'enableBlockPartialEdit',
        helpKey: 'enableBlockPartialEdit',
        keywords: ['partial', 'edit', 'block', 'hover']
    },
    {
        id: 'acc.longPressToPopupEditor',
        type: 'check',
        labelKey: 'longPressToPopupEditor',
        bindKey: 'longPressToPopupEditor',
        helpKey: 'longPressToPopupEditor',
        keywords: ['long', 'press', 'popup', 'editor']
    },
    {
        id: 'acc.enableDragPartialEdit',
        type: 'check',
        labelKey: 'enableDragPartialEdit',
        bindKey: 'enableDragPartialEdit',
        helpKey: 'enableDragPartialEdit',
        keywords: ['partial', 'edit', 'drag', 'selection']
    },
    {
        id: 'acc.botSettingAtStart',
        type: 'check',
        labelKey: 'botSettingAtStart',
        bindKey: 'botSettingAtStart',
        helpKey: 'botSettingAtStart',
        keywords: ['bot', 'setting', 'start', 'open']
    },
    {
        id: 'acc.showMenuChatList',
        type: 'check',
        labelKey: 'showMenuChatList',
        bindKey: 'showMenuChatList',
        helpKey: 'showMenuChatList',
        keywords: ['menu', 'chat', 'list', 'show']
    },
    {
        id: 'acc.showMenuHypaMemoryModal',
        type: 'check',
        labelKey: 'showMenuHypaMemoryModal',
        bindKey: 'showMenuHypaMemoryModal',
        helpKey: 'showMenuHypaMemoryModal',
        keywords: ['menu', 'hypa', 'memory', 'modal']
    },
    {
        id: 'acc.goCharacterOnImport',
        type: 'check',
        labelKey: 'goCharacterOnImport',
        bindKey: 'goCharacterOnImport',
        helpKey: 'goCharacterOnImport',
        keywords: ['character', 'import', 'navigate']
    },
    {
        id: 'acc.sideMenuRerollButton',
        type: 'check',
        labelKey: 'sideMenuRerollButton',
        bindKey: 'sideMenuRerollButton',
        helpKey: 'sideMenuRerollButton',
        keywords: ['side', 'menu', 'reroll', 'button']
    },
    {
        id: 'acc.localActivationInGlobalLorebook',
        type: 'check',
        labelKey: 'localActivationInGlobalLorebook',
        bindKey: 'localActivationInGlobalLorebook',
        helpKey: 'localActivationInGlobalLorebook',
        keywords: ['local', 'activation', 'global', 'lorebook']
    },
    {
        id: 'acc.requestInfoInsideChat',
        type: 'check',
        labelKey: 'requestInfoInsideChat',
        bindKey: 'requestInfoInsideChat',
        helpKey: 'requestInfoInsideChat',
        keywords: ['request', 'info', 'chat']
    },
    {
        id: 'acc.inlayErrorResponse',
        type: 'check',
        labelKey: 'inlayErrorResponse',
        bindKey: 'inlayErrorResponse',
        helpKey: 'inlayErrorResponse',
        keywords: ['inlay', 'error', 'response']
    },
    {
        id: 'acc.bulkEnabling',
        type: 'check',
        labelKey: 'bulkEnabling',
        bindKey: 'bulkEnabling',
        helpKey: 'bulkEnabling',
        keywords: ['bulk', 'enable', 'multiple']
    },
    {
        id: 'acc.showTranslationLoading',
        type: 'check',
        labelKey: 'showTranslationLoading',
        bindKey: 'showTranslationLoading',
        helpKey: 'showTranslationLoading',
        keywords: ['translation', 'loading', 'indicator']
    },
    {
        id: 'acc.autoScrollToNewMessage',
        type: 'check',
        labelKey: 'autoScrollToNewMessage',
        bindKey: 'autoScrollToNewMessage',
        helpKey: 'autoScrollToNewMessage',
        keywords: ['auto', 'scroll', 'new', 'message']
    },
    {
        id: 'acc.alwaysScrollToNewMessage',
        type: 'check',
        labelKey: 'alwaysScrollToNewMessage',
        bindKey: 'alwaysScrollToNewMessage',
        helpKey: 'alwaysScrollToNewMessage',
        condition: (ctx) => ctx.db.autoScrollToNewMessage,
        keywords: ['always', 'scroll', 'new', 'message']
    },
    {
        id: 'acc.newMessageButtonStyle',
        type: 'select',
        labelKey: 'newMessageButtonStyle',
        bindKey: 'newMessageButtonStyle',
        helpKey: 'newMessageButtonStyle',
        condition: (ctx) => ctx.db.autoScrollToNewMessage && !ctx.db.alwaysScrollToNewMessage,
        options: {
            selectOptions: [
                { value: 'bottom-center', labelKey: 'newMessageButtonBottomCenter' },
                { value: 'bottom-right', labelKey: 'newMessageButtonBottomRight' },
                { value: 'bottom-left', labelKey: 'newMessageButtonBottomLeft' },
                { value: 'floating-circle', labelKey: 'newMessageButtonFloatingCircle' },
                { value: 'right-center', labelKey: 'newMessageButtonRightCenter' },
                { value: 'top-bar', labelKey: 'newMessageButtonTopBar' }
            ]
        }
    },
    {
        id: 'acc.createFolderOnBranch',
        type: 'check',
        labelKey: 'createFolderOnBranch',
        bindKey: 'createFolderOnBranch',
        helpKey: 'createFolderOnBranch',
        keywords: ['create', 'folder', 'branch'],
    },
    {
        id: 'acc.hamburgerButtonBottom',
        type: 'check',
        labelKey: 'hamburgerButtonBottom',
        bindKey: 'hamburgerButtonBottom',
        helpKey: 'hamburgerButtonBottom',
        keywords: ['hamburger', 'button', 'bottom', 'menu', 'sidebar', 'accessibility'],
    },
    {
        id: 'acc.hideLeftBarCollapseButton',
        type: 'check',
        labelKey: 'hideLeftBarCollapseButton',
        bindKey: 'hideLeftBarCollapseButton',
        helpKey: 'hideLeftBarCollapseButton',
        keywords: ['left', 'bar', 'collapse', 'toggle', 'mobile', 'sidebar', 'hide'],
    },
    {
        id: 'acc.nodeOnlyScrollButtonType',
        type: 'select',
        labelKey: 'nodeOnlyScrollButtonType',
        bindKey: 'nodeOnlyScrollButtonType',
        helpKey: 'nodeOnlyScrollButtonType',
        options: {
            selectOptions: [
                { value: 'four', labelKey: 'scrollButtonTypeFour' },
                { value: 'two', labelKey: 'scrollButtonTypeTwo' },
                { value: 'off', labelKey: 'scrollButtonTypeOff' },
            ],
        },
        keywords: ['scroll', 'button', 'navigate', 'message'],
    },
    {
        id: 'acc.modelModeLock',
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
        id: 'acc.newChatModelMode',
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
        id: 'acc.showModelInSidebar',
        type: 'check',
        labelKey: 'showModelInSidebar',
        bindKey: 'showModelInSidebar',
        helpKey: 'showModelInSidebar',
        keywords: ['sidebar', 'model', 'show', 'select'],
    },
    {
        id: 'acc.showPresetInSidebar',
        type: 'check',
        labelKey: 'showPresetInSidebar',
        bindKey: 'showPresetInSidebar',
        helpKey: 'showPresetInSidebar',
        keywords: ['sidebar', 'preset', 'show', 'select'],
    },
    {
        id: 'acc.showPersonaInSidebar',
        type: 'check',
        labelKey: 'showPersonaInSidebar',
        bindKey: 'showPersonaInSidebar',
        helpKey: 'showPersonaInSidebar',
        keywords: ['sidebar', 'persona', 'binding', 'show'],
    },
    {
        id: 'acc.disableMobileDragDrop',
        type: 'check',
        labelKey: 'disableMobileDragDrop',
        bindKey: 'disableMobileDragDrop',
        helpKey: 'disableMobileDragDrop',
        keywords: ['mobile', 'drag', 'drop', 'character', 'disable'],
    },
    {
        id: 'acc.disableToggleBinding',
        type: 'check',
        labelKey: 'disableToggleBinding',
        bindKey: 'disableToggleBinding',
        helpKey: 'disableToggleBinding',
        keywords: ['toggle', 'binding', 'chat', 'disable'],
        onChange: () => {
            if (!getDatabase().disableToggleBinding) {
                const chat = getCurrentChat();
                if (chat) loadTogglesFromChat(chat);
            }
        }
    }
];

// Tab groupings (the flat array above stays the source of truth + search index).
const pick = (ids: string[]): SettingItem[] =>
    ids
        .map((id) => accessibilitySettingsItems.find((i) => i.id === id))
        .filter((i): i is SettingItem => !!i);

export const accessibilityEditingItems = pick([
    'acc.confirmReroll',
    'acc.sendKeyPC',
    'acc.sendKeyMobile',
    'acc.fixedChatTextarea',
    'acc.clickToEdit',
    'acc.enableBlockPartialEdit',
    'acc.enableDragPartialEdit',
    'acc.longPressToPopupEditor',
]);

export const accessibilityScrollItems = pick([
    'acc.autoScrollToNewMessage',
    'acc.alwaysScrollToNewMessage',
    'acc.newMessageButtonStyle',
    'acc.nodeOnlyScrollButtonType',
]);

export const accessibilitySidebarItems = pick([
    'acc.modelModeLock',
    'acc.newChatModelMode',
    'acc.showMenuChatList',
    'acc.showMenuHypaMemoryModal',
    'acc.sideMenuRerollButton',
    'acc.hamburgerButtonBottom',
    'acc.hideLeftBarCollapseButton',
    'acc.showModelInSidebar',
    'acc.showPresetInSidebar',
    'acc.showPersonaInSidebar',
]);

export const accessibilityOtherItems = pick([
    'acc.botSettingAtStart',
    'acc.goCharacterOnImport',
    'acc.createFolderOnBranch',
    'acc.localActivationInGlobalLorebook',
    'acc.requestInfoInsideChat',
    'acc.inlayErrorResponse',
    'acc.bulkEnabling',
    'acc.showTranslationLoading',
    'acc.disableMobileDragDrop',
    'acc.disableToggleBinding',
]);
