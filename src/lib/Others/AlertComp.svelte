<script lang="ts">
    import { alertGenerationInfoStore } from "../../ts/alert";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { getCharImage } from '../../ts/characters';
    import { ParseMarkdown } from '../../ts/parser/parser.svelte';
    import BarIcon from '../SideBars/BarIcon.svelte';
    import { ChevronRightIcon, User } from '@lucide/svelte';
    import { hubURL, isCharacterHasAssets } from 'src/ts/characterCards';
    import TextInput from '../UI/GUI/TextInput.svelte';
    import { aiLawApplies, openURL, downloadFile } from 'src/ts/globalApi.svelte';
    import Button from '../UI/GUI/Button.svelte';
    import ShDialog from '../UI/GUI/ShDialog.svelte';
    import ShAlertDialog from '../UI/GUI/ShAlertDialog.svelte';
    import ShLoadingDialog from '../UI/GUI/ShLoadingDialog.svelte';
    import ShButton from '../UI/GUI/ShButton.svelte';
    import { XIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, CheckIcon, PencilIcon, TrashIcon, EllipsisVerticalIcon, RefreshCwIcon, PlusIcon, DownloadIcon, UploadIcon } from "@lucide/svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import { language } from 'src/lang';
    import { fetchRequestLogs, type RequestLogEntry } from 'src/ts/requestLog';
    import { alertStore, selectedCharID, togglePresetsOpenStore } from "src/ts/stores.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import ShDropdownMenu from '../UI/GUI/ShDropdownMenu.svelte';
    import ShDropdownMenuTrigger from '../UI/GUI/ShDropdownMenuTrigger.svelte';
    import ShDropdownMenuContent from '../UI/GUI/ShDropdownMenuContent.svelte';
    import ShDropdownMenuItem from '../UI/GUI/ShDropdownMenuItem.svelte';
    import ShDropdownMenuSeparator from '../UI/GUI/ShDropdownMenuSeparator.svelte';
    import { nodeOnlyVer } from "src/ts/storage/database.svelte";
    import { tokenize } from "src/ts/tokenizer";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme";
    import Help from "./Help.svelte";
    import { getChatBranches } from "src/ts/gui/branches";
    import { getCurrentCharacter, type TogglePreset, applyToggleValues, snapshotCurrentToggleValues } from "src/ts/storage/database.svelte";
    import { alertInput, alertConfirm, alertError, alertNormalWait, notifySuccess } from "src/ts/alert";
    import { selectSingleFile } from "src/ts/util";
    import { translateStackTrace } from "../../ts/sourcemap";
    import { getDetailedOSLabel, getFallbackOSLabel, getRisuEnvironmentLabel } from "src/ts/platform";

    let showDetails = $state(false);
    let translatedStackTrace = $state('');
    let stackTraceTranslationFailed = $state(false);
    let isTranslating = $state(false);
    let osLabel = $state(getFallbackOSLabel());
    const displayedStackTrace = $derived(translatedStackTrace || $alertStore.stackTrace || '');
    const risuEnvironment = getRisuEnvironmentLabel();
    const userAgent = typeof navigator === "undefined" ? "Unknown" : navigator.userAgent || "Unknown";
    const stackTraceCodeBlock = $derived.by(() => {
        const lines = [
            `PocketRisu v${nodeOnlyVer}`,
            `OS: ${osLabel}`,
            `User-Agent: ${userAgent}`,
            `Risu environment: ${risuEnvironment}`,
        ]

        if (stackTraceTranslationFailed) {
            lines.push(language.stackTraceTranslationFailed)
        } else if (isTranslating) {
            lines.push(language.translating)
        }

        if (displayedStackTrace) {
            lines.push('', displayedStackTrace)
        }

        return lines.join('\n')
    });

    let btn
    let input = $state('')
    let cardExportType = $state('realm')
    let cardExportType2 = $state('')
    let cardLicense = $state('')
    let generationInfoMenuIndex = $state(0)
    let branchHover:null|{
        x:number,
        y:number,
        content:string,
    } = $state(null)
    // Branch tree rows: y=0 is the greeting (not part of chat.message), the
    // rest map to message[y-1]. Indexing message[-1] for the first row threw
    // a TypeError on every hover.
    function branchNodeContent(obj: { chatId: number, y: number }): string {
        const char = getCurrentCharacter()
        const chat = char.chats[obj.chatId]
        if(obj.y === 0){
            return (chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings?.[chat.fmIndex ?? 0]) ?? ''
        }
        return chat.message[obj.y - 1]?.data ?? ''
    }
    let copiedKey: string | null = $state(null)
    let togglePresetShowAll = $state(false)

    function closeTogglePresets() {
        togglePresetsOpenStore.set(false)
    }

    async function copyToClipboard(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            // fallback
            const textarea = document.createElement('textarea')
            textarea.value = text
            document.body.appendChild(textarea)
            textarea.select()
            document.execCommand('copy')
            document.body.removeChild(textarea)
        }
        copiedKey = key
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null
        }, 1500)
    }
    $effect.pre(() => {
        showDetails = false;
        translatedStackTrace = '';
        stackTraceTranslationFailed = false;
        isTranslating = false;
        if(btn){
            btn.focus()
        }
        if($alertStore.type !== 'input'){
            input = ''
        } else {
            input = $alertStore.defaultValue ?? ''
        }
        if($alertStore.type !== 'branches'){
            branchHover = null
        }
        if($alertStore.type !== 'cardexport'){
            cardExportType = ''
            cardExportType2 = ''
            cardLicense = ''
        }
    });

    $effect(() => {
        if ($alertStore.type === 'error' && $alertStore.stackTrace && !translatedStackTrace && !stackTraceTranslationFailed && !isTranslating) {
            void loadTranslatedTrace();
        }
    });

    $effect(() => {
        void loadDetailedOSLabel();
    });

    async function loadDetailedOSLabel() {
        try {
            osLabel = await getDetailedOSLabel();
        } catch (error) {
            console.warn("Failed to load detailed OS information:", error);
        }
    }

    async function loadTranslatedTrace() {
        if (isTranslating || translatedStackTrace || stackTraceTranslationFailed || !$alertStore.stackTrace) return;
        isTranslating = true;
        try {
            const result = await translateStackTrace($alertStore.stackTrace);
            if (result.didTranslate) {
                translatedStackTrace = result.stackTrace;
            } else {
                stackTraceTranslationFailed = true;
            }
        } catch (e) {
            console.error("Failed to translate stack trace:", e);
            stackTraceTranslationFailed = true;
        } finally {
            isTranslating = false;
        }
    }

    async function loadMessageRequestLog(generationId: string): Promise<RequestLogEntry | null> {
        if (!generationId || generationId === 'none') return null
        const rows = await fetchRequestLogs({ chatId: generationId, limit: 1, bodies: true })
        return rows[0] ?? null
    }

    const beautifyJSON = (data:string) =>{
        try {
            return JSON.stringify(JSON.parse(data), null, 2)
        } catch (error) {
            return data
        }
    }
</script>

<svelte:window onmessage={async (e) => {
    if(e.origin.startsWith("https://sv.risuai.xyz") || e.origin.startsWith("https://nightly.sv.risuai.xyz") || e.origin.startsWith("http://127.0.0.1") || e.origin === window.location.origin){
        if(e.data.msg?.data?.vaild && $alertStore.type === 'login'){
            $alertStore = {
                type: 'none',
                msg: JSON.stringify(e.data.msg)
            }
        }
    }
}}></svelte:window>

{#if $alertStore.type !== 'none' &&  $alertStore.type !== 'cardexport' && $alertStore.type !== 'branches' && $alertStore.type !== 'selectModule' && $alertStore.type !== 'pukmakkurit' && $alertStore.type !== 'error' && $alertStore.type !== 'normal' && $alertStore.type !== 'markdown' && $alertStore.type !== 'ask' && $alertStore.type !== 'pluginconfirm' && $alertStore.type !== 'tos' && $alertStore.type !== 'input' && $alertStore.type !== 'select' && $alertStore.type !== 'wait' && $alertStore.type !== 'wait2' && $alertStore.type !== 'progress' && $alertStore.type !== 'confirmMulti'}
    <div class="absolute w-full h-full z-50 bg-black/50 flex justify-center items-center">
        <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl  max-h-full overflow-y-auto">
            {#if $alertStore.type === 'selectChar'}
                <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">Select</h2>
            {/if}
            {#if $alertStore.type !== 'requestdata' && $alertStore.type !== 'addchar'}
                <span class="text-gray-300 whitespace-pre-wrap">{$alertStore.msg}</span>
                {#if $alertStore.submsg}
                    <span class="text-gray-500 text-sm">{$alertStore.submsg}</span>
                {/if}
            {/if}

            {#if $alertStore.type === 'login'}
                <div class="fixed top-0 left-0 bg-black/50 w-full h-full flex justify-center items-center">
                    <iframe src={hubURL + '/hub/login'} title="login" class="w-full h-full">
                    </iframe>
                </div>
            {:else if $alertStore.type === 'selectChar'}
                <div class="flex w-full items-start flex-wrap gap-2 justify-start">
                    {#each DBState.db.characters as char, i}
                        {#if char.image}
                            {#await getCharImage(DBState.db.characters[i].image, 'css')}
                                <BarIcon onClick={() => {
                                    alertStore.set({type: 'none',msg: char.chaId})
                                }}>
                                    <User/>
                                </BarIcon>
                            {:then im} 
                                <BarIcon onClick={() => {
                                    alertStore.set({type: 'none',msg: char.chaId})
                                }} additionalStyle={im} />
                                
                            {/await}
                        {:else}
                            <BarIcon onClick={() => {
                                alertStore.set({type: 'none',msg: char.chaId})
                            }}>
                            <User/>
                            </BarIcon>
                        {/if}
                    {/each}
                </div>
            {:else if $alertStore.type === 'requestdata'}
                {#if aiLawApplies()}
                <div>
                    {language.generatedByAIDisclaimer}
                </div>
                {/if}
                <div class="flex flex-wrap gap-2">
                    <Button selected={generationInfoMenuIndex === 0} size="sm" onclick={() => {generationInfoMenuIndex = 0}}>
                        {language.tokens}
                    </Button>
                    <Button selected={generationInfoMenuIndex === 1} size="sm" onclick={() => {generationInfoMenuIndex = 1}}>
                        {language.metaData}
                    </Button>
                    <Button selected={generationInfoMenuIndex === 2} size="sm" onclick={() => {generationInfoMenuIndex = 2}}>
                        {language.log}
                    </Button>
                    <Button selected={generationInfoMenuIndex === 3} size="sm" onclick={() => {generationInfoMenuIndex = 3}}>
                        {language.prompt}
                    </Button>
                    <button class="ml-auto" onclick={() => {
                        alertStore.set({
                            type: 'none',
                            msg: ''
                        })
                    }}>✖</button>
                </div>
                {#if generationInfoMenuIndex === 0}
                    <!-- Recovered messages from older jobs can lack maxContext
                         (and tokens); fall back to 0% instead of a NaN% gradient. -->
                    {@const graphMaxContext = $alertGenerationInfoStore.genInfo.maxContext ?? 0}
                    {@const graphInputPct = graphMaxContext > 0 ? (($alertGenerationInfoStore.genInfo.inputTokens ?? 0) / graphMaxContext) * 100 : 0}
                    {@const graphTotalPct = graphMaxContext > 0 ? ((($alertGenerationInfoStore.genInfo.outputTokens ?? 0) + ($alertGenerationInfoStore.genInfo.inputTokens ?? 0)) / graphMaxContext) * 100 : 0}
                    <div class="mt-4 flex justify-center w-full">
                        <div class="w-32 h-32 border-darkborderc border-4 rounded-lg" style:background={
                            `linear-gradient(0deg,
                            rgb(59,130,246) 0%,
                            rgb(59,130,246) ${graphInputPct}%,
                            rgb(34 197 94) ${graphInputPct}%,
                            rgb(34 197 94) ${graphTotalPct}%,
                            rgb(156 163 175) ${graphTotalPct}%,
                            rgb(156 163 175) 100%)`
                        }>

                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                        <span class="text-blue-500">{language.inputTokens}</span>
                        <span class="text-blue-500 justify-self-end">{$alertGenerationInfoStore.genInfo.inputTokens ?? '?'} {language.tokens}</span>
                        <span class="text-green-500">{language.outputTokens}</span>
                        <span class="text-green-500 justify-self-end">{$alertGenerationInfoStore.genInfo.outputTokens ?? '?'} {language.tokens}</span>
                        <span class="text-gray-400">{language.maxContextSize}</span>
                        <span class="text-gray-400 justify-self-end">{$alertGenerationInfoStore.genInfo.maxContext ?? '?'} {language.tokens}</span>
                    </div>
                    <span class="text-textcolor2 text-sm">{language.tokenWarning}</span>
                {/if}
                {#if generationInfoMenuIndex === 1}
                <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                    <span class="text-blue-500">Index</span>
                    <span class="text-blue-500 justify-self-end">{$alertGenerationInfoStore.idx}</span>
                    <span class="text-amber-500">Model</span>
                    <span class="text-amber-500 justify-self-end">{$alertGenerationInfoStore.genInfo.model}</span>
                    {#if $alertGenerationInfoStore.genInfo.modelId}
                        <span class="text-amber-500">Model ID</span>
                        <span class="text-amber-500 justify-self-end">{$alertGenerationInfoStore.genInfo.modelId}</span>
                    {/if}
                    <span class="text-green-500">ID</span>
                    <span class="text-green-500 justify-self-end">{DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].chatId ?? "None"}</span>
                    <span class="text-red-500">GenID</span>
                    <span class="text-red-500 justify-self-end">{$alertGenerationInfoStore.genInfo.generationId}</span>
                    <span class="text-cyan-500">Saying</span>
                    <span class="text-cyan-500 justify-self-end">{DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].saying}</span>
                    <span class="text-purple-500">Size</span>
                    <span class="text-purple-500 justify-self-end">{JSON.stringify(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx]).length} Bytes</span>
                    <span class="text-yellow-500">Time</span>
                    <span class="text-yellow-500 justify-self-end">{(new Date(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].time ?? 0)).toLocaleString()}</span>
                    {#if $alertGenerationInfoStore.genInfo.stageTiming}
                        {@const stage1 = parseFloat(((($alertGenerationInfoStore.genInfo.stageTiming.stage1 ?? 0) / 1000).toFixed(1)))}
                        {@const stage2 = parseFloat(((($alertGenerationInfoStore.genInfo.stageTiming.stage2 ?? 0) / 1000).toFixed(1)))}
                        {@const stage3 = parseFloat(((($alertGenerationInfoStore.genInfo.stageTiming.stage3 ?? 0) / 1000).toFixed(1)))}
                        {@const stage4 = parseFloat(((($alertGenerationInfoStore.genInfo.stageTiming.stage4 ?? 0) / 1000).toFixed(1)))}
                        {@const totalRounded = (stage1 + stage2 + stage3 + stage4).toFixed(1)}
                        <span class="text-gray-400">Timing</span>
                        <span class="text-gray-400 justify-self-end">
                            <span style="color: #60a5fa;">{stage1}</span> + 
                            <span style="color: #db2777;">{stage2}</span> + 
                            <span style="color: #34d399;">{stage3}</span> + 
                            <span style="color: #8b5cf6;">{stage4}</span> = 
                            <span class="text-white font-bold">{totalRounded}s</span>
                        </span>
                    {/if}

                    <span class="text-green-500">Tokens</span>
                    {#await tokenize(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].data)}
                        <span class="text-green-500 justify-self-end">Loading</span>
                    {:then tokens} 
                        <span class="text-green-500 justify-self-end">{tokens}</span>
                    {/await}
                </div>
                {/if}
                {#if generationInfoMenuIndex === 2}
                    {#await loadMessageRequestLog($alertStore.msg)}
                        <span class="text-gray-500 mt-2">{language.loading}</span>
                    {:then data}
                        {#if !data}
                            <span class="text-gray-300 text-lg mt-2">{language.errors.requestLogRemoved}</span>
                            <span class="text-gray-500">{language.errors.requestLogRemovedDesc}</span>
                        {:else}
                            <h1 class="text-2xl font-bold my-4">URL</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap">{data.url}</code>
                            {#if data.durationMs !== undefined && data.durationMs !== null}
                                <h1 class="text-2xl font-bold my-4">{language.requestLogsDuration}</h1>
                                <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap">{(data.durationMs / 1000).toFixed(2)}s{data.firstTokenMs ? ` (${language.requestLogsFirstToken}: ${(data.firstTokenMs / 1000).toFixed(2)}s)` : ''}</code>
                            {/if}
                            <h1 class="text-2xl font-bold my-4">Request Body</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap">{beautifyJSON(data.requestBody ?? '')}</code>
                            <h1 class="text-2xl font-bold my-4">Response</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap">{beautifyJSON(data.responseBody ?? '')}</code>
                        {/if}
                    {/await}
                {/if}
                {#if generationInfoMenuIndex === 3}
                    {#if Object.keys(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo || {}).length === 0}
                        <div class="text-gray-300 text-lg mt-2">{language.promptInfoEmptyMessage}</div>
                    {:else}
                        <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                            <span class="text-blue-500">Preset Name</span>
                            <span class="text-blue-500 justify-self-end">{DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo.promptName}</span>
                            <span class="text-purple-500">Toggles</span>
                            <div class="col-span-2 max-h-32 overflow-y-auto border border-stone-500 rounded-sm p-2 bg-gray-900">
                                {#if DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo.promptToggles.length === 0}
                                    <div class="text-gray-500 italic text-center py-4">{language.promptInfoEmptyToggle}</div>
                                {:else}
                                    <div class="grid grid-cols-2 gap-y-2 gap-x-4">
                                        {#each DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo.promptToggles as toggle}
                                        <span class="text-gray-200 truncate">{toggle.key}</span>
                                        <span class="text-gray-200 justify-self-end truncate">{toggle.value}</span>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                            <span class="text-red-500">Prompt Text</span>
                            <div class="col-span-2 max-h-80 overflow-y-auto border border-stone-500 rounded-sm p-4 bg-gray-900">
                                {#if !DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo.promptText}
                                    <div class="text-gray-500 italic text-center py-4">{language.promptInfoEmptyText}</div>
                                {:else}
                                    {#each DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[$alertGenerationInfoStore.idx].promptInfo.promptText as block}
                                        <div class="mb-2">
                                            <div class="font-bold text-gray-600">{block.role}</div>
                                            <pre class="whitespace-pre-wrap text-sm bg-stone-900 p-2 rounded-sm border border-stone-500">{block.content}</pre>
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        </div>
                    {/if}
                {/if}
            {:else if $alertStore.type === 'addchar'}
                <div class="w-2xl flex flex-col max-w-full">

                    <button class="border-darkborderc border py-12 px-8 flex rounded-md hover:ring-2 justify-center items-center" onclick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        alertStore.set({
                            type: 'none',
                            msg: 'importFromRealm'
                        })
                    }}>
                        <div class="flex flex-col justify-start items-start">
                            <span class="text-2xl font-bold">{language.importFromRealm}</span>
                            <span class="text-textcolor2">{language.importFromRealmDesc}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2" onclick={((e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        alertStore.set({
                            type: 'none',
                            msg: 'importCharacter'
                        })
                    })}>
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.importCharacter}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2" onclick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        alertStore.set({
                            type: 'none',
                            msg: 'createfromScratch'
                        })
                    }}>
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.createfromScratch}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2" onclick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        alertStore.set({
                            type: 'none',
                            msg: 'importPackage'
                        })
                    }}>
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.characterPackageImport}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2" onclick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        alertStore.set({
                            type: 'none',
                            msg: 'cancel'
                        })
                    }}>
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.cancel}</span>
                        </div>
                    </button>
                </div>
            {/if}
        </div>
    </div>

{:else if $alertStore.type === 'cardexport'}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div  class="fixed top-0 left-0 h-full w-full bg-black/50 flex flex-col z-50 items-center justify-center" role="button" tabindex="0" onclick={close}>
        <div class="bg-darkbg rounded-md p-4 max-w-full flex flex-col w-2xl" role="button" tabindex="0" onclick={(e) => {
            e.stopPropagation()
        }}>
            <h1 class="font-bold text-2xl w-full">
                <span>
                    {language.shareExport}
                </span>
                <button class="float-right text-textcolor2 hover:text-primary" onclick={() => {
                    alertStore.set({
                        type: 'none',
                        msg: JSON.stringify({
                            type: 'cancel',
                            type2: cardExportType2
                        })
                    })
                }}>
                    <XIcon />
                </button>
            </h1>
            <span class="text-textcolor mt-4">{language.type}</span>
            {#if cardExportType === ''}
                {#if $alertStore.submsg === 'module'}
                    <span class="text-textcolor2 text-sm">{language.risuMDesc}</span>
                {:else if $alertStore.submsg === 'preset'}
                    <span class="text-textcolor2 text-sm">{language.risupresetDesc}</span>
                    {#if cardExportType2 === 'preset' && (DBState.db.botPresets[DBState.db.botPresetsId].image || DBState.db.botPresets[DBState.db.botPresetsId].regex?.length > 0)}
                        <span class="text-red-500 text-sm">Use RisuRealm to share the preset. Preset with image or regexes cannot be exported for now.</span>
                    {/if}
                {:else}
                    <span class="text-textcolor2 text-sm">{language.ccv3Desc}</span>
                    {#if cardExportType2 !== 'charx' && cardExportType2 !== 'charxJpeg' && isCharacterHasAssets(DBState.db.characters[$selectedCharID])}
                        <span class="text-red-500 text-sm">{language.notCharxWarn}</span>
                    {/if}
                {/if}
            {:else if cardExportType === 'json'}
                <span class="text-textcolor2 text-sm">{language.jsonDesc}</span>
            {:else if cardExportType === 'ccv2'}
                <span class="text-textcolor2 text-sm">{language.ccv2Desc}</span>
                <span class="text-red-500 text-sm">{language.v2Warning}</span>
            {/if}
            <div class="flex items-center flex-wrap mt-2">
                {#if $alertStore.submsg === 'preset'}
                    <button class="bg-bgcolor px-2 py-4 rounded-lg flex-1" class:ring-1={cardExportType === ''} onclick={() => {cardExportType = ''}}>Risupreset</button>
                {:else if $alertStore.submsg === 'module'}
                    <button class="bg-bgcolor px-2 py-4 rounded-lg flex-1" class:ring-1={cardExportType === ''} onclick={() => {cardExportType = ''}}>RisuM</button>
                {:else}
                    <button class="bg-bgcolor px-2 py-4 rounded-lg flex-1" class:ring-1={cardExportType === ''} onclick={() => {
                        cardExportType = ''
                        cardExportType2 = 'charxJpeg'
                    }}>Character Card V3</button>
                    <button class="bg-bgcolor px-2 py-4 rounded-lg ml-2 flex-1" class:ring-1={cardExportType === 'ccv2'} onclick={() => {cardExportType = 'ccv2'}}>Character Card V2</button>
                {/if}
            </div>
            {#if $alertStore.submsg === '' && cardExportType === ''}
                <span class="text-textcolor mt-4">{language.format}</span>
                <SelectInput bind:value={cardExportType2} className="mt-2">
                    <OptionInput value="charx">CHARX</OptionInput>
                    <OptionInput value="charxJpeg">CHARX-JPEG</OptionInput>
                    <OptionInput value="">PNG</OptionInput>
                    <OptionInput value="json">JSON</OptionInput>
                </SelectInput>
            {/if}
            <Button className="mt-4" onclick={() => {
                alertStore.set({
                    type: 'none',
                    msg: JSON.stringify({
                        type: cardExportType,
                        type2: cardExportType2
                    })
                })
            }}>{language.export}</Button>
        </div>
    </div>

{:else if $alertStore.type === 'selectModule'}
    <ModuleChatMenu alertMode close={(d) => {
        alertStore.set({
            type: 'none',
            msg: d
        })
    }} />
{:else if $alertStore.type === 'pukmakkurit'}
    <!-- Log Generator by dootaang, GPL3 -->
    <!-- Svelte, Typescript version by Kwaroran -->
    
    <div class="absolute w-full h-full z-50 bg-black/50 flex justify-center items-center">
        <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl  max-h-full overflow-y-auto">
            <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">{language.preview}</h2>

        </div>
    </div>
{:else if $alertStore.type === 'branches'}
    <div class="absolute w-full h-full z-50 bg-black/80 flex justify-center items-center overflow-x-auto overflow-y-auto">
        {#if branchHover !== null}
            <div class="z-30 whitespace-pre-wrap p-4 text-textcolor bg-darkbg border-darkborderc border rounded-md absolute" style="top: {branchHover.y * 80 + 24}px; left: {(branchHover.x + 1) * 80 + 24}px">
                {branchHover.content}
            </div>
        {/if}

        <div class="x-50 right-2 top-2 absolute">
            <button class="bg-darkbg border-darkborderc border p-2 rounded-md" onclick={() => {
                alertStore.set({
                    type: 'none',
                    msg: ''
                })
            }}>
                <XIcon />
            </button>
        </div>

        {#each getChatBranches() as obj}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
                role="table"
                class="peer w-12 h-12 z-20 bg-bgcolor border border-darkborderc rounded-full flex justify-center items-center overflow-y-auto absolute"
                style="top: {obj.y * 80 + 24}px; left: {obj.x * 80 + 24}px"
                onmouseenter={() => {
                    if(branchHover === null){
                        branchHover = {
                            x: obj.x,
                            y: obj.y,
                            content: branchNodeContent(obj)
                        }
                    }
                }}
                onclick={() => {
                    if(branchHover === null){
                        branchHover = {
                            x: obj.x,
                            y: obj.y,
                            content: branchNodeContent(obj)
                        }
                    }
                }}
                onmouseleave={() => {
                    branchHover = null
                }}
            >
                
            </div>
            {#if obj.connectX === obj.x}
                {#if obj.multiChild}
                    <div class="w-0 h-20 border-x border-x-red-500 absolute" style="top: {(obj.y-1) * 80 + 24}px; left: {obj.x * 80 + 45}px">

                    </div>
                {:else}
                    <div class="w-0 h-20 border-x border-x-blue-500 absolute" style="top: {(obj.y-1) * 80 + 24}px; left: {obj.x * 80 + 45}px">

                    </div>
                {/if}
            {:else if obj.connectX !== -1}
                <div class="w-0 h-10 border-x border-x-red-500 absolute" style="top: {(obj.y) * 80}px; left: {obj.x * 80 + 45}px">

                </div>
                <div class="h-0 border-y border-y-red-500 absolute" style="top: {(obj.y) * 80}px; left: {obj.connectX * 80 + 46}px" style:width={Math.abs((obj.x - obj.connectX) * 80) + 'px'}>

                </div>
            {/if}
        {/each}
    </div>
{/if}

<ShDialog
    open={$alertStore.type === 'error'}
    size="lg"
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'error') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    {#snippet title()}
        <span class="text-draculared">{language.error}</span>
    {/snippet}

    <div class="flex flex-col gap-2">
        <span class="text-textcolor whitespace-pre-wrap wrap-break-word">{$alertStore.msg}</span>
        {#if $alertStore.submsg}
            <span class="text-textcolor2 text-sm">{$alertStore.submsg}</span>
        {/if}

        {#if $alertStore.stackTrace}
            <div class="mt-2">
                <Button styled="outlined" size="sm" onclick={() => showDetails = !showDetails}>
                    {showDetails ? language.hideErrorDetails : language.showErrorDetails}
                    {#if showDetails}
                        <XIcon class="inline ml-2" />
                    {:else}
                        <ChevronRightIcon class="inline ml-2" />
                    {/if}
                </Button>
                {#if showDetails}
                    <div class="stack-trace-wrap">
                        <button
                            class="stack-trace-copy"
                            onclick={() => copyToClipboard(stackTraceCodeBlock, 'stack-trace')}
                            title={language.copy}
                            aria-label={language.copy}
                        >
                            {#if copiedKey === 'stack-trace'}
                                <CheckIcon size={14} />
                            {:else}
                                <CopyIcon size={14} />
                            {/if}
                        </button>
                        <pre class="stack-trace">{stackTraceCodeBlock}</pre>
                    </div>
                {/if}
            </div>
        {/if}
    </div>

    {#snippet footer()}
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>

<ShDialog
    open={$alertStore.type === 'normal'}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'normal') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    <div class="flex flex-col gap-2">
        <span class="whitespace-pre-wrap">{$alertStore.msg}</span>
        {#if $alertStore.submsg}
            <span class="text-textcolor2 text-sm">{$alertStore.submsg}</span>
        {/if}
    </div>

    {#snippet footer()}
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>

<ShDialog
    open={$alertStore.type === 'markdown'}
    size="lg"
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'markdown') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    <div class="overflow-y-auto">
        <span class="chattext prose chattext2" class:prose-invert={$ColorSchemeTypeStore === 'dark'}>
            {#await ParseMarkdown($alertStore.msg) then msg}
                {@html msg}
            {/await}
        </span>
    </div>

    {#snippet footer()}
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>

<ShAlertDialog
    open={$alertStore.type === 'ask'}
    closeOnOutsideClick={true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'ask') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    <span class="whitespace-pre-wrap text-textcolor">{$alertStore.msg}</span>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>{language.no}</ShButton>
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>{language.yes}</ShButton>
    {/snippet}
</ShAlertDialog>

<ShAlertDialog
    open={$alertStore.type === 'pluginconfirm'}
    closeOnOutsideClick={true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'pluginconfirm') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    {#if $alertStore.type === 'pluginconfirm'}
        {@const parts = $alertStore.msg.split('\n\n')}
        {@const mainPart = parts[0] ?? ''}
        {@const confirmMessage = parts[1] ?? ''}
        {@const mainParts = mainPart.split('\n')}
        {@const pluginName = mainParts[0] ?? ''}
        {@const warnings = mainParts.slice(1)}
        <div class="flex flex-col gap-3">
            <p class="text-xl font-bold text-textcolor">{pluginName}</p>
            {#if warnings.length > 0}
                <ul class="list-disc list-inside text-draculared text-sm space-y-1">
                    {#each warnings as warning}
                        <li>{warning}</li>
                    {/each}
                </ul>
            {/if}
            {#if confirmMessage}
                <p class="text-textcolor2">{confirmMessage}</p>
            {/if}
        </div>
    {/if}
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>{language.no}</ShButton>
        <ShButton variant="destructive" onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>{language.yes}</ShButton>
    {/snippet}
</ShAlertDialog>

<ShDialog
    open={$alertStore.type === 'select'}
    closable={false}
    closeOnOutsideClick={false}
>
    {#if $alertStore.type === 'select'}
        {@const hasDisplay = $alertStore.msg.startsWith('__DISPLAY__')}
        {@const raw = hasDisplay ? $alertStore.msg.substring(11) : $alertStore.msg}
        {@const parts = raw.split('||')}
        {@const prompt = hasDisplay ? parts[0] : ''}
        {@const options = hasDisplay ? parts.slice(1) : parts}
        <div class="flex flex-col gap-3">
            {#if prompt}
                <p class="text-textcolor whitespace-pre-wrap">{prompt}</p>
            {/if}
            <div class="flex flex-col gap-2">
                {#each options as label, i}
                    <ShButton
                        variant="outline"
                        className="w-full justify-start"
                        onclick={() => alertStore.set({ type: 'none', msg: i.toString() })}
                    >
                        {label}
                    </ShButton>
                {/each}
            </div>
        </div>
    {/if}
</ShDialog>

<ShAlertDialog
    open={$alertStore.type === 'confirmMulti'}
    closeOnEscape={true}
    closeOnOutsideClick={true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'confirmMulti') {
            alertStore.set({ type: 'none', msg: 'cancel' })
        }
    }}
>
    {#snippet title()}
        {$alertStore.msg}
    {/snippet}
    {#snippet description()}
        {#if $alertStore.submsg}
            <span class="whitespace-pre-wrap">{$alertStore.submsg}</span>
        {/if}
    {/snippet}
    {#if $alertStore.type === 'confirmMulti'}
        {@const actions = $alertStore.actions ?? []}
        <div class="flex flex-col gap-2">
            {#each actions as action, i}
                <ShButton
                    variant={action.variant ?? 'default'}
                    className="w-full"
                    onclick={() => alertStore.set({ type: 'none', msg: i.toString() })}
                >
                    {action.label}
                </ShButton>
            {/each}
        </div>
    {/if}
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'cancel' })}>{language.cancel}</ShButton>
    {/snippet}
</ShAlertDialog>

<ShDialog
    open={$alertStore.type === 'input'}
    closable={false}
    closeOnOutsideClick={false}
>
    <div class="flex flex-col gap-3">
        {#if $alertStore.msg}
            <p class="text-textcolor whitespace-pre-wrap">{$alertStore.msg}</p>
        {/if}
        <TextInput
            bind:value={input}
            id="alert-input"
            autocomplete="off"
            list="alert-input-list"
            fullwidth
            onkeydown={(e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    // Closing the popup returns focus to the button that opened
                    // it before this key's keypress fires; without preventDefault
                    // that keypress activates the button and reopens the popup
                    // (a second "new folder" dialog, then a duplicate folder).
                    e.preventDefault()
                    alertStore.set({ type: 'none', msg: input })
                }
            }}
        />
        {#if $alertStore.datalist}
            <datalist id="alert-input-list">
                {#each $alertStore.datalist as item}
                    <option
                        value={item[0]}
                        label={item[1] ? item[1] : item[0]}
                    >{item[1] ? item[1] : item[0]}</option>
                {/each}
            </datalist>
        {/if}
    </div>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.cancel}</ShButton>
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: input })}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>

<ShLoadingDialog
    open={$alertStore.type === 'wait' || $alertStore.type === 'wait2' || $alertStore.type === 'progress'}
    message={$alertStore.msg}
    submessage={$alertStore.type !== 'progress' ? ($alertStore.submsg ?? '') : ''}
    progress={$alertStore.type === 'progress' ? parseFloat($alertStore.submsg ?? '0') : null}
/>

<ShAlertDialog
    open={$alertStore.type === 'tos'}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'tos') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    <!-- svelte-ignore a11y_missing_attribute -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="text-textcolor">
        You should accept
        <a role="button" tabindex="0" class="text-borderc hover:underline cursor-pointer" onclick={() => openURL('https://sv.risuai.xyz/hub/tos')}>Terms of Service</a>
        to continue.
    </div>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>Do not Accept</ShButton>
        <ShButton onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>Accept</ShButton>
    {/snippet}
</ShAlertDialog>

<!-- tier="base" puts this below default ShDialog/ShAlertDialog tier so
     nested alertConfirm/alertInput (overwrite, rename, delete) paint on
     top regardless of Portal mount order. See .agent/guide/ui.md. -->
<ShDialog
    open={$togglePresetsOpenStore}
    onOpenChange={(v) => { if (!v) closeTogglePresets() }}
    tier="base"
>
    {#snippet title()}{language.togglePresetSelectTitle}{/snippet}

    {#if $togglePresetsOpenStore}
        {@const currentPromptPresetName = DBState.db.botPresets[DBState.db.botPresetsId]?.name}
        <div class="flex flex-col gap-3">
            <label class="flex items-center gap-2 text-sm text-textcolor2 self-start cursor-pointer select-none">
                <ShSwitch bind:checked={togglePresetShowAll} />
                {language.togglePresetFilterShowAll}
            </label>

            {#if !DBState.db.togglePresets?.length}
                <p class="text-textcolor2 text-sm">{language.togglePresetEmpty}</p>
            {:else}
                {@const filteredPresets = togglePresetShowAll
                    ? DBState.db.togglePresets.map((p, i) => ({preset: p, index: i}))
                    : DBState.db.togglePresets.map((p, i) => ({preset: p, index: i})).filter(({preset}) => preset.promptPresetName === currentPromptPresetName)}
                {#if filteredPresets.length === 0}
                    <p class="text-textcolor2 text-sm">{language.togglePresetEmptyFiltered}</p>
                {:else}
                    <div class="flex flex-col gap-1">
                        {#each filteredPresets as {preset, index: i}}
                            <div class="flex items-center border border-darkborderc rounded-md hover:ring-1 hover:ring-borderc/50 transition-shadow">
                                <button class="flex-1 min-w-0 p-2 text-left cursor-pointer text-textcolor truncate hover:bg-selected/30 rounded-l-md transition-colors" onclick={async () => {
                                    const name = preset.name
                                    const isMismatch = preset.promptPresetName !== currentPromptPresetName
                                    const msg = isMismatch ? language.togglePresetMismatchConfirm : language.togglePresetApplyConfirm
                                    const confirmed = await alertConfirm(msg)
                                    if (!confirmed) return
                                    applyToggleValues(preset.values)
                                    notifySuccess((language.togglePresetApplied as any)(name))
                                    closeTogglePresets()
                                }}>
                                    <div class="text-xs text-textcolor2 leading-tight">{preset.promptPresetName ?? language.togglePresetNoPromptPreset}</div>
                                    {preset.name}
                                </button>
                                <div class="flex items-center shrink-0 pr-1 gap-0.5">
                                    {#if togglePresetShowAll}
                                        <ShButton variant="ghost" size="icon-xs" onclick={() => {
                                            if (i > 0) {
                                                const presets = DBState.db.togglePresets!;
                                                [presets[i - 1], presets[i]] = [presets[i], presets[i - 1]];
                                                DBState.db.togglePresets = [...presets];
                                            }
                                        }}>
                                            <ChevronUpIcon size={14} />
                                        </ShButton>
                                        <ShButton variant="ghost" size="icon-xs" onclick={() => {
                                            const presets = DBState.db.togglePresets!;
                                            if (i < presets.length - 1) {
                                                [presets[i], presets[i + 1]] = [presets[i + 1], presets[i]];
                                                DBState.db.togglePresets = [...presets];
                                            }
                                        }}>
                                            <ChevronDownIcon size={14} />
                                        </ShButton>
                                    {/if}
                                    <ShDropdownMenu>
                                        <ShDropdownMenuTrigger>
                                            {#snippet child({ props })}
                                                <ShButton {...props} variant="ghost" size="icon-xs">
                                                    <EllipsisVerticalIcon size={14} />
                                                </ShButton>
                                            {/snippet}
                                        </ShDropdownMenuTrigger>
                                        <!-- z-[45] sits between the base togglePresets dialog (z-40) and
                                             nested alertConfirm/alertInput (z-50): the menu floats over
                                             the list but is occluded by the confirm popups it triggers. -->
                                        <ShDropdownMenuContent class="z-[45] min-w-40" align="end">
                                            <ShDropdownMenuItem onSelect={async () => {
                                                const idx = i
                                                const presetName = DBState.db.togglePresets![idx].name
                                                const confirmed = await alertConfirm((language.togglePresetOverwriteConfirm as any)(presetName))
                                                if (confirmed) {
                                                    const promptPreset = DBState.db.botPresets[DBState.db.botPresetsId]
                                                    DBState.db.togglePresets![idx].values = snapshotCurrentToggleValues()
                                                    DBState.db.togglePresets![idx].promptPresetName = promptPreset?.name
                                                    DBState.db.togglePresets = [...DBState.db.togglePresets!]
                                                    notifySuccess((language.togglePresetOverwritten as any)(presetName))
                                                }
                                            }}>
                                                <RefreshCwIcon size={14} />
                                                {language.togglePresetMenuOverwrite}
                                            </ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={async () => {
                                                const idx = i
                                                const oldName = DBState.db.togglePresets![idx].name
                                                const name = await alertInput(language.togglePresetRename, [], oldName)
                                                if (name && name !== oldName) {
                                                    DBState.db.togglePresets![idx].name = name
                                                    DBState.db.togglePresets = [...DBState.db.togglePresets!]
                                                    notifySuccess((language.togglePresetRenamed as any)(oldName, name))
                                                }
                                            }}>
                                                <PencilIcon size={14} />
                                                {language.togglePresetMenuRename}
                                            </ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={() => {
                                                const copy = $state.snapshot(preset);
                                                copy.name = preset.name + ' (Copy)';
                                                DBState.db.togglePresets!.splice(i + 1, 0, copy);
                                                DBState.db.togglePresets = [...DBState.db.togglePresets!];
                                                notifySuccess((language.togglePresetDuplicated as any)(copy.name))
                                            }}>
                                                <CopyIcon size={14} />
                                                {language.togglePresetMenuDuplicate}
                                            </ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={() => {
                                                const exportData = { name: preset.name, values: preset.values, promptPresetName: preset.promptPresetName }
                                                downloadFile(`${preset.name}_toggle.json`, Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8'))
                                                notifySuccess((language.togglePresetExported as any)(preset.name))
                                            }}>
                                                <DownloadIcon size={14} />
                                                {language.togglePresetMenuExport}
                                            </ShDropdownMenuItem>
                                            <ShDropdownMenuSeparator />
                                            <ShDropdownMenuItem variant="destructive" onSelect={async () => {
                                                const idx = i
                                                const presetName = DBState.db.togglePresets![idx].name
                                                const confirmed = await alertConfirm((language.togglePresetDeleteConfirm as any)(presetName))
                                                if (confirmed) {
                                                    DBState.db.togglePresets!.splice(idx, 1)
                                                    DBState.db.togglePresets = [...DBState.db.togglePresets!]
                                                    notifySuccess((language.togglePresetDeleted as any)(presetName))
                                                }
                                            }}>
                                                <TrashIcon size={14} />
                                                {language.togglePresetMenuDelete}
                                            </ShDropdownMenuItem>
                                        </ShDropdownMenuContent>
                                    </ShDropdownMenu>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}

            <!-- Add new / import: live alongside the list rather than as a
                 dialog footer, since they create new entries instead of
                 closing the dialog. Mobile stacks vertically so the long
                 Korean labels don't wrap inside narrow flex-1 cells. -->
            <div class="flex flex-col sm:flex-row gap-2 mt-1">
                <ShButton
                    variant="outline"
                    className="w-full sm:flex-1 sm:w-auto"
                    onclick={async () => {
                        const name = await alertInput(language.togglePresetNamePrompt)
                        if (!name) return
                        DBState.db.togglePresets ??= []
                        const promptPreset = DBState.db.botPresets[DBState.db.botPresetsId]
                        DBState.db.togglePresets.push({
                            name,
                            values: snapshotCurrentToggleValues(),
                            promptPresetName: promptPreset?.name
                        })
                        DBState.db.togglePresets = [...DBState.db.togglePresets]
                        notifySuccess((language.togglePresetSaved as any)(name))
                    }}
                >
                    <PlusIcon size={16} />
                    {language.togglePresetSaveNew}
                </ShButton>
                <ShButton
                    variant="outline"
                    className="w-full sm:flex-1 sm:w-auto"
                    onclick={async () => {
                        let f: {name: string, data: Uint8Array} | undefined
                        try {
                            f = await selectSingleFile(['json'])
                        } catch { return }
                        if (!f) return
                        try {
                            const data = JSON.parse(Buffer.from(f.data).toString('utf-8'))
                            if (typeof data.name !== 'string' || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
                                alertError(language.togglePresetImportError)
                                return
                            }
                            const sanitizedValues: Record<string, string> = {}
                            for (const [k, v] of Object.entries(data.values)) {
                                if (typeof k === 'string' && typeof v === 'string') {
                                    sanitizedValues[k] = v
                                }
                            }
                            DBState.db.togglePresets ??= []
                            DBState.db.togglePresets.push({
                                name: data.name,
                                values: sanitizedValues,
                                promptPresetName: typeof data.promptPresetName === 'string' ? data.promptPresetName : undefined
                            })
                            DBState.db.togglePresets = [...DBState.db.togglePresets]
                            notifySuccess((language.togglePresetImported as any)(data.name))
                        } catch {
                            alertError(language.togglePresetImportError)
                        }
                    }}
                >
                    <UploadIcon size={16} />
                    {language.togglePresetImport}
                </ShButton>
            </div>
        </div>
    {/if}
</ShDialog>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }

    .stack-trace-wrap {
        position: relative;
        margin-top: 0.5rem;
    }

    .stack-trace {
        background-color: var(--risu-theme-bgcolor);
        color: var(--risu-theme-textcolor2);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.25rem;
        padding: 0.75rem 2.75rem 0.75rem 0.75rem;
        font-family: monospace;
        font-size: 0.75rem;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 200px;
        overflow-y: auto;
    }

    .stack-trace-copy {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.375rem;
        background-color: var(--risu-theme-darkbg);
        color: var(--risu-theme-textcolor2);
        transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
    }

    .stack-trace-copy:hover {
        background-color: var(--risu-theme-bgcolor);
        color: var(--risu-theme-textcolor);
    }
</style>
