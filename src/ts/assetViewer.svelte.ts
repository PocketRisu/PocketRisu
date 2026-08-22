// Asset Viewer — a lightweight popup to browse, zoom and search the image assets
// of a single character or module. Opened from the character/module editor tabs.
// Scoped to one source at a time so it stays light even for users with many characters.

export const ASSET_VIEWER_IMAGE_EXTS = ['png', 'webp', 'jpeg', 'jpg', 'gif', 'avif', 'svg']

export interface AssetViewerItem {
    name: string
    path: string
    ext: string
}

export const assetViewerStore = $state<{
    open: boolean
    title: string
    items: AssetViewerItem[]
}>({
    open: false,
    title: '',
    items: [],
})

// Asset tuples are [name, path, ext]; ext may be missing on older data, so fall back to the path.
function assetExt(asset: [string, string, string]): string {
    return (asset[2] || asset[1]?.split('.').pop() || '').toLowerCase()
}

function isImageAsset(asset: [string, string, string]): boolean {
    return ASSET_VIEWER_IMAGE_EXTS.includes(assetExt(asset))
}

export function hasImageAssets(assets: [string, string, string][] | undefined): boolean {
    return !!assets && assets.some(isImageAsset)
}

export function openAssetViewer(title: string, assets: [string, string, string][] | undefined) {
    assetViewerStore.items = (assets ?? []).filter(isImageAsset).map((asset) => ({
        name: asset[0],
        path: asset[1],
        ext: assetExt(asset),
    }))
    assetViewerStore.title = title
    assetViewerStore.open = true
}

export function closeAssetViewer() {
    assetViewerStore.open = false
    assetViewerStore.items = []
    assetViewerStore.title = ''
}
