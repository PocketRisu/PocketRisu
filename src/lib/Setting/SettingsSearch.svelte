<script lang="ts">
    import { SearchIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { getModelInfo } from 'src/ts/model/modellist';
    import type { SettingContext } from 'src/ts/setting/types';
    import { searchSettings, navigateToSearchResult, type SettingSearchResult } from 'src/ts/setting/searchIndex';

    interface Props {
        open?: boolean;
    }

    let { open = $bindable(false) }: Props = $props();

    let query = $state('');

    // Reset the query whenever the palette reopens.
    $effect(() => {
        if (open) query = '';
    });

    // Same context shape SettingRenderer uses — conditions need live db +
    // model info so model-gated items don't appear as dead search results.
    let ctx: SettingContext = $derived({
        db: DBState.db,
        modelInfo: getModelInfo(DBState.db.aiModel),
        subModelInfo: getModelInfo(DBState.db.subModel),
    });

    let results: SettingSearchResult[] = $derived(searchSettings(query, ctx));

    function select(result: SettingSearchResult) {
        open = false;
        navigateToSearchResult(result);
    }

    function onInputKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && results.length > 0) {
            e.preventDefault();
            select(results[0]);
        }
    }
</script>

<ShDialog bind:open size="default" tier="alert" closeOnEscape={true} closable={false} ariaLabel={language.searchSettingsPlaceholder}>
    <div class="flex items-center gap-2 border border-darkborderc focus-within:border-borderc rounded-md px-3 py-2 transition-colors">
        <SearchIcon size={18} class="text-textcolor2 shrink-0" />
        <!-- svelte-ignore a11y_autofocus — command palette: focus belongs in the query field -->
        <input
            class="bg-transparent text-textcolor outline-hidden min-w-0 grow"
            placeholder={language.searchSettingsPlaceholder}
            bind:value={query}
            onkeydown={onInputKeydown}
            autofocus
        />
    </div>

    <!-- Fixed-height results pane so the dialog doesn't resize while typing -->
    <div class="flex flex-col overflow-y-auto h-[50vh] mt-2 pr-1">
        {#if !query.trim()}
            <span class="text-textcolor2 text-sm px-1 py-2">{language.searchSettingsHint}</span>
        {:else if results.length === 0}
            <span class="text-textcolor2 text-sm px-1 py-2">{language.searchSettingsNoResults}</span>
        {:else}
            {#each results as result (result.key)}
                <button
                    class="flex flex-col items-start text-left px-2 py-2 rounded-md hover:bg-selected shrink-0"
                    onclick={() => select(result)}
                >
                    <span class="text-sm text-textcolor">{result.label}</span>
                    {#if result.location}
                        <span class="text-xs text-textcolor2">{result.location}</span>
                    {/if}
                    {#if result.help}
                        <span class="text-xs text-textcolor2 opacity-70 line-clamp-2">{result.help}</span>
                    {/if}
                </button>
            {/each}
        {/if}
    </div>
</ShDialog>
