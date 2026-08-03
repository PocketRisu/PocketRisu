<script lang="ts">
    import { alertConfirm, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { DBState, modelPresetSelectCallback, settingsOpen } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { CopyIcon, PencilIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { duplicateModelPreset, normalizeModelPresetLayout, removeModelPresetFromLayout } from "src/ts/preset/layout";

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();
    let presets = $derived(DBState.db.modelPresets ?? []);
    let layout = $derived(normalizeModelPresetLayout(DBState.db.modelPresetLayout, presets));
    let presetsById = $derived(new Map(presets.map((preset) => [preset.id, preset])));

    $effect(() => () => modelPresetSelectCallback.set(null));

    function select(id: string) {
        const callback = get(modelPresetSelectCallback);
        if (!callback) return;
        modelPresetSelectCallback.set(null);
        callback(id);
        close();
    }

    function duplicate(id: string) {
        const result = duplicateModelPreset(presets, layout, id);
        if (!result) return;
        DBState.db.modelPresets = result.presets;
        DBState.db.modelPresetLayout = result.layout;
        notifySuccess(language.presetDuplicated);
    }

    async function remove(id: string) {
        const preset = presetsById.get(id);
        if (!preset || !await alertConfirm(`${language.removeConfirm}${preset.name}`)) return;
        DBState.db.modelPresets = presets.filter((item) => item.id !== id);
        DBState.db.modelPresetLayout = removeModelPresetFromLayout(layout, id);
        notifySuccess(language.presetDeleted);
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.modelPresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close} aria-label="close"><XIcon size={24}/></button>
            </div>
        </div>
        {#if !$settingsOpen}
            <ShButton variant="default" size="default" className="w-full mb-4" onclick={() => { close(); openSettings(SettingsRoute.ModelPreset) }}>
                <PencilIcon size={16}/><span class="ml-1">{language.presetEdit}</span>
            </ShButton>
        {/if}
        {#if presets.length === 0}
            <div class="text-textcolor2 text-sm text-center py-8">{language.modelPresetEmpty}</div>
        {/if}
        {#each layout as entry (`${entry.type}:${entry.id}`)}
            {#if entry.type === 'folder'}
                <div class="border-t border-darkborderc px-2 pt-3 pb-1 text-xs font-medium text-textcolor2">{entry.name}</div>
            {/if}
            {@const ids = entry.type === 'preset' ? [entry.id] : entry.presetIds}
            {#each ids as id (id)}
                {@const preset = presetsById.get(id)}
                {#if preset}
                    <div
                        class="flex items-center text-textcolor border-t border-darkborderc p-2 cursor-pointer text-left"
                        role="button"
                        tabindex="0"
                        onclick={() => select(preset.id)}
                        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') select(preset.id) }}
                    >
                        <span class="truncate">{preset.name}</span>
                        {#if preset.profileSnapshot?.profileId}<span class="text-textcolor2 text-xs ml-2 opacity-70 truncate">({preset.profileSnapshot.profileId})</span>{/if}
                        <span class="grow"></span>
                        <span class="flex gap-2 shrink-0">
                            <button class="text-textcolor2 hover:text-primary" onclick={(event) => { event.stopPropagation(); duplicate(preset.id) }} aria-label="duplicate"><CopyIcon size={18}/></button>
                            <button class="text-textcolor2 hover:text-red-400" onclick={(event) => { event.stopPropagation(); remove(preset.id) }} aria-label="delete"><TrashIcon size={18}/></button>
                        </span>
                    </div>
                {/if}
            {/each}
        {/each}
    </div>
</div>

<style>
    .break-any { overflow-wrap: anywhere; }
</style>
