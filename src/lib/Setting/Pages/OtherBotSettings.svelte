<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShSlider from "src/lib/UI/GUI/ShSlider.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { HardDriveUploadIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { selectSingleFile } from "src/ts/util";
    import { DBState, OtherBotsSubmenuIndex } from 'src/ts/stores.svelte';
    import { saveAsset, globalFetch } from "src/ts/globalApi.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { getCharImage } from "src/ts/characters";
    import { alertError, notifySuccess, notifyError } from "src/ts/alert";



    // wavespeed
    interface WavespeedModel {
        model_id: string;
        name: string;
        base_price: number;
        supportsImageInput: boolean;
        supportsLoras: boolean;
    }
    interface LoraItem {
        path: string;
        scale: number;
    }
    let wavespeedModels = $state<WavespeedModel[]>([]);
    let isWavespeedLoading = $state(false);
    let wavespeedSearchQuery = $state("");
    let wavespeedLoras = $state<LoraItem[]>([
        { path: "", scale: 1.0 },
        { path: "", scale: 1.0 },
        { path: "", scale: 1.0 }
    ]);

    /**
     * Fetch models from WaveSpeed API dynamically
     * https://wavespeed.ai/docs/docs-common-api/models
     */
    async function fetchWavespeedModels() {
        if (!DBState.db.wavespeedImage.key || DBState.db.wavespeedImage.key.trim() === '') {
            notifyError('WaveSpeed API Key not set');
            return [];
        }

        isWavespeedLoading = true;
        try {
            const result = await globalFetch('https://api.wavespeed.ai/api/v3/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${DBState.db.wavespeedImage.key}`
                },
            });

            if (!result.ok || !result.data) {
                notifyError('Failed to fetch WaveSpeed models');
                return;
            }

            let responseData;
            try {
                responseData = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
            } catch (e) {
                notifyError('Failed to parse WaveSpeed response');
                return;
            }

            if (responseData.code !== 200 || !Array.isArray(responseData.data)) {
                notifyError('Invalid WaveSpeed API response');
                return;
            }

            // Filter, transform, and sort models by name
            const filteredModels: WavespeedModel[] = responseData.data
              .filter((model: any) =>
                model.type === 'text-to-image' || model.type === 'image-to-image'
              )
              .map((model: any) => {
                  // Check if model supports LoRAs
                  const supportsLoras = model.api_schema?.api_schemas?.some((schema: any) =>
                    schema.request_schema?.properties?.loras !== undefined
                  ) ?? false;

                  return {
                      model_id: model.model_id,
                      name: model.name,
                      base_price: model.base_price,
                      type: model.type,
                      supportsImageInput: model.type === 'image-to-image',
                      supportsLoras: supportsLoras,
                  };
              })
              .sort((a, b) => a.name.localeCompare(b.model_id));

            wavespeedModels = filteredModels;
            notifySuccess(`Successfully loaded ${filteredModels.length} models`);
        } catch (error) {
            notifyError(`Failed to fetch models: ${error}`);
        } finally {
            isWavespeedLoading = false;
        }
    }

    /**
     * Handle model selection change
     */
    function handleModelChange() {
        const selectedModel = wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model);

        // Reset reference_mode for text-to-image models
        if (selectedModel?.supportsImageInput) {
            DBState.db.wavespeedImage.reference_mode = '';
            DBState.db.wavespeedImage.reference_image = undefined;
            DBState.db.wavespeedImage.reference_base64image = undefined;
        }

        // Reset loras if model doesn't support them
        if (!selectedModel?.supportsLoras) {
            DBState.db.wavespeedImage.loras = undefined;
        }
    }

    /**
     * Get display name for a WaveSpeed model
     * @param model - The model to get display name for
     */
    function getModelDisplayName(model: WavespeedModel): string {
        const imageInputIcon = model.supportsImageInput ? '✓' : '✗';
        const loraIcon = model.supportsLoras ? '✓' : '✗';
        return `${model.name} (price: ${model.base_price}) [${imageInputIcon} Image] [${loraIcon} LoRA]`;
    }

    /**
     * Filter and sort models based on search query
     */
    function getFilteredModels(): WavespeedModel[] {
        if (wavespeedSearchQuery === "") return wavespeedModels;

        const searchTerms = wavespeedSearchQuery.toLowerCase().trim().split(/\s+/);
        return wavespeedModels.filter(model => {
            const modelText = (model.name + " " + model.model_id).toLowerCase();
            return searchTerms.every(term => modelText.includes(term));
        });
    }

    $effect(() => {
        // Sync loras to DB, filtering out empty URLs
        if (DBState.db.wavespeedImage) {
            DBState.db.wavespeedImage.loras = wavespeedLoras
              .filter(item => item.path && item.path.trim() !== "")
              .map(item => ({
                  path: item.path,
                  scale: item.scale
              }));
        }
    });
    // End wavespeed

    async function importComfyWorkflow() {
        const file = await selectSingleFile(['json'])
        if (!file) {
            return
        }
        const text = new TextDecoder().decode(file.data)
        try {
            JSON.parse(text)
        } catch {
            alertError(language.comfyWorkflowInvalidJson)
            return
        }
        DBState.db.comfyConfig.workflow = text
    }

    // Row-layout field descriptor for SettingRowLayout (label + inline help).
    function f(id: string, label: string, helpKey?: string): SettingItem {
        return { id: `otherBots.${id}`, type: 'custom', fallbackLabel: label, helpKey }
    }
</script>

<SettingPage title={language.otherBots}>
<SettingTabs tabs={[
    { label: 'TTS', value: 1 },
    { label: language.emotionImage, value: 2 },
    { label: language.imageGeneration, value: 3 },
]} bind:selected={$OtherBotsSubmenuIndex} />

{#if $OtherBotsSubmenuIndex === 3}
    <div class="flex flex-col [&>*:first-child]:border-t-0 [&>[role=alert]+*]:border-t-0">
        <SettingRowLayout item={f('ob44', `${language.imageGeneration} ${language.provider}`, 'sdProvider')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.sdProvider}>
            <OptionInput value="" >None</OptionInput>
            <OptionInput value="webui" >Stable Diffusion WebUI</OptionInput>
            <OptionInput value="novelai" >Novel AI</OptionInput>
            <OptionInput value="dalle" >Dall-E</OptionInput>
            <OptionInput value="stability" >Stability API</OptionInput>
            <OptionInput value="fal" >Fal.ai</OptionInput>
            <OptionInput value="comfyui" >ComfyUI</OptionInput>
            <OptionInput value="Imagen" >Imagen</OptionInput>
            <OptionInput value="openai-compat" >OpenAI Compatible</OptionInput>
            <OptionInput value="wavespeed" >WaveSpeedAI</OptionInput>

            <!-- Legacy -->
            {#if DBState.db.sdProvider === 'comfy'}
                <OptionInput value="comfy" >ComfyUI (Legacy)</OptionInput>
            {/if}
        </SelectInput>
    {/snippet}
</SettingRowLayout>

        {#if DBState.db.sdProvider === 'webui'}
        <ShAlert variant="warning" className="my-2">{#snippet icon()}<TriangleAlertIcon />{/snippet}You must use WebUI with --api flag</ShAlert>
            <ShAlert variant="warning" className="my-2">{#snippet icon()}<TriangleAlertIcon />{/snippet}You must use WebUI without agpl license or use unmodified version with agpl license to observe the contents of the agpl license.</ShAlert>
            <SettingRowLayout item={f('ob16', `WebUI ${language.providerURL}`, 'webuiUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="https://..." bind:value={DBState.db.webUiUrl}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob1', `Steps`, 'webuiSteps')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={100} bind:value={DBState.db.sdSteps}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob2', `CFG Scale`, 'webuiCFG')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={20} bind:value={DBState.db.sdCFG}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob3', `Width`, 'webuiWidth')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.sdConfig.width}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob4', `Height`, 'webuiHeight')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.sdConfig.height}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob17', `Sampler`, 'webuiSampler')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.sdConfig.sampler_name}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob66', `Enable Hires`, 'webuiEnableHr')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.sdConfig.enable_hr} onCheckedChange={(v) => DBState.db.sdConfig.enable_hr = v} />{/snippet}
</SettingRowLayout>
            {#if DBState.db.sdConfig.enable_hr === true}
                <SettingRowLayout item={f('ob5', `denoising_strength`, 'webuiDenoising')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={10} bind:value={DBState.db.sdConfig.denoising_strength}/>{/snippet}
</SettingRowLayout>
                <SettingRowLayout item={f('ob6', `hr_scale`, 'webuiHrScale')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={10} bind:value={DBState.db.sdConfig.hr_scale}/>{/snippet}
</SettingRowLayout>
                <SettingRowLayout item={f('ob18', `Upscaler`, 'webuiUpscaler')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.sdConfig.hr_upscaler}/>{/snippet}
</SettingRowLayout>
            {/if}
        {/if}

        {#if DBState.db.sdProvider === 'novelai'}
            <SettingRowLayout item={f('ob19', `Novel AI ${language.providerURL}`, 'naiImgUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="https://image.novelai.net" bind:value={DBState.db.NAIImgUrl}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob20', `API Key`, 'naiImgKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="pst-..." bind:value={DBState.db.NAIApiKey}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob45', `Model`, 'naiModel')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgModel}>
                <OptionInput value="nai-diffusion-5-full" >nai-diffusion-5-full</OptionInput>
                <OptionInput value="nai-diffusion-5-full-medium" >nai-diffusion-5-full-medium</OptionInput>
                <OptionInput value="nai-diffusion-5-curated" >nai-diffusion-5-curated</OptionInput>
                <OptionInput value="nai-diffusion-4-5-full" >nai-diffusion-4-5-full</OptionInput>
                <OptionInput value="nai-diffusion-4-5-curated" >nai-diffusion-4-5-curated</OptionInput>
                <OptionInput value="nai-diffusion-4-full" >nai-diffusion-4-full</OptionInput>
                <OptionInput value="nai-diffusion-4-curated-preview" >nai-diffusion-4-curated-preview</OptionInput>
                <OptionInput value="nai-diffusion-3" >nai-diffusion-3</OptionInput>
                <OptionInput value="nai-diffusion-furry-3" >nai-diffusion-furry-3</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob7', `Width`, 'naiWidth')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.NAIImgConfig.width}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob8', `Height`, 'naiHeight')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.NAIImgConfig.height}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('naiSampler', `Sampler`, 'naiSampler')}>
            {#snippet control()}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'
            || DBState.db.NAIImgModel?.startsWith('nai-diffusion-5')}
                <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2m_sde" >DPM++ 2M SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                </SelectInput>
            {:else}
                <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_2s" >DPM++ 2S</OptionInput>
                    <OptionInput value="ddim_v3" >DDIM</OptionInput>
                </SelectInput>
            {/if}
            {/snippet}
            </SettingRowLayout>

            <SettingRowLayout item={f('ob46', `Noise Schedule`, 'naiNoiseSchedule')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.noise_schedule}>
                <OptionInput value="native" >native</OptionInput>
                <OptionInput value="karras" >karras</OptionInput>
                <OptionInput value="exponential" >exponential</OptionInput>
                <OptionInput value="polyexponential" >polyexponential</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob9', `steps`, 'naiSteps')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.NAIImgConfig.steps}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob10', `CFG scale`, 'naiCFG')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.NAIImgConfig.scale}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob11', `CFG rescale`, 'naiCFGRescale')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={1} bind:value={DBState.db.NAIImgConfig.cfg_rescale}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob47', `Image Reference`, 'naiImageReference')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.reference_mode}>
                <OptionInput value="" >None</OptionInput>
                {#if !DBState.db.NAIImgModel?.startsWith('nai-diffusion-5')}
                    <OptionInput value="vibe" >Vibe Trasfer</OptionInput>
                {/if}
                {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'}
                    <OptionInput value="character" >Character Reference</OptionInput>
                {/if}
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            {#if DBState.db.NAIImgConfig.reference_mode === 'vibe'
                && !DBState.db.NAIImgModel?.startsWith('nai-diffusion-5')}
                <div class="relative py-3">
                <button class="mb-4" onclick={async () => {
                    const file = await selectSingleFile(['naiv4vibe'])
                    if(!file){
                        return null
                    }
                    try {
                        const vibeData = JSON.parse(new TextDecoder().decode(file.data))
                        if (vibeData.version !== 1 || vibeData.identifier !== "novelai-vibe-transfer") {
                            alertError("Invalid vibe file. Version must be 1.")
                            return
                        }

                        // Store the vibe data
                        DBState.db.NAIImgConfig.vibe_data = vibeData

                        // Set the thumbnail as preview image for display
                        if (vibeData.thumbnail) {
                            // Clear the array and add the thumbnail
                            DBState.db.NAIImgConfig.reference_image_multiple = [];

                            // Set default model selection based on current model
                            if (DBState.db.NAIImgModel.includes('nai-diffusion-4-full')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4full';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-curated')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4curated';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-full')) { 
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5full';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5curated';
                            }

                            // Set InfoExtracted to the first value for the selected model
                            const selectedModel = DBState.db.NAIImgConfig.vibe_model_selection;
                            if (selectedModel && vibeData.encodings[selectedModel]) {
                                const encodings = vibeData.encodings[selectedModel];
                                const firstKey = Object.keys(encodings)[0];
                                if (firstKey) {
                                    DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                                }
                            }
                        }

                        // Initialize reference_strength_multiple if not set
                        if (!DBState.db.NAIImgConfig.reference_strength_multiple || !Array.isArray(DBState.db.NAIImgConfig.reference_strength_multiple)) {
                            DBState.db.NAIImgConfig.reference_strength_multiple = [0.7];
                        }
                    } catch (error) {
                        alertError("Error parsing vibe file: " + error)
                    }
                }}>
                    {#if !DBState.db.NAIImgConfig.vibe_data || !DBState.db.NAIImgConfig.vibe_data.thumbnail}
                        <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                            <span class="text-sm">Upload<br />Vibe</span>
                        </div>
                    {:else}
                        <img src={DBState.db.NAIImgConfig.vibe_data.thumbnail} alt="Vibe Preview" class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" />
                    {/if}
                </button>

                {#if DBState.db.NAIImgConfig.vibe_data}
                    <button 
                        onclick={() => {
                            DBState.db.NAIImgConfig.vibe_data = undefined;
                            DBState.db.NAIImgConfig.vibe_model_selection = undefined;
                        }}
                        class="absolute top-2 right-2 bg-draculared/80 hover:bg-draculared text-white text-xs font-medium py-1 px-2 rounded-md"
                    >
                        Delete
                    </button>
                {/if}

                </div>

                {#if DBState.db.NAIImgConfig.vibe_data}

                    <SettingRowLayout item={f('ob48', `Vibe Model`, 'naiVibeModel')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.vibe_model_selection} onchange={(e) => {
                        // When vibe model changes, set InfoExtracted to the first value
                        if (DBState.db.NAIImgConfig.vibe_data?.encodings &&
                            DBState.db.NAIImgConfig.vibe_model_selection &&
                            DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) {
                            const encodings = DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection];
                            const firstKey = Object.keys(encodings)[0];
                            if (firstKey) {
                                DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                            }
                        }
                    }}>
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4full}
                            <OptionInput value="v4full">nai-diffusion-4-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4curated}
                            <OptionInput value="v4curated">nai-diffusion-4-curated</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5full']}
                            <OptionInput value="v4-5full">nai-diffusion-4-5-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5curated']}
                            <OptionInput value="v4-5curated">nai-diffusion-4-5-curated</OptionInput>
                        {/if}
                    </SelectInput>
    {/snippet}
</SettingRowLayout>

                    <SettingRowLayout item={f('ob49', `Information Extracted`, 'naiInfoExtracted')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.NAIImgConfig.InfoExtracted}>
                        {#if DBState.db.NAIImgConfig.vibe_model_selection && DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]}
                            {#each Object.entries(DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) as [key, value]}
                                <OptionInput value={value.params.information_extracted}>{value.params.information_extracted}</OptionInput>
                            {/each}
                        {/if}
                    </SelectInput>
    {/snippet}
</SettingRowLayout>

                    <SettingRowLayout item={f('ob61', `Reference Strength Multiple`, 'naiRefStrength')} wideControl>
    {#snippet control()}<div class="w-full sm:w-48"><ShSlider inputWidth="w-16" min={0} max={1} step={0.1} bind:value={DBState.db.NAIImgConfig.reference_strength_multiple[0]} /></div>{/snippet}
</SettingRowLayout>
                {/if}
            {/if}

            {#if DBState.db.NAIImgConfig.reference_mode === 'character' && 
                (DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated')}
                
                <div class="relative py-3">
                    <button class="mb-2" onclick={async () => {
                        const img = await selectSingleFile([
                            'jpg',
                            'jpeg',
                            'png',
                            'webp'
                        ])
                        if(!img){
                            return null
                        }
                        
                        const imageData = img.data;
                        
                        DBState.db.NAIImgConfig.character_base64image = Buffer.from(imageData).toString('base64');
                        const saveId = await saveAsset(imageData)
                        DBState.db.NAIImgConfig.character_image = saveId
                        console.log('Character image set:', DBState.db.NAIImgConfig.character_image)
                    }}>
                        {#if !DBState.db.NAIImgConfig.character_image || DBState.db.NAIImgConfig.character_image === ''}
                            <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                <span class="text-sm">Upload<br />Image</span>
                            </div>
                        {:else}
                            {#await getCharImage(DBState.db.NAIImgConfig.character_image, 'plain')}
                                <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Uploading<br />Image..</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                            {/await}
                        {/if}
                    </button>

                    {#if DBState.db.NAIImgConfig.character_image && DBState.db.NAIImgConfig.character_image !== ''}
                        <button 
                            onclick={() => {
                                DBState.db.NAIImgConfig.character_image = undefined;
                                DBState.db.NAIImgConfig.character_base64image = undefined;
                            }}
                            class="absolute top-2 right-2 bg-draculared/80 hover:bg-draculared text-white text-xs font-medium py-1 px-2 rounded-md"
                        >
                            Delete
                        </button>
                    {/if}
                </div>
                
                <p class="text-xs text-textcolor2 py-2">Leave blank to use the character's default image.</p>

                <SettingRowLayout item={f('ob67', `Style Aware`, 'naiStyleAware')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.style_aware} onCheckedChange={(v) => DBState.db.NAIImgConfig.style_aware = v} />{/snippet}
</SettingRowLayout>

            {/if}




            {#if (DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2')
            && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingRowLayout item={f('ob68', `Use SMEA`, 'naiUseSMEA')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.sm} onCheckedChange={(v) => DBState.db.NAIImgConfig.sm = v} />{/snippet}
</SettingRowLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingRowLayout item={f('ob69', `Use DYN`, 'naiUseDYN')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.sm_dyn} onCheckedChange={(v) => DBState.db.NAIImgConfig.sm_dyn = v} />{/snippet}
</SettingRowLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3'}
                <SettingRowLayout item={f('ob70', `Variety+`, 'naiVarietyPlus')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.variety_plus} onCheckedChange={(v) => DBState.db.NAIImgConfig.variety_plus = v} />{/snippet}
</SettingRowLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2'}
                <SettingRowLayout item={f('ob71', `Decrisp`, 'naiDecrisp')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.decrisp} onCheckedChange={(v) => DBState.db.NAIImgConfig.decrisp = v} />{/snippet}
</SettingRowLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'}
                <SettingRowLayout item={f('ob72', `Use legacy uc`, 'naiLegacyUC')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIImgConfig.legacy_uc} onCheckedChange={(v) => DBState.db.NAIImgConfig.legacy_uc = v} />{/snippet}
</SettingRowLayout>
            {/if}

            <SettingRowLayout item={f('ob73', `Enable I2I`, 'naiEnableI2I')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAII2I} onCheckedChange={(v) => DBState.db.NAII2I = v} />{/snippet}
</SettingRowLayout>
            
            {#if DBState.db.NAII2I}
                <div class="relative py-3">
                    <button class="mb-2" onclick={async () => {
                        const img = await selectSingleFile([
                            'jpg',
                            'jpeg',
                            'png',
                            'webp'
                        ])
                        if(!img){
                            return null
                        }
                        DBState.db.NAIImgConfig.base64image = Buffer.from(img.data).toString('base64');
                        const saveId = await saveAsset(img.data)
                        DBState.db.NAIImgConfig.image = saveId
                    }}>
                        {#if !DBState.db.NAIImgConfig.image || DBState.db.NAIImgConfig.image === ''}
                            <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                <span class="text-sm">Upload<br />Image</span>
                            </div>
                        {:else}
                            {#await getCharImage(DBState.db.NAIImgConfig.image, 'plain')}
                                <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Uploading<br />Image..</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                            {/await}
                        {/if}
                    </button>

                    {#if DBState.db.NAIImgConfig.image && DBState.db.NAIImgConfig.image !== ''}
                        <button 
                            onclick={() => {
                                DBState.db.NAIImgConfig.image = undefined;
                                DBState.db.NAIImgConfig.base64image = undefined;
                            }}
                            class="absolute top-2 right-2 bg-draculared/80 hover:bg-draculared text-white text-xs font-medium py-1 px-2 rounded-md"
                        >
                            Delete
                        </button>
                    {/if}
                </div>
                <p class="text-xs text-textcolor2 py-2">Leave blank to use the character's default image.</p>


                <SettingRowLayout item={f('ob62', `Strength`)} wideControl>
    {#snippet control()}<div class="w-full sm:w-48"><ShSlider inputWidth="w-16" min={0} max={0.99} step={0.01} bind:value={DBState.db.NAIImgConfig.strength} /></div>{/snippet}
</SettingRowLayout>
                <SettingRowLayout item={f('ob63', `Noise`)} wideControl>
    {#snippet control()}<div class="w-full sm:w-48"><ShSlider inputWidth="w-16" min={0} max={0.99} step={0.01} bind:value={DBState.db.NAIImgConfig.noise} /></div>{/snippet}
</SettingRowLayout>


            {/if}
        {/if}

         
        
        {#if DBState.db.sdProvider === 'dalle'}
            <SettingRowLayout item={f('ob21', `OpenAI API Key`, 'dalleKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="sk-..." bind:value={DBState.db.openAIKey}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob50', `Dall-E Quality`, 'dalleQuality')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.dallEQuality}>
                <OptionInput value="standard" >Standard</OptionInput>
                <OptionInput value="hd" >HD</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

        {/if}

        {#if DBState.db.sdProvider === 'stability'}
            <SettingRowLayout item={f('ob22', `Stability API Key`, 'stabilityKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." bind:value={DBState.db.stabilityKey}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob51', `Stability Model`, 'stabilityModel')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.stabilityModel}>
                <OptionInput value="ultra" >SD Ultra</OptionInput>
                <OptionInput value="core" >SD Core</OptionInput>
                <OptionInput value="sd3-large" >SD3 Large</OptionInput>
                <OptionInput value="sd3-medium" >SD3 Medium</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            {#if DBState.db.stabilityModel === 'core'}
                <SettingRowLayout item={f('ob52', `SD Core Style`, 'stabilityCoreStyle')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.stabllityStyle}>
                    <OptionInput value="" >Unspecified</OptionInput>
                    <OptionInput value="3d-model" >3D Model</OptionInput>
                    <OptionInput value="analog-film" >Analog Film</OptionInput>
                    <OptionInput value="anime" >Anime</OptionInput>
                    <OptionInput value="cinematic" >Cinematic</OptionInput>
                    <OptionInput value="comic-book" >Comic Book</OptionInput>
                    <OptionInput value="digital-art" >Digital Art</OptionInput>
                    <OptionInput value="enhance" >Enhance</OptionInput>
                    <OptionInput value="fantasy-art" >Fantasy Art</OptionInput>
                    <OptionInput value="isometric" >Isometric</OptionInput>
                    <OptionInput value="line-art" >Line Art</OptionInput>
                    <OptionInput value="low-poly" >Low Poly</OptionInput>
                    <OptionInput value="modeling-compound" >Modeling Compound</OptionInput>
                    <OptionInput value="neon-punk" >Neon Punk</OptionInput>
                    <OptionInput value="origami" >Origami</OptionInput>
                    <OptionInput value="photographic" >Photographic</OptionInput>
                    <OptionInput value="pixel-art" >Pixel Art</OptionInput>
                    <OptionInput value="tile-texture" >Tile Texture</OptionInput>
                </SelectInput>
    {/snippet}
</SettingRowLayout>
            {/if}
        {/if}

        {#if DBState.db.sdProvider === 'comfyui'}
            <SettingRowLayout item={f('ob23', `ComfyUI ${language.providerURL}`, 'comfyUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="http://127.0.0.1:8188" bind:value={DBState.db.comfyUiUrl}/>{/snippet}
</SettingRowLayout>

            <div class="py-3 border-t border-darkborderc flex flex-col">
                <SettingFieldLabel label={language.comfyWorkflow} helpKey="comfyWorkflow" />
                <TextAreaInput className="mt-2" bind:value={DBState.db.comfyConfig.workflow}/>
                <div class="mt-2 flex">
                    <ShButton variant="outline" size="sm" onclick={importComfyWorkflow}>
                        <HardDriveUploadIcon />{language.settingActionImport}
                    </ShButton>
                </div>
            </div>

            <SettingRowLayout item={f('ob12', `Timeout (sec)`, 'comfyTimeout')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding bind:value={DBState.db.comfyConfig.timeout} min={1} max={120}/>{/snippet}
</SettingRowLayout>
        {/if}

        {#if DBState.db.sdProvider === 'comfy'}
            <ShAlert variant="warning" className="my-2">{#snippet icon()}<TriangleAlertIcon />{/snippet}The first image generated by the prompt will be selected.</ShAlert>
            <SettingRowLayout item={f('ob25', `ComfyUI ${language.providerURL}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="http://127.0.0.1:8188" bind:value={DBState.db.comfyUiUrl}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob26', `Workflow`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="valid ComfyUI API json (Enable Dev mode Options in ComfyUI)" bind:value={DBState.db.comfyConfig.workflow}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob27', `Positive Text Node: ID`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="eg. 1, 3, etc" bind:value={DBState.db.comfyConfig.posNodeID}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob28', `Positive Text Node: Input Field Name`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="eg. text" bind:value={DBState.db.comfyConfig.posInputName}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob29', `Negative Text Node: ID`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="eg. 1, 3, etc" bind:value={DBState.db.comfyConfig.negNodeID}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob30', `Positive Text Node: Input Field Name`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="eg. text" bind:value={DBState.db.comfyConfig.negInputName}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob13', `Timeout (sec)`)}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding bind:value={DBState.db.comfyConfig.timeout} min={1} max={120}/>{/snippet}
</SettingRowLayout>
        {/if}

        {#if DBState.db.sdProvider === 'fal'}
            <SettingRowLayout item={f('ob31', `Fal.ai API Key`, 'falKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." bind:value={DBState.db.falToken}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob14', `Width`, 'falWidth')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.sdConfig.width}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('ob15', `Height`, 'falHeight')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding min={0} max={2048} bind:value={DBState.db.sdConfig.height}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob53', `Model`, 'falModel')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.falModel}>
                <OptionInput value="fal-ai/flux/dev" >Flux[Dev]</OptionInput>
                <OptionInput value="fal-ai/flux-lora" >Flux[Dev] with Lora</OptionInput>
                <OptionInput value="fal-ai/flux-pro" >Flux[Pro]</OptionInput>
                <OptionInput value="fal-ai/flux/schnell" >Flux[Schnell]</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            {#if DBState.db.falModel === 'fal-ai/flux-lora'}
                <SettingRowLayout item={f('ob32', `Lora Model URL`, 'urllora')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.falLora}/>{/snippet}
</SettingRowLayout>

                <SettingRowLayout item={f('ob64', `Lora Weight`, 'falLoraWeight')} wideControl>
    {#snippet control()}<div class="w-full sm:w-48"><ShSlider inputWidth="w-16"  min={0}  max={2} step={0.01} bind:value={DBState.db.falLoraScale} /></div>{/snippet}
</SettingRowLayout>
            {/if}


        {/if}

        {#if DBState.db.sdProvider === 'Imagen'}
            <SettingRowLayout item={f('ob33', `GoogleAI API Key`, 'imagenKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.google.accessToken}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob54', `Model`, 'imagenModel')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.ImagenModel}>
                <OptionInput value="imagen-4.0-generate-001" >Imagen 4</OptionInput>
                <OptionInput value="imagen-4.0-ultra-generate-001" >Imagen 4 Ultra</OptionInput>
                <OptionInput value="imagen-4.0-fast-generate-001" >Imagen 4 Fast</OptionInput>
                <OptionInput value="imagen-3.0-generate-002" >Imagen 3.0</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            {#if DBState.db.ImagenModel === 'imagen-4.0-generate-001' || DBState.db.ImagenModel === 'imagen-4.0-ultra-generate-001'}
                <SettingRowLayout item={f('ob55', `Image size`, 'imagenImageSize')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.ImagenImageSize}>
                    <OptionInput value="1K" >1K</OptionInput>
                    <OptionInput value="2K" >2K</OptionInput>
                </SelectInput>
    {/snippet}
</SettingRowLayout>
            {/if}

            <SettingRowLayout item={f('ob56', `Aspect ratio`, 'imagenAspectRatio')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.ImagenAspectRatio}>
                <OptionInput value="1:1" >1:1</OptionInput>
                <OptionInput value="3:4" >3:4</OptionInput>
                <OptionInput value="4:3" >4:3</OptionInput>
                <OptionInput value="9:16" >9:16</OptionInput>
                <OptionInput value="16:9" >16:9</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob57', `Person generation`, 'imagenPersonGeneration')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.ImagenPersonGeneration}>
                <OptionInput value="allow_all" >Allow all</OptionInput>
                <OptionInput value="allow_adult" >Allow adult</OptionInput>
                <OptionInput value="dont_allow" >Don't allow</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>
        {/if}

        {#if DBState.db.sdProvider === 'openai-compat'}
            <SettingRowLayout item={f('ob34', `API URL`, 'oaiImgUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="https://api.example.com/v1/images/generations" bind:value={DBState.db.openaiCompatImage.url}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob35', `API Key`, 'oaiImgKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="sk-..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.openaiCompatImage.key}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob36', `Model`, 'oaiImgModel')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="dall-e-3" bind:value={DBState.db.openaiCompatImage.model}/>{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob58', `Image Size`, 'oaiImgSize')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.openaiCompatImage.size}>
                <OptionInput value="1024x1024" >1024x1024</OptionInput>
                <OptionInput value="1536x1024" >1536x1024</OptionInput>
                <OptionInput value="1024x1536" >1024x1536</OptionInput>
                <OptionInput value="512x512" >512x512</OptionInput>
                <OptionInput value="256x256" >256x256</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('ob59', `Quality`, 'oaiImgQuality')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.openaiCompatImage.quality}>
                <OptionInput value="auto" >Auto</OptionInput>
                <OptionInput value="low" >Low</OptionInput>
                <OptionInput value="medium" >Medium</OptionInput>
                <OptionInput value="high" >High</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>
        {/if}

        {#if DBState.db.sdProvider === 'wavespeed'}
            <SettingRowLayout item={f('ob37', `API Key`, 'waveKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="sk-..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.wavespeedImage.key}/>{/snippet}
</SettingRowLayout>

            <div class="py-3 border-t border-darkborderc flex flex-col gap-2">
            <SettingFieldLabel label={'Model'} helpKey="waveModel" />
            <div class="flex gap-2 items-center">
                <TextInput
                  className="h-8 grow"
                  size="sm"
                  padding
                  bind:value={wavespeedSearchQuery}
                  placeholder="Search models..."
                />
                <ShButton variant="outline" size="sm" className="shrink-0" disabled={isWavespeedLoading} onclick={fetchWavespeedModels}>
                    {isWavespeedLoading ? 'Loading...' : 'Refresh Models'}
                </ShButton>
            </div>
            <SelectInput size="sm" bind:value={DBState.db.wavespeedImage.model} onchange={handleModelChange}>
                <OptionInput value="" >Select a model...</OptionInput>
                {#if wavespeedModels.length > 0}
                    {#each getFilteredModels() as model}
                        <OptionInput value={model.model_id}>
                            {getModelDisplayName(model)}
                        </OptionInput>
                    {/each}
                {:else if DBState.db.wavespeedImage.model}
                    <OptionInput value={DBState.db.wavespeedImage.model}> {DBState.db.wavespeedImage.model} </OptionInput>
                {/if}
            </SelectInput>
            </div>

            <div class="pt-3 border-t border-darkborderc flex flex-col"><SettingFieldLabel label={'LoRAs'} helpKey="waveLoras" /></div>
            {#if wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model)?.supportsLoras}
                {#each wavespeedLoras as lora, index}
                    <div class="flex flex-col gap-2 mt-2">
                        <TextInput
                          className="h-8"
                          size="sm"
                          padding
                          fullwidth
                          placeholder={`LoRA ${index + 1} URL (optional)`}
                          bind:value={lora.path}
                        />
                        <ShSlider inputWidth="w-16" min={0} max={4} step={0.1} bind:value={lora.scale} />
                    </div>
                {/each}
                <p class="text-xs text-textcolor2 py-2">
                    Only .safetensors files are supported. Use owner/model-name (Hugging Face) or direct URL (Civitai).
                </p>
            {:else}
                <p class="text-xs text-textcolor2 py-2">
                    Model does not support LoRA. Or refresh model list to update model status.
                </p>
            {/if}

            <div class="pt-3 border-t border-darkborderc flex flex-col"><SettingFieldLabel label={'Image Reference'} helpKey="waveImageReference" /></div>
            {#if wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model)?.supportsImageInput}
                <SelectInput className="mt-2 mb-2 w-full sm:w-48" size="sm" bind:value={DBState.db.wavespeedImage.reference_mode}>
                    <OptionInput value="" >None</OptionInput>
                    <OptionInput value="image" >Upload Image</OptionInput>
                    <OptionInput value="character" >Use Character Image</OptionInput>
                </SelectInput>

                {#if DBState.db.wavespeedImage.reference_mode === 'image'}
                    <div class="relative py-3">
                        <button class="mb-2" onclick={async () => {
                            const img = await selectSingleFile([
                                'jpg',
                                'jpeg',
                                'png',
                                'webp'
                            ])
                            if(!img){
                                return null
                            }

                            const imageData = img.data;

                            DBState.db.wavespeedImage.reference_base64image = Buffer.from(imageData).toString('base64');
                            const saveId = await saveAsset(imageData)
                            DBState.db.wavespeedImage.reference_image = saveId
                            console.log('Character image set:', DBState.db.wavespeedImage.reference_image)
                        }}>
                            {#if !DBState.db.wavespeedImage.reference_image || DBState.db.wavespeedImage.reference_image === ''}
                                <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Upload<br />Image</span>
                                </div>
                            {:else}
                                {#await getCharImage(DBState.db.wavespeedImage.reference_image, 'plain')}
                                    <div class="rounded-md h-20 w-20 border border-dashed border-darkborderc bg-darkbg text-textcolor2 cursor-pointer hover:border-primary hover:text-primary flex items-center justify-center">
                                        <span class="text-sm">Uploading<br />Image..</span>
                                    </div>
                                {:then im}
                                    <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                                {/await}
                            {/if}
                        </button>

                        {#if DBState.db.wavespeedImage.reference_image && DBState.db.wavespeedImage.reference_image !== ''}
                            <button
                              onclick={() => {
                                    DBState.db.wavespeedImage.reference_image = undefined;
                                    DBState.db.wavespeedImage.reference_base64image = undefined;
                                }}
                              class="absolute top-2 right-2 bg-draculared/80 hover:bg-draculared text-white text-xs font-medium py-1 px-2 rounded-md"
                            >
                                Delete
                            </button>
                        {/if}
                    </div>
                {/if}
                {#if DBState.db.wavespeedImage.reference_mode === 'character'}
                    <p class="text-xs text-textcolor2 py-2">Use the character's default image.</p>
                {/if}
            {:else}
                <p class="text-xs text-textcolor2 py-2">
                    Model does not support image input. Or refresh model list to update model status.
                </p>
            {/if}
        {/if}
    </div>
{/if}

{#if $OtherBotsSubmenuIndex === 1}
<div class="flex flex-col [&>*:first-child]:border-t-0 [&>[role=alert]+*]:border-t-0">
    <SettingRowLayout item={f('ob65', `Auto Speech`, 'ttsAutoSpeech')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.ttsAutoSpeech} onCheckedChange={(v) => DBState.db.ttsAutoSpeech = v} />{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob38', `ElevenLabs API key`, 'ttsElevenLabsKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.elevenLabKey}/>{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob39', `VOICEVOX URL`, 'ttsVoicevoxUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.voicevoxUrl}/>{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob40', `OpenAI Key`, 'ttsOpenAIKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.openAIKey}/>{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob41', `NovelAI API key`, 'ttsNAIKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="pst-..." bind:value={DBState.db.NAIApiKey}/>{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob42', `Huggingface Key`, 'ttsHuggingfaceKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.huggingfaceKey} placeholder="hf_..."/>{/snippet}
</SettingRowLayout>

    <SettingRowLayout item={f('ob43', `fish-speech API Key`, 'ttsFishSpeechKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.fishSpeechKey}/>{/snippet}
</SettingRowLayout>

</div>
{/if}

{#if $OtherBotsSubmenuIndex === 2}
<div class="flex flex-col [&>*:first-child]:border-t-0 [&>[role=alert]+*]:border-t-0">
    <SettingRowLayout item={f('ob60', `${language.emotionMethod}`, 'emotionMethod')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.emotionProcesser}>
        <OptionInput value="submodel" >Ax. Model</OptionInput>
        <OptionInput value="embedding" >MiniLM-L6-v2</OptionInput>
    </SelectInput>
    {/snippet}
</SettingRowLayout>
</div>
{/if}

</SettingPage>
