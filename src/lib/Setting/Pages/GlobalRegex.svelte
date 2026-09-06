<script lang="ts">
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
</script>
<SettingPage title={language.globalRegexScript}>
<RegexList bind:value={DBState.db.globalscript} />
<div class="text-textcolor2 mt-2 flex gap-2">
    <button class="font-medium cursor-pointer hover:text-primary" onclick={() => {
        let script = DBState.db.globalscript
        script.push({
            comment: "",
            in: "",
            out: "",
            type: "editinput"
        })
        DBState.db.globalscript = script
    }}><PlusIcon /></button>
    <button class="font-medium cursor-pointer hover:text-primary" onclick={() => {
        exportRegex()
    }}><DownloadIcon /></button>
    <button class="font-medium cursor-pointer hover:text-primary" onclick={async () => {
        DBState.db.globalscript = await importRegex(DBState.db.globalscript)
    }}><HardDriveUploadIcon /></button>
</div>
</SettingPage>