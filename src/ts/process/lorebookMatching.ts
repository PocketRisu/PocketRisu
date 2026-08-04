export type LorebookMatchingMode = 'partial' | 'whitespace' | 'word-boundary'

const KOREAN_WORD_SUFFIXES = new Set([
    '은', '는', '이', '가', '을', '를', '의', '에', '에서',
    '에게', '한테', '께', '와', '과', '도', '만', '부터', '까지',
    '로', '으로', '랑', '이랑', '하고', '보다', '처럼', '만큼',
    '마다', '조차', '마저', '밖에', '뿐',
    '이라', '라', '이라고', '라고', '이라는', '라는', '이란', '란',
    '이야', '야', '이에요', '예요', '입니다', '이고', '이며', '이면',
])

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
        const endingSegment = segments.find((segment) => {
            const segmentEnd = segment.index + segment.segment.length
            return segment.isWordLike && segment.index < matchEnd && segmentEnd > matchEnd
        })
        if(startsOnWordBoundary && endingSegment){
            const suffix = normalizedText.slice(
                matchEnd,
                endingSegment.index + endingSegment.segment.length,
            )
            if(KOREAN_WORD_SUFFIXES.has(suffix)){
                return true
            }
        }
        matchIndex = normalizedText.indexOf(normalizedKey, matchIndex + 1)
    }

    return false
}
