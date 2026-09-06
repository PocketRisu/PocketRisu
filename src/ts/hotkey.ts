import { get } from "svelte/store"
import { alertClear, alertMd, alertSelect, alertWait, doingAlert } from "./alert"
import { getDatabase, getCurrentCharacter, getCurrentChat } from "./storage/database.svelte"
import { setChatMemoryPreset } from "./process/memory/memoryPresets"
import { alertStore, DBState, MobileGUIStack, MobileSideBar, openPersonaList, personaSelectCallback, openPresetList, openModelPresetList, openMemoryPresetList, memoryPresetSelectCallback, openThemePresetList, OpenRealmStore, PlaygroundStore, QuickSettings, SafeModeStore, selectedCharID, settingsOpen } from "./stores.svelte"
import { language } from "src/lang"
import { updateTextThemeAndCSS } from "./gui/colorscheme"
import { defaultHotkeys } from "./defaulthotkeys"
import { doingChat, previewBody, sendChat } from "./process/index.svelte"
import { endAllGenerations } from "./process/generationState"
import { RISU_SIDEBAR_DRAG_TYPE } from "./dragTypes"
import { openSettings, SettingsRoute, SystemTab } from "./routing"
import { deselectCharacter } from "./characters"

export function initHotkey(){
    document.addEventListener('keydown', async (ev) => {
        if(
            !ev.ctrlKey &&
            !ev.altKey &&
            !ev.shiftKey &&
            (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) ||
            document.activeElement.getAttribute('contenteditable'))
        ){
            return
        }


        const database = getDatabase()

        const hotKeys = database?.hotkeys ?? defaultHotkeys

        let hotkeyRan = false
        for(const hotkey of hotKeys){
            let hotKeyRanThisTime = true

            if(!hotkeyMatches(hotkey, ev)){
                continue
            }
            switch(hotkey.action){
                case 'reroll':{
                    clickQuery('.button-icon-reroll')
                    break
                }
                case 'unreroll':{
                    clickQuery('.button-icon-unreroll')
                    break
                }
                case 'translate':{
                    clickQuery('.button-icon-translate')
                    break
                }
                case 'remove':{
                    clickQuery('.button-icon-remove')
                    break
                }
                case 'edit':{
                    clickQuery('.button-icon-edit')
                    setTimeout(() => {
                        focusQuery('.message-edit-area')
                    }, 100)
                    break
                }
                case 'copy':{
                    clickQuery('.button-icon-copy')
                    break
                }
                case 'focusInput':{
                    focusQuery('.text-input-area')
                    break
                }
                case 'send':{
                    clickQuery('.button-icon-send')
                    break
                }
                case 'settings':{
                    settingsOpen.set(!get(settingsOpen))
                    break
                }
                case 'home':{
                    deselectCharacter()
                    break
                }
                case 'presets':{
                    openPresetList.set(!get(openPresetList))
                    break
                }
                case 'persona':{
                    openPersonaList.set(!get(openPersonaList))
                    personaSelectCallback.set(null)
                    break
                }
                case 'modelSelect':{
                    openModelPresetList.set(!get(openModelPresetList))
                    break
                }
                case 'toggleCSS':{
                    SafeModeStore.set(!get(SafeModeStore))
                    updateTextThemeAndCSS()
                    break
                }
                case 'prevChar':{
                    const sorted = database.characters.map((v, i) => {
                        return {name: v.name, i}
                    }).sort((a, b) => a.name.localeCompare(b.name))
                    const currentIndex = sorted.findIndex(v => v.i === get(selectedCharID))
                    if(currentIndex <= 0){
                        return
                    }
                    selectedCharID.set(sorted[currentIndex - 1].i)
                    try {
                        const char = database.characters[sorted[currentIndex - 1].i]
                        if (char?.chaId) {
                            localStorage.setItem('risu-last-active-character', char.chaId)
                        }
                    } catch {}
                    PlaygroundStore.set(0)
                    OpenRealmStore.set(false)
                    break
                }
                case 'nextChar':{
                    const sorted = database.characters.map((v, i) => {
                        return {name: v.name, i}
                    }).sort((a, b) => a.name.localeCompare(b.name))
                    const currentIndex = sorted.findIndex(v => v.i === get(selectedCharID))
                    if(currentIndex >= sorted.length - 1){
                        return
                    }
                    // currentIndex === -1 (nothing selected) intentionally falls through
                    // to sorted[0], matching the previous behaviour.
                    selectedCharID.set(sorted[currentIndex + 1].i)
                    try {
                        const char = database.characters[sorted[currentIndex + 1].i]
                        if (char?.chaId) {
                            localStorage.setItem('risu-last-active-character', char.chaId)
                        }
                    } catch {}
                    PlaygroundStore.set(0)
                    OpenRealmStore.set(false)
                    break
                }
                case 'quickMenu':{
                    quickMenu()
                    break
                }
                case 'previewRequest':{
                    if(get(doingChat) && get(selectedCharID) !== -1){
                        // Consumed (break → preventDefault below) so the key
                        // does not leak to the browser's default action.
                        break
                    }
                    alertWait("Loading...")
                    ev.preventDefault()
                    ev.stopPropagation()
                    try {
                        const ok = await sendChat(-1, {
                            previewPrompt: true
                        })
                        if(ok === false){
                            // sendChat reported the failure itself (error
                            // alert or inlay). Only the "Loading..." dialog
                            // must not be left behind.
                            if(get(alertStore).type === 'wait') alertClear()
                            return
                        }

                        let md = ''
                        md += '### Prompt\n'
                        md += '```json\n' + JSON.stringify(JSON.parse(previewBody), null, 2).replaceAll('```', '\\`\\`\\`') + '\n```\n'
                        alertMd(md)
                    } catch (error) {
                        // alertWait above opens a deliberately non-closable dialog
                        // (no X, ESC and outside click blocked). On the success path
                        // alertMd replaces it, but a throw would otherwise leave the
                        // user trapped in it until a reload.
                        alertClear()
                        throw error
                    } finally {
                        // Without this a throw from sendChat/JSON.parse left the
                        // generation state locked.
                        endAllGenerations()
                    }
                    return
                }
                case 'toggleLog':{
                    openSettings(SettingsRoute.System, SystemTab.RequestLogs)
                    break
                }
                case 'quickSettings':{
                    QuickSettings.open = !QuickSettings.open
                    QuickSettings.index = 0
                    break
                }
                case 'scrollToActiveChar':{
                    if(database.enableScrollToActiveChar !== false){
                        window.dispatchEvent(new CustomEvent('scrollToActiveCharacter'))
                    }
                    break
                }
                default:{
                    hotKeyRanThisTime = false
                }
            }

            if(hotKeyRanThisTime){
                hotkeyRan = true
                break
            }
        }

        if(hotkeyRan){
            ev.preventDefault()
            ev.stopPropagation()
            return
        }


        if(ev.key === 'Escape'){
            // 모달(AlertComp 팝업 또는 Sh*Dialog)이 열려있을 땐 전역 ESC 동작을 중단한다.
            // bits-ui Dialog는 preventDefault만 하고 stopPropagation은 하지 않기 때문에,
            // 가드 없이는 Dialog 자체는 유지되지만 뒤에 있는 설정 드로어가 함께 닫히는 현상이 있다.
            if(doingAlert() || document.querySelector('[aria-modal="true"][data-state="open"]')){
                ev.preventDefault()
                return
            }
            if(get(settingsOpen)){
                settingsOpen.set(false)
            }
            ev.preventDefault()
        }
        if(ev.key === 'Enter'){
            const alertType = get(alertStore).type 
            if(alertType === 'ask' || alertType === 'normal' || alertType === 'error'){
                alertStore.set({
                    type: 'none',
                    msg: 'yes'
                })
            }
        }
    })


    let touchs = 0
    let touchStartTime = 0
    //check for triple touch
    document.addEventListener('touchstart', (ev) => {
        touchs++
        if(touchs > 2){
            if(Date.now() - touchStartTime > 300){
                return
            }
            touchs = 0
            if(doingAlert()){
                return
            }
            quickMenu()
        }
        if(touchs === 1){
            touchStartTime = Date.now()
        }
    })
    document.addEventListener('touchend', (ev) => {
        touchs = 0
    })
    
    let lastScrollTime = 0
    const SCROLL_COOLDOWN = 500
    
    document.addEventListener('dragover', (ev) => {
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
            const types = ev.dataTransfer?.types || []
            const isCharacterDrag = types.includes(RISU_SIDEBAR_DRAG_TYPE)
            
            if (isCharacterDrag) {
                const db = getDatabase()
                if(db.enableScrollToActiveChar !== false){
                    const now = Date.now()
                    if (now - lastScrollTime > SCROLL_COOLDOWN) {
                        lastScrollTime = now
                        window.dispatchEvent(new CustomEvent('scrollToActiveCharacter'))
                    }
                }
            }
        }
    }, true)
}

export async function quickMenu(){
    const db = getDatabase()
    const showHypaV3 = (db.memoryPresets?.length ?? 0) > 0 && !!getCurrentChat()

    const options = [
        language.presets,
        language.themePresets,
        language.persona,
        ...(showHypaV3 ? [language.longTermMemory + ' ' + language.presets] : []),
        language.cancel
    ]

    const sel = parseInt(await alertSelect(options))
    let idx = 0
    if(sel === idx++){
        openPresetList.set(!get(openPresetList))
    }
    else if(sel === idx++){
        openThemePresetList.set(!get(openThemePresetList))
    }
    else if(sel === idx++){
        openPersonaList.set(!get(openPersonaList))
        personaSelectCallback.set(null)
    }
    else if(showHypaV3 && sel === idx++){
        memoryPresetSelectCallback.set((value) => {
            const char = getCurrentCharacter()
            const chat = getCurrentChat()
            if (chat) setChatMemoryPreset(DBState.db, char, chat, value)
        })
        openMemoryPresetList.set(true)
    }
}

export function hotkeyMatches(hotkey: typeof DBState.db.hotkeys[number], ev: KeyboardEvent): boolean {
    if(!hotkey){
        return false
    }

    hotkey.ctrl = hotkey.ctrl ?? false
    hotkey.alt = hotkey.alt ?? false
    hotkey.shift = hotkey.shift ?? false

    if(hotkey.ctrl !== ev.ctrlKey) return false
    if(hotkey.alt !== ev.altKey) return false
    if(hotkey.shift !== ev.shiftKey) return false
    if(hotkey.key.toLowerCase() !== ev.key.toLowerCase()) return false
    if(!hotkey.ctrl && !hotkey.alt && !hotkey.shift){
        if(['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return false
    }
    return true
}

function clickQuery(query:string){
    let ele = document.querySelector(query) as HTMLElement
    console.log(ele)
    if(ele){
        ele.click()
    }
}

function focusQuery(query:string){
    let ele = document.querySelector(query) as HTMLElement
    if(ele){
        ele.focus()
    }
}



export function initMobileGesture(){
    let pressingPointers = new Map<number, {x:number, y:number}>()

    document.addEventListener('touchstart', (ev) => {
        for(const touch of ev.changedTouches){
            const ele = touch.target as HTMLElement
            if(ele.tagName === 'BUTTON' || ele.tagName === 'INPUT' || ele.tagName === 'SELECT' || ele.tagName === 'TEXTAREA'){
                return
            }
            pressingPointers.set(touch.identifier, {x: touch.clientX, y: touch.clientY})
        }
    }, {
        passive: true
    })
    document.addEventListener('touchend', (ev) => {
        for(const touch of ev.changedTouches){
            const d = pressingPointers.get(touch.identifier)
            const moveX = touch.clientX - d.x
            const moveY = touch.clientY - d.y
            pressingPointers.delete(touch.identifier)

            if(moveX > 50 && Math.abs(moveY) < Math.abs(moveX)){
                if(get(selectedCharID) === -1){
                    if(get(MobileGUIStack) > 0){
                        MobileGUIStack.update(v => v - 1)
                    }
                }
                else{
                    if(get(MobileSideBar) > 0){
                        MobileSideBar.update(v => v - 1)
                    }
                }
            }
            else if(moveX < -50 && Math.abs(moveY) < Math.abs(moveX)){
                if(get(selectedCharID) === -1){
                    if(get(MobileGUIStack) < 2){
                        MobileGUIStack.update(v => v + 1)
                    }
                }
                else{
                    if(get(MobileSideBar) < 3){
                        MobileSideBar.update(v => v + 1)
                    }
                }
            }
        }
    }, {
        passive: true
    })
}
