<script lang="ts">
  import { untrack } from 'svelte'
  import { ChevronLeft, ChevronRight, X, Search as SearchIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import { getFileSrc } from 'src/ts/globalApi.svelte'
  import { assetViewerStore, closeAssetViewer } from 'src/ts/assetViewer.svelte'

  let search = $state('')
  let zoomIndex = $state(-1) // index into the filtered list; -1 means grid view
  let srcs = $state<string[]>([]) // resolved asset URL per source item index
  let track = $state<HTMLDivElement | null>(null) // the horizontal scroll-snap container
  let scrollRaf = 0 // rAF guard so the scroll handler runs at most once per frame

  // Resolve asset URLs whenever the source items change. getFileSrc returns an
  // /api/asset/ URL on NodeOnly, so the browser fetches lazily per thumbnail.
  $effect(() => {
    const items = assetViewerStore.items
    srcs = new Array(items.length).fill('')
    items.forEach((item, i) => {
      getFileSrc(item.path).then((url) => { srcs[i] = url })
    })
  })

  const filtered = $derived.by(() => {
    const query = search.trim().toLowerCase()
    const indexed = assetViewerStore.items.map((item, i) => ({ ...item, origIndex: i }))
    return query ? indexed.filter((item) => item.name.toLowerCase().includes(query)) : indexed
  })

  const current = $derived(zoomIndex >= 0 ? (filtered[zoomIndex] ?? null) : null)
  const canPrev = $derived(zoomIndex > 0)
  const canNext = $derived(zoomIndex >= 0 && zoomIndex < filtered.length - 1)

  // Navigation drives the scroll position; the scroll handler is the single
  // source of truth for zoomIndex. Buttons/keys scroll, swipes scroll — both
  // converge through onTrackScroll, so there is no index⇄scroll feedback loop.
  function go(offset: -1 | 1) {
    scrollToIndex(zoomIndex + offset)
  }

  function scrollToIndex(i: number) {
    if (!track || i < 0 || i >= filtered.length) return
    track.scrollLeft = i * track.clientWidth // instant jump — buttons/keys switch immediately
  }

  function onTrackScroll() {
    if (scrollRaf) return
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0
      if (!track || !track.clientWidth) return
      const i = Math.round(track.scrollLeft / track.clientWidth)
      if (i >= 0 && i < filtered.length && i !== zoomIndex) zoomIndex = i
    })
  }

  // When the zoom view opens, jump to the tapped image without animation.
  // untrack keeps zoomIndex out of the dependency set, so the user's own swipes
  // (which update zoomIndex via onTrackScroll) never trigger a re-scroll fight.
  $effect(() => {
    const el = track
    if (!el) return
    untrack(() => { el.scrollLeft = zoomIndex * el.clientWidth })
  })

  // Arrows navigate the zoom view; Escape closes the zoom, then the whole viewer.
  $effect(() => {
    if (!assetViewerStore.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoomIndex >= 0) zoomIndex = -1
        else closeAssetViewer()
      } else if (zoomIndex >= 0 && e.key === 'ArrowLeft' && canPrev) go(-1)
      else if (zoomIndex >= 0 && e.key === 'ArrowRight' && canNext) go(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
</script>

<div class="fixed inset-0 z-50 flex flex-col" style="background: #09090b;">
  <!-- Header: title + search + close -->
  <div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/10">
    <span class="text-white text-sm font-semibold truncate">{assetViewerStore.title}</span>
    <div class="flex items-center gap-2 ml-auto">
      <div class="relative">
        <SearchIcon size={14} class="absolute left-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <input
          class="w-40 sm:w-56 pl-7 pr-2 py-1.5 rounded bg-white/5 border border-white/15 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
          placeholder={language.search}
          bind:value={search}
        />
      </div>
      <button
        class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={closeAssetViewer}
        title={language.goback}
      >
        <X size={16} />
      </button>
    </div>
  </div>

  <!-- Thumbnail grid -->
  <div class="flex-1 min-h-0 overflow-y-auto p-4">
    {#if filtered.length === 0}
      <div class="h-full flex items-center justify-center text-textcolor2 text-sm">{language.noData}</div>
    {:else}
      <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
        {#each filtered as item, i (item.origIndex)}
          <button
            class="relative group aspect-square rounded-lg overflow-hidden bg-darkbg border border-darkborderc hover:border-borderc/70 transition-colors"
            onclick={() => (zoomIndex = i)}
          >
            {#if srcs[item.origIndex]}
              <img alt={item.name} class="w-full h-full object-cover" src={srcs[item.origIndex]} loading="lazy" />
            {/if}
            <div class="absolute inset-x-0 bottom-0 pt-6 pb-1.5 px-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <p class="text-white text-[11px] truncate leading-tight">{item.name}</p>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Fullscreen zoom -->
{#if zoomIndex >= 0}
  <div class="fixed inset-0 z-[60]" style="background: #09090b;">
    <!-- Toolbar -->
    <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
      <div class="flex-1 min-w-0">
        <p class="text-white text-sm font-semibold truncate">{current?.name}</p>
        <p class="text-white/40 text-xs">{zoomIndex + 1} / {filtered.length}</p>
      </div>
      <button
        class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors shrink-0 pointer-events-auto"
        onclick={() => (zoomIndex = -1)}
        title={language.goback}
      >
        <X size={16} />
      </button>
    </div>

    {#if canPrev}
      <button
        class="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={() => go(-1)}
      >
        <ChevronLeft size={22} />
      </button>
    {/if}

    <!-- Swipe track: every image is a full-width snap slide, so the browser drives
         the swipe physics (follow-finger, momentum, snap) natively. Only images
         within ±1 of the current slide are mounted to bound memory. -->
    <div
      bind:this={track}
      onscroll={onTrackScroll}
      class="asset-zoom-track w-full h-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain"
    >
      {#each filtered as item, i (item.origIndex)}
        <!-- snap-always (scroll-snap-stop: always) forbids the scroll from passing
             a snap point, so even a fast flick advances exactly one slide. -->
        <div class="snap-center snap-always shrink-0 w-full h-full flex items-center justify-center px-0 py-2 sm:px-16 sm:py-14">
          {#if Math.abs(i - zoomIndex) <= 1 && srcs[item.origIndex]}
            <img
              alt={item.name}
              class="max-w-full max-h-full object-contain shadow-2xl sm:rounded select-none"
              src={srcs[item.origIndex]}
              draggable="false"
            />
          {/if}
        </div>
      {/each}
    </div>

    {#if canNext}
      <button
        class="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={() => go(1)}
      >
        <ChevronRight size={22} />
      </button>
    {/if}
  </div>
{/if}

<style>
  /* Hide the horizontal scrollbar of the swipe track (it only exists to drive
     scroll-snap navigation). Matches the SettingTabs scrollbar-hiding pattern. */
  .asset-zoom-track {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .asset-zoom-track::-webkit-scrollbar {
    display: none;
  }
</style>
