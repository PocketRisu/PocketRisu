<script lang="ts">
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToThemePreset, copyThemePreset, downloadThemePreset, importThemePreset, themePresetTemplate } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { CopyIcon, Share2Icon, PencilIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { updateColorScheme, updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import { updateAnimationSpeed } from "src/ts/gui/animation";
    import { updateGuisize } from "src/ts/gui/guisize";

    let editMode = $state(false)
    let isDragging = $state(false)
    let dragOverIndex = $state(-1)

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= DBState.db.themePresets.length || toIndex > DBState.db.themePresets.length) return;

        let themePresets = [...DBState.db.themePresets];
        const movedItem = themePresets.splice(fromIndex, 1)[0];
        if (!movedItem) return;

        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        themePresets.splice(adjustedToIndex, 0, movedItem);

        const currentId = DBState.db.themePresetsId;
        if (currentId === fromIndex) {
            DBState.db.themePresetsId = adjustedToIndex;
        } else if (fromIndex < currentId && adjustedToIndex >= currentId) {
            DBState.db.themePresetsId = currentId - 1;
        } else if (fromIndex > currentId && adjustedToIndex <= currentId) {
            DBState.db.themePresetsId = currentId + 1;
        }

        DBState.db.themePresets = themePresets;
    }

    function handlePresetDrop(targetIndex: number, e) {
        e.preventDefault();
        e.stopPropagation();
        const data = e.dataTransfer?.getData('text');
        if (data === 'themePreset') {
            const sourceIndex = parseInt(e.dataTransfer?.getData('presetIndex') || '0');
            movePreset(sourceIndex, targetIndex);
        }
    }

    function applyThemeVisuals() {
        updateColorScheme()
        updateTextThemeAndCSS()
        updateAnimationSpeed()
        updateGuisize()
    }

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center" data-risu-modal-scroll data-risu-modal="" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); }}} onclick={close}>
    <div class="risu-modal-panel bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.themePresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#each DBState.db.themePresets as preset, i}
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
                ondragleave={(e) => {
                    dragOverIndex = -1
                }}
                ondrop={(e) => {
                    handlePresetDrop(i, e)
                    dragOverIndex = -1
                }}>
            </div>

            <button onclick={() => {
                if(!editMode){
                    changeToThemePreset(i)
                    applyThemeVisuals()
                    close()
                }
            }}
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
            class:bg-selected={i === DBState.db.themePresetsId}
            class:draggable-preset={!editMode}
            draggable={!editMode ? "true" : "false"}
            ondragstart={(e) => {
                if (editMode) {
                    e.preventDefault()
                    return
                }
                isDragging = true
                e.dataTransfer?.setData('text', 'themePreset')
                e.dataTransfer?.setData('presetIndex', i.toString())

                const dragElement = document.createElement('div')
                dragElement.textContent = preset?.name || 'Unnamed Theme'
                dragElement.className = 'absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-textcolor2 rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none z-50'
                document.body.appendChild(dragElement)
                e.dataTransfer?.setDragImage(dragElement, 10, 10)

                setTimeout(() => {
                    document.body.removeChild(dragElement)
                }, 0)
            }}
            ondragend={(e) => {
                isDragging = false
                dragOverIndex = -1
            }}
            ondragover={(e) => {
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
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
                    <TextInput bind:value={DBState.db.themePresets[i].name} placeholder="string" padding={false}/>
                {:else}
                    <span>{preset.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        copyThemePreset(i)
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        downloadThemePreset(i, 'json')
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <Share2Icon size={18} />
                    </div>
                    <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(DBState.db.themePresets.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${preset.name}`)
                        if(d){
                            changeToThemePreset(0)
                            applyThemeVisuals()
                            let themePresets = DBState.db.themePresets
                            themePresets.splice(i, 1)
                            DBState.db.themePresets = themePresets
                            changeToThemePreset(0, false)
                            applyThemeVisuals()
                        }
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}

        <div class="w-full transition-all duration-200"
            class:h-0.5={!isDragging || dragOverIndex !== DBState.db.themePresets.length}
            class:h-1={isDragging && dragOverIndex === DBState.db.themePresets.length}
            class:bg-blue-500={isDragging && dragOverIndex === DBState.db.themePresets.length}
            class:shadow-lg={isDragging && dragOverIndex === DBState.db.themePresets.length}
            class:hover:bg-gray-600={!isDragging}
            role="listitem"
            ondragover={(e) => {
                e.preventDefault()
                dragOverIndex = DBState.db.themePresets.length
            }}
            ondragleave={(e) => {
                dragOverIndex = -1
            }}
            ondrop={(e) => {
                handlePresetDrop(DBState.db.themePresets.length, e)
                dragOverIndex = -1
            }}>
        </div>

        <div class="flex mt-2 items-center">
            <button class="text-textcolor2 hover:text-primary cursor-pointer mr-1" onclick={() => {
                let themePresets = DBState.db.themePresets
                let newPreset = safeStructuredClone(themePresetTemplate)
                newPreset.name = `New Theme`
                themePresets.push(newPreset)
                DBState.db.themePresets = themePresets
            }}>
                <PlusIcon/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                importThemePreset()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
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

    /* Drag and drop styles */
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
