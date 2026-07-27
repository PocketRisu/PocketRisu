<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { changeUserPersona } from "src/ts/persona";


    interface Props {
        close?: any;
        onSelect?: ((index: number) => void) | null;
    }

    let { close = () => {}, onSelect = null }: Props = $props();

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center" data-risu-modal-scroll data-risu-modal="" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); }}} onclick={close}>
    <div class="risu-modal-panel bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#each DBState.db.personas as persona, i}
            <button onclick={() => {
                if (onSelect) {
                    onSelect(i)
                } else {
                    changeUserPersona(i)
                }
                close()
            }} class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === DBState.db.selectedPersona}>
                <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                    <span class="font-medium">{persona.name}</span>
                    {#if persona.note}
                        <span class="opacity-75"> / {persona.note}</span>
                    {/if}
                </span>
            </button>
        {/each}
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
@keyframes risu-modal-in {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to   { opacity: 1; transform: none; }
}
.risu-modal-panel {
    animation: risu-modal-in var(--dur-base, 200ms) cubic-bezier(0.2, 0, 0, 1) both;
}
</style>