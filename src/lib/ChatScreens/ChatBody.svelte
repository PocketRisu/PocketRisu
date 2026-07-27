<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { DBState } from 'src/ts/stores.svelte'
    import { sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { tick } from 'svelte'
    import { addMetadataToElement, getDistance, ParseMarkdown, postTranslationParse, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, translateHTML } from "../../ts/translator/translator"
    import { getModuleAssets } from "src/ts/process/modules";
    import { reportMarkdownParse } from "src/ts/process/parseDebug";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { findSafeBlockBoundary, getCommonPrefixLength } from "./incrementalHtml";

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        bodyRoot?: HTMLElement|null
        modelShortName: string
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        bodyRoot,
        modelShortName = '',
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10

    let committedChunks = $state<string[]>([])
    let liveHtml = $state('')
    let committedPrefix = ''
    let previousFullHtml = ''
    let parseSequence = 0
    let appliedSequence = 0
    let streamIdentity = ''

    const resolvedAssetSrc = new Map<string, string>()
    const resolvingAssetSrc = new Map<string, Promise<string>>()
    let viewerSrc = $state('')

    const getCachedFileSrc = async (cacheKey: string, path: string) => {
        const cached = resolvedAssetSrc.get(cacheKey)
        if(cached){
            return cached
        }

        let resolving = resolvingAssetSrc.get(cacheKey)
        if(!resolving){
            resolving = getFileSrc(path).then((src) => {
                resolvedAssetSrc.set(cacheKey, src)
                resolvingAssetSrc.delete(cacheKey)
                return src
            }).catch((error) => {
                resolvingAssetSrc.delete(cacheKey)
                throw error
            })
            resolvingAssetSrc.set(cacheKey, resolving)
        }

        return resolving
    }

    const resetIncrementalRender = () => {
        committedChunks = []
        liveHtml = ''
        committedPrefix = ''
        previousFullHtml = ''
    }

    const applyIncrementalHtml = (html: string) => {
        if(committedPrefix && !html.startsWith(committedPrefix)){
            resetIncrementalRender()
        }

        const commonLength = previousFullHtml
            ? getCommonPrefixLength(previousFullHtml, html)
            : 0
        const stableBoundary = findSafeBlockBoundary(html, commonLength)

        if(stableBoundary > committedPrefix.length){
            const newChunk = html.slice(committedPrefix.length, stableBoundary)
            if(newChunk){
                committedChunks = [...committedChunks, newChunk]
                committedPrefix += newChunk
            }
        }

        liveHtml = html.slice(committedPrefix.length)
        previousFullHtml = html
    }

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        translated;
        retranslate;
        let lastParsedQueue = ''
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg)) || (chatID !== lastChatId)){
                lastParsedQueue = ''
                lastCharArg = charArg
                lastChatId = chatID
                let translateText = false
                try {
                    if(DBState.db.autoTranslate){
                        if(DBState.db.autoTranslateCachedOnly && DBState.db.translatorType === 'llm'){
                            const cache = DBState.db.translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !DBState.db.legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition()))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition()))

                            translateText = cache !== null
                        }
                        else{
                            translateText = true
                        }
                    }

                    const lastTranslated = translated

                    setTimeout(() => {
                        translated = translateText
                    }, 10)

                    if (lastTranslated !== translateText) {
                        return;
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(retranslate || translated){
                if (DBState.db.showTranslationLoading) {
                    lastParsed = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`
                }

                let transResult

                if(DBState.db.translatorType === 'llm' && DBState.db.translateBeforeHTMLFormatting){
                    await sleep(100)
                    translating = true
                    data = await translateHTML(data, false, charArg, chatID, retranslate)
                    translating = false
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                    lastParsedQueue = marked
                    lastCharArg = charArg
                    transResult = marked
                }
                else if(!DBState.db.legacyTranslation){
                    const marked = await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition())
                    translating = true
                    const translated = await postTranslationParse(await translateHTML(marked, false, charArg, chatID, retranslate))
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }
                else{
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                    translating = true
                    const translated = await translateHTML(marked, false, charArg, chatID, retranslate)
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }

                setTimeout(() => {
                    retranslate = false
                }, 10);

                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                lastParsedQueue = marked
                lastCharArg = charArg
                return marked
            }
        } catch (error) {
            if(tries > 2){
                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1)
        }
        finally{
            lastParsed = lastParsedQueue
        }
    }

    const checkImg = () => {
        if(!DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/"]):not([noimage])') as NodeListOf<HTMLImageElement>

        if (imgs.length > 0) {
            const currentCharacter = getCurrentCharacter()
            const styl = currentCharacter.prebuiltAssetStyle
            const assets = getModuleAssets().concat(currentCharacter.additionalAssets ?? [])
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''

                if(name.length > 200 || name.includes(':')){
                    img.setAttribute('noimage', 'true')
                    return
                }

                const foundAsset = exactAssets.get(name)
                if(foundAsset){
                    img.dataset.risuAssetName = name
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    img.setAttribute('loading', 'eager')
                    img.decoding = 'async'
                    img.style.cursor = 'pointer'
                    img.onclick = () => { viewerSrc = img.src }

                    const cached = resolvedAssetSrc.get(name)
                    if(cached){
                        img.src = cached
                        return
                    }

                    const originalName = name
                    const resolved = await getCachedFileSrc(name, foundAsset)
                    if(img.isConnected && img.getAttribute('src')?.toLocaleLowerCase() === originalName){
                        img.src = resolved
                    }
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(currentFound){
                    img.dataset.risuAssetName = name
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    img.setAttribute('loading', 'eager')
                    img.decoding = 'async'
                    img.style.cursor = 'pointer'
                    img.onclick = () => { viewerSrc = img.src }

                    const cached = resolvedAssetSrc.get(name)
                    if(cached){
                        img.src = cached
                        img.removeAttribute('noimage')
                        return
                    }

                    const originalName = name
                    const got = await getCachedFileSrc(name, currentFound)
                    if(img.isConnected && img.getAttribute('src')?.toLocaleLowerCase() === originalName){
                        img.setAttribute('src', got)
                        img.removeAttribute('noimage')
                    }
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    let markParsingResult = $derived.by(() => {
        reportMarkdownParse(idx)
        return markParsing(msgDisplay, character, idx)
    })

    $effect(() => {
        const identity = `${idx}:${typeof character === 'string' ? character : JSON.stringify(character ?? null)}`
        if(identity !== streamIdentity){
            streamIdentity = identity
            resetIncrementalRender()
        }

        const currentResult = markParsingResult
        const sequence = ++parseSequence

        currentResult.then(async (md) => {
            if(sequence < appliedSequence || typeof md !== 'string'){
                return
            }
            appliedSequence = sequence

            const html = addMetadataToElement(trimMarkdown(md), modelShortName)
            applyIncrementalHtml(html)

            await tick()
            checkImg()
            if (bodyRoot) resolveInlayPlaceholders(bodyRoot)
        })
    })
</script>

{#each committedChunks as chunk, chunkIndex (chunkIndex)}
    {@html chunk}
{/each}
{@html liveHtml}

{#if viewerSrc}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" data-risu-modal-scroll onclick={() => { viewerSrc = '' }}>
    <img src={viewerSrc} alt="" class="max-w-[90vw] max-h-[90vh] object-contain rounded-md shadow-2xl" onclick={(e) => e.stopPropagation()} />
</div>
{/if}