<script lang="ts">
    import { CopyIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState, modelProfileReplaceTarget, openModelProfileBrowser, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { getBundledRegistryId, getOfficialRegistry, resolveSnapshot } from "src/ts/preset/registry";
    import { buildFragmentFromSnapshot, getProfileUpdateStatus, migrateUserValues } from "src/ts/preset/customProfiles";
    import { localizeDescription } from "src/ts/preset/registry/i18n";
    import type { ModelPreset } from "src/ts/preset/types";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { duplicateModelPreset, removeModelPresetFromLayout } from "src/ts/preset/layout";

    interface Props {
        preset: ModelPreset;
        onAfterDelete?: () => void;
    }

    let { preset = $bindable(), onAfterDelete = () => {} }: Props = $props();

    function duplicate() {
        const src = preset;
        const result = duplicateModelPreset(DBState.db.modelPresets, DBState.db.modelPresetLayout, src.id);
        if (!result) return;
        DBState.db.modelPresets = result.presets;
        DBState.db.modelPresetLayout = result.layout;
        notifySuccess(language.presetDuplicated);
        // Jump straight into the new copy's editor (parent watches this store).
        openModelPresetEditId.set(result.copy.id);
    }

    async function remove() {
        const ok = await alertConfirm(`${language.presetDeleteConfirm}\n${preset.name}`);
        if (!ok) return;
        const idx = DBState.db.modelPresets.findIndex(p => p.id === preset.id);
        if (idx < 0) return;
        const next = [...DBState.db.modelPresets];
        next.splice(idx, 1);
        DBState.db.modelPresets = next;
        DBState.db.modelPresetLayout = removeModelPresetFromLayout(DBState.db.modelPresetLayout, preset.id);
        notifySuccess(language.presetDeleted);
        onAfterDelete();
    }

    // Resolve the preset's source profile in its registry (official=bundled,
    // else the persisted custom cache) — drives the update hint, updated-at
    // date, and the one-click apply.
    const sourceLookup = $derived.by(() => {
        const sp = preset.sourceProfile;
        const cache = !sp?.registryId
            ? undefined
            : sp.registryId === getBundledRegistryId()
                ? getOfficialRegistry()
                : DBState.db.modelProfileRegistryCache;
        const current = sp?.registryId ? cache?.registries?.[sp.registryId]?.profiles?.[sp.profileId] : undefined;
        return { sp, cache, current };
    });
    const updateStatus = $derived(getProfileUpdateStatus(sourceLookup.current, preset.sourceProfile?.profileUpdatedAt));
    // Installed = the snapshot this preset is pinned to; latest = the registry's
    // current version (only meaningful when an update is available).
    const installedLabel = $derived(fmtDate(preset.sourceProfile?.profileUpdatedAt));
    const latestLabel = $derived(fmtDate(sourceLookup.current?.updatedAt));
    const description = $derived(sourceLookup.current ? localizeDescription(sourceLookup.current) : '');

    function fmtDate(ms?: number): string {
        // Strip the ko-locale trailing period ("2026. 6. 3." -> "2026. 6. 3").
        return ms ? new Date(ms).toLocaleDateString().replace(/\.\s*$/, '') : '';
    }

    function replaceProfile() {
        modelProfileReplaceTarget.set(preset.id);
        openModelProfileBrowser.set(true);
    }

    // One-click apply of the current source profile (the "update available"
    // badge). Re-resolves the same profile, migrates matching userValues, and
    // warns before dropping orphaned settings.
    async function applyUpdate() {
        const { sp, cache, current } = sourceLookup;
        if (!sp?.registryId || !cache || !current) return;
        const snapshot = resolveSnapshot(cache, sp.profileId);
        const { values, droppedKeys } = migrateUserValues(preset.userValues, snapshot.schema);
        const warn = droppedKeys.length > 0 ? language.profileReplaceWarn : language.profileUpdateLossWarn;
        const msg = `${warn}\n\n`
            + `${language.profileUpdatedAtLabel}: ${fmtDate(sp.profileUpdatedAt) || '-'}\n`
            + `${language.profileLatestVersionLabel}: ${fmtDate(current.updatedAt) || '-'}`;
        if (!(await alertConfirm(msg))) return;
        preset.profileSnapshot = snapshot;
        preset.sourceProfile = {
            ...sp,
            profileVersion: snapshot.profileVersion,
            providerBaseVersion: snapshot.providerBaseVersion,
            fetchedAt: Date.now(),
            profileUpdatedAt: current.updatedAt,
        };
        preset.userValues = values;
        preset.updatedAt = Date.now();
        notifySuccess(language.profileReplaced);
    }

    async function exportPreset() {
        const fragment = buildFragmentFromSnapshot(preset.profileSnapshot, preset.name, Date.now());
        const name = (preset.name || 'profile').replace(/[^a-z0-9._-]/gi, '_');
        await downloadFile(`${name}.profile.json`, JSON.stringify(fragment, null, 2));
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
        <span class="text-textcolor">{language.name}</span>
        <TextInput bind:value={preset.name} fullwidth />
    </div>

    <div class="flex flex-col gap-1">
    <span class="text-textcolor">{language.profileSectionTitle}</span>
    <div class="flex flex-col gap-1 p-3 rounded-md border border-darkborderc bg-darkbg/40">
        <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-textcolor truncate">{preset.profileSnapshot.profileId}</span>
            {#if updateStatus === 'updatable'}
                <button class="text-xs px-2 py-0.5 rounded border border-amber-500 text-amber-500 hover:bg-amber-500/10 cursor-pointer shrink-0" onclick={applyUpdate}>{language.profileUpdateAvailable}</button>
            {:else if updateStatus === 'missing'}
                <span class="text-xs px-2 py-0.5 rounded border border-darkborderc text-textcolor2 shrink-0">{language.profileSourceMissing}</span>
            {/if}
        </div>
        {#if description}
            <div class="text-xs text-textcolor2">{description}</div>
        {/if}
        <div class="text-xs text-textcolor2">Provider: {preset.profileSnapshot.providerBaseId}</div>
        {#if preset.profileSnapshot.modelId}
            <div class="text-xs text-textcolor2">Default model: {preset.profileSnapshot.modelId}</div>
        {/if}
        {#if installedLabel}
            <div class="text-xs text-textcolor2">
                {language.profileUpdatedAtLabel}: {installedLabel}{#if updateStatus === 'updatable' && latestLabel && latestLabel !== installedLabel}{' '}({language.profileLatestVersionLabel}: {latestLabel}){/if}
            </div>
        {/if}
        {#if preset.profileSnapshot.capabilities && preset.profileSnapshot.capabilities.length > 0}
            <div class="flex flex-wrap gap-1 mt-1">
                {#each preset.profileSnapshot.capabilities as cap}
                    <span class="text-xs px-2 py-0.5 rounded border border-darkborderc text-textcolor2">{cap}</span>
                {/each}
            </div>
        {/if}
        <div class="flex gap-2 mt-2">
            <ShButton size="sm" className="flex-1" onclick={replaceProfile}>
                <RefreshCwIcon size={14} class="shrink-0" />
                <span class="ml-1">{language.profileReplace}</span>
            </ShButton>
            <ShButton size="sm" className="flex-1" onclick={exportPreset}>
                <DownloadIcon size={14} class="shrink-0" />
                <span class="ml-1">{language.profileExport}</span>
            </ShButton>
        </div>
    </div>
    </div>

    <div class="flex flex-col gap-2">
        <ShButton variant="default" size="default" className="w-full" onclick={duplicate}>
            <CopyIcon size={16}/>
            <span class="ml-1">{language.presetDuplicate}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" className="w-full" onclick={remove}>
            <Trash2Icon size={16}/>
            <span class="ml-1">{language.presetDelete}</span>
        </ShButton>
    </div>
</div>
