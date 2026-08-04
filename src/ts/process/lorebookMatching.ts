export type LorebookMatchingMode = 'partial' | 'whitespace' | 'word-boundary'

export function resolveLorebookMatchingMode(
    mode: LorebookMatchingMode | undefined,
    legacyFullWordMatching: boolean | undefined,
): LorebookMatchingMode {
    if(mode === 'partial' || mode === 'whitespace' || mode === 'word-boundary'){
        return mode
    }
    return legacyFullWordMatching ? 'whitespace' : 'partial'
}

export function matchesLorebookKey(
    text: string,
    key: string,
    mode: LorebookMatchingMode,
    locale?: string,
): boolean {
    const normalizedText = text.toLocaleLowerCase(locale)
    const normalizedKey = key.trim().toLocaleLowerCase(locale)
    if(!normalizedKey){
        return false
    }

    if(mode === 'partial'){
        return normalizedText.replace(/ /g, '').includes(normalizedKey.replace(/ /g, ''))
    }
    if(mode === 'whitespace'){
        return normalizedText.split(' ').includes(normalizedKey)
    }

    const segments = Array.from(new Intl.Segmenter(locale, {
        granularity: 'word',
    }).segment(normalizedText))
    let matchIndex = normalizedText.indexOf(normalizedKey)

    while(matchIndex !== -1){
        const matchEnd = matchIndex + normalizedKey.length
        const startsOnWordBoundary = segments.some((segment) => {
            return segment.isWordLike && segment.index === matchIndex
        })
        const endsOnWordBoundary = segments.some((segment) => {
            return segment.isWordLike && segment.index + segment.segment.length === matchEnd
        })
        if(startsOnWordBoundary && endsOnWordBoundary){
            return true
        }
        matchIndex = normalizedText.indexOf(normalizedKey, matchIndex + 1)
    }

    return false
}
