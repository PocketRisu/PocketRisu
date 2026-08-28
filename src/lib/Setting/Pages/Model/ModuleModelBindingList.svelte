<script lang="ts">
    // Dynamic per-module rows for the Model Preset page's "Module Binding" tab.
    // Derives the row skeleton from SettingRowLayout rather than re-inventing it
    // (ui.md "Setting 레이아웃 작업 원칙" #1), feeding it a synthetic SettingItem
    // per module so the label/divider rhythm matches the declarative rows above.
    import { DBState } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import SettingRowLayout from 'src/lib/Setting/Wrappers/SettingRowLayout.svelte'
    import type { SettingItem } from 'src/ts/setting/types'
    import {
        getModuleBindingPresetId,
        listModelCallingModules,
        moduleBindingKeys,
    } from 'src/ts/process/moduleModelBinding'

    // Read from db.modules (every installed module), not getModules() — the
    // latter is scoped to the character/chat currently open, which would make
    // this global page show a different list depending on where the user came from.
    let modules = $derived(listModelCallingModules(
        DBState.db.modules ?? [],
        DBState.db.lightBoardModuleBindingCompatibilityMode ?? true,
    ))

    let bindings = $derived(DBState.db.moduleModelBindings ?? {})
    let presets = $derived(DBState.db.modelPresets ?? [])

    /** A stored id whose preset no longer exists. Kept, not cleared, so a
     * re-imported preset reconnects; surfaced here so it does not look bound. */
    function isDangling(module: typeof modules[number]): boolean {
        const id = getModuleBindingPresetId(module, bindings)
        return !!id && !presets.some((p) => p.id === id)
    }

    function rowItem(moduleId: string, name: string): SettingItem {
        return {
            id: `modelPreset.moduleBinding.${moduleId}`,
            type: 'custom',
            fallbackLabel: name,
        }
    }

    function setBinding(module: typeof modules[number], presetId: string) {
        DBState.db.moduleModelBindings ??= {}
        const [preferredKey, ...legacyKeys] = moduleBindingKeys(module)
        if (presetId) {
            DBState.db.moduleModelBindings[preferredKey] = presetId
        } else {
            delete DBState.db.moduleModelBindings[preferredKey]
        }
        for (const legacyKey of legacyKeys) {
            delete DBState.db.moduleModelBindings[legacyKey]
        }
    }
</script>

{#if modules.length === 0}
    <div class="text-textcolor2 text-sm py-3 border-t border-darkborderc">
        {language.moduleModelBindingEmpty}
    </div>
{:else}
    <!-- Off: rows stay visible (so the user can see what is configured before
         switching it on) but are not interactive. -->
    <div
        class:opacity-50={!DBState.db.moduleModelBindingsEnabled}
        class:pointer-events-none={!DBState.db.moduleModelBindingsEnabled}
    >
        {#each modules as module (module.id)}
            <SettingRowLayout item={rowItem(module.id, module.name)}>
                {#snippet control()}
                    <ShSelect
                        className="w-48"
                        size="sm"
                        value={isDangling(module) ? '' : (getModuleBindingPresetId(module, bindings) ?? '')}
                        onchange={(e) => setBinding(module, e.currentTarget.value)}
                    >
                        <OptionInput value="">{language.moduleModelBindingUnset}</OptionInput>
                        {#each presets as preset (preset.id)}
                            <OptionInput value={preset.id}>{preset.name}</OptionInput>
                        {/each}
                    </ShSelect>
                {/snippet}
            </SettingRowLayout>
            {#if isDangling(module)}
                <p class="text-xs text-draculared pb-3">{language.moduleModelBindingDangling}</p>
            {/if}
        {/each}
    </div>
{/if}
