<script lang="ts">
    // System → Plugin Storage tab. Built-in replacement for the community
    // "plugin-storage-viewer" plugin. Plugin data is stored in a single global
    // namespace (not per-plugin), so this is a flat key/value manager over the
    // three backends a plugin can write to:
    //   - save:  db.pluginCustomStorage  (travels with the save file)
    //   - local: localStorage `safe_plugin_*`  (device-local, strings only)
    //   - idb:   SafeLocalPluginStorage  (IndexedDB, device-local, JSON)
    // Origin plugin is best-effort: new V3 writes are tagged into a sidecar
    // meta store (pluginStorageMeta), but legacy/V2 keys have no record and show
    // as unknown. Edit/delete are allowed directly, guarded by confirm.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import {
        RefreshCwIcon,
        Trash2Icon,
        PencilIcon,
        AlignLeftIcon,
        SaveIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { getDatabase } from 'src/ts/storage/database.svelte'
    import { SafeLocalStorage, SafeLocalPluginStorage } from 'src/ts/plugins/pluginSafeClass'
    import { getOwners, removeOwner } from 'src/ts/plugins/pluginStorageMeta'
    import { language } from 'src/lang'

    type BackendId = 'save' | 'local' | 'idb'

    // Sentinel filter value for entries with no recorded origin plugin.
    const UNKNOWN = '__risu_unknown__'

    interface Entry {
        key: string
        raw: unknown
        str: string
        size: number
        type: string
        owner?: string
    }

    const BACKENDS: { id: BackendId; label: () => string; desc: () => string }[] = [
        { id: 'save', label: () => language.pluginStorageBackendSave, desc: () => language.pluginStorageBackendSaveDesc },
        { id: 'local', label: () => language.pluginStorageBackendLocal, desc: () => language.pluginStorageBackendLocalDesc },
        { id: 'idb', label: () => language.pluginStorageBackendIdb, desc: () => language.pluginStorageBackendIdbDesc },
    ]

    const safeLocal = new SafeLocalStorage()
    const idb = new SafeLocalPluginStorage()

    let backendIndex = $state(0)
    const backend = $derived(BACKENDS[backendIndex].id)
    let entries = $state<Entry[]>([])
    let loading = $state(false)
    let loadError = $state<string | null>(null)
    let loadProgress = $state(0)
    let loadTotal = $state(0)
    // Monotonic token: a newer load() invalidates any in-flight older one
    // (e.g. when the user switches backend tabs mid-load).
    let loadToken = 0
    let searchKey = $state('')
    let searchVal = $state('')
    let ownerFilter = $state('')   // '' = all; UNKNOWN = no recorded origin; else plugin name

    let detailOpen = $state(false)
    let selected = $state<Entry | null>(null)
    let editing = $state(false)
    let editText = $state('')
    let saving = $state(false)

    const filtered = $derived.by(() => {
        const k = searchKey.trim().toLowerCase()
        const v = searchVal.trim().toLowerCase()
        const f = ownerFilter
        return entries.filter((e) => {
            const keyMatch = !k || e.key.toLowerCase().includes(k)
            const valMatch = !v || e.str.toLowerCase().includes(v)
            const ownerMatch =
                !f || (f === UNKNOWN ? !e.owner : e.owner === f)
            return keyMatch && valMatch && ownerMatch
        })
    })

    // True when any search/owner filter narrows the list — drives the bulk
    // button label (delete-shown vs clear-all).
    const isFiltered = $derived(
        searchKey.trim() !== '' || searchVal.trim() !== '' || ownerFilter !== '',
    )

    // Distinct origin plugins present in the current backend, for the filter.
    const ownerOptions = $derived.by(() => {
        const set = new Set<string>()
        for (const e of entries) if (e.owner) set.add(e.owner)
        return [...set].sort((a, b) => a.localeCompare(b))
    })
    const hasUnknown = $derived(entries.some((e) => !e.owner))

    // ── helpers ────────────────────────────────────────────────────────────
    function valueToString(val: unknown): string {
        if (typeof val === 'string') return val
        if (val === null || val === undefined) return ''
        try {
            return JSON.stringify(val)
        } catch {
            return String(val)
        }
    }

    function detectType(raw: string): string {
        if (!raw) return 'empty'
        try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return 'array'
            if (typeof parsed === 'object' && parsed !== null) return 'object'
            return typeof parsed
        } catch {
            return 'string'
        }
    }

    function prettyPrint(raw: string): string {
        try {
            return JSON.stringify(JSON.parse(raw), null, 2)
        } catch {
            return raw
        }
    }

    function formatSize(bytes: number): string {
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    // ── backend access ───────────────────────────────────────────────────────
    async function backendSet(key: string, value: unknown): Promise<void> {
        if (backend === 'save') {
            const db = getDatabase()
            db.pluginCustomStorage ??= {}
            db.pluginCustomStorage[key] = value
            return
        }
        if (backend === 'local') {
            safeLocal.setItem(key, value as string)
            return
        }
        await idb.setItem(key, value)
    }

    async function backendRemove(key: string): Promise<void> {
        // Drop the value, then its origin record so the sidecar doesn't keep a
        // dangling entry. (The idb instance here has no owner, so its own
        // removeItem won't touch meta — we clean it explicitly.)
        if (backend === 'save') {
            const db = getDatabase()
            db.pluginCustomStorage ??= {}
            delete db.pluginCustomStorage[key]
        } else if (backend === 'local') {
            safeLocal.removeItem(key)
        } else {
            await idb.removeItem(key)
        }
        await removeOwner(backend, key)
    }

    // ── actions ────────────────────────────────────────────────────────────
    async function load() {
        const token = ++loadToken
        loading = true
        loadError = null
        loadProgress = 0
        loadTotal = 0
        entries = []
        try {
            // Resolve the key list and a per-key value reader ONCE. Previously
            // the save backend re-snapshotted the entire DB on every key, which
            // froze the UI on large saves before anything could paint.
            let keys: string[]
            let read: (key: string) => unknown | Promise<unknown>
            if (backend === 'save') {
                const store = $state.snapshot(getDatabase().pluginCustomStorage ?? {}) as Record<string, unknown>
                keys = Object.keys(store)
                read = (k) => store[k] ?? null
            } else if (backend === 'local') {
                keys = safeLocal.keys()
                read = (k) => safeLocal.getItem(k)
            } else {
                keys = await idb.keys()
                read = (k) => idb.getItem(k)
            }
            if (token !== loadToken) return
            loadTotal = keys.length

            // Best-effort origin map (key → plugin name). Empty for legacy/V2
            // keys written before tagging existed.
            const owners = await getOwners(backend)
            if (token !== loadToken) return

            // Yield once so the page shell paints before the stringify loop.
            await new Promise((r) => setTimeout(r))

            const list: Entry[] = []
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]
                const raw = await read(key)
                const str = valueToString(raw)
                list.push({ key, raw, str, size: str.length * 2, type: detectType(str), owner: owners[key] })
                loadProgress = i + 1
                // Periodically yield to keep the UI responsive and let the
                // progress bar update.
                if ((i & 63) === 63) {
                    await new Promise((r) => setTimeout(r))
                    if (token !== loadToken) return
                }
            }
            if (token !== loadToken) return
            list.sort((a, b) => a.key.localeCompare(b.key))
            entries = list
        } catch (e) {
            if (token !== loadToken) return
            loadError = e instanceof Error ? e.message : String(e)
            entries = []
        } finally {
            if (token === loadToken) loading = false
        }
    }

    function openDetail(entry: Entry) {
        selected = entry
        editing = false
        editText = prettyPrint(entry.str)
        detailOpen = true
    }

    function startEdit() {
        if (!selected) return
        editText = prettyPrint(selected.str)
        editing = true
    }

    function formatJson() {
        try {
            editText = JSON.stringify(JSON.parse(editText), null, 2)
        } catch (e) {
            notifyError(language.pluginStorageJsonError(e instanceof Error ? e.message : String(e)))
        }
    }

    async function saveEdit() {
        if (!selected) return
        saving = true
        try {
            let saveValue: unknown
            if (backend === 'local') {
                // localStorage holds strings; normalize valid JSON, keep raw otherwise.
                saveValue = editText
                try {
                    saveValue = JSON.stringify(JSON.parse(editText))
                } catch {}
            } else {
                // save/idb keep parsed JSON when possible, raw string otherwise.
                try {
                    saveValue = JSON.parse(editText)
                } catch {
                    saveValue = editText
                }
            }
            await backendSet(selected.key, saveValue)
            const savedKey = selected.key
            await load()
            selected = entries.find((e) => e.key === savedKey) ?? null
            editing = false
            if (!selected) detailOpen = false
            notifySuccess(language.pluginStorageSaved(savedKey))
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
        } finally {
            saving = false
        }
    }

    async function removeEntry(entry: Entry) {
        const ok = await alertConfirm(language.pluginStorageDeleteConfirm(entry.key))
        if (!ok) return
        try {
            await backendRemove(entry.key)
            if (selected?.key === entry.key) detailOpen = false
            await load()
            notifySuccess(language.pluginStorageDeleted)
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
        }
    }

    // Bulk-delete every entry currently shown (i.e. matching the active search /
    // owner filter). With no filter this is the whole backend, so one button
    // serves both partial and full clears. The label reflects which it is.
    async function removeFiltered() {
        // Snapshot before load() swaps `entries` out from under `filtered`.
        const targets = filtered.slice()
        if (targets.length === 0) return

        const isAll = targets.length === entries.length
        const backendLabel = BACKENDS[backendIndex].label()
        const msg = isAll
            ? language.pluginStorageBulkDeleteAllConfirm(backendLabel, targets.length)
            : language.pluginStorageBulkDeleteConfirm(backendLabel, targets.length)
        const ok = await alertConfirm(msg)
        if (!ok) return

        try {
            if (backend === 'save') {
                // Drop all values in one pass to avoid re-resolving the reactive
                // DB per key, then clean up the origin records.
                const db = getDatabase()
                db.pluginCustomStorage ??= {}
                for (const e of targets) delete db.pluginCustomStorage[e.key]
                for (const e of targets) await removeOwner('save', e.key)
            } else {
                for (const e of targets) await backendRemove(e.key)
            }
            detailOpen = false
            await load()
            notifySuccess(language.pluginStorageBulkDeleted(targets.length))
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
            // Re-sync the UI to whatever actually got removed on partial failure.
            await load()
        }
    }

    // Load on mount and whenever the backend tab changes; reset search per tab.
    let loadedIndex = -1
    $effect(() => {
        const idx = backendIndex
        if (idx === loadedIndex) return
        loadedIndex = idx
        searchKey = ''
        searchVal = ''
        ownerFilter = ''
        load()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.pluginStorageDesc}</p>

<!-- Backend selector (single-select ShToggle group). The active toggle is
     disabled so it can't be toggled off; opacity is restored so it still
     reads as the selected one. -->
<div class="flex flex-wrap gap-1 mb-2">
    {#each BACKENDS as b, i (b.id)}
        <ShToggle
            size="sm"
            pressed={backendIndex === i}
            disabled={backendIndex === i}
            onPressedChange={() => (backendIndex = i)}
            className="disabled:opacity-100"
        >
            {b.label()}
        </ShToggle>
    {/each}
</div>
<p class="text-textcolor2 text-xs mb-4 opacity-70">{BACKENDS[backendIndex].desc()}</p>

<!-- Search -->
<div class="flex flex-col sm:flex-row gap-2 mb-3">
    <ShInput bind:value={searchKey} placeholder={language.pluginStorageSearchKey} />
    <ShInput bind:value={searchVal} placeholder={language.pluginStorageSearchValue} />
</div>

<!-- Origin filter: System-Logs-style toggle chips. No chip selected = all.
     Clicking the active chip clears back to all (keeps pressed in sync with
     ownerFilter, so no toggle desync). -->
{#if ownerOptions.length > 0 || hasUnknown}
    <div class="flex items-start gap-2 mb-3">
        <span class="text-textcolor2 text-xs shrink-0 pt-1.5">{language.pluginStorageOwner}</span>
        <div class="flex flex-wrap gap-1">
            {#each ownerOptions as p (p)}
                <ShToggle size="xs" pressed={ownerFilter === p} onPressedChange={(on) => (ownerFilter = on ? p : '')}>
                    {p}
                </ShToggle>
            {/each}
            {#if hasUnknown}
                <ShToggle size="xs" pressed={ownerFilter === UNKNOWN} onPressedChange={(on) => (ownerFilter = on ? UNKNOWN : '')}>
                    {language.pluginStorageOwnerUnknown}
                </ShToggle>
            {/if}
        </div>
    </div>
{/if}

<!-- Count + bulk delete + refresh -->
<div class="flex items-center justify-between mb-2">
    <span class="text-textcolor2 text-xs">
        <ShBadge variant="secondary">{filtered.length}</ShBadge> / {entries.length} keys
    </span>
    <div class="flex items-center gap-1">
        <ShButton
            variant="destructive"
            size="sm"
            onclick={removeFiltered}
            disabled={loading || filtered.length === 0}
        >
            <Trash2Icon size={14} />
            {isFiltered
                ? language.pluginStorageBulkDeleteShown(filtered.length)
                : language.pluginStorageBulkDeleteAll(filtered.length)}
        </ShButton>
        <ShButton variant="ghost" size="sm" onclick={load} disabled={loading}>
            <RefreshCwIcon size={14} class={loading ? 'animate-spin' : ''} />
            {language.pluginStorageRefresh}
        </ShButton>
    </div>
</div>

<!-- List -->
<div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto rounded-md border border-darkborderc/50 p-1">
    {#if loading}
        <div class="flex flex-col items-center gap-3 text-textcolor2 text-sm py-12">
            <RefreshCwIcon size={20} class="animate-spin" />
            <span class="tabular-nums">{loadTotal > 0 ? `${loadProgress} / ${loadTotal}` : language.systemLogsLoading}</span>
            {#if loadTotal > 0}
                <div class="w-48 h-1 rounded-full bg-darkborderc/50 overflow-hidden">
                    <div class="h-full bg-primary transition-[width] duration-150" style="width: {Math.round((loadProgress / loadTotal) * 100)}%"></div>
                </div>
            {/if}
        </div>
    {:else if loadError}
        <div class="text-textcolor2 text-sm text-center py-12">
            {language.pluginStorageLoadError}<br />
            <span class="text-xs opacity-60">{loadError}</span>
        </div>
    {:else if filtered.length === 0}
        <div class="text-textcolor2 text-sm text-center py-12">{language.pluginStorageEmpty}</div>
    {:else}
        {#each filtered as entry (entry.key)}
            <div
                class="group flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-selected cursor-pointer"
                role="button"
                tabindex="0"
                onclick={() => openDetail(entry)}
                onkeydown={(e) => { if (e.key === 'Enter') openDetail(entry) }}
            >
                <span class="font-mono text-sm text-textcolor truncate flex-1 min-w-0" title={entry.key}>{entry.key}</span>
                {#if entry.owner}
                    <ShBadge variant="secondary" className="max-w-[35%] overflow-hidden">{entry.owner}</ShBadge>
                {/if}
                <span class="text-textcolor2 text-[10px] uppercase tracking-wide shrink-0 opacity-70">{entry.type}</span>
                <span class="text-textcolor2 text-xs shrink-0 tabular-nums">{formatSize(entry.size)}</span>
                <button
                    class="shrink-0 text-textcolor2 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-1"
                    aria-label={language.remove}
                    onclick={(e) => { e.stopPropagation(); removeEntry(entry) }}
                >
                    <Trash2Icon size={15} />
                </button>
            </div>
        {/each}
    {/if}
</div>

<!-- Detail / edit dialog. tier="base" (z-40) so the delete confirm popup
     (alert tier, z-50) renders above this management dialog. -->
<ShDialog bind:open={detailOpen} size="xl" tier="base">
    {#snippet title()}
        <span class="font-mono break-all">{selected?.key ?? ''}</span>
    {/snippet}
    {#if selected}
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs mb-3">
            <span class="text-textcolor2">{language.pluginStorageMetaType}: <span class="text-textcolor font-mono">{selected.type}</span></span>
            <span class="text-textcolor2">{language.pluginStorageMetaSize}: <span class="text-textcolor font-mono">{formatSize(selected.size)}</span></span>
            <span class="text-textcolor2">{language.pluginStorageMetaChars}: <span class="text-textcolor font-mono">{selected.str.length.toLocaleString()}</span></span>
            <span class="text-textcolor2">{language.pluginStorageOwner}: <span class="text-textcolor font-mono">{selected.owner ?? language.pluginStorageOwnerUnknown}</span></span>
        </div>

        {#if editing}
            <textarea
                bind:value={editText}
                class="w-full h-[50vh] resize-none rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor outline-none focus-visible:border-borderc whitespace-pre"
                spellcheck="false"
            ></textarea>
        {:else}
            <pre class="w-full h-[50vh] overflow-auto rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor2 whitespace-pre-wrap break-all">{prettyPrint(selected.str)}</pre>
        {/if}
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            {#if editing}
                <ShButton variant="outline" onclick={formatJson} disabled={saving}>
                    <AlignLeftIcon size={14} />
                    {language.pluginStorageFormatJson}
                </ShButton>
                <ShButton variant="outline" onclick={() => (editing = false)} disabled={saving}>
                    {language.cancel}
                </ShButton>
                <ShButton variant="primary" onclick={saveEdit} disabled={saving}>
                    <SaveIcon size={14} />
                    {language.pluginStorageSave}
                </ShButton>
            {:else}
                <ShButton variant="destructive" onclick={() => selected && removeEntry(selected)}>
                    <Trash2Icon size={14} />
                    {language.remove}
                </ShButton>
                <ShButton variant="outline" onclick={() => (detailOpen = false)}>
                    {language.close}
                </ShButton>
                <ShButton variant="primary" onclick={startEdit}>
                    <PencilIcon size={14} />
                    {language.edit}
                </ShButton>
            {/if}
        </div>
    {/snippet}
</ShDialog>
