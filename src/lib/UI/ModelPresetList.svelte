<script lang="ts">
    import { DBState, settingsOpen, SettingsMenuIndex } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import { notifySuccess } from "src/ts/alert";
    import { groupByFolder } from "src/ts/folders";
    import { ArrowLeft, CheckIcon, ChevronRight, HistoryIcon, PinIcon, PinOffIcon, Settings, TriangleAlert } from "@lucide/svelte";
    import ShButton from "./GUI/ShButton.svelte";
    import ModelList from "./ModelList.svelte";
    import { getModelInfo } from "src/ts/model/modellist";
    import { LEGACY_SLOT, legacySlotValue, parseLegacySlot } from "src/ts/preset/types";

    interface Props {
        value?: string;
        onChange?: (v: string) => void;
        blankable?: boolean;       // aux slots: empty = "use default sub model"
        blankLabel?: string;
        warnIfEmpty?: boolean;     // main/sub slots: empty = block, show warning
        disabled?: boolean;
        // Chat binding slots may name a legacy model instead of a preset
        // (`@legacy` / `@legacy:<model>`); module bindings may not.
        allowLegacy?: boolean;
    }

    let {
        value = $bindable(""),
        onChange = () => {},
        blankable = false,
        blankLabel,
        warnIfEmpty = false,
        disabled = false,
        allowLegacy = false,
    }: Props = $props();

    let openOptions = $state(false);
    // Legacy model lists run long (plugin providers add many), so legacy
    // models get their own tab instead of sharing the preset list.
    let activeTab = $state<'preset' | 'legacy'>('preset');
    let expandedFolders = $state<Set<string>>(new Set());

    let presets = $derived(DBState.db.modelPresets ?? []);
    let groups = $derived(groupByFolder(presets.map(preset => preset.folderId), DBState.db.modelPresetFolders ?? []));
    let legacy = $derived(allowLegacy ? parseLegacySlot(value) : null);
    let bound = $derived(value && !legacy ? (presets.find(p => p.id === value) ?? null) : null);
    // value set but no matching preset → dangling (deleted). Treated as unset by
    // the resolver; surfaced here as a warning so the user can rebind.
    let dangling = $derived(!!value && !bound && !legacy);

    let label = $derived(
        legacy ? (legacy.model
            ? (getModelInfo(legacy.model)?.shortName || getModelInfo(legacy.model)?.name || legacy.model)
            : language.modelSlotLegacyGlobalShort)
        : bound ? bound.name
        : dangling ? language.modelPresetDeleted
        : blankable ? (blankLabel ?? language.useDefaultSubModel)
        : warnIfEmpty ? language.modelPresetUnset
        : language.none
    );

    function pick(id: string) {
        value = id;
        openOptions = false;
        onChange(id);
        // Toast only on binding a real preset, not on clearing to the blank
        // ("use default sub model") option or picking a legacy model.
        if (id && !parseLegacySlot(id)) notifySuccess(language.modelPresetBindedSuccess);
    }

    function openPicker() {
        activeTab = legacy ? 'legacy' : 'preset';
        openOptions = true;
    }

    function toggleFolder(id: string) {
        const next = new Set(expandedFolders);
        next.has(id) ? next.delete(id) : next.add(id);
        expandedFolders = next;
    }

    function goToPresetSettings() {
        openOptions = false;
        settingsOpen.set(true);
        SettingsMenuIndex.set(16);
    }
</script>

{#snippet presetRow(index: number)}
    {@const preset = presets[index]}
    <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded" class:bg-selected={preset.id === value} onclick={() => pick(preset.id)}>
        <span class="truncate flex-1">{preset.name}</span>
        {#if preset.id === value}<CheckIcon size={14} class="shrink-0 text-primary" />{/if}
    </button>
{/snippet}

{#if openOptions}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="fixed top-0 w-full h-full left-0 bg-black/50 z-50 flex justify-center items-center" role="button" tabindex="0" onclick={() => { openOptions = false }}>
        <div class="w-96 max-w-full max-h-full overflow-x-hidden bg-bgcolor p-4 flex flex-col" role="button" tabindex="0" onclick={(e) => { e.stopPropagation() }}>
            <div class="shrink-0 flex items-center gap-3 mb-3">
                <button
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => { openOptions = false }}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <h1 class="font-bold text-xl flex-1">{allowLegacy ? language.modelBindingTitle : language.modelPresetMenu}</h1>
            </div>

            <ShButton className="w-full mb-2" onclick={goToPresetSettings}>
                <Settings size={16} class="shrink-0" />
                <span class="truncate">{language.modelPresetConfigure}</span>
            </ShButton>
            <div class="shrink-0 border-t-1 border-y-selected mb-2"></div>

            {#if allowLegacy}
                <div class="shrink-0 flex w-full rounded-md border border-selected mb-2">
                    <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'preset'} onclick={() => { activeTab = 'preset' }}>{language.modelSlotPresetSection}</button>
                    <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'legacy'} onclick={() => { activeTab = 'legacy' }}>{language.modelSlotLegacySection}</button>
                </div>
            {/if}

            {#if allowLegacy && activeTab === 'legacy'}
                <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded mb-1" class:bg-selected={value === LEGACY_SLOT} onclick={() => pick(LEGACY_SLOT)}>
                    <span class="truncate flex-1">{language.modelSlotLegacyGlobal}</span>
                    {#if value === LEGACY_SLOT}<CheckIcon size={14} class="shrink-0 text-primary" />{/if}
                </button>
                <ModelList embedded value={legacy?.model ?? ''} onChange={(model) => pick(legacySlotValue(model))} />
            {:else}
            <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
                {#if presets.length === 0}
                    <div class="px-3 py-4 text-sm text-textcolor2 text-center">{language.modelPresetEmpty}</div>
                {:else}
                    {#each groups as group (group.folder?.id ?? '')}
                        {#if group.folder && group.indexes.length > 0}
                            {@const folder = group.folder}
                            <button class="shrink-0 w-full flex items-center gap-1 px-3 py-1.5 text-sm font-medium hover:bg-selected rounded" onclick={() => toggleFolder(folder.id)}>
                                <span class="truncate flex-1 text-left">{folder.name}</span>
                                <ChevronRight size={14} class={`transition-transform shrink-0${expandedFolders.has(folder.id) ? ' rotate-90' : ''}`} />
                            </button>
                            {#if expandedFolders.has(folder.id)}
                                <div class="pl-4 flex flex-col">
                                    {#each group.indexes as index (presets[index].id)}
                                        {@render presetRow(index)}
                                    {/each}
                                </div>
                            {/if}
                        {:else if !group.folder}
                            {#each group.indexes as index (presets[index].id)}
                                {@render presetRow(index)}
                            {/each}
                        {/if}
                    {/each}
                {/if}

                {#if blankable}
                    <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded text-textcolor2" onclick={() => pick('')}>
                        <span class="truncate">{blankLabel ?? language.useDefaultSubModel}</span>
                    </button>
                {/if}
            </div>
            {/if}
        </div>
    </div>
{/if}

<ShButton
    className={`w-full min-w-0 justify-start${disabled ? ' opacity-50 pointer-events-none' : ''} ${
        (bound || legacy) ? 'border-selected text-textcolor'
        : (dangling || (warnIfEmpty && !value)) ? 'border-amber-500 text-amber-500'
        : 'text-textcolor2 opacity-75 hover:opacity-100'
    }`}
    onclick={() => { if (!disabled) { openPicker() } }}
>
    {#if legacy}
        <HistoryIcon size={16} class="shrink-0" />
        <span class="shrink-0 text-[10px] font-semibold px-1 rounded bg-selected">{language.modelSlotLegacyBadge}</span>
    {:else if bound}
        <PinIcon size={16} class="shrink-0" />
    {:else if dangling || (warnIfEmpty && !value)}
        <TriangleAlert size={16} class="shrink-0" />
    {:else}
        <PinOffIcon size={16} class="shrink-0" />
    {/if}
    <span class="truncate">{label}</span>
</ShButton>
