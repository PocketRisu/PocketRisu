import { get, writable } from "svelte/store"
import { toast } from "svelte-sonner"
import { sleep } from "./util"
import { language } from "../lang"
import { getDatabase, nodeOnlyVer, type MessageGenerationInfo } from "./storage/database.svelte"
import { alertStore as alertStoreImported, togglePresetsOpenStore } from "./stores.svelte"
import { addLog } from "./log"
import { nativeConsoleError } from "./log-capture"
import type { ShButtonVariant } from "../lib/UI/GUI/ShButton.svelte"

/**
 * Action descriptor for dialog buttons. Reusable across any alert type
 * that renders a list of pressable actions (confirmMulti, future variants).
 */
export interface AlertAction {
    label: string
    variant?: ShButtonVariant
}

export interface alertData{
    type: 'error'|'normal'|'none'|'ask'|'wait'|'selectChar'
            |'input'|'wait2'|'markdown'|'select'|'login'
            |'tos'|'cardexport'|'requestdata'|'addchar'|'selectModule'
            |'pukmakkurit'|'branches'|'progress'|'pluginconfirm'
            |'confirmMulti',
    msg: string,
    submsg?: string
    datalist?: [string, string][],
    stackTrace?: string;
    defaultValue?: string
    actions?: AlertAction[]
}

export interface NotifyOptions {
    description?: string
    source?: string
}

type AlertGenerationInfoStoreData = {
    genInfo: MessageGenerationInfo,
    idx: number
}
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData>(null)
export const alertStore = {
    set: (d:alertData) => {
        alertStoreImported.set(d)
    }
}

// Shared acceptance cache for both global startup TOS and Realm download confirmation.
const TOS_ACCEPTANCE_STORAGE_KEY = 'tos2'

// Normalize any value (string / Error / plain object / primitive) into a
// human-readable message and an optional stack trace. Shared by alertError
// and the notify* family so callers can pass raw catch() values safely —
// a raw Error object would otherwise end up as `[object Object]` in the
// toast title and get dropped by the server's string-message filter.
function normalizeErrorMessage(msg: unknown): { message: string; stack?: string } {
    if (typeof msg === 'string') return { message: msg }
    try {
        if (msg instanceof Error) {
            return { message: msg.message || String(msg), stack: msg.stack }
        }
        if (msg && typeof msg === 'object') {
            const errorLike = msg as { message?: unknown; stack?: unknown }
            const stack = typeof errorLike.stack === 'string' ? errorLike.stack : undefined
            const messageField = typeof errorLike.message === 'string' ? errorLike.message : ''
            const message = messageField || (JSON.stringify(msg) ?? String(msg))
            return { message, stack }
        }
        return { message: JSON.stringify(msg) ?? String(msg) }
    } catch {
        return { message: String(msg) }
    }
}

export function alertError(msg: unknown) {
    // Use nativeConsoleError (pre-monkey-patch) so devtools still shows the error
    // but log-capture does not also persist it — alertError below calls addLog
    // explicitly with source='blocking-alert', avoiding a duplicate entry.
    nativeConsoleError(`[NodeOnly v${nodeOnlyVer}]`, msg)
    const db = getDatabase()

    let { message: errorMessage, stack: stackTrace } = normalizeErrorMessage(msg)
    errorMessage = errorMessage.trim()
    if (!errorMessage) {
        errorMessage = 'Unknown error'
    }

    const ignoredErrors = [
        '{}'
    ]

    if(ignoredErrors.includes(errorMessage)){
        return
    }

    let submsg = ''

    //check if it's a known error
    if(errorMessage.includes('Failed to fetch') || errorMessage.includes("NetworkError when attempting to fetch resource.")){
        submsg =    db.usePlainFetch ? language.errors.networkFetchPlain : language.errors.networkFetch
    }

    // Persist error to logs.db alongside the blocking modal. UX remains blocking;
    // logging is a parallel concern.
    addLog({
        level: 'error',
        message: errorMessage,
        description: stackTrace,
        source: 'blocking-alert',
    })

    alertStoreImported.set({
        'type': 'error',
        'msg': errorMessage,
        'submsg': submsg,
        'stackTrace': stackTrace
    })
}

export async function waitAlert(){
    while(true){
        if (get(alertStoreImported).type === 'none'){
            break
        }
        await sleep(10)
    }
}

export function alertNormal(msg:string){
    alertStoreImported.set({
        'type': 'normal',
        'msg': msg
    })
}

export async function alertNormalWait(msg:string){
    alertStoreImported.set({
        'type': 'normal',
        'msg': msg
    })
    await waitAlert()
}

export async function alertAddCharacter() {
    alertStoreImported.set({
        'type': 'addchar',
        'msg': language.addCharacter
    })
    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertLogin(){
    alertStoreImported.set({
        'type': 'login',
        'msg': 'login'
    })
    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertSelect(msg:string[], display?:string){
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join('||')}` : msg.join('||')
    alertStoreImported.set({
        'type': 'select',
        'msg': message
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertErrorWait(msg:string){
    alertStoreImported.set({
        'type': 'wait2',
        'msg': msg
    })
    await waitAlert()
}

export function alertMd(msg:string){
    alertStoreImported.set({
        'type': 'markdown',
        'msg': msg
    })
}

export function doingAlert(){
    return get(alertStoreImported).type !== 'none' && get(alertStoreImported).type !== 'wait'
}

// ─── Non-blocking notify* family ────────────────────────────────────────────
// Pairs a sonner toast with a persistent log entry. Pick the level that fits
// the message; blocking equivalents (alertError, alertConfirm, alertInput)
// stay in place for cases that require user acknowledgement.

// Clear any in-flight wait/progress modal before showing a notify*. The legacy
// alertNormal side-effect of overwriting alertStore used to do this implicitly;
// without it, a lingering "Loading..." modal stays on screen after the toast
// fires. Only clears transitional states — input/ask/etc. stay intact.
//
// TODO(refactor): this is a workaround for the two-layer UI state (alertStore
// modals + sonner toasts). The cleaner fix is migrating wait/progress to
// sonner's toast.loading/toast.promise and dropping them from alertStore, so
// the two systems do not need explicit coordination. Tracked for a follow-up
// branch, out of scope for the alert-to-notify migration.
function clearTransitionalAlert() {
    const current = get(alertStoreImported).type
    if (current === 'wait' || current === 'wait2' || current === 'progress') {
        alertStoreImported.set({ type: 'none', msg: '' })
    }
}

// notify* accept `unknown` so catch-block callers (notifyError(err)) work
// safely. Raw Error objects were previously stringified as `[object Object]`
// by sonner and dropped by the server's string-message filter — now they
// normalize to .message + .stack (stack → description unless caller overrides).
export function notifyError(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message, stack } = normalizeErrorMessage(msg)
    const description = opts?.description ?? stack
    addLog({ level: 'error', message, description, source: opts?.source })
    toast.error(message, description ? { description } : undefined)
}

export function notifyWarning(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message, stack } = normalizeErrorMessage(msg)
    const description = opts?.description ?? stack
    addLog({ level: 'warning', message, description, source: opts?.source })
    toast.warning(message, description ? { description } : undefined)
}

export function notifyInfo(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message } = normalizeErrorMessage(msg)
    addLog({ level: 'info', message, description: opts?.description, source: opts?.source })
    toast.info(message, opts?.description ? { description: opts.description } : undefined)
}

export function notifySuccess(msg: unknown, opts?: Pick<NotifyOptions, 'description'>) {
    // Intentionally not logged (decision 4-2): success feedback has low timeline value.
    clearTransitionalAlert()
    const { message } = normalizeErrorMessage(msg)
    toast.success(message, opts?.description ? { description: opts.description } : undefined)
}

export function alertWait(msg:string){
    alertStoreImported.set({
        'type': 'wait',
        'msg': msg
    })

}


export function alertClear(){
    alertStoreImported.set({
        'type': 'none',
        'msg': ''
    })
}

export async function alertSelectChar(){
    alertStoreImported.set({
        'type': 'selectChar',
        'msg': ''
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertConfirm(msg:string){

    alertStoreImported.set({
        'type': 'ask',
        'msg': msg
    })

    await waitAlert()

    return get(alertStoreImported).msg === 'yes'
}

/**
 * Confirm dialog with multiple actions and a cancel button.
 * Renders prompt as title, actions as stacked buttons in body, and a single
 * outline Cancel button in the footer. Bare strings render with the `default`
 * variant; pass `{label, variant}` to opt into destructive/primary/etc.
 *
 * @returns index of the picked action, or -1 if cancelled.
 */
/**
 * @param prompt Short heading. Rendered as the dialog title, so keep it to a line.
 * @param actions Buttons, in order. The dialog always adds its own Cancel.
 * @param detail Optional body text below the title, for anything longer than a
 *               heading (breakdowns, consequences). Newlines are preserved.
 */
export async function alertConfirmMulti(prompt:string, actions:(string | AlertAction)[], detail?:string){
    const normalized: AlertAction[] = actions.map(a =>
        typeof a === 'string' ? { label: a, variant: 'default' } : a
    )
    alertStoreImported.set({
        'type': 'confirmMulti',
        'msg': prompt,
        'submsg': detail,
        'actions': normalized,
    })

    await waitAlert()

    const raw = get(alertStoreImported).msg
    const n = parseInt(raw)
    return isNaN(n) ? -1 : n
}

export async function alertPluginConfirm(msg:string){

    alertStoreImported.set({
        'type': 'pluginconfirm',
        'msg': msg
    })

    await waitAlert()

    return get(alertStoreImported).msg === 'yes'
}

export async function alertCardExport(type:string = ''){

    alertStoreImported.set({
        'type': 'cardexport',
        'msg': '',
        'submsg': type
    })

    await waitAlert()

    return JSON.parse(get(alertStoreImported).msg) as {
        type: string,
        type2: string,
    }
}

export async function alertTOS(){

    if(localStorage.getItem(TOS_ACCEPTANCE_STORAGE_KEY) === 'true'){
        return true
    }

    alertStoreImported.set({
        'type': 'tos',
        'msg': 'tos'
    })

    await waitAlert()

    if(get(alertStoreImported).msg === 'yes'){
        localStorage.setItem(TOS_ACCEPTANCE_STORAGE_KEY, 'true')
        return true
    }

    return false
}

export async function alertInput(msg:string, datalist?:[string, string][], defaultValue?:string) {

    alertStoreImported.set({
        'type': 'input',
        'msg': msg,
        'datalist': datalist ?? [],
        'defaultValue': defaultValue ?? ''
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertModuleSelect(){

    alertStoreImported.set({
        'type': 'selectModule',
        'msg': ''
    })

    while(true){
        if (get(alertStoreImported).type === 'none'){
            break
        }
        await sleep(20)
    }

    return get(alertStoreImported).msg
}

export function alertRequestData(info:AlertGenerationInfoStoreData){
    alertGenerationInfoStore.set(info)
    alertStoreImported.set({
        'type': 'requestdata',
        'msg': info.genInfo.generationId ?? 'none'
    })
}

export async function alertTogglePresets(): Promise<void> {
    // Toggle preset selector lives in its own store (togglePresetsOpenStore)
    // rather than alertStore. This way, alertConfirm / alertInput triggered
    // from inside the toggle preset menu overlay on top instead of replacing
    // the alertStore singleton, so the legacy reopenPresets() round-trip
    // disappears.
    //
    // Returns void: applying a preset now happens directly in AlertComp's
    // onclick handler (via applyToggleValues) rather than being threaded
    // back through this function's return value.
    return new Promise<void>(resolve => {
        togglePresetsOpenStore.set(true)
        const unsub = togglePresetsOpenStore.subscribe(v => {
            if (!v) {
                // subscribe fires once on subscribe with current value (true),
                // then again only on changes. Skip initial true and resolve
                // once the consumer flips it back to false.
                unsub()
                resolve()
            }
        })
    })
}
