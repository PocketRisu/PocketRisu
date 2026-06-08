<script>
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { newChatModelDefaults } from 'src/ts/storage/database.svelte';
    import { ReloadGUIPointer, selectedCharID } from "../../ts/stores.svelte";
    import { DownloadIcon, SquarePenIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { exportChat, importChat } from "../../ts/characters";
    import { findCharacterbyId } from "../../ts/util";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { changeChatTo, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid";

    let editMode = $state(false)
    /** @type {{close?: any}} */
    let { close = () => {} } = $props();
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-72 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.chatList}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#each DBState.db.characters[$selectedCharID].chats as chat, i}
            <button onclick={() => {
                if(!editMode){
                    changeChatTo(i)
                    close()
                }
            }} class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === DBState.db.characters[$selectedCharID].chatPage}>
                {#if editMode}
                    <TextInput bind:value={DBState.db.characters[$selectedCharID].chats[i].name} padding={false}/>
                {:else}
                    <span>{chat.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    <div class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        exportChat(i)
                    }} onkeydown={() => {

                    }}>
                        <DownloadIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(DBState.db.characters[$selectedCharID].chats.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${chat.name}`)
                        if(d){
                            changeChatTo(0)
                            let chats = DBState.db.characters[$selectedCharID].chats
                            chats.splice(i, 1)
                            DBState.db.characters[$selectedCharID].chats = chats
                            void requestImmediateSave()
                        }
                    }} onkeydown={() => {
                        
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        <div class="flex mt-2 items-center">
            <button class="text-textcolor2 hover:text-primary cursor-pointer mr-1" onclick={() => {
                const len = DBState.db.characters[$selectedCharID].chats.length
                let chats = DBState.db.characters[$selectedCharID].chats
                const newChat = {
                    message:[], note:'', name:`New Chat ${len + 1}`, localLore:[], fmIndex: -1, id: v4(),
                    ...newChatModelDefaults()
                }
                chats.unshift(newChat)
                DBState.db.characters[$selectedCharID].chats = chats
                changeChatTo(0)
                void requestImmediateSave()
                close()
            }}>
                <PlusIcon/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
                <SquarePenIcon size={18}/>
            </button>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
