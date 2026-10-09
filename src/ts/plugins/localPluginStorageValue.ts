// Keep ordinary values as legacy JSON. Rich values use one KV record:
// NUL + PLS + version, metadata/JSON lengths, metadata, JSON, then raw bytes.
// The leading NUL cannot collide with a valid legacy JSON document.
const magic = new Uint8Array([0, 80, 76, 83, 1]);
const headerSize = magic.length + 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ViewConstructor = {
    new(buffer: ArrayBuffer, byteOffset?: number, length?: number): ArrayBufferView;
    BYTES_PER_ELEMENT?: number;
};
const viewTypes: Record<string, ViewConstructor> = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array, DataView,
};
const float16 = (globalThis as unknown as { Float16Array?: ViewConstructor }).Float16Array;
if (float16) viewTypes.Float16Array = float16;

// RAB is newer than the project's ES2023 type library. Feature detection keeps
// ordinary buffers usable in browsers that do not implement resize().
type ResizableBuffer = ArrayBuffer & { resizable?: boolean; maxByteLength?: number; resize(size: number): void };
function isLengthTracking(view: ArrayBufferView, name: string): boolean {
    if (!(view.buffer as ResizableBuffer).resizable) return false;
    // JavaScript exposes no tracking flag. Probe a native clone, never the
    // caller's buffer. Cloning also rejects views that are already out of bounds.
    const probe = structuredClone(view);
    const buffer = probe.buffer as ResizableBuffer;
    if (probe.byteLength) {
        buffer.resize(probe.byteOffset);
        try {
            if (name === 'DataView') void probe.byteLength;
            else (probe as unknown as Uint8Array).values();
            return true;
        } catch { return false; }
    }
    const width = viewTypes[name].BYTES_PER_ELEMENT ?? 1;
    if (buffer.maxByteLength - probe.byteOffset >= width) {
        buffer.resize(probe.byteOffset + width);
        return probe.byteLength !== 0;
    }
    // With no room to grow, zero-length fixed/tracking views behave identically.
    return false;
}

// The storage viewer must not round-trip these values through its JSON editor.
export function requiresLocalPluginStorageEncoding(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === undefined || typeof value === 'bigint') return true;
    if (typeof value === 'number') return !Number.isFinite(value) || Object.is(value, -0);
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return true;
    seen.add(value);
    if (Object.prototype.toString.call(value) !== '[object Object]' && !Array.isArray(value)) return true;
    if (Array.isArray(value) && (Object.keys(value).length !== value.length
        || Object.keys(value).some((key, i) => key !== String(i)))) return true;
    return Object.values(value).some((item) => requiresLocalPluginStorageEncoding(item, seen));
}

type StoredValue = null | boolean | string | number | { ref: number };
type Properties = [string, StoredValue][];
type StoredNode =
    | { type: 'Object'; properties: Properties }
    | { type: 'Array'; length: number; properties: Properties }
    | { type: 'Map'; entries: [StoredValue, StoredValue][] }
    | { type: 'Set'; values: StoredValue[] }
    | { type: 'ArrayBuffer'; byteLength: number; maxByteLength?: number }
    | { type: 'View'; name: string; buffer: number; byteOffset: number; byteLength: number; lengthTracking?: boolean }
    | { type: 'Blob'; byteLength: number; mimeType: string }
    | { type: 'File'; byteLength: number; mimeType: string; name: string; lastModified: number }
    | { type: 'Date'; time: number | null }
    | { type: 'RegExp'; source: string; flags: string }
    | { type: 'Primitive'; name: 'undefined' | 'bigint' | 'number'; value: string }
    | { type: 'Box'; value: StoredValue };

// Nodes keep object identity (including cycles). Views refer to a buffer node,
// so its complete bytes are stored once, regardless of the number of views.
export async function encodeLocalPluginStorageValue(value: unknown): Promise<Uint8Array> {
    // Snapshot ordinary values without building the binary graph. This also
    // drops custom prototypes/toJSON, matching IndexedDB's clone semantics.
    value = value === undefined ? null : value;
    if (!requiresLocalPluginStorageEncoding(value)) {
        return encoder.encode(JSON.stringify(structuredClone(value)));
    }
    const nodes: StoredNode[] = [];
    const seen = new Map<object, number>();
    const payloads: (Uint8Array | Blob)[] = [];
    function store(item: unknown): StoredValue {
        if (item === null) return null;
        if (typeof item === 'string' || typeof item === 'boolean') return item;
        if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
        if (typeof item === 'function' || typeof item === 'symbol') {
            throw new DOMException('Value cannot be cloned for plugin storage', 'DataCloneError');
        }
        if (item && typeof item === 'object' && seen.has(item)) {
            return { ref: seen.get(item) };
        }
        const ref = nodes.length;
        // Register before visiting children so self references are valid.
        nodes.push(null);
        if (item && typeof item === 'object') seen.set(item, ref);
        let node: StoredNode;
        if (item === undefined || typeof item === 'bigint' || typeof item === 'number') {
            node = { type: 'Primitive', name: typeof item as 'undefined' | 'bigint' | 'number',
                value: Object.is(item, -0) ? '-0' : String(item) };
        } else if (item instanceof Blob) {
            node = typeof File !== 'undefined' && item instanceof File
                ? { type: 'File', byteLength: item.size, mimeType: item.type, name: item.name, lastModified: item.lastModified }
                : { type: 'Blob', byteLength: item.size, mimeType: item.type };
            payloads.push(item);
        } else if (item instanceof ArrayBuffer) {
            node = { type: 'ArrayBuffer', byteLength: item.byteLength };
            if ((item as ResizableBuffer).resizable) node.maxByteLength = (item as ResizableBuffer).maxByteLength;
            // Snapshot the complete backing buffer before the first await.
            payloads.push(new Uint8Array(new Uint8Array(item)));
        } else if (ArrayBuffer.isView(item)) {
            const name = Object.prototype.toString.call(item).slice(8, -1);
            if (!Object.hasOwn(viewTypes, name) || !(item.buffer instanceof ArrayBuffer)) {
                throw new DOMException('Unsupported storage buffer view', 'DataCloneError');
            }
            node = { type: 'View', name, buffer: (store(item.buffer) as { ref: number }).ref,
                byteOffset: item.byteOffset, byteLength: item.byteLength };
            if ((item.buffer as ResizableBuffer).resizable) node.lengthTracking = isLengthTracking(item, name);
        } else if (item instanceof Date) {
            node = { type: 'Date', time: Number.isNaN(item.getTime()) ? null : item.getTime() };
        } else if (item instanceof RegExp) {
            node = { type: 'RegExp', source: item.source, flags: item.flags };
        } else if (item instanceof Map) {
            node = { type: 'Map', entries: [...item].map(([key, entry]) => [store(key), store(entry)]) };
        } else if (item instanceof Set) {
            node = { type: 'Set', values: [...item].map(store) };
        } else if (['[object Number]', '[object Boolean]', '[object String]', '[object BigInt]'].includes(Object.prototype.toString.call(item))) {
            node = { type: 'Box', value: store(item.valueOf()) };
        } else if (Array.isArray(item) || Object.prototype.toString.call(item) === '[object Object]') {
            const properties = Object.keys(item).map((key): [string, StoredValue] => [key, store(item[key])]);
            node = Array.isArray(item) ? { type: 'Array', length: item.length, properties } : { type: 'Object', properties };
        } else {
            throw new DOMException('Unsupported value for plugin storage', 'DataCloneError');
        }
        nodes[ref] = node;
        return { ref };
    }
    // localForage normalizes a root undefined to null.
    const root = store(value);
    const metadata = encoder.encode(JSON.stringify(nodes));
    const jsonBytes = encoder.encode(JSON.stringify(root));
    const bytes = await Promise.all(payloads.map(async (part) =>
        part instanceof Blob ? new Uint8Array(await part.arrayBuffer()) : part));
    const result = new Uint8Array(headerSize + metadata.length + jsonBytes.length
        + bytes.reduce((sum, part) => sum + part.byteLength, 0));
    result.set(magic);
    const header = new DataView(result.buffer);
    header.setUint32(magic.length, metadata.length, true);
    header.setUint32(magic.length + 4, jsonBytes.length, true);
    let offset = headerSize;
    for (const part of [metadata, jsonBytes, ...bytes]) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function restoreGraph(nodes: StoredNode[], root: StoredValue, data: Uint8Array, offset: number): unknown {
    const invalid = () => { throw new Error('Invalid local plugin storage binary part'); };
    if (!Array.isArray(nodes)) return invalid();
    const values: unknown[] = new Array(nodes.length);
    const natural = (n: number) => Number.isSafeInteger(n) && n >= 0;
    function read(value: StoredValue): any {
        if (value === null || typeof value === 'string' || typeof value === 'boolean'
            || (typeof value === 'number' && Number.isFinite(value))) return value;
        if (!value || typeof value !== 'object' || !natural(value.ref) || value.ref >= nodes.length) return invalid();
        return values[value.ref];
    }
    for (const [index, node] of nodes.entries()) {
        if (!node || typeof node !== 'object') return invalid();
        switch (node.type) {
            case 'Object': values[index] = {}; break;
            case 'Array':
                if (!natural(node.length) || node.length > 0xffffffff) return invalid();
                values[index] = new Array(node.length); break;
            case 'Map': values[index] = new Map(); break;
            case 'Set': values[index] = new Set(); break;
            case 'Blob': case 'File': case 'ArrayBuffer': {
                if (!natural(node.byteLength) || node.byteLength > data.length - offset) return invalid();
                const bytes = new Uint8Array(data.subarray(offset, offset + node.byteLength));
                offset += node.byteLength;
                if (node.type === 'ArrayBuffer') {
                    if (node.maxByteLength === undefined) values[index] = bytes.buffer;
                    else {
                        if (!natural(node.maxByteLength) || node.maxByteLength < node.byteLength) return invalid();
                        const BufferConstructor = ArrayBuffer as unknown as {
                            new(size: number, options: { maxByteLength: number }): ResizableBuffer;
                        };
                        const buffer = new BufferConstructor(node.byteLength, { maxByteLength: node.maxByteLength });
                        if (!buffer.resizable) throw new Error('Resizable ArrayBuffer is not supported in this browser');
                        new Uint8Array(buffer).set(bytes);
                        values[index] = buffer;
                    }
                }
                else {
                    if (typeof node.mimeType !== 'string') return invalid();
                    if (node.type === 'File') {
                        if (typeof node.name !== 'string' || !Number.isFinite(node.lastModified)) return invalid();
                        values[index] = new File([bytes], node.name, { type: node.mimeType, lastModified: node.lastModified });
                    } else values[index] = new Blob([bytes], { type: node.mimeType });
                }
                break;
            }
            case 'Date':
                if (node.time !== null && !Number.isFinite(node.time)) return invalid();
                values[index] = new Date(node.time === null ? NaN : node.time); break;
            case 'RegExp':
                if (typeof node.source !== 'string' || typeof node.flags !== 'string') return invalid();
                values[index] = new RegExp(node.source, node.flags); break;
            case 'Primitive':
                if (node.name === 'undefined' && node.value === 'undefined') values[index] = undefined;
                else if (node.name === 'bigint' && /^-?\d+$/.test(node.value)) values[index] = BigInt(node.value);
                else if (node.name === 'number' && ['NaN', 'Infinity', '-Infinity', '-0'].includes(node.value)) values[index] = Number(node.value);
                else return invalid();
                break;
            case 'View': case 'Box': break;
            default: return invalid();
        }
    }
    if (offset !== data.length) throw new Error('Unexpected local plugin storage binary bytes');
    // Buffers/primitives must exist before constructing dependent views/boxes.
    for (const [index, node] of nodes.entries()) {
        if (node.type === 'View') {
            if (!Object.hasOwn(viewTypes, node.name) || !natural(node.buffer)
                || nodes[node.buffer]?.type !== 'ArrayBuffer' || !natural(node.byteOffset) || !natural(node.byteLength)) return invalid();
            const buffer = values[node.buffer] as ArrayBuffer;
            const ctor = viewTypes[node.name];
            const width = ctor.BYTES_PER_ELEMENT ?? 1;
            if (node.byteOffset > buffer.byteLength || node.byteLength > buffer.byteLength - node.byteOffset
                || node.byteOffset % width || node.byteLength % width) return invalid();
            if (node.lengthTracking !== undefined && typeof node.lengthTracking !== 'boolean') return invalid();
            if (node.lengthTracking && !(buffer as ResizableBuffer).resizable) return invalid();
            values[index] = node.lengthTracking
                ? new ctor(buffer, node.byteOffset) : new ctor(buffer, node.byteOffset, node.byteLength / width);
            if ((values[index] as ArrayBufferView).byteLength !== node.byteLength) return invalid();
        } else if (node.type === 'Box') {
            const primitive = read(node.value);
            if (!['number', 'string', 'boolean', 'bigint'].includes(typeof primitive)) return invalid();
            values[index] = Object(primitive);
        }
    }
    for (const [index, node] of nodes.entries()) {
        if (node.type === 'Object' || node.type === 'Array') {
            if (!Array.isArray(node.properties)) return invalid();
            for (const property of node.properties) {
                if (!Array.isArray(property) || property.length !== 2 || typeof property[0] !== 'string'
                    || (node.type === 'Array' && property[0] === 'length')) return invalid();
                Object.defineProperty(values[index], property[0], {
                    value: read(property[1]), writable: true, enumerable: true, configurable: true,
                });
            }
        } else if (node.type === 'Map') {
            if (!Array.isArray(node.entries)) return invalid();
            for (const entry of node.entries) {
                if (!Array.isArray(entry) || entry.length !== 2) return invalid();
                (values[index] as Map<unknown, unknown>).set(read(entry[0]), read(entry[1]));
            }
        } else if (node.type === 'Set') {
            if (!Array.isArray(node.values)) return invalid();
            for (const value of node.values) (values[index] as Set<unknown>).add(read(value));
        }
    }
    return read(root);
}

export function decodeLocalPluginStorageValue<T>(data: Uint8Array): T {
    if (data[0] !== magic[0]) return JSON.parse(decoder.decode(data)) as T;
    if (data.length < headerSize || !magic.slice(0, 4).every((byte, i) => data[i] === byte)
        || data[4] !== magic[4]) {
        throw new Error('Invalid local plugin storage binary header');
    }
    const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const metadataEnd = headerSize + header.getUint32(magic.length, true);
    const jsonEnd = metadataEnd + header.getUint32(magic.length + 4, true);
    if (jsonEnd > data.length) throw new Error('Truncated local plugin storage value');
    const metadata = JSON.parse(decoder.decode(data.subarray(headerSize, metadataEnd)));
    return restoreGraph(metadata, JSON.parse(decoder.decode(data.subarray(metadataEnd, jsonEnd))), data, jsonEnd) as T;
}
