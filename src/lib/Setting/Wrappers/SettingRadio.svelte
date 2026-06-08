<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import ShRadio from 'src/lib/UI/GUI/ShRadio.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import { language } from 'src/lang';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });

    // Resolve labelKey → localized label (like SettingSelect).
    let processedOptions = $derived(
        (item.options?.selectOptions ?? [])
            .filter((opt) => !opt.condition || opt.condition(ctx))
            .map((opt) => ({
                value: String(opt.value),
                label: opt.labelKey ? (language as any)[opt.labelKey] : (opt.label ?? ''),
                description: opt.descriptionKey ? (language as any)[opt.descriptionKey] : undefined,
            }))
    );

    const helpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : undefined
    );
</script>

{#if ctx.layout === 'row'}
    <!-- Radio groups are vertical, so they stay stacked even in row mode. -->
    <div class="py-3 border-t border-darkborderc">
        <span class="text-sm text-textcolor">{getLabel(item)}</span>
        {#if helpText}<p class="text-xs text-textcolor2 mt-0.5">{helpText}</p>{/if}
        <ShRadio className="mt-2" bind:value={localValue} options={processedOptions} />
    </div>
{:else}
    <span class="text-textcolor {item.classes ?? 'mt-4'}">
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <ShRadio className="mt-2" bind:value={localValue} options={processedOptions} />
{/if}
