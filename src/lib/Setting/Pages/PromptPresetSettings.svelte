<script lang="ts">
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { InfoIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState, openPresetList } from "src/ts/stores.svelte";
    import {
        promptPresetBasicInfoItems,
        promptPresetPromptItems,
        promptPresetParameterItems,
        promptPresetAdvancedItems,
    } from "src/ts/setting/promptPresetSettingsData.svelte";

    let submenu = $state(0);
</script>

<SettingPage title={language.promptPresetMenu}>
    <PresetHeader
        label={language.currentPromptPreset}
        activeName={DBState.db.botPresets?.[DBState.db.botPresetsId]?.name ?? '—'}
        onManage={() => openPresetList.set(true)}
    />
    <SettingTabs
        tabs={[
            { label: language.basicInfo, value: 0 },
            { label: language.prompt, value: 1 },
            { label: language.parameters, value: 2 },
            { label: language.advancedSettings, value: 3 },
        ]}
        bind:selected={submenu}
    />

    {#if submenu === 0}
        <SettingRenderer items={promptPresetBasicInfoItems} />
    {:else if submenu === 1}
        <SettingRenderer items={promptPresetPromptItems} />
    {:else if submenu === 2}
        <ShAlert className="mt-4 mb-2">
            {#snippet icon()}<InfoIcon />{/snippet}
            {language.promptPresetParamScopeDesc}
        </ShAlert>
        <SettingRenderer items={promptPresetParameterItems} layout="block" />
    {:else if submenu === 3}
        <SettingRenderer items={promptPresetAdvancedItems} />
    {/if}
</SettingPage>
