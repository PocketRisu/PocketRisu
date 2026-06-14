<script lang="ts">
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage } from "src/ts/characters";
    import { makeAgoText } from "src/ts/util";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(char: (character)[]) {
        return char.map((c, i) => ({
                name: c.name || "Unnamed",
                image: c.image,
                chats: c.chats.length,
                i: i,
                type: c.type,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
            })).sort((a, b) => {
            if (a.interaction === b.interaction) {
                return a.name.localeCompare(b.name);
            }
            return b.interaction - a.interaction;
        });
    }
</script>
<div class="flex flex-col items-center w-full overflow-y-auto h-full">
    {#each sortChar(DBState.db.characters) as char, i}
        {#if char.name.replace(/ /g,"").toLocaleLowerCase().includes(search.replace(/ /g,"").toLocaleLowerCase())}
            <button class="flex p-2 border-t-darkborderc gap-2 w-full" class:border-t={i !== 0} onclick={() => {
                changeChar(char.i)
                endGrid()
            }}>
                <BarIcon additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                <div class="flex flex-1 w-full flex-col justify-start items-start text-start">
                    <span>{char.name}</span>
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
