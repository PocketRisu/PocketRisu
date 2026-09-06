<script lang="ts">
    import SettingRenderer from "../SettingRenderer.svelte";
    import {
        accessibilityEditingItems,
        accessibilityScrollItems,
        accessibilitySidebarItems,
        accessibilityOtherItems,
        accessibilityCharacterItems,
    } from "src/ts/setting/accessibilitySettingsData";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import { AccessibilitySubmenuIndex } from "src/ts/stores.svelte";
</script>

<SettingPage title={language.accessibility}>
<SettingTabs
    tabs={[
        { label: language.accTabEditing, value: 0 },
        { label: language.accTabScroll, value: 1 },
        { label: language.accTabSidebar, value: 2 },
        { label: language.character, value: 4 },
        { label: language.others, value: 3 },
    ]}
    bind:selected={$AccessibilitySubmenuIndex}
/>

{#if $AccessibilitySubmenuIndex === 0}
    <SettingRenderer items={accessibilityEditingItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 1}
    <SettingRenderer items={accessibilityScrollItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 2}
    <SettingRenderer items={accessibilitySidebarItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 3}
    <SettingRenderer items={accessibilityOtherItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 4}
    <SettingRenderer items={accessibilityCharacterItems} layout="row" />
{/if}
</SettingPage>
