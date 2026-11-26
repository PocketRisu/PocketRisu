// Which toggle keys a chat pin controls, matching what loading it does
// (loadTogglesFromChat → applyToggleValues): every saved value is set, and of
// the recorded unset keys only those the current template (getToggleKeys:
// preset and enabled modules) still has are cleared. Any other toggle keeps
// whatever value it has, so only pinnedKeys can differ from the pin.
//
// uncoveredKeys are shown toggles the pin says nothing about, which updating
// the pin takes in: template keys it has neither saved nor recorded as unset
// (added after the pin, or a pin made before unset keys were recorded), and any
// shown toggle with a value it has not saved (the character's own toggles are
// not in the template, so only their values are ever pinned).
export function getTogglePinScope(
    saved: Record<string, string>,
    unsetKeys: readonly string[] | undefined,
    templateKeys: readonly string[],
    shown: { keys: readonly string[], values: Record<string, string> } = { keys: [], values: {} },
): { pinnedKeys: Set<string>, uncoveredKeys: string[] } {
    const template = new Set(templateKeys)
    const unset = new Set(unsetKeys ?? [])
    const pinnedKeys = new Set(Object.keys(saved))
    for (const key of unset) {
        if (template.has(key)) pinnedKeys.add(key)
    }
    const uncovered = new Set(templateKeys.filter((key) => !(key in saved) && !unset.has(key)))
    for (const key of shown.keys) {
        if (!(key in saved) && shown.values[key] !== undefined) uncovered.add(key)
    }
    return { pinnedKeys, uncoveredKeys: [...uncovered] }
}
