import { Packr, Unpackr, decode } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { createBotPresetTemplate, getDatabase, type Database } from "./database.svelte";
import { forageStorage } from "../globalApi.svelte";
import { chatToStub } from "./chatStorage";

const packr = new Packr({
    useRecords:false
});

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords:false
})


// NodeOnly: server cannot resolve remote blocks, always disable
const disableRemoteSaving = () => true
const checkedRemoteExistence = new Set<string>();
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]); 
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const magicStreamCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const magicRisuSaveHeader = new TextEncoder().encode("RISUSAVE\0");


async function checkCompressionStreams(){
    if(!CompressionStream){
        const {makeCompressionStream} = await import('compression-streams-polyfill/ponyfill');
        //@ts-expect-error polyfill CompressionStream type is incompatible with globalThis.CompressionStream
        globalThis.CompressionStream = makeCompressionStream(TransformStream);
    }
    if(!DecompressionStream){
        const {makeDecompressionStream} = await import('compression-streams-polyfill/ponyfill');
        //@ts-expect-error polyfill DecompressionStream type is incompatible with globalThis.DecompressionStream
        globalThis.DecompressionStream = makeDecompressionStream(TransformStream);
    }
}

export function encodeRisuSaveLegacy(data:any, compression:'noCompression'|'compression' = 'noCompression'){
    let encoded:Uint8Array = packr.encode(data)
    if(compression === 'compression'){
        encoded = fflate.compressSync(encoded)
        const result = new Uint8Array(encoded.length + magicCompressedHeader.length);
        result.set(magicCompressedHeader, 0)
        result.set(encoded, magicCompressedHeader.length)
        return result
    }
    else{
        const result = new Uint8Array(encoded.length + magicHeader.length);
        result.set(magicHeader, 0)
        result.set(encoded, magicHeader.length)
        return result
    }
}

export async function encodeRisuSaveCompressionStream(data:any) {
    await checkCompressionStreams()
    let encoded:Uint8Array = packr.encode(data)
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(encoded as any);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer()
    const result = new Uint8Array(new Uint8Array(buf).length + magicStreamCompressedHeader.length);
    result.set(magicStreamCompressedHeader, 0)
    result.set(new Uint8Array(buf), magicStreamCompressedHeader.length)
    return result
}

export type toSaveType = {
    character: string[];
    chat: [string, string][];
    root: boolean;
    botPreset: boolean;
    modules: boolean;
    plugins: boolean;
    pluginCustomStorage: boolean;
}

enum RisuSaveType {
    CONFIG = 0,
    ROOT = 1,
    CHARACTER_WITH_CHAT = 2,
    CHAT = 3,
    BOTPRESET = 4,
    MODULES = 5,
    REMOTE = 6,
    CHARACTER_WITHOUT_CHAT = 7,
    ROOT_COMPONENT = 8,
    PLUGINS = 9,
    LOADOUTS = 10,
    PLUGIN_STORAGE = 11,
}

type EncodeBlockArg = {
    compression:boolean
    data:string
    type:RisuSaveType
    name:string
    cache?:boolean
    skipRemoteSaving?:boolean
}

type EncodeBlockOption = {
    remote: 'none'|'prefer'|'force'
}

const risuSaveCacheMap = new Map<string, {type: RisuSaveType, data: string, name: string}>();
export class RisuSaveEncoder {

    private blocks: { [key: string]: Uint8Array } = {};
    private compression: boolean = false;
    // Per-character change detection: the exact JSON we last encoded. A plain
    // string comparison is a native memcmp — ~3x faster than the previous
    // normalizeJSON + calculateHash walk — and the string is reused as the
    // encode payload, so changed characters aren't stringified twice.
    // In-memory only (rebuilt by init()), so the representation is free to
    // differ from the patcher's protocol-level calculateHash.
    private characterJsons: { [key: string]: string } = {};

    async init(data:Database,arg:{
        compression?: boolean,
        skipRemoteSavingOnCharacters?: boolean
    } = {}){
        const {
            compression = false,
            skipRemoteSavingOnCharacters = true
        } = arg;
        this.compression = compression;
        let obj:Record<any,any> = {}
        let keys = Object.keys(data)
        for(const key of keys){
            if(
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'plugins' && key !== 'pluginCustomStorage'
            ){
                obj[key] = data[key]
            }
        }
        this.blocks['root'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
        this.blocks['preset'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.botPresets),
            type: RisuSaveType.BOTPRESET,
            name: 'preset'
        });
        this.blocks['modules'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.modules),
            type: RisuSaveType.MODULES,
            name: 'modules'
        });
        this.blocks['plugins'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.plugins),
            type: RisuSaveType.PLUGINS,
            name: 'plugins'
        });
        this.blocks['pluginStorage'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.pluginCustomStorage),
            type: RisuSaveType.PLUGIN_STORAGE,
            name: 'pluginStorage'
        });
        this.characterJsons = {}
        for( const character of data.characters) {
            // Replace chats with stubs for database.bin — full chat data lives server-side
            const charForEncode = { ...character, chats: character.chats.map(c => chatToStub(c)) }
            // Raw stringify (no normalize fallback): a circular ref must fail the
            // save loudly, exactly as before, rather than silently persist a
            // lossy copy. This string doubles as the encode payload.
            const charJson = JSON.stringify(charForEncode)
            this.blocks[character.chaId] = await this.encodeBlock({
                compression,
                data: charJson,
                type: RisuSaveType.CHARACTER_WITH_CHAT,
                name: character.chaId,
                skipRemoteSaving: skipRemoteSavingOnCharacters
            }, {
                remote: 'prefer'
            });
            this.characterJsons[character.chaId] = charJson
        }
        this.blocks['config'] = await this.encodeBlock({
            compression,
            data: JSON.stringify({
                version: 1
            }),
            type: RisuSaveType.CONFIG,
            name: "config"
        })
    }

    async set(data:Database, toSave:toSaveType){
        let obj:Record<any,any> = {}
        let keys = Object.keys(data)
        for(const key of keys){
            if(
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'plugins' && key !== 'pluginCustomStorage'
            ){
                obj[key] = data[key]
            }
        }

        const savedId = new Set<string>();
        for(const character of data.characters) {
            if (!character?.chaId) {
                continue
            }
            const chaId = character.chaId
            savedId.add(chaId)
            const index = toSave.character.indexOf(chaId);
            // Compare against the stub-replaced character so hydration (stub →
            // full chat) doesn't read as a change of the character itself.
            // Raw stringify (see init): circular refs fail the save loudly.
            const charForEncode = { ...character, chats: character.chats.map(c => chatToStub(c)) }
            const charJson = JSON.stringify(charForEncode)
            const hasChanged = this.characterJsons[chaId] !== charJson

            if (index !== -1 || hasChanged || !this.blocks[chaId]) {
                this.blocks[character.chaId] = await this.encodeBlock({
                    compression: this.compression,
                    data: charJson,
                    type: RisuSaveType.CHARACTER_WITH_CHAT,
                    name: character.chaId
                }, {
                    remote: 'prefer'
                });
                this.characterJsons[chaId] = charJson
                if (index !== -1) {
                    toSave.character.splice(index, 1);
                }
            }
        }
        if(toSave.character.length > 0){
            console.log(`Deleting character data: ${toSave.character.join(', ')}`);
            //probably deleted characters
            for(const chaId of toSave.character){
                if(!savedId.has(chaId)){
                    delete this.blocks[chaId];
                    delete this.characterJsons[chaId];
                }
            }
        }

        // Ensure stale character blocks are always removed even when deletion wasn't tracked in toSave.
        // This prevents deleted characters from being resurrected after full-write fallback.
        const currentCharacterIds = new Set<string>((data.characters ?? []).map((character) => character?.chaId).filter(Boolean));
        for (const key of Object.keys(this.blocks)) {
            if (key === 'root' || key === 'preset' || key === 'modules' || key === 'config'
                || key === 'plugins' || key === 'pluginStorage') {
                continue;
            }
            if (!currentCharacterIds.has(key)) {
                delete this.blocks[key];
                delete this.characterJsons[key];
            }
        }

        if(toSave.botPreset){
            this.blocks['preset'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.botPresets),
                type: RisuSaveType.BOTPRESET,
                name: 'preset'
            });
        }
        if(toSave.modules){
            this.blocks['modules'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.modules),
                type: RisuSaveType.MODULES,
                name: 'modules'
            });
        }

        if(toSave.pluginCustomStorage){
            this.blocks['pluginStorage'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.pluginCustomStorage),
                type: RisuSaveType.PLUGIN_STORAGE,
                name: 'pluginStorage'
            });
        }

        if(toSave.plugins){
            this.blocks['plugins'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.plugins),
                type: RisuSaveType.PLUGINS,
                name: 'plugins'
            });
        }

        obj["__directory"] = Object.keys(this.blocks).filter(key => key !== 'root');
        this.blocks['root'] = await this.encodeBlock({
            compression: this.compression,
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
    }

    encode(arg:{
        compression?: boolean
    } = {}){
        if(!this.blocks['config']){
            return null
        }
        let totalLength = 0
        for(const key in this.blocks){
            totalLength += this.blocks[key].length;
        }
        totalLength += magicRisuSaveHeader.length;
        const arrayBuf = new ArrayBuffer(totalLength);
        const view = new Uint8Array(arrayBuf);
        let offset = 0;
        view.set(magicRisuSaveHeader, offset);
        offset += magicRisuSaveHeader.length;
        for(const key in this.blocks){
            view.set(this.blocks[key], offset);
            offset += this.blocks[key].length;
        }
        console.log(Object.keys(this.blocks).length, 'blocks encoded');
        return arrayBuf;
    }

    async encodeBlock(arg:EncodeBlockArg, option:EncodeBlockOption = { remote: 'none' }){
        if(
            option.remote === 'force' ||
            (option.remote === 'prefer' && !disableRemoteSaving())
        ){
            return await this.encodeRemoteBlock(arg);
        }
        return await this.encodeRawBlock(arg);
    }

    async encodeRawBlock(arg:EncodeBlockArg){
        let databuf: Uint8Array;
        const cacheBlock = arg.cache ?? true;
        if(arg.compression){
            await checkCompressionStreams();
            const cs = new CompressionStream('gzip');
            const writer = cs.writable.getWriter();
            writer.write(new TextEncoder().encode(arg.data));
            writer.close();
            const compressedData = await new Response(cs.readable).arrayBuffer();
            databuf = (new Uint8Array(compressedData));
        }
        else{
            databuf = (new TextEncoder().encode(arg.data));
        }
        const nameBuf = new TextEncoder().encode(arg.name);
        const lengthBuf = new ArrayBuffer(4);
        new Uint32Array(lengthBuf)[0] = databuf.length;
        const arrayBuf = new ArrayBuffer(2 + 1 + nameBuf.length + 4 + databuf.length);
        const buf = new Uint8Array(arrayBuf);
        buf.set(new Uint8Array([arg.type, arg.compression ? 1 : 0]), 0);
        buf.set(new Uint8Array([nameBuf.length]), 2);
        buf.set(nameBuf, 3);
        buf.set(new Uint8Array(lengthBuf), 3 + nameBuf.length);
        buf.set(databuf, 7 + nameBuf.length);
        risuSaveCacheMap.set(`risuSaveBlock_${arg.name}`, {
            type: arg.type,
            data: arg.data,
            name: arg.name,
        });
        return buf;
    }

    async encodeRemoteBlock(arg:EncodeBlockArg){
        console.log(`Encoding remote block: ${arg.name}`);
        const encoded = new TextEncoder().encode(arg.data);
        const fileName = `remotes/${arg.name}.local.bin`

        if(arg.skipRemoteSaving && checkedRemoteExistence.has(arg.name) === false){
            let fileExists = false;
            const stored = await forageStorage.keys();
            if(stored.includes(fileName)){
                fileExists = true;
            }
            if(!fileExists){
                console.log(`Remote file ${fileName} does not exist, disabling skipRemoteSaving for this block.`);
                arg.skipRemoteSaving = false;
            }
            checkedRemoteExistence.add(arg.name);
        }

        if(!arg.skipRemoteSaving){
            await forageStorage.setItem(fileName, encoded);
        }
        return await this.encodeBlock({
            compression: false,
            data: JSON.stringify({
                v: 1,
                type: arg.type,
                name: arg.name,
            }),
            type: RisuSaveType.REMOTE,
            name: arg.name
        });
    }
}

export class RisuSaveDecoder {
    private blocks: {
        name: string;
        type: RisuSaveType;
        compression: boolean;
        content: string;
    }[] = []
    async decode(data: Uint8Array): Promise<Database> {
        console.log('Decoding RisuSave data');
        let offset = magicRisuSaveHeader.length;
        //@ts-expect-error Database has required fields, but we initialize empty and populate incrementally during decode
        let db:Database = {}
        const loadedBlocks = new Set<string>();
        while (offset < data.length) {
            try {
                const type = data[offset];
                const compression = data[offset + 1] === 1;
                offset += 2;

                const nameLength = data[offset];
                offset += 1;
                const name = new TextDecoder().decode(data.subarray(offset, offset + nameLength));
                offset += nameLength;

                const newArrayBuf = new ArrayBuffer(4);
                const lengthSubUint8Buf = data.slice(offset, offset + 4);
                new Uint8Array(newArrayBuf).set(lengthSubUint8Buf);
                const length = new Uint32Array(newArrayBuf)[0];
                offset += 4;

                let blockData = data.subarray(offset, offset + length);
                offset += length;

                if (compression) {
                    //decode using DecompressionStream
                    await checkCompressionStreams();
                    const cs = new DecompressionStream('gzip');
                    const writer = cs.writable.getWriter();
                    writer.write(blockData as any);
                    writer.close();
                    const buf = await new Response(cs.readable).arrayBuffer();
                    blockData = new Uint8Array(buf);
                }

                loadedBlocks.add(name);
                this.blocks.push({
                    name,
                    type,
                    compression,
                    content: new TextDecoder().decode(blockData)
                })   
            } catch (error) {
                continue
            }
        }
        console.log('blocks',this.blocks)
        let directory: string[] = []
        for(let i = 0; i < this.blocks.length; i++){
            const key = i;
            try {
            switch(this.blocks[key].type){
                case RisuSaveType.ROOT:{
                    const rootData = JSON.parse(this.blocks[key].content);
                    for(const rootKey in rootData){
                        if(!db[rootKey] && !rootKey.startsWith('__')){
                            db[rootKey] = rootData[rootKey];
                        }
                        if(rootKey === '__directory'){
                            directory = rootData[rootKey];
                            console.log('RisuSave directory:', directory);
                            for(const dirKey of directory){
                                if(!loadedBlocks.has(dirKey)){
                                    try {
                                        console.log(`Loading directory block ${dirKey} from cache`);
                                        const dirData:{
                                            type:RisuSaveType
                                            data:string
                                            name:string
                                        } = risuSaveCacheMap.get(`risuSaveBlock_${dirKey}`) ?? null;

                                        if(dirData){
                                            this.blocks.push({
                                                name: dirData.name,
                                                type: dirData.type,
                                                compression: false,
                                                content: dirData.data
                                            });
                                            loadedBlocks.add(dirKey);
                                        }
                                    } catch (error) {
                                        console.error(`Error loading directory block ${dirKey}:`, error);
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
                case RisuSaveType.CHARACTER_WITH_CHAT:
                case RisuSaveType.CHARACTER_WITHOUT_CHAT:{
                    db.characters ??= [];
                    const character = JSON.parse(this.blocks[key].content);
                    db.characters.push(character);
                    break
                }
                case RisuSaveType.BOTPRESET:{
                    db.botPresets = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.MODULES:{
                    db.modules = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.CONFIG:{
                    //ignore for now
                    break;
                }
                case RisuSaveType.PLUGINS:{
                    db.plugins = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.LOADOUTS:{
                    // Loadout feature removed; ignore any legacy blocks from older backups.
                    break;
                }
                case RisuSaveType.PLUGIN_STORAGE:{
                    db.pluginCustomStorage = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.REMOTE:{
                    const remoteInfo:{
                        v:number
                        type:RisuSaveType
                        name:string
                    } = JSON.parse(this.blocks[key].content);
                    const fileName = `remotes/${remoteInfo.name}.local.bin`
                    let remoteData:Uint8Array|null = null
                    const stored = await forageStorage.getItem(fileName);
                    if(stored){
                        remoteData = stored as Uint8Array;
                    }

                    if(!remoteData){
                        console.warn(`Remote file ${fileName} not found.`);
                        break;
                    }
                    const decoded = new TextDecoder().decode(remoteData)

                    //add to blocks for further processing
                    this.blocks.push({
                        name: remoteInfo.name,
                        type: remoteInfo.type,
                        compression: false,
                        content: decoded
                    });
                    break;
                }
                case RisuSaveType.ROOT_COMPONENT:{
                    const componentData:{
                        data:any
                        key:string
                    } = JSON.parse(this.blocks[key].content);
                    db[componentData.key] = componentData.data;
                    break;
                }
                default:{
                    console.warn(`Not Implemented RisuSaveType: ${this.blocks[key].type} for ${this.blocks[key].name}`);
                }
            }
            } catch (error) {
                console.error(`Error processing block ${this.blocks[key].name}:`, error);

                if(this.blocks[key].type === RisuSaveType.ROOT){
                    throw new Error('Failed to decode root block, cannot proceed with decoding RisuSave data');
                }
            }
        }
        //to fix botpreset bugs
        if(!Array.isArray(db.botPresets) || db.botPresets.length === 0){
            db.botPresets = [createBotPresetTemplate()]
            db.botPresetsId = 0
        }
        console.log('Decoded RisuSave data', db);
        return db;
    }
}

export async function decodeRisuSave(data:Uint8Array){
    try {
        const header = checkHeader(data)
        switch(header){
            case "compressed":
                data = data.slice(magicCompressedHeader.length)
                return decode(fflate.decompressSync(data))
            case "raw":
                data = data.slice(magicHeader.length)
                return unpackr.decode(data)
            case "stream":{
                await checkCompressionStreams()
                data = data.slice(magicStreamCompressedHeader.length)
                const cs = new DecompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(data as any);
                writer.close();
                const buf = await new Response(cs.readable).arrayBuffer()
                return unpackr.decode(new Uint8Array(buf))
            }
            case "risusave":{
                const decoder = new RisuSaveDecoder();
                return await decoder.decode(data);
            }
        }
        return unpackr.decode(data)
    }
    catch (error) {
        console.error('Error decoding RisuSave data:', error);
        try {
            console.log('risudecode')
            const risuSaveHeader = new Uint8Array(Buffer.from("\u0000\u0000RISU",'utf-8'))
            const realData = data.subarray(risuSaveHeader.length)
            const dec = unpackr.decode(realData)
            return dec   
        } catch (error) {
            const buf = Buffer.from(fflate.decompressSync(Buffer.from(data)))
            try {
                return JSON.parse(buf.toString('utf-8'))                            
            } catch (error) {
                return unpackr.decode(buf)
            }
        }
    }
}

function checkHeader(data: Uint8Array) {

    let header:'none'|'compressed'|'raw'|'stream'|'risusave' = 'raw'

    if (data.length < magicHeader.length) {
      return false;
    }
  
    for (let i = 0; i < magicHeader.length; i++) {
      if (data[i] !== magicHeader[i]) {
        header = 'none'
        break
      }
    }

    if(header === 'none'){
        header = 'compressed'
        for (let i = 0; i < magicCompressedHeader.length; i++) {
            if (data[i] !== magicCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'stream'
        for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
            if (data[i] !== magicStreamCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'risusave'
        for (let i = 0; i < magicRisuSaveHeader.length; i++) {
            if (data[i] !== magicRisuSaveHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    // All bytes matched
    return header;
}

// --- Hash & normalization utilities for patch-based sync ---

const PRIME_MULTIPLIER = 31;

const SEED_OBJECT = 17;
const SEED_ARRAY = 19;
const SEED_STRING = 23;
const SEED_NUMBER = 29;
const SEED_BOOLEAN = 31;
const SEED_NULL = 37;

export function calculateHash(node: any): number {
    if (node === null || node === undefined) return SEED_NULL;
    switch (typeof node) {
        case 'object':
            if (Array.isArray(node)) {
                let arrayHash = SEED_ARRAY;
                for (const item of node)
                    arrayHash = (Math.imul(arrayHash, PRIME_MULTIPLIER) + calculateHash(item)) >>> 0;
                return arrayHash;
            } else {
                // Independent of key order
                let objectHash = SEED_OBJECT;
                for (const key in node)
                    objectHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + calculateHash(node[key]));
                return objectHash >>> 0;
            }
        case 'string':
            let strHash = 2166136261;
            for (let i = 0; i < node.length; i++)
                strHash = Math.imul(strHash ^ node.charCodeAt(i), 16777619);
            return Math.imul(SEED_STRING, PRIME_MULTIPLIER) + (strHash >>> 0);
        case 'number':
            let numHash;
            if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
                numHash = node >>> 0;
            else {
                const str = node.toString();
                numHash = 2166136261;
                for (let i = 0; i < str.length; i++)
                    numHash = Math.imul(numHash ^ str.charCodeAt(i), 16777619);
                numHash = numHash >>> 0;
            }
            return Math.imul(SEED_NUMBER, PRIME_MULTIPLIER) + numHash;
        case 'boolean':
            return Math.imul(SEED_BOOLEAN, PRIME_MULTIPLIER) + (node ? 1 : 0);

        default:
            return 0;
    }
}

export function normalizeJSON(value: any, seen?: WeakSet<object>): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') {
        if (typeof value === 'number' && !isFinite(value)) return null;
        if (typeof value === 'function' ||
            typeof value === 'symbol' ||
            typeof value === 'bigint')
            return undefined;
        return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp || value instanceof Error) return {};
    if (!seen) seen = new WeakSet();
    if (seen.has(value)) {
        console.warn('[normalizeJSON] Circular reference detected and replaced with null')
        return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const result: any[] = [];
        for (const item of value) {
            if (item === undefined) {
                result.push(null);
            } else {
                const normalized = normalizeJSON(item, seen);
                result.push(normalized === undefined ? null : normalized);
            }
        }
        seen.delete(value);
        return result;
    }
    const result: Record<string, any> = {};
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const propValue = value[key];
            if (propValue !== undefined) {
                const normalized = normalizeJSON(propValue, seen);
                if (normalized !== undefined)
                    result[key] = normalized;
            }
        }
    }
    seen.delete(value);
    return result;
}

// Compare two arrays element-wise, but emit a single `replace` op covering the
// whole array when structure changes (add, remove, reorder). Element-wise diff
// via fast-json-patch is dangerous on arrays of deep objects: deleting one
// entry shifts every following index, each shifted slot deep-diffs "old item N
// vs new item N+1", and the resulting op list can balloon past V8's function
// argument limit (~125k) — `patch.push(...ops)` then throws
// `RangeError: Maximum call stack size exceeded`. Callers MUST iterate the
// returned ops with `for (const op of ops) patch.push(op)` rather than spread,
// to stay safe even when a single item's internal diff is large.
//
// `idKey != null` (modules, botPresets — both gained stable string ids):
// structural detection by id equality at each index, with a safety belt
// that forces `replace` when ids are falsy or duplicated (defensive against
// corrupted backups, or backups predating the id field). `idKey == null`:
// length-only detection — retained as a fallback for arrays without stable
// ids, currently unused by callers but kept for future use.
export function diffArrayWithIdGuard(
    compare: (a: any, b: any) => any[],
    path: string,
    lastArr: any[] | undefined,
    curArr: any[],
    idKey: string | null,
): any[] {
    const last = lastArr ?? []
    let structural = last.length !== curArr.length

    if (!structural && idKey != null) {
        const lastIds = last.map((m: any) => m?.[idKey])
        const curIds = curArr.map((m: any) => m?.[idKey])
        const hasInvalidIds = curIds.some(id => !id) || lastIds.some(id => !id)
        const hasDuplicates = new Set(curIds).size !== curIds.length
        structural = hasInvalidIds || hasDuplicates ||
            lastIds.some((id, i) => id !== curIds[i])
    }

    if (structural) {
        return [{ op: 'replace', path, value: curArr }]
    }

    const ops: any[] = []
    for (let i = 0; i < curArr.length; i++) {
        const subPatch = compare(last[i], curArr[i])
        for (const p of subPatch) {
            ops.push({ ...p, path: `${path}/${i}${p.path}` })
        }
    }
    return ops
}

export class RisuSavePatcher {
    private lastSyncedDb: any;
    private hashBlocks: { [key: string]: number } = {};
    // Cheap change pre-check baselines. calculateHash over normalizeJSON'd data
    // is the client↔server patch protocol (the server recomputes the same hash,
    // see server.cjs expectedHash verification) and MUST NOT change — but when
    // an entry's JSON is byte-identical to the baseline, the stored hash and
    // baseline are still valid, so the expensive normalize+hash+diff can be
    // skipped wholesale. String comparison is a native memcmp (~3x cheaper).
    // Granularity matters: while typing into a root field (personaPrompt) or a
    // module lorebook, that whole block changes on EVERY save — so baselines
    // are kept per ROOT KEY and per MODULE, and only the changed entry pays
    // normalize + protocol hash + diff.
    // Maps (not plain objects): ids come from user-importable data, so a key
    // like "__proto__" on a plain object would silently hit the prototype
    // setter instead of storing — corrupting the skip checks and, worse, the
    // modules hash fold. Map keys are also type-strict (1 !== "1").
    private lastRootKeyJsons = new Map<string, string>();
    private lastCharJsons = new Map<string, string>();
    private lastModuleJsons = new Map<string, string>();
    private moduleItemHashes = new Map<string, number>();

    hash(): string {
        this.hashBlocks['characters'] = SEED_ARRAY;
        for (const character of this.lastSyncedDb.characters) {
            this.hashBlocks['characters'] = (Math.imul(this.hashBlocks['characters'], PRIME_MULTIPLIER) + this.hashBlocks[character.chaId]) >>> 0;
        }

        const keys = Object.keys(this.lastSyncedDb)
        let rootHash = SEED_OBJECT;
        for (const key of keys) {
            rootHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + this.hashBlocks[key])
        }
        return (rootHash >>> 0).toString(16);
    }

    async init(data: any) {
        this.lastSyncedDb = normalizeJSON(data);
        if (!Array.isArray(this.lastSyncedDb.characters)) {
            this.lastSyncedDb.characters = [];
        }
        this.hashBlocks = {};

        const keys = Object.keys(this.lastSyncedDb)

        for (const key of keys) {
            if (key !== 'characters') {
                this.hashBlocks[key] = calculateHash(this.lastSyncedDb[key]);
            }
        }

        for (let i = 0; i < this.lastSyncedDb.characters.length; i++) {
            const character = this.lastSyncedDb.characters[i];
            // Hash with stubs only (matching set()) so hashes stay in sync
            const withStubs = { ...character, chats: (character.chats || []).map((c: any) => chatToStub(c)) };
            this.hashBlocks[character.chaId] = calculateHash(withStubs);
            this.lastSyncedDb.characters[i] = withStubs;
        }

        // Seed the cheap pre-check baselines from the NORMALIZED data, not the
        // raw input. The protocol baseline (what the server holds) is always the
        // normalizeJSON form, so a raw baseline could match a future raw string
        // whose normalized form differs from the server's (e.g. a shared
        // reference that normalize replaced with null then later un-shares),
        // causing the fast path to skip a change the server still needs. Seeding
        // from the normalized form means any normalize-affecting value (shared
        // ref, Date, non-finite) makes raw≠baseline and falls safely to full path.
        const { characters: _c, botPresets: _b, modules: _m, ...normRootOnly } = this.lastSyncedDb
        this.lastRootKeyJsons = new Map();
        for (const key of Object.keys(normRootOnly)) {
            this.lastRootKeyJsons.set(key, JSON.stringify(normRootOnly[key]))
        }
        this.lastCharJsons = new Map();
        for (const character of this.lastSyncedDb.characters) {
            if (character?.chaId) this.lastCharJsons.set(character.chaId, JSON.stringify(character))
        }
        this.lastModuleJsons = new Map();
        this.moduleItemHashes = new Map();
        const normModulesInit = Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : []
        for (const m of normModulesInit) {
            if (typeof m?.id === 'string' && m.id) {
                this.lastModuleJsons.set(m.id, JSON.stringify(m))
                this.moduleItemHashes.set(m.id, calculateHash(m))
            }
        }
    }

    async set(data: any, toSave: toSaveType): Promise<{ patch: any[]; expectedHash: string }> {
        const { compare } = await import('fast-json-patch')
        const expectedHash: string = this.hash();
        const patch: any[] = []

        const {
            characters: lastCharacters = [],
            botPresets: lastBotPresets,
            modules: lastModules,
            ...lastRoot
        } = this.lastSyncedDb

        const {
            characters: curCharacters = [],
            botPresets: curBotPresets,
            modules: curModules,
            ...curRoot
        } = data

        // Per-KEY cheap pre-check over the root. While typing into a root field
        // (e.g. personaPrompt) the root changes on every save, so a whole-root
        // pre-check would never match and every save would pay a full-root
        // normalize + deep diff + rehash of ~all root keys. Per key, only the
        // edited key takes that path; every other key is a string compare.
        // Per-key diff/remove ops are equivalent to compare(lastRoot, normRoot):
        // an object diff recurses per key independently, and wrapping the value
        // as {key: value} yields the identical /key-rooted ops with escaping
        // handled by the library. Baselines are built from the NORMALIZED value
        // (see init()) so normalize-affected data always falls to the full path.
        const nextRoot: any = {}
        const removedRootKeys = new Set(Object.keys(lastRoot))
        for (const key of Object.keys(curRoot)) {
            // An own '__proto__' key can't round-trip through JSON Patch — the
            // server's applyPatch rejects any op touching it (prototype-pollution
            // guard), failing every save. The old whole-root normalizeJSON
            // silently dropped it (its `out[key] =` assignment hits the prototype
            // setter), so match that and drop it. (Other inherited-name keys like
            // 'constructor' are kept here exactly as the old whole-root compare
            // produced them.)
            if (key === '__proto__') continue
            // hasOwn, not `in`: membership must match the baseline's OWN keys
            // (`in` would treat inherited names like 'toString' as present).
            const hadKey = Object.hasOwn(lastRoot, key)
            let curKeyJson: string | undefined
            try { curKeyJson = JSON.stringify(curRoot[key]) } catch { curKeyJson = undefined }
            // Fast skip: raw JSON equals the normalized baseline ⇒ present and
            // unchanged. curKeyJson can be undefined for non-serializable values
            // (toJSON()→undefined, bigint throw, function) — those never equal a
            // stored baseline string, so the explicit guard just makes the skip
            // not fire for them.
            if (curKeyJson !== undefined && hadKey && curKeyJson === this.lastRootKeyJsons.get(key)) {
                removedRootKeys.delete(key)
                nextRoot[key] = lastRoot[key]
                continue
            }
            // Decide presence by the NORMALIZED result, NOT by JSON.stringify of
            // the raw value. normalizeJSON ignores toJSON and maps
            // bigint/function/symbol to undefined; its PARENT then drops keys
            // whose normalized value is undefined. Mirror that here — only a
            // normalized-undefined value means the key is absent. (A raw
            // JSON.stringify of undefined does NOT imply that: e.g.
            // {x:1, toJSON:()=>undefined} normalizes to {x:1}.)
            const normVal = normalizeJSON(curRoot[key])
            if (normVal === undefined) {
                // Absent in the normalized form. If it was present (hadKey) the
                // key stays in removedRootKeys → the removal loop emits a remove;
                // if it was never present, nothing to do.
                continue
            }
            removedRootKeys.delete(key)
            const before = hadKey ? { [key]: lastRoot[key] } : {}
            for (const p of compare(before, { [key]: normVal })) patch.push(p)
            this.hashBlocks[key] = calculateHash(normVal)
            this.lastRootKeyJsons.set(key, JSON.stringify(normVal))
            nextRoot[key] = normVal
        }
        for (const key of removedRootKeys) {
            // Key deleted from the live db (or its value normalized to undefined)
            // → emit the remove op (escaping via compare) and drop its caches.
            for (const p of compare({ [key]: lastRoot[key] }, {})) patch.push(p)
            delete this.hashBlocks[key]
            this.lastRootKeyJsons.delete(key)
        }

        if (toSave.botPreset) {
            const normBotPresets = normalizeJSON(curBotPresets) ?? []
            const ops = diffArrayWithIdGuard(compare, '/botPresets', lastBotPresets, normBotPresets, 'id')
            for (const op of ops) patch.push(op)
            this.hashBlocks['botPresets'] = calculateHash(normBotPresets);
            this.lastSyncedDb.botPresets = normBotPresets;
        }

        if (toSave.modules) {
            // Per-MODULE cheap pre-check, mirroring diffArrayWithIdGuard's
            // structural-vs-elementwise pivot: editing one module's lorebook
            // changes the modules block on every save, so only the edited
            // module should pay normalize + protocol hash + diff.
            const lastModulesArr: any[] = Array.isArray(lastModules) ? lastModules : []
            const curModulesArr: any[] = Array.isArray(curModules) ? curModules : []
            let structural = lastModulesArr.length !== curModulesArr.length
            if (!structural) {
                const lastModIds = lastModulesArr.map((m: any) => m?.id)
                const curModIds = curModulesArr.map((m: any) => m?.id)
                // Non-string ids (numbers, objects) go structural too: ids come
                // from importable data, and only strings are safe/strict as
                // cache keys (1 vs "1" must not collide).
                const hasInvalidIds = curModIds.some(id => !id || typeof id !== 'string') || lastModIds.some(id => !id || typeof id !== 'string')
                const hasDuplicates = new Set(curModIds).size !== curModIds.length
                structural = hasInvalidIds || hasDuplicates || lastModIds.some((id, i) => id !== curModIds[i])
            }

            if (structural) {
                // Structural change → single whole-array replace, exactly like
                // diffArrayWithIdGuard, and rebuild the per-module baselines.
                const normModules = normalizeJSON(curModulesArr) ?? []
                patch.push({ op: 'replace', path: '/modules', value: normModules })
                this.hashBlocks['modules'] = calculateHash(normModules);
                this.lastSyncedDb.modules = normModules;
                this.lastModuleJsons = new Map();
                this.moduleItemHashes = new Map();
                for (const m of normModules) {
                    if (typeof m?.id === 'string' && m.id) {
                        this.lastModuleJsons.set(m.id, JSON.stringify(m))
                        this.moduleItemHashes.set(m.id, calculateHash(m))
                    }
                }
            } else {
                // Same structure (all ids valid, string-typed, aligned) → element-wise.
                for (let i = 0; i < curModulesArr.length; i++) {
                    const id = curModulesArr[i].id
                    let curModJson: string | null = null
                    try { curModJson = JSON.stringify(curModulesArr[i]) } catch { curModJson = null }
                    if (curModJson !== null && curModJson === this.lastModuleJsons.get(id) && this.moduleItemHashes.has(id)) {
                        continue // unchanged: baseline slot + item hash stay valid
                    }
                    const normModule = normalizeJSON(curModulesArr[i])
                    for (const p of compare(lastModulesArr[i], normModule)) {
                        patch.push({ ...p, path: `/modules/${i}${p.path}` })
                    }
                    this.moduleItemHashes.set(id, calculateHash(normModule))
                    this.lastModuleJsons.set(id, JSON.stringify(normModule))
                    this.lastSyncedDb.modules[i] = normModule
                }
                // The protocol hash of the whole array is the documented fold of
                // calculateHash over items (see calculateHash's array branch) —
                // recompose it from the cached per-item hashes so the value is
                // bit-identical to calculateHash(normalizeJSON(modules)).
                let modulesHash = SEED_ARRAY
                for (const m of (Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : [])) {
                    const cached = (typeof m?.id === 'string') ? this.moduleItemHashes.get(m.id) : undefined
                    const itemHash = cached !== undefined ? cached : calculateHash(m)
                    modulesHash = (Math.imul(modulesHash, PRIME_MULTIPLIER) + itemHash) >>> 0
                }
                this.hashBlocks['modules'] = modulesHash
            }
        }

        // Detect structural changes (additions, deletions, reordering)
        const lastIds = lastCharacters.map((c: any) => c?.chaId)
        const curIds = curCharacters.map((c: any) => c?.chaId)
        const structuralChange = lastIds.length !== curIds.length ||
            lastIds.some((id: string, i: number) => id !== curIds[i])

        // Replace chats with stubs for patch diff — full chat data lives server-side
        function withStubs(char: any) {
            if (!char) return char
            return { ...char, chats: (char.chats || []).map((c: any) => chatToStub(c)) }
        }

        if (structuralChange) {
            // Structural change → replace entire characters array (safe for deletions/additions)
            const normChars = normalizeJSON(curCharacters.map(withStubs))
            patch.push({ op: 'replace', path: '/characters', value: normChars })
            // Update all character hashes
            for (const lastId of lastIds) {
                if (lastId) delete this.hashBlocks[lastId];
            }
            for (const char of normChars) {
                if (char?.chaId) {
                    this.hashBlocks[char.chaId] = calculateHash(char);
                }
            }
            this.lastSyncedDb.characters = normChars;
            // Rebuild the cheap baselines from the NORMALIZED chars (the server's
            // state), not the raw input — see init().
            this.lastCharJsons = new Map();
            for (const char of normChars) {
                if (char?.chaId) this.lastCharJsons.set(char.chaId, JSON.stringify(char))
            }
        } else {
            // Same structure → per-character field-level diff (efficient)
            for (let i = 0; i < curCharacters.length; i++) {
                const lastChar = lastCharacters[i]
                const curChar = curCharacters[i]
                const curCharId = curChar?.chaId
                const trackedBySave = toSave.character.includes(curCharId ?? '')

                // Cheap pre-check: identical JSON ⇒ identical data ⇒ stored
                // hash, baseline and (empty) diff are all still valid — skip
                // the normalize + protocol hash + compare entirely.
                let curJson: string | null = null
                try { curJson = JSON.stringify(withStubs(curChar)) } catch { curJson = null }
                if (!trackedBySave && curCharId && curJson !== null && curJson === this.lastCharJsons.get(curCharId)) {
                    continue
                }

                const normChar = normalizeJSON(withStubs(curChar))
                const curCharHash = curCharId ? calculateHash(normChar) : undefined
                const changedByHash = !!(curCharId && curCharHash !== this.hashBlocks[curCharId])

                if (trackedBySave || changedByHash) {
                    let charPatch = compare(lastChar, normChar).map((v) => {
                        v.path = `/characters/${i}` + v.path;
                        return v;
                    })
                    patch.push(...charPatch);
                    this.hashBlocks[normChar.chaId] = curCharHash ?? calculateHash(normChar);
                    this.lastSyncedDb.characters[i] = normChar;
                }
                // Refresh the cheap baseline from the NORMALIZED form (the
                // server's actual state), not curJson — a raw baseline could
                // later match a string whose normalized form differs from the
                // server's (shared ref → null → un-share), silently skipping a
                // real change. Normalized baseline keeps such chars on the safe
                // full path. normChar is cycle-free, so stringify won't throw.
                if (curCharId) {
                    this.lastCharJsons.set(curCharId, JSON.stringify(normChar))
                }
            }
        }

        this.lastSyncedDb = {
            characters: this.lastSyncedDb.characters,
            botPresets: this.lastSyncedDb.botPresets,
            modules: this.lastSyncedDb.modules,
            ...nextRoot
        }

        return {
            patch,
            expectedHash
        }
    }
}

// Stub metadata fields a patch may legitimately touch on `chats[i]`. Anything
// else is chat-internal data that lives server-side via /api/chat-content;
// emitting such ops over /api/patch silently strips the `_stub` flag in the
// server's dbCache and corrupts the on-disk DB. Keep in sync with chatToStub.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only these op types are legitimate on chat-internal paths. The patcher's
// fast-json-patch.compare only emits add/replace/remove; move/copy/test would
// only come from external/legacy clients and could bypass the field-name
// allowlist by aliasing _stub through `from`. Reject them outright.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove'])

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/

/**
 * Detect patch ops that mutate chat-internal fields. The patcher should never
 * produce these — chats are always run through chatToStub before diffing — so
 * any hit indicates a baseline-vs-current mismatch that would cause server-side
 * data loss (see findChatInternalFieldOps in server.cjs). Used by the save
 * pipeline to refuse the patch and fall through to a safe full write.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Removing `_stub`
 * or setting it to a falsy value is itself the loss vector — the server's
 * reassembleFullDb skips fullChat merge when `_stub` is falsy.
 *
 * `move`/`copy` ops on chat-internal paths are rejected wholesale because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
export function findDangerousChatOps(patch: any[]): { op: string; path: string; field: string; reason?: string }[] {
    if (!Array.isArray(patch)) return []
    const violations: { op: string; path: string; field: string; reason?: string }[] = []
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE)
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null
        if (!pathMatch && !fromMatch) continue

        // Any move/copy/test that touches a chat-internal field — on either
        // path or from — is a bypass attempt. Block at the op-type layer.
        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: pathMatch?.[1] ?? fromMatch?.[1] ?? '',
                reason: `disallowed op type on chat field`,
            })
            continue
        }

        if (pathMatch) {
            const field = pathMatch[1]
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field })
                continue
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' })
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' })
                }
            }
        }
    }
    return violations
}
