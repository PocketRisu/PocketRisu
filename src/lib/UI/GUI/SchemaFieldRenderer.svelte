<script lang="ts">
    import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import { language } from "src/lang";
    import { localizeDescription } from "src/ts/preset/registry/i18n";
    import { XIcon } from "@lucide/svelte";
    import TextInput from "./TextInput.svelte";
    import SecretInput from "./SecretInput.svelte";
    import CredentialField from "src/lib/Setting/Pages/Model/CredentialField.svelte";
    import TextAreaInput from "./TextAreaInput.svelte";
    import NumberInput from "./NumberInput.svelte";
    import ShSlider from "./ShSlider.svelte";
    import SelectInput from "./SelectInput.svelte";
    import ShSelect from "./ShSelect.svelte";
    import OptionInput from "./OptionInput.svelte";
    import CheckInput from "./CheckInput.svelte";

    interface Props {
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
        // Present only in the ModelPreset editor. Lets auth (`secret`) fields
        // render the saved-key picker, which binds the preset-level apiKeyRef.
        preset?: ModelPreset;
    }

    let { schemaField, uiField, userValues = $bindable(), preset }: Props = $props();

    const fieldKey = $derived(schemaField.key);
    const isAuthField = $derived(schemaField.mapsTo?.target === 'auth');

    // Reset (clear-to-undefined) is offered for optional scalar widgets where
    // a value is present. textarea/string-array/json/key-value let the user
    // clear by emptying the textarea directly, so we skip the button there.
    const resetableWidgets = new Set([
        'text', 'secret', 'number-input', 'slider',
        'select', 'segmented', 'toggle', 'combobox',
    ]);
    const showReset = $derived(
        !schemaField.required &&
        userValues[fieldKey] !== undefined &&
        resetableWidgets.has(uiField.widget)
    );

    function resetField() {
        userValues[fieldKey] = undefined;
    }

    const localizedDescription = $derived(localizeDescription(schemaField));

    // stringArray widget: textarea one-per-line, syncs to/from userValues[key]: string[]
    let stringArrayText = $state('');
    let stringArrayInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (stringArrayInitialized) return;
        const v = userValues[fieldKey];
        stringArrayText = Array.isArray(v) ? v.join('\n') : '';
        stringArrayInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (!stringArrayInitialized) return;
        const lines = stringArrayText.split('\n').map(s => s.trim()).filter(Boolean);
        userValues[fieldKey] = lines.length === 0 ? undefined : lines;
    });

    // combobox widget: a free-text input (the source of truth) plus a
    // suggestions dropdown that writes the picked value into it. Replaces the
    // native <datalist>, whose rendering is delegated to the browser and
    // misbehaves on mobile (suggestion taps not committing, crashes on Samsung
    // Internet). The dropdown reuses ShSelect, so touch devices fall back to
    // the OS-native picker. Suggestions display the raw value (the model id),
    // not a prettified label, so what you pick is exactly what's sent — and the
    // pretty label never hides a "-preview"/date suffix.
    const comboOptions = $derived(
        uiField.widget === 'combobox'
            ? (schemaField.enum ?? []).filter(Boolean).map(o => String(o.value))
            : []
    );
    // The dropdown mirrors the text value only when it matches a suggestion;
    // otherwise it rests on the placeholder. userValues stays the single source
    // of truth — the dropdown never carries independent state that could desync.
    let comboPick = $state('');
    $effect(() => {
        if (uiField.widget !== 'combobox') return;
        const current = String(userValues[fieldKey] ?? '');
        comboPick = comboOptions.includes(current) ? current : '';
    });
    function comboSelect(picked: string) {
        // Ignore the placeholder ("") — clearing is done via the text field /
        // reset button, never by re-selecting the "choose a suggestion" row.
        if (picked) userValues[fieldKey] = picked;
    }

    // JSON widget: stringify on read, parse on write. Errors surface inline.
    // We seed jsonText from userValues once on mount, then user edits jsonText
    // and an $effect parses+commits on every change (invalid JSON keeps the
    // last good value but shows the error).
    let jsonText = $state('');
    let jsonError = $state<string | null>(null);
    let jsonInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (jsonInitialized) return;
        const v = userValues[fieldKey];
        try {
            jsonText = v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
        } catch {
            jsonText = '';
        }
        jsonInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (!jsonInitialized) return;
        if (jsonText.trim() === '') {
            userValues[fieldKey] = undefined;
            jsonError = null;
            return;
        }
        try {
            userValues[fieldKey] = JSON.parse(jsonText);
            jsonError = null;
        } catch (e) {
            jsonError = e instanceof Error ? e.message : String(e);
        }
    });
</script>

{#if isAuthField && preset}
    <CredentialField {preset} {schemaField} {uiField} bind:userValues />
{:else}
<div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
        <span class="text-sm text-textcolor flex items-center gap-1">
            {schemaField.label}
            {#if schemaField.required}<span class="text-red-400">*</span>{/if}
        </span>
        {#if showReset}
            <button
                type="button"
                class="text-textcolor2 hover:text-red-400 transition-colors flex items-center gap-1 text-xs"
                title={language.reset}
                onclick={resetField}
            >
                <XIcon size={12} />
                <span>{language.reset}</span>
            </button>
        {/if}
    </div>
    {#if localizedDescription}
        <span class="text-xs text-textcolor2">{localizedDescription}</span>
    {/if}

    {#if uiField.widget === 'text'}
        <TextInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'secret'}
        <SecretInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'textarea'}
        <TextAreaInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
            autocomplete="off"
            height="24"
        />
    {:else if uiField.widget === 'number-input'}
        <NumberInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min}
            max={schemaField.max}
            fullwidth
        />
    {:else if uiField.widget === 'slider'}
        <ShSlider
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min ?? 0}
            max={schemaField.max ?? 100}
            step={schemaField.step ?? 1}
        />
    {:else if uiField.widget === 'select'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each (schemaField.enum ?? []).filter(Boolean) as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'segmented'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each (schemaField.enum ?? []).filter(Boolean) as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'toggle'}
        <CheckInput bind:check={userValues[fieldKey] as boolean} name={schemaField.label} />
    {:else if uiField.widget === 'combobox'}
        <input
            type="text"
            class="bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-textcolor focus:outline-hidden focus:ring-2 focus:ring-borderc"
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
        />
        {#if comboOptions.length > 0}
            <ShSelect bind:value={comboPick} onchange={(e) => comboSelect(e.currentTarget.value)}>
                <OptionInput value="">{language.modelPresetPickSuggestion}</OptionInput>
                {#each comboOptions as opt}
                    <OptionInput value={opt}>{opt}</OptionInput>
                {/each}
            </ShSelect>
        {/if}
    {:else if uiField.widget === 'string-array'}
        <TextAreaInput
            bind:value={stringArrayText}
            placeholder={uiField.placeholder ?? '한 줄에 하나씩'}
            fullwidth
            autocomplete="off"
            height="20"
        />
    {:else if uiField.widget === 'json' || uiField.widget === 'key-value'}
        <TextAreaInput
            bind:value={jsonText}
            placeholder={uiField.placeholder ?? '{}'}
            fullwidth
            autocomplete="off"
            height="32"
        />
        {#if jsonError}
            <span class="text-xs text-red-400">{jsonError}</span>
        {/if}
    {/if}
</div>
{/if}
