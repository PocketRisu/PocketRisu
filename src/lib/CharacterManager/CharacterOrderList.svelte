<script lang="ts">
    // "Sidebar order" view: the rail's characterOrder rendered as rows —
    // folders as collapsible groups, loose characters between them, in the
    // exact rail sequence. Drag reorders across the top level and into/out of
    // folders (same Sortable group); folders cannot nest. After a drop the
    // layout is read back from the DOM and the whole order array is rebuilt
    // (src/ts/characterOrder.ts), mirroring FolderedList's approach.
    import type { Snippet } from "svelte";
    import { ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon, FolderIcon } from "@lucide/svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";
    import ShDropdownMenu from "src/lib/UI/GUI/ShDropdownMenu.svelte";
    import ShDropdownMenuTrigger from "src/lib/UI/GUI/ShDropdownMenuTrigger.svelte";
    import ShDropdownMenuContent from "src/lib/UI/GUI/ShDropdownMenuContent.svelte";
    import CharacterRow from "./CharacterRow.svelte";
    import { isFolderEntry, type OrderEntry, type OrderLayoutItem } from "src/ts/characterOrder";
    import type { ManagerEntry } from "src/ts/characterManager";
    import { folderDisplayMode, type folder } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";
    import { folderIconComponent } from "./folderIcons";

    interface Props {
        order: OrderEntry[];
        entries: Map<string, ManagerEntry>;
        visible: (entry: ManagerEntry) => boolean;
        dragDisabled?: boolean;
        selectable?: boolean;
        selectedIds?: ReadonlySet<string>;
        activeChaId?: string;
        onOpen: (entry: ManagerEntry) => void;
        onToggleSelect?: (entry: ManagerEntry) => void;
        onLayoutChange: (layout: OrderLayoutItem[]) => void;
        rowMenu?: Snippet<[ManagerEntry]>;
        folderMenu?: Snippet<[folder]>;
    }

    let {
        order, entries, visible, dragDisabled = false, selectable = false, selectedIds,
        activeChaId, onOpen, onToggleSelect, onLayoutChange, rowMenu, folderMenu,
    }: Props = $props();

    const STORAGE_KEY = 'risu-character-manager-collapsed';
    let rootEl: HTMLDivElement = $state();
    let collapsed = $state<Set<string>>(loadCollapsed());

    function loadCollapsed(): Set<string> {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return new Set(raw ? JSON.parse(raw) as string[] : []);
        } catch {
            return new Set();
        }
    }

    function toggleCollapsed(id: string) {
        const next = new Set(collapsed);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        collapsed = next;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch {}
    }

    // Color swatch next to the folder name (same palette the rail tints its slot with).
    const folderColorClass: Record<string, string> = {
        red: 'bg-red-700', yellow: 'bg-yellow-700', green: 'bg-green-700', blue: 'bg-blue-700',
        indigo: 'bg-indigo-700', purple: 'bg-purple-700', pink: 'bg-pink-700',
    };

    function entryKey(entry: OrderEntry): string {
        return isFolderEntry(entry) ? `folder:${entry.id}` : entry;
    }

    /** Count of visible characters in a folder; folders stay shown while any child matches. */
    function folderVisibleCount(f: folder): number {
        let n = 0;
        for (const id of f.data) {
            const e = entries.get(id);
            if (e && visible(e)) n++;
        }
        return n;
    }

    // A folder block dragged into a folder container would nest folders;
    // refuse the move (and keep Sortable's own .no-sort rule).
    function onMove(evt: { dragged: HTMLElement; to: HTMLElement; related: HTMLElement }) {
        if (evt.related?.className?.indexOf?.('no-sort') !== -1) return false;
        if (evt.dragged.dataset.folderId !== undefined && evt.to.closest('[data-folder-container]')) return false;
        return true;
    }

    function rowId(el: HTMLElement): string | undefined {
        return el.dataset.orderKey ?? el.dataset.sortableKey;
    }

    /** Current layout as rendered (source of truth right after a drop). */
    function layoutFromDom(): OrderLayoutItem[] {
        const out: OrderLayoutItem[] = [];
        for (const child of Array.from(rootEl.children)) {
            if (!(child instanceof HTMLElement)) continue;
            const folderId = child.dataset.folderId;
            if (folderId !== undefined) {
                const data: string[] = [];
                const container = child.querySelector<HTMLElement>('[data-folder-container] [data-risu-sortable-list]');
                container?.querySelectorAll<HTMLElement>(':scope > [data-order-key], :scope > [data-sortable-key]').forEach((el) => {
                    const id = rowId(el);
                    if (id) data.push(id);
                });
                out.push({ type: 'folder', id: folderId, data });
            } else {
                const id = rowId(child);
                if (id) out.push({ type: 'char', id });
            }
        }
        return out;
    }

    function onDrop() {
        onLayoutChange(layoutFromDom());
    }
</script>

<ShSortableList
    bind:element={rootEl}
    className="flex flex-col gap-1"
    disabled={dragDisabled}
    draggable="[data-order-key]"
    dataAttribute="data-order-key"
    options={{ group: 'character-manager', onMove }}
    onReorder={onDrop}
>
    {#each order as entry (entryKey(entry))}
        {#if isFolderEntry(entry)}
            {@const isCollapsed = collapsed.has(entry.id)}
            {@const count = folderVisibleCount(entry)}
            {@const FolderGlyph = (folderDisplayMode(entry) === 'icon' ? folderIconComponent(entry.nodeOnlyIcon) : undefined) ?? FolderIcon}
            <div data-order-key={`folder:${entry.id}`} data-folder-id={entry.id} data-sortable-no-scale
                class="rounded-md border border-darkborderc bg-darkbg">
                <div class="flex items-center gap-2 px-2 py-2 text-textcolor cursor-pointer select-none"
                    role="button" tabindex="0"
                    onclick={() => toggleCollapsed(entry.id)}
                    onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed(entry.id) }}>
                    {#if isCollapsed}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                    <span class="shrink-0 h-4 w-4 rounded-sm border border-darkborderc {folderColorClass[entry.color] ?? 'bg-bgcolor'}" title={entry.color || language.defaultLabel}></span>
                    <FolderGlyph size={16} class="shrink-0 text-textcolor2"/>
                    <span class="truncate grow font-medium">{entry.name}</span>
                    <span class="text-xs text-textcolor2">{count}{count !== entry.data.length ? ` / ${entry.data.length}` : ''}</span>
                    {#if folderMenu}
                        <ShDropdownMenu>
                            <ShDropdownMenuTrigger>
                                {#snippet child({ props })}
                                    <button {...props} class="no-sort shrink-0 p-1 rounded text-textcolor2 risu-interactive-accent" aria-label="menu"
                                        onclick={(e) => { e.stopPropagation(); (props as { onclick?: (e: MouseEvent) => void }).onclick?.(e) }}>
                                        <EllipsisVerticalIcon size={16}/>
                                    </button>
                                {/snippet}
                            </ShDropdownMenuTrigger>
                            <ShDropdownMenuContent align="end" class="min-w-40 z-[45]">
                                {@render folderMenu(entry)}
                            </ShDropdownMenuContent>
                        </ShDropdownMenu>
                    {/if}
                </div>
                <div data-folder-container={entry.id} class:hidden={isCollapsed}>
                    <ShSortableList
                        className="flex flex-col px-2 pb-2 gap-0.5 min-h-8"
                        disabled={dragDisabled}
                        options={{ group: 'character-manager', onMove }}
                        onReorder={onDrop}
                    >
                        {#each entry.data as chaId (chaId)}
                            {@render row(chaId, 'data-sortable-key')}
                        {:else}
                            <div class="no-sort text-xs text-textcolor2 text-center py-1">{language.none}</div>
                        {/each}
                    </ShSortableList>
                </div>
            </div>
        {:else}
            {@render row(entry, 'data-order-key')}
        {/if}
    {/each}
</ShSortableList>

{#snippet row(chaId: string, attr: 'data-order-key' | 'data-sortable-key')}
    {@const e = entries.get(chaId)}
    {#if e}
        <div {...{ [attr]: chaId }} data-sortable-no-scale class:hidden={!visible(e)}>
            <CharacterRow
                entry={e}
                {selectable}
                selected={selectedIds?.has(chaId) ?? false}
                active={activeChaId === chaId}
                {onOpen}
                {onToggleSelect}
                menu={rowMenu}
            />
        </div>
    {/if}
{/snippet}
