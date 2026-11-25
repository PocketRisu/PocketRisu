// URL shown to plugins for a request log entry: credentials in the authority,
// the query and the hash are dropped because they can carry secrets.
//
// Not every logged URL parses: requests sent through a plugin provider are logged
// as `plugin://<provider name>`, and a name with spaces or brackets is not a valid
// URL, which made getFetchLogs throw for every log (#115). Such entries, and
// other schemes (whose origin is the opaque "null", or blob:), keep their text up
// to the query or hash instead. Other unparsable URLs fail closed on credentials:
// everything up to the last `@` is dropped (only the scheme is kept), whatever
// shape the authority has. `plugin://` entries are left alone there, since the
// provider name may contain `@`.
export function fetchLogUrlForPlugin(rawUrl: string): string {
    const raw = String(rawUrl ?? '')
    try {
        // No base URL: with one, `https:/user:pass@host` would resolve as a same-scheme
        // relative path and skip the credential handling below.
        const url = new URL(raw)
        // Only plain web URLs: blob: reports its inner URL's origin and keeps that
        // URL (credentials included) in its path.
        if (/^(https?|wss?):$/.test(url.protocol)) {
            return url.origin + url.pathname
        }
    } catch {
        // fall through to the plain-text form
    }
    const text = raw.split(/[?#]/, 1)[0]
    if (text.startsWith('plugin://')) {
        return text
    }
    const at = text.lastIndexOf('@')
    if (at === -1) {
        return text
    }
    // A scheme only counts when a slash follows, so `user:pass@host` keeps no part of the user
    const scheme = /^\s*([a-z][a-z0-9+.-]*:)[\/\\]/i.exec(text)?.[1] ?? ''
    return (scheme ? scheme + '//' : '') + text.slice(at + 1)
}
