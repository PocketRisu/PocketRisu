<script lang="ts">
    import { changeChar, getCharImage, removeChar } from "../../ts/characters";
    import { promptActivateCharacter } from "../../ts/characterArchive";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, User, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { parseMultilangString } from "src/ts/util";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
  import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    interface Props {
        endGrid?: any;
    }

    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let selected = $state(3)

    function selectAndClose(index = -1){
        changeChar(index)
        endGrid()
    }

    type CatalogEntry = {
        image:string
        index:number
        type:string,
        name:string
        desc:string
        chaId:string
        archived:boolean
    }

    // Deactivated entries have no index; activation (with confirmation)
    // happens first and then the character opens like any other.
    async function openChar(char: CatalogEntry){
        if(char.archived){
            const opened = await promptActivateCharacter(char.chaId)
            if(opened) endGrid()
            return
        }
        selectAndClose(char.index)
    }

    function matchesSearch(name:string, search:string){
        return (name ?? '').replace(/ /g,"").toLocaleLowerCase().includes(search.toLocaleLowerCase().replace(/ /g,""))
    }

    function formatChars(search:string, db:Database, trash = false){
        let charas:CatalogEntry[] = []

        for(let i=0;i<db.characters.length;i++){
            const c = db.characters[i]
            if(c.trashTime && !trash){
                continue
            }
            if(!c.trashTime && trash){
                continue
            }
            if(matchesSearch(c.name, search)){
                charas.push({
                    image: c.image,
                    index: i,
                    type: c.type,
                    name: c.name,
                    desc: c.creatorNotes ?? 'No description',
                    chaId: c.chaId,
                    archived: false,
                })
            }
        }
        if(!trash && !db.nodeOnlyHideArchivedCharacters){
            for(const stub of db.nodeOnlyArchivedCharacters ?? []){
                if(!stub?.chaId || !matchesSearch(stub.name, search)) continue
                charas.push({
                    image: stub.image,
                    index: -1,
                    type: 'character',
                    name: stub.name,
                    desc: language.deactivatedBadge,
                    chaId: stub.chaId,
                    archived: true,
                })
            }
        }
        return charas
    }
</script>

<div class="h-full w-full flex justify-center">
    <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col overflow-y-auto">
        <div class="mx-4 mb-6 flex flex-col">
            <div class="flex items-center gap-3 mb-2">
                <button 
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => endGrid()}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <div class="flex-1">
                    <TextInput placeholder="Search" bind:value={search} autocomplete="off" fullwidth={true}/>
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 3}}>
                    {language.simple}
                </Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 0}}>
                    {language.grid}
                </Button>
                <Button styled={selected === 1  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 1}}>
                    {language.list}
                </Button>
                <Button styled={selected === 2  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 2}}>
                    {language.trash}
                </Button>
                <div class="grow"></div>
                <span class="text-textcolor2 text-sm">
                    {formatChars(search, DBState.db).length} {language.character}
                </span>
            </div>
        </div>
        {#if selected === 0}
            <div class="w-full flex justify-center">
                <div class="flex flex-wrap gap-2 w-full justify-center">
                    {#each formatChars(search, DBState.db) as char}
                        <div class="flex items-center text-textcolor" class:opacity-40={char.archived} class:grayscale={char.archived} title={char.archived ? `${char.name} (${language.deactivatedBadge})` : undefined}>
                            {#if char.image}
                                <BarIcon onClick={() => {openChar(char)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                            {:else}
                                <BarIcon onClick={() => {openChar(char)}} additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}>
                                            <User/>
                                </BarIcon>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>
        {:else if selected === 1}
            {#each formatChars(search, DBState.db) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2" class:opacity-60={char.archived}>
                    <div class:grayscale={char.archived}>
                        <BarIcon onClick={() => {openChar(char)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                    </div>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">
                            {char.name || "Unnamed"}
                            {#if char.archived}
                                <span class="ml-2 align-middle text-xs font-normal text-textcolor2 border border-darkborderc rounded px-1.5 py-0.5">{language.deactivatedBadge}</span>
                            {/if}
                        </h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                openChar(char)
                            }}>
                                <SquareMousePointer />
                            </button>
                            {#if !char.archived}
                                <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                    removeChar(char.chaId, char.name)
                                }}>
                                    <TrashIcon />
                                </button>
                            {/if}
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 2}
            <span class="text-textcolor2 text-sm mb-2">{language.trashDesc}</span>
            {#each formatChars(search, DBState.db, true) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                const restoreIdx = findCharacterIndexbyId(char.chaId)
                                if (restoreIdx !== -1) {
                                    DBState.db.characters[restoreIdx].trashTime = undefined
                                    checkCharOrder()
                                }
                            }}>
                                <Undo2Icon />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name, 'permanent')
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 3}
            <MobileCharacters {search} gridMode endGrid={endGrid} />
        {/if}
    </div>
</div>
