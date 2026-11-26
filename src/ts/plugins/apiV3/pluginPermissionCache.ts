// Plugin V3 permission decisions, bound to the plugin's code like upstream
// (69a560884, 016d423bb): a decision is stored under `<script hash>_<permission>`,
// so a plugin whose code changes — an update, or a different plugin installed
// under the same name — is asked again, while unchanged code never is.
//
// PocketRisu differences: decisions persist on the server (every device shares
// them and they survive restarts), grants are permanent instead of upstream's
// 3-day reconfirm, denials are remembered as well, and dialogs are shown one
// at a time.

export type PluginPermission = 'fetchLogs' | 'db' | 'dbWrite' | 'mainDom' | 'replacer' | 'provider' | 'sendChat' | 'inlay'

export const pluginPermissions: PluginPermission[] = ['fetchLogs', 'db', 'dbWrite', 'mainDom', 'replacer', 'provider', 'sendChat', 'inlay']

type PluginScriptHasher = (data: Uint8Array) => Promise<string>

export function createPluginScriptHashGetter(script: string, hasher: PluginScriptHasher): () => Promise<string> {
    let scriptHash: Promise<string> | undefined

    return () => {
        scriptHash ??= hasher(new TextEncoder().encode(script))
        return scriptHash
    }
}

export function getPluginPermissionKey(scriptHash: string, permission: PluginPermission): string {
    return `${scriptHash}_${permission}`
}

export type PluginPermissionState = {
    cache: [string, boolean | number][]
    // Written before 1.16, when a decision was also kept per plugin name and
    // carried over to any code under that name. No longer read.
    given?: string[]
    denied?: string[]
}

export interface PluginPermissionGateDeps {
    read(): Promise<PluginPermissionState | null>
    write(state: PluginPermissionState): Promise<void>
    remove(): Promise<void>
    // Shows the consent dialog; resolves true when the user allows.
    confirm(pluginName: string, permission: PluginPermission): Promise<boolean>
    // Runs after a denial is saved, before the next queued dialog is shown.
    onDenied(pluginName: string): Promise<void>
}

export function createPluginPermissionGate(deps: PluginPermissionGateDeps) {
    const decisions = new Map<string, boolean>()
    let loaded: Promise<void> | null = null
    let writing: Promise<void> = Promise.resolve()
    // Serializes permission dialogs. Every plugin shares the single global
    // alertStore, so when several plugins request permission at boot they would
    // otherwise overwrite each other's dialog — only the last one stays clickable
    // and a single click resolves all of them. The chain makes each dialog wait
    // for the previous one to finish, showing them one at a time.
    let dialogChain: Promise<unknown> = Promise.resolve()

    const load = () => loaded ??= (async () => {
        const state = await deps.read()
        for (const [key, value] of state?.cache ?? []) {
            // Decisions are booleans; the numeric `_lastGrantTime` entries of
            // the removed 3-day reconfirm are dropped on the next write.
            if (typeof value === 'boolean') decisions.set(key, value)
        }
    })()

    // Writes run in order and each sends the map as it is when it runs, so the
    // last write always carries every decision.
    const persist = () => {
        writing = writing.catch(() => {}).then(() => deps.write({ cache: [...decisions] }))
        return writing
    }

    // Like `request`, but also reports whether the answer had to wait for a
    // dialog (this call's or an earlier queued one). A caller holding data it
    // read before asking can tell that the data may be stale by then.
    async function requestDecision(
        pluginName: string,
        scriptHash: string,
        permission: PluginPermission,
        reconfirm: boolean | 'periodically' = false,
    ): Promise<{ granted: boolean, waited: boolean }> {
        // `requestPluginPermission` hands plugins this call with any string.
        if (!pluginPermissions.includes(permission)) return { granted: false, waited: false }
        await load()
        const key = getPluginPermissionKey(scriptHash, permission)

        // 'periodically' grants are permanent: a (code, permission) pair is
        // asked once, matching the Android/extension model. Upstream's 3-day
        // expiry was removed — it re-asked when nothing changed. Per-plugin
        // reset still clears.
        const known = () => reconfirm === true ? undefined : decisions.get(key)

        // Fast path: if the answer is already known, skip the serialization queue
        // entirely so cached/granted permissions never block on a pending dialog.
        const early = known()
        if (early !== undefined) return { granted: early, waited: false }

        const showDialog = async (): Promise<boolean> => {
            // Re-check under the lock: an earlier queued dialog for the same code
            // may have already granted/denied while we were waiting our turn, so we
            // don't re-prompt.
            const recheck = known()
            if (recheck !== undefined) return recheck
            const granted = await deps.confirm(pluginName, permission)
            decisions.set(key, granted)
            await persist()
            if (!granted) await deps.onDenied(pluginName)
            return granted
        }

        // Append to the dialog chain so only one permission dialog is shown at a
        // time. The chain swallows rejections, so a single failure never
        // deadlocks every later permission request.
        const run = dialogChain.catch(() => {}).then(showDialog)
        dialogChain = run.catch(() => {})
        return { granted: await run, waited: true }
    }

    async function request(
        pluginName: string,
        scriptHash: string,
        permission: PluginPermission,
        reconfirm: boolean | 'periodically' = false,
    ): Promise<boolean> {
        return (await requestDecision(pluginName, scriptHash, permission, reconfirm)).granted
    }

    // Clears every decision for one version of a plugin's code.
    async function resetScript(scriptHash: string) {
        await load()
        for (const permission of pluginPermissions) {
            decisions.delete(getPluginPermissionKey(scriptHash, permission))
        }
        await persist()
    }

    async function resetAll() {
        await load()
        decisions.clear()
        writing = writing.catch(() => {}).then(() => deps.remove())
        await writing
    }

    return { request, requestDecision, resetScript, resetAll }
}
