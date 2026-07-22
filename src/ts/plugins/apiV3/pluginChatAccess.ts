export type PluginChatLike = {
    id?: string
    message?: unknown[]
    _placeholder?: boolean
    _stub?: boolean
    [key: string]: any
}

export type PluginCharacterLike = {
    chaId?: string
    chats?: PluginChatLike[]
    [key: string]: any
}

export type PluginDatabaseLike = {
    characters?: PluginCharacterLike[]
    [key: string]: any
}

export type PluginChatAccessDependencies = {
    getDatabase: () => PluginDatabaseLike
    hydrateChat: (
        chats: PluginChatLike[],
        index: number,
        chaId: string,
    ) => Promise<PluginChatLike | null>
    normalizeChat: (chat: PluginChatLike) => PluginChatLike
    markChatDirty: (chaId: string, chatId: string) => void
    markCharacterDirty: (chaId: string) => void
}

type CharacterTarget = {
    database: PluginDatabaseLike
    characters: PluginCharacterLike[]
    key: string
    ordinal: number
    character: PluginCharacterLike
}

type ChatTarget = CharacterTarget & {
    chats: PluginChatLike[]
    chatIndex: number
    chat: PluginChatLike
    chatId: string
}

type CommitGuard = () => boolean

const MAX_COLLECTION_HYDRATION_PASSES = 3

function characterKeys(characters: PluginCharacterLike[]): string[] {
    return Object.keys(characters)
}

/**
 * Keeps the compatibility-facing plugin APIs from ever exposing runtime-only
 * lazy placeholders as real empty chats. The RPC bridge already awaits every
 * API function, so these asynchronous trust-boundary checks do not alter the
 * plugin-side calling convention.
 */
export class PluginChatAccess {
    constructor(private readonly dependencies: PluginChatAccessDependencies) {}

    private resolveCharacterAt(
        database: PluginDatabaseLike,
        ordinal: number,
    ): CharacterTarget | null {
        const characters = database?.characters
        if (!Array.isArray(characters)) return null

        const key = characterKeys(characters)[ordinal]
        if (key === undefined) return null
        const character = (characters as any)[key] as PluginCharacterLike | undefined
        if (!character) return null

        return { database, characters, key, ordinal, character }
    }

    private characterTargetIsCurrent(target: CharacterTarget): boolean {
        const currentDatabase = this.dependencies.getDatabase()
        if (currentDatabase !== target.database) return false
        if (currentDatabase.characters !== target.characters) return false
        if (characterKeys(target.characters)[target.ordinal] !== target.key) return false
        return (target.characters as any)[target.key] === target.character
    }

    private assertCharacterTargetIsCurrent(target: CharacterTarget): void {
        if (!this.characterTargetIsCurrent(target)) {
            throw new Error('The plugin character target changed while chats were loading')
        }
    }

    private chatTargetIsCurrent(target: ChatTarget): boolean {
        if (!this.characterTargetIsCurrent(target)) return false
        if (target.character.chats !== target.chats) return false

        const current = target.chats[target.chatIndex]
        if (!current) return false
        return target.chatId ? current.id === target.chatId : current === target.chat
    }

    private assertChatTargetIsCurrent(target: ChatTarget): PluginChatLike {
        if (!this.chatTargetIsCurrent(target)) {
            throw new Error('The plugin chat target changed while it was loading')
        }
        return target.chats[target.chatIndex]
    }

    private assertCharacterChatsAreHydrated(chats: PluginChatLike[]): void {
        const unsafeIndex = chats.findIndex(chat => !chat
            || chat._placeholder
            || chat._stub
            || !Array.isArray(chat.message))
        if (unsafeIndex !== -1) {
            throw new Error(`Refusing to expose unhydrated plugin chat ${unsafeIndex}`)
        }
    }

    private async hydrateCharacterTarget(target: CharacterTarget): Promise<void> {
        const chats = target.character.chats
        if (!Array.isArray(chats) || chats.length === 0) return

        const chaId = target.character.chaId
        if (chats.some(chat => chat?._placeholder) && !chaId) {
            throw new Error('Cannot hydrate plugin chats for a character without an ID')
        }

        for (let pass = 0; pass < MAX_COLLECTION_HYDRATION_PASSES; pass++) {
            this.assertCharacterTargetIsCurrent(target)
            if (target.character.chats !== chats) {
                throw new Error('The plugin character chat list changed while it was loading')
            }

            const placeholders = chats.filter(chat => chat?._placeholder)
            if (placeholders.length === 0) {
                this.assertCharacterChatsAreHydrated(chats)
                return
            }

            for (const placeholder of placeholders) {
                this.assertCharacterTargetIsCurrent(target)
                if (target.character.chats !== chats) {
                    throw new Error('The plugin character chat list changed while it was loading')
                }

                const currentIndex = chats.indexOf(placeholder)
                if (currentIndex === -1 || !chats[currentIndex]?._placeholder) continue

                const hydrated = await this.dependencies.hydrateChat(chats, currentIndex, chaId!)
                this.assertCharacterTargetIsCurrent(target)
                if (target.character.chats !== chats) {
                    throw new Error('The plugin character chat list changed while it was loading')
                }

                if (!hydrated && chats.includes(placeholder) && placeholder._placeholder) {
                    throw new Error(`Plugin chat hydration failed (${chaId}/${placeholder.id ?? currentIndex})`)
                }
            }
        }

        if (chats.some(chat => chat?._placeholder)) {
            throw new Error('The plugin character chat list kept changing while it was loading')
        }
        this.assertCharacterChatsAreHydrated(chats)
    }

    async getHydratedDatabase(): Promise<PluginDatabaseLike> {
        const database = this.dependencies.getDatabase()
        const characters = database?.characters
        if (!Array.isArray(characters)) return database

        const keys = characterKeys(characters)
        const targets = keys.map((_key, ordinal) => this.resolveCharacterAt(database, ordinal))
        for (const target of targets) {
            if (!target) continue
            await this.hydrateCharacterTarget(target)
        }

        if (this.dependencies.getDatabase() !== database
            || database.characters !== characters
            || characterKeys(characters).some((key, index) => key !== keys[index])
            || characterKeys(characters).length !== keys.length) {
            throw new Error('The plugin database changed while chats were loading')
        }
        for (const target of targets) {
            if (target) this.assertCharacterTargetIsCurrent(target)
        }
        return database
    }

    async getHydratedCharacterAt(ordinal: number): Promise<PluginCharacterLike | null> {
        const target = this.resolveCharacterAt(this.dependencies.getDatabase(), ordinal)
        if (!target) return null
        await this.hydrateCharacterTarget(target)
        this.assertCharacterTargetIsCurrent(target)
        return target.character
    }

    private async resolveHydratedChatAt(
        characterOrdinal: number,
        chatIndex: number,
    ): Promise<ChatTarget | null> {
        const target = this.resolveCharacterAt(this.dependencies.getDatabase(), characterOrdinal)
        if (!target) return null

        const chats = target.character.chats
        if (!Array.isArray(chats)) return null
        const chat = chats[chatIndex]
        if (!chat) return null

        const chatId = typeof chat.id === 'string' ? chat.id : ''
        const chatTarget: ChatTarget = {
            ...target,
            chats,
            chatIndex,
            chat,
            chatId,
        }

        if (chat._placeholder) {
            if (!target.character.chaId || !chatId) {
                throw new Error('Cannot hydrate a plugin chat without stable character and chat IDs')
            }
            const hydrated = await this.dependencies.hydrateChat(
                chats,
                chatIndex,
                target.character.chaId,
            )
            if (!hydrated) {
                throw new Error(`Plugin chat hydration failed (${target.character.chaId}/${chatId})`)
            }
        }

        const current = this.assertChatTargetIsCurrent(chatTarget)
        if (current._placeholder || current._stub || !Array.isArray(current.message)) {
            throw new Error('Refusing to expose an unhydrated chat to a plugin')
        }
        return chatTarget
    }

    async getHydratedChatAt(
        characterOrdinal: number,
        chatIndex: number,
    ): Promise<PluginChatLike | null> {
        const target = await this.resolveHydratedChatAt(characterOrdinal, chatIndex)
        return target ? target.chats[target.chatIndex] : null
    }

    async replaceChatAt(
        characterOrdinal: number,
        chatIndex: number,
        incoming: PluginChatLike,
        commitGuard: CommitGuard = () => true,
    ): Promise<void> {
        const target = await this.resolveHydratedChatAt(characterOrdinal, chatIndex)
        if (!target) return

        const current = this.assertChatTargetIsCurrent(target)
        const stableChatId = current.id
        const chaId = target.character.chaId
        if (!chaId || !stableChatId) {
            throw new Error('Cannot replace a plugin chat without stable character and chat IDs')
        }
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            throw new Error('Plugin chat setter requires a chat object')
        }
        if (incoming._placeholder || incoming._stub || !Array.isArray(incoming.message)) {
            throw new Error('Plugin chat setter requires a fully hydrated chat payload')
        }
        if (incoming.id && incoming.id !== stableChatId) {
            throw new Error('Plugin chat setter cannot change the target chat ID')
        }

        const next = this.dependencies.normalizeChat({ ...incoming, id: stableChatId })
        delete next._placeholder
        delete next._stub

        this.assertChatTargetIsCurrent(target)
        if (!commitGuard()) {
            throw new Error('The plugin chat target is no longer selected')
        }
        target.chats[chatIndex] = next
        this.dependencies.markChatDirty(chaId, stableChatId)
        this.dependencies.markCharacterDirty(chaId)
    }

    private normalizeCharacterReplacement(
        incoming: PluginCharacterLike,
        stableChaId: string,
    ): PluginCharacterLike {
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            throw new Error('Plugin character setter requires a character object')
        }
        if (incoming.chaId && incoming.chaId !== stableChaId) {
            throw new Error('Plugin character setter cannot change the target character ID')
        }
        if (!Array.isArray(incoming.chats)) {
            throw new Error('Plugin character setter requires a chats array')
        }

        const seenChatIds = new Set<string>()
        const chats = incoming.chats.map((chat, index) => {
            if (!chat || typeof chat !== 'object' || Array.isArray(chat)
                || chat._placeholder || chat._stub || !Array.isArray(chat.message)) {
                throw new Error(`Plugin character setter chat ${index} is not fully hydrated`)
            }
            if (typeof chat.id !== 'string' || chat.id.length === 0) {
                throw new Error(`Plugin character setter chat ${index} has no stable ID`)
            }
            if (seenChatIds.has(chat.id)) {
                throw new Error(`Plugin character setter contains duplicate chat ID: ${chat.id}`)
            }
            seenChatIds.add(chat.id)

            const normalized = this.dependencies.normalizeChat({ ...chat })
            delete normalized._placeholder
            delete normalized._stub
            return normalized
        })

        return { ...incoming, chaId: stableChaId, chats }
    }

    async replaceCharacterAt(
        ordinal: number,
        incoming: PluginCharacterLike,
        commitGuard: CommitGuard = () => true,
    ): Promise<void> {
        const target = this.resolveCharacterAt(this.dependencies.getDatabase(), ordinal)
        if (!target) return
        await this.hydrateCharacterTarget(target)
        this.assertCharacterTargetIsCurrent(target)

        const stableChaId = target.character.chaId
        if (!stableChaId) {
            throw new Error('Cannot replace a plugin character without a stable character ID')
        }
        const next = this.normalizeCharacterReplacement(incoming, stableChaId)

        this.assertCharacterTargetIsCurrent(target)
        if (!commitGuard()) {
            throw new Error('The plugin character target is no longer selected')
        }
        const characters = target.characters as any
        characters[target.key] = next
        this.dependencies.markCharacterDirty(stableChaId)
        for (const chat of next.chats ?? []) {
            this.dependencies.markChatDirty(stableChaId, chat.id!)
        }
    }

    validateCharacterCollection(characters: unknown): PluginCharacterLike[] {
        if (!Array.isArray(characters)) {
            throw new Error('Plugin database setter requires a characters array')
        }

        const seenCharacterIds = new Set<string>()
        return characters.map((character, index) => {
            const chaId = character?.chaId
            if (typeof chaId !== 'string' || chaId.length === 0) {
                throw new Error(`Plugin database setter character ${index} has no stable ID`)
            }
            if (seenCharacterIds.has(chaId)) {
                throw new Error(`Plugin database setter contains duplicate character ID: ${chaId}`)
            }
            seenCharacterIds.add(chaId)
            return this.normalizeCharacterReplacement(character, chaId)
        })
    }

    markCharacterCollectionDirty(previous: PluginCharacterLike[], next: PluginCharacterLike[]): void {
        const allCharacterIds = new Set<string>()
        for (const character of [...previous, ...next]) {
            if (character?.chaId) allCharacterIds.add(character.chaId)
        }
        for (const chaId of allCharacterIds) this.dependencies.markCharacterDirty(chaId)
        for (const character of next) {
            if (!character?.chaId) continue
            for (const chat of character.chats ?? []) {
                if (chat?.id) this.dependencies.markChatDirty(character.chaId, chat.id)
            }
        }
    }
}
