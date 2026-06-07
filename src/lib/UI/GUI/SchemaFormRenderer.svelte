<script lang="ts">
    import type {
        ModelPreset,
        RegistryFieldSchema,
        RegistryUiField,
        RegistryUiGroup,
        RegistryUiSchema,
        UiVisibility,
    } from "src/ts/preset/types";
    import { localizeGroupLabel } from "src/ts/preset/registry/i18n";
    import SchemaFieldRenderer from "./SchemaFieldRenderer.svelte";

    interface Props {
        schema: RegistryFieldSchema[];
        uiSchema: RegistryUiSchema;
        userValues: Record<string, unknown>;
        visibility: UiVisibility;
        // Passed through to auth fields so they can render the saved-key picker.
        preset?: ModelPreset;
    }

    let { schema, uiSchema, userValues = $bindable(), visibility, preset }: Props = $props();

    // Seed defaults into userValues for fields that the snapshot defines a
    // `default` for. Idempotent — only writes when the key is still undefined.
    $effect(() => {
        for (const field of schema) {
            if (userValues[field.key] === undefined && field.default !== undefined) {
                userValues[field.key] = field.default;
            }
        }
    });

    type RenderEntry = { schemaField: RegistryFieldSchema; uiField: RegistryUiField };

    function visibleEntries(): RenderEntry[] {
        const out: RenderEntry[] = [];
        for (const uiField of uiSchema.fields) {
            // Tolerate null/undefined elements from a malformed/persisted snapshot
            // so a single bad entry can't crash rendering (reading `.visibility` of null).
            if (!uiField) continue;
            if (uiField.visibility !== visibility) continue;
            if (!evalShowIf(uiField)) continue;
            const schemaField = schema.find((f) => f.key === uiField.key);
            if (!schemaField) continue;
            out.push({ schemaField, uiField });
        }
        return out;
    }

    function evalShowIf(uiField: RegistryUiField): boolean {
        const cond = uiField.showIf;
        if (!cond) return true;
        const v = userValues[cond.key];
        if (cond.equals !== undefined) return v === cond.equals;
        if (cond.notEquals !== undefined) return v !== cond.notEquals;
        return true;
    }

    const entries = $derived(visibleEntries());

    const groupedRendered = $derived.by(() => {
        // Tolerate null/undefined group elements from a malformed/persisted
        // snapshot so a bad entry can't crash the sort (reading `.order` of null).
        const groupOrder = uiSchema.groups
            .filter(Boolean)
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

        // entries grouped by group id (or '' for un-grouped)
        const buckets = new Map<string, RenderEntry[]>();
        for (const entry of entries) {
            const key = entry.uiField.group ?? '';
            const arr = buckets.get(key) ?? [];
            arr.push(entry);
            buckets.set(key, arr);
        }
        for (const arr of buckets.values()) {
            arr.sort((a, b) => (a.uiField.order ?? 999) - (b.uiField.order ?? 999));
        }

        const out: { label: string | null; items: RenderEntry[] }[] = [];
        for (const group of groupOrder) {
            const items = buckets.get(group.id);
            if (items && items.length > 0) {
                out.push({ label: localizeGroupLabel(group), items });
            }
        }
        const ungrouped = buckets.get('');
        if (ungrouped && ungrouped.length > 0) {
            out.push({ label: null, items: ungrouped });
        }
        return out;
    });
</script>

{#if groupedRendered.length === 0}
    <p class="text-textcolor2 text-sm py-4">표시할 항목이 없습니다.</p>
{:else}
    <div class="flex flex-col gap-6">
        {#each groupedRendered as group}
            <div class="flex flex-col gap-3">
                {#if group.label}
                    <h3 class="text-sm font-semibold text-textcolor2 uppercase tracking-wide">{group.label}</h3>
                {/if}
                {#each group.items as { schemaField, uiField } (uiField.key)}
                    <SchemaFieldRenderer {schemaField} {uiField} bind:userValues {preset} />
                {/each}
            </div>
        {/each}
    </div>
{/if}
