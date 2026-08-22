<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { DBState, openThemePresetList, DisplaySubmenuIndex } from "src/ts/stores.svelte";
    import {
        displayOtherHomeItems,
        displayOtherChatItems,
        displayOtherBubbleItems,
        displayOtherQuoteItems,
        displayOtherAdvancedItems,
        displaySizeSettingsItems,
        displayThemeSettingsItems,
    } from "src/ts/setting/displaySettingsData.svelte";

</script>

<SettingPage title={language.display}>
<PresetHeader
    label={language.currentThemePreset}
    activeName={DBState.db.themePresets?.[DBState.db.themePresetsId]?.name ?? 'Default'}
    onManage={() => openThemePresetList.set(true)}
/>
<SettingTabs
    tabs={[
        { label: language.theme, value: 0 },
        { label: language.sizeAndSpeed, value: 1 },
        { label: language.others, value: 2 },
    ]}
    bind:selected={$DisplaySubmenuIndex}
/>

{#if $DisplaySubmenuIndex === 0}
    <SettingRenderer items={displayThemeSettingsItems} layout="row" />
{:else if $DisplaySubmenuIndex === 1}
    <SettingRenderer items={displaySizeSettingsItems} layout="row" />
{:else if $DisplaySubmenuIndex === 2}
    <h3 class="text-base font-bold mt-2 mb-1">{language.sectionHomeList}</h3>
    <SettingRenderer items={displayOtherHomeItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.sectionChatView}</h3>
    <SettingRenderer items={displayOtherChatItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.sectionBubble}</h3>
    <SettingRenderer items={displayOtherBubbleItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.sectionQuotes}</h3>
    <SettingRenderer items={displayOtherQuoteItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.sectionAdvanced}</h3>
    <SettingRenderer items={displayOtherAdvancedItems} layout="row" />
{/if}
</SettingPage>
