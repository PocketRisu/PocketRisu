import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    TRANSFER_SIZE_CLEAR_BYTES,
    TRANSFER_SIZE_RECOMMENDED_BYTES,
    dbTransferSizeStore,
    nextTransferSizeState,
    recordDbTransferSize,
    type DbTransferSizeState,
} from './transferSize'

const MB = 1024 * 1024
const empty: DbTransferSizeState = { bytes: null, overLimit: false, source: null }

describe('nextTransferSizeState', () => {
    it('turns on at the recommended limit', () => {
        const s = nextTransferSizeState(empty, TRANSFER_SIZE_RECOMMENDED_BYTES, 'save')
        expect(s).toEqual({ bytes: TRANSFER_SIZE_RECOMMENDED_BYTES, overLimit: true, source: 'save' })
    })

    it('stays off below the limit', () => {
        const s = nextTransferSizeState(empty, 15 * MB, 'boot')
        expect(s).toEqual({ bytes: 15 * MB, overLimit: false, source: 'boot' })
    })

    it('keeps the warning between the clear and recommended bounds for the same source (hysteresis)', () => {
        const on = nextTransferSizeState(empty, 90 * MB, 'save')
        const between = nextTransferSizeState(on, 75 * MB, 'save')
        expect(between.overLimit).toBe(true)
        const stillOff = nextTransferSizeState({ bytes: 60 * MB, overLimit: false, source: 'save' }, 75 * MB, 'save')
        expect(stillOff.overLimit).toBe(false)
    })

    it('clears once below the clear bound', () => {
        const on = nextTransferSizeState(empty, 90 * MB, 'save')
        const off = nextTransferSizeState(on, TRANSFER_SIZE_CLEAR_BYTES - 1, 'save')
        expect(off.overLimit).toBe(false)
    })

    it('does not carry a boot overestimate into the first save measurement', () => {
        const boot = nextTransferSizeState(empty, 110 * MB, 'boot')
        expect(boot.overLimit).toBe(true)
        const save = nextTransferSizeState(boot, 74 * MB, 'save')
        expect(save).toEqual({ bytes: 74 * MB, overLimit: false, source: 'save' })
    })

    it('ignores a boot estimate once a save has been measured', () => {
        const save = nextTransferSizeState(empty, 74 * MB, 'save')
        expect(nextTransferSizeState(save, 110 * MB, 'boot')).toBe(save)
    })

    it('ignores invalid sizes', () => {
        const prev: DbTransferSizeState = { bytes: 90 * MB, overLimit: true, source: 'save' }
        expect(nextTransferSizeState(prev, NaN, 'save')).toBe(prev)
        expect(nextTransferSizeState(prev, -1, 'save')).toBe(prev)
    })
})

describe('recordDbTransferSize', () => {
    it('updates the store', () => {
        recordDbTransferSize(100 * MB, 'save')
        expect(get(dbTransferSizeStore)).toEqual({ bytes: 100 * MB, overLimit: true, source: 'save' })
        recordDbTransferSize(10 * MB, 'save')
        expect(get(dbTransferSizeStore)).toEqual({ bytes: 10 * MB, overLimit: false, source: 'save' })
    })
})
