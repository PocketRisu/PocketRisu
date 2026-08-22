/**
 * Settings Search Manifest
 *
 * Search entries for settings pages/sections that are NOT declaratively
 * defined (i.e. hardcoded Svelte pages that don't go through
 * SettingRenderer). Declarative pages are indexed automatically from their
 * SettingItem arrays in searchIndex.ts — do not duplicate them here except
 * as coarse page-level entries when useful.
 *
 * ⚠️ MAINTENANCE: when adding a new settings page, sub-tab, or a new
 * provider/section inside a hardcoded page (especially OtherBotSettings),
 * add a matching entry here so it stays findable in settings search.
 * See also: Settings.svelte sidebar menu, src/ts/routing.ts (SettingsRoute).
 *
 * Labels are lazy (() => string) because `language` is swapped at runtime
 * when the UI locale changes. Keywords should include both English and
 * Korean where a term is commonly searched.
 */

import { language } from 'src/lang';
import { SettingsRoute, SystemTab, type SettingsRouteValue } from '../routing';

export interface ManualSearchEntry {
    /** Unique id, prefixed with 'manual.' */
    id: string;
    label: () => string;
    /** Optional secondary line shown under the label */
    help?: () => string;
    keywords: string[];
    route: SettingsRouteValue;
    subTab?: number;
}

export const searchManifestEntries: ManualSearchEntry[] = [
    // ── ChatBot page (hardcoded sub-tabs; the Parameters tab is indexed
    //    declaratively from allBasicParameterItems)
    {
        id: 'manual.chatbot.model',
        label: () => language.model,
        keywords: ['ai model', 'api key', 'provider', 'openai', 'claude', 'gemini', 'openrouter', 'ooba', '모델', 'api 키'],
        route: SettingsRoute.ChatBot,
        subTab: 0,
    },
    {
        // Separate Parameters section — custom-rendered below the declarative
        // parameter items on the Parameters tab, so it needs a manual entry.
        id: 'manual.chatbot.separateParameters',
        label: () => language.seperateParameters,
        keywords: ['separate parameters', 'memory temperature', 'emotion', 'translate', '파라미터 분리'],
        route: SettingsRoute.ChatBot,
        subTab: 1,
    },
    {
        id: 'manual.chatbot.customModels',
        label: () => language.customModels,
        keywords: ['custom model', 'local model', 'endpoint', '커스텀 모델', '로컬 모델'],
        route: SettingsRoute.ChatBot,
        subTab: 2,
    },

    // ── Other Bots page (fully hardcoded; ~250 provider fields — indexed at
    //    sub-tab granularity. When upstream adds a new provider, append its
    //    name to the keywords of the matching sub-tab.)
    {
        id: 'manual.otherbots.longTermMemory',
        label: () => language.longTermMemory,
        keywords: ['memory', 'supamemory', 'hypamemory', 'hypa', 'embedding', '기억', '장기기억', '메모리'],
        route: SettingsRoute.OtherBots,
        subTab: 0,
    },
    {
        id: 'manual.otherbots.tts',
        label: () => 'TTS',
        keywords: ['tts', 'voice', 'speech', 'elevenlabs', 'novelai tts', '음성', '보이스', '낭독'],
        route: SettingsRoute.OtherBots,
        subTab: 1,
    },
    {
        id: 'manual.otherbots.emotionImage',
        label: () => language.emotionImage,
        keywords: ['emotion', 'expression', '감정', '표정 이미지'],
        route: SettingsRoute.OtherBots,
        subTab: 2,
    },
    {
        id: 'manual.otherbots.imageGeneration',
        label: () => language.imageGeneration,
        keywords: [
            'image generation', 'stable diffusion', 'webui', 'novelai', 'dalle', 'dall-e',
            'stability', 'fal', 'comfyui', 'imagen', 'openai compatible', 'wavespeed',
            '이미지 생성', '그림',
        ],
        route: SettingsRoute.OtherBots,
        subTab: 3,
    },

    // ── Page-name entries: make every sidebar menu findable by its own
    //    name (declarative pages index their *items*, not the page itself)
    {
        id: 'manual.page.chatBot',
        label: () => language.chatBot,
        keywords: ['chatbot', 'ai', '챗봇'],
        route: SettingsRoute.ChatBot,
    },
    {
        id: 'manual.page.display',
        label: () => language.display,
        keywords: ['display', 'theme', 'appearance', '디스플레이', '화면', '테마'],
        route: SettingsRoute.Display,
    },
    {
        id: 'manual.page.accessibility',
        label: () => language.accessibility,
        keywords: ['accessibility', '접근성', '편의'],
        route: SettingsRoute.Accessibility,
    },
    {
        id: 'manual.page.advanced',
        label: () => language.advancedSettings,
        keywords: ['advanced', 'developer', '고급'],
        route: SettingsRoute.Advanced,
    },
    {
        id: 'manual.page.language',
        label: () => language.language,
        keywords: ['language', 'translation', 'translator', '언어', '번역'],
        route: SettingsRoute.Language,
    },
    {
        id: 'manual.page.soundAndNotification',
        label: () => language.soundAndNotification,
        keywords: ['sound', 'notification', 'volume', 'alarm', '소리', '알림', '효과음', '볼륨'],
        route: SettingsRoute.SoundAndNotification,
    },
    {
        id: 'manual.page.prompt',
        label: () => language.promptTemplate,
        keywords: ['prompt', 'main prompt', 'jailbreak', 'global note', '프롬프트'],
        route: SettingsRoute.Prompt,
    },
    {
        id: 'manual.page.promptPreset',
        label: () => language.promptPresetMenu,
        keywords: ['prompt preset', '프롬프트 프리셋'],
        route: SettingsRoute.PromptPreset,
    },
    {
        id: 'manual.page.inlayImageGallery',
        label: () => language.playground.inlayImageGallery,
        keywords: ['inlay', 'image gallery', '인레이', '이미지 갤러리'],
        route: SettingsRoute.InlayImageGallery,
    },

    // ── Standalone hardcoded pages
    {
        id: 'manual.page.migration',
        label: () => language.migration,
        keywords: ['migration', 'import', 'export', 'backup', 'restore', '이전', '백업', '가져오기', '내보내기'],
        route: SettingsRoute.Migration,
    },
    {
        id: 'manual.page.plugin',
        label: () => language.plugin,
        keywords: ['plugin', '플러그인'],
        route: SettingsRoute.Plugin,
    },
    {
        id: 'manual.page.globalLoreBook',
        label: () => language.loreBook,
        keywords: ['lorebook', 'world info', '로어북', '월드인포'],
        route: SettingsRoute.GlobalLoreBook,
    },
    {
        id: 'manual.page.globalRegex',
        label: () => language.regexScript,
        keywords: ['regex', 'regexp', '정규식', '정규표현식'],
        route: SettingsRoute.GlobalRegex,
    },
    {
        id: 'manual.page.persona',
        label: () => language.persona,
        keywords: ['persona', 'user icon', 'user name', '페르소나', '유저 이름'],
        route: SettingsRoute.Persona,
    },
    {
        id: 'manual.page.module',
        label: () => language.modules,
        keywords: ['module', '모듈'],
        route: SettingsRoute.Module,
    },
    {
        id: 'manual.page.hotkey',
        label: () => language.hotkey,
        keywords: ['hotkey', 'shortcut', 'keyboard', '단축키', '핫키'],
        route: SettingsRoute.Hotkey,
    },
    {
        id: 'manual.page.modelPreset',
        label: () => language.modelPresetMenu,
        keywords: ['model preset', 'preset', '모델 프리셋', '프리셋'],
        route: SettingsRoute.ModelPreset,
    },
    {
        // Tab-name entry. The tab's settings are indexed declaratively
        // (moduleModelBindingItems), but a tab label is only breadcrumb text
        // there — without this, searching the name shown on the tab finds nothing.
        id: 'manual.modelPreset.moduleBinding',
        label: () => language.modelPresetTabModules,
        help: () => language.help.moduleModelBindingEnable,
        keywords: ['module binding', 'per-module', 'module', 'lua', 'trigger', 'script', '모듈 분리 바인딩', '모듈분리바인딩', '모듈 바인딩', '모듈별', '분리', '바인딩'],
        route: SettingsRoute.ModelPreset,
        subTab: 3,
    },
    {
        id: 'manual.page.remoteAccess',
        label: () => language.remoteAccess,
        keywords: ['remote', 'network', 'share', 'tailscale', 'lan', '원격', '원격 접속', '공유'],
        route: SettingsRoute.RemoteAccess,
    },

    // ── System page sub-tabs
    {
        id: 'manual.system.dashboard',
        label: () => language.systemDashboard,
        keywords: ['dashboard', 'storage', 'disk', 'database size', '대시보드', '용량'],
        route: SettingsRoute.System,
        subTab: SystemTab.Dashboard,
    },
    {
        id: 'manual.system.backups',
        label: () => language.systemBackups,
        keywords: ['backup', 'snapshot', 'restore', '백업', '복원'],
        route: SettingsRoute.System,
        subTab: SystemTab.Backups,
    },
    {
        id: 'manual.system.backups.settingsOnly',
        label: () => language.backupSettingsOnly,
        help: () => language.backupSettingsOnlyDesc,
        keywords: [
            'settings only', 'settings backup', 'seed', 'new instance', 'migrate settings',
            'export settings', 'without characters',
            '설정만', '설정 백업', '설정 내보내기', '시드', '새 인스턴스', '인스턴스',
        ],
        route: SettingsRoute.System,
        subTab: SystemTab.Backups,
    },
    {
        id: 'manual.system.logs',
        label: () => language.systemLogs,
        keywords: ['log', 'error log', 'debug', '로그', '오류'],
        route: SettingsRoute.System,
        subTab: SystemTab.Logs,
    },
    {
        id: 'manual.system.requestLogs',
        label: () => language.requestLogsTab,
        keywords: ['request log', 'prompt', 'response', 'api call', '리퀘스트 로그', '요청 기록', '프롬프트'],
        route: SettingsRoute.System,
        subTab: SystemTab.RequestLogs,
    },
    {
        id: 'manual.system.usage',
        label: () => language.usageTab,
        keywords: ['usage', 'token', 'statistics', 'cost', '사용량', '토큰', '통계'],
        route: SettingsRoute.System,
        subTab: SystemTab.Usage,
    },
    {
        id: 'manual.system.pluginStorage',
        label: () => language.pluginStorageTab,
        keywords: ['plugin storage', '플러그인 저장소'],
        route: SettingsRoute.System,
        subTab: SystemTab.PluginStorage,
    },
];
