import { NodeStorage, type PatchItemResult, type ExportBackupOptions } from "./nodeStorage"

export class AutoStorage{
    isAccount:boolean = false

    realStorage:NodeStorage

    async setItem(key:string, value:Uint8Array, etag?:string):Promise<string|null> {
        await this.realStorage.setItem(key, value, etag)
        return null
    }
    async getItem(key:string):Promise<Buffer> {
        return await this.realStorage.getItem(key)
    }
    async keys(prefix: string = ''):Promise<string[]>{
        await this.Init()
        return await this.realStorage.keys(prefix)
    }
    async removeItem(key:string){
        return await this.realStorage.removeItem(key)
    }

    async checkAccountSync(){
        return false
    }

    async Init(){
        if(!this.realStorage){
            console.log("using node storage")
            this.realStorage = new NodeStorage()
        }
    }

    async createAuth(): Promise<string> {
        if (!this.realStorage) {
            this.realStorage = new NodeStorage()
        }
        return this.realStorage.createAuth()
    }

    async exportBackup(opts?: ExportBackupOptions) {
        await this.Init()
        return this.realStorage.exportBackup(opts)
    }

    async settingsBackupEstimate() {
        await this.Init()
        return this.realStorage.settingsBackupEstimate()
    }

    async importBackup(file: Blob, onProgress?: (loaded: number, total: number) => void) {
        await this.Init()
        return this.realStorage.importBackup(file, onProgress)
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return await this.realStorage.patchItem(key, patchData)
    }

    /** Writer-lock state for the reload-on-return check (see NodeStorage). */
    async getWriterLockState() {
        await this.Init()
        return this.realStorage.getWriterLockState()
    }

    /** Get the last known ETag for database.bin */
    getDbEtag(): string | null {
        return this.realStorage._lastDbEtag
    }

    /** Update cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this.realStorage.setDbEtag(etag)
    }

    listItem = this.keys

    // ── Bulk asset operations ──────────────────────────────────────────────────
    async getItems(keys: string[]) { return this.realStorage.getItems(keys) }
    async setItems(entries: {key: string, value: Uint8Array}[]) { return this.realStorage.setItems(entries) }

    // ── Server-side backup ─────────────────────────────────────────────────────
    async saveServerBackup(onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.saveServerBackup(onProgress) }
    async listServerBackups() { await this.Init(); return this.realStorage.listServerBackups() }
    async restoreServerBackup(filename: string, onProgress?: (bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.restoreServerBackup(filename, onProgress) }
    async deleteServerBackup(filename: string) { await this.Init(); return this.realStorage.deleteServerBackup(filename) }
    async downloadServerBackup(filename: string) { await this.Init(); return this.realStorage.downloadServerBackup(filename) }

    // ── Save-folder migration ─────────────────────────────────────────────────
    async scanSaveFolder(folderPath?: string) { await this.Init(); return this.realStorage.scanSaveFolder(folderPath) }
    async executeSaveFolderImport(folderPath?: string) { await this.Init(); return this.realStorage.executeSaveFolderImport(folderPath) }
    async uploadSaveFolderZip(file: Blob, onProgress?: (loaded: number, total: number) => void) { await this.Init(); return this.realStorage.uploadSaveFolderZip(file, onProgress) }
    async scanCleanup() { await this.Init(); return this.realStorage.scanCleanup() }
    async executeCleanup() { await this.Init(); return this.realStorage.executeCleanup() }
}
