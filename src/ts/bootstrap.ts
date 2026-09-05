import { changeFullscreen, checkNullish } from "./util"
import { installDynamicViewportHeight } from "./viewportHeight"
import { v4 as uuidv4 } from 'uuid';
import { get } from "svelte/store";
import { setDatabase, defaultSdDataFunc, getDatabase, changeToThemePreset } from "./storage/database.svelte";
import { chatDraftKey, sweepOrphanDrafts } from "./storage/chatDraft";
import { checkRisuUpdate } from "./update";
import { fetchPublicStats } from "./publicStats";
import { MobileGUI, botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, bootBackupPromptStore } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, alertTOS, waitAlert, alertConfirm, alertInput } from "./alert";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeRisuSave, encodeRisuSaveLegacy } from "./storage/risuSave";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { applyEarlyLanguage, changeLanguage, language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { changeChar, updateLorebooks } from "./characters";
import { initMobileGesture } from "./hotkey";
import { moduleUpdate } from "./process/modules";
import {
    forageStorage,
    saveDb,
    setPatchSyncBaseline,
    getDbBackups,
    checkCharOrder
} from "./globalApi.svelte";
import { registerModelDynamic } from "./model/modellist";
import { initModelJobRecovery } from "./process/request/jobRecovery";
import { convertStubsToPlaceholders } from "./storage/chatStorage";
import { isChatStub, purgeUnsupportedGroupChats } from "./storage/database.svelte";

/**
 * Loads the application data.
 */
export async function loadData() {
    const loaded = get(loadedStore)
    if (!loaded) {
        try {
            applyEarlyLanguage()
            let createdFreshDatabase = false
            {
                await forageStorage.Init()

                LoadingStatusState.text = "Loading Local Save File..."
                let gotStorage: Uint8Array = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                LoadingStatusState.text = "Decoding Local Save File..."
                if (checkNullish(gotStorage)) {
                    createdFreshDatabase = true
                    gotStorage = encodeRisuSaveLegacy({})
                    await forageStorage.setItem('database/database.bin', gotStorage)
                }
                try {
                    const decoded = await decodeRisuSave(gotStorage)
                    // setPatchSyncBaseline owns its defensive clone. Cloning at
                    // both call sites briefly held two full DB copies at boot.
                    setPatchSyncBaseline(decoded)
                    console.log(decoded)
                    setDatabase(decoded)
                } catch (error) {
                    console.error(error)
                    const backups = await getDbBackups()
                    let backupLoaded = false
                    for (const backup of backups) {
                        try {
                            LoadingStatusState.text = `Reading Backup File ${backup}...`
                            const backupData: Uint8Array = await forageStorage.getItem(`database/dbbackup-${backup}.bin`) as unknown as Uint8Array
                            const backupDecoded = await decodeRisuSave(backupData)
                            setPatchSyncBaseline(backupDecoded)
                            setDatabase(backupDecoded)
                            backupLoaded = true
                            break
                        } catch (error) { }
                    }
                    if (!backupLoaded) {
                        throw "Forage: Your save file is corrupted"
                    }
                }

                if (getDatabase().didFirstSetup) {
                    characterURLImport()
                }
            }
            if (createdFreshDatabase) {
                // Brand-new instance (no save file existed): apply the default
                // theme preset (#0 = PocketRisu Standard) so the active display
                // settings (zoomsize 120, iconsize, line height, etc.) match the
                // standard theme instead of upstream's raw DB defaults. setDatabase
                // creates this preset but never applies it. Gated on
                // createdFreshDatabase, so migrating/updating users (who already
                // have a database.bin) are never touched. savecurrent=false skips
                // saving the default state back over the preset.
                changeToThemePreset(0, false)
                const browserLangShort = navigator.language.split('-')[0]
                const browserLanguageMap: Record<string, string> = {
                    de: 'de',
                    en: 'en',
                    ko: 'ko',
                    cn: 'cn',
                    vi: 'vi',
                    es: 'es',
                    zh: 'zh-Hant'
                }
                const mappedLanguage = browserLanguageMap[browserLangShort]
                if (mappedLanguage) {
                    const db = getDatabase()
                    db.language = mappedLanguage
                    changeLanguage(mappedLanguage)
                }
            }
            LoadingStatusState.text = "Loading Plugins..."
            try {
                await loadPlugins()
            } catch (error) { }
            try {
                //@ts-expect-error navigator.standalone is iOS Safari non-standard property, not in Navigator interface
                const isInStandaloneMode = (window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone) || document.referrer.includes('android-app://');
                if (isInStandaloneMode) {
                    await navigator.storage.persist()
                }
            } catch (error) {

            }
            LoadingStatusState.text = "Checking For Format Update..."
            await checkNewFormat()

            // Convert any ChatStubs (from server-stripped database.bin) to placeholder Chats
            // so runtime code only sees Chat objects
            {
                const dbForConvert = getDatabase()
                for (const char of dbForConvert.characters) {
                    char.chats = convertStubsToPlaceholders(char.chats)
                }
            }

            const db = getDatabase();

            LoadingStatusState.text = "Updating States..."
            updateColorScheme()
            updateTextThemeAndCSS()
            updateAnimationSpeed()
            updateHeightMode()
            // Only when no explicit heightMode override is active — an explicit
            // vh/dvh/svh/... choice must keep sizing exactly as configured.
            if (!db.heightMode || db.heightMode === 'normal') {
                installDynamicViewportHeight()
            }
            updateErrorHandling()
            updateGuisize()
            if (!db.didFirstSetup) {
                // Node-only build skips the onboarding screen and lands on the main UI directly.
                db.didFirstSetup = true
            }
            if (db.botSettingAtStart) {
                botMakerMode.set(true)
            }
            if ((db.betaMobileGUI && window.innerWidth <= 800) || import.meta.env.VITE_RISU_LITE === 'TRUE') {
                initMobileGesture()
                MobileGUI.set(true)
            }
            // Boot-time backup reminder. If the user has enabled it, we block
            // the load briefly to ask whether to back up now. Errors here are
            // non-fatal — boot must always proceed even if the reminder fetch
            // or backup itself fails.
            try {
                await maybeRunBootBackupReminder()
            } catch (err) {
                console.warn('[bootstrap] boot backup reminder failed:', err)
            }
            loadedStore.set(true)

            selectedCharID.set(-1)

            // Keep PocketRisu's normal clean boot (-1), then restore through
            // the canonical changeChar path so lazy chat hydration, toggles,
            // and chat UI initialization still run normally.
            try {
                const lastChaId = db.nodeOnlyRestoreLastChat
                    ? localStorage.getItem('risu-last-active-character')
                    : null
                const restoreIndex = lastChaId
                    ? DBState.db.characters.findIndex((char) => char?.chaId === lastChaId)
                    : -1

                if (restoreIndex >= 0) {
                    setTimeout(() => {
                        try {
                            changeChar(restoreIndex)

                        } catch (error) {
                            console.warn('[MobileResume] restore failed:', error)
                        }
                    }, 100)
                }
            } catch { /* best effort only */ }

            startObserveDom()
            assignIds()
            registerModelDynamic()
            saveDb()
            moduleUpdate()
            // cleanChunks는 화면 진입 후 유휴 시간에 실행 (부트 블로킹 제거)
            setTimeout(() => {
                cleanChunks().catch(console.error)
            }, 5_000)
            checkRisuUpdate()
            fetchPublicStats()
            // Server-side model-job recovery (jobRecovery.ts): slot journaled
            // responses from disconnected generations back into their chats.
            // Installs the return triggers (visibility / online) and runs the
            // first pass. Fire-and-forget — never throws, no-op without jobs.
            initModelJobRecovery()
            if (import.meta.env.VITE_RISU_TOS === 'TRUE') {
                alertTOS().then((a) => {
                    if (a === false) {
                        location.reload()
                    }
                })
            }
        } catch (error) {
            alertError(error)
        }
    }
}



/**
 * Hard-bounded fetch — the boot path can't tolerate an indefinite hang on a
 * stuck endpoint, since the loading screen blocks the user until we set
 * loadedStore. AbortError is rethrown like any fetch failure; the call site
 * swallows it.
 */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = 5000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

/**
 * If the user has enabled the boot-time server-backup reminder, prompt with a
 * confirm dialog before the main UI loads. Confirming runs SaveServerBackup
 * synchronously (its alertWait progress overlays the loading screen).
 */
async function maybeRunBootBackupReminder() {
    let enabled = false
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
        if (!res.ok) return
        const json = await res.json()
        enabled = !!json.enabled
    } catch {
        return  // Non-fatal — skip the prompt if the endpoint is unreachable / slow.
    }
    if (!enabled) return

    // Best-effort stats fetch. The prompt component renders whatever we can
    // supply; missing values just hide their respective lines. Uses
    // backupDisk (actual backup destination) so warnings target the right
    // mount when backupsDir is on a different drive than save/.
    let estimate: number | null = null
    let free: number | null = null
    let total: number | null = null
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/db/stats', { headers: { 'risu-auth': auth } })
        if (res.ok) {
            const stats = await res.json()
            if (typeof stats?.estimatedBackupSize === 'number') estimate = stats.estimatedBackupSize
            const d = stats?.backupDisk ?? stats?.disk
            if (typeof d?.free === 'number') free = d.free
            if (typeof d?.total === 'number') total = d.total
        }
    } catch { /* keep nulls */ }

    const insufficient = (estimate != null && free != null && estimate > free)

    const proceed = await new Promise<boolean>((resolve) => {
        bootBackupPromptStore.set({ estimate, free, total, insufficient, resolve })
    })
    if (!proceed) return
    const { SaveServerBackup } = await import('./drive/backuplocal')
    await SaveServerBackup()
}

/**
 * Updates the error handling by adding custom handlers for errors and unhandled promise rejections.
 */
function updateErrorHandling() {
    const errorHandler = (event: ErrorEvent) => {
        console.error(event.error);
        if(!(event.error?.target instanceof Worker)){
            alertError(event.error);
        }
    };
    const rejectHandler = (event: PromiseRejectionEvent) => {
        console.error(event.reason);
        alertError(event.reason);
    };
    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectHandler);
}

/**
 * Updates the height mode of the document based on the value stored in the database.
 */
function updateHeightMode() {
    const db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    switch (db.heightMode) {
        case 'auto':
            root.style.setProperty('--risu-height-size', '100%');
            break
        case 'vh':
            root.style.setProperty('--risu-height-size', '100vh');
            break
        case 'dvh':
            root.style.setProperty('--risu-height-size', '100dvh');
            break
        case 'lvh':
            root.style.setProperty('--risu-height-size', '100lvh');
            break
        case 'svh':
            root.style.setProperty('--risu-height-size', '100svh');
            break
        case 'percent':
            root.style.setProperty('--risu-height-size', '100%');
            break
    }
}

/**
 * Checks and updates the database format to the latest version.
 */
async function checkNewFormat(): Promise<void> {
    let db = getDatabase();

    // Check data integrity
    db.characters = db.characters.map((v) => {
        if (!v) {
            return null;
        }
        v.chaId ??= uuidv4();
        v.type ??= 'character';
        v.chatPage ??= 0;
        v.chats ??= [];
        v.customscript ??= [];
        v.firstMessage ??= '';
        v.globalLore ??= [];
        v.name ??= '';
        v.viewScreen ??= 'none';
        v.emotionImages = v.emotionImages ?? [];

        if (v.type === 'character') {
            v.bias ??= [];
            v.characterVersion ??= '';
            v.creator ??= '';
            v.desc ??= '';
            v.utilityBot ??= false;
            v.tags ??= [];
            v.systemPrompt ??= '';
            v.scenario ??= '';
        }
        return v;
    }).filter((v) => {
        return v !== null;
    });

    const removedGroupChats = purgeUnsupportedGroupChats(db)
    if (removedGroupChats > 0) {
        console.warn(`[bootstrap] Removed ${removedGroupChats} unsupported group chat entr${removedGroupChats === 1 ? 'y' : 'ies'} from database`)
    }

    db.modules = await Promise.all((db.modules ?? []).map(async (v) => {
        if (v?.lorebook) {
            if (!Array.isArray(v.lorebook)) {
                console.error('Critical: Invalid lorebook format detected in module');
                console.error('Module data:', JSON.stringify(v, null, 2));
                
                // Alert user about corrupted data
                alertError(language.bootstrap.dataCorruptionDetected(v.name || 'Unknown', typeof v.lorebook));
                await waitAlert();
                
                // Ask if user wants to report the issue
                const shouldReport = await alertConfirm(language.bootstrap.reportErrorQuestion);
                
                if (shouldReport) {
                    try {
                        // Collect diagnostic information (without personal data)
                        const diagnosticInfo = {
                            timestamp: new Date().toISOString(),
                            moduleName: v.name || 'Unknown',
                            lorebookType: typeof v.lorebook,
                            lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                            isArray: Array.isArray(v.lorebook),
                            keys: v.lorebook ? Object.keys(v.lorebook).join(', ') : 'N/A',
                            formatVersion: db.formatversion || 'Unknown'
                        };
                        
                        // Show the diagnostic info and allow user to copy or send
                        const reportData = JSON.stringify(diagnosticInfo, null, 2);
                        await alertMd(language.bootstrap.diagnosticInformation(reportData));
                        await waitAlert();
                        
                        console.log('Diagnostic information for developers:', diagnosticInfo);
                    } catch (reportError) {
                        console.error('Failed to generate diagnostic report:', reportError);
                    }
                }
                
                // Ask if user wants to reset the data
                const shouldReset = await alertConfirm(language.bootstrap.resetLorebookQuestion);
                
                if (shouldReset) {
                    v.lorebook = [];
                    console.log('Lorebook reset to empty array by user choice');
                } else {
                    console.warn('User chose to keep corrupted lorebook data');
                }
            } else {
                v.lorebook = updateLorebooks(v.lorebook);
            }
        }
        return v
    }));
    
    db.modules = db.modules.filter((v) => {
        return v !== null && v !== undefined;
    });

    db.personas = (db.personas ?? []).map((v) => {
        v.id ??= uuidv4()
        return v
    }).filter((v) => {
        return v !== null && v !== undefined;
    });

    if (!db.formatversion) {
        function checkClean(data: string) {

            if (data.startsWith('assets') || (data.length < 3)) {
                return data
            }
            else {
                const d = 'assets/' + (data.replace(/\\/g, '/').split('assets/')[1])
                if (!d) {
                    return data
                }
                return d;
            }
        }

        db.customBackground = checkClean(db.customBackground);
        db.userIcon = checkClean(db.userIcon);

        for (let i = 0; i < db.characters.length; i++) {
            if (db.characters[i].image) {
                db.characters[i].image = checkClean(db.characters[i].image);
            }
            if (db.characters[i].emotionImages) {
                for (let i2 = 0; i2 < db.characters[i].emotionImages.length; i2++) {
                    if (db.characters[i].emotionImages[i2] && db.characters[i].emotionImages[i2].length >= 2) {
                        db.characters[i].emotionImages[i2][1] = checkClean(db.characters[i].emotionImages[i2][1]);
                    }
                }
            }
        }

        db.formatversion = 2;
    }
    if (db.formatversion < 3) {
        for (let i = 0; i < db.characters.length; i++) {
            let cha = db.characters[i];
            if (cha.type === 'character') {
                if (checkNullish(cha.sdData)) {
                    cha.sdData = defaultSdDataFunc();
                }
            }
        }

        db.formatversion = 3;
    }
    if (db.formatversion < 4) {
        //migration removed due to issues
        db.formatversion = 4;
    }
    if (db.formatversion < 5) {
        if (db.loreBookToken < 8000) {
            db.loreBookToken = 8000;
        }
        db.formatversion = 5;
    }
    if (!db.characterOrder) {
        db.characterOrder = [];
    }
    if (db.mainPrompt === oldMainPrompt) {
        db.mainPrompt = defaultMainPrompt;
    }
    if (db.mainPrompt === oldJailbreak) {
        db.mainPrompt = defaultJailbreak;
    }
    for (let i = 0; i < db.characters.length; i++) {
        const trashTime = db.characters[i].trashTime;
        const targetTrashTime = trashTime ? trashTime + 1000 * 60 * 60 * 24 * 3 : 0;
        if (trashTime && targetTrashTime < Date.now()) {
            db.characters.splice(i, 1);
            i--;
        }
    }
    setDatabase(db);
    checkCharOrder();

    // One-pass cleanup of composer drafts whose chat no longer exists (deleted
    // chats/characters, trash purge, plugin/script removals). Replaces per-delete
    // wiring: any orphan, however it was created, is swept here at boot.
    const validDraftKeys = new Set<string>();
    for (const char of db.characters) {
        if (!char?.chaId) continue;
        for (const chat of char.chats ?? []) {
            if (chat?.id) validDraftKeys.add(chatDraftKey(char.chaId, chat.id));
        }
    }
    // Deactivated characters keep their chats server-side; their drafts stay too.
    for (const stub of db.nodeOnlyArchivedCharacters ?? []) {
        if (!stub?.chaId) continue;
        for (const id of stub.chatIds ?? []) validDraftKeys.add(chatDraftKey(stub.chaId, id));
    }
    void sweepOrphanDrafts(validDraftKeys);
}

/**
 * Purges chunks of data that are not needed.
 */
async function cleanChunks() {
    const db = getDatabase()
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'risu-auth': await forageStorage.createAuth(),
    }
    const sessionId = await forageStorage.getSessionId()
    if (sessionId) headers['x-session-id'] = sessionId

    const response = await fetch('/api/db/assets/auto-sweep', {
        method: 'POST',
        headers,
        body: JSON.stringify({ assets: db.nodeOnlyAutoCleanAssets === true }),
    })
    if (!response.ok) {
        let message = `auto-sweep failed: ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) message += ` ${body.error}`
        } catch { /* non-json error body */ }
        throw new Error(message)
    }
}


/**
 * Assigns unique IDs to characters and chats.
 */
function assignIds() {
    if (!DBState?.db?.characters) {
        return
    }
    const assignedIds = new Set<string>()
    for (let i = 0; i < DBState.db.characters.length; i++) {
        const cha = DBState.db.characters[i]
        if (!cha.chaId) {
            cha.chaId = uuidv4()
        }
        if (assignedIds.has(cha.chaId)) {
            console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
            cha.chaId = uuidv4();
        }
        assignedIds.add(cha.chaId)
        for (let i2 = 0; i2 < cha.chats.length; i2++) {
            const chat = cha.chats[i2]
            if (!chat.id) {
                chat.id = uuidv4()
            }
            if (assignedIds.has(chat.id)) {
                console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
                chat.id = uuidv4();
            }
            assignedIds.add(chat.id)
        }
    }
}
