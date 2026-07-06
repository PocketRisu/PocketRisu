<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue, isItemDisabled, getDisabledTooltip } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SettingRowLayout from './SettingRowLayout.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let isDisabled = $derived(isItemDisabled(item, ctx));
    let disabledTooltip = $derived(isDisabled ? getDisabledTooltip(item) : undefined);

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded — only fires on actual user changes)
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
            <div title={disabledTooltip}>
                <ShSwitch checked={!!localValue} disabled={isDisabled} onCheckedChange={(v) => { if (!isDisabled) localValue = v; }} />
            </div>
        {/snippet}
    </SettingRowLayout>
{:else}
    <div class="flex items-center {item.classes ?? 'mt-2'}">
        <Check bind:check={localValue} name={getLabel(item)} disabled={isDisabled} title={disabledTooltip}>
            {#if item.showExperimental}<Help key="experimental"/>{/if}
            {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false}/>{/if}
        </Check>
    </div>
{/if}
