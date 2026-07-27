<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, SearchIcon, TrashIcon, UploadIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState, modelProfileReplaceTarget, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, alertError, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import {
        getBundledRegistryId,
        getOfficialRegistry,
        isProfileVisible,
        resolveSnapshot,
    } from "src/ts/preset/registry";
    import { createEmptyRegistryCache } from "src/ts/preset/dbDefaults";
    import {
        buildProfileFragment,
        CUSTOM_ID_PREFIX,
        CUSTOM_REGISTRY_ID,
        importFragment,
        migrateUserValues,
        removeCustomProfile,
        validateFragment,
    } from "src/ts/preset/customProfiles";
    import { localizeDisplayName, localizeDescription } from "src/ts/preset/registry/i18n";
    import type { BaseProviderDefinition, ModelPreset, ModelProfile, RegistryCache, RegistryProfileStatus, ResolvedModelProfileSnapshot } from "src/ts/preset/types";
    import { getAdapterBackendExecutionSupport } from "src/ts/preset/backendExecutionSupport";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import CapabilityTag from "../UI/GUI/CapabilityTag.svelte";
    import { v4 as uuidv4 } from "uuid";

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    const officialRegistry = $derived(getOfficialRegistry());

    let activeTab = $state<'official' | 'custom'>('official');
    let query = $state('');

    type Entry = {
        profile: ModelProfile;
        baseProvider: BaseProviderDefinition | undefined;
    };

    const profileStatusOrder: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

    const activeRegistry = $derived<RegistryCache>(
        activeTab === 'official'
            ? officialRegistry
            : (DBState.db.modelProfileRegistryCache ?? createEmptyRegistryCache()),
    );
    const activeRegistryId = $derived(activeTab === 'official' ? getBundledRegistryId() : CUSTOM_REGISTRY_ID);

    function buildEntries(registry: RegistryCache, registryId: string): Entry[] {
        const reg = registry.registries[registryId];
        if (!reg) return [];
        const out: Entry[] = [];
        for (const profile of Object.values(reg.profiles ?? {})) {
            out.push({ profile, baseProvider: reg.baseProviders?.[profile.providerBaseId] });
        }
        return out.sort((a, b) =>
            (a.baseProvider?.displayName ?? '').localeCompare(b.baseProvider?.displayName ?? '')
            || a.profile.displayName.localeCompare(b.profile.displayName),
        );
    }

    const entries = $derived.by(() => {
        const all = buildEntries(activeRegistry, activeRegistryId);
        if (activeTab !== 'official') return all;
        const level = DBState.db.modelProfileVisibilityLevel;
        return all.filter(e => isProfileVisible(e.profile.profileStatus, level));
    });

    const filtered = $derived.by(() => {
        const q = query.trim().toLowerCase();
        if (!q) return entries;
        return entries.filter(({ profile, baseProvider }) => {
            return profile.displayName.toLowerCase().includes(q)
                || localizeDisplayName(profile).toLowerCase().includes(q)
                || profile.id.toLowerCase().includes(q)
                || profile.modelId.toLowerCase().includes(q)
                || (profile.description ?? '').toLowerCase().includes(q)
                || localizeDescription(profile).toLowerCase().includes(q)
                || (baseProvider?.displayName ?? '').toLowerCase().includes(q)
                || (baseProvider?.id ?? '').toLowerCase().includes(q);
        });
    });

    const groupedByProvider = $derived.by(() => {
        const buckets = new Map<string, { id: string; label: string; entries: Entry[] }>();
        for (const entry of filtered) {
            const id = entry.baseProvider?.id ?? entry.profile.providerBaseId ?? '';
            let b = buckets.get(id);
            if (!b) {
                b = { id, label: entry.baseProvider?.displayName ?? id ?? 'Unknown', entries: [] };
                buckets.set(id, b);
            }
            b.entries.push(entry);
        }
        for (const b of buckets.values()) {
            b.entries.sort((x, y) =>
                profileStatusOrder.indexOf(x.profile.profileStatus) - profileStatusOrder.indexOf(y.profile.profileStatus)
                || ((x.profile.sortOrder ?? 0) - (y.profile.sortOrder ?? 0))
                || localizeDisplayName(x.profile).localeCompare(localizeDisplayName(y.profile)));
        }
        return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
    });

    let expandedProviders = $state(new Set<string>());
    const searching = $derived(query.trim() !== '');
    function isProviderExpanded(id: string): boolean {
        return searching || expandedProviders.has(id);
    }
    function toggleProvider(id: string) {
        const next = new Set(expandedProviders);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        expandedProviders = next;
    }

    function seedDefaults(snapshot: ResolvedModelProfileSnapshot): Record<string, unknown> {
        const seeded: Record<string, unknown> = {};
        for (const field of snapshot.schema) {
            if (field.default !== undefined) seeded[field.key] = field.default;
        }
        return seeded;
    }

    function snapshotIncomplete(s: ResolvedModelProfileSnapshot): boolean {
        return !s.auth || !s.endpoint
            || !Array.isArray(s.schema) || s.schema.length === 0
            || !Array.isArray(s.uiSchema?.fields) || s.uiSchema.fields.length === 0;
    }

    function createPresetFrom(profile: ModelProfile) {
        const snapshot = resolveSnapshot(activeRegistry, profile.id);
        if (snapshotIncomplete(snapshot)) {
            alertError(language.profileDataIncomplete);
            return;
        }
        const preset: ModelPreset = {
            id: uuidv4(),
            name: profile.displayName,
            profileSnapshot: snapshot,
            sourceProfile: {
                registryId: activeRegistryId,
                profileId: snapshot.profileId,
                profileVersion: snapshot.profileVersion,
                providerBaseVersion: snapshot.providerBaseVersion,
                fetchedAt: Date.now(),
                profileUpdatedAt: profile.updatedAt,
            },
            userValues: seedDefaults(snapshot),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        DBState.db.modelPresets = [...DBState.db.modelPresets, preset];
        notifySuccess(language.modelPresetCreated);
        openModelPresetEditId.set(preset.id);
        close();
    }

    async function replacePresetProfile(targetId: string, profile: ModelProfile): Promise<boolean> {
        const idx = DBState.db.modelPresets.findIndex((p) => p.id === targetId);
        if (idx < 0) return false;
        const snapshot = resolveSnapshot(activeRegistry, profile.id);
        if (snapshotIncomplete(snapshot)) {
            alertError(language.profileDataIncomplete);
            return false;
        }
        const preset = DBState.db.modelPresets[idx];
        const { values, droppedKeys } = migrateUserValues(preset.userValues, snapshot.schema);
        const warn = droppedKeys.length > 0 ? language.profileReplaceWarn : language.profileUpdateLossWarn;
        if (!(await alertConfirm(warn))) {
            return false;
        }
        preset.profileSnapshot = snapshot;
        preset.sourceProfile = {
            registryId: activeRegistryId,
            profileId: snapshot.profileId,
            profileVersion: snapshot.profileVersion,
            providerBaseVersion: snapshot.providerBaseVersion,
            fetchedAt: Date.now(),
            profileUpdatedAt: profile.updatedAt,
        };
        preset.userValues = values;
        preset.updatedAt = Date.now();
        notifySuccess(language.profileReplaced);
        return true;
    }

    async function selectProfile(profile: ModelProfile) {
        const target = $modelProfileReplaceTarget;
        if (target) {
            if (await replacePresetProfile(target, profile)) {
                modelProfileReplaceTarget.set(null);
                close();
            }
        } else {
            createPresetFrom(profile);
        }
    }

    function safeFileName(id: string): string {
        return id.replace(/[^a-z0-9._-]/gi, '_');
    }

    async function exportProfile(profile: ModelProfile, baseProvider: BaseProviderDefinition | undefined) {
        if (!baseProvider) {
            alertError(language.profileExportNoBase);
            return;
        }
        const fragment = buildProfileFragment(profile, baseProvider, Date.now());
        await downloadFile(`${safeFileName(profile.id)}.profile.json`, JSON.stringify(fragment, null, 2));
    }

    async function importProfile() {
        const file = await selectSingleFile(['json']);
        if (!file) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(file.data));
        } catch {
            alertError(language.profileImportParseError);
            return;
        }
        const res = validateFragment(parsed);
        if (!res.ok || !res.fragment) {
            alertError(`${language.profileImportInvalid}\n\n- ${res.errors.join('\n- ')}`);
            return;
        }
        const fragment = res.fragment;
        const cache = (DBState.db.modelProfileRegistryCache ??= createEmptyRegistryCache());
        const targetId = fragment.profile.id.startsWith(CUSTOM_ID_PREFIX)
            ? fragment.profile.id
            : `${CUSTOM_ID_PREFIX}${fragment.profile.id}`;
        const exists = cache.registries[CUSTOM_REGISTRY_ID]?.profiles?.[targetId] !== undefined;
        if (exists && !(await alertConfirm(language.profileOverwriteConfirm))) {
            return;
        }
        importFragment(cache, fragment, Date.now());
        activeTab = 'custom';
        notifySuccess(language.profileImported);
    }

    async function deleteCustom(profile: ModelProfile) {
        if (!(await alertConfirm(`${language.removeConfirm}${profile.displayName}`))) return;
        const cache = DBState.db.modelProfileRegistryCache;
        if (cache) removeCustomProfile(cache, profile.id);
        notifySuccess(language.presetDeleted);
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="profile-browser-backdrop" data-risu-modal-scroll data-risu-modal="" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); }}} onclick={close}>
    <div class="profile-browser-panel risu-modal-panel break-any" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center text-textcolor mb-4 shrink-0">
            <h2 class="mt-0 mb-0">{language.selectProfile}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        <div class="shrink-0 flex w-full rounded-md border border-selected mb-3">
            <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'official'} onclick={() => { activeTab = 'official' }}>{language.profileTabOfficial}</button>
            <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'custom'} onclick={() => { activeTab = 'custom' }}>{language.profileTabCustom}</button>
        </div>

        <div class="flex items-center gap-2 mb-3 shrink-0">
            <SearchIcon size={16} class="text-textcolor2 shrink-0" />
            <TextInput bind:value={query} placeholder={language.searchProfiles} fullwidth />
        </div>

        {#if activeTab === 'custom'}
            <button
                class="shrink-0 w-full flex items-center justify-center gap-2 mb-3 p-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected text-sm"
                onclick={importProfile}
            >
                <UploadIcon size={16} class="shrink-0" />
                <span>{language.profileImport}</span>
            </button>
        {/if}

        {#snippet profileCard(profile: ModelProfile, baseProvider: BaseProviderDefinition | undefined)}
            {@const localizedDesc = localizeDescription(profile)}
            {@const executionSupport = getAdapterBackendExecutionSupport(baseProvider?.adapterKind)}
            <div class="profile-card flex items-start text-textcolor border border-darkborderc rounded-md p-3 hover:bg-selected/30 transition-colors">
                <button class="flex flex-col min-w-0 grow cursor-pointer text-left" onclick={() => selectProfile(profile)}>
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm text-textcolor truncate">{localizeDisplayName(profile)}</span>
                        {#if profile.profileStatus !== 'current'}
                            <span
                                class="text-[10px] leading-none px-1.5 py-0.5 rounded shrink-0
                                {profile.profileStatus === 'deprecated' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-500'}"
                            >
                                {profile.profileStatus === 'deprecated' ? language.profileStatusDeprecated : language.profileStatusOutdated}
                            </span>
                        {/if}
                        {#if baseProvider}
                            <span class="text-xs text-textcolor2 shrink-0">[{baseProvider.displayName}]</span>
                        {/if}
                        <CapabilityTag active={executionSupport.supported} />
                    </div>
                    <span class="text-xs text-textcolor2 truncate">{profile.id}</span>
                    {#if profile.updatedAt}
                        <span class="text-xs text-textcolor2">{language.profileUpdatedAtLabel}: {new Date(profile.updatedAt).toLocaleDateString()}</span>
                    {/if}
                    {#if localizedDesc}
                        <span class="text-xs text-textcolor2 mt-1 truncate">{localizedDesc}</span>
                    {/if}
                    {#if profile.statusReason}
                        <span class="text-xs text-textcolor2 mt-1 truncate">{profile.statusReason}</span>
                    {/if}
                </button>
                <div class="flex gap-2 shrink-0 ml-2">
                    <button class="text-textcolor2 hover:text-primary cursor-pointer" title={language.profileExport} onclick={() => exportProfile(profile, baseProvider)}>
                        <DownloadIcon size={18}/>
                    </button>
                    {#if activeTab === 'custom'}
                        <button class="text-textcolor2 hover:text-red-400 cursor-pointer" title={language.profileDelete} onclick={() => deleteCustom(profile)}>
                            <TrashIcon size={18}/>
                        </button>
                    {/if}
                </div>
            </div>
        {/snippet}

        <div class="flex flex-col gap-1 overflow-y-auto">
            {#if filtered.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">
                    {activeTab === 'custom' ? language.customProfileEmpty : language.noProfileMatch}
                </div>
            {:else}
                {#each groupedByProvider as group (group.id)}
                    <section class="flex flex-col gap-1 mt-2 first:mt-0">
                        <button
                            class="flex items-center gap-1.5 px-1 py-1 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                            onclick={() => toggleProvider(group.id)}
                        >
                            {#if isProviderExpanded(group.id)}
                                <ChevronDownIcon size={16} class="shrink-0" />
                            {:else}
                                <ChevronRightIcon size={16} class="shrink-0" />
                            {/if}
                            <span class="text-sm font-semibold">{group.label}</span>
                            <span class="text-xs">({group.entries.length})</span>
                        </button>
                        {#if isProviderExpanded(group.id)}
                            {#each group.entries as { profile, baseProvider } (profile.id)}
                                {@render profileCard(profile, baseProvider)}
                            {/each}
                        {/if}
                    </section>
                {/each}
            {/if}
        </div>
    </div>
</div>

<style>
    .profile-browser-backdrop {
        position: fixed;
        inset: 0;
        z-index: 40;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background: rgb(0 0 0 / 62%);
        backdrop-filter: blur(7px);
        animation: profile-backdrop-in 120ms ease both;
    }
    .profile-browser-panel {
        display: flex;
        width: min(760px, 100%);
        max-height: min(820px, 100%);
        flex-direction: column;
        overflow: hidden;
        padding: 1rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-textcolor2) 18%, transparent);
        border-radius: 12px;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 84%, var(--risu-theme-bgcolor));
        box-shadow: 0 20px 70px rgb(0 0 0 / 42%);
        animation: profile-panel-in 180ms cubic-bezier(.2, 0, 0, 1) both;
    }
    .profile-card {
        border-color: color-mix(in srgb, var(--risu-theme-textcolor2) 14%, transparent);
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 72%, transparent);
    }
    .profile-card:hover {
        border-color: color-mix(in srgb, var(--risu-theme-primary) 35%, transparent);
        background: color-mix(in srgb, var(--risu-theme-primary) 7%, var(--risu-theme-bgcolor));
    }
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
    @keyframes profile-backdrop-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    @keyframes profile-panel-in {
        from { opacity: 0; transform: translateY(10px) scale(.99); }
        to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
        .profile-browser-backdrop, .profile-browser-panel { animation: none; }
    }@keyframes risu-modal-in {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to   { opacity: 1; transform: none; }
}
.risu-modal-panel {
    animation: risu-modal-in var(--dur-base, 200ms) cubic-bezier(0.2, 0, 0, 1) both;
}
</style>
