<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage } from "src/ts/characters";
    import { promptActivateCharacter } from "src/ts/characterArchive";
    import { makeAgoText } from "src/ts/util";
    import { language } from "src/lang";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(db: Database) {
        const list = db.characters.map((c, i) => ({
                name: c.name || "Unnamed",
                image: c.image,
                chats: c.chats.length,
                i: i,
                type: c.type,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
                trashTime: c.trashTime,
                archived: false,
                chaId: c.chaId,
            })).filter((c) => !c.trashTime)
        // Deactivated characters are listed in place (dimmed); tapping one
        // asks to activate it first.
        if (!db.nodeOnlyHideArchivedCharacters) {
            for (const stub of db.nodeOnlyArchivedCharacters ?? []) {
                if (!stub?.chaId) continue
                list.push({
                    name: stub.name || "Unnamed",
                    image: stub.image,
                    chats: stub.chatCount ?? 0,
                    i: -1,
                    type: 'character',
                    interaction: stub.lastInteraction || 0,
                    agoText: makeAgoText(stub.lastInteraction || 0),
                    trashTime: undefined,
                    archived: true,
                    chaId: stub.chaId,
                })
            }
        }
        return list.sort((a, b) => {
            if (a.interaction === b.interaction) {
                return a.name.localeCompare(b.name);
            }
            return b.interaction - a.interaction;
        });
    }

    async function open(char: { i: number; archived: boolean; chaId: string }) {
        if (char.archived) {
            const opened = await promptActivateCharacter(char.chaId)
            if (opened) endGrid()
            return
        }
        changeChar(char.i)
        endGrid()
    }
</script>
<div class="flex flex-col items-center w-full overflow-y-auto h-full">
    {#each sortChar(DBState.db) as char, i}
        {#if char.name.replace(/ /g,"").toLocaleLowerCase().includes(search.replace(/ /g,"").toLocaleLowerCase())}
            <button class="flex p-2 border-t-darkborderc gap-2 w-full" class:border-t={i !== 0} class:opacity-60={char.archived} onclick={() => {
                void open(char)
            }}>
                <div class:grayscale={char.archived}>
                    <BarIcon additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                </div>
                <div class="flex flex-1 w-full flex-col justify-start items-start text-start">
                    <span>
                        {char.name}
                        {#if char.archived}
                            <span class="ml-1 align-middle text-xs text-textcolor2 border border-darkborderc rounded px-1 py-0.5">{language.deactivatedBadge}</span>
                        {/if}
                    </span>
                    <div class="text-sm text-textcolor2 flex items-center w-full flex-wrap">
                        <span class="mr-1">{char.chats}</span>
                        <MessageSquareIcon size={14} />
                        <span class="mr-1 ml-1">|</span>
                        <span>{char.agoText}</span>
                    </div>
                </div>
            </button>
        {/if}
    {/each}
</div>

{#if gridMode}
    <button class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc" onclick={() => {
        addCharacter()
    }}>
        <PlusIcon size={24} />
    </button>
{/if}
