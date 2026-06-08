<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { ChevronDownIcon, SettingsIcon } from "@lucide/svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { openSettings, SettingsRoute, AccessibilityTab } from "src/ts/routing";
    import ModelList from "../UI/ModelList.svelte";
    import ModelPresetList from "../UI/ModelPresetList.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import { emptyModelBinding } from "src/ts/preset/types";

    let currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );

    let auxExpanded = $state(false);

    // Global lock; 'none' lets each chat choose. The per-chat dropdown only
    // appears under 'none' — a lock forces the regime app-wide.
    let lock = $derived(DBState.db.nodeOnlyModelModeLock ?? 'none');

    // Effective regime for THIS chat (mirrors resolveChatModelBinding): a lock
    // forces it; under 'none' it's the chat's OWN stored choice only (the
    // new-chat default is snapshotted at creation, not read here).
    let presetRegime = $derived(
        lock === 'preset' ? true :
        lock === 'legacy' ? false :
        (currentChat?.useModelPreset ?? false)
    );

    // Seed the bundle when entering binding regime: copy the global default if
    // set (visible write-time seeding, not a runtime fallback), else start empty.
    // Normalize every field to a defined primitive — bind:value / bind:checked on
    // a $bindable rejects undefined (Svelte props_invalid_value).
    function ensureBinding() {
        if (!currentChat) return;
        if (!currentChat.modelBinding) {
            const def = DBState.db.defaultModelBinding;
            currentChat.modelBinding = def ? structuredClone($state.snapshot(def)) : emptyModelBinding();
        }
        const b = currentChat.modelBinding;
        b.main ??= '';
        b.sub ??= '';
        b.separateAux ??= false;
        b.aux ??= { memory: '', emotion: '', translate: '', otherAx: '' };
        b.aux.memory ??= '';
        b.aux.emotion ??= '';
        b.aux.translate ??= '';
        b.aux.otherAx ??= '';
    }

    function onModeChange(v: 'legacy' | 'preset') {
        if (!currentChat) return;
        currentChat.useModelPreset = v === 'preset';
        if (currentChat.useModelPreset) ensureBinding();
    }

    function openModelModeSettings() {
        openSettings(SettingsRoute.Accessibility, undefined, AccessibilityTab.Sidebar);
    }

    async function confirmSetAsDefault() {
        if (!currentChat?.modelBinding) return;
        if (!(await alertConfirm(language.modelPresetSetDefaultConfirm))) return;
        DBState.db.defaultModelBinding = structuredClone($state.snapshot(currentChat.modelBinding));
        notifySuccess(language.modelPresetDefaultSaved);
    }

    // Make sure the bundle exists whenever the binding UI is shown (including
    // chats forced into preset mode by the global lock).
    $effect(() => {
        if (currentChat && presetRegime) ensureBinding();
    });
</script>

<div class="flex flex-col gap-1 mt-4">
    {#if currentChat && lock === 'none'}
        <!-- Per-chat model-mode picker. Hidden when a global lock is set. -->
        <div class="text-[11px] text-textcolor2 px-1">{language.modelModeLabel}</div>
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <SelectInput
                    value={presetRegime ? 'preset' : 'legacy'}
                    onchange={(e) => onModeChange(e.currentTarget.value as 'legacy' | 'preset')}
                >
                    <option value="legacy">{language.modelModeLegacy}</option>
                    <option value="preset">{language.modelModePreset}</option>
                </SelectInput>
            </div>
            <ShButton size="icon" className="shrink-0" onclick={openModelModeSettings} title={language.modelModeSettingsTitle}>
                <SettingsIcon size={16} />
            </ShButton>
        </div>
    {/if}
    <div class="text-[11px] text-textcolor2 px-1{currentChat && lock === 'none' ? ' mt-3' : ''}">
        {presetRegime ? language.modelPresetBindingTitle : `${language.model}/${language.submodel}`}
    </div>

    {#if !presetRegime}
        <!-- Classic regime: global model selection, untouched. -->
        <ModelList compact bind:value={DBState.db.aiModel} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelList compact bind:value={DBState.db.subModel} />
            </div>
            <ShButton size="icon" className="shrink-0" onclick={() => { auxExpanded = !auxExpanded }} title={language.seperateModelsForAxModels}>
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </ShButton>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" bind:checked={DBState.db.seperateModelsForAxModels} />
                </div>
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelMemory}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.memory} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelTranslate}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.translate} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelEmotion}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.emotion} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelOther}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.otherAx} />
            </div>
        {/if}
    {:else if currentChat?.modelBinding}
        <!-- Binding regime: per-chat ModelPreset bundle. -->
        <ModelPresetList warnIfEmpty bind:value={currentChat.modelBinding.main} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelPresetList warnIfEmpty bind:value={currentChat.modelBinding.sub} />
            </div>
            <ShButton size="icon" className="shrink-0" onclick={() => { auxExpanded = !auxExpanded }} title={language.seperateModelsForAxModels}>
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </ShButton>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" bind:checked={currentChat.modelBinding.separateAux} />
                </div>
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelMemory}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.memory} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelTranslate}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.translate} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelEmotion}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.emotion} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelOther}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.otherAx} />
            </div>
        {/if}
    {/if}

    {#if presetRegime && currentChat?.modelBinding}
        <ShButton variant="ghost" size="xs" className="w-full text-textcolor2" onclick={confirmSetAsDefault}>
            {language.modelPresetSaveAsDefaultButton}
        </ShButton>
    {/if}
</div>
