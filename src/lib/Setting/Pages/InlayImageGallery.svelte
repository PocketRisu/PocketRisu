<script lang="ts">
  import { onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Collapsible } from 'bits-ui'
  import { ChevronDown as ChevronDownIcon, ChevronLeft, ChevronRight, Funnel as FilterIcon, X, Download, Trash2, Info, ImageIcon } from '@lucide/svelte'
  import OptionInput from "../../UI/GUI/OptionInput.svelte";
  import ShBadge from '../../UI/GUI/ShBadge.svelte'
  import ShButton from '../../UI/GUI/ShButton.svelte'
  import ShSelect from '../../UI/GUI/ShSelect.svelte'

  import { language } from 'src/lang'
  import { SizeStore, InlayGallerySubmenuIndex } from 'src/ts/stores.svelte'
  import { alertConfirm, notifySuccess, notifyError, notifyInfo } from 'src/ts/alert'
  import { downloadFile } from 'src/ts/globalApi.svelte'
  import {
    getCharacterChatIndex,
    getInlayAssetBlob,
    listInlayExplorerItems,
    removeInlayAsset,
    removeInlayAssets,
    scanInlayReferences,
    type CharacterChatIndexItem,
    type InlayExplorerItem,
    type InlayScanResult,
  } from 'src/ts/process/files/inlays'
  import SettingPage from '../../UI/GUI/SettingPage.svelte'
  import SettingTabs from '../../UI/GUI/SettingTabs.svelte'
  import SettingRenderer from '../SettingRenderer.svelte'
  import { inlayImageSettingsItems } from 'src/ts/setting/inlayImageSettingsData'


  const PAGE_SIZE = 40

  type SortKey = 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc'
  type SpecialFilter = 'all' | 'meta-missing' | 'orphan-character' | 'orphan-chat' | 'orphan-message'

  // Data state
  let allItems = $state<InlayExplorerItem[]>([])
  let characterIndex = $state<CharacterChatIndexItem[]>([])
  let displayCount = $state(PAGE_SIZE)
  let loading = $state(true)
  let paging = $state(false)
  let galleryScrollContainer: HTMLDivElement | null = $state(null)
  let loadMoreSentinel: HTMLDivElement | null = $state(null)
  let selection = $state<Set<string>>(new SvelteSet())

  // Filter/sort state
  let sortKey = $state<SortKey>('updated-desc')
  let characterFilter = $state('')
  let chatFilter = $state('')
  let specialFilter = $state<SpecialFilter>('all')
  let filtersOpen = $state(false)

  // Scan state
  let scanResult = $state<InlayScanResult | null>(null)
  let scanning = $state(false)
  // Set after a failed scan so the effect below does not retry in a loop;
  // cleared when the filter changes, which is the user's retry path.
  let scanFailed = $state(false)

  // Viewer state
  let viewerOpen = $state(false)
  let viewerId = $state('')
  let viewerUrl = $state('')
  let viewerLoading = $state(false)
  let viewerError = $state('')
  // Mobile defaults to image-only — narrow info panel would dominate the viewport.
  let infoPanelOpen = $state($SizeStore.w >= 768)

  // --- Derived ---
  const activeFilterCount = $derived(
    (characterFilter !== '' ? 1 : 0) +
    (chatFilter !== '' ? 1 : 0) +
    (specialFilter !== 'all' ? 1 : 0)
  )
  const characterMap = $derived(new Map(characterIndex.map((char) => [char.chaId, char])))
  const allChatIds = $derived(new Set(characterIndex.flatMap((char) => char.chats.map((chat) => chat.id))))
  const availableChats = $derived(characterFilter ? (characterMap.get(characterFilter)?.chats ?? []) : [])

  const filteredItems = $derived.by(() => {
    return allItems
      .filter((item) => item.type === 'image')
      .filter((item) => {
        if (characterFilter && item.meta?.charId !== characterFilter) return false
        if (chatFilter && item.meta?.chatId !== chatFilter) return false
        if (specialFilter === 'meta-missing' && item.hasMeta) return false
        if (specialFilter === 'orphan-character' && !isOrphanCharacter(item)) return false
        if (specialFilter === 'orphan-chat' && !isOrphanChat(item)) return false
        if (specialFilter === 'orphan-message' && (!scanResult || (scanResult.refCounts[item.id] ?? 0) > 0)) return false
        return true
      })
  })

  const sortedItems = $derived.by(() => {
    return [...filteredItems].sort((left, right) => {
      const leftValue = getSortTimestamp(left, sortKey)
      const rightValue = getSortTimestamp(right, sortKey)
      return sortKey.endsWith('asc') ? leftValue - rightValue : rightValue - leftValue
    })
  })

  const displayedItems = $derived(sortedItems.slice(0, displayCount))
  const hasMore = $derived(displayCount < sortedItems.length)
  const hasSelection = $derived(selection.size > 0)
  const currentViewerItem = $derived(sortedItems.find((item) => item.id === viewerId) ?? null)
  const viewerIndex = $derived(sortedItems.findIndex((item) => item.id === viewerId))
  const canGoPrev = $derived(viewerIndex > 0)
  const canGoNext = $derived(viewerIndex >= 0 && viewerIndex < sortedItems.length - 1)

  // --- Helpers ---
  function getSortTimestamp(item: InlayExplorerItem, key: SortKey): number {
    if (key.startsWith('created')) return item.meta?.createdAt ?? 0
    return item.meta?.updatedAt ?? 0
  }

  function getCharacterName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    if (!charId) return null
    return characterMap.get(charId)?.name ?? charId
  }

  function getChatName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    const chatId = item?.meta?.chatId
    if (!chatId) return null
    if (charId) {
      const chat = characterMap.get(charId)?.chats.find((entry) => entry.id === chatId)
      return chat?.name ?? chatId
    }
    for (const char of characterIndex) {
      const chat = char.chats.find((entry) => entry.id === chatId)
      if (chat) return chat.name
    }
    return chatId
  }

  function isOrphanCharacter(item: InlayExplorerItem): boolean {
    const charId = item.meta?.charId
    return !!charId && !characterMap.has(charId)
  }

  function isOrphanChat(item: InlayExplorerItem): boolean {
    const chatId = item.meta?.chatId
    if (!chatId) return false
    const charId = item.meta?.charId
    if (charId) {
      const char = characterMap.get(charId)
      if (!char) return false
      return !char.chats.some((chat) => chat.id === chatId)
    }
    return !allChatIds.has(chatId)
  }

  function getStatusLabel(item: InlayExplorerItem | null): string | null {
    if (!item) return null
    if (!item.hasMeta) return language.playground.inlayFilterMetaMissing
    if (isOrphanCharacter(item)) return language.playground.inlayFilterOrphanCharacter
    if (isOrphanChat(item)) return language.playground.inlayFilterOrphanChat
    return null
  }

  function formatTimestamp(value?: number): string | null {
    if (!value || value <= 0) return null
    return new Date(value).toLocaleString()
  }

  function sanitizeFileName(name: string): string {
    const trimmed = name.trim()
    const fallback = trimmed.length > 0 ? trimmed : 'inlay-image.png'
    return fallback.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  }

  function withExtension(name: string, ext: string): string {
    const safeExt = (ext ?? '').trim() || 'bin'
    const lowerName = name.toLowerCase()
    if (lowerName.endsWith(`.${safeExt.toLowerCase()}`)) return name
    const lastDot = name.lastIndexOf('.')
    const base = lastDot > 0 ? name.slice(0, lastDot) : name
    return `${base}.${safeExt}`
  }

  function revokeViewerUrl() {
    viewerUrl = ''
  }

  function loadViewerAsset(id: string) {
    revokeViewerUrl()
    viewerLoading = false
    viewerError = ''
    // Use direct /api/asset/ URL — browser handles caching via HTTP headers
    viewerUrl = `/api/asset/${Buffer.from('inlay/' + id, 'utf-8').toString('hex')}`
  }

  function openViewer(id: string) {
    viewerOpen = true
    viewerId = id
    loadViewerAsset(id)
  }

  function handleCardKeydown(event: KeyboardEvent, id: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openViewer(id)
  }

  function closeViewer() {
    viewerOpen = false
    viewerId = ''
    viewerError = ''
    viewerLoading = false
    revokeViewerUrl()
  }

  function goToNeighbor(offset: -1 | 1) {
    if (viewerIndex < 0) return
    const nextItem = sortedItems[viewerIndex + offset]
    if (!nextItem) return
    openViewer(nextItem.id)
  }

  async function downloadCurrent(item: InlayExplorerItem) {
    try {
      const asset = await getInlayAssetBlob(item.id)
      if (!asset) {
        notifyError('Failed to load image for download.')
        return
      }
      const buffer = new Uint8Array(await asset.data.arrayBuffer())
      await downloadFile(sanitizeFileName(withExtension(asset.name, asset.ext)), buffer)
      notifySuccess(language.successExport)
    } catch (error) {
      notifyError(`${error}`)
    }
  }

  const toggleSelect = (id: string) => {
    if (selection.has(id)) selection.delete(id)
    else selection.add(id)
  }

  const selectAll = () => displayedItems.forEach((item) => selection.add(item.id))
  const deselectAll = () => selection.clear()

  // With the orphan-message filter active a stale "unreferenced" view must not
  // drive a delete: rescan now and keep only ids that still have no reference.
  // Returns null when the scan failed (caller aborts).
  const keepUnreferenced = async (ids: string[]): Promise<string[] | null> => {
    if (specialFilter !== 'orphan-message') return ids
    try {
      scanResult = await scanInlayReferences()
    } catch (error) {
      notifyError(`${language.playground.inlayScanFailed}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    const referenced = ids.filter((id) => (scanResult?.refCounts[id] ?? 0) > 0)
    if (referenced.length > 0) {
      notifyInfo(language.playground.inlayDeleteSkippedReferenced.replace('{count}', referenced.length.toString()))
    }
    return ids.filter((id) => !referenced.includes(id))
  }

  const deleteAsset = async (id: string, name: string) => {
    if (!(await alertConfirm(language.playground.inlayDeleteConfirm.replace('{name}', name)))) return
    const kept = await keepUnreferenced([id])
    if (kept === null || kept.length === 0) return
    await removeInlayAsset(id)
    selection.delete(id)
    allItems = allItems.filter((item) => item.id !== id)
    if (viewerId === id) {
      const currentIndex = sortedItems.findIndex((item) => item.id === id)
      const nextItem = sortedItems[currentIndex + 1] ?? sortedItems[currentIndex - 1] ?? null
      if (nextItem) openViewer(nextItem.id)
      else closeViewer()
    }
  }

  const deleteSelected = async () => {
    if (selection.size === 0) return
    if (!(await alertConfirm(language.playground.inlayDeleteMultipleConfirm.replace('{count}', selection.size.toString())))) return
    let ids = allItems.filter((item) => selection.has(item.id)).map((item) => item.id)
    const kept = await keepUnreferenced(ids)
    if (kept === null) return
    ids = kept
    if (ids.length === 0) { selection.clear(); return }
    await removeInlayAssets(ids)
    const removed = new Set(ids)
    allItems = allItems.filter((item) => !removed.has(item.id))
    if (viewerId && removed.has(viewerId)) closeViewer()
    selection.clear()
  }

  // --- Effects ---
  $effect(() => {
    characterFilter
    const validChatIds = availableChats.map((chat) => chat.id)
    if (chatFilter && !validChatIds.includes(chatFilter)) chatFilter = ''
  })

  $effect(() => {
    allItems.length
    sortKey
    characterFilter
    chatFilter
    specialFilter
    displayCount = PAGE_SIZE
    galleryScrollContainer?.scrollTo({ top: 0 })
  })

  // Auto-scan when orphan-message filter is selected
  $effect(() => {
    if (specialFilter === 'orphan-message' && !scanResult && !scanning && !scanFailed) {
      scanning = true
      scanInlayReferences()
        .then((result) => { scanResult = result })
        .catch((error) => {
          // Unknown is not "unreferenced": leave the filter empty and say why.
          scanFailed = true
          notifyError(`${language.playground.inlayScanFailed}: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => { scanning = false })
    }
  })

  $effect(() => {
    specialFilter
    // Leaving and re-entering the filter starts from a fresh scan.
    scanFailed = false
    scanResult = null
  })

  // Keyboard shortcuts for viewer
  $effect(() => {
    if (!viewerOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer()
      if (e.key === 'ArrowLeft' && canGoPrev) goToNeighbor(-1)
      if (e.key === 'ArrowRight' && canGoNext) goToNeighbor(1)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  })

  // Infinite scroll.
  // The component's own `flex-1 overflow-y-auto` container never actually
  // scrolls because the Settings layout doesn't propagate a height to it —
  // real scrolling happens on an ancestor (rs-setting-cont-4). So we resolve
  // the closest scrollable ancestor at runtime and use it as the observer root.
  let observer: IntersectionObserver | null = null
  $effect(() => {
    if (!galleryScrollContainer || !loadMoreSentinel || !hasMore) {
      observer?.disconnect()
      return
    }
    let rootEl: HTMLElement | null = null
    let p: HTMLElement | null = galleryScrollContainer.parentElement
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
        rootEl = p
        break
      }
      p = p.parentElement
    }
    const loadMore = () => {
      if (!hasMore || loading || paging) return
      paging = true
      displayCount += PAGE_SIZE
      queueMicrotask(() => { paging = false })
    }
    observer?.disconnect()
    observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore() },
      { root: rootEl, rootMargin: '200px 0px', threshold: 0 }
    )
    observer.observe(loadMoreSentinel)
    return () => {
      observer?.disconnect()
      observer = null
    }
  })

  onDestroy(() => {
    observer?.disconnect()
    revokeViewerUrl()
  })

  const loadAssets = async () => {
    loading = true
    const [items, index] = await Promise.all([
      listInlayExplorerItems(),
      Promise.resolve(getCharacterChatIndex()),
    ])
    allItems = items
    characterIndex = index
    loading = false
  }
  loadAssets()
</script>

<div class="h-full min-h-0 flex flex-col overflow-hidden">
  <div class="shrink-0">
    <SettingPage title={language.playground.inlayImageGallery}>
      <SettingTabs tabs={[
        { label: language.playground.inlayImageList, value: 0 },
        { label: language.settings, value: 1 },
      ]} bind:selected={$InlayGallerySubmenuIndex} />
    </SettingPage>
  </div>

  {#if $InlayGallerySubmenuIndex === 1}
    <div class="flex-1 min-h-0 overflow-y-auto">
      <SettingRenderer items={inlayImageSettingsItems} />
    </div>
  {:else}
    <header class="shrink-0 flex flex-col gap-3 bg-bgcolor pb-4">
      <div class="flex flex-wrap gap-3 items-center">
        <span class="text-textcolor2 text-sm">
          {language.playground.inlayTotalAssets.replace('{count}', filteredItems.length.toString())}
        </span>
    {#if scanning}<span class="text-textcolor2 text-sm">{language.playground.inlayScanning}</span>{/if}
        <div class="flex gap-2 ml-auto">
          {#if hasSelection}
            <ShButton onclick={deleteSelected} variant="destructive" size="sm">{language.playground.inlayDeleteSelected}</ShButton>
            <ShButton onclick={deselectAll} variant="default" size="sm">
              {language.playground.inlayDeselectAll} ({selection.size})
            </ShButton>
          {:else if allItems.length > 0}
            <ShButton onclick={selectAll} variant="default" size="sm">{language.playground.inlaySelectAll}</ShButton>
          {/if}
        </div>
      </div>

      {#if allItems.length > 0}
        <Collapsible.Root bind:open={filtersOpen}>
          <Collapsible.Trigger class="group flex items-center gap-1 text-textcolor2 hover:text-textcolor text-sm transition-colors">
            <FilterIcon size={14} />
            <span>{language.playground.inlayFilter}</span>
            {#if activeFilterCount > 0}
              <ShBadge variant="secondary" className="ml-1">{activeFilterCount}</ShBadge>
            {/if}
            <ChevronDownIcon size={14} class="transition-transform group-data-[state=closed]:-rotate-90" />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.playground.inlaySort}</span>
                <ShSelect bind:value={sortKey} size="sm">
                  <OptionInput value="updated-desc">{language.playground.inlaySortUpdatedDesc}</OptionInput>
                  <OptionInput value="updated-asc">{language.playground.inlaySortUpdatedAsc}</OptionInput>
                  <OptionInput value="created-desc">{language.playground.inlaySortCreatedDesc}</OptionInput>
                  <OptionInput value="created-asc">{language.playground.inlaySortCreatedAsc}</OptionInput>
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.character}</span>
                <ShSelect bind:value={characterFilter} size="sm">
                  <OptionInput value="">{language.none}</OptionInput>
                  {#each characterIndex as char (char.chaId)}
                    <OptionInput value={char.chaId}>{char.name}</OptionInput>
                  {/each}
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.Chat}</span>
                <ShSelect bind:value={chatFilter} size="sm">
                  <OptionInput value="">{language.none}</OptionInput>
                  {#each availableChats as chat (chat.id)}
                    <OptionInput value={chat.id}>{chat.name}</OptionInput>
                  {/each}
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.playground.inlayFilter}</span>
                <ShSelect bind:value={specialFilter} size="sm">
                  <OptionInput value="all">{language.playground.inlayFilterAll}</OptionInput>
                  <OptionInput value="meta-missing">{language.playground.inlayFilterMetaMissing}</OptionInput>
                  <OptionInput value="orphan-character">{language.playground.inlayFilterOrphanCharacter}</OptionInput>
                  <OptionInput value="orphan-chat">{language.playground.inlayFilterOrphanChat}</OptionInput>
                  <OptionInput value="orphan-message">{language.playground.inlayFilterOrphanMessage}</OptionInput>
                </ShSelect>
              </div>
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
    </header>

    <div bind:this={galleryScrollContainer} class="flex-1 min-h-0 overflow-y-auto pr-1 pb-4">
      {#if loading}
        <div class="min-h-full flex flex-col items-center justify-center gap-4">
          <div class="w-12 h-12 border-4 border-darkborderc border-t-borderc rounded-full animate-spin"></div>
          <p class="text-textcolor2 text-sm">{language.playground.inlayLoadingMore}</p>
        </div>
      {:else if filteredItems.length === 0}
        <div class="min-h-full flex flex-col items-center justify-center text-center text-textcolor2">
          <p class="text-lg">{language.playground.inlayEmpty}</p>
          <p class="text-sm mt-2">{language.playground.inlayImageGalleryEmptyDesc}</p>
        </div>
      {:else}
        <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {#each displayedItems as item (item.id)}
            <div
              class="relative group aspect-[2/3] rounded-lg overflow-hidden bg-darkbg border cursor-pointer select-none transition-colors
                {selection.has(item.id) ? 'border-borderc' : 'border-darkborderc hover:border-borderc/70'}"
              role="button"
              tabindex="0"
              onclick={() => openViewer(item.id)}
              onkeydown={(event) => handleCardKeydown(event, item.id)}
            >
              {#if item.type === 'image'}
                <img alt={item.name} class="w-full h-full object-cover" src={`/api/asset/${Buffer.from('inlay_thumb/' + item.id, 'utf-8').toString('hex')}`} loading="lazy" />
              {:else}
                <div class="w-full h-full flex items-center justify-center text-textcolor2/40">
                  <ImageIcon size={28} />
                </div>
              {/if}

              <button
                class="absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded flex items-center justify-center transition-all border
                  {selection.has(item.id)
                    ? 'bg-borderc border-borderc'
                    : 'bg-black/50 border-white/40 opacity-0 group-hover:opacity-100'}"
                onclick={(e) => { e.stopPropagation(); toggleSelect(item.id) }}
                title={selection.has(item.id) ? language.playground.inlayDeselectAll : language.playground.inlaySelectAll}
              >
                {#if selection.has(item.id)}
                  <svg class="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                {/if}
              </button>

              {#if getStatusLabel(item)}
                <div
                  class="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-yellow-500 flex items-center justify-center"
                  title={getStatusLabel(item) ?? ''}
                >
                  <span class="text-black text-[9px] font-bold leading-none">!</span>
                </div>
              {/if}

              <div
                class="absolute inset-x-0 bottom-0 pt-8 pb-2 px-2
                  bg-gradient-to-t from-black/80 via-black/40 to-transparent
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col"
              >
                <p class="text-white text-xs font-medium truncate leading-tight">{item.name}</p>
                {#if getCharacterName(item)}
                  <p class="text-white/60 text-[10px] truncate leading-tight">{getCharacterName(item)}</p>
                {/if}
                <div class="flex gap-1.5 mt-1.5 justify-end">
                  <button
                    class="w-6 h-6 rounded bg-white/15 hover:bg-white/30 flex items-center justify-center text-white transition-colors"
                    onclick={(e) => { e.stopPropagation(); downloadCurrent(item) }}
                    title={language.download}
                  >
                    <Download size={11} />
                  </button>
                  <button
                    class="w-6 h-6 rounded bg-draculared/30 hover:bg-draculared/70 flex items-center justify-center text-white transition-colors"
                    onclick={(e) => { e.stopPropagation(); deleteAsset(item.id, item.name) }}
                    title={language.playground.inlayDelete}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if hasMore}
          <div bind:this={loadMoreSentinel} class="flex items-center justify-center py-10">
            <div class="w-7 h-7 border-4 border-darkborderc border-t-borderc rounded-full animate-spin"></div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<!-- Fullscreen viewer -->
{#if viewerOpen}
  <div class="fixed inset-0 z-50 flex overflow-hidden" style="background: #09090b;">

    <!-- Image panel -->
    <div class="flex-1 relative flex items-center justify-center min-w-0 overflow-hidden">

      <!-- Top toolbar -->
      <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
        <div class="flex-1 min-w-0">
          <p class="text-white text-sm font-semibold truncate">{currentViewerItem?.name ?? viewerId}</p>
          {#if viewerIndex >= 0}
            <p class="text-white/40 text-xs">{viewerIndex + 1} / {sortedItems.length}</p>
          {/if}
        </div>
        <div class="flex gap-2 shrink-0 pointer-events-auto">
          <button
            class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
            onclick={() => (infoPanelOpen = !infoPanelOpen)}
            title={language.playground.inlayInfo}
          >
            <Info size={16} />
          </button>
          <button
            class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
            onclick={() => currentViewerItem && downloadCurrent(currentViewerItem)}
            title={language.download}
          >
            <Download size={16} />
          </button>
          <button
            class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
            onclick={closeViewer}
            title={language.goback}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <!-- Prev arrow -->
      {#if canGoPrev}
        <button
          class="absolute left-3 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
          onclick={() => goToNeighbor(-1)}
        >
          <ChevronLeft size={22} />
        </button>
      {/if}

      <!-- Image / loading / error -->
      <div class="w-full h-full flex items-center justify-center px-16 py-14">
        {#if viewerLoading}
          <div class="flex flex-col items-center gap-4">
            <div class="w-12 h-12 border-4 border-white/15 border-t-white/80 rounded-full animate-spin"></div>
            <p class="text-white/50 text-sm">{language.playground.inlayLoadingOriginal}</p>
          </div>
        {:else if viewerError}
          <p class="text-red-300 text-sm">{viewerError}</p>
        {:else if viewerUrl}
          <img
            alt={currentViewerItem?.name ?? viewerId}
            class="max-w-full max-h-full object-contain rounded shadow-2xl"
            style="max-height: calc(100vh - 112px);"
            src={viewerUrl}
          />
        {/if}
      </div>

      <!-- Next arrow -->
      {#if canGoNext}
        <button
          class="absolute right-3 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
          onclick={() => goToNeighbor(1)}
        >
          <ChevronRight size={22} />
        </button>
      {/if}

      <!-- Status badge at bottom -->
      {#if getStatusLabel(currentViewerItem)}
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-yellow-500/90 text-black text-xs font-medium">
          {getStatusLabel(currentViewerItem)}
        </div>
      {/if}
    </div>

    <!-- Info panel -->
    {#if infoPanelOpen}
      <div class="w-72 xl:w-80 shrink-0 flex flex-col overflow-hidden border-l border-white/10" style="background: #18181b;">

        <!-- Panel header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span class="text-white/80 text-sm font-semibold">{language.playground.inlayInfo}</span>
          <button class="text-white/40 hover:text-white transition-colors" onclick={() => (infoPanelOpen = false)}>
            <X size={16} />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">

          <!-- File info -->
          <div class="px-4 py-3 space-y-1.5 border-b border-white/10">
            <p class="text-white text-sm font-medium break-all leading-snug" title={currentViewerItem?.name}>
              {currentViewerItem?.name ?? viewerId}
            </p>
            <p class="text-white/30 text-xs font-mono break-all leading-snug">{viewerId}</p>
            {#if currentViewerItem?.ext}
              <p class="text-white/50 text-xs uppercase font-mono">.{currentViewerItem.ext}</p>
            {/if}
            {#if currentViewerItem?.width && currentViewerItem?.height}
              <p class="text-white/50 text-xs">{currentViewerItem.width} × {currentViewerItem.height} px</p>
            {/if}
            {#if getCharacterName(currentViewerItem)}
              <p class="text-white/60 text-xs">{language.character}: {getCharacterName(currentViewerItem)}</p>
            {/if}
            {#if getChatName(currentViewerItem)}
              <p class="text-white/60 text-xs">{language.Chat}: {getChatName(currentViewerItem)}</p>
            {/if}
            {#if formatTimestamp(currentViewerItem?.meta?.createdAt)}
              <p class="text-white/35 text-xs">{language.playground.inlayCreatedAt} {formatTimestamp(currentViewerItem?.meta?.createdAt)}</p>
            {/if}
            {#if formatTimestamp(currentViewerItem?.meta?.updatedAt)}
              <p class="text-white/35 text-xs">{language.playground.inlayUpdatedAt} {formatTimestamp(currentViewerItem?.meta?.updatedAt)}</p>
            {/if}
          </div>

          <!-- Actions -->
          <div class="px-4 py-4 space-y-2">
            <h3 class="text-white/50 text-[11px] font-semibold uppercase tracking-wider">
              {language.playground.inlayActions}
            </h3>
            <button
              onclick={() => currentViewerItem && downloadCurrent(currentViewerItem)}
              class="w-full flex items-center gap-2 px-3 py-2 rounded border border-white/15 hover:bg-white/5 text-white/70 hover:text-white text-sm transition-colors"
            >
              <Download size={14} />
              {language.download}
            </button>
            <button
              onclick={() => currentViewerItem && deleteAsset(currentViewerItem.id, currentViewerItem.name)}
              class="w-full flex items-center gap-2 px-3 py-2 rounded border border-draculared/40 hover:bg-draculared/15 text-red-400 hover:text-red-300 text-sm transition-colors"
            >
              <Trash2 size={14} />
              {language.playground.inlayDelete}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}
