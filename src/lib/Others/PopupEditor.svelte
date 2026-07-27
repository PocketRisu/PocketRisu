<script lang="ts">
    import { onMount } from 'svelte';
    import { DBState, popUpEditorStore } from '../../ts/stores.svelte';
    import type MonacoEditorType from './MonacoEditor.svelte';
    import { language } from 'src/lang';
    import { risuChatParser } from "src/ts/parser/parser.svelte";
    import { tokenize } from 'src/ts/tokenizer';
    import Toggles from '../SideBars/Toggles.svelte';
    import { getCurrentCharacter } from 'src/ts/storage/database.svelte';

    let languageMode = $state(popUpEditorStore.language || 'markdown');
    let previewing = $state(false);
    let tokens = $state(0);
    let MonacoComponent: (typeof MonacoEditorType)|null = $state(null)
    let showToggles = $state(false)

    let chatParserValue = $derived.by(() => {
        if(!previewing){
            return ''
        }

        try {
            $state.snapshot(DBState.db.globalChatVariables)
        } catch (error) {

        }
        return risuChatParser(popUpEditorStore.value)
    })

    $effect(() => {
        if(!previewing){
            return
        }
        tokenize(chatParserValue).then((toks) => {
            tokens = toks
        }).catch(() => {
            tokens = 0
        })
    })

    onMount(() => {
        import('./MonacoEditor.svelte').then((module) => {
            MonacoComponent = module.default;
        });
    });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    data-risu-modal-scroll
    onclick={() => (popUpEditorStore.open = false)}
>
    <div
        class="bg-darkbg rounded-lg p-4 w-11/12 h-11/12 flex flex-col gap-2"
        onclick={(e) => e.stopPropagation()}
    >
         <!-- Header Toolbar -->
         <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold">Popup Editor</h2>
            <div class="flex items-center gap-2">
                {#if ['markdown', 'cbs'].includes(languageMode)}
                    {#if !previewing}
                        <select
                            bind:value={languageMode}
                            class="bg-bgcolor border-none rounded px-2 py-1 text-sm"
                        >
                            <option value="markdown">Markdown</option>
                            <option value="cbs" disabled>CBS</option>
                        </select>
                    {/if}
                    <button
                        class="bg-primary text-white px-3 py-1 rounded hover:bg-primary/90 transition"
                        onclick={() => (previewing = !previewing)}
                    >
                        {previewing ? language.edit : language.preview}
                    </button>
                {:else}
                    <span class="bg-bgcolor border-none rounded px-2 py-1 text-sm">{languageMode}</span>
                {/if}
                <button
                    class="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 transition"
                    onclick={() => (popUpEditorStore.open = false)}
                >
                    X
                </button>
            </div>
        </div>
        <div class="flex-1 rounded-md overflow-hidden border border-darkborderc">
            {#if previewing}
                <div class="h-full w-full flex">
                    <div class="flex-1 flex flex-col gap-4 overflow-hidden">
                        <div class="flex-1 overflow-y-auto overflow-x-auto max-w-full border border-darkborderc bg-bgcolor p-4">
                            <pre class="m-0">{chatParserValue}</pre>
                        </div>

                        <div class="text-sm p-4 text-gray-500 flex overflow-x-auto">
                            <button class={{
                                "bg-primary text-white hover:bg-primary/90": showToggles,
                                "bg-gray-500 text-white hover:bg-gray-600": !showToggles,
                                "px-3 py-1 rounded transition": true,
                            }} onclick={() => {
                                showToggles = !showToggles
                            }}>Toggles</button>
                            <span class="ml-auto">{tokens} tokens</span>
                        </div>
                    </div>
                    {#if showToggles}
                        <div class="w-64 border-l border-darkborderc overflow-y-auto p-2">
                            <Toggles chara={getCurrentCharacter()} />
                        </div>
                    {/if}
                </div>
            {:else}
                {#if MonacoComponent}
                    <MonacoComponent bind:value={popUpEditorStore.value} language={languageMode} />
                {/if}
            {/if}
        </div>
    </div>
</div>
