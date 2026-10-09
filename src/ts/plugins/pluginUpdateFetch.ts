export const getPluginUpdateFetchAttempts = (metadataOnly: boolean): RequestInit[] => {
    const noStore: RequestInit = { method: 'GET', cache: 'no-store' }
    const plainGet: RequestInit = { method: 'GET' }

    return metadataOnly
        ? [
            { ...noStore, headers: { Range: 'bytes=0-512' } },
            noStore,
            plainGet,
        ]
        : [noStore, plainGet]
}

export const fetchPluginUpdateResource = async (
    updateURL: string,
    metadataOnly: boolean,
    fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
    const requestURL = new URL(updateURL)
    requestURL.searchParams.set('_risu_update', String(Date.now()))

    let lastResponse: Response | undefined
    let lastError: unknown

    for (const init of getPluginUpdateFetchAttempts(metadataOnly)) {
        try {
            const response = await fetchImpl(requestURL.toString(), init)
            if (response.status >= 200 && response.status < 300) return response
            lastResponse = response
        } catch (error) {
            lastError = error
        }
    }

    if (lastResponse) return lastResponse
    throw lastError instanceof Error ? lastError : new Error('Plugin update request failed')
}
