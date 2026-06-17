export function shouldLogFetch(arg: { suppressFetchLog?: boolean }): boolean {
    return arg.suppressFetchLog !== true
}
