import { describe, expect, test } from 'vitest'
import { describePluginStorageValue } from './pluginStorageDisplay'

describe('plugin storage display data sizes', () => {
    test('counts disjoint view ranges without including backing-buffer gaps', () => {
        const buffer = new ArrayBuffer(64)
        const value = [new Uint8Array(buffer, 4, 3), new DataView(buffer, 40, 5)]
        const display = describePluginStorageValue(value)
        expect(display.size).toBe(8)
        expect(display.binarySize).toBe(true)
        expect(JSON.parse(display.str)).toEqual(['Uint8Array (3 B)', 'DataView (5 B)'])
    })

    test.each([false, true])('counts the full buffer once when a view is also present (buffer first: %s)', (bufferFirst) => {
        const buffer = new ArrayBuffer(16)
        const view = new Uint32Array(buffer, 4, 2)
        const display = describePluginStorageValue(bufferFirst ? [buffer, view, view] : [view, buffer, view])
        expect(display.size).toBe(16)
        expect(display.str).toContain('Uint32Array (8 B)')
        expect(display.str).toContain('Reference')
    })

    test('uses view bytes for BigInt arrays without expanding elements', () => {
        const display = describePluginStorageValue(new BigInt64Array([1n, 2n]))
        expect(display).toMatchObject({ str: 'BigInt64Array (16 B)', size: 16, type: 'BigInt64Array', jsonEditable: false })
    })
})

describe('plugin storage display compatibility', () => {
    test.each([
        ['', '', 'empty'],
        ['{"text":"value"}', '{"text":"value"}', 'object'],
        ['plain string', 'plain string', 'string'],
        [null, '', 'empty'],
        [true, 'true', 'boolean'],
        [{ text: 'value', values: [1, 2] }, '{"text":"value","values":[1,2]}', 'object'],
    ] as const)('retains the ordinary JSON/string presentation for %j', (value, str, type) => {
        expect(describePluginStorageValue(value)).toEqual({ str, size: str.length * 2, type, jsonEditable: true, binarySize: false })
    })

    test('shows legacy special primitives and sparse array properties without making them editable', () => {
        const array: any = [undefined, , NaN, -0, 3n]
        array.label = 'legacy'
        const display = describePluginStorageValue({ array, date: new Date('invalid'), expression: /clip/gi })
        expect(JSON.parse(display.str)).toEqual({
            array: { Array: ['[undefined]', '[Empty]', '[NaN]', '[-0]', '3n'], properties: { label: 'legacy' } },
            date: 'Date (Invalid Date)', expression: 'RegExp (/clip/gi)',
        })
        expect(display.jsonEditable).toBe(false)
        expect(display.binarySize).toBe(false)
    })
})
