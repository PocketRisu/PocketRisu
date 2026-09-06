<script lang="ts">
    // Character manager: the management surface for the sidebar rail.
    // Desktop: overlay above the chat (z-40, chat stays mounted). Mobile:
    // mounted inline in the characters tab (`inline`, search from the header).
    // See .agent/notes/character-manager-plan.md.
    import { onDestroy } from "svelte";
    import { v4 } from "uuid";
    import {
        ArchiveIcon, ArchiveRestoreIcon, DownloadIcon, EyeIcon, EyeOffIcon, FolderIcon, FolderPlusIcon,
        PlusIcon, SearchIcon, SettingsIcon, SquareArrowOutUpRightIcon, TrashIcon, Undo2Icon, XIcon,
    } from "@lucide/svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShSelect from "src/lib/UI/GUI/ShSelect.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import ShDropdownMenuSeparator from "src/lib/UI/GUI/ShDropdownMenuSeparator.svelte";
    import CharacterRow from "./CharacterRow.svelte";
    import CharacterOrderList from "./CharacterOrderList.svelte";
    import { createIncrementalList } from "src/lib/UI/incrementalList.svelte";
    import {
        DBState, openCharacterManager, folderSettingsTarget, selectedCharID, settingsOpen,
        SettingsMenuIndex, AccessibilitySubmenuIndex, MobileGUI, MobileGUIStack,
    } from "src/ts/stores.svelte";
    import { addCharacter, changeChar, getCharImage, removeChar } from "src/ts/characters";
    import { exportChar } from "src/ts/characterCards";
    import { activateCharacter, archiveCharacter, deleteTrashedCharacter, promptActivateCharacter, restoreTrashedCharacter, trashDeactivatedCharacter } from "src/ts/characterArchive";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { alertConfirm, alertError, alertInput, alertSelect } from "src/ts/alert";
    import { findCharacterIndexbyId } from "src/ts/util";
    import {
        buildManagerEntries, matchesFilter, matchesSearch, sortEntries,
        type ManagerEntry, type ManagerFilter, type ManagerSort,
    } from "src/ts/characterManager";
    import {
        createFolder, findPlacement, isFolderEntry, moveCharacterInFolder, moveCharacterToFolder,
        moveTopLevelEntry, rebuildOrder, removeFolderKeepItems, setHidden, type OrderLayoutItem,
    } from "src/ts/characterOrder";
    import type { folder } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";

    interface Props {
        inline?: boolean;
        /** Mobile header search; when given the manager hides its own search box. */
        externalSearch?: string;
    }

    let { inline = false, externalSearch }: Props = $props();

    let tab = $state(0); // 0 list, 1 trash, 2 grid
    let searchLocal = $state('');
    let sort = $state<ManagerSort>('order');
    let filter = $state<ManagerFilter>('all');
    let selectMode = $state(false);
    let gridCompact = $state(loadGridCompact());
    let selectedIds = $state<Set<string>>(new Set());

    let search = $derived(externalSearch ?? searchLocal);
    let entries = $derived(buildManagerEntries(DBState.db));
    let liveEntries = $derived([...entries.values()].filter((e) => !e.trashed));
    let trashEntries = $derived([...entries.values()].filter((e) => e.trashed).filter((e) => matchesSearch(e.name, search)));
    let visible = $derived((e: ManagerEntry) => matchesSearch(e.name, search) && matchesFilter(e, filter));
    let flatList = $derived(sortEntries(liveEntries.filter(visible), sort));
    // Grid tab: 'order' follows the rail sequence flattened (folders inlined); other sorts reuse flatList.
    let gridList = $derived.by(() => {
        if (sort !== 'order') return flatList;
        const out: ManagerEntry[] = [];
        const seen = new Set<string>();
        const push = (id: string) => {
            const e = entries.get(id);
            if (e && !e.trashed && !seen.has(id) && visible(e)) { seen.add(id); out.push(e); }
        };
        for (const entry of DBState.db.characterOrder) {
            if (isFolderEntry(entry)) entry.data.forEach(push);
            else push(entry);
        }
        return out;
    });
    let dragDisabled = $derived(search.length > 0 || filter !== 'all' || selectMode);
    let activeChaId = $derived(DBState.db.characters[$selectedCharID]?.chaId);
    let folders = $derived(DBState.db.characterOrder.filter(isFolderEntry));

    function loadGridCompact(): boolean {
        try { return localStorage.getItem('risu-character-manager-grid-compact') === '1'; } catch { return false; }
    }
    function setGridCompact(v: boolean) {
        gridCompact = v;
        try { localStorage.setItem('risu-character-manager-grid-compact', v ? '1' : '0'); } catch {}
    }

    const incremental = createIncrementalList({ pageSize: 60 });
    $effect(() => {
        // New sort/filter/search → start the flat list from the top again.
        void flatList; void gridList;
        incremental.reset();
    });

    onDestroy(() => {
        // Leaving the manager never keeps a stale selection around.
        selectedIds = new Set();
    });

    function close() {
        if (!inline) openCharacterManager.set(false);
    }

    function commitOrder(next: typeof DBState.db.characterOrder) {
        DBState.db.characterOrder = next;
        checkCharOrder();
    }

    async function open(entry: ManagerEntry) {
        if (entry.archived) {
            if (await promptActivateCharacter(entry.chaId)) close();
            return;
        }
        if (entry.index < 0) return;
        changeChar(entry.index);
        close();
    }

    function toggleSelect(entry: ManagerEntry) {
        const next = new Set(selectedIds);
        if (next.has(entry.chaId)) next.delete(entry.chaId);
        else next.add(entry.chaId);
        selectedIds = next;
    }

    function setHiddenFor(chaIds: string[], value: boolean) {
        DBState.db.nodeOnlyHiddenCharacterIds = setHidden(DBState.db.nodeOnlyHiddenCharacterIds ?? [], chaIds, value);
    }

    async function moveToFolderPrompt(chaIds: string[]) {
        const options = [...folders.map((f) => f.name), language.noFolder, language.cancel];
        const sel = parseInt(await alertSelect(options));
        if (Number.isNaN(sel) || sel >= options.length - 1) return;
        const folderId = sel < folders.length ? folders[sel].id : undefined;
        let next = DBState.db.characterOrder;
        for (const id of chaIds) next = moveCharacterToFolder(next, id, folderId);
        commitOrder(next);
    }

    function moveEntry(entry: ManagerEntry, delta: -1 | 1) {
        const placement = findPlacement(DBState.db.characterOrder, entry.chaId);
        if (!placement) return;
        commitOrder(placement.folderId
            ? moveCharacterInFolder(DBState.db.characterOrder, placement.folderId, entry.chaId, delta)
            : moveTopLevelEntry(DBState.db.characterOrder, entry.chaId, delta));
    }

    async function deactivate(entry: ManagerEntry) {
        if (entry.index < 0) return;
        await archiveCharacter(entry.index);
    }

    async function activate(entry: ManagerEntry) {
        try {
            await activateCharacter(entry.chaId);
        } catch (error) {
            alertError(language.activateCharacterFailed + (error instanceof Error ? error.message : String(error)));
        }
    }

    async function exportEntry(entry: ManagerEntry) {
        if (entry.index < 0) return;
        await exportChar(entry.index);
    }

    // Trash = deactivated + marker. A deactivated character just gets the
    // marker; an active one goes through removeChar (deactivate + marker).
    async function trash(entry: ManagerEntry) {
        if (entry.archived) {
            if (!await alertConfirm(language.moveToTrashConfirm + entry.name)) return;
            trashDeactivatedCharacter(entry.chaId);
            return;
        }
        await removeChar(entry.chaId, entry.name);
    }

    // Legacy trash (live character with trashTime) and the new shape both restore.
    function restore(entry: ManagerEntry) {
        if (entry.archived) {
            restoreTrashedCharacter(entry.chaId);
            return;
        }
        const idx = findCharacterIndexbyId(entry.chaId);
        if (idx === -1) return;
        DBState.db.characters[idx].trashTime = undefined;
        checkCharOrder();
    }

    async function deleteArchivedRows(entry: ManagerEntry) {
        try {
            await deleteTrashedCharacter(entry.chaId);
        } catch (error) {
            alertError(language.deleteCharacterFailed + (error instanceof Error ? error.message : String(error)));
        }
    }

    async function deletePermanently(entry: ManagerEntry) {
        if (!entry.archived) {
            await removeChar(entry.chaId, entry.name, 'permanent');
            return;
        }
        if (!await alertConfirm(language.removeConfirm + entry.name)) return;
        if (!await alertConfirm(language.removeConfirm2 + entry.name)) return;
        await deleteArchivedRows(entry);
    }

    async function emptyTrash() {
        const targets = [...entries.values()].filter((e) => e.trashed);
        if (targets.length === 0) return;
        if (!await alertConfirm(language.emptyTrashConfirm(targets.length))) return;
        for (const e of targets) {
            if (e.archived) await deleteArchivedRows(e);
            else await removeChar(e.chaId, e.name, 'permanentForce');
        }
    }

    async function newFolder() {
        const name = (await alertInput(language.folderNameInput))?.trim();
        if (!name) return;
        commitOrder(createFolder(DBState.db.characterOrder, v4(), name));
    }

    async function deleteFolder(f: folder) {
        if (!await alertConfirm(language.folderDeleteKeepItems)) return;
        commitOrder(removeFolderKeepItems(DBState.db.characterOrder, f.id));
    }

    function onLayoutChange(layout: OrderLayoutItem[]) {
        commitOrder(rebuildOrder(DBState.db.characterOrder, layout));
    }

    async function addNew() {
        close();
        await addCharacter();
    }

    function openListSettings() {
        close();
        SettingsMenuIndex.set(11);
        AccessibilitySubmenuIndex.set(4);
        if ($MobileGUI) MobileGUIStack.set(2);
        else settingsOpen.set(true);
    }

    // Bulk actions on the current selection (live characters only).
    function selectedEntries(): ManagerEntry[] {
        return [...selectedIds].map((id) => entries.get(id)).filter((e): e is ManagerEntry => !!e && !e.trashed);
    }

    function clearSelection() {
        selectedIds = new Set();
    }

    function bulkHidden(value: boolean) {
        setHiddenFor(selectedEntries().map((e) => e.chaId), value);
        clearSelection();
    }

    async function bulkMove() {
        await moveToFolderPrompt(selectedEntries().map((e) => e.chaId));
        clearSelection();
    }

    async function bulkDeactivate() {
        const targets = selectedEntries().filter((e) => !e.archived);
        if (targets.length === 0) return;
        if (!await alertConfirm(language.deactivateSelectedConfirm(targets.length))) return;
        for (const e of targets) {
            // Re-resolve every time: each deactivation shifts db.characters.
            const idx = findCharacterIndexbyId(e.chaId);
            if (idx === -1) continue;
            const ok = await archiveCharacter(idx, { skipConfirm: true });
            if (!ok) break;
        }
        clearSelection();
    }

    async function bulkTrash() {
        const targets = selectedEntries();
        if (targets.length === 0) return;
        if (!await alertConfirm(language.trashSelectedConfirm(targets.length))) return;
        for (const e of targets) {
            if (e.archived) trashDeactivatedCharacter(e.chaId);
            else await removeChar(e.chaId, e.name, 'normal', { skipConfirm: true });
        }
        clearSelection();
    }
</script>

{#snippet rowMenu(entry: ManagerEntry)}
    <ShDropdownMenuItem onSelect={() => open(entry)}><SquareArrowOutUpRightIcon /><span>{language.openCharacter}</span></ShDropdownMenuItem>
    {#if entry.hidden}
        <ShDropdownMenuItem onSelect={() => setHiddenFor([entry.chaId], false)}><EyeIcon /><span>{language.showInSidebar}</span></ShDropdownMenuItem>
    {:else}
        <ShDropdownMenuItem onSelect={() => setHiddenFor([entry.chaId], true)}><EyeOffIcon /><span>{language.hideFromSidebar}</span></ShDropdownMenuItem>
    {/if}
    <ShDropdownMenuItem onSelect={() => moveToFolderPrompt([entry.chaId])}><FolderIcon /><span>{language.folderMoveTo}</span></ShDropdownMenuItem>
    {#if sort === 'order'}
        <ShDropdownMenuItem onSelect={() => moveEntry(entry, -1)}><span>{language.moveUp}</span></ShDropdownMenuItem>
        <ShDropdownMenuItem onSelect={() => moveEntry(entry, 1)}><span>{language.moveDown}</span></ShDropdownMenuItem>
    {/if}
    <ShDropdownMenuSeparator />
    {#if entry.archived}
        <ShDropdownMenuItem onSelect={() => activate(entry)}><ArchiveRestoreIcon /><span>{language.activateCharacter}</span></ShDropdownMenuItem>
        <ShDropdownMenuItem variant="destructive" onSelect={() => trash(entry)}><TrashIcon /><span>{language.moveToTrash}</span></ShDropdownMenuItem>
    {:else}
        <ShDropdownMenuItem onSelect={() => deactivate(entry)}><ArchiveIcon /><span>{language.deactivateCharacter}</span></ShDropdownMenuItem>
        <ShDropdownMenuItem onSelect={() => exportEntry(entry)}><DownloadIcon /><span>{language.exportCharacter}</span></ShDropdownMenuItem>
        <ShDropdownMenuItem variant="destructive" onSelect={() => trash(entry)}><TrashIcon /><span>{language.moveToTrash}</span></ShDropdownMenuItem>
    {/if}
{/snippet}

{#snippet trashMenu(entry: ManagerEntry)}
    <ShDropdownMenuItem onSelect={() => restore(entry)}><Undo2Icon /><span>{language.restore}</span></ShDropdownMenuItem>
    <ShDropdownMenuSeparator />
    <ShDropdownMenuItem variant="destructive" onSelect={() => deletePermanently(entry)}><TrashIcon /><span>{language.deletePermanently}</span></ShDropdownMenuItem>
{/snippet}

{#snippet folderMenu(f: folder)}
    <ShDropdownMenuItem onSelect={() => folderSettingsTarget.set(f.id)}><SettingsIcon /><span>{language.folderSettings}</span></ShDropdownMenuItem>
    <ShDropdownMenuItem onSelect={() => commitOrder(moveTopLevelEntry(DBState.db.characterOrder, f.id, -1))}><span>{language.moveUp}</span></ShDropdownMenuItem>
    <ShDropdownMenuItem onSelect={() => commitOrder(moveTopLevelEntry(DBState.db.characterOrder, f.id, 1))}><span>{language.moveDown}</span></ShDropdownMenuItem>
    <ShDropdownMenuSeparator />
    <ShDropdownMenuItem variant="destructive" onSelect={() => deleteFolder(f)}><TrashIcon /><span>{language.remove}</span></ShDropdownMenuItem>
{/snippet}

{#snippet body()}
    <div class="flex items-center gap-2 px-4 pt-4 pb-2 text-textcolor">
        <h2 class="m-0 text-base font-semibold grow truncate">{language.characterManager}</h2>
        <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors" title={language.characterListSettings} aria-label={language.characterListSettings} onclick={openListSettings}>
            <SettingsIcon size={20} />
        </button>
        {#if !inline}
            <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors" aria-label={language.close} onclick={close}>
                <XIcon size={22} />
            </button>
        {/if}
    </div>

    <div class="px-4">
        <SettingTabs tabs={[{ label: language.character, value: 0 }, { label: language.grid, value: 2 }, { label: language.trash, value: 1 }]} bind:selected={tab} />
    </div>

    {#if tab === 0 || tab === 2}
        <div class="mx-4 mb-3 rounded-md border border-darkborderc bg-bgcolor px-3 py-2 text-xs text-textcolor2">{language.characterManagerHint}</div>
        <div class="flex flex-col gap-2 px-4 pb-3">
            <div class="flex items-center gap-2">
                {#if externalSearch === undefined}
                    <div class="risu-field-border flex h-8 items-center gap-2 rounded-md px-2.5 grow min-w-0">
                        <SearchIcon size={14} class="text-textcolor2 shrink-0"/>
                        <input bind:value={searchLocal} placeholder={language.search} class="w-full bg-transparent text-sm text-textcolor outline-none"/>
                    </div>
                {:else}
                    <div class="grow"></div>
                {/if}
                <ShButton size="sm" variant="outline" onclick={newFolder}><FolderPlusIcon /><span class="max-sm:hidden">{language.folderNew}</span></ShButton>
                <ShButton size="sm" onclick={addNew}><PlusIcon /><span class="max-sm:hidden">{language.addCharacter}</span></ShButton>
            </div>
            <div class="flex items-center gap-2">
                <ShSelect bind:value={sort} size="sm" className="w-36 max-sm:grow">
                    <OptionInput value="order">{language.sortSidebarOrder}</OptionInput>
                    <OptionInput value="recent">{language.sortRecentChats}</OptionInput>
                    <OptionInput value="name">{language.sortByName}</OptionInput>
                    <OptionInput value="created">{language.sortByCreated}</OptionInput>
                    <OptionInput value="chats">{language.sortByChatCount}</OptionInput>
                </ShSelect>
                <ShSelect bind:value={filter} size="sm" className="w-36 max-sm:grow">
                    <OptionInput value="all">{language.filterAll}</OptionInput>
                    <OptionInput value="hidden">{language.filterHiddenOnly}</OptionInput>
                    <OptionInput value="archived">{language.filterArchivedOnly}</OptionInput>
                </ShSelect>
                <div class="grow max-sm:hidden"></div>
                {#if tab === 0}
                    <ShToggle bind:pressed={selectMode} size="sm" onPressedChange={(v) => { if (!v) clearSelection() }}>{language.select}</ShToggle>
                {:else}
                    <label class="flex items-center gap-2 cursor-pointer select-none text-sm text-textcolor2">
                        <ShSwitch checked={gridCompact} onCheckedChange={setGridCompact} />
                        {language.gridHideNames}
                    </label>
                {/if}
            </div>
        </div>

        {#if filter === 'hidden'}
            <div class="px-4 pb-2 text-xs text-textcolor2">{language.hiddenFromSidebarHint}</div>
        {/if}

        {#if selectMode && tab === 0}
            <div class="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-darkborderc bg-bgcolor px-3 py-2 text-sm text-textcolor">
                <span class="font-medium">{language.selectionCount(selectedIds.size)}</span>
                <div class="grow"></div>
                <ShButton variant="ghost" size="xs" disabled={selectedIds.size === 0} onclick={() => bulkHidden(true)}><EyeOffIcon />{language.hideFromSidebar}</ShButton>
                <ShButton variant="ghost" size="xs" disabled={selectedIds.size === 0} onclick={() => bulkHidden(false)}><EyeIcon />{language.showInSidebar}</ShButton>
                <ShButton variant="ghost" size="xs" disabled={selectedIds.size === 0} onclick={bulkMove}><FolderIcon />{language.folderMoveTo}</ShButton>
                <ShButton variant="ghost" size="xs" disabled={selectedIds.size === 0} onclick={bulkDeactivate}><ArchiveIcon />{language.deactivateCharacter}</ShButton>
                <ShButton variant="destructive" size="xs" disabled={selectedIds.size === 0} onclick={bulkTrash}><TrashIcon />{language.trash}</ShButton>
                <ShButton variant="outline" size="xs" onclick={clearSelection}>{language.clearSelection}</ShButton>
            </div>
        {/if}

        {#if tab === 2}
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
            {#if gridList.length === 0}
                <div class="py-8 text-center text-sm text-textcolor2">{language.noCharactersFound}</div>
            {:else}
                <div class="grid {gridCompact ? 'gap-1.5 grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))]' : 'gap-3 grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]'}">
                    {#each incremental.slice(gridList) as entry (entry.chaId)}
                        <button
                            type="button"
                            class="flex flex-col items-center gap-1 rounded-md text-textcolor transition-colors {gridCompact ? 'p-0.5' : 'p-1.5'} {activeChaId === entry.chaId ? 'bg-selected' : 'risu-interactive-surface'}"
                            class:opacity-60={entry.archived}
                            title={entry.name}
                            onclick={() => open(entry)}
                        >
                            <div class="relative" class:grayscale={entry.archived}>
                                {#await getCharImage(entry.image, 'plain')}
                                    <div class="{gridCompact ? 'h-14 w-14' : 'h-16 w-16'} bg-skin-border" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons}></div>
                                {:then src}
                                    <img src={src || '/none.webp'} alt="" class="{gridCompact ? 'h-14 w-14' : 'h-16 w-16'} object-cover object-top bg-skin-border" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons} />
                                {/await}
                                {#if entry.archived}
                                    <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons}>
                                        <ArchiveIcon size={18} class="text-white/90" />
                                    </div>
                                {:else if entry.hidden}
                                    <div class="pointer-events-none absolute -right-1 -bottom-1 rounded-full bg-darkbg border border-darkborderc p-0.5 text-textcolor2">
                                        <EyeOffIcon size={11} />
                                    </div>
                                {/if}
                            </div>
                            {#if !gridCompact}
                                <span class="w-full text-center text-xs leading-tight line-clamp-2 break-all">{entry.name}</span>
                            {/if}
                        </button>
                    {/each}
                </div>
                {#if incremental.hasMore(gridList.length)}
                    <div class="h-1" use:incremental.observeSentinel={gridList.length}></div>
                {/if}
            {/if}
        </div>
        {:else}
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
            {#if liveEntries.length === 0}
                <div class="py-8 text-center text-sm text-textcolor2">{language.noCharactersFound}</div>
            {:else if sort === 'order'}
                <CharacterOrderList
                    order={DBState.db.characterOrder}
                    {entries}
                    {visible}
                    {dragDisabled}
                    selectable={selectMode}
                    {selectedIds}
                    {activeChaId}
                    onOpen={open}
                    onToggleSelect={toggleSelect}
                    {onLayoutChange}
                    {rowMenu}
                    {folderMenu}
                />
            {:else}
                <div class="flex flex-col gap-1">
                    {#each incremental.slice(flatList) as entry (entry.chaId)}
                        <CharacterRow
                            {entry}
                            selectable={selectMode}
                            selected={selectedIds.has(entry.chaId)}
                            active={activeChaId === entry.chaId}
                            onOpen={open}
                            onToggleSelect={toggleSelect}
                            menu={rowMenu}
                        />
                    {:else}
                        <div class="py-8 text-center text-sm text-textcolor2">{language.noCharactersFound}</div>
                    {/each}
                    {#if incremental.hasMore(flatList.length)}
                        <div class="h-1" use:incremental.observeSentinel={flatList.length}></div>
                    {/if}
                </div>
            {/if}
        </div>
        {/if}
    {:else}
        <div class="mx-4 mb-3 rounded-md border border-darkborderc bg-bgcolor px-3 py-2 text-xs text-textcolor2">{language.trashDesc}</div>
        <div class="flex items-center gap-2 px-4 pb-3">
            {#if externalSearch === undefined}
                <div class="risu-field-border flex h-8 items-center gap-2 rounded-md px-2.5 grow min-w-0">
                    <SearchIcon size={14} class="text-textcolor2 shrink-0"/>
                    <input bind:value={searchLocal} placeholder={language.search} class="w-full bg-transparent text-sm text-textcolor outline-none"/>
                </div>
            {:else}
                <div class="grow"></div>
            {/if}
            <ShButton size="sm" variant="destructive" disabled={trashEntries.length === 0} onclick={emptyTrash}><TrashIcon />{language.emptyTrash}</ShButton>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
            <div class="flex flex-col gap-1">
                {#each trashEntries as entry (entry.chaId)}
                    <CharacterRow {entry} onOpen={() => {}} menu={trashMenu} />
                {:else}
                    <div class="py-8 text-center text-sm text-textcolor2">{language.noCharactersFound}</div>
                {/each}
            </div>
        </div>
    {/if}
{/snippet}

{#if inline}
    <div class="flex flex-col h-full w-full">
        {@render body()}
    </div>
{:else}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="absolute inset-0 z-40 bg-black/50 flex justify-center items-center sm:p-6" onclick={(e) => { if (e.target === e.currentTarget) close() }}>
        <div class="bg-darkbg rounded-md border border-darkborderc flex flex-col w-full max-w-3xl h-full sm:max-h-[90vh] max-sm:rounded-none max-sm:border-0 overflow-hidden">
            {@render body()}
        </div>
    </div>
{/if}
