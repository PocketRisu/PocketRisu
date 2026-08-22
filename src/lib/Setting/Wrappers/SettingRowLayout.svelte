<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { SettingItem } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import { language } from 'src/lang';

    interface Props {
        item: SettingItem;
        /** The control, rendered right-aligned and vertically centered. */
        control?: Snippet;
    }

    let { item, control }: Props = $props();

    // Inline help text under the label (replaces the tooltip icon in row mode).
    const helpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : undefined
    );
</script>

<!-- data-setting-id: anchor for settings search deep-links (searchIndex.ts) -->
<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc" data-setting-id={item.id}>
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{getLabel(item)}</span>
        {#if helpText}<p class="text-xs text-textcolor2 mt-0.5 whitespace-pre-line">{helpText}</p>{/if}
    </div>
    <div class="shrink-0">{@render control?.()}</div>
</div>
