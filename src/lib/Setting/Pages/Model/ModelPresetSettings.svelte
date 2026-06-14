<script lang="ts">
    import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, BellIcon, CopyIcon, PlusIcon, TrashIcon, TriangleAlertIcon } from "@lucide/svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import SchemaFormRenderer from "src/lib/UI/GUI/SchemaFormRenderer.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelPresetBasicInfo from "./ModelPresetBasicInfo.svelte";
    import ApiKeyPoolManager from "./ApiKeyPoolManager.svelte";
    import ModelPresetOptions from "./ModelPresetOptions.svelte";
    import RegistryNoticeModal from "./RegistryNoticeModal.svelte";
    import { language } from "src/lang";
    import { DBState, openModelProfileBrowser, modelProfileReplaceTarget, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { testModelPreset, type ModelPresetTestResult } from "src/ts/process/request/request";
    import { getOfficialRegistry, getPresetUpdateStatus, syncRemoteRegistry } from "src/ts/preset/registry";
    import { buildSeenMap, computeRegistryNotice, noticeCount } from "src/ts/preset/registry/notice";
    import { TOOL_CAPABLE_ADAPTER_KINDS, VISION_CAPABLE_ADAPTER_KINDS } from "src/ts/preset/types";
    import { onMount } from "svelte";
    import { v4 as uuidv4 } from "uuid";

    let editingId = $state<string | null>(null);
    let submenu = $state(0);

    // "Test" tab state: a one-shot request through the current preset to verify
    // its credentials/endpoint respond. Reset whenever the edited preset changes.
    let testMessage = $state(language.modelPresetTestDefault);
    let testing = $state(false);
    let testResult = $state<ModelPresetTestResult | null>(null);
    // Top-level page tabs (hidden while editing a preset): 0=presets, 1=keys, 2=settings.
    let page = $state(0);

    // Catalog "new/updated models" notice. Fetch the remote registry on menu
    // entry (debounced), then diff the official registry against the seen-map.
    // First successful sync seeds the baseline silently (no banner).
    let noticeOpen = $state(false);
    const notice = $derived(computeRegistryNotice(getOfficialRegistry(), DBState.db.modelRegistrySeen, DBState.db.modelProfileVisibilityLevel));
    const noticeN = $derived(noticeCount(notice));

    onMount(async () => {
        const res = await syncRemoteRegistry();
        if (res.ok && !DBState.db.modelRegistrySeen) {
            DBState.db.modelRegistrySeen = buildSeenMap(getOfficialRegistry());
        }
    });

    // Acknowledge only when the user ticks "don't show again": overwrite the
    // seen-map so the banner clears. Closing without the tick leaves it.
    function acknowledgeNotice(dismiss: boolean) {
        if (dismiss) DBState.db.modelRegistrySeen = buildSeenMap(getOfficialRegistry());
    }

    const editingPreset = $derived(
        editingId
            ? DBState.db.modelPresets.find(p => p.id === editingId) ?? null
            : null
    );

    // If the preset being edited disappears (deleted elsewhere), fall back to list.
    $effect(() => {
        if (editingId && !editingPreset) {
            editingId = null;
        }
    });

    // Visibility of the advanced "model abilities" toggles. Image input only when
    // the adapter implements vision wire and the snapshot does not already declare
    // 'vision' (declared profiles auto-send, so the toggle would be redundant).
    // System-prompt folding only for openai-compatible (literal role passthrough);
    // anthropic/gemini extract system natively, so folding would strip their system
    // instruction. Sequence shaping (alternate role / user-first) is adapter-agnostic
    // and shows for every preset. Tool use mirrors the prior gate (moved here from
    // the basic-settings tab).
    const showImageInputToggle = $derived(
        !!editingPreset
        && VISION_CAPABLE_ADAPTER_KINDS.includes(editingPreset.profileSnapshot.adapterKind)
        && !(editingPreset.profileSnapshot.capabilities ?? []).includes('vision')
    );
    const showFoldToggles = $derived(
        !!editingPreset && editingPreset.profileSnapshot.adapterKind === 'openai-compatible'
    );
    const showSequenceToggles = $derived(!!editingPreset);
    const showToolUseToggle = $derived(
        !!editingPreset
        && (editingPreset.profileSnapshot.capabilities ?? []).includes('tools')
        && TOOL_CAPABLE_ADAPTER_KINDS.includes(editingPreset.profileSnapshot.adapterKind)
    );
    const showAbilities = $derived(showImageInputToggle || showFoldToggles || showSequenceToggles || showToolUseToggle);
    // Gemini context caching section. Gated like the tool-use toggle: the profile
    // must declare the 'cache' capability AND the adapter must be the one that
    // implements the cache wire (google-gemini). v1 main-chat scope; see
    // gemini-cache-keeper-internalization.md §4-3.
    const showCacheSection = $derived(
        !!editingPreset
        && (editingPreset.profileSnapshot.capabilities ?? []).includes('cache')
        && editingPreset.profileSnapshot.adapterKind === 'google-gemini'
    );

    // Open a freshly-created preset directly in its editor.
    $effect(() => {
        if ($openModelPresetEditId) {
            editingId = $openModelPresetEditId;
            submenu = 0;
            openModelPresetEditId.set(null);
        }
    });

    function duplicate(index: number) {
        const src = DBState.db.modelPresets[index];
        if (!src) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...DBState.db.modelPresets, copy];
        notifySuccess(language.presetDuplicated);
    }

    async function remove(index: number) {
        const preset = DBState.db.modelPresets[index];
        if (!preset) return;
        const ok = await alertConfirm(`${language.removeConfirm}${preset.name}`);
        if (!ok) return;
        const next = [...DBState.db.modelPresets];
        next.splice(index, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
    }

    function move(index: number, dir: -1 | 1) {
        const target = index + dir;
        const presets = DBState.db.modelPresets;
        if (target < 0 || target >= presets.length) return;
        const next = [...presets];
        [next[index], next[target]] = [next[target], next[index]];
        DBState.db.modelPresets = next;
    }

    function createNew() {
        modelProfileReplaceTarget.set(null);
        openModelProfileBrowser.set(true);
    }

    // Clear any prior test result when the edited preset changes.
    $effect(() => {
        editingId;
        testResult = null;
    });

    async function runTest() {
        if (!editingPreset || testing || testMessage.trim().length === 0) return;
        testing = true;
        testResult = null;
        try {
            testResult = await testModelPreset(editingPreset, testMessage);
        } catch (err) {
            testResult = { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: 0 };
        } finally {
            testing = false;
        }
    }
</script>

<SettingPage title={language.modelPresetMenu}>
    {#if editingId}
        <ShButton variant="ghost" size="sm" className="mb-4 self-start" onclick={() => { editingId = null }}>
            <ArrowLeftIcon size={16}/>
            <span class="ml-1">{language.backToList}</span>
        </ShButton>

        <SettingTabs
            tabs={[
                { label: language.basicInfo, value: 0 },
                { label: language.basicSettings, value: 1 },
                { label: language.advancedSettings, value: 2 },
                { label: language.modelPresetTabTest, value: 3 },
            ]}
            bind:selected={submenu}
        />

        {#if editingPreset}
            {#if submenu === 0}
                <ModelPresetBasicInfo preset={editingPreset} onAfterDelete={() => { editingId = null }} />
            {:else if submenu === 1}
                <div class="flex flex-col gap-4 mb-6">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex flex-col gap-0.5 min-w-0">
                            <span class="text-sm text-textcolor">{language.maxContextSize}</span>
                            <span class="text-xs text-textcolor2">{language.maxContextHelp}</span>
                        </div>
                        <NumberInput bind:value={editingPreset.maxContext as number} placeholder="65000" className="w-32 shrink-0" />
                    </div>
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex flex-col gap-0.5 min-w-0">
                            <span class="text-sm text-textcolor">{language.streamingOverride}</span>
                            <span class="text-xs text-textcolor2">{language.streamingOverrideHelp}</span>
                        </div>
                        <div class="shrink-0">
                            <ShSwitch checked={!!editingPreset.useStreaming} onCheckedChange={(v) => { editingPreset.useStreaming = v }} />
                        </div>
                    </div>
                    {#if editingPreset.useStreaming}
                        <div class="flex items-center justify-between gap-3 pl-4">
                            <div class="flex flex-col gap-0.5 min-w-0">
                                <span class="text-sm text-textcolor">{language.decoupledStreaming}</span>
                                <span class="text-xs text-textcolor2">{language.decoupledStreamingHelp}</span>
                            </div>
                            <div class="shrink-0">
                                <ShSwitch checked={!!editingPreset.decoupledStreaming} onCheckedChange={(v) => { editingPreset.decoupledStreaming = v }} />
                            </div>
                        </div>
                    {/if}
                </div>
                <SchemaFormRenderer
                    schema={editingPreset.profileSnapshot.schema}
                    uiSchema={editingPreset.profileSnapshot.uiSchema}
                    userValues={editingPreset.userValues}
                    visibility="basic"
                    preset={editingPreset}
                />
            {:else if submenu === 2}
                {#if showAbilities}
                    <div class="flex flex-col gap-4 mb-6">
                        <h3 class="text-sm font-semibold text-textcolor2 uppercase tracking-wide">{language.modelPresetAbilities}</h3>
                        {#if showImageInputToggle}
                            <div class="flex items-center justify-between gap-3">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetImageInput}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetImageInputHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={!!editingPreset.imageInput} onCheckedChange={(v) => { editingPreset.imageInput = v }} />
                                </div>
                            </div>
                        {/if}
                        {#if showFoldToggles}
                            <div class="flex items-center justify-between gap-3">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetFoldSystem}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetFoldSystemHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={!!editingPreset.foldSystemPrompt} onCheckedChange={(v) => { editingPreset.foldSystemPrompt = v }} />
                                </div>
                            </div>
                            {#if editingPreset.foldSystemPrompt}
                                <div class="flex items-center justify-between gap-3 pl-4">
                                    <div class="flex flex-col gap-0.5 min-w-0">
                                        <span class="text-sm text-textcolor">{language.modelPresetKeepFirstSystem}</span>
                                        <span class="text-xs text-textcolor2">{language.modelPresetKeepFirstSystemHelp}</span>
                                    </div>
                                    <div class="shrink-0">
                                        <ShSwitch checked={!!editingPreset.keepFirstSystemPrompt} onCheckedChange={(v) => { editingPreset.keepFirstSystemPrompt = v }} />
                                    </div>
                                </div>
                            {/if}
                        {/if}
                        {#if showSequenceToggles}
                            <div class="flex items-center justify-between gap-3">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetAlternateRole}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetAlternateRoleHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={!!editingPreset.alternateRole} onCheckedChange={(v) => { editingPreset.alternateRole = v }} />
                                </div>
                            </div>
                            <div class="flex items-center justify-between gap-3">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetStartWithUser}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetStartWithUserHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={!!editingPreset.startWithUserInput} onCheckedChange={(v) => { editingPreset.startWithUserInput = v }} />
                                </div>
                            </div>
                        {/if}
                        {#if showToolUseToggle}
                            <div class="flex items-center justify-between gap-3">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetToolUse}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetToolUseHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={!!editingPreset.toolUse} onCheckedChange={(v) => { editingPreset.toolUse = v }} />
                                </div>
                            </div>
                        {/if}
                    </div>
                {/if}
                {#if showCacheSection}
                    <div class="flex flex-col gap-4 mb-6">
                        <h3 class="text-sm font-semibold text-textcolor2 uppercase tracking-wide">{language.modelPresetCacheSection}</h3>
                        <div class="flex items-center justify-between gap-3">
                            <div class="flex flex-col gap-0.5 min-w-0">
                                <span class="text-sm text-textcolor">{language.modelPresetCacheEnable}</span>
                                <span class="text-xs text-textcolor2">{language.modelPresetCacheEnableHelp}</span>
                            </div>
                            <div class="shrink-0">
                                <ShSwitch checked={!!editingPreset.promptCaching?.enabled} onCheckedChange={(v) => { editingPreset.promptCaching = { ...(editingPreset.promptCaching ?? {}), enabled: v } }} />
                            </div>
                        </div>
                        <ShAlert variant="warning">
                            {#snippet icon()}<TriangleAlertIcon />{/snippet}
                            {language.modelPresetCachePluginWarning}
                        </ShAlert>
                        {#if editingPreset.promptCaching?.enabled}
                            <div class="flex items-center justify-between gap-3 pl-4">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetCacheTtl}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetCacheTtlHelp}</span>
                                </div>
                                <NumberInput bind:value={editingPreset.promptCaching.ttlSec as number} placeholder="600" min={1} className="w-32 shrink-0" />
                            </div>
                            <div class="flex items-center justify-between gap-3 pl-4">
                                <div class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm text-textcolor">{language.modelPresetCacheExtend}</span>
                                    <span class="text-xs text-textcolor2">{language.modelPresetCacheExtendHelp}</span>
                                </div>
                                <div class="shrink-0">
                                    <ShSwitch checked={editingPreset.promptCaching.extendTtlOnHit ?? true} onCheckedChange={(v) => { editingPreset.promptCaching = { ...editingPreset.promptCaching, enabled: true, extendTtlOnHit: v } }} />
                                </div>
                            </div>
                            <ShAccordion name={language.modelPresetCacheAdvanced} variant="card" class="ml-4">
                                <div class="flex flex-col gap-4 p-2">
                                    <div class="flex items-center justify-between gap-3">
                                        <div class="flex flex-col gap-0.5 min-w-0">
                                            <span class="text-sm text-textcolor">{language.modelPresetCacheMinTokens}</span>
                                            <span class="text-xs text-textcolor2">{language.modelPresetCacheMinTokensHelp}</span>
                                        </div>
                                        <NumberInput bind:value={editingPreset.promptCaching.minPromptTokens as number} placeholder="4096" min={1} className="w-32 shrink-0" />
                                    </div>
                                    <div class="flex items-center justify-between gap-3">
                                        <div class="flex flex-col gap-0.5 min-w-0">
                                            <span class="text-sm text-textcolor">{language.modelPresetCacheGrowth}</span>
                                            <span class="text-xs text-textcolor2">{language.modelPresetCacheGrowthHelp}</span>
                                        </div>
                                        <NumberInput bind:value={editingPreset.promptCaching.growthTokens as number} placeholder="4096" min={1} className="w-32 shrink-0" />
                                    </div>
                                </div>
                            </ShAccordion>
                        {/if}
                    </div>
                {/if}
                <SchemaFormRenderer
                    schema={editingPreset.profileSnapshot.schema}
                    uiSchema={editingPreset.profileSnapshot.uiSchema}
                    userValues={editingPreset.userValues}
                    visibility="advanced"
                    preset={editingPreset}
                />
                <div class="flex flex-col gap-1 mt-6">
                    <span class="text-sm text-textcolor">{language.tokenizerOverride}</span>
                    <span class="text-xs text-textcolor2">{language.tokenizerOverrideHelp}</span>
                    <SelectInput
                        className="mt-2"
                        bind:value={editingPreset.tokenizerOverride as string}
                    >
                        <OptionInput value="">{language.tokenizerAuto}{editingPreset.profileSnapshot.recommendedTokenizer ? ` (${editingPreset.profileSnapshot.recommendedTokenizer})` : ''}</OptionInput>
                        {#each tokenizerList as [value, label]}
                            <OptionInput {value}>{label}</OptionInput>
                        {/each}
                    </SelectInput>
                </div>
                <div class="flex flex-col gap-1 mt-6">
                    <span class="text-sm text-textcolor">{language.additionalParams}</span>
                    <span class="text-xs text-textcolor2">{language.additionalParamsHelp}</span>
                    <TextAreaInput
                        bind:value={editingPreset.additionalParamsText}
                        placeholder={'reasoning=json::{"effort":"max"}\nheader::X-Trace-Id=abc'}
                        fullwidth
                        autocomplete="off"
                        height="32"
                    />
                </div>
            {:else if submenu === 3}
                <div class="flex flex-col gap-4 mb-6">
                    <div class="flex flex-col gap-0.5">
                        <span class="text-sm text-textcolor">{language.modelPresetTestTitle}</span>
                        <span class="text-xs text-textcolor2">{language.modelPresetTestHelp}</span>
                    </div>
                    <TextAreaInput
                        bind:value={testMessage}
                        placeholder={language.modelPresetTestDefault}
                        fullwidth
                        autocomplete="off"
                        height="24"
                    />
                    <ShButton
                        variant="default"
                        size="default"
                        className="self-start"
                        disabled={testing || testMessage.trim().length === 0}
                        onclick={runTest}
                    >
                        {testing ? language.modelPresetTestSending : language.modelPresetTestSend}
                    </ShButton>

                    {#if testResult}
                        <div class="flex flex-col gap-1 rounded-md border p-3 text-sm {testResult.ok ? 'bg-success/20 border-success/40' : 'bg-draculared/20 border-draculared/40'}">
                            <span class="font-medium {testResult.ok ? 'text-success' : 'text-red-400'}">
                                {testResult.ok ? language.modelPresetTestSuccess : language.modelPresetTestFail}
                                <span class="text-textcolor2 font-normal ml-1">({testResult.latencyMs}ms)</span>
                            </span>
                            <span class="text-textcolor whitespace-pre-wrap break-words">{testResult.message}</span>
                        </div>
                    {/if}
                </div>
            {/if}
        {/if}
    {:else}
        <SettingTabs
            tabs={[
                { label: language.modelPresetTabPresets, value: 0 },
                { label: language.apiKeyManagerMenu, value: 1 },
                { label: language.modelPresetTabOptions, value: 2 },
            ]}
            bind:selected={page}
        />

        {#if page === 1}
            <ApiKeyPoolManager />
        {:else if page === 2}
            <ModelPresetOptions />
        {:else}
            {#if noticeN > 0}
                <ShAlert variant="info" className="mb-4">
                    {#snippet icon()}<BellIcon />{/snippet}
                    {#snippet title()}{language.registryNoticeBanner.replace('{n}', String(noticeN))}{/snippet}
                    {#snippet action()}
                        <ShButton variant="outline" size="sm" onclick={() => { noticeOpen = true }}>
                            {language.registryNoticeMore}
                        </ShButton>
                    {/snippet}
                </ShAlert>
            {/if}

            <ShButton variant="default" size="default" className="w-full mb-4" onclick={createNew}>
                <PlusIcon size={16}/>
                <span class="ml-1">{language.modelPresetCreate}</span>
            </ShButton>

            {#if DBState.db.modelPresets.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">
                    {language.modelPresetEmpty}
                </div>
            {:else}
                <div class="flex flex-col gap-1">
                    {#each DBState.db.modelPresets as preset, i (preset.id)}
                        <button
                            class="flex items-center text-textcolor border border-darkborderc rounded-md p-3 cursor-pointer hover:bg-selected/30 transition-colors text-left"
                            onclick={() => { editingId = preset.id; submenu = 0; }}
                        >
                            <div class="flex flex-col min-w-0 grow">
                                <span class="text-sm text-textcolor truncate flex items-center gap-1.5">
                                    {#if getPresetUpdateStatus(preset) === 'updatable'}
                                        <span class="w-2 h-2 rounded-full bg-amber-500 shrink-0" title={language.profileUpdateAvailable}></span>
                                    {/if}
                                    <span class="truncate">{preset.name}</span>
                                </span>
                                {#if preset.profileSnapshot?.profileId}
                                    <span class="text-xs text-textcolor2 truncate">{preset.profileSnapshot.profileId}</span>
                                {/if}
                            </div>
                            <div class="flex gap-2 shrink-0 ml-2">
                                <div class="text-textcolor2 hover:text-primary cursor-pointer aria-disabled:opacity-30 aria-disabled:pointer-events-none" role="button" tabindex="0" aria-disabled={i === 0} onclick={(e) => {
                                    e.stopPropagation()
                                    move(i, -1)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="move up">
                                    <ArrowUpIcon size={18}/>
                                </div>
                                <div class="text-textcolor2 hover:text-primary cursor-pointer aria-disabled:opacity-30 aria-disabled:pointer-events-none" role="button" tabindex="0" aria-disabled={i === DBState.db.modelPresets.length - 1} onclick={(e) => {
                                    e.stopPropagation()
                                    move(i, 1)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="move down">
                                    <ArrowDownIcon size={18}/>
                                </div>
                                <div class="text-textcolor2 hover:text-primary cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                    e.stopPropagation()
                                    duplicate(i)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="duplicate">
                                    <CopyIcon size={18}/>
                                </div>
                                <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                    e.stopPropagation()
                                    remove(i)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="delete">
                                    <TrashIcon size={18}/>
                                </div>
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}
        {/if}
    {/if}

    <RegistryNoticeModal bind:open={noticeOpen} {notice} onConfirm={acknowledgeNotice} />
</SettingPage>
