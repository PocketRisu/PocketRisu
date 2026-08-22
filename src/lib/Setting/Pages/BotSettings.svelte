<script lang="ts">

    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    
    import { DBState, BotSubmenuIndex } from 'src/ts/stores.svelte';
    import { customProviderStore } from "src/ts/plugins/plugins.svelte";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { PlusIcon, TrashIcon, TriangleAlertIcon, InfoIcon, ArrowRightIcon } from "@lucide/svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { getOpenRouterModels, toModelGridItem as orToGridItem } from "src/ts/model/openrouter";
    import { getNanoGPTModels, getNanoGPTSubscriptionModels, toModelGridItem as ngToGridItem } from "src/ts/model/nanogpt";
    import ModelGrid from "src/lib/UI/ModelGrid.svelte";
    import NanoGPTDashboard from "src/lib/UI/NanoGPTDashboard.svelte";
    import NanoGPTProviderPicker from "src/lib/UI/NanoGPTProviderPicker.svelte";
    import type { ModelGridPinnedItem } from "src/ts/model/modelGrid";
    import OobaSettings from "./OobaSettings.svelte";
    import OpenrouterSettings from "./OpenrouterSettings.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import { getModelInfo, LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import SeparateParametersSection from "./SeparateParametersSection.svelte";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'
    import CustomModelsSettings from './Model/CustomModelsSettings.svelte'
    
    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: 'risu/free',       displayName: 'Free Auto',       providerName: 'Risu'       },
        { id: 'openrouter/auto', displayName: 'OpenRouter Auto', providerName: 'OpenRouter' },
    ]

    // Reset model selection and display name when subscription mode toggles
    let _nanogptSubModeInitialized = false
    $effect(() => {
        const _sub = DBState.db.nanogptUseSubscriptionEndpoint
        if (!_nanogptSubModeInitialized) { _nanogptSubModeInitialized = true; return }
        DBState.db.nanogptRequestModel = ''
        DBState.db.nanogptRequestModelName = ''
    })

    // Reset provider selection to Auto when the model or subscription mode changes
    let _nanogptProviderResetInitialized = false
    $effect(() => {
        const _model = DBState.db.nanogptRequestModel
        const _sub   = DBState.db.nanogptUseSubscriptionEndpoint
        if (!_nanogptProviderResetInitialized) { _nanogptProviderResetInitialized = true; return }
        DBState.db.nanogptProvider = ''
    })

    // Reset subscription mode (and related state) when API key is cleared
    let _nanogptKeyInitialized = false
    $effect(() => {
        const _key = DBState.db.nanogptKey
        if (!_nanogptKeyInitialized) { _nanogptKeyInitialized = true; return }
        if (!_key) {
            DBState.db.nanogptUseSubscriptionEndpoint = false
            DBState.db.nanogptSubscriptionState = ''
            DBState.db.nanogptRequestModel = ''
            DBState.db.nanogptRequestModelName = ''
            DBState.db.nanogptProvider = ''
        }
    })


    $effect.pre(() => {
        if(DBState.db.aiModel === 'textgen_webui' || DBState.db.subModel === 'mancer'){
            DBState.db.useStreaming = DBState.db.textgenWebUIStreamURL.startsWith("wss://")
        }
    });

    function clearVertexToken() {
        DBState.db.vertexAccessToken = '';
        DBState.db.vertexAccessTokenExpires = 0;
        console.log('Vertex AI token cleared');
    }

    let modelInfo = $derived(getModelInfo(DBState.db.aiModel))
    let subModelInfo = $derived(getModelInfo(DBState.db.subModel))
    let nanogptInputMode = $state<'list' | 'manual'>(DBState.db.nanogptRequestModel && !DBState.db.nanogptRequestModelName ? 'manual' : 'list')
    // svelte-ignore state_referenced_locally
    let prevNanogptInputMode = nanogptInputMode;
    $effect(() => {
        if (nanogptInputMode !== prevNanogptInputMode) {
            DBState.db.nanogptRequestModel = '';
            DBState.db.nanogptRequestModelName = '';
            prevNanogptInputMode = nanogptInputMode;
        }
    });
</script>
<SettingPage title={language.chatBot}>
<ShAlert variant="info" className="mb-4">
    {#snippet icon()}<InfoIcon />{/snippet}
    {language.botSettingsPresetMovedDesc}
    {#snippet action()}
        <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.PromptPreset)}>
            {language.promptPresetMenu}
            <ArrowRightIcon size={14} />
        </ShButton>
    {/snippet}
</ShAlert>
<SettingTabs tabs={[
    { label: language.model, value: 0 },
    { label: language.parameters, value: 1 },
    { label: language.customModels, value: 2 },
]} bind:selected={$BotSubmenuIndex} />

{#if $BotSubmenuIndex === 0}
    <ShAlert variant="warning" className="mt-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {#snippet title()}{language.botSettingsLegacyTitle}{/snippet}
        {language.botSettingsLegacyDesc}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.ModelPreset)}>
                {language.modelPresetMenu}
                <ArrowRightIcon size={14} />
            </ShButton>
        {/snippet}
    </ShAlert>
    <span class="text-textcolor mt-4">{language.model} <Help key="model"/></span>
    <ModelList bind:value={DBState.db.aiModel}/>

    <span class="text-textcolor mt-2">{language.submodel} <Help key="submodel"/></span>
    <ModelList bind:value={DBState.db.subModel}/>

    {#if modelInfo.provider === LLMProvider.GoogleCloud || subModelInfo.provider === LLMProvider.GoogleCloud}
        <span class="text-textcolor mt-4">GoogleAI API Key <Help key="googleAIKey"/></span>
        <TextInput className="mt-2" marginBottom={true} placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.google.accessToken}/>
    {/if}
    {#if modelInfo.provider === LLMProvider.VertexAI || subModelInfo.provider === LLMProvider.VertexAI}
        <span class="text-textcolor mt-4">Project ID <Help key="vertexProjectId"/></span>
        <TextInput className="mt-2" marginBottom={true} placeholder="..." bind:value={DBState.db.google.projectId} oninput={clearVertexToken}/>
        <span class="text-textcolor">Vertex Client Email <Help key="vertexClientEmail"/></span>
        <TextInput className="mt-2" marginBottom={true} placeholder="..." bind:value={DBState.db.vertexClientEmail} oninput={clearVertexToken}/>
        <span class="text-textcolor">Vertex Private Key <Help key="vertexPrivateKey"/></span>
        <TextInput className="mt-2" marginBottom={true} placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.vertexPrivateKey} oninput={clearVertexToken}/>
        <span class="text-textcolor">Region <Help key="vertexRegion"/></span>
        <SelectInput className="mt-2" value={DBState.db.vertexRegion} onchange={(e) => {
            DBState.db.vertexRegion = e.currentTarget.value
            clearVertexToken()
        }}>
            <OptionInput value={'global'}>
                global
            </OptionInput>
            <OptionInput value={'us-central1'}>
                us-central1
            </OptionInput>
            <OptionInput value={'us-west1'}>
                us-west1
            </OptionInput>
        </SelectInput>    
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelList || subModelInfo.provider === LLMProvider.NovelList}
        <span class="text-textcolor mt-4">NovelList {language.apiKey} <Help key="novellistKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={true} placeholder="..." bind:value={DBState.db.novellistAPI}/>
    {/if}
    {#if DBState.db.aiModel.startsWith('mancer') || DBState.db.subModel.startsWith('mancer')}
        <span class="text-textcolor mt-4">Mancer {language.apiKey} <Help key="mancerKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={true} placeholder="..." bind:value={DBState.db.mancerHeader}/>
    {/if}
    {#if modelInfo.provider === LLMProvider.Anthropic || subModelInfo.provider === LLMProvider.Anthropic
            || modelInfo.provider === LLMProvider.AWS || subModelInfo.provider === LLMProvider.AWS }
        <span class="text-textcolor mt-4">Claude {language.apiKey} <Help key="claudeApiKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={true} placeholder="..." bind:value={DBState.db.claudeAPIKey}/>
    {/if}
    {#if modelInfo.provider === LLMProvider.Mistral || subModelInfo.provider === LLMProvider.Mistral}
        <span class="text-textcolor mt-4">Mistral {language.apiKey} <Help key="mistralKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={true} placeholder="..." bind:value={DBState.db.mistralKey}/>
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
        <span class="text-textcolor mt-4">NovelAI Bearer Token <Help key="novelaiToken"/></span>
        <TextInput className="mt-2" bind:value={DBState.db.novelai.token}/>
    {/if}
    {#if DBState.db.aiModel === 'reverse_proxy' || DBState.db.subModel === 'reverse_proxy'}
        <span class="text-textcolor mt-2">URL <Help key="forceUrl"/></span>
        <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.forceReplaceUrl} placeholder="https//..." />
        <span class="text-textcolor mt-4"> {language.proxyAPIKey} <Help key="proxyAPIKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} placeholder="leave it blank if it hasn't password" bind:value={DBState.db.proxyKey} />
        <span class="text-textcolor mt-4"> {language.proxyRequestModel} <Help key="proxyRequestModel"/></span>
        <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.customProxyRequestModel} placeholder="Name" />
        <span class="text-textcolor mt-4"> {language.format} <Help key="proxyFormat"/></span>
        <SelectInput className="mt-2" value={DBState.db.customAPIFormat.toString()} onchange={(e) => {
            DBState.db.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat
        }}>
            <OptionInput value={LLMFormat.OpenAICompatible.toString()}>
                OpenAI Compatible
            </OptionInput>
            <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>
                OpenAI Response API
            </OptionInput>
            <OptionInput value={LLMFormat.Anthropic.toString()}>
                Anthropic Claude
            </OptionInput>
            <OptionInput value={LLMFormat.Mistral.toString()}>
                Mistral
            </OptionInput>
            <OptionInput value={LLMFormat.GoogleCloud.toString()}>
                Google Cloud
            </OptionInput>
            <OptionInput value={LLMFormat.Cohere.toString()}>
                Cohere
            </OptionInput>
        </SelectInput>
    {/if}
    {#if modelInfo.provider === LLMProvider.Cohere || subModelInfo.provider === LLMProvider.Cohere}
        <span class="text-textcolor mt-4">Cohere {language.apiKey} <Help key="cohereKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.cohereAPIKey} />
    {/if}
    {#if DBState.db.aiModel === 'ollama-hosted'}
        <span class="text-textcolor mt-4">Ollama URL <Help key="ollamaURL"/></span>
        <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.ollamaURL} />

        <span class="text-textcolor mt-4">Ollama Model <Help key="ollamaModel"/></span>
        <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.ollamaModel} />
    {/if}
    {#if DBState.db.aiModel === 'nanogpt' || DBState.db.subModel === 'nanogpt'}
        <span class="text-textcolor mt-4">NanoGPT {language.apiKey} <Help key="nanogptKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.nanogptKey} />

        <NanoGPTDashboard apiKey={DBState.db.nanogptKey} />

        {#if DBState.db.nanogptSubscriptionState === 'active' || DBState.db.nanogptSubscriptionState === 'grace'}
            <div class="flex items-center mt-3">
                <CheckInput bind:check={DBState.db.nanogptUseSubscriptionEndpoint} name={language.nanoGPTUseSubscriptionEndpoint} />
                <Help key="nanoGPTUseSubscriptionEndpoint" />
            </div>
        {/if}

        <span class="text-textcolor mt-4">NanoGPT {language.model} <Help key="nanogptModelMode"/></span>
        <SegmentedControl
            bind:value={nanogptInputMode}
            options={[
                { value: 'list', label: (language as any).nanoGPTSelectFromList || 'Select from List' },
                { value: 'manual', label: (language as any).nanoGPTManualInput || 'Manual Input' }
            ]}
            size="md"
        />

        {#if nanogptInputMode === 'manual'}
            <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.nanogptRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => DBState.db.nanogptRequestModelName = ''}/>
        {:else}
            {#await Promise.all([getNanoGPTModels(), getNanoGPTSubscriptionModels(DBState.db.nanogptKey)])}
                <ModelGrid bind:value={DBState.db.nanogptRequestModel} loading={true} />
            {:then [regular, sub]}
                <ModelGrid
                    bind:value={DBState.db.nanogptRequestModel}
                    items={DBState.db.nanogptUseSubscriptionEndpoint ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                    showSubBadge={DBState.db.nanogptUseSubscriptionEndpoint}
                    selectedLabelOverride={DBState.db.nanogptRequestModel && !DBState.db.nanogptRequestModelName ? DBState.db.nanogptRequestModel : undefined}
                    onselect={(_id, name) => { DBState.db.nanogptRequestModelName = name }}
                />
                {#if !DBState.db.nanogptUseSubscriptionEndpoint}
                    <NanoGPTProviderPicker
                        apiKey={DBState.db.nanogptKey}
                        modelId={DBState.db.nanogptRequestModel}
                        bind:value={DBState.db.nanogptProvider}
                    />
                {/if}
            {/await}
        {/if}
    {/if}
    {#if DBState.db.aiModel === 'openrouter' || DBState.db.subModel === 'openrouter'}
        <span class="text-textcolor mt-4">OpenRouter {language.apiKey} <Help key="openrouterKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.openrouterKey} />

        <span class="text-textcolor mt-4">OpenRouter {language.model} <Help key="openrouterModel"/></span>
        {#await getOpenRouterModels()}
            <ModelGrid bind:value={DBState.db.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
        {:then m}
            <ModelGrid bind:value={DBState.db.openrouterRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
        {/await}
    {/if}
    {#if DBState.db.aiModel === 'openrouter' || DBState.db.aiModel === 'reverse_proxy'}
        <span class="text-textcolor mt-4">{language.tokenizer} <Help key="tokenizer"/></span>
        <SelectInput className="mt-2" bind:value={DBState.db.customTokenizer}>
            {#each tokenizerList as entry}
                <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
            {/each}
        </SelectInput>
    {/if}
    {#if modelInfo.provider === LLMProvider.OpenAI || subModelInfo.provider === LLMProvider.OpenAI}
        <span class="text-textcolor mt-4">OpenAI {language.apiKey} <Help key="oaiapikey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.openAIKey} placeholder="sk-XXXXXXXXXXXXXXXXXXXX"/>
    {/if}

    {#if modelInfo.keyIdentifier}
        <span class="text-textcolor mt-4">{modelInfo.name} {language.apiKey}</span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.OaiCompAPIKeys[modelInfo.keyIdentifier]} placeholder="..."/>
    {/if}

    {#if subModelInfo.keyIdentifier && subModelInfo.keyIdentifier !== modelInfo.keyIdentifier}
        <span class="text-textcolor mt-4">{subModelInfo.name} {language.apiKey}</span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={false} bind:value={DBState.db.OaiCompAPIKeys[subModelInfo.keyIdentifier]} placeholder="..."/>
    {/if}

    <div class="py-2 flex flex-col gap-2 mb-4">
        {#if modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming)}
            <div class="flex items-center">
                <Check bind:check={DBState.db.useStreaming} name={`Response ${language.streaming}`}/>
                <Help key="streaming"/>
            </div>

            {#if DBState.db.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
                <div class="flex items-center">
                    <Check bind:check={DBState.db.streamGeminiThoughts} name={`Stream Gemini Thoughts`}/>
                    <Help key="streamGeminiThoughts"/>
                </div>
            {/if}
        {/if}

        {#if DBState.db.aiModel === 'reverse_proxy' || DBState.db.subModel === 'reverse_proxy'}
            <div class="flex items-center">
                <Check bind:check={DBState.db.reverseProxyOobaMode} name={`${language.reverseProxyOobaMode}`}/>
                <Help key="reverseProxyOobaMode"/>
            </div>
        {/if}
        {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
            <div class="flex items-center">
                <Check bind:check={DBState.db.NAIadventure} name={language.textAdventureNAI}/>
                <Help key="textAdventureNAI"/>
            </div>

            <div class="flex items-center">
                <Check bind:check={DBState.db.NAIappendName} name={language.appendNameNAI}/>
                <Help key="appendNameNAI"/>
            </div>
        {/if}
    </div>

    {#if DBState.db.aiModel === 'custom' || DBState.db.subModel === 'custom'}
        <span class="text-textcolor mt-2">{language.plugin} <Help key="customPlugin"/></span>
        <SelectInput className="mt-2 mb-4" bind:value={DBState.db.currentPluginProvider}>
            <OptionInput value="">None</OptionInput>
            {#each $customProviderStore as plugin}
                <OptionInput value={plugin}>{plugin}</OptionInput>
            {/each}
        </SelectInput>
    {/if}

    {#if DBState.db.aiModel === "kobold" || DBState.db.subModel === "kobold"}
        <span class="text-textcolor mt-4">Kobold URL <Help key="koboldURL"/></span>
        <TextInput className="mt-2" marginBottom={true} bind:value={DBState.db.koboldURL} />
    {/if}

    {#if DBState.db.aiModel === 'echo_model' || DBState.db.subModel === 'echo_model'}
        <span class="text-textcolor mt-2">Echo Message <Help key="echoMessage"/></span>
        <TextAreaInput className="mt-2 mb-4" margin="bottom" bind:value={DBState.db.echoMessage} placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}/>
        <span class="text-textcolor mt-2">Echo Delay (Seconds) <Help key="echoDelay"/></span>
        <NumberInput className="mt-2" marginBottom={true} bind:value={DBState.db.echoDelay} min={0}/>
    {/if}

    {#if DBState.db.aiModel.startsWith("horde") || DBState.db.subModel.startsWith("horde") }
        <span class="text-textcolor mt-4">Horde {language.apiKey} <Help key="hordeKey"/></span>
        <TextInput className="mt-2" hideText={DBState.db.hideApiKey} marginBottom={true} bind:value={DBState.db.hordeConfig.apiKey} />
    {/if}
    {#if DBState.db.aiModel === 'textgen_webui' || DBState.db.subModel === 'textgen_webui'
        || DBState.db.aiModel === 'mancer' || DBState.db.subModel === 'mancer'}
        <span class="text-textcolor mt-2">Blocking {language.providerURL} <Help key="textgenBlockingURL"/></span>
        <TextInput className="mt-2" marginBottom={true} bind:value={DBState.db.textgenWebUIBlockingURL} placeholder="https://..."/>
        <span class="text-draculared text-xs mb-2">You must use textgen webui with --public-api</span>
        <span class="text-textcolor mt-2">Stream {language.providerURL} <Help key="textgenStreamURL"/></span>
        <TextInput className="mt-2" marginBottom={true} bind:value={DBState.db.textgenWebUIStreamURL} placeholder="wss://..."/>
        <span class="text-draculared text-xs mb-2">Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like http://127.0.0.1:5000/v1/chat/completions</span>
    {/if}
    {#if DBState.db.aiModel === 'ooba' || DBState.db.subModel === 'ooba'}
        <span class="text-textcolor mt-2">Ooba {language.providerURL} <Help key="oogaboogaURL"/></span>
        <TextInput className="mt-2" marginBottom={true} bind:value={DBState.db.textgenWebUIBlockingURL} placeholder="https://..."/>
    {/if}
    {#if DBState.db.aiModel.startsWith("horde") || DBState.db.aiModel === 'kobold' }
        <ChatFormatSettings />
    {/if}

    <AuxModelSelectors />
{/if}

{#if $BotSubmenuIndex === 1}
    <ShAlert variant="warning" className="mt-4 mb-2">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {language.botSettingsParamScopeDesc}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.ModelPreset)}>
                {language.modelPresetMenu}
                <ArrowRightIcon size={14} />
            </ShButton>
        {/snippet}
    </ShAlert>
    <!-- Data-driven basic parameters -->
    <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} />
    {#if DBState.db.aiModel === 'textgen_webui' || DBState.db.aiModel === 'mancer' || DBState.db.aiModel.startsWith('local_') || DBState.db.aiModel.startsWith('hf:::')}
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput className="mt-2" min={1} max={1.5} step={0.01} fixed={2} marginBottom bind:value={DBState.db.ooba.repetition_penalty}/>
        <span class="text-textcolor">Length Penalty</span>
        <SliderInput className="mt-2" min={-5} max={5} step={0.05} marginBottom fixed={2} bind:value={DBState.db.ooba.length_penalty}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput className="mt-2" min={0} max={100} step={1} marginBottom bind:value={DBState.db.ooba.top_k} />
        <span class="text-textcolor">Top P</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ooba.top_p}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ooba.typical_p}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ooba.top_a}/>
        <span class="text-textcolor">No Repeat n-gram Size</span>
        <SliderInput className="mt-2" min={0} max={20} step={1} marginBottom bind:value={DBState.db.ooba.no_repeat_ngram_size}/>
        <div class="flex items-center mt-4">
            <Check bind:check={DBState.db.ooba.do_sample} name={'Do Sample'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={DBState.db.ooba.add_bos_token} name={'Add BOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={DBState.db.ooba.ban_eos_token} name={'Ban EOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={DBState.db.ooba.skip_special_tokens} name={'Skip Special Tokens'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check check={!!DBState.db.localStopStrings} name={language.customStopWords} onChange={() => {
                if(!DBState.db.localStopStrings){
                    DBState.db.localStopStrings = []
                }
                else{
                    DBState.db.localStopStrings = null
                }
            }} />
        </div>
        {#if DBState.db.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-primary w-full" onclick={() => {
                        let localStopStrings = DBState.db.localStopStrings
                        localStopStrings.push('')
                        DBState.db.localStopStrings = localStopStrings
                    }}><PlusIcon /></button>
                </div>
                {#each DBState.db.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={DBState.db.localStopStrings[i]} fullwidth fullh/>
                        </div>
                        <div>
                            <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-red-400 w-full" onclick={() => {
                                let localStopStrings = DBState.db.localStopStrings
                                localStopStrings.splice(i, 1)
                                DBState.db.localStopStrings = localStopStrings
                            }}><TrashIcon /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
            <ChatFormatSettings />
        </div>
        <Check bind:check={DBState.db.ooba.formating.useName} name={language.useNamePrefix}/>
    
    {:else if modelInfo.format === LLMFormat.NovelAI}
        <div class="text-textcolor2 text-xs mt-4 mb-2 p-2 rounded-md border border-darkborderc">
            These parameters follow NovelAI's own definitions. See the official NovelAI documentation for details.
        </div>
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <span class="text-textcolor">Starter</span>
            <TextInput className="mt-2" bind:value={DBState.db.NAIsettings.starter} placeholder={'⁂'} />
            <span class="text-textcolor">Seperator</span>
            <TextInput className="mt-2" bind:value={DBState.db.NAIsettings.seperator} placeholder={"\\n"}/>
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.topP}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput className="mt-2" min={0} max={100} step={1} marginBottom bind:value={DBState.db.NAIsettings.topK}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.topA}/>
        <span class="text-textcolor">Tailfree Sampling</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.001} marginBottom fixed={3} bind:value={DBState.db.NAIsettings.tailFreeSampling}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.typicalp}/>
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput className="mt-2" min={0} max={3} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.repetitionPenalty}/>
        <span class="text-textcolor">Repetition Penalty Range</span>
        <SliderInput className="mt-2" min={0} max={8192} step={1} marginBottom fixed={0} bind:value={DBState.db.NAIsettings.repetitionPenaltyRange}/>
        <span class="text-textcolor">Repetition Penalty Slope</span>
        <SliderInput className="mt-2" min={0} max={10} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.repetitionPenaltySlope}/>
        <span class="text-textcolor">Frequency Penalty</span>
        <SliderInput className="mt-2" min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.frequencyPenalty}/>
        <span class="text-textcolor">Presence Penalty</span>
        <SliderInput className="mt-2" min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.presencePenalty}/>
        <span class="text-textcolor">Mirostat LR</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.mirostat_lr}/>
        <span class="text-textcolor">Mirostat Tau</span>
        <SliderInput className="mt-2" min={0} max={6} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.mirostat_tau}/>
        <span class="text-textcolor">Cfg Scale</span>
        <SliderInput className="mt-2" min={1} max={3} step={0.01} marginBottom fixed={2} bind:value={DBState.db.NAIsettings.cfg_scale}/>

    {:else if modelInfo.format === LLMFormat.NovelList}
        <div class="text-textcolor2 text-xs mt-4 mb-2 p-2 rounded-md border border-darkborderc">
            These parameters follow NovelList's own definitions. See the official NovelList documentation for details.
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput className="mt-2" min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ainconfig.top_p}/>
        <span class="text-textcolor">Reputation Penalty</span>
        <SliderInput className="mt-2" min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ainconfig.rep_pen}/>
        <span class="text-textcolor">Reputation Penalty Range</span>
        <SliderInput className="mt-2" min={0} max={2048} step={1} marginBottom fixed={2} bind:value={DBState.db.ainconfig.rep_pen_range}/>
        <span class="text-textcolor">Reputation Penalty Slope</span>
        <SliderInput className="mt-2" min={0} max={10} step={0.1} marginBottom fixed={2} bind:value={DBState.db.ainconfig.rep_pen_slope}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput className="mt-2" min={1} max={500} step={1} marginBottom fixed={2} bind:value={DBState.db.ainconfig.top_k}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ainconfig.top_a}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput className="mt-2" min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={DBState.db.ainconfig.typical_p}/>
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (DBState.db.reverseProxyOobaMode && DBState.db.aiModel === 'reverse_proxy') || (DBState.db.aiModel === 'ooba')}
        <OobaSettings instructionMode={DBState.db.aiModel === 'ooba'} />
    {/if}

    {#if DBState.db.aiModel.startsWith('openrouter')}
        <OpenrouterSettings />
    {/if}

    <!-- Separate Parameters - handled by custom component -->
    <SeparateParametersSection />
{/if}

{#if $BotSubmenuIndex === 2}
    <CustomModelsSettings noAccordion />
{/if}



</SettingPage>
