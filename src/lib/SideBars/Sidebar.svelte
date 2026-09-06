<script lang="ts">
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    OpenRealmStore,
    PlaygroundStore,

    QuickSettings,

    additionalHamburgerMenu,

    leftBarCollapsed


  } from "../../ts/stores.svelte";
    import { setDatabase, folderDisplayMode, type folder, type ArchivedCharacterStub, type FolderDisplayMode } from "../../ts/storage/database.svelte";
    import { promptActivateCharacter } from "../../ts/characterArchive";
    import { ArchiveIcon } from "@lucide/svelte";
    import { DBState, openCharacterManager, folderSettingsTarget } from 'src/ts/stores.svelte';
    import { tooltipRight } from "src/ts/gui/tooltip";
    import { folderIconComponent } from "../CharacterManager/folderIcons";
    import BarIcon from "./BarIcon.svelte";
    import SidebarIndicator from "./SidebarIndicator.svelte";
    import {
    ShellIcon,
    Settings,
    ListIcon,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    HomeIcon,
    WrenchIcon,
    User2Icon,
    ChevronsLeft,
    ArrowRight,
    HeartIcon,
  } from "@lucide/svelte";
    import {
  addCharacter,
    changeChar,
    deselectCharacter,
    getCharImage,
  } from "../../ts/characters";
    import CharConfig from "./CharConfig.svelte";
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import BaseRoundedButton from "../UI/BaseRoundedButton.svelte";
    import { getCharacterIndexObject, makeAgoText } from "src/ts/util";
    import { v4 } from "uuid";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import SideChatList from "./SideChatList.svelte";
  import { supportDialogOpen, supportEnabled, initSupport } from "src/ts/support";

  import { sideBarSize } from "src/ts/gui/guisize";
  import DevTool from "./DevTool.svelte";
    import QuickSettingsGui from "../Others/QuickSettingsGUI.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
  const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const touchDragEnabled = $derived(isTouchDevice && !DBState.db.disableMobileDragDrop);
    import { RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";

  let sideBarMode = $state(0);
  let editMode = $state(false);
  let menuMode = $state(0);
  let devTool = $state(false)

  function reseter() {
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  type sortTypeNormal = { type:'normal',img: string, index: number, name:string }
  // Deactivated character: rendered in place (dimmed); not in DBState.db.characters.
  type sortTypeArchived = { type:'archived',img: string, chaId: string, name:string }
  type sortTypeEntry = sortTypeNormal|sortTypeArchived
  type sortType =  sortTypeEntry|{type:'folder',folder:sortTypeEntry[],id:string, name:string, color:string, img?:string, icon?:string, display:FolderDisplayMode}
  let charImages: sortType[] = $state([]);
  // Recently interacted characters for the home sidebar. Character-level
  // `lastInteraction` is already in memory (no chat hydration needed), so this
  // sort is cheap; the $derived is only read while on the home screen.
  let recentChars = $derived(
    DBState.db.characters
      .map((c, index) => ({ index, name: c.name, image: c.image, lastInteraction: c.lastInteraction ?? 0, trashTime: c.trashTime }))
      .filter((c) => c.lastInteraction > 0 && !c.trashTime)
      .sort((a, b) => b.lastInteraction - a.lastInteraction)
  );
  // Progressive reveal: render `recentVisible` items, "Load more" adds 10.
  // Avoids mounting hundreds of avatar components at once (no list virtualization).
  let recentVisible = $state(10);
  let IconRounded = $state(false)
  let openFolders:string[] = $state([])
  let currentDrag: DragData | null = $state(null)
  interface Props {
    hidden?: boolean;
  }

  let { hidden = false }: Props = $props();
  initSupport();

  sideBarClosing.set(false)

  $effect(() => {
    let newCharImages: sortType[] = [];
    const idObject = getCharacterIndexObject()
    // Deactivated characters keep their slot in characterOrder; resolve those
    // ids against the stub list (unless the user chose to hide them).
    const archivedById = new Map<string, ArchivedCharacterStub>()
    if (!DBState.db.nodeOnlyHideArchivedCharacters) {
      for (const stub of DBState.db.nodeOnlyArchivedCharacters ?? []) {
        if (stub?.chaId && !stub.trashedAt) archivedById.set(stub.chaId, stub)
      }
    }
    // Sidebar-hidden characters (display only; the character manager still lists them).
    const hiddenSet = new Set(DBState.db.nodeOnlyHiddenCharacterIds ?? [])
    const archivedEntry = (id: string): sortTypeArchived | null => {
      const stub = archivedById.get(id)
      return stub ? { type: 'archived', img: stub.image ?? '', chaId: stub.chaId, name: stub.name ?? '' } : null
    }
    for (const id of DBState.db.characterOrder) {
      if(typeof(id) === 'string'){
        if (hiddenSet.has(id)) continue
        const index = idObject[id] ?? -1
        if(index !== -1){
          const cha = DBState.db.characters[index]
          newCharImages.push({
            img:cha.image ?? "",
            index:index,
            type: "normal",
            name: cha.name
          });
        } else {
          const archived = archivedEntry(id)
          if (archived) newCharImages.push(archived)
        }
      }
      else{
        const folder = id
        let folderCharImages: sortTypeEntry[] = []
        for(const id of folder.data){
          if (hiddenSet.has(id)) continue
          const index = idObject[id] ?? -1
          if(index !== -1){
            const cha = DBState.db.characters[index]
            folderCharImages.push({
              img:cha.image ?? "",
              index:index,
              type: "normal",
              name: cha.name
            });
          } else {
            const archived = archivedEntry(id)
            if (archived) folderCharImages.push(archived)
          }
        }
        newCharImages.push({
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
          img: folder.imgFile,
          icon: folder.nodeOnlyIcon,
          display: folderDisplayMode(folder),
        });
      }
    }
    if (!isEqual(charImages, newCharImages)) {
      charImages = newCharImages;
    }
    if(IconRounded !== DBState.db.roundIcons){
      IconRounded = DBState.db.roundIcons
    }
  })


  const inserter = (mainIndex:DragData, targetIndex:DragData) => {
    if(mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder){
      return
    }
    let db = DBState.db
    let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null
    let targetFolderIndex = targetIndex.folder ? getFolderIndex(targetIndex.folder) : null
    let mainFolderId = mainIndex.folder ? (db.characterOrder[mainFolderIndex] as folder).id : ''
    let movingFolder:folder|false = false
    let mainId = ''
    if(mainIndex.folder){
      mainId = (db.characterOrder[mainFolderIndex] as folder).data[mainIndex.index]
    }
    else{
      const da = db.characterOrder[mainIndex.index]
      if(typeof(da) !== 'string'){
        mainId = da.id
        movingFolder = $state.snapshot(da)
        if(targetIndex.folder){
          return
        }
      }
      else{
        mainId = da
      }
    }
    if(targetIndex.folder){
        const folder = db.characterOrder[targetFolderIndex] as folder
        folder.data.splice(targetIndex.index,0,mainId)
        db.characterOrder[targetFolderIndex] = folder
    }
    else if(movingFolder){
        db.characterOrder.splice(targetIndex.index,0,movingFolder)
    }
    else{
        db.characterOrder.splice(targetIndex.index,0,mainId)
    }
    if(mainIndex.folder){
      mainFolderIndex = -1
      for(let i=0;i<db.characterOrder.length;i++){
        const a =db.characterOrder[i]
        if(typeof(a) !== 'string'){
          if(a.id === mainFolderId){
            mainFolderIndex = i
            break
          }
        }
      }
      if(mainFolderIndex !== -1){
        const folder:folder = db.characterOrder[mainFolderIndex] as folder
        const ind = mainIndex.index > targetIndex.index ? folder.data.lastIndexOf(mainId) : folder.data.indexOf(mainId) 
        if(ind !== -1){
          folder.data.splice(ind, 1)
        }
        db.characterOrder[mainFolderIndex] = folder
      }
      else{
        console.log('folder not found')
      }
    }
    else if(movingFolder){
      let idList:string[] = []
      for(const ord of db.characterOrder){
        idList.push(typeof(ord) === 'string' ? ord : ord.id)
      }
      const ind = mainIndex.index > targetIndex.index ? idList.lastIndexOf(mainId) : idList.indexOf(mainId) 
      if(ind !== -1){
        db.characterOrder.splice(ind, 1)
      }
    }
    else{
      const ind = mainIndex.index > targetIndex.index ? db.characterOrder.lastIndexOf(mainId) : db.characterOrder.indexOf(mainId) 
      if(ind !== -1){
        db.characterOrder.splice(ind, 1)
      }
    }

    DBState.db.characterOrder = db.characterOrder
    checkCharOrder()
  }

  function getFolderIndex(id:string){
    for(let i=0;i<DBState.db.characterOrder.length;i++){
      const data = DBState.db.characterOrder[i]
      if(typeof(data) !== 'string' && data.id === id){
        return i
      }
    }
    return -1
  }

  function scrollToActiveCharacter() {
    const selectedId = $selectedCharID
    if (selectedId === -1) return
    
    const characterId = DBState.db.characters[selectedId]?.chaId
    if (!characterId) return
    
    let targetFolderId: string | null = null
    
    for (const item of charImages) {
      if (item.type === 'folder') {
        const foundChar = item.folder.find(c => 
          c.type === 'normal' && DBState.db.characters[c.index]?.chaId === characterId
        )
        if (foundChar) {
          targetFolderId = item.id
          break
        }
      }
    }
    
    if (targetFolderId && !openFolders.includes(targetFolderId)) {
      openFolders.push(targetFolderId)
      openFolders = openFolders
    }
    
    setTimeout(() => {
      const activeElement = document.querySelector(`[data-char-id="${characterId}"]`)
      if (activeElement) {
        activeElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        })
      }
    }, 100)
  }

  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handler = () => {
      scrollToActiveCharacter()
    }
    
    window.addEventListener('scrollToActiveCharacter', handler)
    
    return () => {
      window.removeEventListener('scrollToActiveCharacter', handler)
    }
  })


  const createFolder = (mainIndex:DragData, targetIndex:DragData) => {
    if(mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder){
      return
    }
    let db = DBState.db
    let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null
    let mainFolder = db.characterOrder[mainFolderIndex] as folder
    if(targetIndex.folder){
      return
    }
    const main = mainIndex.folder ? mainFolder.data[mainIndex.index] : db.characterOrder[mainIndex.index]
    const target = db.characterOrder[targetIndex.index]
    if(typeof(main) !== 'string'){
      return
    }
    if(typeof (target) === 'string'){
      const newFolder:folder = {
        name: "New Folder",
        data: [main, target],
        color: "",
        id: v4()
      }
      db.characterOrder[targetIndex.index] = newFolder
      if(mainIndex.folder){
        mainFolder.data.splice(mainIndex.index, 1)
        db.characterOrder[mainFolderIndex] = mainFolder
      }
      else{
        db.characterOrder.splice(mainIndex.index, 1)
      }
    }
    else{
      target.data.push(main)
      if(mainIndex.folder){
        mainFolder.data.splice(mainIndex.index, 1)
        db.characterOrder[mainFolderIndex] = mainFolder
      }
      else{
        db.characterOrder.splice(mainIndex.index, 1)
      }
    }

    DBState.db.characterOrder = db.characterOrder
    checkCharOrder()
  }

  type DragEv = DragEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }
  type DragData = {
    index:number,
    folder?:string
  }
  const avatarDragStart = (ind:DragData, e:DragEv) => {
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.setData(RISU_SIDEBAR_DRAG_TYPE, 'true');
    currentDrag = ind
    const avatar = e.currentTarget.querySelector('.avatar')
    if(avatar){
      e.dataTransfer.setDragImage(avatar, 10, 10);
    }
  }

  const clearCurrentDrag = () => {
    currentDrag = null
  }

  $effect(() => {
    if (typeof window === 'undefined') return

    window.addEventListener('dragend', clearCurrentDrag)
    window.addEventListener('drop', clearCurrentDrag)
    window.addEventListener('blur', clearCurrentDrag)

    return () => {
      window.removeEventListener('dragend', clearCurrentDrag)
      window.removeEventListener('drop', clearCurrentDrag)
      window.removeEventListener('blur', clearCurrentDrag)
    }
  })

  const getCurrentSidebarDrag = (e:DragEvent) => {
    if(!currentDrag || !e.dataTransfer?.types.includes(RISU_SIDEBAR_DRAG_TYPE)){
      return null
    }
    return currentDrag
  }

  const avatarDragOver = (e:DragEv) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  const avatarDrop = (ind:DragData, e:DragEv) => {
    const drag = getCurrentSidebarDrag(e)
    if(!drag){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    try {
      createFolder(drag,ind)
    } catch (error) {
      console.error('avatarDrop error:', error)
    } finally {
      clearCurrentDrag()
    }
  }

  const preventAll = (e:DragEvent) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    return false
  }

  // Touch long-press drag for mobile devices
  let touchDragState: {
    data: DragData
    element: HTMLElement
    ghost: HTMLElement | null
    highlighted: HTMLElement | null
  } | null = null
  let touchDragTimer = 0
  let touchStartPos = { x: 0, y: 0 }
  let suppressNextClick = false

  function onTouchDragStart(data: DragData, e: TouchEvent & { currentTarget: HTMLElement }) {
    const touch = e.touches[0]
    touchStartPos = { x: touch.clientX, y: touch.clientY }
    const el = e.currentTarget

    if (touchDragTimer) clearTimeout(touchDragTimer)
    touchDragTimer = window.setTimeout(() => {
      touchDragState = { data, element: el, ghost: null, highlighted: null }
      el.style.opacity = '0.4'
      try { navigator.vibrate?.(30) } catch {}

      const rect = el.getBoundingClientRect()
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.style.cssText = `position:fixed;pointer-events:none;z-index:9999;opacity:0.7;width:${rect.width}px;left:${touch.clientX - rect.width / 2}px;top:${touch.clientY - rect.height / 2}px;`
      document.body.appendChild(ghost)
      touchDragState.ghost = ghost
    }, 400)
  }

  function onTouchDragMove(e: TouchEvent) {
    const touch = e.touches[0]

    if (!touchDragState) {
      const dx = Math.abs(touch.clientX - touchStartPos.x)
      const dy = Math.abs(touch.clientY - touchStartPos.y)
      if (dx > 8 || dy > 8) {
        if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
      }
      return
    }

    e.preventDefault()

    if (touchDragState.ghost) {
      const rect = touchDragState.element.getBoundingClientRect()
      touchDragState.ghost.style.left = `${touch.clientX - rect.width / 2}px`
      touchDragState.ghost.style.top = `${touch.clientY - rect.height / 2}px`
    }

    // Find drop target under finger
    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    if (touchDragState.ghost) touchDragState.ghost.style.display = ''

    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
      touchDragState.highlighted = null
    }

    if (!el) return
    const spacer = el.closest('[data-spacer-index]') as HTMLElement | null
    const item = el.closest('[data-drag-index]') as HTMLElement | null

    if (spacer) {
      spacer.classList.add('bg-green-500')
      touchDragState.highlighted = spacer
    } else if (item && item !== touchDragState.element) {
      item.classList.add('ring-2', 'ring-green-400')
      touchDragState.highlighted = item
    }
  }

  function cleanupTouchDrag() {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return false
    touchDragState.element.style.opacity = ''
    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
    }
    if (touchDragState.ghost) touchDragState.ghost.remove()
    touchDragState = null
    return true
  }

  function onTouchDragEnd(e: TouchEvent) {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return

    const touch = e.changedTouches[0]

    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)

    const spacer = el?.closest('[data-spacer-index]') as HTMLElement | null
    const item = el?.closest('[data-drag-index]') as HTMLElement | null

    if (spacer) {
      const idx = parseInt(spacer.dataset.spacerIndex!)
      const folder = spacer.dataset.spacerFolder || undefined
      inserter(touchDragState.data, { index: idx, folder })
    } else if (item && item !== touchDragState.element) {
      const idx = parseInt(item.dataset.dragIndex!)
      const folder = item.dataset.dragFolder || undefined
      createFolder(touchDragState.data, { index: idx, folder })
    }

    cleanupTouchDrag()
    suppressNextClick = true
    requestAnimationFrame(() => { suppressNextClick = false })
  }

  function onTouchDragCancel() {
    cleanupTouchDrag()
  }

  function touchDragContainer(node: HTMLElement) {
    node.addEventListener('touchmove', onTouchDragMove, { passive: false })
    node.addEventListener('touchend', onTouchDragEnd)
    node.addEventListener('touchcancel', onTouchDragCancel)
    return {
      destroy() {
        node.removeEventListener('touchmove', onTouchDragMove)
        node.removeEventListener('touchend', onTouchDragEnd)
        node.removeEventListener('touchcancel', onTouchDragCancel)
      }
    }
  }
</script>
{#if DBState.db.menuSideBar}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full mt-4"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore === 0 &&
    !$settingsOpen
  )}
  onclick={() => {
    reseter();
    deselectCharacter()
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
  }}
>
  <HomeIcon />
  <span class="text-xs">{language.home}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!$settingsOpen}
  onclick={() => {
    if ($settingsOpen) {
      reseter();
      settingsOpen.set(false);
    } else {
      reseter();
      settingsOpen.set(true);
    }
  }}
>
  <Settings />
  <span class="text-xs">{language.settings}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID >= 0
  )}
  onclick={() => {
    reseter();
    openCharacterManager.set(true);
  }}
>
  <User2Icon />
  <span class="text-xs">{language.character}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore !== 0
  )}
  onclick={() => {
    reseter();
    deselectCharacter()
    PlaygroundStore.set(1)
  }}
>
  <ShellIcon />
  <span class="text-xs">{language.playground.playground}</span>
</button>
</div>
{:else}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:max-xs:hidden={$leftBarCollapsed}
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
  {#if !DBState.db.hamburgerButtonBottom}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <div class="mt-2 border-b border-b-selected w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute w-20 min-w-20 flex border-b-selected border-b bg-bgcolor flex-col items-center pt-2 rounded-b-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          deselectCharacter()
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter()
          if($selectedCharID === -1 && $PlaygroundStore !== 0){
            PlaygroundStore.set(0)
            return
          }
          deselectCharacter()
          PlaygroundStore.set(1)
        }}
      ><ShellIcon /></BarIcon>
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {/if}
  <!-- Character manager entry: the only management route from the rail. -->
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    aria-label={language.characterManager}
    use:tooltipRight={language.characterManager}
    onclick={() => {
      reseter();
      openCharacterManager.set(true);
    }}
  >
    <LayoutGridIcon size={18} />
  </button>
  <div class="character-list flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto pr-0" class:max-xs:hidden={$leftBarCollapsed} use:touchDragContainer>
    <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index="0" ondragover={(e) => {
      if(!getCurrentSidebarDrag(e)){ return }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      e.currentTarget.classList.add('bg-green-500')
    }} ondragleave={(e) => {
      e.currentTarget.classList.remove('bg-green-500')
    }} ondrop={(e) => {
      const drag = getCurrentSidebarDrag(e)
      if(!drag){ return }
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.classList.remove('bg-green-500')
      try {
        inserter(drag,{index:0})
      } finally {
        clearCurrentDrag()
      }
    }} ondragenter={preventAll}></div>
    {#each charImages as char, ind}
      <div class="group relative flex items-center px-2"
        role="listitem"
        data-drag-index={ind}
        draggable={!isTouchDevice ? "true" : undefined}
        ondragstart={!isTouchDevice ? (e) => {avatarDragStart({index:ind}, e)} : undefined}
        ondragend={!isTouchDevice ? clearCurrentDrag : undefined}
        ondragover={!isTouchDevice ? avatarDragOver : undefined}
        ondrop={!isTouchDevice ? (e) => {avatarDrop({index:ind}, e)} : undefined}
        ondragenter={!isTouchDevice ? preventAll : undefined}
        ontouchstart={touchDragEnabled ? (e) => {onTouchDragStart({index:ind}, e)} : undefined}
      >
        <SidebarIndicator
          isActive={char.type === 'normal' && $selectedCharID === char.index && sideBarMode !== 1}
        />
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            role="button" tabindex="0"
            onclick={() => {
              if(suppressNextClick) return
              if(char.type === "normal"){
                changeChar(char.index, {reseter});
              } else if(char.type === "archived"){
                void promptActivateCharacter(char.chaId, {reseter});
              }
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                if(char.type === "normal"){
                  changeChar(char.index, {reseter});
                } else if(char.type === "archived"){
                  void promptActivateCharacter(char.chaId, {reseter});
                }
              }
            }}
          >
          {#if char.type === 'normal'}
            <SidebarAvatar 
              src={char.img ? getCharImage(char.img, "plain") : "/none.webp"} 
              size="56" 
              rounded={IconRounded} 
              name={char.name}
              chaId={DBState.db.characters[char.index]?.chaId}
            />
          {:else if char.type === 'archived'}
            <div class="relative">
              <SidebarAvatar 
                src={char.img ? getCharImage(char.img, "plain") : "/none.webp"} 
                size="56" 
                rounded={IconRounded} 
                name={`${char.name} (${language.deactivatedBadge})`}
                chaId={char.chaId}
              />
              <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                <ArchiveIcon size={20} class="text-white/90" />
              </div>
            </div>
          {:else if char.type === "folder"}
            {#key char.color}
            {#key char.name}
              <SidebarAvatar src="slot" size="56" rounded={IconRounded} bordered name={char.name} color={char.color} backgroundimg={char.display === 'image' && char.img ? getCharImage(char.img, "plain") : ""}
              oncontextmenu={(e) => {
                e.preventDefault()
                // Folder settings dialog (name / color / image), shared with the character manager.
                if(char.type === 'folder') folderSettingsTarget.set(char.id)
              }}
              onClick={() => {
                if(suppressNextClick) return
                if(char.type !== 'folder'){
                  return
                }
                if(openFolders.includes(char.id)){
                  openFolders.splice(openFolders.indexOf(char.id), 1)
                }
                else{
                  openFolders.push(char.id)
                }
                openFolders = openFolders
              }}>
                {@const CustomIcon = folderIconComponent(char.icon)}
                {#if char.display === 'name'}
                  <div class="h-full w-full flex justify-center items-center">
                    <span class="hyphens-auto truncate font-bold">{char.name}</span>
                  </div>
                {:else if char.display === 'icon' && CustomIcon}
                  <CustomIcon />
                {:else if openFolders.includes(char.id)}
                  <FolderOpenIcon />
                {:else}
                  <FolderIcon />
                {/if}
              </SidebarAvatar>
            {/key}
            {/key}
          {/if}
        </div>
      </div>
      {#if char.type === 'folder' && openFolders.includes(char.id)}
        {#key char.color}
        <div class="p-1 flex flex-col items-center py-1 mt-1 rounded-lg relative">
          <div class="absolute top-0 left-1 border border-selected w-full h-full rounded-lg z-0 {
            char.color === 'red' ? 'bg-red-700/20' :
            char.color === 'yellow' ? 'bg-yellow-700/20' :
            char.color === 'green' ? 'bg-green-700/20' :
            char.color === 'blue' ? 'bg-blue-700/20' :
            char.color === 'indigo' ? 'bg-indigo-700/20' :
            char.color === 'purple' ? 'bg-purple-700/20' :
            char.color === 'pink' ? 'bg-pink-700/20' :
            'bg-darkbg/20'
          }"></div>
          <div class="h-4 min-h-4 w-14 relative z-10" role="listitem" data-spacer-index="0" data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
            if(!getCurrentSidebarDrag(e)){ return }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            e.currentTarget.classList.add('bg-green-500')
          }} ondragleave={(e) => {
            e.currentTarget.classList.remove('bg-green-500')
          }} ondrop={(e) => {
            const drag = getCurrentSidebarDrag(e)
            if(!drag){ return }
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.classList.remove('bg-green-500')
            try {
              if(char.type === 'folder'){
                inserter(drag,{index:0,folder:char.id})
              }
            } finally {
              clearCurrentDrag()
            }
          }} ondragenter={preventAll}></div>
          {#each char.folder as char2, ind}
              <div class="group relative flex items-center px-2 z-10"
              role="listitem"
              data-drag-index={ind}
              data-drag-folder={char.type === 'folder' ? char.id : undefined}
              draggable={!isTouchDevice ? "true" : undefined}
              ondragstart={!isTouchDevice ? (e) => {if(char.type === 'folder'){avatarDragStart({index: ind, folder:char.id}, e)}} : undefined}
              ondragend={!isTouchDevice ? clearCurrentDrag : undefined}
              ondragover={!isTouchDevice ? avatarDragOver : undefined}
              ondrop={!isTouchDevice ? (e) => {if(char.type === 'folder'){avatarDrop({index: ind, folder:char.id}, e)}} : undefined}
              ondragenter={!isTouchDevice ? preventAll : undefined}
              ontouchstart={touchDragEnabled && char.type === 'folder' ? (e) => {onTouchDragStart({index: ind, folder:char.id}, e)} : undefined}
            >
              <SidebarIndicator
                isActive={char2.type === 'normal' && $selectedCharID === char2.index && sideBarMode !== 1}
              />
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                  role="button" tabindex="0"
                  onclick={() => {
                    if(suppressNextClick) return
                    if(char2.type === "normal"){
                      changeChar(char2.index, {reseter});
                    } else if(char2.type === "archived"){
                      void promptActivateCharacter(char2.chaId, {reseter});
                    }
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      if(char2.type === "normal"){
                        changeChar(char2.index, {reseter});
                      } else if(char2.type === "archived"){
                        void promptActivateCharacter(char2.chaId, {reseter});
                      }
                    }
                  }}
                >
                {#if char2.type === 'archived'}
                  <div class="relative">
                    <SidebarAvatar 
                      src={char2.img ? getCharImage(char2.img, "plain") : "/none.webp"} 
                      size="56" 
                      rounded={IconRounded} 
                      name={`${char2.name} (${language.deactivatedBadge})`}
                      chaId={char2.chaId}
                    />
                    <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                      <ArchiveIcon size={20} class="text-white/90" />
                    </div>
                  </div>
                {:else}
                  <SidebarAvatar 
                    src={char2.img ? getCharImage(char2.img, "plain") : "/none.webp"} 
                    size="56" 
                    rounded={IconRounded} 
                    name={char2.name}
                    chaId={DBState.db.characters[char2.index]?.chaId}
                  />
                {/if}
              </div>
            </div>
            <div class="h-4 min-h-4 w-14 relative z-20" role="listitem" data-spacer-index={ind+1} data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
              if(!getCurrentSidebarDrag(e)){ return }
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              e.currentTarget.classList.add('bg-green-500')
            }} ondragleave={(e) => {
              e.currentTarget.classList.remove('bg-green-500')
            }} ondrop={(e) => {
              const drag = getCurrentSidebarDrag(e)
              if(!drag){ return }
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.classList.remove('bg-green-500')
              try {
                if(char.type === 'folder'){
                  inserter(drag,{index:ind+1,folder:char.id})
                }
              } finally {
                clearCurrentDrag()
              }
            }} ondragenter={preventAll}></div>
          {/each}
        </div>
        {/key}
      {/if}
      <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index={ind+1} ondragover={((e) => {
        if(!getCurrentSidebarDrag(e)){ return }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        e.currentTarget.classList.add('bg-green-500')
      })} ondragleave={(e) => {
        e.currentTarget.classList.remove('bg-green-500')
      }} ondrop={(e) => {
        const drag = getCurrentSidebarDrag(e)
        if(!drag){ return }
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.classList.remove('bg-green-500')
        try {
          inserter(drag,{index:ind+1})
        } finally {
          clearCurrentDrag()
        }
      }} ondragenter={preventAll}></div>
    {/each}
    <div class="flex flex-col items-center gap-2 px-2">
      <BaseRoundedButton
        onClick={async () => {
          addCharacter({reseter}) 
        }}
        ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
          ><path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          /></svg
        ></BaseRoundedButton
      >
    </div>
  </div>
  {#if DBState.db.hamburgerButtonBottom}
  <div class="border-t border-t-selected w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute bottom-full w-20 min-w-20 flex border-t-selected border-t bg-bgcolor flex-col items-center pt-2 rounded-t-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          deselectCharacter()
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter()
          if($selectedCharID === -1 && $PlaygroundStore !== 0){
            PlaygroundStore.set(0)
            return
          }
          deselectCharacter()
          PlaygroundStore.set(1)
        }}
      ><ShellIcon /></BarIcon>
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mb-2 mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {/if}
</div>
{/if}
<div
  class="setting-area h-full max-xs:relative flex-col overflow-y-auto overflow-x-hidden bg-darkbg py-6 text-textcolor max-h-full"
  class:risu-sidebar={!$sideBarClosing}
  class:w-96={$sideBarSize === 0}
  class:w-110={$sideBarSize === 1}
  class:w-124={$sideBarSize === 2}
  class:w-138={$sideBarSize === 3}
  class:risu-sidebar-close={$sideBarClosing}
  class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
  class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
  class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
  class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
  class:px-2={$DynamicGUI}
  class:px-4={!$DynamicGUI}
  class:dynamic-sidebar={$DynamicGUI}
  class:hidden={hidden}
  class:flex={!hidden}
  onanimationend={() => {
    if($sideBarClosing){
      $sideBarClosing = false
      sideBarStore.set(false)
    }
  }}
>
  <button
    class="flex w-full justify-end text-textcolor"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
  </button>
  {#if $leftBarCollapsed}
    <button
      class="hidden max-xs:flex absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-borderc rounded-r-md bg-darkbg hover:border-neutral-200 transition-colors items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20"
      aria-label="Expand sidebar"
      onclick={() => leftBarCollapsed.set(false)}
    >
      <ArrowRight />
    </button>
  {/if}
  {#if sideBarMode === 0}
    {#if $selectedCharID < 0 || $settingsOpen}
      {#if $supportEnabled}
        <!-- Same card rhythm as the recent-chat rows below (p-2.5, round leading badge). -->
        <button
          type="button"
          class="mt-1 mb-1 flex w-full items-center gap-2 rounded-md border border-borderc/10 bg-darkbg px-2 py-1.5 text-left transition-colors hover:border-borderc/30 hover:bg-selected/50"
          onclick={() => supportDialogOpen.set(true)}
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <HeartIcon size={13} />
          </span>
          <span class="truncate text-sm font-medium text-textcolor">{language.supportBanner}</span>
        </button>
      {/if}
      <span class="block text-base font-semibold text-textcolor mt-2">{language.recentChatsTitle}</span>
      {#if DBState.db.nodeOnlyHideRecentChats}
        <!-- list hidden by user preference -->
      {:else if recentChars.length === 0}
        <span class="block text-sm text-textcolor2 mt-2">{language.noRecentChatsDesc}</span>
      {:else}
        <div class="flex flex-col gap-1.5 mt-2">
          {#each recentChars.slice(0, recentVisible) as rc (rc.index)}
            <button
              type="button"
              class="group flex items-center gap-2.5 rounded-md border border-borderc/10 bg-darkbg p-2 text-left transition-colors hover:border-borderc/30 hover:bg-selected/50"
              onclick={() => changeChar(rc.index, {reseter})}
            >
              <div class="shrink-0">
                <SidebarAvatar
                  src={rc.image ? getCharImage(rc.image, "plain") : "/none.webp"}
                  size="36"
                  rounded={IconRounded}
                  name={rc.name}
                  chaId={DBState.db.characters[rc.index]?.chaId}
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-textcolor leading-tight truncate">{rc.name || "Unnamed"}</div>
                <div class="text-xs text-textcolor2 leading-tight truncate">{makeAgoText(rc.lastInteraction)}</div>
              </div>
            </button>
          {/each}
          {#if recentVisible < recentChars.length}
            <button
              type="button"
              class="w-full rounded-md border border-borderc/10 bg-darkbg p-2 text-center text-sm text-textcolor2 transition-colors hover:border-borderc/30 hover:bg-selected/50 hover:text-textcolor"
              onclick={() => recentVisible += 10}
            >
              {language.loadMore}
            </button>
          {/if}
        </div>
      {/if}
    {:else if DBState.db.characters[$selectedCharID]?.chaId === '§playground'}
      <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
    {:else}
      <div class="w-full h-8 min-h-8 border-l border-b border-r border-selected relative bottom-6 rounded-b-md flex">
        <button onclick={() => {
          devTool = false
          botMakerMode.set(false)
        }} class="grow border-r border-r-selected rounded-bl-md" class:text-textcolor2={$botMakerMode || devTool}>{language.Chat}</button>
        <button onclick={() => {
          devTool = false
          botMakerMode.set(true)
        }} class="grow rounded-br-md" class:text-textcolor2={!$botMakerMode || devTool}>{language.character}</button>
        {#if DBState.db.enableDevTools}
          <button onclick={() => {
            devTool = true
          }} class="border-l border-l-selected rounded-br-md px-1" class:text-textcolor2={!devTool}>
            <WrenchIcon size={18} />
          </button>
        {/if}
      </div>
      {#if QuickSettings.open}
        <QuickSettingsGui />
      {:else if devTool}
        <DevTool />
      {:else if $botMakerMode}
        <CharConfig />
      {:else}
        <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
      {/if}
    {/if}
  {/if}
</div>

{#if $DynamicGUI}
    <div role="button" tabindex="0" class="grow h-full min-w-12"
      class:max-xs:!min-w-8={!$leftBarCollapsed}
      class:max-xs:!min-w-6={$leftBarCollapsed}
      class:hidden={hidden} onclick={() => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
      onkeydown={(e)=>{
        if(e.key === 'Enter'){
            e.currentTarget.click()
        }
      }}
      class:sidebar-dark-animation={!$sideBarClosing}
      class:sidebar-dark-close-animation={$sideBarClosing}>

    </div>

{/if}

<style>
  .editMode {
    min-width: 6rem;
  }
  @keyframes sidebar-transition {
    from {
      width: 0rem;
    }
    to {
      width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close {
    from {
      width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-transition-non-dynamic {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close-non-dynamic {
    from {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      right:3rem;
    }
  }
  @keyframes sub-sidebar-transition {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: 5rem;
      min-width: 5rem;
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: 5rem;
      min-width: 5rem;
      max-width: 5rem;
      right:0rem;

    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-dark-animation{
    from {
      background-color: rgba(0,0,0,0) !important;
    }
    to {
      background-color: rgba(0,0,0,0.5) !important;
    }
  }
  @keyframes sidebar-dark-closing-animation{
    from {
      background-color: rgba(0,0,0,0.5) !important;
    }
    to {
      background-color: rgba(0,0,0,0) !important;
    }
  }

  .risu-sidebar:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-non-dynamic;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-close-non-dynamic;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .risu-sidebar.dynamic-sidebar {
    animation-name: sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close.dynamic-sidebar {
    animation-name: sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
    right: 3rem;
  }


  .risu-sub-sidebar {
    animation-name: sub-sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sub-sidebar-close {
    animation-name: sub-sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .sidebar-dark-animation{
    animation-name: sidebar-dark-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0.5)
  }
  .sidebar-dark-close-animation{
    animation-name: sidebar-dark-closing-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0)
  }
  .hamburger-menu {
    scrollbar-width: none;
    overscroll-behavior: none;
  }
  .hamburger-menu::-webkit-scrollbar {
    display: none;
  }
  .character-list {
    scrollbar-width: none;
  }
  .character-list::-webkit-scrollbar {
    display: none;
  }
</style>
