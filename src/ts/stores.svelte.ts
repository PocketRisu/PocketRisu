import { writable } from "svelte/store";
import { MEMORY_PRESET_DEFAULT, MEMORY_PRESET_OFF, getMemoryPreset, resolveMemoryPresetId, setChatMemoryPreset } from './process/memory/memoryPresets'
import type { character, Database } from "./storage/database.svelte";
import { type simpleCharacterArgument } from "./parser/parser.svelte";
import type { alertData } from "./alert";
import { moduleUpdate } from "./process/modules";
import { deepTouch } from "./gui/deepTouch.svelte";
import { resetScriptCache } from "./process/scripts";
import type { hubType } from "./characterCards";
import type { PluginSafetyErrors } from "./plugins/pluginSafety";
import { isWideShell, sidebarStateAfterResize } from "./gui/shellBreakpoint";

let lastShellWidth: number | undefined

function updateSize(){
    SizeStore.set({
        w: window.innerWidth,
        h: window.innerHeight
    })
    DynamicGUI.set(!isWideShell(window.innerWidth))
    // Crossing the docked/overlay breakpoint resets the sidebar to what a
    // boot at the new width would pick; anything else is left alone (#79).
    const sidebar = sidebarStateAfterResize(lastShellWidth, window.innerWidth)
    lastShellWidth = window.innerWidth
    if (sidebar !== undefined) sideBarStore.set(sidebar)
}

export const SizeStore = writable({
    w: 0,
    h: 0
})

export const loadedStore = writable(false)
export const isTouchDevice = writable(typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
export const DynamicGUI = writable(false)
export const sideBarClosing = writable(false)
export const sideBarStore = writable(isWideShell(window.innerWidth))
export const leftBarCollapsed = writable(false)
export const selectedCharID = writable(-1)
export const chatDeselected = writable(false)
export const CurrentTriggerIdStore = writable<string | null>(null)
export const CharEmotion = writable({} as {[key:string]: [string, string, number][]})
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }); // Default width and height in pixels
export const settingsOpen = writable(false)
export const botMakerMode = writable(false)
export const moduleBackgroundEmbedding = writable('')
export const openPresetList = writable(false)
// Character manager popup (desktop overlay; mobile mounts it inline).
export const openCharacterManager = writable(false)
// Folder settings dialog target: characterOrder folder id, or null when closed.
export const folderSettingsTarget = writable<string | null>(null)
export const presetSelectCallback = writable<((index: number) => void) | null>(null)
export const openModelPresetList = writable(false)
export const modelPresetSelectCallback = writable<((id: string) => void) | null>(null)
export const openModelProfileBrowser = writable(false)
// When set to a preset id, the profile browser replaces that preset's profile
// (migrating matching userValues) instead of creating a new preset. null = create.
export const modelProfileReplaceTarget = writable<string | null>(null)
// Set to a newly-created preset id so the ModelPreset settings page opens it
// for editing immediately. Consumed (cleared) by ModelPresetSettings.
export const openModelPresetEditId = writable<string | null>(null)
export const openModuleListStore = writable(false)
export const openThemePresetList = writable(false)
export const openPersonaList = writable(false)
export const personaSelectCallback = writable<((index: number) => void) | null>(null)
export const openMemoryPresetList = writable(false)
/** Receives a preset id, 'off' or 'default' from the memory preset picker. */
export const memoryPresetSelectCallback = writable<((value: string) => void) | null>(null)
export const bookmarkListOpen = writable(false)
export const MobileGUI = writable(false)
export const MobileGUIStack = writable(0)
export const MobileSideBar = writable(0)
export const SettingsMenuIndex = writable(-1)
// Boot-time backup reminder prompt — set by bootstrap and rendered by
// BootBackupPrompt. The component resolves the user's choice (proceed/skip)
// back via the resolve callback. See src/ts/bootstrap.ts.
export interface BootBackupPromptData {
    estimate: number | null
    free: number | null
    total: number | null
    insufficient: boolean
    resolve: (proceed: boolean) => void
}
export const bootBackupPromptStore = writable<BootBackupPromptData | null>(null)

// Sub-tab index inside the System settings page. Exposed as a store so
// other pages can deep-link via openSettings(SettingsRoute.System,
// SystemTab.X) — see src/ts/routing.
export const SystemSubmenuIndex = writable(0)
// Sub-tab index inside the Accessibility settings page. A store so the model-
// mode gear button can deep-link to the Sidebar tab — see src/ts/routing
// (AccessibilityTab) and Setting/Pages/AccessibilitySettings.svelte.
export const AccessibilitySubmenuIndex = writable(0)
// Sub-tab indices for the remaining tabbed settings pages. Stores (instead of
// page-local $state) so the settings search can deep-link to a specific tab —
// see src/ts/setting/searchIndex.ts (navigateToSearchResult).
export const DisplaySubmenuIndex = writable(0)
export const BotSubmenuIndex = writable(0)
export const PromptPresetSubmenuIndex = writable(0)
/** One-shot: open the prompt preset page directly in its editor (settings search deep link). */
export const PromptPresetEditorOpen = writable(false)
export const OtherBotsSubmenuIndex = writable(1)
export const InlayGallerySubmenuIndex = writable(0)
// List-view tab of the Model Preset page (Presets / API keys / Options).
// Distinct from the editor's own sub-tabs, which stay page-local.
export const ModelPresetListTabIndex = writable(0)
export const ReloadGUIPointer = writable(0)
export const ReloadChatPointer = writable({} as Record<number, number>)
export const ScrollToMessageStore = $state({ value: -1 })
export const OpenRealmStore = writable(false)
export const RealmInitialOpenChar = writable<null | hubType>(null)
export const PlaygroundStore = writable(0)
export const HideIconStore = writable(false)
export const CustomCSSStore = writable('')
export const SafeModeStore = writable(false)
export const MobileSearch = writable('')
export const CharConfigSubMenu = writable(0)
export const alertStore = writable({
    type: 'none',
    msg: 'n',
} as alertData)
export const hypaV3ModalOpen = writable(false)
// Toggle preset selector lives outside alertStore so child alertConfirm /
// alertInput overlays can layer on top of it without overwriting state.
export const togglePresetsOpenStore = writable(false)
export const hypaV3ProgressStore = writable({
    open: false,
    miniMsg: '',
    msg: '',
    subMsg: '',
})
export const selIdState = $state({
    selId: -1
})


CustomCSSStore.subscribe((css) => {
    console.log(css)
    const q = document.querySelector('#customcss')
    if(q){
        q.innerHTML = css
    }
    else{
        const s = document.createElement('style')
        s.id = 'customcss'
        s.innerHTML = css
        document.body.appendChild(s)
    }
})

export function createSimpleCharacter(char:character){
    if(!char){
        return null
    }

    const simpleChar:simpleCharacterArgument = {
        type: "simple",
        customscript: char.customscript,
        chaId: char.chaId,
        additionalAssets: char.additionalAssets,
        additionalAssetManifest: char.additionalAssetManifest,
        virtualscript: char.virtualscript,
        emotionImages: char.emotionImages,
        triggerscript: char.triggerscript,
    }

    return simpleChar

}

updateSize()
window.addEventListener("resize", updateSize);
// A foldable or split-screen change can land while the page is hidden and
// leave no resize behind; re-sample when it comes back into view.
window.addEventListener("orientationchange", updateSize);
window.addEventListener("pageshow", updateSize);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'visible') updateSize()
});
export const DBState = $state({
    db: {} as any as Database
});

export const LoadingStatusState = $state({
    text: '',
})

export const loadingOverlayStore = writable<{
    active: boolean,
    text: string,
    onCancel?: (() => void) | null,
}>({
    active: false,
    text: '',
    onCancel: null,
})

export const QuickSettings = $state({
    open: false,
    index: 0
})

export const pluginAlertModalStore = $state({
    open: false,
    errors: [] as PluginSafetyErrors[]
})

export const disableHighlight = writable(true)

export type MenuDef = {
    name: string,
    icon: string,
    iconType:'html'|'img'|'none',
    callback: any,
    id: string,
}

export type ChatPanelDef = {
    id: string,
    pluginName: string,
    html: string,
    className?: string,
}

export const additionalSettingsMenu = $state([] as MenuDef[])
export const additionalFloatingActionButtons = $state([] as MenuDef[])
export const additionalHamburgerMenu = $state([] as MenuDef[])
export const additionalChatMenu = $state([] as MenuDef[])
export const chatPanelStore = $state([] as ChatPanelDef[])
export const bodyIntercepterStore = $state([] as {
    id: string,
    callback: (body: any, type: string) => Promise<any>
}[])
export const popupStore = $state({
    children: null as null | import("svelte").Snippet,
    mouseX: 0,
    mouseY: 0,
    openId: 0,
})

export const popUpEditorStore = $state({
    open: false,
    value: '',
    mode: 'default' as 'default',
    language: 'markdown' as string
})

//Set might be more ideal, however since Svelte doesn't support reactive Sets, using array for now
export const hotReloading = $state<string[]>([])

ReloadGUIPointer.subscribe(() => {
    ReloadChatPointer.set({})
    resetScriptCache()
})

$effect.root(() => {
    selectedCharID.subscribe((v) => {
        selIdState.selId = v

        if (DBState?.db?.characters?.[selIdState.selId]) {
            // "Always toggle on": a chat with no binding of its own follows the
            // global default when that preset asks for it. Explicit bindings
            // (including an explicit 'off') are respected.
            const char = DBState.db.characters[selIdState.selId]
            const chat = char?.chats?.[char.chatPage]
            if (chat && chat.memoryPresetId === undefined && char.memoryPresetId === undefined) {
                const preset = getMemoryPreset(DBState.db, DBState.db.memoryPresetId)
                if (preset?.canon?.source === 'hypaV3' && preset.canon.settings.alwaysToggleOn
                    && resolveMemoryPresetId(DBState.db, char, chat) === MEMORY_PRESET_OFF) {
                    setChatMemoryPreset(DBState.db, char, chat, MEMORY_PRESET_DEFAULT)
                }
            }
        }
    })
    $effect(() => {
        try { deepTouch(DBState.db.modules) } catch (e) {
            console.warn('[ModuleUpdate] deepTouch(modules) failed:', e)
            return
        }
        DBState?.db?.enabledModules
        DBState?.db?.enabledModules?.length
        DBState?.db?.characters?.[selIdState.selId]?.chats?.[DBState?.db?.characters?.[selIdState.selId]?.chatPage]?.modules?.length
        DBState?.db?.characters?.[selIdState.selId]?.modules?.length
        DBState?.db?.characters?.[selIdState.selId]?.hideChatIcon
        DBState?.db?.characters?.[selIdState.selId]?.backgroundHTML
        DBState?.db?.moduleIntergration
        moduleUpdate()
    })
})
