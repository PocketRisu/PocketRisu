<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte';
    import isEqual from 'lodash/isEqual';
    import { mount, onDestroy, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import RequestStatusInline from '../UI/GUI/RequestStatusInline.svelte';
    import { requestStatuses, isTerminalPhase } from 'src/ts/status/requestStatus';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    // Mirrors sendChat()'s roomId fallback exactly (currentChat.id ||
    // chatPage.toString()) — deliberately separate from getCurrentChatRoomId()
    // above, which other code already depends on returning null (not a
    // chatPage fallback) for the per-message hash. Chat.id is optional, so
    // without this dedicated fallback, a live pipeline entry's roomId could
    // never match here for chats that predate the `.id` field.
    const getCurrentPipelineRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id || char.chatPage.toString();
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        bottomInset = 0,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: () => void
        onNextSwipe?: () => void
        unReroll: () => void
        onDeleteSwipe?: () => void
        currentUsername: string
        userIcon: string
        loadPages: number
        userIconPortrait?: boolean
        bottomInset?: number
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    // Cache the simple-character snapshot so its REFERENCE stays stable while the
    // character is unchanged. updateChatBody runs on every streaming tick and
    // Object.assign-copies `character` into every message's reactive props; a
    // fresh object each tick made every ChatBody's markdown derived re-run (all
    // messages blank→re-parse during streaming — a real heat/flicker bug).
    let cachedSimpleChar: ReturnType<typeof createSimpleCharacter> | null = null;
    // Same idea for the avatar images: getCharImage() is async and returns a
    // NEW Promise object on every call even when the resolved image is
    // identical, so re-issuing it every streaming tick reassigns `img` on
    // every visible message and retriggers Chat.svelte's `{#await img}`
    // placeholder — a per-tick avatar flicker. Only recompute when the
    // underlying image location (or the hide-images setting) actually changes.
    let cachedCharImageKey: string | null = null;
    let cachedCharImage: Promise<string | null> | null = null;
    let cachedUserImageKey: string | null = null;
    let cachedUserImage: Promise<string | null> | null = null;
    let hashes: Set<number> = new Set();
    let mountInstances: Map<number, any> = new Map();
    let mountProps: Map<number, any> = new Map();

    //Non-cryptographic hash function to generate a unique hash for each message
    function hashCode(str:string):number {
        let hash = 0;
        for (let i = 0, len = str.length; i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0; // Convert to 32bit integer
        }
        if(hash == 0){
            hash = 1; // Ensure hash is not zero
        }
        return hash;
    }

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        let nextHash = 0;
        let currentHashes: Set<number> = new Set();
        const charImageKey = `${currentCharacter.image}::${DBState.db.hideAllImages}`;
        if (charImageKey !== cachedCharImageKey) {
            cachedCharImageKey = charImageKey;
            cachedCharImage = getCharImage(currentCharacter.image, 'css');
        }
        const charImage = cachedCharImage;
        const userImageKey = `${userIcon}::${DBState.db.hideAllImages}`;
        if (userImageKey !== cachedUserImageKey) {
            cachedUserImageKey = userImageKey;
            cachedUserImage = getCharImage(userIcon, 'css');
        }
        const userImage = cachedUserImage;
        // Only swap the reference when the snapshot's CONTENT actually changes,
        // so streaming ticks don't churn `character` for every message.
        const candidateSimpleChar = createSimpleCharacter(currentCharacter);
        if (!cachedSimpleChar || !isEqual(cachedSimpleChar, candidateSimpleChar)) {
            cachedSimpleChar = candidateSimpleChar;
        }
        const simpleChar = cachedSimpleChar;
        const currentChatRoomId = getCurrentChatRoomId() ?? '';
        let loadStart = messages.length - 1
        let loadEnd = messages.length - loadPages

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        if(chatFoldedStateMessageIndex.index !== -1){
            loadStart = chatFoldedStateMessageIndex.index
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const reloadPointer = reloadPointerMap[i] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const stableMessageId = message.chatId ?? `${message.role ?? ''}:${message.time ?? ''}:${i}`;
            const hashd = currentChatRoomId + stableMessageId + i.toString() + messageLargePortrait.toString() + message.disabled?.toString() + reloadPointer.toString() + (message.swipeId ?? 0).toString() + (message.swipes?.length ?? 0).toString() + isRerollTarget.toString();
            const currentHash = hashCode(hashd);
            currentHashes.add(currentHash);

            const swipes = message.swipes;
            const swipeId = message.swipeId ?? 0;
            const nextProps: any = {
                message: message.data ?? '',
                isLastMemory: false,
                idx: i,
                chatId: message.chatId,
                img: message.role === 'user' ? userImage : charImage,
                onReroll: onReroll,
                onNextSwipe: i === lastRealCharIdx ? onNextSwipe : () => {},
                unReroll: unReroll,
                onDeleteSwipe: i === lastRealCharIdx ? onDeleteSwipe : () => {},
                rerollIcon: i === lastRealCharIdx ? 'force' : false,
                character: simpleChar,
                largePortrait: messageLargePortrait,
                messageGenerationInfo: message.generationInfo,
                role: message.role,
                name: message.role === 'user' ? currentUsername : currentCharacter.name,
                isComment: message.isComment ?? false,
                disabled: message.disabled ?? false,
                currentPage: i === lastRealCharIdx ? (swipeId ?? 0) + 1 : 1,
                totalPages: i === lastRealCharIdx ? (swipes?.length ?? 1) : 1,
            };

            if(!hashes.has(currentHash)){
                const b = document.createElement('div');
                b.setAttribute('x-hashed', currentHash.toString());
                b.setAttribute('data-role', message.role ?? 'char');
                b.classList.add('chat-message-container');
                b.classList.add('chat-message-appear');
                const reactiveProps = $state(nextProps);
                const inst = mount(Chat, {
                    target: b,
                    props: reactiveProps,
                })
                mountInstances.set(currentHash, inst);
                mountProps.set(currentHash, reactiveProps);
                const nextElement = nextHash === 0 ? null : chatBody.querySelector(`[x-hashed="${nextHash}"]`);
                if(nextElement){
                    chatBody.insertBefore(b, nextElement?.nextSibling);
                }
                else{
                    chatBody.prepend(b);
                }
            }
            else{
                const reactiveProps = mountProps.get(currentHash);
                if(reactiveProps){
                    Object.assign(reactiveProps, nextProps);
                }
            }
            nextHash = currentHash;

        }

        // Detailed-mode synthetic status row: a live pipeline entry for this
        // room that hasn't produced a real message yet (covers Hypa +
        // MultiAgent, which have no chat-log row of their own). Appended after
        // the last real message (bottom-most / newest position). Once the real
        // placeholder message appears with a matching chatId, this stops being
        // in currentHashes and the existing toRemove diffing below unmounts it
        // automatically — Chat.svelte then anchors the same stepper inside
        // that real row instead. See RequestStatusInline.svelte.
        if(DBState.db.requestStatusDisplayMode === 'detailed'){
            const pipelineRoomId = getCurrentPipelineRoomId();
            for(const [statusId, entry] of get(requestStatuses)){
                if(!entry.steps?.length || isTerminalPhase(entry.phase)) continue;
                if(entry.roomId !== pipelineRoomId) continue;
                if(messages.some((m) => m.chatId === statusId)) continue;
                const syntheticHash = hashCode(`synthetic-status:${statusId}`);
                currentHashes.add(syntheticHash);
                if(!hashes.has(syntheticHash)){
                    const b = document.createElement('div');
                    b.setAttribute('x-hashed', syntheticHash.toString());
                    b.setAttribute('data-role', 'char');
                    b.classList.add('chat-message-container');
                    const reactiveProps = $state({ id: statusId });
                    const inst = mount(RequestStatusInline, {
                        target: b,
                        props: reactiveProps,
                    });
                    mountInstances.set(syntheticHash, inst);
                    mountProps.set(syntheticHash, reactiveProps);
                    chatBody.prepend(b);
                }
            }
        }

        //@ts-expect-error Set<T> requires type arg, and Set.difference needs 'esnext' lib (polyfilled by Core-js)
        const toRemove:Set = hashes.difference(currentHashes);
        toRemove.forEach((hash) => {
            const inst = mountInstances.get(hash);
            if(inst){
                unmount(inst);
                mountInstances.delete(hash);
                mountProps.delete(hash);
            }
            const element = chatBody.querySelector(`[x-hashed="${hash}"]`);
            if(element){
                chatBody.removeChild(element);
            }
        });

        hashes = currentHashes;
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        hashes.clear();
        mountInstances.forEach((inst) => {
            unmount(inst);
        });
        mountInstances.clear();
        mountProps.clear();
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    // How close (in px) the latest message's bottom may sit from the viewport
    // bottom and still count as "stuck to the bottom".
    const STICK_THRESHOLD = 80;

    // The chat container is `flex-col-reverse`, so the latest message is the
    // first DOM child and sits at the visual bottom. Streaming grows that
    // message every tick; we only want to follow it down while the user is
    // already pinned to the bottom — otherwise their scroll position must stay
    // put. We can't rely on native `column-reverse` stickiness because the
    // streamed markdown re-renders each tick, which discards the browser's
    // scroll anchor and drags the viewport down regardless of position.
    function measurePinnedToBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = chatBody.parentElement.getBoundingClientRect();
        // When pinned, the latest message rests `bottomInset` above the raw
        // viewport bottom (the floating composer occupies that strip), so the
        // stick zone is measured against `scRect.bottom - bottomInset`.
        return rect.bottom <= scRect.bottom - bottomInset + STICK_THRESHOLD;
    }

    let pinnedToBottom = true;
    // A non-growing message currently visible near the top of the viewport,
    // used to restore the scroll position after the latest message grows while
    // the user is scrolled up. Offsets are read from getBoundingClientRect so
    // the math is independent of the browser-specific `scrollTop` sign that
    // `column-reverse` introduces.
    let anchorEl: Element | null = null;
    let anchorOffset = 0;
    let suppressScrollHandling = false;

    function captureAnchor() {
        anchorEl = null;
        if (!chatBody || !chatBody.parentElement) return;
        const scRect = chatBody.parentElement.getBoundingClientRect();
        // Anchor on the element at the top of the viewport: it's the oldest
        // message in view and won't change height while the latest message
        // streams in at the bottom. Pick the visible child with the smallest
        // top edge (DOM order is latest-first, so the streaming message sits at
        // the bottom and is never chosen).
        let best: Element | null = null;
        let bestTop = Infinity;
        for (const child of Array.from(chatBody.children)) {
            const rect = child.getBoundingClientRect();
            const visible = rect.bottom > scRect.top && rect.top < scRect.bottom;
            if (visible && rect.top < bestTop) {
                best = child;
                bestTop = rect.top;
            }
        }
        if (best) {
            anchorEl = best;
            anchorOffset = bestTop - scRect.top;
        }
    }

    function handleContainerScroll() {
        if (suppressScrollHandling) return;
        pinnedToBottom = measurePinnedToBottom();
        if (!pinnedToBottom) captureAnchor();
    }

    function withSuppressedScroll(fn: () => void) {
        suppressScrollHandling = true;
        fn();
        // Release after the programmatic scroll event has been dispatched.
        requestAnimationFrame(() => { suppressScrollHandling = false; });
    }

    $effect(() => {
        const container = chatBody?.parentElement;
        if (!container) return;

        pinnedToBottom = measurePinnedToBottom();
        container.addEventListener('scroll', handleContainerScroll, { passive: true });

        const observer = new ResizeObserver(() => {
            if (pinnedToBottom) {
                // Follow the growing reply down so the newest text stays in view.
                const lastEl = chatBody?.firstElementChild as HTMLElement | null;
                if (lastEl) {
                    withSuppressedScroll(() => {
                        scrollWithinContainer(lastEl, container, { block: 'end', behavior: 'instant', bottomInset });
                    });
                }
            } else if (anchorEl && chatBody?.contains(anchorEl)) {
                // Counteract the layout shift so the user stays where they were.
                const scRect = container.getBoundingClientRect();
                const current = anchorEl.getBoundingClientRect().top - scRect.top;
                const drift = current - anchorOffset;
                if (drift !== 0) {
                    withSuppressedScroll(() => {
                        container.scrollTop += drift;
                    });
                }
            }
        });
        observer.observe(chatBody);

        return () => {
            container.removeEventListener('scroll', handleContainerScroll);
            observer.disconnect();
        };
    });

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'end', behavior: 'instant', bottomInset });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        // The user explicitly asked to jump to the newest message, so re-pin to
        // the bottom and let streaming follow along from here.
        pinnedToBottom = true;
        scrollLatestIntoChatScreen();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        void $requestStatuses; // Make $effect track detailed-mode pipeline updates
        const wasAtBottom = checkIfAtBottom();
        updateChatBody()

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;

        // Never force the viewport to the latest message during generation.
        // Keep the user's current scroll position and expose the manual new-message
        // button only when the reply arrived outside the visible bottom area.
        if(isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && !wasAtBottom){
                hasNewUnreadMessage = true;
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}></div>
