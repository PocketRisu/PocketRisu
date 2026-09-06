<script lang="ts">
    // Folder settings in one dialog: name, color, and a display mode
    // (icon / image / name) whose controls appear only for the chosen mode.
    // Shared by the sidebar rail (right-click on a folder) and the character
    // manager. Target is a characterOrder folder id in `folderSettingsTarget`;
    // every edit re-resolves the folder by id so a stale render index can
    // never redirect the change to another folder.
    import { FolderIcon } from "@lucide/svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import SidebarAvatar from "src/lib/SideBars/SidebarAvatar.svelte";
    import { DBState, folderSettingsTarget } from "src/ts/stores.svelte";
    import { findFolder, updateFolder } from "src/ts/characterOrder";
    import { checkCharOrder, getFileSrc, saveAsset } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { getCharImage } from "src/ts/characters";
    import { FOLDER_ICONS, FOLDER_ICON_NAMES, folderIconComponent } from "./folderIcons";
    import { language } from "src/lang";
    import { folderDisplayMode, type folder, type FolderDisplayMode } from "src/ts/storage/database.svelte";

    // '' is the default (no color). Same set the rail has always offered.
    const FOLDER_COLORS = ['', 'red', 'green', 'blue', 'yellow', 'indigo', 'purple', 'pink'] as const;
    const swatchClass: Record<string, string> = {
        '': 'bg-darkbg',
        red: 'bg-red-700',
        green: 'bg-green-700',
        blue: 'bg-blue-700',
        yellow: 'bg-yellow-700',
        indigo: 'bg-indigo-700',
        purple: 'bg-purple-700',
        pink: 'bg-pink-700',
    };

    let target: folder | undefined = $derived(
        $folderSettingsTarget ? findFolder(DBState.db.characterOrder, $folderSettingsTarget) : undefined
    );
    let mode: FolderDisplayMode = $derived(target ? folderDisplayMode(target) : 'icon');
    let PreviewIcon = $derived(folderIconComponent(target?.nodeOnlyIcon));

    function apply(patch: Partial<Omit<folder, 'id' | 'data'>>) {
        const id = $folderSettingsTarget;
        if (!id) return;
        DBState.db.characterOrder = updateFolder(DBState.db.characterOrder, id, patch);
        checkCharOrder();
    }

    async function pickImage() {
        const file = await selectSingleFile(['png', 'jpg', 'webp']);
        if (!file) return;
        const imgFile = await saveAsset(file.data);
        apply({ imgFile, img: await getFileSrc(imgFile) });
    }

    function close() {
        folderSettingsTarget.set(null);
    }
</script>

{#if target}
    <ShDialog open={true} onOpenChange={(v) => { if (!v) close() }} size="default">
        {#snippet title()}{language.folderSettings}{/snippet}
        <div class="flex flex-col gap-4">
            <div class="flex justify-center">
                {#key target.color + target.name + (target.imgFile ?? '') + (target.nodeOnlyIcon ?? '') + mode}
                    <SidebarAvatar
                        src="slot"
                        size="56"
                        rounded={!!DBState.db.roundIcons}
                        bordered
                        name={target.name}
                        color={target.color}
                        backgroundimg={mode === 'image' && target.imgFile ? getCharImage(target.imgFile, 'plain') : ''}
                    >
                        {#if mode === 'name'}
                            <span class="hyphens-auto truncate font-bold px-1">{target.name}</span>
                        {:else if mode === 'icon' && PreviewIcon}
                            <PreviewIcon />
                        {:else}
                            <FolderIcon />
                        {/if}
                    </SidebarAvatar>
                {/key}
            </div>

            <label class="flex flex-col gap-1">
                <span class="text-sm text-textcolor2">{language.name}</span>
                <ShInput
                    value={target.name}
                    oninput={(e) => apply({ name: e.currentTarget.value })}
                />
            </label>

            <div class="flex flex-col gap-1">
                <span class="text-sm text-textcolor2">{language.folderColor}</span>
                <div class="flex flex-wrap gap-2">
                    {#each FOLDER_COLORS as color (color)}
                        <button
                            type="button"
                            class="h-8 w-8 rounded-md border-2 transition-colors {swatchClass[color]} {target.color === color ? 'border-primary' : 'border-darkborderc hover:border-textcolor2'}"
                            title={color || language.defaultLabel}
                            aria-label={color || language.defaultLabel}
                            aria-pressed={target.color === color}
                            onclick={() => apply({ color })}
                        ></button>
                    {/each}
                </div>
            </div>

            <div class="flex flex-col gap-2">
                <span class="text-sm text-textcolor2">{language.folderDisplayMode}</span>
                <SegmentedControl
                    bind:value={() => mode, (v) => apply({ nodeOnlyDisplay: v as FolderDisplayMode })}
                    size="sm"
                    options={[
                        { value: 'icon', label: language.folderModeIcon },
                        { value: 'image', label: language.folderModeImage },
                        { value: 'name', label: language.folderModeName },
                    ]}
                />

                {#if mode === 'icon'}
                    <div class="grid grid-cols-8 gap-1 max-h-40 overflow-y-auto rounded-md border border-darkborderc p-1">
                        <button
                            type="button"
                            class="flex h-8 items-center justify-center rounded-md text-xs transition-colors {!target.nodeOnlyIcon ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-selected/50'}"
                            title={language.defaultLabel}
                            aria-pressed={!target.nodeOnlyIcon}
                            onclick={() => apply({ nodeOnlyIcon: undefined })}
                        >{language.defaultLabel}</button>
                        {#each FOLDER_ICON_NAMES as iconName (iconName)}
                            {@const Icon = FOLDER_ICONS[iconName]}
                            <button
                                type="button"
                                class="flex h-8 items-center justify-center rounded-md transition-colors {target.nodeOnlyIcon === iconName ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-selected/50'}"
                                title={iconName}
                                aria-label={iconName}
                                aria-pressed={target.nodeOnlyIcon === iconName}
                                onclick={() => apply({ nodeOnlyIcon: iconName })}
                            ><Icon size={18} /></button>
                        {/each}
                    </div>
                {:else if mode === 'image'}
                    <div class="flex items-center gap-2">
                        <ShButton variant="outline" size="sm" onclick={pickImage}>{language.selectImage}</ShButton>
                        <ShButton variant="ghost" size="sm" disabled={!target.imgFile} onclick={() => apply({ imgFile: undefined, img: '' })}>{language.resetImage}</ShButton>
                    </div>
                    {#if !target.imgFile}
                        <span class="text-xs text-textcolor2">{language.folderImageHint}</span>
                    {/if}
                {/if}
            </div>
        </div>
    </ShDialog>
{/if}
