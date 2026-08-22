<script lang="ts">
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import SettingTabs from 'src/lib/UI/GUI/SettingTabs.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import SystemDashboard from './SystemDashboard.svelte'
    import SystemBackup from './SystemBackup.svelte'
    import PluginStorageViewer from './PluginStorageViewer.svelte'
    import RequestLogs from './RequestLogs.svelte'
    import UsageStats from './UsageStats.svelte'
    import { SystemSubmenuIndex } from 'src/ts/stores.svelte'
    import { Collapsible, Tooltip } from 'bits-ui'
    import {
        RefreshCwIcon,
        CopyIcon,
        Trash2Icon,
        ChevronDownIcon,
        CircleXIcon,
        TriangleAlertIcon,
        InfoIcon,
        MonitorIcon,
        SmartphoneIcon,
        ServerIcon,
        ScrollTextIcon,
        FilterIcon,
        TerminalIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { language, getCurrentLocale } from 'src/lang'

    type LogLevel = 'error' | 'warning' | 'info'
    type LogOrigin = 'client' | 'server'

    interface LogEntry {
        id: number
        timestamp: number
        level: LogLevel
        origin: LogOrigin
        message: string
        description?: string
        source?: string
        count: number
        platform?: string
        clientId?: string
        userAgent?: string
    }

    const PAGE_SIZE = 200

    // submenu lives in a store so other pages can deep-link via
    // openSettings(SettingsRoute.System, SystemTab.X) — see src/ts/routing.
    let entries = $state<LogEntry[]>([])
    let totalCount = $state(0)
    let loading = $state(false)
    let loadingMore = $state(false)
    let hasMore = $state(false)
    let loadError = $state<string | null>(null)

    // Subtractive filter model: each Set holds tags the user has *deselected*.
    // Empty Set => no exclusion for that dimension (show all). All tags render
    // as pressed by default; unpressing adds the key to the excluded set.
    // Dynamic dimensions (Source/Device) naturally default to "included" for
    // newly-seen keys because they're absent from the excluded set.
    //
    // Background capture sources (console/uncaught/promise/express) are
    // auto-captured by monkey-patched console / window handlers / Express
    // error middleware — not explicit logger calls. They're hidden by default
    // via the `explicitOnly` mode toggle. `server` is an explicit logger.* call
    // (server-side analog of notifyError) and stays visible.
    const BACKGROUND_SOURCES = new Set(['console', 'uncaught', 'promise', 'express'])

    let excludedLevels = $state<Set<LogLevel>>(new Set())
    let excludedOrigins = $state<Set<LogOrigin>>(new Set())
    let excludedSources = $state<Set<string>>(new Set())
    let excludedDevices = $state<Set<string>>(new Set())
    let explicitOnly = $state(true)
    let search = $state('')
    let filtersOpen = $state(false)

    let expanded = $state<Record<number, boolean>>({})

    function toggleSet<T>(set: Set<T>, key: T): Set<T> {
        const next = new Set(set)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    }
    const toggleLevel = (k: LogLevel) => { excludedLevels = toggleSet(excludedLevels, k) }
    const toggleOrigin = (k: LogOrigin) => { excludedOrigins = toggleSet(excludedOrigins, k) }
    const toggleSource = (k: string) => { excludedSources = toggleSet(excludedSources, k) }
    const toggleDevice = (k: string) => { excludedDevices = toggleSet(excludedDevices, k) }
    const clearAllFilters = () => {
        excludedLevels = new Set(); excludedOrigins = new Set()
        excludedSources = new Set(); excludedDevices = new Set()
        explicitOnly = true
        search = ''
    }

    // ─── Fetch ──────────────────────────────────────────────────────────────
    // Dimensions that go to the server — pushing these server-side keeps
    // pagination consistent (the previous all-client filter produced empty
    // pages when a high-hit filter excluded an entire 200-row window).
    // Source/Device/search stay client-side because:
    //   - Source/Device tags are derived from *loaded* entries, so filtering
    //     them server-side would need a separate "known values" endpoint.
    //   - Search should stay instant without roundtripping every keystroke.
    interface ServerFilter {
        excludeLevels: LogLevel[]
        excludeOrigins: LogOrigin[]
        excludeBackground: boolean
    }
    const serverFilter = $derived<ServerFilter>({
        excludeLevels: Array.from(excludedLevels),
        excludeOrigins: Array.from(excludedOrigins),
        excludeBackground: explicitOnly,
    })

    // Generation counter to discard stale fetch results. loadInitial bumps it
    // (each call starts a fresh pagination); loadMore only snapshots it. If a
    // fetch resolves after a newer generation began, its result is dropped so
    // filter changes mid-pagination don't merge results from different filters.
    let fetchGen = 0

    async function loadInitial() {
        // Snapshot filter BEFORE any await — ensures the $effect tracking this
        // call picks up serverFilter as a dependency synchronously.
        const filter = serverFilter
        const gen = ++fetchGen
        loading = true
        loadError = null
        try {
            const data = await fetchLogs({ limit: PAGE_SIZE, filter })
            if (gen !== fetchGen) return
            entries = data.rows
            totalCount = data.total
            hasMore = data.rows.length >= PAGE_SIZE && data.rows.length < data.total
            expanded = {}
        } catch (err) {
            if (gen !== fetchGen) return
            loadError = err instanceof Error ? err.message : String(err)
        } finally {
            if (gen === fetchGen) loading = false
        }
    }

    async function loadMore() {
        if (loadingMore || !hasMore || entries.length === 0) return
        const filter = serverFilter
        const gen = fetchGen
        loadingMore = true
        try {
            // Use row id as the cursor — server sorts by id DESC, so this matches the
            // server ordering exactly and avoids skipping entries that share a timestamp.
            const oldestId = entries[entries.length - 1].id
            const data = await fetchLogs({ limit: PAGE_SIZE, beforeId: oldestId, filter })
            if (gen !== fetchGen) return
            const existing = new Set(entries.map(e => e.id))
            const fresh = data.rows.filter(r => !existing.has(r.id))
            entries = [...entries, ...fresh]
            totalCount = data.total
            hasMore = fresh.length >= PAGE_SIZE && entries.length < data.total
        } catch (err) {
            if (gen !== fetchGen) return
            loadError = err instanceof Error ? err.message : String(err)
        } finally {
            // Always release — loadMore is guarded to one-at-a-time at entry,
            // and loadInitial tracks its own `loading` flag separately.
            loadingMore = false
        }
    }

    async function fetchLogs(opts: { limit?: number; beforeId?: number; filter?: ServerFilter } = {}) {
        const auth = await forageStorage.createAuth()
        const params = new URLSearchParams()
        if (opts.limit) params.set('limit', String(opts.limit))
        if (opts.beforeId) params.set('before_id', String(opts.beforeId))
        const f = opts.filter
        if (f) {
            if (f.excludeLevels.length) params.set('exclude_levels', f.excludeLevels.join(','))
            if (f.excludeOrigins.length) params.set('exclude_origins', f.excludeOrigins.join(','))
            if (f.excludeBackground) params.set('exclude_background', '1')
        }
        const res = await fetch(`/api/logs?${params.toString()}`, {
            headers: { 'risu-auth': auth },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        return { rows: (json.content ?? []) as LogEntry[], total: json.total ?? 0 }
    }

    async function handleClearAll() {
        const ok = await alertConfirm(language.systemLogsClearConfirm)
        if (!ok) return
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/logs', {
                method: 'DELETE',
                headers: { 'risu-auth': auth },
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            entries = []
            totalCount = 0
            hasMore = false
            expanded = {}
        } catch (err) {
            notifyError(language.systemLogsFailedLoad, {
                description: err instanceof Error ? err.message : String(err),
                source: 'logs-page',
            })
        }
    }

    // Stable key for grouping entries per device/session.
    function deviceKey(e: LogEntry): string {
        if (e.origin === 'server') return `server:${e.platform ?? 'server'}`
        return `${e.platform ?? 'unknown'}#${e.clientId ?? ''}`
    }

    function sourceKey(e: LogEntry): string {
        return e.source ?? '(none)'
    }

    // Unique values derived from loaded entries, ordered by most recent first
    // so the tag rows reflect what the user is actually seeing.
    const availableSources = $derived.by(() => {
        const seen: string[] = []
        const set = new Set<string>()
        for (const e of entries) {
            const k = sourceKey(e)
            if (!set.has(k)) { set.add(k); seen.push(k) }
        }
        return explicitOnly ? seen.filter(s => !BACKGROUND_SOURCES.has(s)) : seen
    })

    const availableDevices = $derived.by(() => {
        const seen: Array<{ key: string; entry: LogEntry }> = []
        const set = new Set<string>()
        for (const e of entries) {
            const k = deviceKey(e)
            if (!set.has(k)) { set.add(k); seen.push({ key: k, entry: e }) }
        }
        return seen
    })

    // ─── Client-side filtering ──────────────────────────────────────────────
    const filtered = $derived.by(() => {
        const needle = search.trim().toLowerCase()
        return entries.filter((e) => {
            if (excludedLevels.has(e.level)) return false
            if (excludedOrigins.has(e.origin)) return false

            // Explicit-only mode hides auto-captured sources regardless of
            // the per-source excluded set (mode takes precedence).
            if (explicitOnly && e.source && BACKGROUND_SOURCES.has(e.source)) return false

            if (excludedSources.has(sourceKey(e))) return false
            if (excludedDevices.has(deviceKey(e))) return false

            if (!needle) return true
            const hay = [
                e.message,
                e.description ?? '',
                e.source ?? '',
                e.platform ?? '',
                e.clientId ?? '',
                e.userAgent ?? '',
            ].join(' ').toLowerCase()
            return hay.includes(needle)
        })
    })

    // Active filter count = number of tags the user has *deselected* from the
    // default (all-on) state. The `explicitOnly` toggle is a mode, not a tag —
    // it's tracked separately and not added to this count.
    const activeFilterCount = $derived(
        excludedLevels.size + excludedOrigins.size + excludedSources.size + excludedDevices.size
    )

    // ─── Formatting helpers ─────────────────────────────────────────────────
    let cachedLocale: string | null = null
    let cachedRtf: Intl.RelativeTimeFormat | null = null
    function rtf(): Intl.RelativeTimeFormat {
        const locale = getCurrentLocale()
        if (cachedLocale !== locale || !cachedRtf) {
            cachedLocale = locale
            cachedRtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        }
        return cachedRtf
    }

    function formatRelative(ts: number): string {
        const diff = Date.now() - ts
        const sign = diff > 0 ? -1 : 1
        const abs = Math.abs(diff)
        const f = rtf()
        if (abs < 60_000) return f.format(sign * Math.max(1, Math.floor(abs / 1000)), 'second')
        if (abs < 3_600_000) return f.format(sign * Math.floor(abs / 60_000), 'minute')
        if (abs < 86_400_000) return f.format(sign * Math.floor(abs / 3_600_000), 'hour')
        if (abs < 7 * 86_400_000) return f.format(sign * Math.floor(abs / 86_400_000), 'day')
        return new Date(ts).toLocaleDateString(getCurrentLocale())
    }

    function formatAbsolute(ts: number): string {
        const d = new Date(ts)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function deviceKind(e: LogEntry): 'server' | 'mobile' | 'desktop' {
        if (e.origin === 'server') return 'server'
        const p = (e.platform ?? '').toLowerCase()
        if (p.includes('ios') || p.includes('android') || p.includes('ipad') || p.includes('mobile')) return 'mobile'
        return 'desktop'
    }

    function levelVariant(level: LogLevel): 'destructive' | 'warning' | 'info' {
        return level === 'error' ? 'destructive' : level === 'warning' ? 'warning' : 'info'
    }

    function formatEntry(e: LogEntry): string {
        const head = `[${e.level.toUpperCase()}] ${formatAbsolute(e.timestamp)} — ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`
        const meta = `origin=${e.origin}${e.source ? ` source=${e.source}` : ''}${e.platform ? ` platform=${e.platform}` : ''}${e.clientId ? ` client=${e.clientId}` : ''}`
        const desc = e.description ? `\n${e.description}` : ''
        return `${head}\n${meta}${desc}`
    }

    async function copyEntry(e: LogEntry) {
        try {
            await navigator.clipboard.writeText(formatEntry(e))
            notifySuccess(language.systemLogsCopied)
        } catch (err) {
            notifyError(String(err))
        }
    }

    async function copyAllFiltered() {
        try {
            const text = filtered.map(formatEntry).join('\n\n---\n\n')
            await navigator.clipboard.writeText(text)
            notifySuccess(language.systemLogsCopied)
        } catch (err) {
            notifyError(String(err))
        }
    }

    function deviceLabel(e: LogEntry): string {
        if (e.origin === 'server') return `${e.platform ?? 'server'}`
        return `${e.platform ?? 'unknown'}${e.clientId ? ` #${e.clientId}` : ''}`
    }

    // Initial load + refetch whenever server-side filter changes.
    // `loadInitial()` synchronously reads `serverFilter` before its first
    // await, so Svelte picks up the dependency and reruns this effect on
    // any change to excludedLevels / excludedOrigins / explicitOnly.
    // Gated on the System Logs tab (index 2) so Dashboard/Backups don't
    // spend a fetch on entry.
    $effect(() => {
        if ($SystemSubmenuIndex !== 2) return
        loadInitial()
    })
</script>

<SettingPage title={language.system}>
    <SettingTabs tabs={[
        { label: language.systemDashboard, value: 0 },
        { label: language.systemBackups, value: 1 },
        { label: language.systemLogs, value: 2 },
        { label: language.requestLogsTab, value: 3 },
        { label: language.usageTab, value: 4 },
        { label: language.pluginStorageTab, value: 5 },
    ]} bind:selected={$SystemSubmenuIndex} />

    {#if $SystemSubmenuIndex === 0}
    <SystemDashboard />
    {:else if $SystemSubmenuIndex === 1}
    <SystemBackup />
    {:else if $SystemSubmenuIndex === 2}
    <p class="text-textcolor2 text-sm mb-4">{language.systemLogsDesc}</p>

    <!-- Toolbar -->
    <div class="flex flex-col gap-3 mb-4">
        <!-- Filter section: collapsible, default open, tag-based multi-select -->
        <Collapsible.Root bind:open={filtersOpen}>
            <div class="flex items-center justify-between mb-2">
                <Collapsible.Trigger class="flex items-center gap-1 text-textcolor2 hover:text-textcolor text-sm transition-colors group">
                    <FilterIcon size={14} />
                    <span>{language.systemLogsFilters}</span>
                    {#if activeFilterCount > 0}
                        <ShBadge variant="secondary" className="ml-1">{language.systemLogsFilterActive(activeFilterCount)}</ShBadge>
                    {/if}
                    <ChevronDownIcon size={14} class="transition-transform group-data-[state=closed]:-rotate-90" />
                </Collapsible.Trigger>
                {#if activeFilterCount > 0}
                    <button class="text-textcolor2 hover:text-textcolor text-xs cursor-pointer" onclick={clearAllFilters}>
                        {language.systemLogsFilterClear}
                    </button>
                {/if}
            </div>
            <Collapsible.Content>
                <div class="flex flex-col gap-2 pb-3 border-b border-darkborderc/50">
                    <!-- Level -->
                    <div class="flex items-start gap-2">
                        <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.systemLogsFilterLevel}</span>
                        <div class="flex flex-wrap gap-1">
                            <ShToggle size="xs" pressed={!excludedLevels.has('error')} onPressedChange={() => toggleLevel('error')}>
                                <CircleXIcon /> {language.systemLogsLevelError}
                            </ShToggle>
                            <ShToggle size="xs" pressed={!excludedLevels.has('warning')} onPressedChange={() => toggleLevel('warning')}>
                                <TriangleAlertIcon /> {language.systemLogsLevelWarning}
                            </ShToggle>
                            <ShToggle size="xs" pressed={!excludedLevels.has('info')} onPressedChange={() => toggleLevel('info')}>
                                <InfoIcon /> {language.systemLogsLevelInfo}
                            </ShToggle>
                        </div>
                    </div>
                    <!-- Origin -->
                    <div class="flex items-start gap-2">
                        <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.systemLogsFilterOrigin}</span>
                        <div class="flex flex-wrap gap-1">
                            <ShToggle size="xs" pressed={!excludedOrigins.has('client')} onPressedChange={() => toggleOrigin('client')}>
                                {language.systemLogsOriginClient}
                            </ShToggle>
                            <ShToggle size="xs" pressed={!excludedOrigins.has('server')} onPressedChange={() => toggleOrigin('server')}>
                                {language.systemLogsOriginServer}
                            </ShToggle>
                        </div>
                    </div>
                    <!-- Source -->
                    {#if availableSources.length > 0}
                        <div class="flex items-start gap-2">
                            <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.systemLogsFilterSource}</span>
                            <div class="flex flex-wrap gap-1">
                                {#each availableSources as src (src)}
                                    <ShToggle size="xs" pressed={!excludedSources.has(src)} onPressedChange={() => toggleSource(src)}>
                                        {src}
                                    </ShToggle>
                                {/each}
                            </div>
                        </div>
                    {/if}
                    <!-- Device -->
                    {#if availableDevices.length > 0}
                        <div class="flex items-start gap-2">
                            <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.systemLogsFilterDevice}</span>
                            <div class="flex flex-wrap gap-1">
                                {#each availableDevices as dev (dev.key)}
                                    <ShToggle size="xs" pressed={!excludedDevices.has(dev.key)} onPressedChange={() => toggleDevice(dev.key)}>
                                        {#if deviceKind(dev.entry) === 'server'}<ServerIcon />
                                        {:else if deviceKind(dev.entry) === 'mobile'}<SmartphoneIcon />
                                        {:else}<MonitorIcon />{/if}
                                        {deviceLabel(dev.entry)}
                                    </ShToggle>
                                {/each}
                            </div>
                        </div>
                    {/if}
                    <!-- Mode: explicit logs only (pressed = hide auto-captured) -->
                    <div class="flex items-center gap-2 flex-wrap pt-2 mt-1 border-t border-darkborderc/30">
                        <ShToggle size="xs" pressed={explicitOnly} onPressedChange={v => explicitOnly = v}>
                            <TerminalIcon /> {language.systemLogsExplicitOnly}
                        </ShToggle>
                        <span class="text-textcolor2 text-xs opacity-70">{language.systemLogsExplicitOnlyHint}</span>
                    </div>
                </div>
            </Collapsible.Content>
        </Collapsible.Root>

        <!-- Search + actions -->
        <div class="flex gap-2 items-stretch">
            <div class="flex-1 min-w-0">
                <ShInput bind:value={search} placeholder={language.systemLogsSearchPlaceholder} />
            </div>
            <ShButton variant="outline" size="default" onclick={loadInitial}>
                <RefreshCwIcon size={16} />
                <span class="hidden sm:inline">{language.systemLogsRefresh}</span>
            </ShButton>
            <ShButton variant="outline" size="default" onclick={copyAllFiltered}>
                <CopyIcon size={16} />
                <span class="hidden sm:inline">{language.systemLogsCopyAll}</span>
            </ShButton>
            <ShButton variant="destructive" size="default" onclick={handleClearAll}>
                <Trash2Icon size={16} />
                <span class="hidden sm:inline">{language.systemLogsClearAll}</span>
            </ShButton>
        </div>
    </div>

    <!-- Status bar -->
    <div class="text-textcolor2 text-xs mb-2 flex items-center gap-2">
        {#if loading}
            <span>{language.systemLogsLoading}</span>
        {:else if loadError}
            <span class="text-draculared">{language.systemLogsFailedLoad}: {loadError}</span>
        {:else}
            <span>{language.systemLogsFiltered(filtered.length, totalCount)}</span>
        {/if}
    </div>

    <!-- List -->
    {#if !loading && filtered.length === 0}
        <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
            <ScrollTextIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
            <div class="text-textcolor font-medium mb-1">{language.systemLogsEmpty}</div>
            <div class="text-textcolor2 text-sm">
                {hasMore ? language.systemLogsEmptyButMore : language.systemLogsEmptyDesc}
            </div>
        </div>
    {:else}
        <Tooltip.Provider delayDuration={300}>
            <div class="flex flex-col gap-1 border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
                {#each filtered as entry (entry.id)}
                    <Collapsible.Root
                        open={expanded[entry.id] === true}
                        onOpenChange={(v) => { expanded = { ...expanded, [entry.id]: v } }}
                    >
                        <Collapsible.Trigger class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-selected/30 focus-visible:outline-none focus-visible:bg-selected/30 border-b border-darkborderc/50 group">
                            <!-- Level icon + badge -->
                            <ShBadge variant={levelVariant(entry.level)} className="shrink-0">
                                {#if entry.level === 'error'}
                                    <CircleXIcon size={12} />
                                {:else if entry.level === 'warning'}
                                    <TriangleAlertIcon size={12} />
                                {:else}
                                    <InfoIcon size={12} />
                                {/if}
                                <span class="hidden sm:inline">{entry.level}</span>
                            </ShBadge>

                            <!-- Time (relative + absolute tooltip) — render Trigger as <span>
                                 via child snippet to avoid a <button> inside Collapsible.Trigger. -->
                            <Tooltip.Root>
                                <Tooltip.Trigger>
                                    {#snippet child({ props })}
                                        <span {...props} class="text-textcolor2 text-xs shrink-0 tabular-nums cursor-help">
                                            {formatRelative(entry.timestamp)}
                                        </span>
                                    {/snippet}
                                </Tooltip.Trigger>
                                <Tooltip.Content
                                    class="bg-darkbg border border-darkborderc rounded-md px-2 py-1 text-xs text-textcolor shadow-lg z-50"
                                    sideOffset={4}
                                >
                                    {formatAbsolute(entry.timestamp)}
                                </Tooltip.Content>
                            </Tooltip.Root>

                            <!-- Message -->
                            <span class="flex-1 min-w-0 truncate text-sm text-textcolor">{entry.message}</span>

                            <!-- Count -->
                            {#if entry.count > 1}
                                <ShBadge variant="outline" className="shrink-0 tabular-nums">×{entry.count}</ShBadge>
                            {/if}

                            <!-- Device badge (click to toggle exclusion of this device) -->
                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <span
                                class="shrink-0 cursor-pointer"
                                onclick={(e) => { e.stopPropagation(); toggleDevice(deviceKey(entry)) }}
                            >
                                <ShBadge variant={excludedDevices.has(deviceKey(entry)) ? 'secondary' : 'default'}>
                                    {#if deviceKind(entry) === 'server'}
                                        <ServerIcon size={12} />
                                    {:else if deviceKind(entry) === 'mobile'}
                                        <SmartphoneIcon size={12} />
                                    {:else}
                                        <MonitorIcon size={12} />
                                    {/if}
                                    <span class="hidden md:inline text-[10px]">{deviceLabel(entry)}</span>
                                </ShBadge>
                            </span>

                            <ChevronDownIcon size={14} class="shrink-0 text-textcolor2 transition-transform group-data-[state=open]:rotate-180" />
                        </Collapsible.Trigger>

                        <Collapsible.Content class="bg-darkbg/60 border-b border-darkborderc/50">
                            <div class="p-3 text-xs text-textcolor2 space-y-2">
                                {#if entry.description}
                                    <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{entry.description}</pre>
                                {/if}
                                <div class="flex flex-wrap gap-x-4 gap-y-1">
                                    <span><span class="text-textcolor2/70">timestamp:</span> {formatAbsolute(entry.timestamp)}</span>
                                    <span><span class="text-textcolor2/70">origin:</span> {entry.origin}</span>
                                    {#if entry.source}<span><span class="text-textcolor2/70">source:</span> {entry.source}</span>{/if}
                                    {#if entry.platform}<span><span class="text-textcolor2/70">platform:</span> {entry.platform}</span>{/if}
                                    {#if entry.clientId}<span><span class="text-textcolor2/70">client:</span> #{entry.clientId}</span>{/if}
                                </div>
                                {#if entry.userAgent}
                                    <div class="break-all"><span class="text-textcolor2/70">user-agent:</span> {entry.userAgent}</div>
                                {/if}
                                <div class="pt-1">
                                    <ShButton variant="outline" size="sm" onclick={() => copyEntry(entry)}>
                                        <CopyIcon size={14} />
                                        <span>{language.systemLogsCopyEntry}</span>
                                    </ShButton>
                                </div>
                            </div>
                        </Collapsible.Content>
                    </Collapsible.Root>
                {/each}
            </div>
        </Tooltip.Provider>
    {/if}

    <!-- Load More — shown whenever the server reports more matching rows,
         including the empty-filter-result case (client-side Source/Device/
         search filters may still collapse a page even after server filter). -->
    {#if hasMore}
        <div class="flex justify-center mt-3">
            <ShButton variant="outline" size="default" disabled={loadingMore} onclick={loadMore}>
                {loadingMore ? language.systemLogsLoading : language.systemLogsLoadMore}
            </ShButton>
        </div>
    {/if}
    {:else if $SystemSubmenuIndex === 3}
    <RequestLogs />
    {:else if $SystemSubmenuIndex === 4}
    <UsageStats />
    {:else if $SystemSubmenuIndex === 5}
    <PluginStorageViewer />
    {/if}
</SettingPage>
