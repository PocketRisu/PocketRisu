<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';

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

<!--
    WARNING: the swatch here is LEFT-aligned, unlike the other ColorInput usages
    (CustomColorSchemeEditor / CustomTextThemeEditor) which are right-aligned.
    ColorInput.svelte forces the picker popup to open leftward (right:0) to fix a
    clipping bug on wide/fullscreen windows. That assumes a right-aligned swatch;
    with this left-aligned layout the popup may instead clip past the panel's left
    edge. No setting currently registers type 'color', so this is dormant — but if
    a 'color' setting is added, revisit popup alignment here before relying on it.
-->
<div class="flex items-center {item.classes ?? 'mt-2'}">
    <ColorInput bind:value={localValue} nullable={item.options?.nullable ?? false} />
    <span class="ml-2">{getLabel(item)}</span>
</div>
