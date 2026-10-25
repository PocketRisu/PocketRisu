<script lang="ts">
    import { PlusIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, ShieldIcon, HardDriveUploadIcon, CloudDownloadIcon } from "@lucide/svelte";
    import { protonImportDialogOpen } from "src/ts/proton/protonImport";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { alertConfirm, alertMd, alertSelect, notifySuccess } from "src/ts/alert";
    import { TriangleAlert } from '@lucide/svelte';
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";

    import { DBState, hotReloading } from "src/ts/stores.svelte";
    import { checkPluginUpdate, importPlugin, loadPlugins, updatePlugin } from "src/ts/plugins/plugins.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { resetPluginPermission } from "src/ts/plugins/apiV3/v3.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles } from "src/ts/plugins/apiV3/developMode";
    import * as pluginStorageStore from "src/ts/plugins/pluginStorageStore";

    // Plugins are keyed by name (no id); track expanded parameter panels by name.
    let showParams = $state<string[]>([])

    function toggleParams(index: number) {
        const name = DBState.db.plugins[index]?.name
        if (!name) return
        showParams = showParams.includes(name) ? showParams.filter(n => n !== name) : [...showParams, name]
    }

    function hasParams(plugin: typeof DBState.db.plugins[number]) {
        return plugin.version !== 1 && Object.keys(plugin.arguments ?? {}).filter((k) => !k.startsWith("hidden_")).length > 0
    }

    // V3 plugins always have a detail panel (the storage access switch).
    function hasPanel(plugin: typeof DBState.db.plugins[number]) {
        return hasParams(plugin) || plugin.version === '3.0'
    }

    const FULL_STORAGE_WARN_BYTES = 100 * 1024 * 1024
    function storageSizeText(bytes: number) {
        return bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.ceil(bytes / 1024)} KB`
    }
    function fullStorageGuideUrl() {
        const lang = DBState.db.language === 'ko' ? 'ko' : 'en'
        return `https://github.com/PocketRisu/PocketRisu/blob/main/docs/${lang}/plugin-storage.md`
    }

    function togglePlugin(index: number) {
        const plugin = DBState.db.plugins[index]
        plugin.enabled = !plugin.enabled
        DBState.db.plugins[index] = plugin
        loadPlugins()
        void requestImmediateSave()
    }

    async function resetPermission(index: number) {
        const plugin = DBState.db.plugins[index]
        const label = plugin.displayName ?? plugin.name
        if (!await alertConfirm(language.resetPluginPermissionConfirm.replace("{}", label))) return
        await resetPluginPermission(plugin.name)
        notifySuccess(language.resetPluginPermissionDone.replace("{}", label))
    }

    async function removePlugin(index: number) {
        const plugin = DBState.db.plugins[index]
        if (!plugin) return
        if (!await alertConfirm(language.removeConfirm + (plugin.displayName ?? plugin.name))) return
        if (DBState.db.currentPluginProvider === plugin.name) {
            DBState.db.currentPluginProvider = "";
        }
        DBState.db.plugins = (DBState.db.plugins ?? []).filter((_, i) => i !== index)
        loadPlugins()
        void requestImmediateSave()
    }

    /** Rebuilds `db.plugins` from the folder list's reported order/membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        const plugins = DBState.db.plugins
        const next = placements.map(({ index, folderId }) => ({ ...plugins[index], folderId }))
        if (next.length !== plugins.length) return
        DBState.db.plugins = next
        void requestImmediateSave()
    }

    async function openDevTools() {
        const v = parseInt(await alertSelect([
            "Import plugin with hot reload",
            "Download plugin template",
            language.cancel
        ]))
        switch(v){
            case 0:
                await hotReloadPluginFiles()
                break;
            case 1:{
                const a = document.createElement('a');
                a.href = '/plugin_start.7z';
                a.download = 'plugin_starter.7z';
                document.body.appendChild(a);
            }
        }
    }
</script>

<SettingPage title={language.plugin}>
<ShAlert variant="warning" className="mb-4">
    {#snippet icon()}<TriangleAlert />{/snippet}
    {language.pluginWarn}
</ShAlert>

<FolderedList
    folders={DBState.db.pluginFolders ?? []}
    itemFolderIds={(DBState.db.plugins ?? []).map(p => p.folderId)}
    itemSearchTexts={(DBState.db.plugins ?? []).map(p => `${p.displayName ?? ''}\n${p.name}`)}
    storageKey="risu-plugin-folders-collapsed"
    onSelect={toggleParams}
    isExpanded={(index) => hasPanel(DBState.db.plugins[index]) && showParams.includes(DBState.db.plugins[index].name)}
    onItemsChange={applyPlacements}
    onFoldersChange={(next) => { DBState.db.pluginFolders = next; void requestImmediateSave() }}
    onDelete={removePlugin}
>
    {#snippet actions()}
        <ShButton size="sm" onclick={() => importPlugin()}><HardDriveUploadIcon />{language.pluginImport}</ShButton>
        <ShButton size="sm" variant="outline" onclick={() => protonImportDialogOpen.set(true)} title={language.protonImport} aria-label={language.protonImport}><CloudDownloadIcon /></ShButton>
        <ShButton size="sm" variant="outline" onclick={openDevTools} title={language.pluginDevTools}><CodeXmlIcon /></ShButton>
    {/snippet}
    {#snippet itemContent(index)}
        {@const plugin = DBState.db.plugins[index]}
        <div class="flex flex-col min-w-0 grow">
            <div class="flex items-center gap-2 min-w-0">
                <span class="text-textcolor truncate">{plugin.displayName ?? plugin.name}</span>
                {#if hotReloading.includes(plugin.name)}
                    <span class="text-xs rounded bg-amber-700 px-2 py-0.5 text-white shrink-0">Hot</span>
                {/if}
                <span class="grow"></span>
                {#if plugin.version === 2 || plugin.version === "2.1"}
                    <button class="no-sort text-yellow-400 cursor-pointer shrink-0" onclick={(e) => { e.stopPropagation(); alertMd(language.pluginV2Warning) }}>
                        <TriangleAlert size={18}/>
                    </button>
                {/if}
                {#if plugin.customLink}
                    {#each plugin.customLink as link}
                        {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                            <a href={link.link} target="_blank" rel="nofollow noopener noreferrer"
                                class="no-sort text-textcolor2 hover:text-textcolor cursor-pointer shrink-0"
                                title={link.hoverText} onclick={(e) => e.stopPropagation()}>
                                <LinkIcon size={18}/>
                            </a>
                        {/if}
                    {/each}
                {/if}
                {#if plugin.updateURL}
                    {#await checkPluginUpdate(plugin) then updateInfo}
                        {#if updateInfo}
                            <button class="no-sort text-green-400 cursor-pointer shrink-0" title={language.pluginUpdateFoundInstallIt}
                                onclick={async (e) => {
                                    e.stopPropagation()
                                    if (await alertConfirm(language.pluginUpdateFoundInstallIt)) updatePlugin(plugin)
                                }}>
                                <PlusIcon size={18}/>
                            </button>
                        {/if}
                    {/await}
                {/if}
                <button class="no-sort shrink-0 cursor-pointer {plugin.enabled ? 'text-textcolor' : 'text-textcolor2'} hover:text-primary"
                    onclick={(e) => { e.stopPropagation(); togglePlugin(index) }}>
                    {#if plugin.enabled}<PowerIcon size={18}/>{:else}<PowerOffIcon size={18}/>{/if}
                </button>
            </div>
            {#if plugin.version === 1}
                <span class="text-draculared text-xs">
                    {language.pluginVersionWarn
                        .replace("{{plugin_version}}", "API V1")
                        .replace("{{required_version}}", "API V3")}
                </span>
            {/if}
        </div>
    {/snippet}
    {#snippet itemPanel(index)}
        {@const plugin = DBState.db.plugins[index]}
        <div class="flex flex-col bg-dark-900/50 p-3 rounded-md">
            {#if plugin.version === '3.0'}
                {@const storageBytes = pluginStorageStore.totalBytes()}
                <div class="flex items-center">
                    <CheckInput bind:check={DBState.db.plugins[index].nodeOnlyFullStorageAccess} name={language.pluginFullStorageAccess} />
                </div>
                <span class="mt-1 text-sm text-textcolor2">
                    {language.pluginFullStorageAccessDesc.replace('{}', storageSizeText(storageBytes))}
                    <a href={fullStorageGuideUrl()} target="_blank" rel="nofollow noopener noreferrer" class="text-blue-400 hover:underline">{language.pluginFullStorageAccessGuide}</a>
                </span>
                {#if storageBytes >= FULL_STORAGE_WARN_BYTES}
                    <span class="mt-1 text-sm text-draculared">{language.pluginFullStorageAccessLarge}</span>
                {/if}
                {#if hasParams(plugin)}
                    <div aria-hidden="true" class="w-full border-t border-darkborderc mt-4"></div>
                {/if}
            {/if}
            {#each Object.keys(plugin.arguments ?? {}) as arg}
                {#if !arg.startsWith("hidden_")}
                    {#if typeof(plugin?.argMeta?.[arg]?.divider) === 'string'}
                        {#if plugin?.argMeta?.[arg]?.divider}
                            <div class="flex items-center mt-6">
                                <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                <div class="relative flex justify-center">
                                    <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                                </div>
                                <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                            </div>
                        {:else}
                            <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                        {/if}
                    {/if}
                    <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                    {#if plugin?.argMeta?.[arg]?.description}
                        <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                    {/if}
                    {#if Array.isArray(plugin.arguments[arg])}
                        <SelectInput
                            className="mt-2 mb-4"
                            bind:value={
                                DBState.db.plugins[index].realArg[arg] as string
                            }
                        >
                            {#each plugin.arguments[arg] as a}
                                <OptionInput value={a}>{a}</OptionInput>
                            {/each}
                        </SelectInput>
                    {:else if plugin.arguments[arg] === "string"}

                        {#if plugin?.argMeta?.[arg]?.textarea}
                            <TextAreaInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as string
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {:else if plugin?.argMeta?.[arg]?.radio}
                            {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                <CheckInput
                                    check={DBState.db.plugins[index].realArg[arg] === (radioOption.split('|').at(-1))}
                                    onChange={(e) => {
                                        if(e){
                                            DBState.db.plugins[index].realArg[arg] = (radioOption.split('|').at(-1))
                                        }
                                    }}
                                    margin={false}
                                    name={radioOption.split('|').at(0)}
                                />
                            {/each}
                        {:else}
                            <TextInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as string
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {/if}
                    {:else if plugin.arguments[arg] === "int"}
                        {#if plugin?.argMeta?.[arg]?.checkbox}
                            <CheckInput
                                check={DBState.db.plugins[index].realArg[arg] === '1'}
                                onChange={(e) => {
                                    DBState.db.plugins[index].realArg[arg] = e ? '1' : '0'
                                }}
                                margin={false}
                                name={
                                    plugin?.argMeta?.[arg]?.checkbox === '1' ? language.enable : plugin?.argMeta?.[arg]?.checkbox
                                }
                            />
                        {:else if plugin?.argMeta?.[arg]?.radio}
                            {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                <CheckInput
                                    check={DBState.db.plugins[index].realArg[arg] === parseInt(radioOption.split('|').at(-1))}
                                    onChange={(e) => {
                                        if(e){
                                            DBState.db.plugins[index].realArg[arg] = parseInt(radioOption.split('|').at(-1))
                                        }
                                    }}
                                    margin={false}
                                    name={radioOption.split('|').at(0)}
                                />
                            {/each}
                        {:else}
                            <NumberInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as number
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {/if}
                    {/if}
                {/if}
            {/each}
        </div>
    {/snippet}
    {#snippet itemMenu(index)}
        <ShDropdownMenuItem onSelect={() => resetPermission(index)}><ShieldIcon /><span>{language.resetPluginPermission}</span></ShDropdownMenuItem>
    {/snippet}
</FolderedList>
{#if !DBState.db.plugins || DBState.db.plugins.length === 0}
    <span class="text-textcolor2 p-3">{language.noPlugins}</span>
{/if}
</SettingPage>
