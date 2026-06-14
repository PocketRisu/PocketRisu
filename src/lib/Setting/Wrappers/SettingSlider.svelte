<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import { language } from 'src/lang';
    import SliderInput from 'src/lib/UI/GUI/SliderInput.svelte';
    import ShSlider from 'src/lib/UI/GUI/ShSlider.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
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

    let customText = $derived(
        typeof item.options?.customText === 'function'
            ? item.options.customText(localValue)
            : item.options?.customText
    );

    // Read-only display formatter for the ShSlider row layout: only for sliders
    // whose value maps to a word/unit label (customText). Numeric sliders —
    // including fixed/decimal ones like line height — keep ShSlider's editable
    // input so the user can type a precise value.
    let rowFormat = $derived.by(() => {
        const ct = item.options?.customText;
        if (ct === undefined) return undefined;
        return typeof ct === 'function' ? ct : () => ct as string;
    });

    // ── 'block' layout (ModelPreset-editor field grammar) ──────────────────
    // Label row + inline help text + FULL-WIDTH ShSlider, with the row layout's
    // divider rhythm (border-t, dropped on the first field by SettingRenderer).
    // The legacy SliderInput operates on RAW stored values (e.g. temperature
    // 0–200 hundredths) and only scales at display time via `multiple`; ShSlider
    // has no such concept, so the block branch converts to real units at the
    // binding boundary (track/input show 0.00–2.00, storage stays 0–200).
    // The -1000 "slider disabled" sentinel is surfaced as a header ShSwitch
    // (the slot the ModelPreset editor uses for its Reset affordance); turning
    // it on restores `min`, matching the legacy checkbox behavior.
    let blockHelpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : undefined
    );

    function roundReal(v: number): number {
        return Math.round(v * 1e6) / 1e6;
    }

    let blockMult = $derived(item.options?.multiple ?? 1);
    let blockMin = $derived(roundReal((item.options?.min ?? 0) * blockMult));
    let blockMax = $derived(roundReal((item.options?.max ?? 100) * blockMult));
    let blockStep = $derived(roundReal((item.options?.step ?? 1) * blockMult));
    let blockEnabled = $derived(typeof localValue === 'number' && localValue !== -1000);

    function readBlockValue(): number {
        if (!blockEnabled) return blockMin;
        return roundReal(localValue * blockMult);
    }

    function writeBlockValue(v: number) {
        localValue = roundReal(v / blockMult);
    }

    function setBlockEnabled(on: boolean) {
        localValue = on ? (item.options?.min ?? 0) : -1000;
    }
</script>

{#if ctx.layout === 'row'}
    <SettingRowLayout {item}>
        {#snippet control()}
            <div class="w-48">
                <ShSlider
                    min={item.options?.min ?? 0}
                    max={item.options?.max ?? 100}
                    step={item.options?.step ?? 1}
                    format={rowFormat}
                    inputWidth="w-16"
                    bind:value={localValue}
                />
            </div>
        {/snippet}
    </SettingRowLayout>
{:else if ctx.layout === 'block'}
    <!-- SettingRowLayout grammar (label + inline help stacked left, affordance
         vertically centered right), plus a full-width slider third line. Markup
         is replicated rather than nesting SettingRowLayout because the divider
         (border-t/py-3) must wrap the slider line too. -->
    <div class="py-3 border-t border-darkborderc">
        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col min-w-0">
                <span class="text-sm text-textcolor {item.classes ?? ''}">{getLabel(item)}</span>
                {#if blockHelpText}<p class="text-xs text-textcolor2 mt-0.5">{blockHelpText}</p>{/if}
            </div>
            {#if item.options?.disableable}
                <div class="shrink-0">
                    <ShSwitch checked={blockEnabled} onCheckedChange={setBlockEnabled} />
                </div>
            {/if}
        </div>
        {#if !item.options?.disableable || blockEnabled}
            <ShSlider
                className="mt-2"
                min={blockMin}
                max={blockMax}
                step={blockStep}
                bind:value={readBlockValue, writeBlockValue}
            />
        {/if}
    </div>
{:else}
    <span class="text-textcolor {item.classes ?? ''}">
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <SliderInput
        className="mt-2"
        marginBottom={true}
        min={item.options?.min}
        max={item.options?.max}
        step={item.options?.step}
        fixed={item.options?.fixed}
        multiple={item.options?.multiple}
        disableable={item.options?.disableable}
        {customText}
        bind:value={localValue}
    />
{/if}
