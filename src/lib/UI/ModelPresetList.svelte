<script lang="ts">
    import { DBState, settingsOpen, SettingsMenuIndex } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import { notifySuccess } from "src/ts/alert";
    import { ArrowLeft, CheckIcon, ChevronRight, PinIcon, PinOffIcon, Settings, TriangleAlert } from "@lucide/svelte";
    import ShButton from "./GUI/ShButton.svelte";
    import { normalizeModelPresetLayout } from "src/ts/preset/layout";

    interface Props {
        value?: string;
        onChange?: (v: string) => void;
        blankable?: boolean;       // aux slots: empty = "use default sub model"
        blankLabel?: string;
        warnIfEmpty?: boolean;     // main/sub slots: empty = block, show warning
        disabled?: boolean;
    }

    let {
        value = $bindable(""),
        onChange = () => {},
        blankable = false,
        blankLabel,
        warnIfEmpty = false,
        disabled = false,
    }: Props = $props();

    let openOptions = $state(false);
    let expandedFolders = $state<Set<string>>(new Set());

    let presets = $derived(DBState.db.modelPresets ?? []);
    let layout = $derived(normalizeModelPresetLayout(DBState.db.modelPresetLayout, presets));
    let presetsById = $derived(new Map(presets.map((preset) => [preset.id, preset])));
    let bound = $derived(value ? (presets.find(p => p.id === value) ?? null) : null);
    // value set but no matching preset → dangling (deleted). Treated as unset by
    // the resolver; surfaced here as a warning so the user can rebind.
    let dangling = $derived(!!value && !bound);

    let label = $derived(
        bound ? bound.name
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
        // ("use default sub model") option.
        if (id) notifySuccess(language.modelPresetBindedSuccess);
    }

    function toggleFolder(id: string) {
        const next = new Set(expandedFolders);
        next.has(id) ? next.delete(id) : next.add(id);
        expandedFolders = next;
    }

    function openPresetList() {
        if (disabled) return;
        const selectedFolder = layout.find((entry) => entry.type === 'folder' && entry.presetIds.includes(value));
        if (selectedFolder) expandedFolders = new Set([...expandedFolders, selectedFolder.id]);
        openOptions = true;
    }

    function goToPresetSettings() {
        openOptions = false;
        settingsOpen.set(true);
        SettingsMenuIndex.set(16);
    }
</script>

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
                <h1 class="font-bold text-xl flex-1">{language.modelPresetMenu}</h1>
            </div>

            <ShButton className="w-full mb-2" onclick={goToPresetSettings}>
                <Settings size={16} class="shrink-0" />
                <span class="truncate">{language.modelPresetConfigure}</span>
            </ShButton>
            <div class="shrink-0 border-t-1 border-y-selected mb-2"></div>

            <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
                {#if presets.length === 0}
                    <div class="px-3 py-4 text-sm text-textcolor2 text-center">{language.modelPresetEmpty}</div>
                {:else}
                    {#each layout as entry (`${entry.type}:${entry.id}`)}
                        {#if entry.type === 'preset'}
                            {@const preset = presetsById.get(entry.id)}
                            {#if preset}
                                <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded" class:bg-selected={preset.id === value} onclick={() => pick(preset.id)}>
                                    <span class="truncate flex-1">{preset.name}</span>
                                    {#if preset.id === value}<CheckIcon size={14} class="shrink-0 text-primary" />{/if}
                                </button>
                            {/if}
                        {:else}
                            <button class="shrink-0 w-full flex items-center gap-1 px-3 py-1.5 text-sm font-medium hover:bg-selected rounded" onclick={() => toggleFolder(entry.id)}>
                                <span class="truncate flex-1 text-left">{entry.name}</span>
                                <ChevronRight size={14} class={`transition-transform shrink-0${expandedFolders.has(entry.id) ? ' rotate-90' : ''}`} />
                            </button>
                            {#if expandedFolders.has(entry.id)}
                                <div class="pl-4 flex flex-col">
                                    {#each entry.presetIds as presetId (presetId)}
                                        {@const preset = presetsById.get(presetId)}
                                        {#if preset}
                                            <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded" class:bg-selected={preset.id === value} onclick={() => pick(preset.id)}>
                                                <span class="truncate flex-1">{preset.name}</span>
                                                {#if preset.id === value}<CheckIcon size={14} class="shrink-0 text-primary" />{/if}
                                            </button>
                                        {/if}
                                    {/each}
                                </div>
                            {/if}
                        {/if}
                    {/each}
                {/if}

                {#if blankable}
                    <button class="shrink-0 w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm hover:bg-selected rounded text-textcolor2" onclick={() => pick('')}>
                        <span class="truncate">{blankLabel ?? language.useDefaultSubModel}</span>
                    </button>
                {/if}
            </div>
        </div>
    </div>
{/if}

<ShButton
    className={`w-full min-w-0 justify-start${disabled ? ' opacity-50 pointer-events-none' : ''} ${
        bound ? 'border-selected text-textcolor'
        : (dangling || (warnIfEmpty && !value)) ? 'border-amber-500 text-amber-500'
        : 'text-textcolor2 opacity-75 hover:opacity-100'
    }`}
    onclick={openPresetList}
>
    {#if bound}
        <PinIcon size={16} class="shrink-0" />
    {:else if dangling || (warnIfEmpty && !value)}
        <TriangleAlert size={16} class="shrink-0" />
    {:else}
        <PinOffIcon size={16} class="shrink-0" />
    {/if}
    <span class="truncate">{label}</span>
</ShButton>
