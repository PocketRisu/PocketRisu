<script lang="ts">
    // System → Backups tab. Single home for snapshot management, full server
    // backups, and local backup actions. Migration-style legacy backups stay
    // in MigrationSettings so this page focuses on day-to-day operations.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import ServerBackupList from 'src/lib/Setting/ServerBackupList.svelte'
    import {
        CameraIcon,
        SaveIcon,
        DownloadIcon,
        UploadIcon,
        RotateCcwIcon,
        FolderIcon,
        TriangleAlertIcon,
        RefreshCwIcon,
        TrashIcon,
    } from '@lucide/svelte'
    import { alertConfirm, alertError, alertWait, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { setDatabase } from 'src/ts/storage/database.svelte'
    import { decodeRisuSave } from 'src/ts/storage/risuSave'
    import { language } from 'src/lang'
    import { LoadLocalBackup, SaveLocalBackup, SaveServerBackup } from 'src/ts/drive/backuplocal'

    // ── Types ────────────────────────────────────────────────────────────────
    interface Snapshot { key: string; size: number; timestamp: number | null }
    interface BackupPathInfo { path: string; default: string; isDefault: boolean }
    interface SnapshotLimits {
        maxCount: number
        maxBytes: number
        currentCount: number
        currentBytes: number
        logicalBytes: number
        bounds: { minCount: number; maxCount: number; minBytes: number; maxBytes: number }
        defaults: { count: number; bytes: number }
    }

    // ── State ────────────────────────────────────────────────────────────────
    let snapshots = $state<Snapshot[]>([])
    let snapshotLoading = $state(false)
    let snapshotError = $state<string | null>(null)

    let pathInfo = $state<BackupPathInfo | null>(null)
    let pathDialogOpen = $state(false)
    let pathDraft = $state('')
    let pathDialogError = $state<string | null>(null)
    let pathDialogBusy = $state(false)

    let backupListEl = $state<ServerBackupList | undefined>(undefined)
    let backupSaving = $state(false)

    let limits = $state<SnapshotLimits | null>(null)
    let limitsDialogOpen = $state(false)
    // ShInput is string-typed; we parse in submitLimits.
    let limitsDraftCount = $state('20')
    let limitsDraftMB = $state('500')
    let limitsDialogError = $state<string | null>(null)
    let limitsDialogBusy = $state(false)

    let bootReminder = $state(false)
    let bootReminderLoaded = $state(false)

    // Stats subset for warnings — fetched alongside snapshots/limits.
    // Uses backupDisk (the backup destination) rather than save/ — the user
    // may have pointed backupsDir at a different mount/external drive, in
    // which case save/'s free space is irrelevant for the backup guard.
    let diskFree = $state<number | null>(null)
    let diskTotal = $state<number | null>(null)
    let estimatedBackupSize = $state<number | null>(null)

    const diskUsedPct = $derived(
        diskFree != null && diskTotal != null && diskTotal > 0
            ? ((diskTotal - diskFree) / diskTotal) * 100
            : null
    )
    // 90-94% → yellow warn, 95%+ → red crit.
    const diskUsageLevel = $derived<'none' | 'warn' | 'crit'>(
        diskUsedPct == null ? 'none'
            : diskUsedPct >= 95 ? 'crit'
            : diskUsedPct >= 90 ? 'warn'
            : 'none'
    )
    const insufficientForBackup = $derived(
        estimatedBackupSize != null && diskFree != null && estimatedBackupSize > diskFree
    )

    // ── Format helpers ───────────────────────────────────────────────────────
    function fmtBytes(n: number): string {
        if (n < 1024) return `${n} B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    // ── Snapshots ────────────────────────────────────────────────────────────
    async function loadSnapshots() {
        snapshotLoading = true
        snapshotError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            snapshots = json.snapshots ?? []
        } catch (err) {
            snapshotError = err instanceof Error ? err.message : String(err)
        } finally {
            snapshotLoading = false
        }
    }

    async function deleteSnapshot(snap: Snapshot) {
        const when = snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key
        if (!(await alertConfirm(language.backupSnapshotDeleteConfirm(when)))) return
        try {
            const auth = await forageStorage.createAuth()
            const url = '/api/db/snapshots?key=' + encodeURIComponent(snap.key)
            const res = await fetch(url, { method: 'DELETE', headers: { 'risu-auth': auth } })
            if (!res.ok) {
                const json = await res.json().catch(() => ({}))
                throw new Error(json?.error || `HTTP ${res.status}`)
            }
            notifySuccess(language.backupSnapshotDeleted)
            await Promise.all([loadSnapshots(), loadLimits()])
        } catch (err) {
            alertError(language.backupSnapshotDeleteFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    async function restoreSnapshot(snap: Snapshot) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        alertWait(language.serverBackupRestoring)
        try {
            // Server-side atomic restore: copies snapshot blob → live blob,
            // invalidates caches, rebuilds chat store. Avoids the race where
            // a client-side setDatabase + reload could lose data because the
            // debounced save hadn't flushed yet.
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/restore', {
                method: 'POST',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ key: snap.key }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess('Loaded backup')
            location.search = ''
            location.reload()
        } catch (err) {
            alertError(err instanceof Error ? err.message : String(err))
        }
    }

    // ── Snapshot limits ──────────────────────────────────────────────────────
    async function loadLimits() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            limits = await res.json()
        } catch (err) {
            console.error('[Snapshot limits]', err)
        }
    }

    function openLimitsDialog() {
        if (!limits) return
        limitsDraftCount = String(limits.maxCount)
        limitsDraftMB = String(Math.round(limits.maxBytes / 1024 / 1024))
        limitsDialogError = null
        limitsDialogOpen = true
    }

    async function submitLimits() {
        if (!limits) return
        const c = Math.floor(Number(limitsDraftCount))
        const mb = Math.floor(Number(limitsDraftMB))
        const minC = limits.bounds.minCount
        const maxC = limits.bounds.maxCount
        const minMB = Math.round(limits.bounds.minBytes / 1024 / 1024)
        const maxMB = Math.round(limits.bounds.maxBytes / 1024 / 1024)
        if (!Number.isFinite(c) || c < minC || c > maxC) {
            limitsDialogError = language.backupSnapshotLimitsCountRange(minC, maxC)
            return
        }
        if (!Number.isFinite(mb) || mb < minMB || mb > maxMB) {
            limitsDialogError = language.backupSnapshotLimitsBytesRange(minMB, maxMB)
            return
        }
        limitsDialogBusy = true
        limitsDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ maxCount: c, maxBytes: mb * 1024 * 1024 }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                limitsDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            limitsDialogOpen = false
            notifySuccess(language.backupSnapshotLimitsSuccess(json.removed ?? 0))
            await Promise.all([loadLimits(), loadSnapshots()])
        } catch (err) {
            limitsDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            limitsDialogBusy = false
        }
    }

    // ── Backup path ──────────────────────────────────────────────────────────
    async function loadPath() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            pathInfo = await res.json()
        } catch (err) {
            // Non-fatal — path display will show '—'.
            console.error('[Backup path]', err)
        }
    }

    function openPathDialog() {
        pathDraft = pathInfo?.path ?? ''
        pathDialogError = null
        pathDialogOpen = true
    }

    async function submitPathChange() {
        const trimmed = pathDraft.trim()
        if (!trimmed) {
            pathDialogError = language.backupServerPathInputLabel
            return
        }
        pathDialogBusy = true
        pathDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ path: trimmed }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                pathDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            pathInfo = json
            pathDialogOpen = false
            notifySuccess(language.backupServerPathSuccess)
            // Refresh backup list since the dir changed (now empty unless user moved files).
            backupListEl?.loadBackups()
        } catch (err) {
            pathDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            pathDialogBusy = false
        }
    }

    // ── Stats (for disk warnings + insufficient guard) ──────────────────────
    async function loadStats() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats', { headers: { 'risu-auth': auth } })
            if (!res.ok) return
            const json = await res.json()
            // Prefer backupDisk (mounts to actual backup destination); fall
            // back to disk for older servers that don't yet expose it.
            const d = json?.backupDisk ?? json?.disk
            if (typeof d?.free === 'number') diskFree = d.free
            if (typeof d?.total === 'number') diskTotal = d.total
            if (typeof json?.estimatedBackupSize === 'number') estimatedBackupSize = json.estimatedBackupSize
        } catch { /* non-fatal */ }
    }

    // ── Boot reminder ────────────────────────────────────────────────────────
    async function loadBootReminder() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            bootReminder = !!json.enabled
            bootReminderLoaded = true
        } catch (err) {
            console.error('[Boot reminder]', err)
        }
    }

    async function saveBootReminder(next: boolean) {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            notifySuccess(next ? language.backupBootReminderToggledOn : language.backupBootReminderToggledOff)
        } catch (err) {
            // Optimistic update revert on PUT failure.
            bootReminder = !next
            notifyError('Failed to save: ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    // ── Server backup actions ───────────────────────────────────────────────
    async function createServerBackup() {
        if (!(await alertConfirm(language.backupConfirm))) return
        backupSaving = true
        try {
            await SaveServerBackup()
            backupListEl?.loadBackups()
        } finally {
            backupSaving = false
        }
    }

    async function downloadLocal() {
        if (!(await alertConfirm(language.backupConfirm))) return
        SaveLocalBackup()
    }

    async function restoreFromLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }

    $effect(() => {
        loadSnapshots()
        loadPath()
        loadLimits()
        loadBootReminder()
        loadStats()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.backupTabDesc}</p>

<!-- Server backup section ────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-textcolor">
            <SaveIcon size={16} />
            <span class="font-medium">{language.backupServer}</span>
        </div>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerDesc}</p>

    {#if insufficientForBackup}
        <div class="bg-draculared/20 border border-draculared/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-red-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
            <span class="leading-relaxed text-sm">{language.backupServerInsufficient}</span>
        </div>
    {:else if diskUsageLevel === 'crit' && diskUsedPct != null}
        <div class="bg-draculared/20 border border-draculared/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-red-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
            <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
        </div>
    {:else if diskUsageLevel === 'warn' && diskUsedPct != null}
        <div class="bg-yellow-900/30 border border-yellow-700/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-yellow-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-yellow-400" />
            <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
        </div>
    {/if}

    <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
        {#if bootReminderLoaded}
            <div class="flex items-center gap-2">
                <label class="flex items-center gap-2 cursor-pointer select-none" title={language.backupBootReminderHint}>
                    <ShSwitch bind:checked={bootReminder} onCheckedChange={(v) => { bootReminder = v; saveBootReminder(v); }} />
                    <span class="text-textcolor text-sm">{language.backupBootReminder}</span>
                </label>
                <Help key="bootBackupReminder" />
            </div>
        {:else}
            <span></span>
        {/if}
        <ShButton variant="primary" onclick={createServerBackup} disabled={backupSaving || insufficientForBackup}>
            <SaveIcon size={16} />
            {language.backupServerCreate}
        </ShButton>
    </div>

    <!-- Path control -->
    <div class="flex items-center gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
        <FolderIcon size={14} class="text-textcolor2 shrink-0" />
        <span class="text-textcolor2 text-xs shrink-0">{language.backupServerPath}:</span>
        <span class="text-textcolor text-xs font-mono truncate flex-1 min-w-0">
            {pathInfo?.path ?? '—'}
        </span>
        {#if pathInfo?.isDefault}
            <span class="text-textcolor2 text-xs shrink-0 opacity-60">({language.backupServerPathDefault})</span>
        {/if}
        <ShButton variant="outline" size="xs" onclick={openPathDialog}>
            {language.backupServerPathChange}
        </ShButton>
    </div>

    <ServerBackupList bind:this={backupListEl} />
</div>

<!-- Snapshot section ─────────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-textcolor">
            <CameraIcon size={16} />
            <span class="font-medium">{language.backupSnapshot}</span>
        </div>
        <ShButton variant="outline" size="sm" onclick={loadSnapshots} disabled={snapshotLoading}>
            <RefreshCwIcon size={14} class={snapshotLoading ? 'animate-spin' : ''} />
        </ShButton>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.storageBackupsAutoDesc}</p>

    <!-- Retention limits row -->
    {#if limits}
        <div class="flex items-start gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <!-- Stacked so the (now longer) "current/savings" line wraps to as many
                 lines as it needs on a narrow phone instead of being truncated. -->
            <div class="flex flex-col gap-0.5 flex-1 min-w-0">
                <span class="text-textcolor2 text-xs">{language.backupSnapshotLimits(limits.maxCount, limits.maxBytes)}</span>
                <span class="text-textcolor2 text-xs opacity-70 wrap-break-word">
                    {language.backupSnapshotLimitsCurrent(limits.currentCount, limits.currentBytes, limits.logicalBytes)}
                </span>
            </div>
            <div class="shrink-0">
                <ShButton variant="outline" size="xs" onclick={openLimitsDialog}>
                    {language.backupSnapshotLimitsChange}
                </ShButton>
            </div>
        </div>
    {/if}

    {#if snapshotError}
        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {snapshotError}
        </ShAlert>
    {:else if snapshots.length === 0 && !snapshotLoading}
        <p class="text-textcolor2 text-sm">{language.backupSnapshotEmpty}</p>
    {:else if snapshots.length > 0}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            {#each snapshots as snap, i (snap.key)}
                <div class="flex items-center gap-3 px-3 py-2 {i > 0 ? 'border-t border-darkborderc/50' : ''}">
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-sm text-textcolor">
                            {snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key}
                        </span>
                        <span class="text-xs text-textcolor2 tabular-nums">{fmtBytes(snap.size)}</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button class="text-textcolor2 hover:text-primary cursor-pointer" title={language.backupSnapshotRestore} aria-label={language.backupSnapshotRestore}
                            onclick={() => restoreSnapshot(snap)}>
                            <RotateCcwIcon size={18}/>
                        </button>
                        <button class="text-textcolor2 hover:text-red-400 cursor-pointer" title={language.backupSnapshotDelete} aria-label={language.backupSnapshotDelete}
                            onclick={() => deleteSnapshot(snap)}>
                            <TrashIcon size={18}/>
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>

<!-- Local backup section ────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <DownloadIcon size={16} />
        <span class="font-medium">{language.backupLocal}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupLocalDesc}</p>

    <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupLocalDownload}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalDownloadDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadLocal}>
                <DownloadIcon size={14} />
                {language.backupLocalDownload}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.loadBackupLocal}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalRestoreDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={restoreFromLocalFile}>
                <UploadIcon size={14} />
                {language.loadBackupLocal}
            </ShButton>
        </div>
    </div>
</div>

<!-- Path-change dialog ──────────────────────────────────────────────────── -->
<ShDialog bind:open={pathDialogOpen} size="lg">
    {#snippet title()}{language.backupServerPathDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerPathDialogDesc}</p>
    <label class="flex flex-col gap-1">
        <span class="text-textcolor2 text-sm">{language.backupServerPathInputLabel}</span>
        <ShInput bind:value={pathDraft} placeholder="/absolute/path/to/backups" />
    </label>
    {#if pathDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {pathDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (pathDialogOpen = false)} disabled={pathDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitPathChange} disabled={pathDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>

<!-- Snapshot limits dialog ──────────────────────────────────────────────── -->
<ShDialog bind:open={limitsDialogOpen} size="lg">
    {#snippet title()}{language.backupSnapshotLimitsDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupSnapshotLimitsDialogDesc}</p>
    {#if limits}
        <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsCount}</span>
                <ShInput type="number" bind:value={limitsDraftCount}
                    min={limits.bounds.minCount} max={limits.bounds.maxCount} step={1} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsCountRange(limits.bounds.minCount, limits.bounds.maxCount)}
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsBytes}</span>
                <ShInput type="number" bind:value={limitsDraftMB}
                    min={Math.round(limits.bounds.minBytes / 1024 / 1024)}
                    max={Math.round(limits.bounds.maxBytes / 1024 / 1024)}
                    step={10} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsBytesRange(
                        Math.round(limits.bounds.minBytes / 1024 / 1024),
                        Math.round(limits.bounds.maxBytes / 1024 / 1024)
                    )}
                </span>
            </label>
        </div>
    {/if}
    {#if limitsDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {limitsDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (limitsDialogOpen = false)} disabled={limitsDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitLimits} disabled={limitsDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>
