<script lang="ts">
    import ColorPicker from 'svelte-awesome-color-picker';
    interface Props {
        value?: string;
        nullable?: boolean;
        oninput?: () => void;
    }

    let { value = $bindable('#000000'), nullable = false, oninput }: Props = $props();

    $effect(() => {
        //this is for updating
        value

        oninput?.()
    });
</script>

<div class="cl rounded-full bg-white">
    <ColorPicker
        label="" bind:hex={value}
        nullable={nullable}
    />
</div>

<style>
    .cl{
        --cp-bg-color: var(--risu-theme-bgcolor);
        --cp-border-color: var(--risu-theme-darkborderc);
        --cp-text-color: var(--risu-theme-textcolor);
        --cp-input-color: #555;
        --cp-button-hover-color: #777;
    }

    /*
     * Anchor the picker popup to the swatch's right edge so it always opens
     * leftward (into the panel). The library's responsive positioning measures
     * window width, not the narrow centered settings panel, so on a wide/fullscreen
     * window it wrongly opens the popup rightward and it gets clipped past the
     * panel edge. Our color swatches sit on the right side of the panel, so
     * left-opening keeps the popup inside. NOTE: assumes a right-aligned swatch —
     * see SettingColor.svelte (left-aligned) if it ever becomes active.
     */
    .cl :global(.wrapper[role="dialog"]) {
        left: auto !important;
        right: 0;
    }
</style>