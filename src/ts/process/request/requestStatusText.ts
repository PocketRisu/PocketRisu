import { language } from '../../../lang'
import { languageEnglish } from '../../../lang/en'

export function requestStatusText(key: keyof typeof language.requestStatus): string {
    const text = language.requestStatus[key] ?? languageEnglish.requestStatus[key]
    return typeof text === 'string' ? text : String(key)
}
