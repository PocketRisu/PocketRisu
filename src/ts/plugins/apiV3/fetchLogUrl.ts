// URL shown to plugins for a request log entry: the query and hash are dropped
// because they can carry API keys.
//
// Not every logged URL parses: requests sent through a plugin provider are logged
// as `plugin://<provider name>`, and a name with spaces or brackets is not a valid
// URL, which made getFetchLogs throw for every log (#115). Such entries, and
// non-web schemes whose origin is the opaque "null", keep their text up to the
// query or hash instead.
export function fetchLogUrlForPlugin(rawUrl: string): string {
    const raw = String(rawUrl ?? '')
    try {
        const url = new URL(raw, globalThis.location?.href)
        if (url.origin !== 'null') {
            return url.origin + url.pathname
        }
    } catch {
        // fall through to the plain-text form
    }
    return raw.split(/[?#]/, 1)[0]
}
