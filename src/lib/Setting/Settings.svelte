<script lang="ts">
    import { AccessibilityIcon, ActivityIcon, PackageIcon, BotIcon, CodeIcon, CogIcon, ContactIcon, FlaskConicalIcon, ImageIcon, LanguagesIcon, MonitorIcon, MonitorSmartphoneIcon, Sailboat, ScrollTextIcon, SearchIcon, UserIcon, CircleXIcon, KeyboardIcon, TruckIcon, FileBoxIcon, Volume2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import NotificationSoundSettings from "./Pages/NotificationSoundSettings.svelte";
    import MigrationSettings from "./Pages/MigrationSettings.svelte";
    import BotSettings from "./Pages/BotSettings.svelte";
    import ModelPresetSettings from "./Pages/Model/ModelPresetSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import PluginSettings from "./Pages/PluginSettings.svelte";
    import FilesSettings from "./Pages/FilesSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import SystemSettings from "./Pages/SystemSettings.svelte";
    import { additionalSettingsMenu, MobileGUI, SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import GlobalLoreBookSettings from "./Pages/GlobalLoreBookSettings.svelte";
    import Lorepreset from "./lorepreset.svelte";
    import GlobalRegex from "./Pages/GlobalRegex.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import ModuleSettings from "./Pages/Module/ModuleSettings.svelte";
  import { isLite } from "src/ts/lite";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import InlayImageGallery from "./Pages/InlayImageGallery.svelte";
    import RemoteAccessSettings from "./Pages/RemoteAccessSettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import DevPanel from "src/lib/_dev/DevPanel.svelte";
    import SettingsSearch from "./SettingsSearch.svelte";

    // Dev panel is opt-in via localStorage['risu-dev-panel']='1' in devtools.
    // Read once on mount — flag changes require reload. Gates both the menu
    // button below and the route render branch (SettingsMenuIndex === 99).
    const devPanelEnabled = typeof localStorage !== 'undefined'
        && localStorage.getItem('risu-dev-panel') === '1';

    let openLoreList = $state(false)
    let searchOpen = $state(false)
    if(window.innerWidth >= 900 && $SettingsMenuIndex === -1 && !$MobileGUI){
        $SettingsMenuIndex = 1
    }

</script>
<div class="h-full w-full flex justify-center rs-setting-cont" class:bg-bgcolor={$MobileGUI} class:setting-bg={!$MobileGUI}>
    <div class="h-full max-w-4xl w-full flex relative rs-setting-cont-2">
        {#if (window.innerWidth >= 700 && !$MobileGUI) || $SettingsMenuIndex === -1}
            <div class="flex h-full flex-col p-4 pt-8 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0"
                class:w-full={window.innerWidth < 700 || $MobileGUI}
                class:bg-darkbg={!$MobileGUI} class:bg-bgcolor={$MobileGUI}
            >
                <!-- Fake-input trigger: the actual search lives in a dialog
                     (SettingsSearch) so the result list never reflows the
                     sidebar. -->
                <button
                    class="flex items-center gap-2 border border-darkborderc hover:border-borderc rounded-md px-2 py-1.5 text-textcolor2 transition-colors"
                    onclick={() => { searchOpen = true }}
                >
                    <SearchIcon size={16} class="shrink-0" />
                    <span class="text-sm">{language.searchSettingsPlaceholder}</span>
                </button>
                {#if !$isLite}
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 1 || $SettingsMenuIndex === 13}
                        class:text-textcolor2={$SettingsMenuIndex !== 1 && $SettingsMenuIndex !== 13}
                        onclick={() => {
                            $SettingsMenuIndex = 1

                    }}>
                        <BotIcon />
                        <span>{language.chatBot}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 16}
                        class:text-textcolor2={$SettingsMenuIndex !== 16}
                        onclick={() => {
                            $SettingsMenuIndex = 16
                    }}>
                        <FileBoxIcon />
                        <span>{language.modelPresetMenu}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 17}
                        class:text-textcolor2={$SettingsMenuIndex !== 17}
                        onclick={() => {
                            $SettingsMenuIndex = 17
                    }}>
                        <ScrollTextIcon />
                        <span>{language.promptPresetMenu}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 12}
                        class:text-textcolor2={$SettingsMenuIndex !== 12}
                        onclick={() => {
                            $SettingsMenuIndex = 12
                    }}>
                        <ContactIcon />
                        <span>{language.persona}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 2}
                        class:text-textcolor2={$SettingsMenuIndex !== 2}
                        onclick={() => {
                            $SettingsMenuIndex = 2
                    }}>
                        <Sailboat />
                        <span>{language.otherBots}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 3}
                        class:text-textcolor2={$SettingsMenuIndex !== 3}
                        onclick={() => {
                            $SettingsMenuIndex = 3
                    }}>
                        <MonitorIcon />
                        <span>{language.display}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 7}
                        class:text-textcolor2={$SettingsMenuIndex !== 7}
                        onclick={() => {
                            $SettingsMenuIndex = 7
                    }}>
                        <Volume2Icon />
                        <span>{language.soundAndNotification}</span>
                    </button>
                {/if}
                <button class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 10}
                    class:text-textcolor2={$SettingsMenuIndex !== 10}
                    onclick={() => {
                        $SettingsMenuIndex = 10
                }}>
                    <LanguagesIcon />
                    <span>{language.language}</span>
                </button>
                {#if !$isLite}
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 11}
                        class:text-textcolor2={$SettingsMenuIndex !== 11}
                        onclick={() => {
                            $SettingsMenuIndex = 11
                    }}>
                        <AccessibilityIcon />
                        <span>{language.accessibility}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 14}
                        class:text-textcolor2={$SettingsMenuIndex !== 14}
                        onclick={() => {
                            $SettingsMenuIndex = 14
                    }}>
                        <PackageIcon />
                        <span>{language.modules}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 4}
                        class:text-textcolor2={$SettingsMenuIndex !== 4}
                        onclick={() => {
                        $SettingsMenuIndex = 4
                    }}>
                        <CodeIcon />
                        <span>{language.plugin}</span>
                    </button>
                {/if}
                <button class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 0}
                    class:text-textcolor2={$SettingsMenuIndex !== 0}
                    onclick={() => {
                        $SettingsMenuIndex = 0
                }}>
                    <TruckIcon />
                    <span>{language.migration}</span>
                </button>
                <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 15}
                        class:text-textcolor2={$SettingsMenuIndex !== 15}
                        onclick={() => {
                        $SettingsMenuIndex = 15
                    }}>
                        <KeyboardIcon />
                        <span>{language.hotkey}</span>
                    </button>
                {#if !$isLite}
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 23}
                        class:text-textcolor2={$SettingsMenuIndex !== 23}
                        onclick={() => {
                        $SettingsMenuIndex = 23
                    }}>
                        <ImageIcon />
                        <span>{language.playground.inlayImageGallery}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 21}
                        class:text-textcolor2={$SettingsMenuIndex !== 21}
                        onclick={() => {
                        $SettingsMenuIndex = 21
                    }}>
                        <MonitorSmartphoneIcon />
                        <span>{language.remoteAccess}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 6}
                        class:text-textcolor2={$SettingsMenuIndex !== 6}
                        onclick={() => {
                        $SettingsMenuIndex = 6
                    }}>
                        <ActivityIcon />
                        <span>{language.advancedSettings}</span>
                    </button>
                    <button class="flex gap-2 items-center hover:text-textcolor"
                        class:text-textcolor={$SettingsMenuIndex === 22}
                        class:text-textcolor2={$SettingsMenuIndex !== 22}
                        onclick={() => {
                        $SettingsMenuIndex = 22
                    }}>
                        <CogIcon />
                        <span>{language.system}</span>
                    </button>
                    {#if devPanelEnabled}
                        <button class="flex gap-2 items-center hover:text-textcolor"
                            class:text-textcolor={$SettingsMenuIndex === 99}
                            class:text-textcolor2={$SettingsMenuIndex !== 99}
                            onclick={() => {
                            $SettingsMenuIndex = 99
                        }}>
                            <FlaskConicalIcon />
                            <span>Dev Panel</span>
                        </button>
                    {/if}
                    {#if additionalSettingsMenu.length > 0}
                        <div class="border-t border-selected mt-2 pt-2">
                            <span class="text-textcolor2 text-xs ml-1">{language.plugin}</span>
                        </div>
                    {/if}
                    {#each additionalSettingsMenu as menu}
                        <button class="flex gap-2 items-center hover:text-textcolor text-textcolor2"
                            onclick={() => {
                                menu.callback()
                        }}>
                            <PluginDefinedIcon ico={menu} />
                            <span>{menu.name}</span>
                        </button>
                    {/each}

                {/if}
                {#if window.innerWidth < 700 && !$MobileGUI}
                    <button class="absolute top-2 right-2 hover:text-primary text-textcolor" onclick={() => {
                        settingsOpen.set(false)
                    }}> <CircleXIcon size={DBState.db.settingsCloseButtonSize} /> </button>
                {/if}
            </div>
        {/if}
        {#if (window.innerWidth >= 700 && !$MobileGUI) || $SettingsMenuIndex !== -1}
            {#key $SettingsMenuIndex}
                <div class="grow py-6 px-4 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0">
                    <div class="w-full max-w-2xl mx-auto flex flex-col">
                        {#if $SettingsMenuIndex === 0}
                            <MigrationSettings />
                        {:else if $SettingsMenuIndex === 1}
                            <BotSettings />
                        {:else if $SettingsMenuIndex === 2}
                            <OtherBotSettings />
                        {:else if $SettingsMenuIndex === 3}
                            <DisplaySettings />
                        {:else if $SettingsMenuIndex === 7}
                            <NotificationSoundSettings />
                        {:else if $SettingsMenuIndex === 4}
                            <PluginSettings />
                        {:else if $SettingsMenuIndex === 5}
                            <FilesSettings />
                        {:else if $SettingsMenuIndex === 6}
                            <AdvancedSettings />
                        {:else if $SettingsMenuIndex === 8}
                            <GlobalLoreBookSettings bind:openLoreList />
                        {:else if $SettingsMenuIndex === 9}
                            <GlobalRegex/>
                        {:else if $SettingsMenuIndex === 10}
                            <LanguageSettings/>
                        {:else if $SettingsMenuIndex === 11}
                            <AccessibilitySettings/>
                        {:else if $SettingsMenuIndex === 12}
                            <PersonaSettings/>
                        {:else if $SettingsMenuIndex === 14}
                            <ModuleSettings/>
                        {:else if $SettingsMenuIndex === 13}
                            <PromptSettings onGoBack={() => {
                                $SettingsMenuIndex = 1
                            }}/>
                        {:else if $SettingsMenuIndex === 15 && window.innerWidth >= 768}
                            <HotkeySettings/>
                        {:else if $SettingsMenuIndex === 16}
                            <ModelPresetSettings/>
                        {:else if $SettingsMenuIndex === 17}
                            <PromptPresetSettings/>
                        {:else if $SettingsMenuIndex === 23}
                            <InlayImageGallery/>
                        {:else if $SettingsMenuIndex === 21}
                            <RemoteAccessSettings/>
                        {:else if $SettingsMenuIndex === 22}
                            <SystemSettings/>
                        {:else if $SettingsMenuIndex === 99 && devPanelEnabled}
                            <DevPanel/>
                        {/if}
                    </div>
            </div>
            {/key}
            {#if !$MobileGUI}
                <button class="absolute top-2 right-2 hover:text-primary text-textcolor" onclick={() => {
                    if(window.innerWidth >= 700){
                        settingsOpen.set(false)
                    }
                    else{
                        $SettingsMenuIndex = -1
                    }
                }}>
                    <CircleXIcon size={DBState.db.settingsCloseButtonSize} />
                </button>
            {/if}
        {/if}
    </div>
</div>
{#if openLoreList}
    <Lorepreset close={() => {openLoreList = false}} />
{/if}
<SettingsSearch bind:open={searchOpen} />
<style>
    .setting-bg{
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);

    }
</style>
