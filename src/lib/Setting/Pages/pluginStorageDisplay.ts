import { isLocalPluginStorageJsonEditable } from 'src/ts/plugins/localPluginStorageValue'

export interface PluginStorageDisplay {
    str: string
    size: number
    type: string
    jsonEditable: boolean
    binarySize: boolean
    mimeType?: string
    fileName?: string
}

function valueToString(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    return JSON.stringify(value)
}

function detectJsonType(str: string): string {
    if (!str) return 'empty'
    try {
        const value = JSON.parse(str)
        if (Array.isArray(value)) return 'array'
        if (value !== null && typeof value === 'object') return 'object'
        return typeof value
    } catch {
        return 'string'
    }
}

function nativeType(value: object): string {
    if (Array.isArray(value)) return 'array'
    const type = Object.prototype.toString.call(value).slice(8, -1)
    return type === 'Object' ? 'object' : type
}

// These are display summaries only. JSON editability is determined from the
// original value, never from the JSON-shaped preview containing placeholders.
export function describePluginStorageValue(value: unknown): PluginStorageDisplay {
    const jsonEditable = isLocalPluginStorageJsonEditable(value)
    if (jsonEditable) {
        const str = valueToString(value)
        return { str, size: str.length * 2, type: detectJsonType(str), jsonEditable, binarySize: false }
    }

    const seen = new WeakMap<object, string>()
    const ranges = new Map<ArrayBufferLike, [number, number][]>()
    let blobBytes = 0
    let binarySize = false

    function addRange(buffer: ArrayBufferLike, start: number, length: number) {
        binarySize = true
        const spans = ranges.get(buffer) ?? []
        spans.push([start, start + length])
        ranges.set(buffer, spans)
    }

    function summarize(item: unknown, path: string): unknown {
        if (item === undefined) return '[undefined]'
        if (typeof item === 'bigint') return `${item}n`
        if (typeof item === 'number') {
            if (Object.is(item, -0)) return '[-0]'
            if (!Number.isFinite(item)) return `[${item}]`
        }
        if (item === null || typeof item !== 'object') return item
        const previous = seen.get(item)
        if (previous !== undefined) return `[Reference: ${previous}]`
        seen.set(item, path)

        const type = nativeType(item)
        if (item instanceof Blob) {
            binarySize = true
            blobBytes += item.size
            const name = typeof File !== 'undefined' && item instanceof File ? `${JSON.stringify(item.name)}, ` : ''
            return `${type} (${name}${item.size} B${item.type ? `, ${item.type}` : ''})`
        }
        if (item instanceof ArrayBuffer) {
            addRange(item, 0, item.byteLength)
            return `ArrayBuffer (${item.byteLength} B)`
        }
        if (ArrayBuffer.isView(item)) {
            addRange(item.buffer, item.byteOffset, item.byteLength)
            return `${type} (${item.byteLength} B)`
        }
        if (item instanceof Date) {
            return `Date (${Number.isNaN(item.getTime()) ? 'Invalid Date' : item.toISOString()})`
        }
        if (item instanceof RegExp) return `RegExp (${item})`
        if (item instanceof Map) {
            return { Map: [...item].map(([key, entry], i) => [
                summarize(key, `${path}["Map"][${i}][0]`),
                summarize(entry, `${path}["Map"][${i}][1]`),
            ]) }
        }
        if (item instanceof Set) {
            return { Set: [...item].map((entry, i) => summarize(entry, `${path}["Set"][${i}]`)) }
        }
        if (['Number', 'Boolean', 'String', 'BigInt'].includes(type)) {
            return `${type} (${String(item.valueOf())})`
        }
        if (Array.isArray(item)) {
            const extraKeys = Object.keys(item).filter((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)
            const arrayPath = extraKeys.length ? `${path}["Array"]` : path
            const array = Array.from({ length: item.length }, (_, i) => Object.hasOwn(item, i)
                ? summarize(item[i], `${arrayPath}[${i}]`) : '[Empty]')
            if (!extraKeys.length) return array
            return { Array: array, properties: Object.fromEntries(extraKeys.map((key) => [
                key, summarize(item[key], `${path}["properties"][${JSON.stringify(key)}]`),
            ])) }
        }
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
            key, summarize(entry, `${path}[${JSON.stringify(key)}]`),
        ]))
    }

    const preview = summarize(value, '$')
    const str = typeof preview === 'string' ? preview : JSON.stringify(preview)
    let bytes = blobBytes
    // Count each visible byte once across overlapping views and direct buffer
    // references. Exclude unseen backing-buffer bytes and encoding overhead.
    for (const spans of ranges.values()) {
        spans.sort((a, b) => a[0] - b[0])
        let end = 0
        for (const [start, nextEnd] of spans) {
            bytes += Math.max(0, nextEnd - Math.max(start, end))
            end = Math.max(end, nextEnd)
        }
    }
    return {
        str,
        size: binarySize ? bytes : str.length * 2,
        type: value !== null && typeof value === 'object' ? nativeType(value) : typeof value,
        jsonEditable,
        binarySize,
        mimeType: value instanceof Blob ? value.type : undefined,
        fileName: typeof File !== 'undefined' && value instanceof File ? value.name : undefined,
    }
}
