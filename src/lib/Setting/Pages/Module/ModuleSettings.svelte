<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";

    import { DBState } from 'src/ts/stores.svelte';
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, hydrateModuleAssets, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { SquarePen, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, CloudDownload } from "@lucide/svelte";
    import { protonImportDialogOpen } from "src/ts/proton/protonImport";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertError, alertSelect, notifySuccess } from "src/ts/alert";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleIndex = $state(-1)
    let converting = $state(false)

    function isGlobal(rmodule: RisuModule) {
        return DBState.db.enabledModules.includes(rmodule.id)
    }

    function isIntegrated(rmodule: RisuModule) {
        return !!rmodule.namespace
            && !!DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace)
    }

    function toggleGlobal(rmodule: RisuModule) {
        if (isGlobal(rmodule)) {
            DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
        } else {
            DBState.db.enabledModules.push(rmodule.id)
        }
        DBState.db.enabledModules = DBState.db.enabledModules
    }

    function openEditor(index: number) {
        const rmodule = DBState.db.modules[index]
        if (!rmodule || rmodule.mcp) return
        tempModule = rmodule
        editModuleIndex = index
        mode = 2
    }

    async function exportModuleAt(index: number) {
        const rmodule = DBState.db.modules[index]
        if (!rmodule || rmodule.mcp) return
        const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
        if (sel === 0) exportModule(rmodule)
        else exportModuleLegacy(rmodule)
    }

    async function removeModule(index: number) {
        const rmodule = DBState.db.modules[index]
        if (!rmodule) return
        const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
        if (!d) return
        if (isGlobal(rmodule)) {
            DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
            DBState.db.enabledModules = DBState.db.enabledModules
        }
        DBState.db.modules = DBState.db.modules.filter((_, i) => i !== index)
        notifySuccess(language.moduleDeleted)
    }

    /** Rebuilds `db.modules` from the folder list's reported order/membership. Ids are untouched. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        const modules = DBState.db.modules
        const next = placements.map(({ index, folderId }) => ({ ...modules[index], folderId }))
        if (next.length !== modules.length) return
        DBState.db.modules = next
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <SettingPage title={language.modules}>

    <FolderedList
        folders={DBState.db.moduleFolders ?? []}
        itemFolderIds={DBState.db.modules.map(m => m.folderId)}
        itemSearchTexts={DBState.db.modules.map(m => `${m.name}\n${m.description ?? ''}`)}
        storageKey="risu-module-folders-collapsed"
        onSelect={openEditor}
        onItemsChange={applyPlacements}
        onFoldersChange={(next) => { DBState.db.moduleFolders = next }}
        onDelete={removeModule}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={() => {
                tempModule = { name: '', description: '', id: v4() }
                mode = 1
            }}><PlusIcon />{language.createModule}</ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importModule()}><HardDriveUpload />{language.importModule}</ShButton>
            <ShButton size="sm" variant="outline" onclick={() => protonImportDialogOpen.set(true)} title={language.protonImport} aria-label={language.protonImport}><CloudDownload /></ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importMCPModule()} title="MCP"><Waypoints /></ShButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const rmodule = DBState.db.modules[index]}
            {#if rmodule.mcp}
                <Waypoints size={18} class="shrink-0 text-textcolor2" />
            {/if}
            <div class="flex flex-col min-w-0 grow">
                <span class="text-textcolor truncate">{rmodule.name}</span>
                <span class="text-xs text-textcolor2 truncate">{rmodule.description || 'No description provided'}</span>
            </div>
            <button class="no-sort shrink-0 p-1 cursor-pointer {isGlobal(rmodule) ? 'text-blue-500' : isIntegrated(rmodule) ? 'text-amber-500 hover:text-primary' : 'text-textcolor2 hover:text-primary'}"
                use:tooltip={language.enableGlobal}
                onclick={(e) => { e.stopPropagation(); toggleGlobal(rmodule) }}>
                <Globe size={18}/>
            </button>
        {/snippet}
        {#snippet itemMenu(index)}
            {@const rmodule = DBState.db.modules[index]}
            {#if !rmodule.mcp}
                <ShDropdownMenuItem onSelect={() => openEditor(index)}><SquarePen /><span>{language.edit}</span></ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => exportModuleAt(index)}><Share2Icon /><span>{language.download}</span></ShDropdownMenuItem>
            {/if}
        {/snippet}
    </FolderedList>
    {#if DBState.db.modules.length === 0}
        <div class="text-textcolor2 p-3">{language.noModules}</div>
    {/if}

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <ShButton variant="primary" className="mt-6 w-full" onclick={() => {
        DBState.db.modules.push(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</ShButton>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <ShButton variant="primary" className="mt-6 w-full" onclick={() => {
            DBState.db.modules[editModuleIndex] = tempModule
            notifySuccess(language.moduleUpdated)
            mode = 0
        }}>{language.editModule}</ShButton>
        <ShButton variant="outline" className="mt-2 w-full" disabled={converting} onclick={async () => {
            if(converting){
                return
            }
            converting = true
            try {
                // Hydrate first: copying the descriptor would make the new
                // character share the module's manifest, so editing one would
                // change the other until the next reload.
                const char = convertModuleToCharacter(await hydrateModuleAssets(tempModule))
                DBState.db.characters.push(char)
                checkCharOrder()
                notifySuccess(language.successfullyConverted)
            } catch (error) {
                alertError(`${error}`)
            } finally {
                converting = false
            }
        }}>{language.convertToCharacter}</ShButton>
    {/if}
    </SettingPage>
{/if}
