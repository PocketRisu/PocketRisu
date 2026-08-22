<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte';
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

{#if ctx.layout === 'row'}
    <SettingRowLayout {item}>
        {#snippet control()}
            <TextInput
                className="w-48 text-sm"
                bind:value={localValue}
                placeholder={item.options?.placeholder}
                hideText={item.options?.hideText}
            />
        {/snippet}
    </SettingRowLayout>
{:else}
    <span class="text-textcolor {item.classes ?? ''}" data-setting-id={item.id}>
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <TextInput
        className="mt-2"
        marginBottom={true}
        bind:value={localValue}
        placeholder={item.options?.placeholder}
        hideText={item.options?.hideText}
    />
{/if}
