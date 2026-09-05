<script lang="ts">
  import { onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'

  import { language } from 'src/lang'
  import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
  import { alertConfirm, notifyError, notifyInfo } from 'src/ts/alert'
  import {
    getCharacterChatIndex,
    listInlayExplorerItems,
    removeInlayAsset,
    removeInlayAssets,
    scanInlayReferences,
    type CharacterChatIndexItem,
    type InlayExplorerItem,
    type InlayScanResult,
  } from 'src/ts/process/files/inlays'
  import Button from '../UI/GUI/Button.svelte'
  import CheckInput from '../UI/GUI/CheckInput.svelte'

  const PAGE_SIZE = 36

  type SortKey = 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc'
  type SpecialFilter = 'all' | 'meta-missing' | 'orphan-character' | 'orphan-chat' | 'orphan-message'

  let allItems = $state<InlayExplorerItem[]>([])
  let characterIndex = $state<CharacterChatIndexItem[]>([])
  let displayCount = $state(PAGE_SIZE)
  let loading = $state(true)
  let scanResult = $state<InlayScanResult | null>(null)
  let scanning = $state(false)
  // Set after a failed scan so the effect below does not retry in a loop;
  // cleared when the filter changes, which is the user's retry path.
  let scanFailed = $state(false)
  let paging = $state(false)
  let loadMoreSentinel: HTMLDivElement | null = $state(null)
  let selection = $state<Set<string>>(new SvelteSet())

  let sortKey = $state<SortKey>('updated-desc')
  let characterFilter = $state('')
  let chatFilter = $state('')
  let specialFilter = $state<SpecialFilter>('all')

  const characterMap = $derived(new Map(characterIndex.map((char) => [char.chaId, char])))
  const allChatIds = $derived(new Set(characterIndex.flatMap((char) => char.chats.map((chat) => chat.id))))
  const availableChats = $derived(characterFilter ? (characterMap.get(characterFilter)?.chats ?? []) : [])

  const filteredItems = $derived.by(() => {
    return allItems.filter((item) => {
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

  function getSortTimestamp(item: InlayExplorerItem, key: SortKey): number {
    if (key.startsWith('created')) return item.meta?.createdAt ?? 0
    return item.meta?.updatedAt ?? 0
  }

  function getCharacterName(item: InlayExplorerItem): string | null {
    const charId = item.meta?.charId
    if (!charId) return null
    return characterMap.get(charId)?.name ?? charId
  }

  function getChatName(item: InlayExplorerItem): string | null {
    const charId = item.meta?.charId
    const chatId = item.meta?.chatId
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

  function getStatusLabel(item: InlayExplorerItem): string | null {
    if (!item.hasMeta) return language.playground.inlayFilterMetaMissing
    if (isOrphanCharacter(item)) return language.playground.inlayFilterOrphanCharacter
    if (isOrphanChat(item)) return language.playground.inlayFilterOrphanChat
    return null
  }

  function formatTimestamp(value?: number): string | null {
    if (!value || value <= 0) return null
    return new Date(value).toLocaleString()
  }

  const toggleSelect = (id: string) => {
    if (selection.has(id)) {
      selection.delete(id)
    } else {
      selection.add(id)
    }
  }

  const selectAll = () => {
    displayedItems.forEach((item) => selection.add(item.id))
  }

  const deselectAll = () => {
    selection.clear()
  }

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
    if (!(await alertConfirm(language.playground.inlayDeleteConfirm.replace('{name}', name)))) {
      return
    }
    const kept = await keepUnreferenced([id])
    if (kept === null || kept.length === 0) return
    await removeInlayAsset(id)
    selection.delete(id)
    allItems = allItems.filter((item) => item.id !== id)
  }

  const deleteSelected = async () => {
    if (selection.size === 0) return
    if (!(await alertConfirm(language.playground.inlayDeleteMultipleConfirm.replace('{count}', selection.size.toString())))) {
      return
    }

    let ids = allItems.filter((item) => selection.has(item.id)).map((item) => item.id)
    const kept = await keepUnreferenced(ids)
    if (kept === null) return
    ids = kept
    if (ids.length === 0) { selection.clear(); return }
    await removeInlayAssets(ids)
    const removed = new Set(ids)
    allItems = allItems.filter((item) => !removed.has(item.id))
    selection.clear()
  }

  $effect(() => {
    characterFilter
    const validChatIds = availableChats.map((chat) => chat.id)
    if (chatFilter && !validChatIds.includes(chatFilter)) {
      chatFilter = ''
    }
  })

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

  $effect(() => {
    allItems.length
    sortKey
    characterFilter
    chatFilter
    specialFilter
    displayCount = PAGE_SIZE
  })

  let observer: IntersectionObserver | null = null
  $effect(() => {
    if (!loadMoreSentinel || !hasMore) {
      observer?.disconnect()
      return
    }

    const loadMore = () => {
      if (!hasMore || loading || paging) {
        return
      }

      paging = true
      displayCount += PAGE_SIZE
      queueMicrotask(() => {
        paging = false
      })
    }

    observer?.disconnect()
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore()
        }
      },
      {
        root: null,
        rootMargin: '200px 0px',
        threshold: 0,
      }
    )
    observer.observe(loadMoreSentinel)

    return () => {
      observer?.disconnect()
      observer = null
    }
  })

  onDestroy(() => {
    observer?.disconnect()
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

<h2 class="text-4xl text-textcolor mt-6 font-black relative">{language.playground.inlayExplorer}</h2>

<header class="flex flex-col gap-4 py-6 sticky top-0 bg-bgcolor z-10">
  <div class="flex flex-wrap gap-4 items-center">
    <span class="text-textcolor2">{language.playground.inlayTotalAssets.replace('{count}', filteredItems.length.toString())}</span>
    {#if scanning}<span class="text-textcolor2 text-sm">{language.playground.inlayScanning}</span>{/if}
    {#if allItems.length > 0}
      <div class="flex gap-2 ml-auto">
        {#if hasSelection}
          <Button onclick={deleteSelected} styled="danger" size="sm">{language.playground.inlayDeleteSelected}</Button>
          <Button onclick={deselectAll} styled="primary" size="sm"
            >{language.playground.inlayDeselectAll} ({selection.size})</Button
          >
        {:else}
          <Button onclick={selectAll} styled="primary" size="sm">{language.playground.inlaySelectAll}</Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if allItems.length > 0}
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      <div class="flex flex-col gap-1 text-sm text-textcolor2">
        <span>{language.playground.inlaySort}</span>
        <SelectInput bind:value={sortKey}>
          <OptionInput value="updated-desc">{language.playground.inlaySortUpdatedDesc}</OptionInput>
          <OptionInput value="updated-asc">{language.playground.inlaySortUpdatedAsc}</OptionInput>
          <OptionInput value="created-desc">{language.playground.inlaySortCreatedDesc}</OptionInput>
          <OptionInput value="created-asc">{language.playground.inlaySortCreatedAsc}</OptionInput>
        </SelectInput>
      </div>

      <div class="flex flex-col gap-1 text-sm text-textcolor2">
        <span>{language.character}</span>
        <SelectInput bind:value={characterFilter}>
          <OptionInput value="">{language.none}</OptionInput>
          {#each characterIndex as char (char.chaId)}
            <OptionInput value={char.chaId}>{char.name}</OptionInput>
          {/each}
        </SelectInput>
      </div>

      <div class="flex flex-col gap-1 text-sm text-textcolor2">
        <span>{language.Chat}</span>
        <SelectInput bind:value={chatFilter}>
          <OptionInput value="">{language.none}</OptionInput>
          {#each availableChats as chat (chat.id)}
            <OptionInput value={chat.id}>{chat.name}</OptionInput>
          {/each}
        </SelectInput>
      </div>

      <div class="flex flex-col gap-1 text-sm text-textcolor2">
        <span>{language.playground.inlayFilter}</span>
        <SelectInput bind:value={specialFilter}>
          <OptionInput value="all">{language.playground.inlayFilterAll}</OptionInput>
          <OptionInput value="meta-missing">{language.playground.inlayFilterMetaMissing}</OptionInput>
          <OptionInput value="orphan-character">{language.playground.inlayFilterOrphanCharacter}</OptionInput>
          <OptionInput value="orphan-chat">{language.playground.inlayFilterOrphanChat}</OptionInput>
          <OptionInput value="orphan-message">{language.playground.inlayFilterOrphanMessage}</OptionInput>
        </SelectInput>
      </div>
    </div>
  {/if}
</header>

{#if filteredItems.length === 0 && !loading}
  <div class="text-center py-12 text-textcolor2">
    <p class="text-lg">{language.playground.inlayEmpty}</p>
    <p class="text-sm mt-2">{language.playground.inlayEmptyDesc}</p>
  </div>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each displayedItems as item (item.id)}
      {#key selection.has(item.id)}
        <div class="border border-darkborderc rounded-lg p-4 bg-darkbg">
          <div class="flex items-center gap-2 mb-3">
            <CheckInput check={selection.has(item.id)} hiddenName margin={false} onChange={() => toggleSelect(item.id)} />
            <span class="px-2 py-1 text-xs rounded bg-darkbutton text-textcolor2">
              {item.type}
            </span>
            {#if getStatusLabel(item)}
              <span class="px-2 py-1 text-xs rounded bg-black/20 text-textcolor2">
                {getStatusLabel(item)}
              </span>
            {/if}
          </div>

          <div class="mb-3">
            {#if item.type === 'image'}
              <img alt={item.name} class="w-full h-40 object-contain rounded bg-black/20" src={`/api/asset/${Buffer.from('inlay_thumb/' + item.id, 'utf-8').toString('hex')}`} loading="lazy" />
            {:else}
              <div class="w-full h-40 rounded bg-black/20 border border-darkborderc/50 flex items-center justify-center text-sm text-textcolor2">
                {item.type === 'audio' ? language.playground.inlayAudioAsset : item.type === 'video' ? language.playground.inlayVideoAsset : item.type === 'signature' ? language.playground.inlaySignatureAsset : language.playground.inlayOriginalLoadNeeded}
              </div>
            {/if}
          </div>

          <div class="flex justify-between items-start mb-2">
            <div class="flex-1 min-w-0">
              <p class="text-textcolor font-medium truncate" title={item.name}>{item.name}</p>
              {#if item.name !== item.id}
                <p class="text-textcolor2 text-xs truncate" title={item.id}>{item.id}</p>
              {/if}
            </div>
          </div>

          <div class="text-textcolor2 text-sm mb-3 space-y-1">
            {#if item.width && item.height}
              <p>{item.width}x{item.height}</p>
            {/if}
            {#if getCharacterName(item)}
              <p>{language.character}: {getCharacterName(item)}</p>
            {/if}
            {#if getChatName(item)}
              <p>{language.Chat}: {getChatName(item)}</p>
            {/if}
            {#if formatTimestamp(item.meta?.createdAt)}
              <p>{language.playground.inlayCreatedAt} {formatTimestamp(item.meta?.createdAt)}</p>
            {/if}
            {#if formatTimestamp(item.meta?.updatedAt)}
              <p>{language.playground.inlayUpdatedAt} {formatTimestamp(item.meta?.updatedAt)}</p>
            {/if}
          </div>

          <Button onclick={() => deleteAsset(item.id, item.name)} styled="danger" size="sm">{language.playground.inlayDelete}</Button>
        </div>
      {/key}
    {/each}
  </div>

  {#if hasMore}
    <div bind:this={loadMoreSentinel} class="h-12 flex items-center justify-center text-textcolor2 text-sm">
      {language.playground.inlayLoadingMore}
    </div>
  {/if}
{/if}
