<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import Hub from "./Realm/RealmMain.svelte";
    import { OpenRealmStore, RealmInitialOpenChar, openCharacterManager } from "src/ts/stores.svelte";
    import { dbTransferSizeStore, transferSizeWarningDismissed } from "src/ts/transferSize";
    import { ArrowLeft, ChevronDown, MailIcon, SendIcon, TriangleAlertIcon, UsersIcon, XIcon } from "@lucide/svelte";
    import GithubIcon from "./GithubIcon.svelte";
    import { getVersionString, openURL } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { getRisuHub, hubAdditionalHTML } from "src/ts/characterCards";
    import RisuHubIcon from "./Realm/RealmHubIcon.svelte";
    import Title from "./Title.svelte";
    import { updateInfoStore, updatePopupStore } from "src/ts/update";
    import { publicStatsStore } from "src/ts/publicStats";
    import { isSecureContext } from "src/ts/secureContext";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import ShButton from "./GUI/ShButton.svelte";

    let realmOpen = $state(!DBState.db.hideRealm);

    const fmtMB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

    const relatedLinkIconClass =
      "h-40 w-40 md:h-44 md:w-44 origin-right -rotate-12 opacity-[0.12] transition-all duration-500 group-hover:scale-105 group-hover:opacity-[0.22]";
</script>
<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
      <Title />
      <h3 class="text-textcolor2 mt-1">v{getVersionString()}</h3>
      {#if $updateInfoStore?.hasUpdate}
        <button
          class="mt-1.5 px-3 py-1 rounded-full text-sm font-medium transition-colors
            {$updateInfoStore.severity === 'optional'
              ? 'bg-green-900/30 text-green-400 border border-green-800/50 hover:bg-green-900/50'
              : 'bg-red-900/30 text-red-400 border border-red-800/50 hover:bg-red-900/50'}"
          onclick={() => updatePopupStore.set($updateInfoStore)}
        >
          {#if $updateInfoStore.severity === 'outdated'}
            ⚠ {language.updateOutdated.replace('{{version}}', $updateInfoStore.latestVersion)}
          {:else if $updateInfoStore.severity === 'required'}
            ⚠ {language.updateRequired.replace('{{version}}', $updateInfoStore.latestVersion)}
          {:else}
            {language.updateAvailable.replace('{{version}}', $updateInfoStore.latestVersion)}
          {/if}
        </button>
      {/if}
      {#if $publicStatsStore}
      <div class="mt-3 flex gap-2 flex-wrap justify-center">
        <span class="px-3 py-1 rounded-full text-xs bg-darkbg border border-selected text-textcolor2">
          👥 {language.statsUsersToday.replace('{{count}}', $publicStatsStore.dau.toLocaleString())}
          <span class="text-textcolor2/60">({language.statsYesterday.replace('{{count}}', $publicStatsStore.yesterdayDau.toLocaleString())})</span>
        </span>
        <span class="px-3 py-1 rounded-full text-xs bg-darkbg border border-selected text-textcolor2">
          📊 {language.statsVisitsToday.replace('{{count}}', $publicStatsStore.visits.toLocaleString())}
        </span>
      </div>
      {/if}
    {/if}
    <div class="w-full flex p-4 flex-col text-textcolor max-w-4xl">
      {#if !$OpenRealmStore}
      {#if !isSecureContext}
        <div class="mt-4 w-full bg-yellow-900/30 border border-yellow-700/40 rounded-md px-4 py-3 flex items-center justify-between gap-3 flex-wrap text-yellow-300">
          <div class="flex items-start gap-2.5 min-w-0 flex-1">
            <TriangleAlertIcon class="size-4 shrink-0 mt-0.5 text-yellow-400" />
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-sm">{language.httpInsecureWarningTitle}</span>
              <span class="leading-relaxed text-sm opacity-90">{language.httpInsecureWarningBody}</span>
            </div>
          </div>
          <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.RemoteAccess)}>
            {language.httpInsecureOpenRemoteAccess}
          </ShButton>
        </div>
      {/if}
      {#if $dbTransferSizeStore.overLimit && !$transferSizeWarningDismissed}
        <div class="mt-4 w-full bg-yellow-900/30 border border-yellow-700/40 rounded-md px-4 py-3 flex items-center justify-between gap-3 flex-wrap text-yellow-300">
          <div class="flex items-start gap-2.5 min-w-0 flex-1">
            <TriangleAlertIcon class="size-4 shrink-0 mt-0.5 text-yellow-400" />
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-sm">{language.transferSizeWarningTitle}</span>
              <span class="leading-relaxed text-sm opacity-90">{language.transferSizeWarningBody.replace('{{size}}', fmtMB($dbTransferSizeStore.bytes ?? 0))}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <ShButton variant="outline" size="sm" onclick={() => openCharacterManager.set(true)}>
              {language.transferSizeOpenCharacterManager}
            </ShButton>
            <button
              type="button"
              class="text-yellow-400/70 hover:text-yellow-300 cursor-pointer"
              aria-label={language.transferSizeDismiss}
              title={language.transferSizeDismiss}
              onclick={() => transferSizeWarningDismissed.set(true)}
            >
              <XIcon class="size-4" />
            </button>
          </div>
        </div>
      {/if}
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex-1 flex items-center gap-2 text-2xl font-bold text-left outline-none focus-visible:ring-2 focus-visible:ring-borderc/50 rounded"
          aria-expanded={realmOpen}
          aria-controls="main-realm-section"
          onclick={() => (realmOpen = !realmOpen)}
        >
          <span>Recently Uploaded</span>
          <ChevronDown
            size={20}
            class="shrink-0 transition-transform duration-150 {realmOpen ? 'rotate-180' : ''}"
          />
        </button>
        <button
          type="button"
          class="text-base font-medium p-1 bg-darkbg rounded-md hover:ring-3"
          onclick={() => {
            $OpenRealmStore = true
          }}
        >Get More</button>
      </div>
      <div
        id="main-realm-section"
        role="region"
        aria-hidden={!realmOpen}
        inert={!realmOpen}
      >
        {#if realmOpen}
          {#await getRisuHub({
                search: '',
                page: 0,
                nsfw: false,
                sort: 'recommended'
            }) then charas}
            {#if charas.length > 0}
              {@html hubAdditionalHTML}
              <div class="w-full flex gap-4 p-2 flex-wrap justify-center">
                  {#each charas as chara}
                      <RisuHubIcon onClick={() => {
                        $OpenRealmStore = true
                        if(DBState.db.realmDirectOpen){
                            $RealmInitialOpenChar = chara
                        }
                      }} chara={chara} />
                  {/each}
              </div>
            {:else}
              <div class="text-textcolor2">Failed to load {language.hub}...</div>
            {/if}
          {/await}
        {/if}
      </div>
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <h1 class="text-2xl font-bold mb-4">
        Related Links
      </h1>
        <div class="grid w-full grid-cols-1 gap-4 p-2 md:grid-cols-2">
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:border-borderc/30 hover:bg-selected/50 hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://github.com/PocketRisu/PocketRisu")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedGithub}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedGithubDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <GithubIcon class={relatedLinkIconClass} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:border-borderc/30 hover:bg-selected/50 hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://forms.gle/5ms5XntMrfaxmHTSA")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedFeedbackForm}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedFeedbackFormDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <SendIcon class={relatedLinkIconClass} strokeWidth={1} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:border-borderc/30 hover:bg-selected/50 hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("mailto:contact@pocketrisu.com")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedContactEmail}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedContactEmailDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <MailIcon class={relatedLinkIconClass} strokeWidth={1} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:border-borderc/30 hover:bg-selected/50 hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://arca.live/b/characterai")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedArcaLive}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedArcaLiveDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <UsersIcon class={relatedLinkIconClass} strokeWidth={1} />
            </div>
          </button>
        </div>

      {:else}
        <div class="flex items-center mt-4">
          <button class="mr-2 text-textcolor2 hover:text-primary" onclick={() => ($OpenRealmStore = false)}>
            <ArrowLeft/>
          </button>
        </div>
        <Hub />
      {/if}
  </div>
</div>