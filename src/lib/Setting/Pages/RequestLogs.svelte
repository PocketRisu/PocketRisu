<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import { Collapsible, Tooltip } from 'bits-ui'
    import {
        RefreshCwIcon,
        CopyIcon,
        CheckIcon,
        Trash2Icon,
        ChevronDownIcon,
        FilterIcon,
        ScrollTextIcon,
        ServerIcon,
        ZapIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import {
        fetchRequestLogPage, fetchRequestLogEntry, fetchRequestLogStats, clearRequestLogs,
        type RequestLogEntry, type RequestLogCategory, type RequestLogSource,
    } from 'src/ts/requestLog'

    const PAGE_SIZE = 50

    // Every category is stored, but the log is overwhelmingly about model
    // requests, so the default view shows those and the rest is one click away.
    const CATEGORIES: RequestLogCategory[] = ['llm', 'tts', 'image', 'translate', 'embedding', 'other']
    const SOURCES: RequestLogSource[] = [
        'main', 'translate', 'memory', 'emotion', 'sub',
        'preview', 'test', 'tts', 'image', 'plugin', 'other',
    ]

    const categoryLabel: Record<RequestLogCategory, string> = {
        llm: language.requestLogsCategoryLlm,
        tts: language.requestLogsCategoryTts,
        image: language.requestLogsCategoryImage,
        translate: language.requestLogsCategoryTranslate,
        embedding: language.requestLogsCategoryEmbedding,
        other: language.requestLogsCategoryOther,
    }
    const sourceLabel: Record<RequestLogSource, string> = {
        main: language.requestLogsSourceMain,
        translate: language.requestLogsSourceTranslate,
        memory: language.requestLogsSourceMemory,
        emotion: language.requestLogsSourceEmotion,
        sub: language.requestLogsSourceSub,
        preview: language.requestLogsSourcePreview,
        test: language.requestLogsSourceTest,
        tts: language.requestLogsSourceTts,
        image: language.requestLogsSourceImage,
        plugin: language.requestLogsSourcePlugin,
        other: language.requestLogsSourceOther,
    }
    const routeLabel: Record<string, string> = {
        direct: language.requestLogsRouteDirect,
        proxy: language.requestLogsRouteProxy,
        job: language.requestLogsRouteJob,
    }

    let entries = $state<RequestLogEntry[]>([])
    let totalCount = $state(0)
    let loading = $state(false)
    let loadingMore = $state(false)
    let hasMore = $state(false)
    let loadError = $state<string | null>(null)
    let storage = $state<{ used: number, max: number } | null>(null)

    // Selected filters (inclusive, unlike the system log's subtractive model:
    // here the useful default is a narrow view — LLM only — rather than
    // everything minus a few).
    let selectedCategories = $state<Set<RequestLogCategory>>(new Set(['llm']))
    let selectedSources = $state<Set<RequestLogSource>>(new Set())
    let resultFilter = $state<'all' | 'success' | 'failed'>('all')
    let search = $state('')
    let filtersOpen = $state(false)

    // Bodies are fetched per row on expand, keeping the list payload small.
    let expanded = $state<Record<number, boolean>>({})
    // 'loading' while in flight, the entry on success, 'error' when the row is
    // gone (rotated away between list and expand). Distinct states so a failure
    // is not rendered as a permanent spinner and can be retried by collapsing.
    type DetailState = 'loading' | 'error' | RequestLogEntry
    let details = $state<Record<number, DetailState>>({})
    let copiedKey = $state<string | null>(null)

    function toggleSet<T>(set: Set<T>, key: T): Set<T> {
        const next = new Set(set)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    }
    const toggleCategory = (k: RequestLogCategory) => { selectedCategories = toggleSet(selectedCategories, k) }
    const toggleSource = (k: RequestLogSource) => { selectedSources = toggleSet(selectedSources, k) }
    const clearAllFilters = () => {
        selectedCategories = new Set(['llm'])
        selectedSources = new Set()
        resultFilter = 'all'
        search = ''
    }

    const activeFilterCount = $derived(
        (selectedCategories.size === 1 && selectedCategories.has('llm') ? 0 : 1)
        + (selectedSources.size > 0 ? 1 : 0)
        + (resultFilter !== 'all' ? 1 : 0),
    )

    // An empty array means "no filter" to the server, so unpressing every chip
    // would show everything — the opposite of what the user just asked for.
    // Fall back to the full list so the result set is at least honest, and let
    // the empty-state below explain it.
    const serverFilter = $derived({
        categories: selectedCategories.size > 0 ? Array.from(selectedCategories) : CATEGORIES,
        sources: Array.from(selectedSources),
        successOnly: resultFilter === 'success',
        failedOnly: resultFilter === 'failed',
    })

    // Generation counter discards stale results when filters change mid-fetch.
    let fetchGen = 0

    async function loadInitial() {
        const filter = serverFilter
        const gen = ++fetchGen
        loading = true
        loadError = null
        try {
            const data = await fetchRequestLogPage({ ...filter, limit: PAGE_SIZE })
            if (gen !== fetchGen) return
            entries = data.content
            totalCount = data.total
            hasMore = data.content.length >= PAGE_SIZE && data.content.length < data.total
            expanded = {}
            details = {}
            const stats = await fetchRequestLogStats()
            if (gen === fetchGen && stats) {
                storage = { used: stats.requestBytes, max: stats.maxTotalBytes }
            }
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
            const data = await fetchRequestLogPage({
                ...filter,
                limit: PAGE_SIZE,
                beforeId: entries[entries.length - 1].id,
            })
            if (gen !== fetchGen) return
            const existing = new Set(entries.map(e => e.id))
            const fresh = data.content.filter(r => !existing.has(r.id))
            entries = [...entries, ...fresh]
            totalCount = data.total
            hasMore = fresh.length >= PAGE_SIZE && entries.length < data.total
        } catch (err) {
            if (gen !== fetchGen) return
            loadError = err instanceof Error ? err.message : String(err)
        } finally {
            loadingMore = false
        }
    }

    async function onExpand(entry: RequestLogEntry, open: boolean) {
        expanded = { ...expanded, [entry.id]: open }
        if (!open) return
        const current = details[entry.id]
        if (current && current !== 'error') return
        details = { ...details, [entry.id]: 'loading' }
        const full = await fetchRequestLogEntry(entry.id)
        details = { ...details, [entry.id]: full ?? 'error' }
    }

    async function handleClearAll() {
        if (!await alertConfirm(language.requestLogsClearConfirm)) return
        const ok = await clearRequestLogs(false)
        if (!ok) {
            notifyError(language.requestLogsFailedLoad, { source: 'request-logs-page' })
            return
        }
        entries = []
        totalCount = 0
        hasMore = false
        expanded = {}
        details = {}
        storage = null
    }

    async function copyText(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text)
            copiedKey = key
            notifySuccess(language.requestLogsCopied)
            setTimeout(() => { if (copiedKey === key) copiedKey = null }, 1500)
        } catch (err) {
            notifyError(String(err), { source: 'request-logs-page' })
        }
    }

    // Search stays client-side over the loaded page so typing is instant.
    const filtered = $derived.by(() => {
        const q = search.trim().toLowerCase()
        if (!q) return entries
        return entries.filter(e =>
            e.url.toLowerCase().includes(q)
            || (e.model ?? '').toLowerCase().includes(q)
            || (e.errorMessage ?? '').toLowerCase().includes(q),
        )
    })

    function formatDuration(ms: number | undefined | null): string {
        if (ms === undefined || ms === null) return '—'
        return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
    }

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function formatTime(ts: number): string {
        return new Date(ts).toLocaleTimeString()
    }

    function formatAbsolute(ts: number): string {
        return new Date(ts).toLocaleString()
    }

    function shortUrl(url: string): string {
        try {
            const u = new URL(url)
            return u.host + u.pathname
        } catch {
            return url
        }
    }

    function tokenSummary(e: RequestLogEntry): string | null {
        if (e.inputTokens == null && e.outputTokens == null) return null
        return `${(e.inputTokens ?? 0).toLocaleString()} → ${(e.outputTokens ?? 0).toLocaleString()}`
    }

    $effect(() => {
        // Re-runs when any filter changes; search is intentionally not a dep.
        void serverFilter
        loadInitial()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.requestLogsDesc}</p>

<div class="flex flex-col gap-3 mb-4">
    <Collapsible.Root bind:open={filtersOpen}>
        <div class="flex items-center justify-between mb-2">
            <Collapsible.Trigger class="flex items-center gap-1 text-textcolor2 hover:text-textcolor text-sm transition-colors group">
                <FilterIcon size={14} />
                <span>{language.requestLogsFilters}</span>
                {#if activeFilterCount > 0}
                    <ShBadge variant="secondary" className="ml-1">{language.requestLogsFilterActive(activeFilterCount)}</ShBadge>
                {/if}
                <ChevronDownIcon size={14} class="transition-transform group-data-[state=closed]:-rotate-90" />
            </Collapsible.Trigger>
            {#if activeFilterCount > 0}
                <button class="text-textcolor2 hover:text-textcolor text-xs cursor-pointer" onclick={clearAllFilters}>
                    {language.requestLogsFilterClear}
                </button>
            {/if}
        </div>
        <Collapsible.Content>
            <div class="flex flex-col gap-2 pb-3 border-b border-darkborderc/50">
                <div class="flex items-start gap-2">
                    <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.requestLogsFilterCategory}</span>
                    <div class="flex flex-wrap gap-1">
                        {#each CATEGORIES as cat (cat)}
                            <ShToggle size="xs" pressed={selectedCategories.has(cat)} onPressedChange={() => toggleCategory(cat)}>
                                {categoryLabel[cat]}
                            </ShToggle>
                        {/each}
                    </div>
                </div>
                <div class="flex items-start gap-2">
                    <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.requestLogsFilterSource}</span>
                    <div class="flex flex-wrap gap-1">
                        {#each SOURCES as src (src)}
                            <ShToggle size="xs" pressed={selectedSources.has(src)} onPressedChange={() => toggleSource(src)}>
                                {sourceLabel[src]}
                            </ShToggle>
                        {/each}
                    </div>
                </div>
                <div class="flex items-start gap-2">
                    <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.requestLogsFilterResult}</span>
                    <div class="flex flex-wrap gap-1">
                        <ShToggle size="xs" pressed={resultFilter === 'success'}
                            onPressedChange={v => resultFilter = v ? 'success' : 'all'}>
                            {language.requestLogsResultSuccess}
                        </ShToggle>
                        <ShToggle size="xs" pressed={resultFilter === 'failed'}
                            onPressedChange={v => resultFilter = v ? 'failed' : 'all'}>
                            {language.requestLogsResultFailed}
                        </ShToggle>
                    </div>
                </div>
            </div>
        </Collapsible.Content>
    </Collapsible.Root>

    <div class="flex gap-2 items-stretch">
        <div class="flex-1 min-w-0">
            <ShInput bind:value={search} placeholder={language.requestLogsSearchPlaceholder} />
        </div>
        <ShButton variant="outline" size="default" onclick={loadInitial}>
            <RefreshCwIcon size={16} />
            <span class="hidden sm:inline">{language.requestLogsRefresh}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" onclick={handleClearAll}>
            <Trash2Icon size={16} />
            <span class="hidden sm:inline">{language.requestLogsClearAll}</span>
        </ShButton>
    </div>

    <div class="flex flex-col gap-3 pt-1">
        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-sm text-textcolor">{language.requestLogsEnabled}</span>
                <span class="text-xs text-textcolor2">{language.requestLogsEnabledDesc}</span>
            </div>
            <div class="shrink-0">
                <ShSwitch checked={!!DBState.db.requestLogEnabled}
                    onCheckedChange={(v) => { DBState.db.requestLogEnabled = v }} />
            </div>
        </div>
        {#if DBState.db.requestLogEnabled}
            <div class="flex items-center justify-between gap-3">
                <div class="flex flex-col gap-0.5 min-w-0">
                    <span class="text-sm text-textcolor">{language.requestLogsStreamUsage}</span>
                    <span class="text-xs text-textcolor2">{language.requestLogsStreamUsageDesc}</span>
                </div>
                <div class="shrink-0">
                    <ShSwitch checked={!!DBState.db.requestLogStreamUsage}
                        onCheckedChange={(v) => { DBState.db.requestLogStreamUsage = v }} />
                </div>
            </div>
        {/if}
    </div>
</div>

<div class="text-textcolor2 text-xs mb-2 flex items-center gap-2 flex-wrap">
    {#if loading}
        <span>{language.requestLogsLoading}</span>
    {:else if loadError}
        <span class="text-draculared">{language.requestLogsFailedLoad}: {loadError}</span>
    {:else}
        <span>{language.requestLogsCount(filtered.length, totalCount)}</span>
        {#if storage}
            <span class="opacity-70">· {language.requestLogsStorage(formatBytes(storage.used), formatBytes(storage.max))}</span>
        {/if}
    {/if}
</div>

{#if !loading && filtered.length === 0}
    <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
        <ScrollTextIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
        <div class="text-textcolor font-medium mb-1">{language.requestLogsEmpty}</div>
        <div class="text-textcolor2 text-sm">
            {hasMore ? language.requestLogsEmptyButMore : language.requestLogsEmptyDesc}
        </div>
    </div>
{:else}
    <Tooltip.Provider delayDuration={300}>
        <div class="flex flex-col gap-1 border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            {#each filtered as entry (entry.id)}
                {@const detail = details[entry.id]}
                <Collapsible.Root
                    open={expanded[entry.id] === true}
                    onOpenChange={(v) => onExpand(entry, v)}
                >
                    <Collapsible.Trigger class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-selected/30 focus-visible:outline-none focus-visible:bg-selected/30 border-b border-darkborderc/50 group">
                        <ShBadge variant={entry.success ? 'default' : 'destructive'} className="shrink-0 tabular-nums">
                            {entry.status ?? (entry.success ? 'OK' : 'ERR')}
                        </ShBadge>

                        <Tooltip.Root>
                            <Tooltip.Trigger>
                                {#snippet child({ props })}
                                    <span {...props} class="text-textcolor2 text-xs shrink-0 tabular-nums cursor-help">
                                        {formatTime(entry.timestamp)}
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

                        <span class="flex-1 min-w-0 truncate text-sm text-textcolor font-mono" title={entry.url}>
                            {entry.model || shortUrl(entry.url)}
                        </span>

                        <span class="text-textcolor2 text-xs shrink-0 tabular-nums hidden sm:inline">
                            {formatDuration(entry.durationMs)}
                        </span>

                        {#if tokenSummary(entry)}
                            <span class="text-textcolor2 text-xs shrink-0 tabular-nums hidden md:inline">
                                {tokenSummary(entry)}
                            </span>
                        {/if}

                        <ShBadge variant="outline" className="shrink-0 hidden md:inline-flex">
                            {sourceLabel[entry.source] ?? entry.source}
                        </ShBadge>

                        {#if entry.route === 'job'}
                            <ShBadge variant="secondary" className="shrink-0">
                                <ServerIcon size={12} />
                                <span class="hidden lg:inline">{routeLabel.job}</span>
                            </ShBadge>
                        {:else if entry.streaming}
                            <ShBadge variant="secondary" className="shrink-0">
                                <ZapIcon size={12} />
                            </ShBadge>
                        {/if}

                        <ChevronDownIcon size={14} class="shrink-0 text-textcolor2 transition-transform group-data-[state=open]:rotate-180" />
                    </Collapsible.Trigger>

                    <Collapsible.Content class="bg-darkbg/60 border-b border-darkborderc/50">
                        <div class="p-3 text-xs text-textcolor2 space-y-3">
                            <div class="flex flex-wrap gap-x-4 gap-y-1">
                                <span><span class="text-textcolor2/70">{language.requestLogsDuration}:</span> {formatDuration(entry.durationMs)}</span>
                                {#if entry.firstTokenMs != null}
                                    <span><span class="text-textcolor2/70">{language.requestLogsFirstToken}:</span> {formatDuration(entry.firstTokenMs)}</span>
                                {/if}
                                {#if tokenSummary(entry)}
                                    <span><span class="text-textcolor2/70">{language.requestLogsTokens}:</span> {tokenSummary(entry)}{entry.cachedTokens ? ` (cache ${entry.cachedTokens.toLocaleString()})` : ''}</span>
                                {/if}
                                {#if entry.route}
                                    <span><span class="text-textcolor2/70">route:</span> {routeLabel[entry.route] ?? entry.route}</span>
                                {/if}
                                {#if entry.provider}
                                    <span><span class="text-textcolor2/70">provider:</span> {entry.provider}</span>
                                {/if}
                                {#if entry.truncated}
                                    <ShBadge variant="secondary">{language.requestLogsTruncated}</ShBadge>
                                {/if}
                            </div>

                            <div>
                                <div class="flex items-center justify-between mb-1">
                                    <span class="text-textcolor text-xs font-semibold">URL</span>
                                    <ShButton variant="ghost" size="sm" onclick={() => copyText(entry.url, `${entry.id}-url`)}>
                                        {#if copiedKey === `${entry.id}-url`}<CheckIcon size={12} />{:else}<CopyIcon size={12} />{/if}
                                    </ShButton>
                                </div>
                                <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{entry.url}</pre>
                            </div>

                            {#if entry.errorMessage}
                                <div>
                                    <span class="text-draculared text-xs font-semibold">{language.requestLogsError}</span>
                                    <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 mt-1 text-draculared font-mono">{entry.errorMessage}</pre>
                                </div>
                            {/if}

                            {#if detail === 'loading'}
                                <div class="py-2">{language.requestLogsLoading}</div>
                            {:else if detail === 'error'}
                                <div class="py-2 text-draculared">{language.requestLogsFailedLoad}</div>
                            {:else if detail}
                                {#if detail.requestHeaders}
                                    <div>
                                        <div class="flex items-center justify-between mb-1">
                                            <span class="text-textcolor text-xs font-semibold">{language.requestLogsRequestHeaders}</span>
                                            <ShButton variant="ghost" size="sm" onclick={() => copyText(detail.requestHeaders ?? '', `${entry.id}-h`)}>
                                                {#if copiedKey === `${entry.id}-h`}<CheckIcon size={12} />{:else}<CopyIcon size={12} />{/if}
                                            </ShButton>
                                        </div>
                                        <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 max-h-32 overflow-y-auto text-textcolor font-mono">{detail.requestHeaders}</pre>
                                    </div>
                                {/if}
                                {#if detail.requestBody}
                                    <div>
                                        <div class="flex items-center justify-between mb-1">
                                            <span class="text-textcolor text-xs font-semibold">{language.requestLogsRequestBody}</span>
                                            <ShButton variant="ghost" size="sm" onclick={() => copyText(detail.requestBody ?? '', `${entry.id}-b`)}>
                                                {#if copiedKey === `${entry.id}-b`}<CheckIcon size={12} />{:else}<CopyIcon size={12} />{/if}
                                            </ShButton>
                                        </div>
                                        <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 max-h-80 overflow-y-auto text-textcolor font-mono">{detail.requestBody}</pre>
                                    </div>
                                {/if}
                                {#if detail.responseBody}
                                    <div>
                                        <div class="flex items-center justify-between mb-1">
                                            <span class="text-textcolor text-xs font-semibold">{language.requestLogsResponse}</span>
                                            <ShButton variant="ghost" size="sm" onclick={() => copyText(detail.responseBody ?? '', `${entry.id}-r`)}>
                                                {#if copiedKey === `${entry.id}-r`}<CheckIcon size={12} />{:else}<CopyIcon size={12} />{/if}
                                            </ShButton>
                                        </div>
                                        <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 max-h-80 overflow-y-auto text-textcolor font-mono">{detail.responseBody}</pre>
                                    </div>
                                {/if}
                            {/if}
                        </div>
                    </Collapsible.Content>
                </Collapsible.Root>
            {/each}
        </div>
    </Tooltip.Provider>
{/if}

{#if hasMore}
    <div class="flex justify-center mt-3">
        <ShButton variant="outline" size="default" disabled={loadingMore} onclick={loadMore}>
            {loadingMore ? language.requestLogsLoading : language.requestLogsLoadMore}
        </ShButton>
    </div>
{/if}
