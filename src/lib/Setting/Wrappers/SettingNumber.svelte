<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingRowLayout from './SettingRowLayout.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });
</script>

{#if ctx.layout === 'row' || ctx.layout === 'block'}
    <!-- A number field needs no full-width control, so the block layout is
         identical to the row layout: label + inline help stacked on the left,
         compact input vertically centered on the right (SettingRowLayout). -->
    <SettingRowLayout {item}>
        {#snippet control()}
            <NumberInput
                className="w-24"
                size="sm"
                padding={true}
                min={item.options?.min}
                max={item.options?.max}
                bind:value={localValue}
            />
        {/snippet}
    </SettingRowLayout>
{:else}
    <span class="text-textcolor {item.classes ?? ''}">
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <NumberInput
        className="mt-2"
        marginBottom={true}
        min={item.options?.min}
        max={item.options?.max}
        bind:value={localValue}
    />
{/if}
