import { get } from 'svelte/store';
import { checkNullish, decryptBuffer, encryptBuffer, selectSingleFile } from '../util';
import { changeLanguage, language } from '../../lang';
import type { RisuPlugin } from '../plugins/plugins.svelte';
import type {triggerscript as triggerscriptMain} from '../process/triggers';
import { downloadFile, saveAsset as saveImageGlobal } from '../globalApi.svelte';
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from './defaultPrompts';
import { notifySuccess } from '../alert';
import type { NAISettings } from '../process/models/nai';
import { prebuiltNAIpresets, prebuiltPresets } from '../process/templates/templates';
import { defaultColorScheme, type ColorScheme } from '../gui/colorscheme';
import type { PromptItem, PromptSettings } from '../process/prompt';
import type { OobaChatCompletionRequestParams } from '../model/ooba';
import { type HypaV3Settings, type HypaV3Preset, createHypaV3Preset } from '../process/memory/hypav3'
import { normalizeTranslatorPresetState, type TranslatorPreset } from '../translator/presets'
import { safeStructuredClone } from '../polyfill';
import { v4 as uuidv4 } from 'uuid';
import { applyModelPresetDefaults } from '../preset/dbDefaults';
import type { ApiKeyPoolEntry, ModelBindingFields, ModelBindingSet, ModelPreset, ModelPresetMigrationSummary, RegistryCache } from '../preset/types';

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = "2026.2.291" //<APP_VERSION_POINT>
export let webAppSubVer = ''
export const nodeOnlyVer: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

// 'custom' was a deprecated experimental theme (kwaroran's "not for real use now",
// 2024-10) whose select option had been hidden but still reachable through legacy
// DBs and theme presets. Coerce it to '' (NodeOnly Standard) at every entry point
// so SettingSelect's auto-normalization can't silently flip it to 'customHTML'.
export function normalizeTheme(theme: string | undefined | null): string {
    if (theme === undefined || theme === null || theme === 'custom') return ''
    return theme
}

export function setDatabase(data:Database){
    if(checkNullish(data.characters)){
        data.characters = []
    }
    if(checkNullish(data.apiType)){
        data.apiType = 'gemini-3-flash-preview'
    }
    if(checkNullish(data.openAIKey)){
        data.openAIKey = ''
    }
    if(checkNullish(data.mainPrompt)){
        data.mainPrompt = defaultMainPrompt
    }
    if(checkNullish(data.jailbreak)){
        data.jailbreak = defaultJailbreak
    }
    if(checkNullish(data.globalNote)){
        data.globalNote = ``
    }
    if(checkNullish(data.temperature)){
        data.temperature = 80
    }
    if(checkNullish(data.maxContext)){
        data.maxContext = 4000
    }
    if(checkNullish(data.maxResponse)){
        data.maxResponse = 500
    }
    if(checkNullish(data.frequencyPenalty)){
        data.frequencyPenalty = 70
    }
    if(checkNullish(data.PresensePenalty)){
        data.PresensePenalty = 70
    }
    if(checkNullish(data.aiModel)){
        data.aiModel = 'gemini-3-flash-preview'
    }
    if(checkNullish(data.jailbreakToggle)){
        data.jailbreakToggle = false
    }
    if(checkNullish(data.formatingOrder)){
        data.formatingOrder = ['main','description', 'personaPrompt','chats','lastChat','jailbreak','lorebook', 'globalNote', 'authorNote']
    }
    if(checkNullish(data.loreBookDepth)){
        data.loreBookDepth = 5
    }
    if(checkNullish(data.loreBookToken)){
        data.loreBookToken = 800
    }
    if(checkNullish(data.username)){
        data.username = 'User'
    }
    if(checkNullish(data.userIcon)){
        data.userIcon = ''
    }
    if (checkNullish(data.userNote)){
        data.userNote = ''
    }
    if(checkNullish(data.additionalPrompt)){
        data.additionalPrompt = 'The assistant must act as {{char}}. user is {{user}}.'
    }
    if(checkNullish(data.descriptionPrefix)){
        data.descriptionPrefix = 'description of {{char}}: '
    }
    if(checkNullish(data.forceReplaceUrl)){
        data.forceReplaceUrl = ''
    }
    if(checkNullish(data.language)){
        data.language = 'en'
    }
    if(checkNullish(data.swipe)){
        data.swipe = true
    }
    if(checkNullish(data.translator)){
        data.translator = ''
    }
    if(checkNullish(data.translatorMaxResponse)){
        data.translatorMaxResponse = 1000
    }
    if(checkNullish(data.currentPluginProvider)){
        data.currentPluginProvider = ''
    }
    if(checkNullish(data.plugins)){
        data.plugins = []
    }
    if(checkNullish(data.zoomsize)){
        data.zoomsize = 100
    }
    if(checkNullish(data.customBackground)){
        data.customBackground = ''
    }
    if(checkNullish(data.textgenWebUIStreamURL)){
        data.textgenWebUIStreamURL = 'wss://localhost/api/'
    }
    if(checkNullish(data.textgenWebUIBlockingURL)){
        data.textgenWebUIBlockingURL = 'https://localhost/api/'
    }
    if(checkNullish(data.autoTranslate)){
        data.autoTranslate = false
    }
    if(checkNullish(data.fullScreen)){
        data.fullScreen = false
    }
    if(checkNullish(data.playMessage)){
        data.playMessage = false
    }
    if(checkNullish(data.messageSound)){
        data.messageSound = ''
    }
    if(checkNullish(data.messageSoundVolume)){
        data.messageSoundVolume = 100
    }
    if(checkNullish(data.translateSound)){
        data.translateSound = ''
    }
    if(checkNullish(data.translateSoundVolume)){
        data.translateSoundVolume = 100
    }
    if(checkNullish(data.playMessageOnTranslateEnd)){
        data.playMessageOnTranslateEnd = false
    }
    if(checkNullish(data.customSounds)){
        data.customSounds = []
    }
    if(checkNullish(data.iconsize)){
        data.iconsize = 100
    }
    data.theme = normalizeTheme(data.theme)
    if(data.nodeOnlyStandardChatWidth !== 'standard' && data.nodeOnlyStandardChatWidth !== 'wide' && data.nodeOnlyStandardChatWidth !== 'full'){
        data.nodeOnlyStandardChatWidth = 'standard'
    }
    if(checkNullish(data.subModel)){
        data.subModel = 'gemini-3-flash-preview'
    }
    if(checkNullish(data.waifuWidth)){
        data.waifuWidth = 100
    }
    if(checkNullish(data.waifuWidth2)){
        data.waifuWidth2 = 100
    }
    if(checkNullish(data.emotionPrompt)){
        data.emotionPrompt = ""
    }
    if(checkNullish(data.proxyKey)){
        data.proxyKey = ""
    }
    if(checkNullish(data.botPresets)){
        let defaultPreset = createBotPresetTemplate()
        defaultPreset.name = "Default"
        data.botPresets = [defaultPreset]
    }
    // Ensure every botPreset has a stable string id (idempotent).
    // Required for chat binding and new model preset system; physical store
    // (db.botPresetsId index) remains the source of truth for active preset.
    if (Array.isArray(data.botPresets)) {
        for (const preset of data.botPresets) {
            if (preset && !preset.id) {
                preset.id = uuidv4()
            }
        }
    }
    if(checkNullish(data.botPresetsId)){
        data.botPresetsId = 0
    }
    if(checkNullish(data.themePresets)){
        let defaultTheme = safeStructuredClone(themePresetTemplate)
        defaultTheme.name = "Default"
        data.themePresets = [defaultTheme]
    }
    if(checkNullish(data.themePresetsId)){
        data.themePresetsId = 0
    }
    if(checkNullish(data.sdProvider)){
        data.sdProvider = ''
    }
    if(checkNullish(data.webUiUrl)){
        data.webUiUrl = 'http://127.0.0.1:7860/'
    }
    if(checkNullish(data.sdSteps)){
        data.sdSteps = 30
    }
    if(checkNullish(data.sdCFG)){
        data.sdCFG = 7
    }
    if(checkNullish(data.NAIImgUrl)){
        data.NAIImgUrl = 'https://image.novelai.net/ai/generate-image'
    }
    if(checkNullish(data.NAIApiKey)){
        data.NAIApiKey = ''
    }
    if(checkNullish(data.NAIImgModel)){
        data.NAIImgModel = 'nai-diffusion-4-5-full'
    }
    if(checkNullish(data.NAII2I)){
        data.NAII2I = false
    }
    if(checkNullish(data.NAIREF)){
        data.NAIREF = false
    }
    if(checkNullish(data.textTheme)){
        data.textTheme = "standard"
    }
    if(checkNullish(data.emotionPrompt2)){
        data.emotionPrompt2 = ""
    }
    if(checkNullish(data.requestRetrys)){
        data.requestRetrys = 2
    }
    if(checkNullish(data.useSayNothing)){
        data.useSayNothing = true
    }
    if(checkNullish(data.bias)){
        data.bias = []
    }
    if(checkNullish(data.showUnrecommended)){
        data.showUnrecommended = false
    }
    if(checkNullish(data.allowV2Plugin)){
        data.allowV2Plugin = false
    }
    if(checkNullish(data.elevenLabKey)){
        data.elevenLabKey = ''
    }
    if(checkNullish(data.voicevoxUrl)){
        data.voicevoxUrl = ''
    }
    if(checkNullish(data.showMemoryLimit)){
        data.showMemoryLimit = false
    }
    if(checkNullish(data.showFirstMessagePages)){
        data.showFirstMessagePages = false
    }
    if(checkNullish(data.voyageApiKey)){
        data.voyageApiKey = ""
    }
    if(checkNullish(data.supaMemoryKey)){
        data.supaMemoryKey = ""
    }
    if(checkNullish(data.confirmReroll)){
        data.confirmReroll = true
    }
    if(checkNullish(data.sdConfig)){
        data.sdConfig = {
            width:512,
            height:512,
            sampler_name:"Euler a",
            script_name:"",
            denoising_strength:0.7,
            enable_hr:false,
            hr_scale:1.25,
            hr_upscaler:"Latent"
        }
    }
    if(checkNullish(data.NAIImgConfig)){
        data.NAIImgConfig = {
            width:1024,
            height:1024,
            sampler:"k_euler_ancestral",
            noise_schedule:"karras",
            steps:28,
            scale:5,
            cfg_rescale: 0,
            sm:true,
            sm_dyn:false,
            noise:0.0,
            strength:0.6,
            image:"",
            base64image:"",
            InfoExtracted:1,
            //add 4
            autoSmea:false,
            legacy_uc:false,
            use_coords:false,
            v4_prompt:{
                caption:{
                    base_caption:'',
                    char_captions:[]
                },
                use_coords:false,
                use_order:true
            },
            v4_negative_prompt:{
                caption:{
                    base_caption:'',
                    char_captions:[]
                },
                legacy_uc:false,
            },
            variety_plus: false,
            decrisp: false,
            reference_mode: '',
            character_image: '',
            character_base64image: '',
            style_aware: false,
        }
    }
    //add NAI v4 (사용중인 사람용 추가 DB Init)
    if(checkNullish(data.NAIImgConfig.v4_prompt)){
        data.NAIImgConfig.autoSmea = false;
        data.NAIImgConfig.use_coords = false;
        data.NAIImgConfig.legacy_uc = false;
        data.NAIImgConfig.v4_prompt = {
            caption:{
                base_caption:"",
                char_captions:[]
            },
            use_coords:false,
            use_order:true
        };
        data.NAIImgConfig.v4_negative_prompt = {
            caption:{
                base_caption:"",
                char_captions:[]
            },
            legacy_uc:false,
        };
    }
    if(checkNullish(data.customTextTheme)){
        data.customTextTheme = {
            FontColorStandard: "#f8f8f2",
            FontColorBold: "#f8f8f2",
            FontColorItalic: "#8C8D93",
            FontColorItalicBold: "#8C8D93",
            FontColorQuote1: '#8BE9FD',
            FontColorQuote2: '#FFB86C'
        }
    }
    if(checkNullish(data.hordeConfig)){
        data.hordeConfig = {
            apiKey: "",
            model: "",
            softPrompt: ""
        }
    }
    if(checkNullish(data.novelai)){
        data.novelai = {
            token: "",
            model: "clio-v1",
        }
    }
    if(checkNullish(data.loreBook)){
        data.loreBookPage = 0
        data.loreBook = [{
            name: "My First LoreBook",
            data: []
        }]
    }
    if(checkNullish(data.loreBookPage) || data.loreBook.length < data.loreBookPage){
        data.loreBookPage = 0
    }
    data.globalscript ??= []
    data.sendWithEnter ??= true
    data.sendKeyPC ??= 'enter'
    data.sendKeyMobile ??= 'button'
    data.autoSuggestPrompt ??= defaultAutoSuggestPrompt
    data.autoSuggestPrefix ??= ""
    data.OAIPrediction ??= ''
    data.autoSuggestClean ??= true
    data.imageCompression ??= true
    data.inlayImageLossless ??= false
    data.inlayImagePriority ??= true
    data.enableBlockPartialEdit ??= false
    data.enableDragPartialEdit ??= false
    if(!data.formatingOrder.includes('personaPrompt')){
        data.formatingOrder.splice(data.formatingOrder.indexOf('main'),0,'personaPrompt')
    }
    data.selectedPersona ??= 0
    data.personaPrompt ??= ''
    data.personas ??= [{
        name: data.username,
        personaPrompt: "",
        icon: data.userIcon,
        note: data.userNote,
        largePortrait: false
    }]
    data.classicMaxWidth ??= false
    data.ooba ??= safeStructuredClone(defaultOoba)
    data.ainconfig ??= safeStructuredClone(defaultAIN)
    data.openrouterKey ??= ''
    data.openrouterRequestModel ??= 'openai/gpt-3.5-turbo'
    data.nanogptKey ??= ''
    data.nanogptRequestModel ??= ''
    data.nanogptRequestModelName ??= ''
    data.nanogptProvider ??= ''
    data.nanogptSubscriptionState ??= ''
    data.nanogptUseSubscriptionEndpoint ??= false
    data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets)
    data.assetWidth ??= -1
    data.animationSpeed ??= 0.4
    data.colorScheme ??= safeStructuredClone(defaultColorScheme)
    // Backfill `primary` for existing colorScheme objects saved before the
    // primary token was added. Without this, custom-scheme users (whose object
    // is preserved as-is) would render with an undefined CSS var.
    data.colorScheme.primary ??= defaultColorScheme.primary
    data.colorSchemeName ??= 'default'
    data.NAIsettings.starter ??= ""
    data.hypaModel ??= 'MiniLM'
    data.mancerHeader ??= ''
    data.emotionProcesser ??= 'submodel'
    data.translatorType ??= 'google'
    data.htmlTranslation ??= false
    data.deeplOptions ??= {
        key:'',
        freeApi: false
    }
    data.deeplXOptions ??= {
        url:'',
        token:''
    } 
    data.NAIadventure ??= false
    data.NAIappendName ??= true
    data.NAIsettings.cfg_scale ??= 1
    data.NAIsettings.mirostat_tau ??= 0
    data.NAIsettings.mirostat_lr ??= 1
    data.autofillRequestUrl ??= true
    data.customProxyRequestModel ??= ''
    data.generationSeed ??= -1
    data.newOAIHandle ??= true
    data.gptVisionQuality ??= 'low'
    data.huggingfaceKey ??= ''
    data.fishSpeechKey ??= ''
    data.presetRegex ??= []
    data.reverseProxyOobaArgs ??= {
        mode: 'instruct'
    }
    data.top_p ??= 1
    if(typeof(data.top_p) !== 'number'){
        //idk why type changes, but it does so this is a fix
        data.top_p = 1
    }
    //@ts-expect-error data.google has required fields (accessToken, projectId), but we use empty object as default and populate below
    data.google ??= {}
    data.google.accessToken ??= ''
    data.google.projectId ??= ''
    data.genTime ??= 1
    data.promptSettings ??= {
        assistantPrefill: '',
        postEndInnerFormat: '',
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
        customChainOfThought: false,
        maxThoughtTagDepth: -1
    }
    if (data.sdProvider === 'kei') data.sdProvider = ''
    data.top_k ??= 0
    data.promptSettings.maxThoughtTagDepth ??= -1
    data.openrouterFallback ??= true
    data.openrouterMiddleOut ??= false
    data.memoryLimitThickness ??= 1
    data.modules ??= []
    data.enabledModules ??= []
    data.additionalParams ??= []
    data.heightMode ??= 'normal'
    data.antiClaudeOverload ??= false
    data.ollamaURL ??= ''
    data.ollamaModel ??= ''
    data.autoContinueChat ??= false
    data.autoContinueMinTokens ??= 0
    data.repetition_penalty ??= 1
    data.min_p ??= 0
    data.top_a ??= 0
    data.customTokenizer ??= 'tik'
    data.instructChatTemplate ??= "chatml"
    // Migration: convert old string type into new provider object
    if (typeof data.openrouterProvider === 'string') {
        const oldProvider = data.openrouterProvider as unknown as string;
        data.openrouterProvider = {
            order: oldProvider ? [oldProvider] : [],
            only: [],
            ignore: []
        }
    }
    if (data.botPresets) {
        for (const preset of data.botPresets) {
            if (typeof preset.openrouterProvider === 'string') {
                const oldProvider = preset.openrouterProvider as unknown as string;
                preset.openrouterProvider = {
                    order: oldProvider ? [oldProvider] : [],
                    only: [],
                    ignore: []
                }
            }
        }
    }
    data.openrouterProvider ??= {
        order: [],
        only: [],
        ignore: []
    }
    data.useInstructPrompt ??= false
    data.textAreaSize ??= 0
    data.sideBarSize ??= 0
    data.textAreaTextSize ??= 0
    data.combineTranslation ??= false
    data.customPromptTemplateToggle ??= ''
    data.globalChatVariables ??= {}
    data.templateDefaultVariables ??= ''
    data.dallEQuality ??= 'standard'
    data.customTextTheme.FontColorQuote1 ??= '#8BE9FD'
    data.customTextTheme.FontColorQuote2 ??= '#FFB86C'
    data.font ??= 'default'
    data.customFont ??= ''
    data.lineHeight ??= 1.25
    data.stabilityModel ??= 'sd3-large'
    data.stabllityStyle ??= ''
    data.legacyTranslation ??= false
    data.comfyUiUrl ??= 'http://localhost:8188'
    data.comfyConfig ??= {
        workflow: '',
        posNodeID: '',
        posInputName: 'text',
        negNodeID: '',
        negInputName: 'text',
        timeout: 30
    }
    data.hideApiKey ??= true
    data.unformatQuotes ??= false
    data.ttsAutoSpeech ??= false
    data.translatorInputLanguage ??= 'auto'
    data.falModel ??= 'fal-ai/flux/dev'
    data.falLoraScale ??= 1
    data.customCSS ??= ''
    data.strictJsonSchema ??= true
    data.statics ??= {
        messages: 0,
        imports: 0
    }
    data.customQuotes ??= false
    data.customQuotesData ??= ['“','”','‘','’']
    data.groupOtherBotRole ??= 'user'
    data.customAPIFormat ??= LLMFormat.OpenAICompatible
    data.systemContentReplacement ??= `system: {{slot}}`
    data.systemRoleReplacement ??= 'user'
    data.vertexAccessToken ??= ''
    data.vertexAccessTokenExpires ??= 0
    data.vertexClientEmail ??= ''
    data.vertexPrivateKey ??= ''
    data.vertexRegion ??= 'global'
    data.seperateParametersEnabled ??= false
    data.seperateParameters ??= {
        memory: {},
        emotion: {},
        translate: {},
        otherAx: {},
        overrides: {}
    }
    data.seperateParameters.overrides ??= {}
    data.customFlags ??= []
    data.enableCustomFlags ??= false
    data.assetMaxDifference ??= 4
    data.showSavingIcon ??= false
    data.banCharacterset ??= []
    data.showPromptComparison ??= false
    data.OaiCompAPIKeys ??= {}
    data.reasoningEffort ??= 0
    data.hypaV3Presets ??= [
        createHypaV3Preset("Default", {
            summarizationPrompt: (data as any).supaMemoryPrompt || "",
            ...data.hypaV3Settings
        })
    ]
    if (data.hypaV3Presets.length > 0) {
        data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
            createHypaV3Preset(
                preset.name || `Preset ${i + 1}`,
                preset.settings || {}
            )
        )
    }
    if (data.botPresets) {
        for (const preset of data.botPresets) {
            preset.localNetworkMode ??= false
            preset.localNetworkTimeoutSec ??= 600
            if (typeof preset.localNetworkMode !== 'boolean') {
                preset.localNetworkMode = false
            }
            if (typeof preset.localNetworkTimeoutSec !== 'number' || Number.isNaN(preset.localNetworkTimeoutSec)) {
                preset.localNetworkTimeoutSec = 600
            }
        }
    }
    data.hypaV3PresetId ??= 0
    normalizeTranslatorPresetState(data)
    data.showDeprecatedTriggerV2 ??= false
    data.returnCSSError ??= true
    data.realmDirectOpen ??= false
    data.checkCorruption ??= false
    data.toggleConfirmRecommendedPreset ??= false
    data.useExperimentalGoogleTranslator ??= false
    data.thinkingType ??= 'budget'
    data.adaptiveThinkingEffort ??= 'high'
    if(data.antiClaudeOverload){ //migration
        data.antiClaudeOverload = false
        data.antiServerOverloads = true
    }
    data.hypaCustomSettings = {
        url: data.hypaCustomSettings?.url ?? "",
        key: data.hypaCustomSettings?.key ?? "",
        model: data.hypaCustomSettings?.model ?? ""     
    }
    data.doNotChangeSeperateModels ??= false
    data.seperateModelsForAxModels ??= false
    data.seperateModels ??= { memory: '', emotion: '', translate: '', otherAx: '' }
    data.modelTools ??= []
    data.enableScrollToActiveChar ??= true
    
    // Merge existing hotkeys with new default hotkeys
    if (!data.hotkeys) {
        data.hotkeys = safeStructuredClone(defaultHotkeys)
    } else {
        const existingActions = new Set(data.hotkeys.map(h => h.action))
        const newHotkeys = defaultHotkeys.filter(h => !existingActions.has(h.action))
        if (newHotkeys.length > 0) {
            data.hotkeys.push(...safeStructuredClone(newHotkeys))
        }
    }
    
    // Remove scrollToActiveChar hotkey if feature is disabled
    if (data.enableScrollToActiveChar === false) {
        data.hotkeys = data.hotkeys.filter(h => h.action !== 'scrollToActiveChar')
    }
    
    data.fallbackModels ??= {
        memory: [],
        emotion: [],
        translate: [],
        otherAx: [],
        model: []
    }
    data.fallbackModels = {
        model: data.fallbackModels.model.filter((v) => v !== ''),
        memory: data.fallbackModels.memory.filter((v) => v !== ''),
        emotion: data.fallbackModels.emotion.filter((v) => v !== ''),
        translate: data.fallbackModels.translate.filter((v) => v !== ''),
        otherAx: data.fallbackModels.otherAx.filter((v) => v !== '')
    }
    data.customModels ??= []
    data.authRefreshes ??= []
    data.rememberToolUsage ??= true
    data.simplifiedToolUse ??= false
    data.streamGeminiThoughts ??= false
    data.settingsCloseButtonSize ??= 24
    data.showModelInSidebar ??= true
    data.showPresetInSidebar ??= true
    data.showPersonaInSidebar ??= true
    data.disableMobileDragDrop ??= false
    data.disableToggleBinding ??= false
    data.hideAllImages ??= false
    data.hideMessagePageCount ??= false
    data.ImagenModel ??= 'imagen-4.0-generate-001'
    data.ImagenImageSize ??= '1K'
    data.ImagenAspectRatio ??= '1:1'
    data.ImagenPersonGeneration ??= 'allow_all'
    data.openaiCompatImage ??= {
        url: '',
        key: '',
        model: '',
        size: '1024x1024',
        quality: 'auto'
    }
    data.wavespeedImage ??= {
        key: '',
        model: '',
        loras: [],
        reference_mode: '',
        reference_image: '',
        reference_base64image: ''
    }
    data.autoScrollToNewMessage ??= true
    data.alwaysScrollToNewMessage ??= false
    data.newMessageButtonStyle ??= 'bottom-center'
    data.echoMessage ??= "Echo Message"
    data.echoDelay ??= 0
    data.createFolderOnBranch ??= true
    data.hamburgerButtonBottom ??= false
    data.hideLeftBarCollapseButton ??= false
    data.dynamicModelRegistry ??= true
    data.saveSignatures ??= false
    data.nodeOnlyScrollButtonType ??= 'four'
    data.keepSessionAlive ??= 'off'
    data.localNetworkMode ??= false
    if (typeof data.localNetworkMode !== 'boolean') data.localNetworkMode = false
    data.localNetworkTimeoutSec ??= 600
    if (typeof data.localNetworkTimeoutSec !== 'number' || Number.isNaN(data.localNetworkTimeoutSec)) data.localNetworkTimeoutSec = 600
    data.pluginCustomStorage ??= {}
    data.longPressToPopupEditor ??= false
    data.fixedChatTextarea ??= true
    applyModelPresetDefaults(data)
    changeLanguage(data.language)
    setDatabaseLite(data)
}

export function setDatabaseLite(data:Database){
    DBState.db = data
}

interface getDatabaseOptions{
    snapshot?:boolean
}

export function getDatabase(options:getDatabaseOptions = {}):Database{
    if(options.snapshot){
        return $state.snapshot(DBState.db) as Database
    }
    return DBState.db as Database
}

export function getCurrentCharacter(options:getDatabaseOptions = {}):character{
    const db = getDatabase(options)
    if(!db.characters){
        db.characters = []
    }
    const char = db.characters?.[get(selectedCharID)]
    return char
}

export function setCurrentCharacter(char:character){
    if(!DBState.db.characters){
        DBState.db.characters = []
    }
    DBState.db.characters[get(selectedCharID)] = char
}

export function getCharacterByIndex(index:number,options:getDatabaseOptions = {}):character{
    const db = getDatabase(options)
    if(!db.characters){
        db.characters = []
    }
    const char = db.characters?.[index]
    return char
}

export function setCharacterByIndex(index:number,char:character){
    if(!DBState.db.characters){
        DBState.db.characters = []
    }
    DBState.db.characters[index] = char
}

export function getCurrentChat(){
    const char = getCurrentCharacter()
    return char?.chats[char.chatPage]
}

export function setCurrentChat(chat:Chat){
    const char = getCurrentCharacter()
    char.chats[char.chatPage] = normalizeChat(chat)
    setCurrentCharacter(char)
}

// ── Prompt Option State (per-chat toggle sync) ──────────────────────

function parseToggleKeysFromTemplate(template:string){
    const keys = new Set<string>()
    for(const rawLine of template.split('\n')){
        const line = rawLine.trim()
        if(!line){
            continue
        }
        const parts = line.split('=')
        const key = parts[0]?.trim()
        const type = parts[2]?.trim()
        if(!key || type === 'group' || type === 'groupEnd' || type === 'divider' || type === 'caption'){
            continue
        }
        keys.add(`toggle_${key}`)
    }
    return Array.from(keys)
}

function getEnabledModuleDefinitions(db:Database, char:character, chat:Chat){
    const ids = [
        ...(db.enabledModules ?? []),
        ...(char.modules ?? []),
        ...(chat.modules ?? []),
        ...(db.moduleIntergration ? db.moduleIntergration.split(',').map((value) => value.trim()).filter(Boolean) : [])
    ]
    const idSet = new Set(ids)
    const seen = new Set<string>()
    const modules:RisuModule[] = []
    for(const module of db.modules ?? []){
        if(!module){
            continue
        }
        if(!idSet.has(module.id) && !(module.namespace && idSet.has(module.namespace))){
            continue
        }
        if(seen.has(module.id)){
            continue
        }
        seen.add(module.id)
        modules.push(module)
    }
    return modules
}


// ─────────────────────────────────────────────────────────────────────
// Toggle Preset
// ─────────────────────────────────────────────────────────────────────

export interface TogglePreset {
    name: string
    values: Record<string, string>   // toggle_key → value
    promptPresetName?: string        // name of the prompt preset active when saved
}

export function getToggleKeys(db:Database = getDatabase(), char:character = getCurrentCharacter(), chat:Chat = getCurrentChat()):string[]{
    const moduleToggleTemplate = getEnabledModuleDefinitions(db, char, chat)
        .map((module) => module.customModuleToggle ?? '')
        .filter(Boolean)
        .join('\n')
    return parseToggleKeysFromTemplate(`${db.customPromptTemplateToggle ?? ''}\n${moduleToggleTemplate}`)
}

export function snapshotToggleValues(db:Database = getDatabase()):Record<string, string>{
    const values:Record<string, string> = {}
    for(const [key, value] of Object.entries(db.globalChatVariables)){
        if(key.startsWith('toggle_') && value !== undefined){
            values[key] = value
        }
    }
    return values
}

export function snapshotCurrentToggleValues(db:Database = getDatabase()):Record<string, string>{
    const keys = getToggleKeys(db)
    const values:Record<string, string> = {}
    for(const key of keys){
        const value = db.globalChatVariables[key]
        if(value !== undefined){
            values[key] = value
        }
    }
    return values
}

export function applyToggleValues(values:Record<string, string>, db:Database = getDatabase()):void{
    const keys = getToggleKeys(db)
    // Apply current preset's keys (reset if not in saved values)
    for(const key of keys){
        const value = values[key]
        if(value === undefined){
            delete db.globalChatVariables[key]
            continue
        }
        db.globalChatVariables[key] = value
    }
    // Restore orphan toggle values from other presets
    for(const [key, value] of Object.entries(values)){
        if(!keys.includes(key)){
            db.globalChatVariables[key] = value
        }
    }
}

export function saveTogglesToChat():void{
    if(getDatabase().disableToggleBinding) return
    const chat = getCurrentChat()
    if(!chat) return
    chat.savedToggleValues = snapshotToggleValues()
}

export function loadTogglesFromChat(chat:Chat):void{
    if(getDatabase().disableToggleBinding) return
    if(!chat?.savedToggleValues) return
    applyToggleValues(chat.savedToggleValues)
}

// ─────────────────────────────────────────────────────────────────────

export interface DynamicOutput {
    autoAdjustSchema: boolean
    dynamicMessages: boolean
    dynamicMemory: boolean
    dynamicResponseTiming: boolean
    dynamicOutputPrompt: boolean
    showTypingEffect: boolean
    dynamicRequest: boolean
}

export interface Database{
    characters: character[],
    apiType: string
    openAIKey: string
    proxyKey:string
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel: string
    jailbreakToggle:boolean
    loreBookDepth: number
    loreBookToken: number,
    cipherChat: boolean,
    loreBook: {
        name:string
        data:loreBook[]
    }[]
    loreBookPage: number
    username: string
    userIcon: string
    userNote: string
    additionalPrompt: string
    descriptionPrefix: string
    forceReplaceUrl: string
    language: string
    translator: string
    plugins: RisuPlugin[]
    currentPluginProvider: string
    zoomsize:number
    customBackground:string
    textgenWebUIStreamURL:string
    textgenWebUIBlockingURL:string
    autoTranslate: boolean
    fullScreen:boolean
    playMessage:boolean
    /** Sound for the message-complete notification. Holds either a bundled
     * preset id (e.g. "bell") or an uploaded asset path ("assets/<hash>.mp3").
     * Empty => the default sound. Not theme-scoped. */
    messageSound:string
    /** Playback volume (0-100) for the message-complete notification. */
    messageSoundVolume:number
    /** Sound for the translation-complete notification. Same format as
     * {@link messageSound}. Empty => the default sound. */
    translateSound:string
    /** Playback volume (0-100) for the translation-complete notification. */
    translateSoundVolume:number
    /** User-uploaded notification sounds, shown alongside bundled presets in
     * the sound picker. `id` is a stable uuid (list identity / render key);
     * `path` is the "assets/<hash>" asset path (content-hashed, deduped by
     * saveAsset); `name` is the original filename for display. Not theme-scoped. */
    customSounds:{ id:string, name:string, path:string }[]
    iconsize:number
    theme: string
    nodeOnlyStandardChatWidth: 'standard' | 'wide' | 'full'
    subModel:string
    emotionPrompt: string,
    formatversion:number
    waifuWidth:number
    waifuWidth2:number
    botPresets:botPreset[]
    /**
     * @deprecated New code: use getActiveBotPreset() / setActiveBotPresetById() helpers.
     * Kept as the physical store for upstream RisuAI .bin backup compatibility.
     * Reorder/delete must go through withStableActivePreset() to keep this in sync.
     */
    botPresetsId:number
    themePresets:themePreset[]
    themePresetsId:number
    togglePresets?:TogglePreset[]
    sdProvider: string
    webUiUrl:string
    sdSteps:number
    sdCFG:number
    sdConfig:sdConfig
    NAIImgUrl:string
    NAIApiKey:string
    NAIImgModel:string
    NAII2I:boolean
    NAIREF:boolean
    NAIImgConfig:NAIImgConfig
    ttsAutoSpeech?:boolean
    promptPreprocess:boolean
    bias: [string, number][]
    swipe:boolean
    confirmReroll:boolean
    textTheme: string
    customTextTheme: {
        FontColorStandard: string,
        FontColorBold : string,
        FontColorItalic : string,
        FontColorItalicBold : string,
        FontColorQuote1 : string,
        FontColorQuote2 : string
    }
    requestRetrys:number
    emotionPrompt2:string
    useSayNothing:boolean
    didFirstSetup: boolean
    showUnrecommended:boolean
    allowV2Plugin:boolean
    elevenLabKey:string
    voicevoxUrl:string
    useExperimental:boolean
    showMemoryLimit:boolean
    roundIcons:boolean
    useStreaming:boolean
    voyageApiKey:string
    supaMemoryKey:string
    textScreenColor?:string
    textBorder?:boolean
    textScreenRounded?:boolean
    textScreenBorder?:string
    characterOrder:(string|folder)[]
    hordeConfig:hordeConfig,
    novelai:{
        token:string,
        model:string
    }
    globalscript: customscript[],
    sendWithEnter:boolean
    /** Desktop send-key mode. 'enter': Enter sends (Shift+Enter newline);
     * 'ctrl-enter'/'shift-enter': that combo sends (Enter newline);
     * 'button': only the send button (Enter newline). Replaces sendWithEnter. */
    sendKeyPC: 'enter' | 'ctrl-enter' | 'shift-enter' | 'button'
    /** Mobile send-key mode. 'button': only the send button (Enter newline);
     * 'enter': Enter sends (Shift+Enter newline). */
    sendKeyMobile: 'button' | 'enter'
    fixedChatTextarea:boolean
    clickToEdit: boolean
    enableBlockPartialEdit: boolean
    enableDragPartialEdit: boolean
    koboldURL:string
    useAutoSuggestions:boolean
    autoSuggestPrompt:string
    autoSuggestPrefix:string
    autoSuggestClean:boolean
    claudeAPIKey:string,
    useChatCopy:boolean,
    novellistAPI:string,
    useAutoTranslateInput:boolean
    imageCompression:boolean
    inlayImageLossless:boolean
    inlayImagePriority:boolean
    account?:{
        token:string
        id:string,
        data: {
            refresh_token?:string,
            access_token?:string
            expires_in?: number
        }
        useSync?:boolean
    },
    classicMaxWidth: boolean,
    useChatSticker:boolean,
    useAdditionalAssetsPreview:boolean,
    usePlainFetch:boolean
    localNetworkMode:boolean
    localNetworkTimeoutSec:number
    memoryAlgorithmType:string // To enable new memory module/algorithms
    proxyRequestModel:string
    ooba:OobaSettings
    ainconfig: AINsettings
    personaPrompt:string
    openrouterRequestModel:string
    openrouterKey:string
    openrouterMiddleOut:boolean
    nanogptKey:string
    nanogptRequestModel:string
    nanogptRequestModelName:string
    nanogptProvider:string
    nanogptSubscriptionState:string
    nanogptUseSubscriptionEndpoint:boolean
    openrouterFallback:boolean
    selectedPersona:number
    personas:{
        personaPrompt:string
        name:string
        icon:string
        largePortrait?:boolean
        id?:string
        note?:string
    }[]
    personaNote:boolean
    assetWidth:number
    animationSpeed:number
    botSettingAtStart:false
    NAIsettings:NAISettings
    hideRealm:boolean
    colorScheme:ColorScheme
    colorSchemeName:string
    promptTemplate?:PromptItem[]
    forceProxyAsOpenAI?:boolean
    hypaModel:HypaModel
    saveTime?:number
    mancerHeader:string
    emotionProcesser:'submodel'|'embedding',
    showMenuChatList?:boolean,
    translatorType:'google'|'deepl'|'none'|'llm'|'deeplX'|'bergamot',
    translatorInputLanguage?:string
    htmlTranslation?:boolean,
    NAIadventure?:boolean,
    NAIappendName?:boolean,
    deeplOptions:{
        key:string,
        freeApi:boolean
    }
    deeplXOptions:{
        url:string,
        token:string    
    }
    localStopStrings?:string[]
    autofillRequestUrl:boolean
    customProxyRequestModel:string
    generationSeed:number
    newOAIHandle:boolean
    gptVisionQuality:string
    reverseProxyOobaMode:boolean
    reverseProxyOobaArgs: OobaChatCompletionRequestParams
    huggingfaceKey:string
    fishSpeechKey:string
    allowAllExtentionFiles?:boolean
    translatorPrompt:string
    translatorMaxResponse:number
    translatorPresets: TranslatorPreset[]
    translatorPresetId: number
    top_p: number,
    google: {
        accessToken: string
        projectId: string
    }
    mistralKey?:string
    chainOfThought?:boolean
    genTime:number
    promptSettings: PromptSettings
    top_k:number
    repetition_penalty:number
    min_p:number
    top_a:number
    claudeAws:boolean
    lastPatchNoteCheckVersion?:string,
    memoryLimitThickness?:number
    modules: RisuModule[]
    enabledModules: string[]
    sideMenuRerollButton?:boolean
    requestInfoInsideChat?:boolean
    additionalParams:[string, string][]
    heightMode:string
    noWaitForTranslate:boolean
    antiClaudeOverload:boolean
    ollamaURL:string
    ollamaModel:string
    autoContinueChat:boolean
    autoContinueMinTokens:number
    removeIncompleteResponse:boolean
    customTokenizer:string
    instructChatTemplate:string
    JinjaTemplate:string
    openrouterProvider: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt:boolean
    textAreaSize:number
    sideBarSize:number
    textAreaTextSize:number
    combineTranslation:boolean
    dynamicAssets:boolean
    dynamicAssetsEditDisplay:boolean
    customPromptTemplateToggle:string
    globalChatVariables:{[key:string]:string}
    templateDefaultVariables:string
    cohereAPIKey:string
    goCharacterOnImport:boolean
    dallEQuality:string
    font: string
    customFont: string
    lineHeight: number
    stabilityModel: string
    stabilityKey: string
    stabllityStyle: string
    legacyTranslation: boolean
    comfyConfig: ComfyConfig
    comfyUiUrl: string
    useLegacyGUI: boolean
    claudeCachingExperimental: boolean
    hideApiKey: boolean
    unformatQuotes: boolean
    enableDevTools: boolean
    falToken: string
    falModel: string
    falLora: string
    falLoraName: string
    falLoraScale: number
    moduleIntergration: string
    customCSS: string
    betaMobileGUI:boolean
    jsonSchemaEnabled:boolean
    jsonSchema:string
    strictJsonSchema:boolean
    extractJson:string
    statics: {
        messages: number
        imports: number
    }
    customQuotes:boolean
    customQuotesData?:[string, string, string, string]
    groupTemplate?:string
    groupOtherBotRole?:string
    guiHTML:string
    OAIPrediction:string
    customAPIFormat:LLMFormat
    systemContentReplacement:string
    systemRoleReplacement:'user'|'assistant'
    vertexPrivateKey: string
    vertexClientEmail: string
    vertexAccessToken: string
    vertexAccessTokenExpires: number
    vertexRegion: string
    seperateParametersEnabled:boolean
    seperateParameters:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    translateBeforeHTMLFormatting:boolean
    autoTranslateCachedOnly:boolean
    lightningRealmImport:boolean
    notification: boolean
    customFlags: LLMFlags[]
    enableCustomFlags: boolean
    googleClaudeTokenizing: boolean
    presetChain: string
    legacyMediaFindings?:boolean
    geminiStream?:boolean
    assetMaxDifference:number
    auxModelUnderModelSettings:boolean
    showModelInSidebar:boolean
    showPresetInSidebar:boolean
    showPersonaInSidebar:boolean
    disableMobileDragDrop:boolean
    disableToggleBinding:boolean
    menuSideBar:boolean
    pluginV2: RisuPlugin[]
    showSavingIcon:boolean
    presetRegex: customscript[]
    banCharacterset:string[]
    showPromptComparison:boolean
    hypaV3:boolean
    hypaV3Settings: HypaV3Settings // legacy
    hypaV3Presets: HypaV3Preset[]
    hypaV3PresetId: number
    realmDirectOpen:boolean
    OaiCompAPIKeys: {[key:string]:string}
    inlayErrorResponse:boolean
    reasoningEffort:number
    bulkEnabling:boolean
    showTranslationLoading: boolean
    showDeprecatedTriggerV1:boolean
    showDeprecatedTriggerV2:boolean
    returnCSSError:boolean
    checkCorruption?: boolean
    toggleConfirmRecommendedPreset?: boolean
    useExperimentalGoogleTranslator:boolean
    thinkingTokens: number
    thinkingType: 'off' | 'budget' | 'adaptive'
    adaptiveThinkingEffort: 'low' | 'medium' | 'high' | 'max'
    antiServerOverloads: boolean
    hypaCustomSettings: {
        url: string,
        key: string,
        model: string,       
    },
    localActivationInGlobalLorebook: boolean
    showFolderName: boolean
    automaticCachePoint: boolean
    chatCompression: boolean
    claudeRetrivalCaching: boolean
    outputImageModal: boolean
    playMessageOnTranslateEnd:boolean
    seperateModelsForAxModels:boolean
    seperateModels:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    doNotChangeSeperateModels:boolean
    modelTools: string[]
    hotkeys:Hotkey[]
    fallbackModels: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    doNotChangeFallbackModels: boolean
    fallbackWhenBlankResponse: boolean
    customModels: {
        id: string
        internalId: string
        url: string
        format: LLMFormat
        tokenizer: LLMTokenizer
        key: string
        name: string
        params: string
        flags: LLMFlags[]
    }[]
    modelPresets: ModelPreset[]
    // P4 dual-regime global default binding (plan v6 §7). Copied into new chats
    // (seeding); useModelPresetByDefault seeds the new-chat regime toggle.
    useModelPresetByDefault?: boolean
    defaultModelBinding?: ModelBindingSet
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelProfileRegistryCache?: RegistryCache
    modelProfileRegistryLastFetched?: number
    // Per-profile id -> last acknowledged `updatedAt`. Drives the catalog
    // "new/updated models" notice; the user acknowledges by overwriting it
    // with the current map. See src/ts/preset/registry/notice.ts.
    modelRegistrySeen?: Record<string, number>
    // Catalog display level: hide outdated/deprecated profiles from the browser
    // and the update notice. Display-only — profiles are still downloaded.
    modelProfileVisibilityLevel?: 'all' | 'hideDeprecated' | 'currentOnly'
    // Opt-in custom registry source (dev branch / fork). Off ⇒ official URL.
    // Must be https; a non-https value is rejected at sync time.
    useCustomModelRegistry?: boolean
    modelProfileRegistryBaseUrl?: string
    igpPrompt:string
    useTokenizerCaching:boolean
    showMenuHypaMemoryModal:boolean
    authRefreshes:{
        url:string
        tokenUrl:string
        refreshToken:string
        clientId:string
        clientSecret:string
    }[]
    promptInfoInsideChat:boolean
    promptTextInfoInsideChat:boolean
    claudeBatching:boolean
    claude1HourCaching:boolean
    rememberToolUsage:boolean
    simplifiedToolUse:boolean
    requestLocation:string
    newImageHandlingBeta?: boolean
    showFirstMessagePages:boolean
    streamGeminiThoughts:boolean
    verbosity:number
    dynamicOutput?:DynamicOutput
    hubServerType?:string
    pluginCustomStorage:{[key:string]:any}
    // Best-effort "which plugin last wrote this key" sidecar for the save-file
    // plugin storage. Additive metadata only — never wraps the value itself, so
    // existing plugins read their keys unchanged. Populated for new V3 writes;
    // legacy/V2 keys stay unrecorded. See pluginStorageMeta.ts.
    pluginStorageMeta?:{[key:string]:{plugin:string,updatedAt:number}}
    longPressToPopupEditor?: boolean
    ImagenModel:string
    ImagenImageSize:string
    ImagenAspectRatio:string
    ImagenPersonGeneration:string,
    enableScrollToActiveChar:boolean
    openaiCompatImage: {
        url: string
        key: string
        model: string
        size: string
        quality: string
    }
    wavespeedImage: {
        key: string
        model: string
        loras: Array<{path: string, scale: number}>,
        reference_mode: string
        reference_image: string
        reference_base64image: string
    }
    settingsCloseButtonSize:number
    promptDiffPrefs:PromptDiffPrefs
    enableBookmark?: boolean
    hideAllImages?: boolean
    hideMessagePageCount?: boolean
    autoScrollToNewMessage?: boolean
    alwaysScrollToNewMessage?: boolean
    newMessageButtonStyle?: string
    pluginDevelopMode?: boolean
    echoMessage?:string
    echoDelay?:number
    createFolderOnBranch?:boolean
    hamburgerButtonBottom?:boolean
    hideLeftBarCollapseButton?:boolean
    enableRemoteSaving?:boolean
    blockquoteStyling?:boolean
    dynamicModelRegistry?:boolean
    nodeOnlyScrollButtonType?:'four'|'two'|'off'
    seperateParametersByModel?:boolean
    disableSeperateParameterChangeOnPresetChange?:boolean
    saveSignatures?:boolean
    keepSessionAlive: 'off' | 'pip' | 'sound'
}

export interface SeparateParameters{
    temperature?:number
    top_k?:number
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    top_p?:number
    frequency_penalty?:number
    presence_penalty?:number
    reasoning_effort?:number
    thinking_tokens?:number
    thinking_type?: 'off' | 'budget' | 'adaptive'
    adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'max'
    outputImageModal?:boolean
    verbosity?:number
}

type OutputModal = 'image'|'audio'|'video'

export interface customscript{
    comment: string;
    in:string
    out:string
    type:string
    flag?:string
    ableFlag?:boolean

}

export type triggerscript = triggerscriptMain

export interface loreBook{
    key:string
    secondkey:string
    insertorder: number
    comment: string
    content: string
    mode: 'multiple'|'constant'|'normal'|'child'|'folder',
    alwaysActive: boolean
    selective:boolean
    extentions?:{
        risu_case_sensitive:boolean
    }
    activationPercent?:number
    loreCache?:{
        key:string
        data:string[]
    },
    useRegex?:boolean
    bookVersion?:number
    id?:string
    folder?:string
}

export interface character{
    type?:"character"
    name:string
    image?:string
    firstMessage:string
    desc:string
    notes:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    viewScreen: 'emotion'|'none'|'imggen',
    bias: [string, number][]
    emotionImages: [string, string][]
    globalLore: loreBook[]
    chaId: string
    sdData: [string, string][]
    newGenData?: {
        prompt: string,
        negative: string,
        instructions: string,
        emotionInstructions: string,
    }
    customscript: customscript[]
    triggerscript: triggerscript[]
    utilityBot: boolean
    exampleMessage:string
    removedQuotes?:boolean
    creatorNotes:string
    systemPrompt:string
    postHistoryInstructions:string
    alternateGreetings:string[]
    tags:string[]
    creator:string
    characterVersion: string
    personality:string
    scenario:string
    firstMsgIndex:number
    loreSettings?:loreSettings
    loreExt?:any
    additionalData?: {
        tag?:string[]
        creator?:string
        character_version?:string
    }
    ttsMode?:string
    ttsSpeech?:string
    voicevoxConfig?:{
        speaker?: string
        SPEED_SCALE?: number
        PITCH_SCALE?: number
        INTONATION_SCALE?: number
        VOLUME_SCALE?: number
    }
    naittsConfig?:{
        customvoice?: boolean
        voice?: string
        version?: string
    }
    gptSoVitsConfig?:{
        url?:string
        use_auto_path?:boolean
        ref_audio_path?:string
        use_long_audio?:boolean
        ref_audio_data?: {
            fileName:string
            assetId:string
        }
        volume?:number
        text_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        text?:string
        use_prompt?:boolean
        prompt?:string | null
        prompt_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        top_p?:number
        temperature?:number
        speed?:number
        top_k?:number
        text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5"
    }
    fishSpeechConfig?:{
        model?: {
            _id:string
            title:string
            description:string
        },
        chunk_length:number,
        normalize:boolean,

    }
    supaMemory?:boolean
    additionalAssets?:[string, string, string][]
    ttsReadOnlyQuoted?:boolean
    replaceGlobalNote:string
    backgroundHTML?:string
    reloadKeys?:number
    backgroundCSS?:string
    license?:string
    private?:boolean
    additionalText:string
    oaiVoice?:string
    virtualscript?:string
    scriptstate?:{[key:string]:string|number|boolean}
    depth_prompt?: { depth: number, prompt: string }
    extentions?:{[key:string]:any}
    largePortrait?:boolean
    inlayViewScreen?:boolean
    hfTTS?: {
        model: string
        language: string
    },
    vits?: OnnxModelFiles
    realmId?:string
    imported?:boolean
    trashTime?:number
    nickname?:string
    source?:string[]
    group_only_greetings?:string[]
    creation_date?:number
    modification_date?:number
    ccAssets?: Array<{
        type: string
        uri: string
        name: string
        ext: string
    }>
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number
    translatorNote?:string
    doNotChangeSeperateModels?:boolean
    escapeOutput?:boolean
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    coldstorage?:string
    coldStoragedChats?:string[]
}


export interface loreSettings{
    tokenBudget: number
    scanDepth:number
    recursiveScanning: boolean
    fullWordMatching?: boolean
}


export function purgeUnsupportedGroupChats(db: Database): number {
    const before = db.characters.length
    db.characters = db.characters.filter((char): char is character => (char as any)?.type !== 'group')
    if (db.characterOrder?.length) {
        const validIds = new Set(db.characters.map((char) => char.chaId))
        const nextOrder: (string | folder)[] = []
        for (const entry of db.characterOrder) {
            if (typeof entry === 'string') {
                if (validIds.has(entry)) {
                    nextOrder.push(entry)
                }
                continue
            }
            const data = entry.data.filter((id) => validIds.has(id))
            if (data.length > 0) {
                nextOrder.push({ ...entry, data })
            }
        }
        db.characterOrder = nextOrder
    }
    return before - db.characters.length
}
export interface botPreset{
    id?: string
    name?:string
    apiType?: string
    openAIKey?: string
    localNetworkMode?: boolean
    localNetworkTimeoutSec?: number
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel?: string
    subModel?:string
    currentPluginProvider?:string
    textgenWebUIStreamURL?:string
    textgenWebUIBlockingURL?:string
    forceReplaceUrl?:string
    forceReplaceUrl2?:string
    promptPreprocess: boolean,
    bias: [string, number][]
    proxyRequestModel?:string
    openrouterRequestModel?:string
    proxyKey?:string
    ooba: OobaSettings
    ainconfig: AINsettings
    koboldURL?: string
    NAISettings?: NAISettings
    autoSuggestPrompt?: string
    autoSuggestPrefix?: string
    autoSuggestClean?: boolean
    promptTemplate?:PromptItem[]
    NAIadventure?: boolean
    NAIappendName?: boolean
    localStopStrings?: string[]
    customProxyRequestModel?: string
    reverseProxyOobaArgs?: OobaChatCompletionRequestParams
    top_p?: number
    promptSettings?: PromptSettings
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    openrouterProvider?: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt?:boolean
    customPromptTemplateToggle?:string
    templateDefaultVariables?:string
    moduleIntergration?:string
    top_k?:number
    instructChatTemplate?:string
    JinjaTemplate?:string
    jsonSchemaEnabled?:boolean
    jsonSchema?:string
    strictJsonSchema?:boolean
    extractJson?:string
    groupTemplate?:string
    groupOtherBotRole?:string
    seperateParametersEnabled?:boolean
    seperateParameters?:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    customAPIFormat?:LLMFormat
    systemContentReplacement?: string
    systemRoleReplacement?: 'user'|'assistant'
    enableCustomFlags?: boolean
    customFlags?: LLMFlags[]
    image?:string
    regex?:customscript[]
    reasonEffort?:number
    thinkingTokens?:number
    thinkingType?: 'off' | 'budget' | 'adaptive'
    adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'max'
    outputImageModal?:boolean
    seperateModelsForAxModels?:boolean
    seperateModels?:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    modelTools?:string[]
    fallbackModels?: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    fallbackWhenBlankResponse?: boolean
    verbosity?:number
    dynamicOutput?:DynamicOutput
    modelBinding?: ModelBindingFields['modelBinding']
    subModelBinding?: ModelBindingFields['subModelBinding']
    taskModelBindings?: ModelBindingFields['taskModelBindings']
}


export interface themePreset{
    name: string
    // Theme tab (submenu 0)
    theme: string
    nodeOnlyStandardChatWidth?: 'standard' | 'wide' | 'full'
    guiHTML: string
    customCSS: string
    waifuWidth: number
    waifuWidth2: number
    colorSchemeName: string
    colorScheme: ColorScheme
    textTheme: string
    customTextTheme: {
        FontColorStandard: string
        FontColorBold: string
        FontColorItalic: string
        FontColorItalicBold: string
        FontColorQuote1: string
        FontColorQuote2: string
    }
    font: string
    customFont: string
    // Size & Speed tab (submenu 1)
    zoomsize: number
    lineHeight: number
    iconsize: number
    textAreaSize: number
    textAreaTextSize: number
    sideBarSize: number
    assetWidth: number
    animationSpeed: number
    memoryLimitThickness?: number
    settingsCloseButtonSize: number
    // Others tab (submenu 2)
    showMemoryLimit: boolean
    showFirstMessagePages: boolean
    hideRealm: boolean
    hideAllImages?: boolean
    hideMessagePageCount?: boolean
    showFolderName: boolean
    customBackground: string
    roundIcons: boolean
    textScreenColor?: string
    textBorder?: boolean
    textScreenRounded?: boolean
    textScreenBorder?: string
    showSavingIcon: boolean
    showPromptComparison: boolean
    useChatCopy: boolean
    useAdditionalAssetsPreview: boolean
    useLegacyGUI: boolean
    hideApiKey: boolean
    unformatQuotes: boolean
    blockquoteStyling?: boolean
    customQuotes: boolean
    customQuotesData?: [string, string, string, string]
    betaMobileGUI: boolean
    menuSideBar: boolean
    useChatSticker: boolean
}

interface hordeConfig{
    apiKey:string
    model:string
    softPrompt:string
}

export interface folder{
    name:string
    data:string[]
    color:string
    id:string
    imgFile?:string
    img?:string
}


interface sdConfig{
    width:number
    height:number
    sampler_name:string
    script_name:string
    denoising_strength:number
    enable_hr:boolean
    hr_scale: number
    hr_upscaler:string
}

export interface NAIImgConfig{
    width:number,
    height:number,
    sampler:string,
    noise_schedule:string,
    steps:number,
    scale:number,
    cfg_rescale:number,
    sm:boolean,
    sm_dyn:boolean,
    noise:number,
    strength:number,
    image:string,
    base64image:string,
    InfoExtracted:number,
    //add 4
    autoSmea:boolean,
    use_coords:boolean,
    legacy_uc: boolean,
    v4_prompt:NAIImgConfigV4Prompt,
    v4_negative_prompt:NAIImgConfigV4NegativePrompt,
    //add vibe
    reference_image_multiple?:string[],
    reference_strength_multiple?:number[],
    vibe_data?:NAIVibeData,
    vibe_model_selection?:string
    //add variety+ and decrisp options
    variety_plus:boolean,
    decrisp:boolean,
    //add character reference
    reference_mode:string,
    character_image:string,
    character_base64image:string,
    style_aware:boolean,
}

//add 4
interface NAIImgConfigV4Prompt{
    caption: NAIImgConfigV4Caption,
    use_coords: boolean,
    use_order: boolean
}
//add 4
interface NAIImgConfigV4NegativePrompt{
    caption: NAIImgConfigV4Caption,
    legacy_uc: boolean
}
//add 4
interface NAIImgConfigV4Caption{
    base_caption: string,
    char_captions: NAIImgConfigV4CharCaption[]
}
//add 4
interface NAIImgConfigV4CharCaption{
    char_caption: string,
    centers:
        {
            x: number,
            y: number
        }[]
}

// NAI Vibe Data interfaces
interface NAIVibeData {
    identifier: string;
    version: number;
    type: string;
    image: string;
    id: string;
    encodings: {
        [key: string]: {
            [key: string]: NAIVibeEncoding;
        }
    };
    name: string;
    thumbnail: string;
    createdAt: number;
    importInfo: {
        model: string;
        information_extracted: number;
        strength: number;
    };
}

interface NAIVibeEncoding {
    encoding: string;
    params: {
        information_extracted: number;
    };
}

interface ComfyConfig{
    workflow:string,
    posNodeID: string,
    posInputName:string,
    negNodeID: string,
    negInputName:string,
    timeout: number
}

export type FormatingOrderItem = 'main'|'jailbreak'|'chats'|'lorebook'|'globalNote'|'authorNote'|'lastChat'|'description'|'postEverything'|'personaPrompt'

/**
 * Ensure a Chat object has all required fields.
 * Call at trust boundaries: after hydration, before assigning to character.chats, etc.
 */
export function normalizeChat(chat: Partial<Chat>): Chat {
    const c = chat as Chat
    if (!Array.isArray(c.message)) c.message = []
    if (typeof c.note !== 'string') c.note = ''
    if (typeof c.name !== 'string') c.name = ''
    if (!Array.isArray(c.localLore)) c.localLore = []
    return c
}

export interface Chat{
    message: Message[]
    note:string
    name:string
    localLore: loreBook[]
    sdData?:string
    suggestMessages?:string[]
    isStreaming?:boolean
    scriptstate?:{[key:string]:string|number|boolean}
    modules?:string[]
    id?:string
    bindedPersona?:string
    bindedBotPreset?:string
    fmIndex?:number
    /** Per-chat toggle to exclude the first message (greeting) from the prompt
     * context. The greeting still renders in the UI. Absent/undefined => included
     * (default). The greeting lives on the character, not in `message`, so this
     * cannot reuse the message-level `disabled` flag. */
    firstMessageDisabled?:boolean
    hypaV3Data?:SerializableHypaV3Data
    folderId?:string
    lastDate?:number
    bookmarks?: string[];
    bookmarkNames?: { [chatId: string]: string };
    supaMemory?: boolean
    savedToggleValues?: Record<string, string>
    // P4 dual-regime: per-chat model preset binding (plan v6 §7). useModelPreset
    // is the regime toggle; modelBinding (the bundle) persists across toggling so
    // it is restored on re-enable. Off (or absent) => classic global model path.
    useModelPreset?: boolean
    modelBinding?: ModelBindingSet
    /** Runtime-only: true while awaiting hydration from server. Never persisted. */
    _placeholder?: boolean
}

// `ChatStub` and `isChatStub` live in chatStub.ts so they can be unit-tested
// without loading the Svelte runtime. Re-exported here to preserve existing
// import paths across the codebase.
export type { ChatStub } from './chatStub'
export { isChatStub } from './chatStub'

export type ChatOrStub = Chat | import('./chatStub').ChatStub

export interface ChatFolder{
    id:string
    name?:string
    color?:string
    folded:boolean
}

export interface Message{
    role: 'user'|'char'
    data: string
    saying?: string
    chatId?:string
    time?: number
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    name?:string
    otherUser?:boolean
    disabled?:false|true|'allBefore'
    isComment?:boolean
    swipes?: string[]
    swipeId?: number
}

export interface MessageGenerationInfo{
    model?: string
    generationId?: string
    inputTokens?: number
    outputTokens?: number
    maxContext?: number
    stageTiming?: {
        stage1?: number
        stage2?: number
        stage3?: number
        stage4?: number
    }
}

export interface MessagePresetInfo{
    promptName?: string,
    promptToggles?: {key: string, value: string}[],
    promptText?: OpenAIChat[],
}

export interface PromptDiffPrefs {
    diffStyle: 'line' | 'intraline'
    formatStyle: 'raw' | 'card'
    viewStyle: 'unified' | 'split'
    isGrouped: boolean
    showOnlyChanges: boolean
    contextRadius: number
}

interface AINsettings{
    top_p: number,
    rep_pen: number,
    top_a: number,
    rep_pen_slope:number,
    rep_pen_range: number,
    typical_p:number
    badwords:string
    stoptokens:string
    top_k:number
}

export interface OobaSettings{
    max_new_tokens: number,
    do_sample: boolean,
    temperature: number,
    top_p: number,
    typical_p: number,
    repetition_penalty: number,
    encoder_repetition_penalty: number,
    top_k: number,
    min_length: number,
    no_repeat_ngram_size: number,
    num_beams: number,
    penalty_alpha: number,
    length_penalty: number,
    early_stopping: boolean,
    seed: number,
    add_bos_token: boolean,
    truncation_length: number,
    ban_eos_token: boolean,
    skip_special_tokens: boolean,
    top_a: number,
    tfs: number,
    epsilon_cutoff: number,
    eta_cutoff: number,
    formating:{
        header:string,
        systemPrefix:string,
        userPrefix:string,
        assistantPrefix:string
        seperator:string
        useName:boolean
    }
}


export const saveImage = saveImageGlobal

export const defaultAIN:AINsettings = {
    top_p: 0.7,
    rep_pen: 1.0625,
    top_a: 0.08,
    rep_pen_slope: 1.7,
    rep_pen_range: 1024,
    typical_p: 1.0,
    badwords: '',
    stoptokens: '',
    top_k: 140
}

export const defaultOoba:OobaSettings = {
    max_new_tokens: 180,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    typical_p: 1,
    repetition_penalty: 1.15,
    encoder_repetition_penalty: 1,
    top_k: 20,
    min_length: 0,
    no_repeat_ngram_size: 0,
    num_beams: 1,
    penalty_alpha: 0,
    length_penalty: 1,
    early_stopping: false,
    seed: -1,
    add_bos_token: true,
    truncation_length: 4096,
    ban_eos_token: false,
    skip_special_tokens: true,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    formating:{
        header: "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
        systemPrefix: "### Instruction:",
        userPrefix: "### Input:",
        assistantPrefix: "### Response:",
        seperator:"",
        useName:false,
    }
}


export const presetTemplate:botPreset = {
    id: '',
    name: "New Preset",
    apiType: "gemini-3-flash-preview",
    openAIKey: "",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: ['main', 'description', 'personaPrompt','chats','lastChat', 'jailbreak', 'lorebook', 'globalNote', 'authorNote'],
    aiModel: "gemini-3-flash-preview",
    subModel: "gemini-3-flash-preview",
    currentPluginProvider: "",
    textgenWebUIStreamURL: '',
    textgenWebUIBlockingURL: '',
    forceReplaceUrl: '',
    forceReplaceUrl2: '',
    promptPreprocess: false,
    proxyKey: '',
    bias: [],
    ooba: safeStructuredClone(defaultOoba),
    ainconfig: safeStructuredClone(defaultAIN),
    reverseProxyOobaArgs: {
        mode: 'instruct'
    },
    top_p: 1,
    useInstructPrompt: false,
    verbosity: 1
}

export const themePresetTemplate: themePreset = {
    name: "New Theme",
    theme: '',
    nodeOnlyStandardChatWidth: 'standard',
    guiHTML: '',
    customCSS: '',
    waifuWidth: 100,
    waifuWidth2: 100,
    colorSchemeName: 'default',
    colorScheme: safeStructuredClone(defaultColorScheme),
    textTheme: 'standard',
    customTextTheme: {
        FontColorStandard: "#f8f8f2",
        FontColorBold: "#f8f8f2",
        FontColorItalic: "#8C8D93",
        FontColorItalicBold: "#8C8D93",
        FontColorQuote1: '#8BE9FD',
        FontColorQuote2: '#FFB86C'
    },
    font: 'default',
    customFont: '',
    zoomsize: 120,
    lineHeight: 1.30,
    iconsize: 70,
    textAreaSize: 0,
    textAreaTextSize: 0,
    sideBarSize: 0,
    assetWidth: -1,
    animationSpeed: 0.4,
    memoryLimitThickness: 1,
    settingsCloseButtonSize: 24,
    showMemoryLimit: false,
    showFirstMessagePages: false,
    hideRealm: false,
    hideAllImages: false,
    hideMessagePageCount: false,
    showFolderName: false,
    customBackground: '',
    roundIcons: false,
    textScreenColor: null,
    textBorder: false,
    textScreenRounded: false,
    textScreenBorder: null,
    showSavingIcon: false,
    showPromptComparison: false,
    useChatCopy: false,
    useAdditionalAssetsPreview: false,
    useLegacyGUI: false,
    hideApiKey: true,
    unformatQuotes: false,
    blockquoteStyling: false,
    customQuotes: false,
    customQuotesData: ['"', '"', '\u2018', '\u2019'],
    betaMobileGUI: false,
    menuSideBar: false,
    useChatSticker: false,
}

const defaultSdData:[string,string][] = [
    ["always", "solo, 1girl"],
    ['negative', ''],
    ["|character\'s appearance", ''],
    ['current situation', ''],
    ['$character\'s pose', ''],
    ['$character\'s emotion', ''],
    ['current location', ''],
]

export const defaultSdDataFunc = () =>{
    return safeStructuredClone(defaultSdData)
}

// ─────────────────────────────────────────────────────────────
// botPreset id-based helper layer
//
// Physical storage stays index-based (db.botPresetsId: number) for upstream
// RisuAI .bin backup compatibility. New code (chat binding etc.) should use
// these helpers so reorder/delete operations stay stable: withStableActivePreset
// preserves the active preset by id while the underlying array is mutated.
// ─────────────────────────────────────────────────────────────

export function createBotPresetTemplate(): botPreset {
    const preset = safeStructuredClone(presetTemplate)
    preset.id = uuidv4()
    return preset
}

export function getActiveBotPreset(): botPreset | null {
    const db = getDatabase()
    if (!Array.isArray(db.botPresets) || db.botPresetsId < 0 || db.botPresetsId >= db.botPresets.length) {
        return null
    }
    return db.botPresets[db.botPresetsId] ?? null
}

export function getActiveBotPresetId(): string | undefined {
    return getActiveBotPreset()?.id || undefined
}

export function getBotPresetById(id: string): botPreset | null {
    const db = getDatabase()
    if (!id || !Array.isArray(db.botPresets)) return null
    return db.botPresets.find((p) => p?.id === id) ?? null
}

export function getBotPresetIndexById(id: string): number {
    const db = getDatabase()
    if (!id || !Array.isArray(db.botPresets)) return -1
    return db.botPresets.findIndex((p) => p?.id === id)
}

export function setActiveBotPresetById(id: string | undefined): void {
    const db = getDatabase()
    if (id === undefined) {
        db.botPresetsId = -1
        return
    }
    const idx = getBotPresetIndexById(id)
    if (idx >= 0) {
        db.botPresetsId = idx
    }
}

/**
 * Run a botPresets mutation (reorder / splice) while preserving which preset
 * is active by its stable string id. Replaces ad-hoc index-recalculation code
 * paths and keeps db.botPresetsId in sync with the active preset's new index.
 */
export function withStableActivePreset(fn: () => void): void {
    const activeId = getActiveBotPresetId()
    fn()
    const db = getDatabase()
    if (activeId) {
        const newIdx = getBotPresetIndexById(activeId)
        db.botPresetsId = newIdx >= 0 ? newIdx : 0
    } else if (Array.isArray(db.botPresets) && db.botPresetsId >= db.botPresets.length) {
        db.botPresetsId = Math.max(0, db.botPresets.length - 1)
    }
}

export function saveCurrentPreset(){
    let db = getDatabase()
    let pres = db.botPresets

    if(db.botPresetsId === -1){
        return
    }
    const savedPreset:botPreset =  {
        id: pres[db.botPresetsId]?.id || uuidv4(),
        name: pres[db.botPresetsId].name,
        apiType: db.apiType,
        openAIKey: db.openAIKey,
        localNetworkMode: db.localNetworkMode,
        localNetworkTimeoutSec: db.localNetworkTimeoutSec,
        mainPrompt:db.mainPrompt,
        jailbreak: db.jailbreak,
        globalNote: db.globalNote,
        temperature: db.temperature,
        maxContext: db.maxContext,
        maxResponse: db.maxResponse,
        frequencyPenalty: db.frequencyPenalty,
        PresensePenalty: db.PresensePenalty,
        formatingOrder: db.formatingOrder,
        aiModel: db.aiModel,
        subModel: db.subModel,
        currentPluginProvider: db.currentPluginProvider,
        textgenWebUIStreamURL: db.textgenWebUIStreamURL,
        textgenWebUIBlockingURL: db.textgenWebUIBlockingURL,
        forceReplaceUrl: db.forceReplaceUrl,
        promptPreprocess: db.promptPreprocess,
        bias: db.bias,
        koboldURL: db.koboldURL,
        proxyKey: db.proxyKey,
        ooba: safeStructuredClone(db.ooba),
        ainconfig: safeStructuredClone(db.ainconfig),
        proxyRequestModel: db.proxyRequestModel,
        openrouterRequestModel: db.openrouterRequestModel,
        NAISettings: safeStructuredClone(db.NAIsettings),
        promptTemplate: db.promptTemplate ?? null,
        NAIadventure: db.NAIadventure ?? false,
        NAIappendName: db.NAIappendName ?? false,
        localStopStrings: db.localStopStrings,
        autoSuggestPrompt: db.autoSuggestPrompt,
        customProxyRequestModel: db.customProxyRequestModel,
        reverseProxyOobaArgs: safeStructuredClone(db.reverseProxyOobaArgs) ?? null,
        top_p: db.top_p ?? 1,
        promptSettings: safeStructuredClone(db.promptSettings) ?? null,
        repetition_penalty: db.repetition_penalty,
        min_p: db.min_p,
        top_a: db.top_a,
        openrouterProvider: db.openrouterProvider,
        useInstructPrompt: db.useInstructPrompt,
        customPromptTemplateToggle: db.customPromptTemplateToggle ?? "",
        templateDefaultVariables: db.templateDefaultVariables ?? "",
        moduleIntergration: db.moduleIntergration ?? "",
        top_k: db.top_k,
        instructChatTemplate: db.instructChatTemplate,
        JinjaTemplate: db.JinjaTemplate ?? '',
        jsonSchemaEnabled:db.jsonSchemaEnabled??false,
        jsonSchema:db.jsonSchema ?? '',
        strictJsonSchema:db.strictJsonSchema ?? true,
        extractJson:db.extractJson ?? '',
        groupOtherBotRole: db.groupOtherBotRole ?? 'user',
        groupTemplate: db.groupTemplate ?? '',
        seperateParametersEnabled: db.seperateParametersEnabled ?? false,
        seperateParameters: safeStructuredClone(db.seperateParameters),
        customAPIFormat: safeStructuredClone(db.customAPIFormat),
        systemContentReplacement: db.systemContentReplacement,
        systemRoleReplacement: db.systemRoleReplacement,
        customFlags: safeStructuredClone(db.customFlags),
        enableCustomFlags: db.enableCustomFlags,
        regex: db.presetRegex,
        image: pres?.[db.botPresetsId]?.image ?? '',
        reasonEffort: db.reasoningEffort ?? 0,
        thinkingTokens: db.thinkingTokens ?? null,
        thinkingType: db.thinkingType ?? 'budget',
        adaptiveThinkingEffort: db.adaptiveThinkingEffort ?? 'high',
        outputImageModal: db.outputImageModal ?? false,
        seperateModelsForAxModels: false,
        seperateModels: null,
        modelTools: safeStructuredClone(db.modelTools),
        fallbackModels: safeStructuredClone(db.fallbackModels),
        fallbackWhenBlankResponse: db.fallbackWhenBlankResponse ?? false,
        verbosity: db.verbosity ?? 1,
        dynamicOutput: db.dynamicOutput ?? null
    }
    
    if(!Array.isArray(pres)){
        pres = []
    }
    //if out of bounds, create a new preset
    if(db.botPresetsId >= pres.length){
        pres.push(savedPreset)
    }
    else{
        pres[db.botPresetsId] = savedPreset
    }
    db.botPresets = pres
}

export function copyPreset(id:number){
    saveCurrentPreset()
    let db = getDatabase()
    let pres = db.botPresets
    const newPres = safeStructuredClone(pres[id])
    newPres.id = uuidv4()
    newPres.name += " Copy"
    db.botPresets.push(newPres)
}

export function changeToPreset(id =0, savecurrent = true){
    if(savecurrent){
        saveCurrentPreset()
    }
    let db = getDatabase()
    let pres = db.botPresets
    const newPres = pres[id]
    db.botPresetsId = id
    db = setPreset(db, newPres)
    const chat = getCurrentChat()
    if(chat){
        loadTogglesFromChat(chat)
    }
}

export function setPreset(db:Database, newPres: botPreset){
    db.apiType = newPres.apiType ?? db.apiType
    db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode
    db.localNetworkTimeoutSec = newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec
    db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt
    db.jailbreak = newPres.jailbreak ?? db.jailbreak
    db.globalNote = newPres.globalNote ?? db.globalNote
    db.temperature = newPres.temperature ?? db.temperature
    db.maxContext = newPres.maxContext ?? db.maxContext
    db.maxResponse = newPres.maxResponse ?? db.maxResponse
    db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty
    db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty
    db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder
    db.aiModel = newPres.aiModel ?? db.aiModel
    db.subModel = newPres.subModel ?? db.subModel
    db.currentPluginProvider = newPres.currentPluginProvider ?? db.currentPluginProvider
    db.textgenWebUIStreamURL = newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL
    db.textgenWebUIBlockingURL = newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL
    db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl
    db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess
    db.bias = newPres.bias ?? db.bias
    db.koboldURL = newPres.koboldURL ?? db.koboldURL
    db.proxyKey = newPres.proxyKey ?? db.proxyKey
    db.ooba = safeStructuredClone(newPres.ooba ?? db.ooba)
    db.ainconfig = safeStructuredClone(newPres.ainconfig ?? db.ainconfig)
    db.openrouterRequestModel = newPres.openrouterRequestModel ?? db.openrouterRequestModel
    db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel
    db.NAIsettings = newPres.NAISettings ?? db.NAIsettings
    db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt
    db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix
    db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean
    db.promptTemplate = newPres.promptTemplate
    db.NAIadventure = newPres.NAIadventure
    db.NAIappendName = newPres.NAIappendName
    db.NAIsettings.cfg_scale ??= 1
    db.NAIsettings.mirostat_tau ??= 0
    db.NAIsettings.mirostat_lr ??= 1
    db.localStopStrings = newPres.localStopStrings
    db.customProxyRequestModel = newPres.customProxyRequestModel ?? ''
    db.reverseProxyOobaArgs = safeStructuredClone(newPres.reverseProxyOobaArgs) ?? {
        mode: 'instruct'
    }
    db.top_p = newPres.top_p ?? 1
    db.promptSettings = safeStructuredClone(newPres.promptSettings) ?? {
        assistantPrefill: '',
        postEndInnerFormat: '',
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
    }
    db.promptSettings.maxThoughtTagDepth ??= -1
    db.repetition_penalty = newPres.repetition_penalty
    db.min_p = newPres.min_p
    db.top_a = newPres.top_a
    db.openrouterProvider = newPres.openrouterProvider
    db.useInstructPrompt = newPres.useInstructPrompt ?? false
    db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? ''
    db.templateDefaultVariables = newPres.templateDefaultVariables ?? ''
    db.moduleIntergration = newPres.moduleIntergration ?? ''
    db.top_k = newPres.top_k ?? db.top_k
    db.instructChatTemplate = newPres.instructChatTemplate ?? db.instructChatTemplate
    db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate
    db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false
    db.jsonSchema = newPres.jsonSchema ?? ''
    db.strictJsonSchema = newPres.strictJsonSchema ?? true
    db.extractJson = newPres.extractJson ?? ''
    db.groupOtherBotRole = newPres.groupOtherBotRole ?? 'user'
    db.groupTemplate = newPres.groupTemplate ?? ''
    db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false
    db.customAPIFormat = safeStructuredClone(newPres.customAPIFormat) ?? LLMFormat.OpenAICompatible
    db.systemContentReplacement = newPres.systemContentReplacement ?? ''
    db.systemRoleReplacement = newPres.systemRoleReplacement ?? 'user'
    db.customFlags = safeStructuredClone(newPres.customFlags) ?? []
    db.enableCustomFlags = newPres.enableCustomFlags ?? false
    db.presetRegex = newPres.regex ?? []
    db.reasoningEffort = newPres.reasonEffort ?? 0
    db.thinkingTokens = newPres.thinkingTokens ?? null
    db.thinkingType = newPres.thinkingType ?? 'budget'
    db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? 'high'
    db.outputImageModal = newPres.outputImageModal ?? false
    // Model config (separated aux models) is decoupled from prompt presets in v6:
    // switching a prompt preset no longer overwrites db.seperateModels. The global
    // db.seperateModels is the single source of truth (preset copies are inert).
    if(!db.doNotChangeFallbackModels){
        db.fallbackModels = safeStructuredClone(newPres.fallbackModels) ?? {
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
            model: []
        }
        db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false
    }
    if(db.disableSeperateParameterChangeOnPresetChange){
        db.seperateParameters = safeStructuredClone(db.seperateParameters)
    }
    else{
         db.seperateParameters = newPres.seperateParameters ? safeStructuredClone(newPres.seperateParameters) : {
            memory: {},
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {}
        }   
    }
    db.modelTools = safeStructuredClone(newPres.modelTools ?? [])
    db.verbosity = newPres.verbosity ?? 1
    db.dynamicOutput = newPres.dynamicOutput

    return db
}

// Theme preset functions

export function saveCurrentThemePreset(){
    let db = getDatabase()
    let pres = db.themePresets
    const saved: themePreset = {
        name: pres[db.themePresetsId]?.name ?? "Default",
        theme: normalizeTheme(db.theme),
        nodeOnlyStandardChatWidth: db.nodeOnlyStandardChatWidth,
        guiHTML: db.guiHTML,
        customCSS: db.customCSS,
        waifuWidth: db.waifuWidth,
        waifuWidth2: db.waifuWidth2,
        colorSchemeName: db.colorSchemeName,
        colorScheme: safeStructuredClone(db.colorScheme),
        textTheme: db.textTheme,
        customTextTheme: safeStructuredClone(db.customTextTheme),
        font: db.font,
        customFont: db.customFont,
        zoomsize: db.zoomsize,
        lineHeight: db.lineHeight,
        iconsize: db.iconsize,
        textAreaSize: db.textAreaSize,
        textAreaTextSize: db.textAreaTextSize,
        sideBarSize: db.sideBarSize,
        assetWidth: db.assetWidth,
        animationSpeed: db.animationSpeed,
        memoryLimitThickness: db.memoryLimitThickness,
        settingsCloseButtonSize: db.settingsCloseButtonSize,
        showMemoryLimit: db.showMemoryLimit,
        showFirstMessagePages: db.showFirstMessagePages,
        hideRealm: db.hideRealm,
        hideAllImages: db.hideAllImages,
        hideMessagePageCount: db.hideMessagePageCount,
        showFolderName: db.showFolderName,
        customBackground: db.customBackground,
        roundIcons: db.roundIcons,
        textScreenColor: db.textScreenColor,
        textBorder: db.textBorder,
        textScreenRounded: db.textScreenRounded,
        textScreenBorder: db.textScreenBorder,
        showSavingIcon: db.showSavingIcon,
        showPromptComparison: db.showPromptComparison,
        useChatCopy: db.useChatCopy,
        useAdditionalAssetsPreview: db.useAdditionalAssetsPreview,
        useLegacyGUI: db.useLegacyGUI,
        hideApiKey: db.hideApiKey,
        unformatQuotes: db.unformatQuotes,
        blockquoteStyling: db.blockquoteStyling,
        customQuotes: db.customQuotes,
        customQuotesData: db.customQuotesData ? [...db.customQuotesData] as [string,string,string,string] : ['"','"','\u2018','\u2019'],
        betaMobileGUI: db.betaMobileGUI,
        menuSideBar: db.menuSideBar,
        useChatSticker: db.useChatSticker,
    }
    if(!Array.isArray(pres)){
        pres = []
    }
    if(db.themePresetsId >= pres.length){
        pres.push(saved)
    } else {
        pres[db.themePresetsId] = saved
    }
    db.themePresets = pres
}

export function changeToThemePreset(id = 0, savecurrent = true){
    if(savecurrent){
        saveCurrentThemePreset()
    }
    let db = getDatabase()
    const pres = db.themePresets
    const p = pres[id]
    if(!p) return
    db.themePresetsId = id
    db.theme = normalizeTheme(p.theme ?? db.theme)
    db.nodeOnlyStandardChatWidth = p.nodeOnlyStandardChatWidth ?? db.nodeOnlyStandardChatWidth
    db.guiHTML = p.guiHTML ?? db.guiHTML
    db.customCSS = p.customCSS ?? db.customCSS
    db.waifuWidth = p.waifuWidth ?? db.waifuWidth
    db.waifuWidth2 = p.waifuWidth2 ?? db.waifuWidth2
    db.colorSchemeName = p.colorSchemeName ?? db.colorSchemeName
    db.colorScheme = safeStructuredClone(p.colorScheme ?? db.colorScheme)
    db.textTheme = p.textTheme ?? db.textTheme
    db.customTextTheme = safeStructuredClone(p.customTextTheme ?? db.customTextTheme)
    db.font = p.font ?? db.font
    db.customFont = p.customFont ?? db.customFont
    db.zoomsize = p.zoomsize ?? db.zoomsize
    db.lineHeight = p.lineHeight ?? db.lineHeight
    db.iconsize = p.iconsize ?? db.iconsize
    db.textAreaSize = p.textAreaSize ?? db.textAreaSize
    db.textAreaTextSize = p.textAreaTextSize ?? db.textAreaTextSize
    db.sideBarSize = p.sideBarSize ?? db.sideBarSize
    db.assetWidth = p.assetWidth ?? db.assetWidth
    db.animationSpeed = p.animationSpeed ?? db.animationSpeed
    db.memoryLimitThickness = p.memoryLimitThickness ?? db.memoryLimitThickness
    db.settingsCloseButtonSize = p.settingsCloseButtonSize ?? db.settingsCloseButtonSize
    db.showMemoryLimit = p.showMemoryLimit ?? db.showMemoryLimit
    db.showFirstMessagePages = p.showFirstMessagePages ?? db.showFirstMessagePages
    db.hideMessagePageCount = p.hideMessagePageCount ?? db.hideMessagePageCount
    db.hideRealm = p.hideRealm ?? db.hideRealm
    db.hideAllImages = p.hideAllImages ?? db.hideAllImages
    db.showFolderName = p.showFolderName ?? db.showFolderName
    db.customBackground = p.customBackground ?? db.customBackground
    db.roundIcons = p.roundIcons ?? db.roundIcons
    db.textScreenColor = p.textScreenColor
    db.textBorder = p.textBorder
    db.textScreenRounded = p.textScreenRounded
    db.textScreenBorder = p.textScreenBorder
    db.showSavingIcon = p.showSavingIcon ?? db.showSavingIcon
    db.showPromptComparison = p.showPromptComparison ?? db.showPromptComparison
    db.useChatCopy = p.useChatCopy ?? db.useChatCopy
    db.useAdditionalAssetsPreview = p.useAdditionalAssetsPreview ?? db.useAdditionalAssetsPreview
    db.useLegacyGUI = p.useLegacyGUI ?? db.useLegacyGUI
    db.hideApiKey = p.hideApiKey ?? db.hideApiKey
    db.unformatQuotes = p.unformatQuotes ?? db.unformatQuotes
    db.blockquoteStyling = p.blockquoteStyling ?? db.blockquoteStyling
    db.customQuotes = p.customQuotes ?? db.customQuotes
    db.customQuotesData = p.customQuotesData ? [...p.customQuotesData] as [string,string,string,string] : db.customQuotesData
    db.betaMobileGUI = p.betaMobileGUI ?? db.betaMobileGUI
    db.menuSideBar = p.menuSideBar ?? db.menuSideBar
    db.useChatSticker = p.useChatSticker ?? db.useChatSticker
}

export function copyThemePreset(id: number){
    saveCurrentThemePreset()
    let db = getDatabase()
    const newPres = safeStructuredClone(db.themePresets[id])
    newPres.name += " Copy"
    db.themePresets.push(newPres)
}

export async function downloadThemePreset(id: number, type: 'json'|'risutheme' = 'json'){
    saveCurrentThemePreset()
    let db = getDatabase()
    let pres = safeStructuredClone(db.themePresets[id])
    pres.customBackground = ''

    if(type === 'json'){
        downloadFile(pres.name + "_theme.json", Buffer.from(JSON.stringify(pres, null, 2)))
    } else {
        const buf = fflate.compressSync(encodeMsgpack({
            presetVersion: 1,
            type: 'theme',
            preset: await encryptBuffer(
                encodeMsgpack(pres),
                'risutheme'
            )
        }))
        const buf2 = await encodeRPack(buf)
        downloadFile(pres.name + "_theme.risutheme", buf2)
    }

    notifySuccess(language.successExport)
}

export async function importThemePreset(f: {
    name: string
    data: Uint8Array
} | null = null){
    if(!f){
        f = await selectSingleFile(["json", "risutheme"])
    }
    if(!f) return

    let pre: any
    if(f.name.endsWith('.risutheme')){
        let data = await decodeRPack(f.data)
        const decoded = await decodeMsgpack(fflate.decompressSync(data))
        if(decoded.presetVersion === 1 && decoded.type === 'theme'){
            pre = {
                ...safeStructuredClone(themePresetTemplate),
                ...decodeMsgpack(Buffer.from(await decryptBuffer(decoded.preset, 'risutheme')))
            }
        }
    } else {
        pre = {
            ...safeStructuredClone(themePresetTemplate),
            ...(JSON.parse(Buffer.from(f.data).toString('utf-8')))
        }
    }

    if(!pre) return

    let db = getDatabase()
    pre.name = pre.name ?? "Imported Theme"
    pre.theme = normalizeTheme(pre.theme)
    db.themePresets.push(pre)
    notifySuccess(language.successImport)
}

import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import type { OnnxModelFiles } from '../process/transformers';
import type { RisuModule } from '../process/modules';
import { decodeRPack, encodeRPack } from '../rpack/rpack_js';
import { DBState, selectedCharID } from '../stores.svelte';
import { LLMFlags, LLMFormat, LLMTokenizer } from '../model/modellist';
import type { HypaModel } from '../process/memory/hypamemory';
import type { SerializableHypaV3Data } from '../process/memory/hypav3';
import { defaultHotkeys, type Hotkey } from '../defaulthotkeys';
import type { OpenAIChat } from '../process/index.svelte';

export async function downloadPreset(id:number, type:'json'|'risupreset'|'return' = 'json'){
    saveCurrentPreset()
    let db = getDatabase()
    let pres = safeStructuredClone(db.botPresets[id])
    console.log(pres)
    pres.openAIKey = ''
    pres.forceReplaceUrl = ''
    pres.forceReplaceUrl2 = ''
    pres.proxyKey = ''
    pres.textgenWebUIStreamURL=  ''
    pres.textgenWebUIBlockingURL=  ''

    if(type === 'json'){
        downloadFile(pres.name + "_preset.json", Buffer.from(JSON.stringify(pres, null, 2)))
    }
    else if(type === 'risupreset' || type === 'return'){
        const buf = fflate.compressSync(encodeMsgpack({
            presetVersion: 2,
            type: 'preset',
            preset: await encryptBuffer(
                encodeMsgpack(pres),
                'risupreset'
            )
        }))

        const buf2 = await encodeRPack(buf)

        if(type === 'risupreset'){
            downloadFile(pres.name + "_preset.risup", buf2)
        }
        else{
            return {
                data: pres,
                buf: buf2
            }
        }

    }

    notifySuccess(language.successExport)


    return {
        data: pres,
        buf: null
    }
}


export async function importPreset(f:{
    name:string
    data:Uint8Array
}|null = null){
    if(!f){
        f = await selectSingleFile(["json", "preset", "risupreset", "risup"])
    }
    if(!f){
        return
    }
    let pre:any
    if(f.name.endsWith('.risupreset') || f.name.endsWith('.risup')){
        let data = f.data
        if(f.name.endsWith('.risup')){
            data = await decodeRPack(data)
        }
        const decoded = await decodeMsgpack(fflate.decompressSync(data))
        console.log(decoded)
        if((decoded.presetVersion === 0 || decoded.presetVersion === 2) && decoded.type === 'preset'){
            pre = {...presetTemplate,...decodeMsgpack(Buffer.from(await decryptBuffer(decoded.preset ?? decoded.pres, 'risupreset')))}
        }
    }
    else{
        pre = {...presetTemplate,...(JSON.parse(Buffer.from(f.data).toString('utf-8')))}
        console.log(pre)
    }
    let db = getDatabase()
    if(pre.presetVersion && pre.presetVersion >= 3){
        //NAI preset
        const pr = safeStructuredClone(prebuiltPresets.NAI)
        pr.temperature = pre.parameters.temperature * 100
        pr.maxResponse = pre.parameters.max_length
        pr.NAISettings.topK = pre.parameters.top_k
        pr.NAISettings.topP = pre.parameters.top_p
        pr.NAISettings.topA = pre.parameters.top_a
        pr.NAISettings.typicalp = pre.parameters.typical_p
        pr.NAISettings.tailFreeSampling = pre.parameters.tail_free_sampling
        pr.NAISettings.repetitionPenalty = pre.parameters.repetition_penalty
        pr.NAISettings.repetitionPenaltyRange = pre.parameters.repetition_penalty_range
        pr.NAISettings.repetitionPenaltySlope = pre.parameters.repetition_penalty_slope
        pr.NAISettings.frequencyPenalty = pre.parameters.repetition_penalty_frequency
        pr.NAISettings.repostitionPenaltyPresence = pre.parameters.repetition_penalty_presence
        pr.PresensePenalty = pre.parameters.repetition_penalty_presence * 100
        pr.NAISettings.cfg_scale = pre.parameters.cfg_scale
        pr.NAISettings.mirostat_lr = pre.parameters.mirostat_lr
        pr.NAISettings.mirostat_tau = pre.parameters.mirostat_tau
        pr.name = pre.name ?? "Imported"
        pr.id = uuidv4()
        db.botPresets.push(pr)
        return
    }

    if(Array.isArray(pre?.prompt_order?.[0]?.order) && Array.isArray(pre?.prompts)){
        //ST preset
        const pr = safeStructuredClone(presetTemplate)
        pr.promptTemplate = []

        function findPrompt(identifier:number){
            return pre.prompts.find((p:any) => p.identifier === identifier)
        }
        pr.temperature = (pre.temperature ?? 0.8) * 100
        pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100
        pr.PresensePenalty = (pre.presence_penalty * 0.7) * 100
        pr.top_p = pre.top_p ?? 1

        for(const prompt of pre.prompt_order[0].order){
            if(!prompt?.enabled){
                continue
            }
            const p = findPrompt(prompt?.identifier ?? '')
            if(p){
                switch(p.identifier){
                    case 'main':{
                        pr.promptTemplate.push({
                            type: 'plain',
                            type2: 'main',
                            text: p.content ?? "",
                            role: p.role ?? "system"
                        })
                        break
                    }
                    case 'jailbreak':
                    case 'nsfw':{
                        pr.promptTemplate.push({
                            type: 'jailbreak',
                            type2: 'normal',
                            text: p.content ?? "",
                            role: p.role ?? "system"
                        })
                        break
                    }
                    case 'dialogueExamples':
                    case 'charPersonality':
                    case 'scenario':{
                        break //ignore
                    }
                    case 'chatHistory':{
                        pr.promptTemplate.push({
                            type: 'chat',
                            rangeEnd: 'end',
                            rangeStart: 0
                        })
                        break
                    }
                    case 'worldInfoBefore':{
                        pr.promptTemplate.push({
                            type: 'lorebook'
                        })
                        break
                    }
                    case 'worldInfoAfter':{
                        break
                    }
                    case 'charDescription':{
                        pr.promptTemplate.push({
                            type: 'description'
                        })
                        break
                    }
                    case 'personaDescription':{
                        pr.promptTemplate.push({
                            type: 'persona'
                        })
                        break
                    }
                    default:{
                        console.log(p)
                        pr.promptTemplate.push({
                            type: 'plain',
                            type2: 'normal',
                            text: p.content ?? "",
                            role: p.role ?? "system"
                        })
                    }
                }
            }
            else{
                console.log("Prompt not found", prompt)

            }
        }
        if(pre?.assistant_prefill){
            pr.promptTemplate.push({
                type: 'postEverything'
            })
            pr.promptTemplate.push({
                type: 'plain',
                type2: 'main',
                text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
                role: 'bot'
            })
        }
        pr.name = "Imported ST Preset"
        pr.id = uuidv4()
        db.botPresets.push(pr)
        return
    }
    pre.name ??= "Imported"
    pre.id = uuidv4()
    if(!Array.isArray(db.botPresets)){
        db.botPresets = []
    }
    db.botPresets.push(pre)
}
