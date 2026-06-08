<script lang="ts">
    // Vertical radio group — bits-ui RadioGroup port with RisuAI theming.
    // The whole row (indicator + label) is the clickable RadioGroup.Item.
    import { RadioGroup } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    interface Props {
        value?: string;
        options?: { value: string; label: string; description?: string }[];
        name?: string;
        disabled?: boolean;
        className?: string;
    }

    let {
        value = $bindable(''),
        options = [],
        name,
        disabled = false,
        className = '',
    }: Props = $props();
</script>

<RadioGroup.Root
    bind:value
    {name}
    {disabled}
    orientation="vertical"
    class={cn('flex flex-col gap-0.5', className)}
>
    {#each options as opt (opt.value)}
        <RadioGroup.Item
            value={opt.value}
            class={
                'group flex gap-2.5 w-full text-left text-sm text-textcolor ' +
                (opt.description ? 'items-start ' : 'items-center ') +
                'py-1.5 px-1 rounded-md outline-none transition-colors ' +
                'hover:bg-selected/30 focus-visible:ring-2 focus-visible:ring-borderc/50 ' +
                'disabled:opacity-50 disabled:cursor-not-allowed'
            }
        >
            <span
                class={'relative shrink-0 size-4 rounded-full border border-darkborderc transition-colors group-data-[state=checked]:border-primary' + (opt.description ? ' mt-0.5' : '')}
            >
                <span
                    class="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity group-data-[state=checked]:opacity-100"
                ></span>
            </span>
            <span class="min-w-0">
                <span>{opt.label}</span>
                {#if opt.description}
                    <span class="block text-xs text-textcolor2">{opt.description}</span>
                {/if}
            </span>
        </RadioGroup.Item>
    {/each}
</RadioGroup.Root>
