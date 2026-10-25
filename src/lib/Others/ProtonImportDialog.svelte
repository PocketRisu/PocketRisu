<script lang="ts">
    import { ChevronRightIcon, ExternalLinkIcon, FileIcon, FolderIcon, LoaderCircleIcon, SearchIcon, TriangleAlertIcon, CircleCheckIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";
    import { alertError } from "src/ts/alert";
    import {
        anySignal,
        findProtonLink,
        importProtonFile,
        isProtonImportable,
        isProtonPlugin,
        openProtonShare,
        protonImportDialogOpen,
        type ProtonEntry,
        type ProtonShare,
    } from "src/ts/proton/protonImport";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";
    import { cn } from "src/lib/utils";

    type Stage = 'input' | 'loading' | 'folder' | 'confirm' | 'downloading' | 'importing' | 'done' | 'notice';

    let linkText = $state('');
    let inputError = $state('');
    let stage = $state<Stage>('input');
    let url = $state<string | null>(null);
    // Folder path from the shared root to the folder on screen.
    let trail = $state<ProtonEntry[]>([]);
    let entries = $state<ProtonEntry[]>([]);
    let query = $state('');
    let onlyImportable = $state(true);
    let sortNewest = $state(false);
    let imported = $state<string[]>([]);
    let current = $state<ProtonEntry | null>(null);
    let progress = $state<{ downloaded: number, total?: number } | null>(null);
    let notice = $state<{ variant: 'warning' | 'destructive', message: string } | null>(null);
    let doneName = $state('');

    let share: ProtonShare | null = null;
    // session lives as long as the opened link; task only for one download.
    // Closing or opening another link aborts the session, and every async step
    // checks the session it started with before touching the screen.
    let session: AbortController | null = null;
    let task: AbortController | null = null;
    const folderCache = new Map<string, ProtonEntry[]>();

    const visible = $derived.by(() => {
        const q = query.trim().toLowerCase();
        const list = entries.filter((e) =>
            (!onlyImportable || e.type === 'folder' || isProtonImportable(e.name))
            && (!q || e.name.toLowerCase().includes(q)));
        if (!sortNewest) return list;
        return [...list].sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder')
            || (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    });
    const hiddenCount = $derived(onlyImportable
        ? entries.filter((e) => e.type === 'file' && !isProtonImportable(e.name)).length
        : 0);
    const percent = $derived(progress?.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : null);

    function reset() {
        session?.abort();
        session = null;
        task = null;
        share = null;
        folderCache.clear();
        linkText = '';
        inputError = '';
        stage = 'input';
        url = null;
        trail = [];
        entries = [];
        query = '';
        imported = [];
        current = null;
        progress = null;
        notice = null;
        doneName = '';
    }

    function showNotice(variant: 'warning' | 'destructive', message: string) {
        notice = { variant, message };
        stage = 'notice';
    }

    function fail(error: unknown, s: AbortController | null) {
        // The dialog was closed or another link opened; nobody is left to tell.
        if (!s || s.signal.aborted) return;
        console.error('[Proton]', error);
        showNotice('destructive', language.protonImportFailed);
    }

    async function openLink() {
        inputError = '';
        const found = findProtonLink(linkText);
        if (!found) {
            inputError = language.protonImportInvalidLink;
            return;
        }
        session?.abort();
        const s = new AbortController();
        session = s;
        share = null;
        folderCache.clear();
        imported = [];
        trail = [];
        url = found;
        stage = 'loading';
        try {
            const result = await openProtonShare(found, { signal: s.signal });
            if (s.signal.aborted) return;
            if (result.kind === 'password') return showNotice('warning', language.protonImportPassword);
            if (result.kind === 'unsupported') return showNotice('warning', language.protonImportLegacy);
            share = result.share;
            const root = share.root;
            if (root.type === 'folder') await enterFolder(root, []);
            else if (!isProtonImportable(root.name)) showNotice('warning', language.protonImportUnsupported);
            // A pasted link doesn't tell what it points to; installing code needs a yes.
            else if (isProtonPlugin(root.name)) {
                current = root;
                stage = 'confirm';
            }
            else await importEntry(root);
        } catch (error) {
            fail(error, s);
        }
    }

    async function enterFolder(folder: ProtonEntry, parents: ProtonEntry[]) {
        const s = session;
        let list = folderCache.get(folder.uid);
        if (!list) {
            stage = 'loading';
            list = await share.list(folder.uid, s.signal);
            if (s.signal.aborted) return;
            folderCache.set(folder.uid, list);
        }
        trail = [...parents, folder];
        entries = list;
        query = '';
        stage = 'folder';
    }

    async function navigate(folder: ProtonEntry, parents: ProtonEntry[]) {
        const s = session;
        try {
            await enterFolder(folder, parents);
        } catch (error) {
            fail(error, s);
        }
    }

    function backToStart() {
        if (trail.length > 0) stage = 'folder';
        else stage = 'input';
    }

    async function importEntry(entry: ProtonEntry) {
        const s = session;
        current = entry;
        progress = { downloaded: 0, total: entry.size };
        const controller = new AbortController();
        task = controller;
        stage = 'downloading';
        let data: Uint8Array;
        try {
            data = await share.download(entry, {
                signal: anySignal([s.signal, controller.signal]),
                onProgress: (downloaded, total) => { if (task === controller) progress = { downloaded, total }; },
            });
        } catch (error) {
            if (controller.signal.aborted && !s.signal.aborted) return backToStart();
            throw error;
        } finally {
            if (task === controller) task = null;
        }
        if (s.signal.aborted) return;
        stage = 'importing';
        // Importers report their own failures (and plugin confirmations) through
        // alerts, but a throw can leave their loading alert up with no way out.
        const ok = await importProtonFile(entry.name, data).catch((error) => {
            alertError(error);
            return false;
        });
        if (s.signal.aborted) return;
        if (ok) imported = [...imported, entry.uid];
        if (trail.length > 0) stage = 'folder';
        else if (ok) {
            doneName = entry.name;
            stage = 'done';
        }
        else stage = 'input';
    }

    async function pick(entry: ProtonEntry) {
        if (entry.type === 'folder') return navigate(entry, trail);
        if (!isProtonImportable(entry.name)) return;
        const s = session;
        try {
            await importEntry(entry);
        } catch (error) {
            fail(error, s);
        }
    }

    function formatBytes(bytes?: number): string {
        if (bytes == null) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatDate(ms?: number): string {
        if (!ms) return '';
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
</script>

<ShDialog
    bind:open={$protonImportDialogOpen}
    onOpenChange={(open) => { if (!open) reset(); }}
    size="lg"
    tier="base"
    closable={stage !== 'importing'}
    closeOnOutsideClick={false}
>
    {#snippet title()}{language.protonImportTitle}{/snippet}

    <div class="flex flex-col gap-3">
        {#if stage === 'input'}
            <p class="text-sm text-textcolor2">{language.protonImportDesc}</p>
            <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); openLink(); }}>
                <ShInput
                    bind:value={linkText}
                    className="flex-1 min-w-0"
                    placeholder="https://drive.proton.me/urls/..."
                    autocomplete="off"
                    spellcheck={false}
                />
                <ShButton type="submit" variant="primary" disabled={!linkText.trim()}>{language.protonImportOpen}</ShButton>
            </form>
            {#if inputError}
                <p class="text-sm text-draculared">{inputError}</p>
            {/if}
            <p class="text-xs text-textcolor2">{language.protonImportNotice}</p>
        {:else if stage === 'loading'}
            <div class="flex items-center gap-2 py-6 justify-center text-textcolor2">
                <LoaderCircleIcon size={18} class="animate-spin" />
                {language.protonImportLoading}
            </div>
        {:else if stage === 'folder'}
            <nav class="flex flex-wrap items-center gap-1 text-sm text-textcolor2">
                {#each trail as crumb, i (crumb.uid)}
                    {#if i > 0}<ChevronRightIcon size={14} />{/if}
                    {#if i < trail.length - 1}
                        <button type="button" class="hover:text-textcolor underline-offset-2 hover:underline" onclick={() => navigate(crumb, trail.slice(0, i))}>{crumb.name}</button>
                    {:else}
                        <span class="text-textcolor font-medium">{crumb.name}</span>
                    {/if}
                {/each}
            </nav>
            <div class="flex flex-wrap items-center gap-2">
                <div class="relative flex-1 min-w-40">
                    <SearchIcon size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none" />
                    <ShInput bind:value={query} className="pl-9" placeholder={language.search} autocomplete="off" />
                </div>
                <div class="flex">
                    <!-- Segmented pair: pressing the active one again keeps it on. -->
                    <ShToggle size="sm" bind:pressed={() => !sortNewest, (p) => { if (p) sortNewest = false; }} className="rounded-r-none">{language.protonImportSortName}</ShToggle>
                    <ShToggle size="sm" bind:pressed={() => sortNewest, (p) => { if (p) sortNewest = true; }} className="rounded-l-none -ml-px">{language.protonImportSortNewest}</ShToggle>
                </div>
            </div>
            <label class="flex items-center gap-2 text-sm text-textcolor2">
                <ShSwitch size="sm" bind:checked={onlyImportable} />
                {language.protonImportOnlyImportable}
                {#if hiddenCount > 0}<span>({language.protonImportHidden(hiddenCount)})</span>{/if}
            </label>
            <!-- Fixed height for big folders so filtering doesn't make the dialog jump. -->
            <ul class={cn('flex flex-col border border-darkborderc rounded-md divide-y divide-darkborderc overflow-y-auto', entries.length > 8 ? 'h-[50vh]' : 'max-h-[50vh]')}>
                {#each visible as entry (entry.uid)}
                    {@const usable = entry.type === 'folder' || isProtonImportable(entry.name)}
                    <li>
                        <button
                            type="button"
                            class="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-left transition-colors hover:bg-selected/30 disabled:opacity-50 disabled:hover:bg-transparent"
                            disabled={!usable}
                            onclick={() => pick(entry)}
                        >
                            {#if entry.type === 'folder'}
                                <FolderIcon size={18} class="text-textcolor2 shrink-0" />
                            {:else}
                                <FileIcon size={18} class="text-textcolor2 shrink-0" />
                            {/if}
                            <span class="flex flex-col min-w-0 flex-1">
                                <span class="text-textcolor break-all">{entry.name}</span>
                                {#if entry.type === 'file'}
                                    <span class="text-xs text-textcolor2">{[formatBytes(entry.size), formatDate(entry.modifiedAt)].filter(Boolean).join(', ')}</span>
                                {/if}
                            </span>
                            {#if imported.includes(entry.uid)}
                                <ShBadge variant="success">{language.protonImportImported}</ShBadge>
                            {/if}
                            {#if entry.type === 'folder'}
                                <ChevronRightIcon size={16} class="text-textcolor2 shrink-0" />
                            {/if}
                        </button>
                    </li>
                {:else}
                    <li class="px-3 py-6 text-center text-sm text-textcolor2">{language.protonImportEmpty}</li>
                {/each}
            </ul>
        {:else if stage === 'confirm' && current}
            <ShAlert variant="warning">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.protonImportPluginConfirm(current.name)}
            </ShAlert>
            <div class="flex flex-wrap justify-end gap-2">
                <ShButton variant="outline" onclick={backToStart}>{language.cancel}</ShButton>
                <ShButton variant="primary" onclick={() => pick(current)}>{language.protonImportInstall}</ShButton>
            </div>
        {:else if stage === 'downloading' || stage === 'importing'}
            <div class="flex flex-col gap-2 py-2">
                <div class="flex items-center gap-2 text-textcolor">
                    <LoaderCircleIcon size={18} class="animate-spin shrink-0" />
                    <span class="break-all">{current?.name}</span>
                </div>
                {#if stage === 'downloading'}
                    <div class="h-2 rounded-full bg-selected overflow-hidden">
                        <div class="h-full bg-primary transition-[width]" style:width={`${percent ?? 0}%`}></div>
                    </div>
                    <div class="flex items-center justify-between text-sm text-textcolor2">
                        <span>{formatBytes(progress?.downloaded)}{progress?.total ? ` / ${formatBytes(progress.total)}` : ''}</span>
                        <ShButton size="sm" variant="outline" onclick={() => task?.abort()}>{language.cancel}</ShButton>
                    </div>
                {:else}
                    <p class="text-sm text-textcolor2">{language.protonImportImporting}</p>
                {/if}
            </div>
        {:else if stage === 'done'}
            <ShAlert variant="success">
                {#snippet icon()}<CircleCheckIcon />{/snippet}
                {language.protonImportDone(doneName)}
            </ShAlert>
            <div class="flex justify-end">
                <ShButton variant="outline" onclick={() => { stage = 'input'; linkText = ''; }}>{language.protonImportAnother}</ShButton>
            </div>
        {:else if stage === 'notice' && notice}
            <ShAlert variant={notice.variant}>
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {notice.message}
            </ShAlert>
            <div class="flex flex-wrap justify-end gap-2">
                <ShButton variant="outline" onclick={backToStart}>
                    {trail.length > 0 ? language.protonImportBackToList : language.protonImportAnother}
                </ShButton>
                {#if url}
                    <ShButton variant="primary" onclick={() => openURL(url)}>
                        {language.protonImportOpenInProton}
                        <ExternalLinkIcon size={14} />
                    </ShButton>
                {/if}
            </div>
        {/if}
    </div>
</ShDialog>
