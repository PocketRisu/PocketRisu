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
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Official = remote registry if synced, else bundled (reactive on the cache).
    const officialRegistry = $derived(getOfficialRegistry());

    let activeTab = $state<'official' | 'custom'>('official');
    let query = $state('');

    type Entry = {
        profile: ModelProfile;
        baseProvider: BaseProviderDefinition | undefined;
    };

    const profileStatusOrder: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

    // Active registry by tab. Official = bundled (read-only). Custom = the
    // persisted cache's 'custom' registry (reactive: import/delete update it).
    const activeRegistry = $derived<RegistryCache>(
        activeTab === 'official'
            ? officialRegistry
            : (DBState.db.modelProfileRegistryCache ?? createEmptyRegistryCache()),
    );
    const activeRegistryId = $derived(activeTab === 'official' ? getBundledRegistryId() : CUSTOM_REGISTRY_ID);

    // Scope to the active tab's registry only. The custom cache object can hold
    // multiple registries (e.g. the official 'bundled' entry is persisted into
    // the same DB cache), so iterating all of them would leak official profiles
    // into the custom tab.
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

    // The catalog display level hides outdated/deprecated profiles on the
    // official tab only. Custom profiles are the user's own — always shown.
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

    // Both tabs group by provider (collapsible) — soon-large catalog, and a
    // single list UI for official + custom. Within a provider, current profiles
    // sort before outdated/deprecated.
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

    // Providers default collapsed; an active search force-expands everything so
    // matches are always visible.
    let expandedProviders = $state(new Set<string>());
    const searching = $derived(query.trim() !== '');
    function isProviderExpanded(id: string): boolean {
        return searching || expandedProviders.has(id);
    }
    function toggleProvider(id: string) {
        // Reassign a new Set — Svelte 5 $state does not proxy Set mutations
        // (.add/.delete), so an in-place change wouldn't trigger reactivity.
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

    // A resolved snapshot must carry the data needed to build & dispatch a
    // request. A degenerate snapshot (null auth/endpoint, empty schema) comes
    // from an incomplete registry cache — refuse rather than persist a preset
    // that renders blank and crashes on export. (always-persist sync should
    // self-heal the cache on the next menu entry; this is the safety net.)
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

    // Replace an existing preset's profile (custom-profiles plan §3): re-resolve
    // the chosen profile's snapshot, carry over matching userValues keys, drop
    // orphans, seed defaults for new fields, and re-stamp sourceProfile.
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
        // Replacing the profile can lose settings — always confirm (a stronger,
        // specific warning when settings will definitely be dropped).
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

    // Export any profile (official or custom) as a self-contained, key-free
    // fragment so it can be edited and shared as a JSON file.
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

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-hidden">
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
            <div class="flex items-start text-textcolor border border-darkborderc rounded-md p-3 hover:bg-selected/30 transition-colors">
                <button class="flex flex-col min-w-0 grow cursor-pointer text-left" onclick={() => selectProfile(profile)}>
                    <div class="flex items-center gap-2">
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
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
