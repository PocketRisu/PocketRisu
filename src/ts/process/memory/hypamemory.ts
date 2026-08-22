import { globalFetch } from "src/ts/globalApi.svelte";
import { runEmbedding } from "../transformers";
import { appendLastPath } from "src/ts/util";
import { getDatabase } from "src/ts/storage/database.svelte";
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "src/ts/storage/persistentKv";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { isLocalNetworkUrl } from "src/ts/network/localNetwork";

export type HypaModel = 'custom'|'ada'|'openai3small'|'openai3large'|'MiniLM'|'MiniLMGPU'|'nomic'|'nomicGPU'|'bgeSmallEn'|'bgeSmallEnGPU'|'bgem3'|'bgem3GPU'|'multiMiniLM'|'multiMiniLMGPU'|'bgeM3Ko'|'bgeM3KoGPU'|'voyageContext3'

// In a typical environment, bge-m3 is a heavy model.
// If your GPU can't handle this model, you'll see errror below.
// Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost
export const localModels = {
    models: {
        'MiniLM':'Xenova/all-MiniLM-L6-v2',
        'MiniLMGPU': "Xenova/all-MiniLM-L6-v2",
        'nomic':'nomic-ai/nomic-embed-text-v1.5',
        'nomicGPU':'nomic-ai/nomic-embed-text-v1.5',
        'bgeSmallEn': 'Xenova/bge-small-en-v1.5',
        'bgeSmallEnGPU': 'Xenova/bge-small-en-v1.5',
        'bgem3': 'Xenova/bge-m3',
        'bgem3GPU': 'Xenova/bge-m3',
        'multiMiniLM': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        'multiMiniLMGPU': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        'bgeM3Ko': 'HyperBlaze/BGE-m3-ko',
        'bgeM3KoGPU': 'HyperBlaze/BGE-m3-ko',
    },
    gpuModels:[
        'MiniLMGPU',
        'nomicGPU',
        'bgeSmallEnGPU',
        'bgem3GPU',
        'multiMiniLMGPU',
        'bgeM3KoGPU',
    ]
}

// Shared embedding vector cache across all HypaProcesser instances
export const hypaVectorCache = new Map<string, memoryVector>();
const hypaVectorCachePrefix = 'cache/hypa-vector/';

export async function getPersistedHypaVector(cacheKey: string): Promise<memoryVector | undefined> {
    if (hypaVectorCache.has(cacheKey)) {
        return hypaVectorCache.get(cacheKey)
    }
    const storageKey = await makeHashedStorageKey(hypaVectorCachePrefix, cacheKey)
    const payload = await readPersistentJson<{ key: string, value: memoryVector }>(storageKey)
    if (!payload || payload.key !== cacheKey) {
        return undefined
    }
    hypaVectorCache.set(cacheKey, payload.value)
    return payload.value
}

export async function setPersistedHypaVector(cacheKey: string, value: memoryVector) {
    const normalizedValue: memoryVector = {
        ...value,
        embedding: Array.from(value.embedding)
    }
    hypaVectorCache.set(cacheKey, normalizedValue)
    const storageKey = await makeHashedStorageKey(hypaVectorCachePrefix, cacheKey)
    await writePersistentJson(storageKey, {
        key: cacheKey,
        value: normalizedValue
    })
}

export class HypaProcesser{
    oaikey:string
    vectors:memoryVector[]
    model:HypaModel
    customEmbeddingUrl:string

    constructor(model:HypaModel|'auto' = 'auto',customEmbeddingUrl?:string){
        this.vectors = []
        const db = getDatabase()
        if(model === 'auto'){
            this.model = db.hypaModel || 'MiniLM'
        }
        else{
            this.model = model
        }
        this.customEmbeddingUrl = customEmbeddingUrl?.trim() || db.hypaCustomSettings?.url?.trim() || ""
    }

    async embedDocuments(texts: string[]): Promise<VectorArray[]> {
        const subPrompts = chunkArray(texts,50);
    
        const embeddings: VectorArray[] = [];
    
        for (let i = 0; i < subPrompts.length; i += 1) {
          const input = subPrompts[i];
    
          const data = await this.getEmbeds(input, 'document')

          embeddings.push(...data);
        }
    
        return embeddings;
    }
    
    
    async getEmbeds(input:string[]|string, inputType:'query'|'document' = 'query'):Promise<VectorArray[]> {
        if(isContextModel(this.model)){
            const provider = getContextProvider(this.model)
            const inputs:string[] = Array.isArray(input) ? input : [input]
            if(inputType === 'query'){
                return await provider.embedQueries(inputs)
            }
            const groups = inputs.map(s => [s])
            const results = await provider.embedDocumentGroups(groups)
            return results.map(group => group[0])
        }
        if(Object.keys(localModels.models).includes(this.model)){
            const inputs:string[] = Array.isArray(input) ? input : [input]
            let results:Float32Array[] = await runEmbedding(inputs, localModels.models[this.model], localModels.gpuModels.includes(this.model) ? 'webgpu' : 'wasm')
            return results
        }
        let gf = null;
        if(this.model === 'custom'){
            if(!this.customEmbeddingUrl){
                throw new Error('Custom model requires a Custom Server URL')
            }
            const {customEmbeddingUrl} = this
            const replaceUrl = customEmbeddingUrl.endsWith('/embeddings')?customEmbeddingUrl:appendLastPath(customEmbeddingUrl,'embeddings')

            const db = getDatabase()
            const fetchArgs = {
                headers: {
                    ...(db.hypaCustomSettings?.key?.trim() ? {"Authorization": "Bearer " + db.hypaCustomSettings.key.trim()} : {})
                },
                body: {
                    "input": input,
                    ...(db.hypaCustomSettings?.model?.trim() ? {"model": db.hypaCustomSettings.model.trim()} : {})
                }
            };
 
            const localNetworkOpts = isLocalNetworkUrl(replaceUrl.toString()) ? { networkRoute: 'local_network' as const } : {};
            gf = await globalFetch(replaceUrl.toString(), { ...fetchArgs, ...localNetworkOpts, logCategory: 'embedding', logSource: 'memory' })
        }
        if(this.model === 'ada' || this.model === 'openai3small' || this.model === 'openai3large'){
            const db = getDatabase()
            const models = {
                'ada':'text-embedding-ada-002',
                'openai3small':'text-embedding-3-small',
                'openai3large':'text-embedding-3-large'
            }

            gf = await globalFetch("https://api.openai.com/v1/embeddings", {
                logCategory: 'embedding',
                logSource: 'memory',
                headers: {
                    "Authorization": "Bearer " + (this.oaikey?.trim() || db.supaMemoryKey?.trim())
                },
                body: {
                    "input": input,
                    "model": models[this.model]
                }
            })
        }
        const data = gf.data
    
    
        if(!gf.ok){
            throw JSON.stringify(gf.data)
        }
    
        const result:number[][] = []
        for(let i=0;i<data.data.length;i++){
            result.push(data.data[i].embedding)
        }
    
        return result
    }

    async testText(text:string){
        const cached = await getPersistedHypaVector(text)
        if(cached){
            return cached.embedding
        }
        const vec = (await this.embedDocuments([text]))[0]
        await setPersistedHypaVector(text, { content: text, embedding: vec as number[] })
        return vec
    }
    
    async addText(texts:string[]) {
        const db = getDatabase()
        const suffix = (this.model === 'custom' && db.hypaCustomSettings?.model?.trim()) ? `-${db.hypaCustomSettings.model.trim()}` : ""

        for(let i=0;i<texts.length;i++){
            const itm = await getPersistedHypaVector(texts[i] + '|' + this.model + suffix)
            if(itm){
                itm.alreadySaved = true
                this.vectors.push(itm)
            }
        }

        texts = texts.filter((v) => {
            for(let i=0;i<this.vectors.length;i++){
                if(this.vectors[i].content === v){
                    return false
                }
            }
            return true
        })

        if(texts.length === 0){
            return
        }
        const vectors = await this.embedDocuments(texts)

        const memoryVectors:memoryVector[] = vectors.map((embedding, idx) => ({
            content: texts[idx],
            embedding
        }));

        for(let i=0;i<memoryVectors.length;i++){
            const vec = memoryVectors[i]
            if(!vec.alreadySaved){
                await setPersistedHypaVector(texts[i] + '|' + this.model + suffix, vec)
            }
        }

        this.vectors = memoryVectors.concat(this.vectors)
    }

    async similaritySearch(query: string) {
        const results = await this.similaritySearchVectorWithScore((await this.getEmbeds(query))[0],);
        return results.map((result) => result[0]);
    }

    async similaritySearchScored(query: string) {
        return await this.similaritySearchVectorWithScore((await this.getEmbeds(query))[0],);
    }

    private similaritySearchVectorWithScore(
        query: VectorArray,
      ): [string, number][] {
          const memoryVectors = this.vectors
          const searches = memoryVectors
                .map((vector, index) => ({
                    similarity: similarity(query, vector.embedding),
                    index,
                }))
                .sort((a, b) => (a.similarity > b.similarity ? -1 : 0))
      
          const result: [string, number][] = searches.map((search) => [
              memoryVectors[search.index].content,
              search.similarity,
          ]);
      
          return result;
    }

    similarityCheck(query1:number[],query2: number[]) {
        return similarity(query1, query2)
    }
}

export function similarity(a:VectorArray, b:VectorArray) {
    let dot = 0;
    for(let i=0;i<a.length;i++){
        dot += a[i] * b[i]
    }
    return dot
}

export function contextHash(texts: string[]): string {
    let h = 0x811c9dc5
    const s = texts.join('\0')
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
}

export type VectorArray = number[]|Float32Array

export type memoryVector = {
    embedding:number[]|Float32Array,
    content:string,
    alreadySaved?:boolean
}

const chunkArray = <T>(arr: T[], chunkSize: number) =>
    arr.reduce((chunks, elem, index) => {
        const chunkIndex = Math.floor(index / chunkSize);
        const chunk = chunks[chunkIndex] || [];
        chunks[chunkIndex] = chunk.concat([elem]);
        return chunks;
}, [] as T[][]);
