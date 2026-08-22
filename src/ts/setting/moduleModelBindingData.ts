// Data-driven items for the Model Preset page's "Module Binding" tab.
// Rendered with SettingRenderer layout="row" (see ui.md "Setting 행 레이아웃"),
// matching the sibling "Settings" tab on the same page.

import type { SettingItem } from './types'

export const moduleModelBindingItems: SettingItem[] = [
    {
        // Master switch. Off by default — while off the resolution chokepoint
        // skips the override branch entirely, so behaviour matches the classic
        // main/sub model settings exactly.
        id: 'modelPreset.moduleModelBindingsEnabled',
        type: 'check',
        labelKey: 'moduleModelBindingEnable',
        helpKey: 'moduleModelBindingEnable',
        bindKey: 'moduleModelBindingsEnabled',
        keywords: ['module', 'per-module', 'module binding', 'lua', 'trigger', 'script', '모듈', '모듈별', '모듈 분리 바인딩', '바인딩', '루아', '트리거', '스크립트'],
    },
    {
        // The per-module rows are dynamic (one per installed module that can
        // call a model), so they cannot be declared as static items.
        id: 'modelPreset.moduleModelBindingList',
        type: 'custom',
        componentId: 'ModuleModelBindingList',
    },
]
