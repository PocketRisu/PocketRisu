<script lang="ts">
    import { alertConfirm, notifyError, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { DBState, modelPresetSelectCallback, settingsOpen } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { CopyIcon, PencilIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";

    let editMode = $state(false)
    let isDragging = $state(false)
    let dragOverIndex = $state(-1)

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Clear any pending model-preset-select callback when the modal unmounts
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            modelPresetSelectCallback.set(null);
        };
    });

    function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        const presets = DBState.db.modelPresets;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return;

        const next = [...presets];
        const movedItem = next.splice(fromIndex, 1)[0];
        if (!movedItem) return;
        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(adjustedToIndex, 0, movedItem);
        DBState.db.modelPresets = next;
    }

    function handlePresetDrop(targetIndex: number, e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        const data = e.dataTransfer?.getData('text');
        if (data === 'modelPreset') {
            const sourceIndex = parseInt(e.dataTransfer?.getData('presetIndex') || '0');
            movePreset(sourceIndex, targetIndex);
        }
    }

    function duplicatePreset(index: number) {
        const src = DBState.db.modelPresets[index];
        if (!src) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        const presets = [...DBState.db.modelPresets, copy];
        DBState.db.modelPresets = presets;
        notifySuccess(language.presetDuplicated);
    }

    async function deletePreset(index: number) {
        const preset = DBState.db.modelPresets[index];
        if (!preset) return;
        const ok = await alertConfirm(`${language.removeConfirm}${preset.name}`);
        if (!ok) return;
        const next = [...DBState.db.modelPresets];
        next.splice(index, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center" data-risu-modal-scroll data-risu-modal="" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); }}} onclick={close}>
    <div class="risu-modal-panel bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.modelPresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#if !$settingsOpen}
            <ShButton variant="default" size="default" className="w-full mb-4" onclick={() => {
                close()
                openSettings(SettingsRoute.ModelPreset)
            }}>
                <PencilIcon size={16}/>
                <span class="ml-1">{language.presetEdit}</span>
            </ShButton>
        {/if}

        {#if DBState.db.modelPresets.length === 0}
            <div class="text-textcolor2 text-sm text-center py-8">
                {language.modelPresetEmpty}
            </div>
        {/if}

        {#each DBState.db.modelPresets as preset, i}
            <div class="w-full transition-all duration-200"
                class:h-0.5={!isDragging || dragOverIndex !== i}
                class:h-1={isDragging && dragOverIndex === i}
                class:bg-blue-500={isDragging && dragOverIndex === i}
                class:shadow-lg={isDragging && dragOverIndex === i}
                class:hover:bg-gray-600={!isDragging}
                role="listitem"
                ondragover={(e) => {
                    e.preventDefault()
                    dragOverIndex = i
                }}
                ondragleave={() => {
                    dragOverIndex = -1
                }}
                ondrop={(e) => {
                    handlePresetDrop(i, e)
                    dragOverIndex = -1
                }}>
            </div>

            <button onclick={() => {
                if (!editMode) {
                    const cb = get(modelPresetSelectCallback)
                    if (cb) {
                        modelPresetSelectCallback.set(null)
                        cb(preset.id)
                        close()
                    }
                    // No callback = chat-binding flow never opened the modal.
                    // The menu page renders an inline library instead of opening
                    // this modal, so this branch shouldn't normally fire. Stay
                    // silent if it does (no active concept on ModelPreset).
                }
            }}
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
            class:draggable-preset={!editMode}
            draggable={!editMode ? "true" : "false"}
            ondragstart={(e) => {
                if (editMode) {
                    e.preventDefault()
                    return
                }
                isDragging = true
                e.dataTransfer?.setData('text', 'modelPreset')
                e.dataTransfer?.setData('presetIndex', i.toString())
            }}
            ondragend={() => {
                isDragging = false
                dragOverIndex = -1
            }}
            ondragover={(e) => {
                e.preventDefault()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const mouseY = e.clientY
                const elementCenter = rect.top + rect.height / 2
                if (mouseY < elementCenter) {
                    dragOverIndex = i
                } else {
                    dragOverIndex = i + 1
                }
            }}
            ondrop={(e) => {
                handlePresetDrop(dragOverIndex, e)
                dragOverIndex = -1
            }}>
                {#if editMode}
                    <TextInput bind:value={DBState.db.modelPresets[i].name} placeholder="string" padding={false}/>
                {:else}
                    <span>{preset.name}</span>
                    {#if preset.profileSnapshot?.profileId}
                        <span class="text-textcolor2 text-xs ml-2 opacity-70">({preset.profileSnapshot.profileId})</span>
                    {/if}
                {/if}
                <div class="grow flex justify-end">
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        duplicatePreset(i)
                    }} onkeydown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.click()
                        }
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        deletePreset(i)
                    }} onkeydown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.click()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}

        <div class="w-full transition-all duration-200"
            class:h-0.5={!isDragging || dragOverIndex !== DBState.db.modelPresets.length}
            class:h-1={isDragging && dragOverIndex === DBState.db.modelPresets.length}
            class:bg-blue-500={isDragging && dragOverIndex === DBState.db.modelPresets.length}
            class:shadow-lg={isDragging && dragOverIndex === DBState.db.modelPresets.length}
            class:hover:bg-gray-600={!isDragging}
            role="listitem"
            ondragover={(e) => {
                e.preventDefault()
                dragOverIndex = DBState.db.modelPresets.length
            }}
            ondragleave={() => {
                dragOverIndex = -1
            }}
            ondrop={(e) => {
                handlePresetDrop(DBState.db.modelPresets.length, e)
                dragOverIndex = -1
            }}>
        </div>

        <div class="flex mt-2 items-center">
            <!-- "+ 새로 만들기" — P2에서 registry profile browser 모달로 교체 -->
            <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={() => {
                editMode = !editMode
            }} aria-label="Toggle edit mode">
                <PencilIcon size={18}/>
            </button>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
    .draggable-preset:hover {
        cursor: grab;
    }
    .draggable-preset:active {
        cursor: grabbing;
    }
    .h-0\.5 {
        min-height: 2px;
        height: 2px;
    }
    .h-1 {
        min-height: 4px;
        height: 4px;
    }
@keyframes risu-modal-in {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to   { opacity: 1; transform: none; }
}
.risu-modal-panel {
    animation: risu-modal-in var(--dur-base, 200ms) cubic-bezier(0.2, 0, 0, 1) both;
}
</style>
