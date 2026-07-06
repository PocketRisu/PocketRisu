<script lang="ts">
    // Inline pipeline stepper for 'detailed' request-status display mode.
    // Renders the ordered step checklist (Hypa memory / MultiAgent sub-agents /
    // generation) for one request-status entry, all steps visible at once with
    // the current one highlighted. Disappears the instant the entry goes
    // terminal — no retention delay (that's the 'modal' toast's concern, not
    // this one's; see requestStatusReaper.ts for store-level cleanup).
    //
    // Used two ways by the chat area (see Chats.svelte / Chat.svelte):
    // - as a synthetic row appended after the last real message, before the
    //   real placeholder message exists yet (covers Hypa + MultiAgent, which
    //   produce no chat-log row of their own);
    // - anchored inside the real assistant message row once it exists.
    import { requestStatuses, isTerminalPhase, type PipelineStepStatus } from 'src/ts/status/requestStatus'
    import { language } from 'src/lang'
    import { CheckIcon, XIcon, RotateCwIcon } from '@lucide/svelte'

    interface Props {
        id: string
    }

    let { id }: Props = $props()

    const entry = $derived($requestStatuses.get(id))
    const steps = $derived(entry?.steps ?? [])
    const visible = $derived(!!entry && steps.length > 0 && !isTerminalPhase(entry.phase))

    const rs = language.requestStatus
    const STATUS_LABEL: Record<PipelineStepStatus, string> = {
        pending: rs?.stepPending ?? 'Pending',
        active: rs?.stepActive ?? 'In progress',
        done: rs?.stepDone ?? 'Done',
        error: rs?.stepError ?? 'Error',
        skipped: rs?.stepSkipped ?? 'Skipped',
    }
</script>

{#if visible}
    <div class="rsi-root" role="status" aria-live="polite">
        <ol class="rsi-steps">
            {#each steps as step (step.key)}
                <li class="rsi-step rsi-step-{step.status}">
                    <span class="rsi-icon" aria-hidden="true">
                        {#if step.status === 'done'}
                            <CheckIcon size={12} />
                        {:else if step.status === 'error'}
                            <XIcon size={12} />
                        {:else if step.status === 'skipped'}
                            <span class="rsi-dash">—</span>
                        {:else if step.status === 'active'}
                            <RotateCwIcon size={12} class="rsi-spin" />
                        {:else}
                            <span class="rsi-dot"></span>
                        {/if}
                    </span>
                    <span class="rsi-label">{step.label}</span>
                    <span class="rsi-sr-only">{STATUS_LABEL[step.status]}</span>
                </li>
            {/each}
        </ol>
    </div>
{/if}

<style>
    .rsi-root {
        display: flex;
        margin-bottom: 0.6rem;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.5rem;
        background: var(--risu-theme-darkbg);
    }
    .rsi-steps {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 1rem;
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .rsi-step {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.8rem;
        color: var(--risu-theme-textcolor2);
        white-space: nowrap;
    }
    .rsi-step-done { color: var(--risu-theme-textcolor); }
    .rsi-step-active { color: var(--risu-theme-textcolor); font-weight: 600; }
    .rsi-step-error { color: var(--risu-theme-draculared); }
    .rsi-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
        flex-shrink: 0;
    }
    .rsi-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        border: 1px solid var(--risu-theme-textcolor2);
    }
    .rsi-dash { font-size: 0.7rem; line-height: 1; }
    :global(.rsi-spin) {
        color: var(--risu-theme-primary);
        animation: rsi-spin 1s linear infinite;
    }
    @keyframes rsi-spin {
        to { transform: rotate(360deg); }
    }
    .rsi-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }
</style>
