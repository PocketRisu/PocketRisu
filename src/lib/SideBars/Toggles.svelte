<script lang="ts">
    import { getModuleToggles } from "src/ts/process/modules";
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import type { character } from "src/ts/storage/database.svelte";
    import { getCurrentChat, getToggleKeys, getToggleUnsetValues, parseToggleKeysFromTemplate, snapshotToggleBinding, snapshotToggleValues, saveTogglesToChat } from "src/ts/storage/database.svelte";
    import { getTogglePinScope } from "src/ts/togglePinScope";
    import { alertConfirm, alertConfirmMulti, alertTogglePresets, notifySuccess } from "src/ts/alert";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import { PinIcon, SaveIcon, FolderHeartIcon } from "@lucide/svelte";
    import ShAccordion from '../UI/GUI/ShAccordion.svelte'
    import ShButton from "../UI/GUI/ShButton.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import Help from "../Others/Help.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
    import TextInput from "../UI/GUI/TextInput.svelte";

    interface Props {
        chara?: character
        noContainer?: boolean
    }

    let { chara = $bindable(), noContainer }: Props = $props();

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage])
    let isPinned = $derived(!DBState.db.disableToggleBinding && !!currentChat?.savedToggleValues)
    let toggleTemplate = $derived.by(() => {
        // Track chat/module changes so the toggle list re-derives on chat switch
        const _char = DBState.db.characters[$selectedCharID]
        void _char?.chats?.[_char?.chatPage]?.modules
        void _char?.modules
        void DBState.db.enabledModules
        void DBState.db.moduleIntergration

        return DBState.db.customPromptTemplateToggle + '\n' +
            getModuleToggles() + '\n' +
            ((DBState.db?.characters?.[$selectedCharID] as character)?.customModuleToggle ?? '')
    })
    // An unset select reads as its first option ('0'); see getToggleUnsetValues.
    let unsetToggleValues = $derived(getToggleUnsetValues(toggleTemplate))
    const normToggle = (key: string, v: string | undefined) => v ?? unsetToggleValues[key] ?? ''
    // Only the keys loading the pin restores count as changed; toggles the pin
    // says nothing about keep their value on chat entry (see getTogglePinScope).
    let pinScope = $derived.by(() => {
        void toggleTemplate // re-derive on chat, character and module changes
        return getTogglePinScope(
            currentChat?.savedToggleValues ?? {},
            currentChat?.savedToggleUnsetKeys,
            getToggleKeys(),
            { keys: parseToggleKeysFromTemplate(toggleTemplate), values: snapshotToggleValues() },
        )
    })
    let pinnedKeys = $derived(pinScope.pinnedKeys)

    let dirtyCount = $derived.by(() => {
        if (DBState.db.disableToggleBinding) return 0
        const saved = currentChat?.savedToggleValues
        if (!saved) return 0
        const current = snapshotToggleValues()
        let count = 0
        for (const key of pinnedKeys) {
            if (normToggle(key, saved[key]) !== normToggle(key, current[key])) count++
        }
        return count
    })
    let isDirty = $derived(dirtyCount > 0)
    // Updating also takes in toggles the pin does not cover yet, which never
    // count as changed.
    let canUpdatePin = $derived(isDirty || pinScope.uncoveredKeys.length > 0)

    async function pinToChat() {
        const chat = getCurrentChat()
        if (!chat) return
        if (chat.savedToggleValues) {
            const confirmed = await alertConfirm(language.togglePinRemove)
            if (confirmed) {
                chat.savedToggleValues = undefined
                chat.savedToggleUnsetKeys = undefined
                notifySuccess(language.togglePinUnbound)
            }
        } else {
            saveTogglesToChat()
            notifySuccess(language.togglePinSaved)
        }
    }

    function updatePin() {
        saveTogglesToChat()
        notifySuccess(language.togglePinSaved)
    }

    // Same idea as the model binding's "save as default": new chats start
    // pinned to this snapshot. Existing chats are not touched.
    async function saveAsDefault() {
        if (DBState.db.defaultToggleValues) {
            const sel = await alertConfirmMulti(language.toggleDefaultManage, [
                language.toggleDefaultOverwrite,
                { label: language.toggleDefaultClear, variant: 'destructive' },
            ])
            if (sel === 1) {
                DBState.db.defaultToggleValues = undefined
                DBState.db.defaultToggleUnsetKeys = undefined
                void requestImmediateSave()
                notifySuccess(language.toggleDefaultCleared)
                return
            }
            if (sel !== 0) return
        } else if (!(await alertConfirm(language.toggleSetDefaultConfirm))) {
            return
        }
        const { values, unsetKeys } = snapshotToggleBinding()
        DBState.db.defaultToggleValues = values
        DBState.db.defaultToggleUnsetKeys = unsetKeys
        void requestImmediateSave()
        notifySuccess(language.toggleDefaultSaved)
    }

    async function openPresetList() {
        await alertTogglePresets()
    }

    const jailbreakToggleToken = '{{jbtoggled}}'
    const usesJailbreakToggle = (value?: string) =>
        typeof value === 'string' && value.includes(jailbreakToggleToken)
    const templateUsesJailbreakToggle = (template: PromptItem[]) =>
        template.some(item => {
            if (item.type === 'jailbreak') {
                return true
            }
            if ('text' in item && usesJailbreakToggle(item.text)) {
                // plain, jailbreak, cot
                return true
            }
            if ('innerFormat' in item && usesJailbreakToggle(item.innerFormat)) {
                // persona, description, lorebook, postEverything, memory
                return true
            }
            if ('defaultText' in item && usesJailbreakToggle(item.defaultText)) {
                // author note
                return true
            }
            return false
        })

    let hasJailbreakPrompt = $derived.by(() => {
        const template = DBState.db.promptTemplate
        if (!template) {
            return (DBState.db.jailbreak ?? '').trim().length > 0
        }
        return templateUsesJailbreakToggle(template)
    })

    function isToggleDirty(key: string): boolean {
        if (DBState.db.disableToggleBinding) return false
        const saved = currentChat?.savedToggleValues
        if (!saved) return false
        const fullKey = `toggle_${key}`
        if (!pinnedKeys.has(fullKey)) return false
        return normToggle(fullKey, DBState.db.globalChatVariables[fullKey]) !== normToggle(fullKey, saved[fullKey])
    }


    let groupedToggles = $derived.by(() => {
        const ungrouped = parseToggleSyntax(toggleTemplate)

        let groupOpen = false
        // group toggles together between group ... groupEnd
        return ungrouped.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === 'group') {
                groupOpen = true
                acc.push(toggle)
            } else if (toggle.type === 'groupEnd') {
                groupOpen = false
            } else if (groupOpen) {
                (acc.at(-1) as sidebarToggleGroup).children.push(toggle)
            } else {
                acc.push(toggle)
            }
            return acc
        }, [])
    })

</script>

{#snippet sep()}
    <div class="w-full mt-0.5 -mb-1.5 border-t border-darkborderc/20"></div>
{/snippet}

{#snippet toggles(items: sidebarToggle[], reverse: boolean = false)}
    {#each items as toggle, index}
        {#if index > 0
            && toggle.type !== 'divider' && items[index - 1]?.type !== 'divider'
            && toggle.type !== 'caption' && items[index - 1]?.type !== 'caption'
            && !(toggle.type === 'group' && items[index - 1]?.type === 'group')}
            {@render sep()}
        {/if}
        {#if toggle.type === 'group' && toggle.children.length > 0}
            <ShAccordion class="w-full mt-1" name={toggle.value}>
                {@render toggles((toggle as sidebarToggleGroup).children, reverse)}
            </ShAccordion>
        {:else if toggle.type === 'select'}
            <div class="w-full flex gap-2 mt-2 items-center justify-between min-h-10 rounded-md px-1 transition-colors" class:bg-red-900={isToggleDirty(toggle.key)} class:bg-opacity-15={isToggleDirty(toggle.key)}>
                <span class="min-w-0 break-words">{toggle.value}</span>
                <SelectInput className="w-32 shrink-0" bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]}>
                    {#each toggle.options as option, i}
                        <OptionInput value={i.toString()}>{option}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
        {:else if toggle.type === 'text'}
            <div class="w-full flex gap-2 mt-2 items-center justify-between min-h-10 rounded-md px-1 transition-colors" class:bg-red-900={isToggleDirty(toggle.key)} class:bg-opacity-15={isToggleDirty(toggle.key)}>
                <span class="min-w-0 break-words">{toggle.value}</span>
                <TextInput className="w-32 shrink-0" bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </div>
        {:else if toggle.type === 'textarea'}
            <div class="w-full flex gap-2 mt-2 items-start justify-between min-h-10 rounded-md px-1 transition-colors" class:bg-red-900={isToggleDirty(toggle.key)} class:bg-opacity-15={isToggleDirty(toggle.key)}>
                <span class="min-w-0 break-words mt-1.5">{toggle.value}</span>
                <TextAreaInput className="w-32 shrink-0" height='20' bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </div>
        {:else if toggle.type === 'caption'}
            <div class="w-full mt-1 text-xs text-textcolor2">
                {toggle.value}
            </div>
        {:else if toggle.type === 'divider'}
            <!-- Prevent multiple dividers appearing in a row -->
            {#if index === 0 || items[index - 1]?.type !== 'divider' || items[index - 1]?.value !== toggle.value}
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center" class:justify-end={!reverse}>
                    {#if toggle.value}
                        <span class="shrink-0">{toggle.value}</span>
                    {/if}
                    <hr class="border-t border-darkborderc m-0 grow" />
                </div>
            {/if}
        {:else}
            <div class="w-full flex gap-2 mt-2 items-center justify-between min-h-10 rounded-md px-1 transition-colors" class:bg-red-900={isToggleDirty(toggle.key)} class:bg-opacity-15={isToggleDirty(toggle.key)}>
                <span class="min-w-0 break-words">{toggle.value}</span>
                <ShSwitch
                    className="shrink-0"
                    checked={DBState.db.globalChatVariables[`toggle_${toggle.key}`] === '1'}
                    onCheckedChange={(checked) => {
                        const fullKey = `toggle_${toggle.key}`
                        // Turning off a switch the pin holds unset returns it
                        // to unset, not '0' (CBS reads them differently).
                        const pin = isPinned ? currentChat?.savedToggleValues : undefined
                        if (!checked && pin && pin[fullKey] === undefined) {
                            delete DBState.db.globalChatVariables[fullKey]
                        } else {
                            DBState.db.globalChatVariables[fullKey] = checked ? '1' : '0'
                        }
                    }}
                />
            </div>
        {/if}
    {/each}
{/snippet}

{#if !DBState.db.disableToggleBinding}
<div class="text-[11px] text-textcolor2 mt-4 px-1">{language.toggleBindingLabel}</div>
{/if}
<!-- The preset list stays available with binding disabled: applying a
     preset does not depend on it. -->
<div class="flex gap-1 mt-1 items-stretch" class:justify-end={DBState.db.disableToggleBinding}>
    {#if !DBState.db.disableToggleBinding}
    {#if isPinned}
        <span use:tooltip={language.togglePinRemove}>
            <ShButton variant="primary" size="icon" onclick={pinToChat}>
                <PinIcon size={16} />
            </ShButton>
        </span>
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinUpdate}>
            <ShButton
                variant={isDirty ? 'destructive' : 'default'}
                disabled={!canUpdatePin}
                className="w-full"
                onclick={canUpdatePin ? updatePin : undefined}
            >
                <SaveIcon size={16} class="shrink-0" />
                <span class="truncate">{isDirty ? dirtyCount : language.togglePinUpdateLabel}</span>
            </ShButton>
        </span>
    {:else}
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinToChat}>
            <ShButton className="w-full" onclick={pinToChat}>
                <PinIcon size={16} class="shrink-0" />
                <span class="truncate">{language.togglePinLabel}</span>
            </ShButton>
        </span>
    {/if}
    {/if}
    <span use:tooltip={language.togglePresetList}>
        <ShButton size="icon" onclick={openPresetList}>
            <FolderHeartIcon size={16} />
        </ShButton>
    </span>
</div>

{#if !noContainer && groupedToggles.length > 4}
    <div class="h-48 border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2 overflow-y-auto">
        {#if hasJailbreakPrompt}
            <div class="w-full flex gap-2 mt-2 items-center justify-between min-h-10 rounded-md px-1">
                <span class="min-w-0 break-words">{language.jailbreakToggle}</span>
                <ShSwitch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
            </div>
            {@render sep()}
        {/if}
        {@render toggles(groupedToggles, true)}
    </div>
{:else}
    {#if hasJailbreakPrompt}
        <div class="w-full flex gap-2 mt-2 items-center justify-between min-h-10 rounded-md px-1">
            <span class="min-w-0 break-words">{language.jailbreakToggle}</span>
            <ShSwitch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
        </div>
        {#if groupedToggles.length > 0}
            {@render sep()}
        {/if}
    {/if}
    {@render toggles(groupedToggles)}
{/if}

{#if !DBState.db.disableToggleBinding && currentChat}
    <ShButton variant="ghost" size="xs" className="w-full text-textcolor2 mt-1" onclick={saveAsDefault}>
        {DBState.db.defaultToggleValues ? language.toggleDefaultSavedButton : language.toggleSaveAsDefaultButton}
    </ShButton>
{/if}
