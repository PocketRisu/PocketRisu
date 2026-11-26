<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import { language } from "src/lang";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookList from "src/lib/SideBars/LoreBook/LoreBookList.svelte";
    import { type CCLorebook, convertExternalLorebook } from "src/ts/process/lorebook.svelte";
    import type { RisuModule } from "src/ts/process/modules";
    import { DownloadIcon, FolderPlusIcon, HardDriveUploadIcon, ImageIcon, PlusIcon, Trash2Icon, TrashIcon } from "@lucide/svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import TriggerList from "src/lib/SideBars/Scripts/TriggerList.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { appendAssetManifestItems, editAssetManifest, forageStorage, getFileSrc, loadAssetManifestItems, recoverAssetManifestConflict, saveAsset, downloadFile } from "src/ts/globalApi.svelte";
    import { alertError, notifySuccess } from "src/ts/alert";
    import { confirmDeleteAllRegex, exportRegex, importRegex } from "src/ts/process/scripts";
    import { selectMultipleFile } from "src/ts/util";
    import { openAssetViewer, hasImageAssets } from "src/ts/assetViewer.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
  import { v4 } from "uuid";

    let submenu = $state(0)
    interface Props {
        currentModule: RisuModule;
    }

    let { currentModule = $bindable() }: Props = $props();
    let assetFileExtensions:string[] = $state([])
    let assetFilePath:string[] = $state([])
    let manifestItems:[string, string, string][] = $state([])
    let manifestOffset = $state(0)
    let manifestTotal = $state(0)
    let manifestLoading = $state(false)
    const manifestPageSize = 100

    async function loadManifestPage(offset = 0) {
        if (!currentModule.assetManifest) return
        manifestLoading = true
        try {
            const page = await forageStorage.getAssetManifestPage(currentModule.assetManifest, {
                offset,
                limit: manifestPageSize,
            })
            manifestItems = page.items as [string, string, string][]
            manifestOffset = page.offset
            manifestTotal = page.total
            assetFileExtensions = []
            assetFilePath = []
        } finally {
            manifestLoading = false
        }
    }

    async function openAssetsTab() {
        if (!currentModule.assetManifest) currentModule.assets ??= []
        submenu = 5
        if (currentModule.assetManifest) await loadManifestPage(0)
    }

    async function addManifestAsset(item: [string, string, string]) {
        if (!currentModule.assetManifest) {
            currentModule.assets ??= []
            currentModule.assets.push(item)
            currentModule.assets = currentModule.assets
            return
        }
        try {
            currentModule.assetManifest = await editAssetManifest(currentModule.assetManifest, [
                { type: 'append', item },
            ])
            const lastPageOffset = Math.floor((currentModule.assetManifest.count - 1) / manifestPageSize) * manifestPageSize
            await loadManifestPage(lastPageOffset)
        } catch (error) {
            if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
        }
    }

    async function renameManifestAsset(index: number, name: string) {
        if (!currentModule.assetManifest) return
        // The row on screen now; another page or a reload may replace it
        // while the rename is in flight.
        const row = manifestItems[index]
        try {
            currentModule.assetManifest = await editAssetManifest(currentModule.assetManifest, [
                { type: 'rename', index: manifestOffset + index, name },
            ])
            // Rename in place: reloading the page swapped the whole table for
            // a loading row, which threw the scroll back to the top.
            if (row && manifestItems[index] === row) row[0] = name
        } catch (error) {
            if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
        }
    }

    async function removeManifestAsset(index: number) {
        if (!currentModule.assetManifest) {
            currentModule.assets?.splice(index, 1)
            currentModule.assets = currentModule.assets
            return
        }
        try {
            currentModule.assetManifest = await editAssetManifest(currentModule.assetManifest, [
                { type: 'remove', index: manifestOffset + index },
            ])
            const nextOffset = Math.min(manifestOffset, Math.max(0, Math.floor((currentModule.assetManifest.count - 1) / manifestPageSize) * manifestPageSize))
            await loadManifestPage(nextOffset)
        } catch (error) {
            if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
        }
    }

    async function openCurrentAssetViewer() {
        const assets = currentModule.assetManifest
            ? await loadAssetManifestItems(currentModule.assetManifest) as [string, string, string][]
            : currentModule.assets
        openAssetViewer(currentModule.name, assets)
    }

    $effect.pre(() => {
        if(DBState.db.useAdditionalAssetsPreview){
            const assets = currentModule?.assetManifest ? manifestItems : currentModule?.assets
            if(assets){
                for(let i = 0; i < assets.length; i++){
                    if(assets[i].length > 2 && assets[i][2]) {
                        assetFileExtensions[i] = assets[i][2]
                    } else 
                        assetFileExtensions[i] = assets[i][1].split('.').pop()
                        getFileSrc(assets[i][1]).then((filePath) => {
                        assetFilePath[i] = filePath
                    })
                }
            }
        }
    });

    function addLorebook(){
        if(Array.isArray(currentModule.lorebook)){
            currentModule.lorebook.push({
                key: '',
                comment: `New Lore`,
                content: '',
                mode: 'normal',
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false
            })

            currentModule.lorebook = currentModule.lorebook
        }
    }

    function addLorebookFolder(){
        if(Array.isArray(currentModule.lorebook)){
            const id = v4()
            currentModule.lorebook.push({
                key: '\uf000folder:' + id,
                comment: `New Folder`,
                content: '',
                mode: 'folder',
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false,
            })

            currentModule.lorebook = currentModule.lorebook
        }
    }

    async function exportLoreBook(){
        try {
            const lore = currentModule.lorebook        
            const stringl = Buffer.from(JSON.stringify({
                type: 'risu',
                ver: 1,
                data: lore
            }), 'utf-8')

            await downloadFile(`lorebook_export.json`, stringl)

            notifySuccess(language.successExport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    async function importLoreBook(){
        let lore = currentModule.lorebook
        const lorebook = (await selectMultipleFile(['json', 'lorebook']))
        if(!lorebook){
            return
        }
        try {
            for(const f of lorebook){
                const importedlore = JSON.parse(Buffer.from(f.data).toString('utf-8'))
                if(importedlore.type === 'risu' && importedlore.data){
                    const datas:loreBook[] = importedlore.data
                    for(const data of datas){
                        lore.push(data)
                    }
                }
                else if(importedlore.entries){
                    const entries:{[key:string]:CCLorebook} = importedlore.entries
                    lore.push(...convertExternalLorebook(entries))
                }
            }
        } catch (error) {
            alertError(`${error}`)
        }
    }

    function addRegex(){
        if(Array.isArray(currentModule.regex)){
            currentModule.regex.push({
                comment: "",
                in: "",
                out: "",
                type: "editinput"
            })

            currentModule.regex = currentModule.regex
        }
    }

    function addTrigger(){
        if(Array.isArray(currentModule.trigger)){
            currentModule.trigger.push({
                conditions: [],
                type: 'start',
                comment: '',
                effect: []
            })

            currentModule.trigger = currentModule.trigger
        }
    }

    // Tab switches keep the legacy side effects: each tab lazily initializes
    // the module field it edits before showing it.
    function selectTab(value: number) {
        if (value === 1) {
            currentModule.lorebook ??= []
        } else if (value === 2) {
            currentModule.regex ??= []
        } else if (value === 3) {
            currentModule.trigger ??= [{
                comment: "",
                type: "manual",
                conditions: [],
                effect: [{
                    type: "v2Header",
                    code: "",
                    indent: 0
                }]
            }, {
                comment: "New Event",
                type: 'manual',
                conditions: [],
                effect: []
            }]
        } else if (value === 5) {
            openAssetsTab()
            return
        }
        submenu = value
    }

    // Row-layout field descriptor for SettingRowLayout (label + inline help).
    function field(id: string, label: string, helpKey?: string): SettingItem {
        return { id: `module.${id}`, type: 'custom', fallbackLabel: label, helpKey }
    }
</script>


<SettingTabs
    tabs={[
        { label: language.basicInfo, value: 0 },
        { label: language.loreBook, value: 1 },
        { label: language.regexScript, value: 2 },
        { label: language.triggerScript, value: 3 },
        { label: language.additionalAssets, value: 5 },
    ]}
    bind:selected={() => submenu, selectTab}
/>

{#if submenu === 0}
    <div class="flex flex-col [&>*:first-child]:border-t-0">
        <SettingRowLayout item={field('name', language.name, 'moduleName')} wideControl>
            {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={currentModule.name}/>{/snippet}
        </SettingRowLayout>
        <SettingRowLayout item={field('description', language.description, 'moduleDescription')} wideControl>
            {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={currentModule.description}/>{/snippet}
        </SettingRowLayout>
        <SettingRowLayout item={field('namespace', language.namespace, 'namespace')} wideControl>
            {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={currentModule.namespace}/>{/snippet}
        </SettingRowLayout>
        <SettingRowLayout item={field('hideIcon', language.hideChatIcon, 'moduleHideChatIcon')}>
            {#snippet control()}<ShSwitch checked={!!currentModule.hideIcon} onCheckedChange={(v) => currentModule.hideIcon = v} />{/snippet}
        </SettingRowLayout>
        <div class="py-3 border-t border-darkborderc">
            <SettingFieldLabel label={language.customPromptTemplateToggle} helpKey="customPromptTemplateToggle" />
            <TextAreaInput className="mt-2" bind:value={currentModule.customModuleToggle}/>
        </div>
    </div>
{/if}
{#if submenu === 1 && (Array.isArray(currentModule.lorebook))}
    <LoreBookList externalLoreBooks={currentModule.lorebook} />
    <div class="mt-2 flex gap-1">
        <ShButton variant="ghost" size="icon-sm" aria-label="Add" onclick={() => {addLorebook()}}><PlusIcon /></ShButton>
        <ShButton variant="ghost" size="icon-sm" aria-label="Export" onclick={() => {exportLoreBook()}}><DownloadIcon /></ShButton>
        <ShButton variant="ghost" size="icon-sm" aria-label="Add folder" onclick={() => {addLorebookFolder()}}><FolderPlusIcon /></ShButton>
        <ShButton variant="ghost" size="icon-sm" aria-label="Import" onclick={() => {importLoreBook()}}><HardDriveUploadIcon /></ShButton>
    </div>
{/if}

{#if submenu === 2 && (Array.isArray(currentModule.regex))}
    <div class="flex flex-col">
        <SettingFieldLabel label={language.backgroundHTML} helpKey="moduleBackgroundEmbedding" />
        <TextAreaInput bind:value={currentModule.backgroundEmbedding} className="mt-2" placeholder={language.backgroundHTML}/>
    </div>
    <div class="flex flex-col py-3 mt-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.regexScript} helpKey="moduleRegexList" />
        <RegexList bind:value={currentModule.regex}/>
        <div class="mt-2 flex gap-1">
            <ShButton variant="ghost" size="icon-sm" aria-label="Add" onclick={() => {
                addRegex()
            }}><PlusIcon /></ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label="Export" onclick={() => {
                exportRegex(currentModule.regex)
            }}><DownloadIcon /></ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label="Import" onclick={async () => {
                currentModule.regex = await importRegex(currentModule.regex)
            }}><HardDriveUploadIcon /></ShButton>
            <ShButton variant="ghost" size="icon-sm" title={language.regexDeleteAll} aria-label={language.regexDeleteAll} disabled={!currentModule.regex?.length} onclick={async () => {
                if(await confirmDeleteAllRegex(currentModule.regex)){
                    currentModule.regex = []
                }
            }}><Trash2Icon /></ShButton>
        </div>
    </div>
{/if}

{#if submenu === 5 && (Array.isArray(currentModule.assets) || currentModule.assetManifest)}
    {#if currentModule.assetManifest || hasImageAssets(currentModule.assets)}
        <ShButton
            className="w-full mb-3"
            onclick={openCurrentAssetViewer}
        >
            <ImageIcon size={16} />
            <span>{language.viewInAssetViewer}</span>
        </ShButton>
    {/if}
    <div class="mb-2 flex flex-col"><SettingFieldLabel label={language.additionalAssets} helpKey="moduleAdditionalAssets" /></div>
    <div class="w-full max-w-full border border-selected rounded-md p-2">
        <table class="contain w-full max-w-full tabler mt-2">
            <tbody>
            <tr>
                <th class="font-medium">{language.value}</th>
                <th class="font-medium cursor-pointer w-10">
                    <button class="hover:text-primary" onclick={async () => {
                        const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif', 'jpeg', 'jpg', 'ttf', 'otf', 'css', 'webm', 'woff', 'woff2', 'svg', 'avif'])
                        if(!da){
                            return
                        }
                        const appended: [string, string, string][] = []
                        for(const f of da){
                            const img = f.data
                            const name = f.name
                            const extension = name.split('.').pop().toLowerCase()
                            const imgp = await saveAsset(img,'', extension)
                            if (currentModule.assetManifest) appended.push([name, imgp, extension])
                            else await addManifestAsset([name, imgp, extension])
                        }
                        if (currentModule.assetManifest && appended.length > 0) {
                            try {
                                currentModule.assetManifest = await appendAssetManifestItems(currentModule.assetManifest, appended)
                                const lastPageOffset = Math.floor((currentModule.assetManifest.count - 1) / manifestPageSize) * manifestPageSize
                                await loadManifestPage(lastPageOffset)
                            } catch (error) {
                                if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
                            }
                        }
                    }}>
                        <PlusIcon />
                    </button>
                </th>
            </tr>
            {#if manifestLoading}
                <tr><td colspan="3">{language.storageLoading}</td></tr>
            {:else if currentModule.assetManifest ? manifestTotal === 0 : (!currentModule.assets || currentModule.assets.length === 0)}
                <tr>
                    <td colspan="3">{language.noData}</td>
                </tr>
            {:else}
                {#each (currentModule.assetManifest ? manifestItems : currentModule.assets) as assets, i}
                    <tr>
                        <td class="font-medium truncate">
                            {#if assetFilePath[i] && DBState.db.useAdditionalAssetsPreview}
                                {#if assetFileExtensions[i] === 'mp4'}
                                <!-- svelte-ignore a11y_media_has_caption -->
                                    <video controls class="mt-2 px-2 w-full m-1 rounded-md"><source src={assetFilePath[i]} type="video/mp4"></video>
                                {:else if assetFileExtensions[i] === 'mp3'}
                                    <audio controls class="mt-2 px-2 w-full h-16 m-1 rounded-md" loop><source src={assetFilePath[i]} type="audio/mpeg"></audio>
                                {:else}
                                    <img src={assetFilePath[i]} class="w-16 h-16 m-1 rounded-md" alt={assets[0]}/>
                                {/if}
                            {/if}
                            {#if currentModule.assetManifest}
                                <TextInput
                                    fullwidth
                                    marginBottom
                                    value={assets[0]}
                                    onchange={(event) => renameManifestAsset(i, event.currentTarget.value)}
                                    placeholder="..."
                                />
                            {:else}
                                <TextInput fullwidth marginBottom bind:value={currentModule.assets[i][0]} placeholder="..." />
                            {/if}
                        </td>
                        
                        <th class="font-medium cursor-pointer w-10">
                            <button class="hover:text-red-400" onclick={() => removeManifestAsset(i)}>
                                <TrashIcon />
                            </button>
                        </th>
                    </tr>
                {/each}
            {/if}
            </tbody>
        </table>
        {#if currentModule.assetManifest && manifestTotal > manifestPageSize}
            <div class="mt-2 flex items-center justify-between gap-2">
                <ShButton
                    disabled={manifestOffset === 0 || manifestLoading}
                    onclick={() => loadManifestPage(Math.max(0, manifestOffset - manifestPageSize))}
                >←</ShButton>
                <span>{manifestOffset + 1}–{Math.min(manifestOffset + manifestItems.length, manifestTotal)} / {manifestTotal}</span>
                <ShButton
                    disabled={manifestOffset + manifestPageSize >= manifestTotal || manifestLoading}
                    onclick={() => loadManifestPage(manifestOffset + manifestPageSize)}
                >→</ShButton>
            </div>
        {/if}
    </div>
{/if}

{#if submenu === 3 && (Array.isArray(currentModule.trigger))}
    <TriggerList bind:value={currentModule.trigger} lowLevelAble={currentModule.lowLevelAccess} />

    <div class="mt-4 [&>*:first-child]:border-t-0">
        <SettingRowLayout item={field('lowLevelAccess', language.lowLevelAccess, 'lowLevelAccess')}>
            {#snippet control()}<ShSwitch checked={!!currentModule.lowLevelAccess} onCheckedChange={(v) => currentModule.lowLevelAccess = v} />{/snippet}
        </SettingRowLayout>
    </div>
{/if}
