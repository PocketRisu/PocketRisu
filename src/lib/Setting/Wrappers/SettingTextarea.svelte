<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import { language } from 'src/lang';

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
    <!-- Multiline stays stacked (input below), but the label matches row styling:
         14px label + inline help text, consistent with select/slider rows. -->
    <div class="py-3 border-t border-darkborderc">
        <span class="text-sm text-textcolor">{getLabel(item)}</span>
        {#if item.helpKey && (language.help as any)[item.helpKey]}
            <p class="text-xs text-textcolor2 mt-0.5">{(language.help as any)[item.helpKey]}</p>
        {/if}
        <TextAreaInput
            className="mt-2"
            bind:value={localValue}
            placeholder={item.options?.placeholder}
        />
    </div>
{:else}
    <span class="text-textcolor {item.classes ?? ''}" data-setting-id={item.id}>
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <TextAreaInput
        className="mt-2 mb-4"
        bind:value={localValue}
        placeholder={item.options?.placeholder}
    />
{/if}
