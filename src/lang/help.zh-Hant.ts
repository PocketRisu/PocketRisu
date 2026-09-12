/**
 * PocketRisu NodeOnly — 繁體中文說明文字（`language.help`）。
 *
 * 為了便於維護，此物件從 `src/lang/en.ts` 拆分而來。稽核紀錄、結構設計理由與
 * `scripts/check-help-keys.mjs` 驗證工具請參閱工作區的 `.agent/notes/help-audit/`。
 *
 * 慣例：英文 `help.en.ts` 是說明文字 key 的完整基準；各語系檔案必須維持相同 key，
 * `src/lang/index.ts` 會透過 `lodash/merge` 合併語系內容。
 */

export const helpZhHant = {
        "model": "聊天時使用的主要模型",
        "submodel": "輔助模型用於分析情緒立繪、生成自動建議等功能",
        "oaiapikey": "OpenAI 的 API 金鑰，可在 https://platform.openai.com/api-keys 取得",
        "mainprompt": "主要提示詞用於決定模型的預設行為",
        "jailbreak": "啟用角色越獄後，將使用越獄提示詞",
        "globalNote": "會強烈影響模型行為的備註，也稱為 UJB；適用於所有角色",
        "autoSuggest": "用於自動建議使用者回應時生成選項的提示詞",
        "formatOrder": "提示詞的排列順序。越靠下的區塊對模型的影響越大",
        "forceUrl": "此欄位有內容時，請求會傳送至您輸入的 URL",
        "tempature":
            "較低的數值會使角色更緊密地遵循提示詞，但回應可能顯得生硬且機械化。\n較高的數值會增加創意表現，但角色回應也更容易變得不穩定",
        "frequencyPenalty": "較高的數值可以減少單次回應中的重複用詞，但數值過高也可能使角色回應變得不穩定",
        "presensePenalty": "較高的數值可以減少整體上下文中的重複用詞，但數值過高也可能使角色回應變得不穩定",
        "sdProvider": "圖片生成供應商",
        "msgSound": "角色回應時播放「叮」聲",
        "charDesc": "角色的簡要描述。這會影響角色的回應方式",
        "charFirstMessage": "角色的開局訊息，會大幅影響角色的回應方式",
        "charNote": "會強烈影響模型行為的備註，只套用於目前角色，也稱為 UJB",
        "toggleNsfw": "啟用或停用越獄提示詞",
        "lorebook": "Lorebook 是由使用者建立的條目資料庫。當上下文符合條目的啟用條件時，該條目的內容才會加入送給模型的提示詞",
        "loreName": "Lorebook 條目的名稱本身不會影響 AI 回應",
        "loreActivationKey": "當上下文中包含任一啟用關鍵字時，該條目會被啟用並送入提示詞。請以逗號分隔多個關鍵字",
        "loreorder": "插入順序越高，條目的提示詞優先順序也越高；同時啟用大量 Lorebook 條目時，也較不容易因 Token 限制而被截除",
        "bias": "Bias 是一組字串與出現機率權重的對應設定，用於修改特定字串出現的機率。\n數值範圍可為 -100 到 100；數值越高越容易出現，越低則越不容易出現。\n另外，在部分模型中設為 -101 時，可作為「強制禁止詞」。\n警告：若 Tokenizer 設定錯誤，可能無法正常運作",
        "emotion":
            "情緒立繪會依角色回應中分析出的情緒顯示對應圖片。情緒名稱必須使用文字關鍵字（例如 `joy`、`happy`、`fear`）。若存在名為 **neutral** 的情緒，會作為預設情緒。至少需要 4 張圖片才能正常運作",
        "imggen": "分析對話後，將提示詞套用至 {{slot}}",
        "regexScript":
            "Regex 腳本是一個自訂工具，可將符合 IN 的字串替換為 OUT。\n\n共有四種類型：" +
            "\n\n- **修改輸入（Modify Input）**：修改使用者輸入" +
            "\n\n- **修改輸出（Modify Output）**：修改角色輸出" +
            "\n\n- **修改請求資料（Modify Request Data）**：修改送出時的目前對話資料" +
            "\n\n- **修改顯示（Modify Display）**：只修改畫面上顯示的文字，不變更實際對話資料" +
            "\n\nIN 必須是 Regex，且不可包含旗標，也不要在開頭與結尾加上斜線。\n\nOUT 是可包含替換模式的字串。可用模式如下：" +
            "\n\n- $$\n\n    - 插入 $" +
            "\n\n- $&\n\n    - 插入比對到的子字串" +
            "\n\n- $`\n\n    - 插入比對結果之前的內容" +
            "\n\n- $1\n\n    - 插入第一個比對群組，也可使用 2、3 等其他數字" +
            "\n\n- $(name)\n\n    - 插入命名群組" +
            "\n\n除了原生支援的旗標外，亦可使用下列提供給進階使用者的旗標：" +
            "\n\n- `<inject>`：將結果注入目前字串" +
            "\n- `<move_top>`：將結果移至字串頂端" +
            "\n- `<move_bottom>`：將結果移至字串底端" +
            "\n- `<repeat_back>`：找不到符合項目時，沿用上一個比對結果" +
            "\n- `<order n>`：設定結果順序。數值越高越優先顯示；`n` 為數字（例如 `<order 1>`）。未設定時預設為 0" +
            "\n- `<cbs>`：解析 IN 中的大括號語法" +
            "\n\n可與原生旗標組合，例如：`gi<cbs><move_top>`",
        "experimental": "此為實驗性功能，可能不穩定",
        "oogaboogaURL":
            "若您的 WebUI 支援舊版 API，URL 應類似 *https:.../run/textgen*。\n\n" +
            "若 WebUI 支援新版 API，URL 應類似 *https://.../api/v1/generate*；請使用 API 伺服器作為主機，並在參數中加入 --api",
        "exampleMessage":
            "示範對話會影響角色輸出，但不會永久佔用 Token" +
            "\n\n對話格式範例：" +
            "\n\n```\n<START>\n{{user}}: hi\n{{char}}: hello\n<START>\n{{user}}: hi\nHaruhi: hello\n```" +
            "\n\n```<START>``` 代表一段新對話的開始",
        "creatorQuotes": "顯示在開局訊息上方的創作者留言，用來向使用者說明卡片資訊；此內容不會加入提示詞",
        "systemPrompt": "此欄位有內容時，會取代設定中的主要提示詞",
        "chatNote": "對模型行為有強烈影響的備註，嵌入於目前對話中，也稱為記憶或 UJB",
        "personality": "角色性格的簡要描述。\n\n**不建議使用此欄位，請改寫在角色描述中**",
        "scenario": "角色情境的簡要描述。\n\n**不建議使用此欄位，請改寫在角色描述中**",
        "utilityBot": "啟用後會忽略主要提示詞、越獄提示詞與其他提示詞。適用於工具型 Bot，而非角色扮演",
        "loreSelective": "啟用選擇性模式後，必須同時符合啟用關鍵字與次要關鍵字，才會啟用該 Lorebook 條目",
        "loreRandomActivation":
            "啟用機率條件後，只要 Lorebook 條目的其他條件皆成立，每次送出對話時就會依「機率」設定值決定是否啟用",
        "additionalAssets":
            "在對話中顯示的額外資源。\n\n - 使用 `{{raw::<asset name>}}` 取得資源路徑。\n - 使用 `{{image::<asset name>}}` 顯示圖片。\n - 使用 `{{video::<asset name>}}` 顯示影片。\n - 使用 `{{audio::<asset name>}}` 播放音訊。\n    - 建議放在背景 HTML 中",
        "replaceGlobalNote": "此欄位有內容時，會以此內容取代目前的全域備註",
        "backgroundHTML":
            "會插入對話畫面背景的 Markdown／HTML 內容。\n\n也可搭配額外資源，例如使用 `{{audio::<asset name}}` 播放背景音樂" +
            "\n\n另外還可使用：" +
            "\n - `{{bg::<asset name>}}`：將指定資源顯示為背景圖片",
        "additionalText": "系統會將內容依兩個換行分段，並根據目前對話進行相似度搜尋，選出最多 3 個最相關的段落加入角色描述。可在此放置較長內容",
        "charjs": "會隨角色一起執行的 JavaScript 程式碼。可參考 `https://github.com/kwaroran/Risuai/blob/main/src/etc/example-char.js`。基於安全性，目前不建議使用；匯出時也不會包含此內容",
        "romanizer":
            "Romanizer 會在送出資料時，將非拉丁文字轉寫為拉丁字母，以減少 Token 使用量。這可能使模型輸出與原始文字不同。若對話本身使用拉丁字元，不建議啟用",
        "inlayImages": "啟用後，可將圖片內嵌至對話；若 AI 支援圖片輸入，也能讀取這些圖片",
        "metrica":
            "Metric Systemizer 會在送出請求時將公制轉成英制，並在顯示輸出時再轉回公制，讓模型以英制處理，而使用者仍看到公制。若對話原本使用英制，不建議啟用",
        "topP": "Top P 是核取樣（nucleus sampling）的機率門檻。模型會依 Token 機率由高到低累加，取涵蓋至少 top_p 累積機率的最小 Token 集合，再從該集合中取樣",
        "openAIFixer": "OpenAI Fixer 是用來修正部分 OpenAI 問題的外掛",
        "sayNothing": "啟用後，若沒有輸入任何文字，會自動輸入「say nothing」",
        "showUnrecommended": "啟用後會顯示不建議使用或已棄用的設定。**不建議使用這些設定**",
        "streamingDisplayOptimizationMode":
            "在長篇串流回應搭配大量後處理（例如 Regex 腳本）時，降低畫面顯示延遲。對行動裝置或低階裝置尤其有幫助。\n\n" +
            "關閉時維持一般行為，但每收到一個 Token 都會執行後處理，可能造成明顯負擔。\n\n" +
            "平衡模式會降低負載，只在短時間間隔（約每 0.125 秒）嘗試執行後處理。\n\n" +
            "強力模式與平衡模式類似，但串流期間完全略過後處理，等串流結束後再執行一次。\n\n" +
            "此為實驗性功能，部分功能可能因此出現非預期行為",
        "moduleModelBindingEnable": "模組自行送出的請求（例如腳本與 Trigger）會使用指定的模型預設集。關閉時，這些請求會改用目前對話的主要／輔助模型設定",
        "allowV2Plugin": "警告：啟用後會允許執行已棄用的 V2.0 外掛。V2.0 外掛會略過 V2.1 的安全檢查，可能存在風險。除非您明確信任該外掛，而且目前無法移轉至 V3，否則請維持關閉",
        "allowV21Plugin": "警告：由於 V2.1 API 已棄用，且未來版本將停止支援，系統預設禁止安裝新的 V2.1 外掛。已安裝的 V2.1 外掛仍可繼續執行。只有在您信任該外掛，且需要安裝或更新時才啟用；V2.1 安全檢查仍會生效",
        "imageCompression": "啟用後，匯出角色時會壓縮圖片。若動態圖片無法正常運作，請嘗試停用",
        "inlayImageLossless": "啟用後，內嵌圖片會以無損 PNG 儲存，而不是壓縮成 WebP。可保留原始畫質，但會明顯增加儲存空間用量",
        "inlayImagePriority": "啟用後會先嘗試將內嵌內容當作圖片顯示，以加快載入。若圖片載入失敗，影片／音訊內嵌內容會自動切換至正確類型。若大量使用影片或音訊內嵌內容，建議關閉",
        "modelModeLock": "設定對話要如何選擇模型系統。可全部固定使用舊版模型系統、固定使用模型預設集綁定系統，或不固定，讓每個對話自行決定",
        "newChatModelMode": "模型模式未被固定時，新建立的對話預設使用哪一套模型系統",
        "showModelInSidebar": "在側邊欄顯示目前 AI 模型名稱，方便快速確認",
        "showPresetInSidebar": "在側邊欄顯示目前套用的提示詞預設集名稱，方便快速確認",
        "showPersonaInSidebar": "在側邊欄顯示目前使用的使用者人設名稱，方便快速確認",
        "disableMobileDragDrop": "停用行動裝置上的對話拖放排序。若捲動畫面時常不小心拖動項目，可啟用此選項",
        "disableToggleBinding": "停用將開關值固定綁定至個別對話的功能。停用後會隱藏綁定／儲存／預設集按鈕，切換對話時也不會還原先前綁定的值",
        "useExperimental": "啟用後會顯示部分實驗性功能",
        "forceProxyAsOpenAI": "啟用後，使用反向代理時會強制採用 OpenAI 格式",
        "forcePlainFetch": "啟用後會使用瀏覽器 Fetch API，而非原生 HTTP 請求；這可能造成 CORS 錯誤",
        "autoFillRequestURL": "啟用後會依目前模型自動填入對應的請求 URL",
        "localNetworkModeDesc": "透過本機執行環境轉送私有網路／LAN 的模型 URL，而不是由瀏覽器直接 Fetch。\n\n" +
            "**用途**\n" +
            "- 避免瀏覽器對 `192.168.x.x`、`10.x.x.x`、`localhost`、`.local` 等本機位址的私有網路／CORS 限制。\n" +
            "- 在 Node 自架模式中，降低本機推理首 Token 較慢時發生逾時的風險。\n\n" +
            "**運作方式**\n" +
            "- 只有在啟用本機網路模式，且目標 URL 被判定為本機／私有網路位址時才會套用。\n" +
            "- Node 自架：串流會優先使用實驗性的 Job + WebSocket 中繼（失敗時改用 `/proxy2`）；非串流使用 `/proxy2`。\n" +
            "- Tauri：使用原生直接連線路徑。\n" +
            "- 公開網頁模式：基於設計，不允許直接存取本機／私有網路位址。\n\n" +
            "**限制**\n" +
            "- 僅適用於 OpenAI 相容的請求路徑。\n" +
            "- 無法繞過兩個公開網域之間的 Cloudflare origin 限制。\n" +
            "- 必須使用您自己的自架 URL（`globalThis.__NODE__ === true`）此功能才會生效",
        "chainOfThought": "啟用後會加入 Chain of Thought 提示詞",
        "gptVisionQuality": "用於設定圖片辨識模型的品質。品質越高，辨識越準確，但也會使用更多 Token",
        "genTimes":
            "設定支援此功能的模型一次要生成幾個回應。第一個以外的回應會預先快取，供之後「重新生成」使用。這有機會降低成本；但若沒有使用這些預先生成的回應，反而可能增加成本",
        "requestretrys": "設定請求失敗時的重試次數",
        "chatLoadInitialPages": "開啟對話畫面時，最初顯示的近期訊息數量。數值越高可立即顯示更多歷史紀錄，但開啟長對話時負擔也會增加",
        "chatLoadAdditionalPages": "每次捲動到頂端時額外載入並顯示的舊訊息數量。數值越高可減少重複載入次數，但每次載入的負擔也會增加",
        "emotionPrompt": "設定用於偵測情緒的提示詞。留空時使用預設提示詞",
        "additionalParams":
            '加入 Request Body 的額外參數。若要排除某個參數，可將值設為 `{{none}}`。若要加入 Header 而非 Request Body，可在鍵名前加上 `header::`，例如 `header::Authorization`。若要將值作為 JSON，可在值前加上 `json::`，例如 `json::{"key":"value"}`；否則會自動判斷值的型別',
        "antiClaudeOverload":
            "發生 Claude 過載時，PocketRisu 會嘗試以相同提示詞繼續請求，降低再次發生的機率。僅適用於串流回應；非官方 API 端點可能無法運作",
        "triggerScript":
            'Trigger 腳本是在符合條件時執行的自訂腳本，可修改對話資料、執行指令、變更變數等；可用功能依觸發時機而異。也可透過 {{button::顯示文字::TriggerName}} 按鈕執行，或在 HTML 按鈕加入 `risu-trigger="<TriggerName>"` 屬性',
        "autoContinueChat": "啟用後，若回應結尾沒有標點符號，會嘗試自動繼續生成回應。**請勿用於不使用標點符號的語言**",
        "combineTranslation":
            "啟用後，若同一句文字被 HTML 標籤拆開，會先合併後再翻譯，並在翻譯結果上重新套用「修改顯示」腳本。\n這有助於翻譯器產生正確譯文。\n若啟用後 UI 顯示異常，請關閉此選項並回報問題",
        "dynamicAssets":
            "啟用後，處理資料時若找不到完全相同的資源名稱，會透過向量搜尋尋找最接近的名稱並自動替換",
        "dynamicAssetsEditDisplay": "啟用後，動態資源也會套用至「修改顯示」階段，但可能造成效能問題",
        "nickname": "若設定暱稱，對話中的 {{char}} 或 <char> 會使用暱稱取代角色名稱",
        "useRegexLorebook": "啟用後，Lorebook 搜尋會使用 Regex，而非字串比對。格式為 /regex/flags",
        "customChainOfThought": "警告：已不建議使用 Chain of Thought 開關。請改將 Chain of Thought 提示詞放入其他提示詞欄位",
        "customPromptTemplateToggle":
            "可在此自訂提示詞開關。格式為 `<toggle variable>=<toggle name>`，每行一組，例如 `cot=Toggle COT`。可在提示詞中以 `{{getglobalvar::toggle_<toggle variable>}}` 取得開關值，例如 `{{getglobalvar::toggle_cot}}`",
        "defaultVariables":
            "可在此定義預設變數。格式為 `<variable name>=<variable value>`，每行一組，例如 `name=PocketRisu`。之後可在 Trigger 腳本與變數 CBS 中使用，如 `{{getvar::A}}`、`{{setvar::A::B}}` 或 `{{? $A + 1}}`。若提示詞模板與角色的預設變數名稱相同，會優先使用角色的預設變數",
        "lowLevelAccess":
            "啟用後，可使用需要較高運算資源的功能，並允許透過 Trigger V2 或 Lua 呼叫 AI 模型等底層存取功能。除非確實需要，否則請勿啟用",
        "triggerLLMPrompt":
            "要送給模型的提示詞。可使用 `@@role user`、`@@role system`、`@@role assistant` 建立多輪、不同身分的訊息，例如：\n```\n@@role system\nrespond as hello\n@@role assistant\nhello\n@@role user\nhi\n```",
        "legacyTranslation":
            "啟用後使用舊版翻譯方式：在翻譯前先預處理 Markdown 與引號，而非在翻譯後進行後處理",
        "luaHelp":
            "Trigger 腳本可使用 Lua。您可以定義 onInput、onOutput、onStart 函式；onInput 在使用者送出訊息時呼叫，onOutput 在角色送出訊息時呼叫，onStart 在對話開始時呼叫。詳細資訊請參閱說明文件",
        "claudeCachingExperimental":
            "Claude 快取是實驗性功能，可降低模型成本，但若沒有使用重新生成也可能增加成本。由於仍屬實驗性功能，可能不穩定，未來行為也可能變更",
        "urllora":
            "可使用模型檔案的直接下載連結。Google Drive 可透過 https://sites.google.com/site/gdocs2direct/ 等網站建立直接連結；也可使用 CivitAI：複製 AIR（例如 `urn:air:flux1:lora:civitai:180891@776656`，或直接使用 `civitai:180891@776656`）後貼上",
        "v2GetAlertSelect": "選項以 |（pipe）字元分隔",
        "v2RegexTest": "Regex 比對成功時回傳 1，未符合則回傳 0",
        "v2Calculate":
            "計算數學運算式，支援基本四則運算（+、-、*、/、%、^）、比較運算子（<、>、<=、>=、=、!=）、邏輯運算子（&&、||、!）、括號優先順序，以及使用 $variableName 格式代入變數。變數會自動轉成數字，無效值預設為 0",
        "namespace":
            "Namespace 是模組的唯一識別名稱，用於避免模組之間發生衝突，也可供預設集與其他模組引用或互動。若不確定該填什麼，請留空",
        "moduleIntergration":
            "可在模組整合區塊填入模組 Namespace 以啟用模組；若要同時啟用多個模組，請以逗號分隔，例如 `module1,module2,module3`。此功能提供給希望依不同預設集切換模組的進階使用者",
        "customCSS": "自訂 CSS 樣式。若設定造成問題，也可按 Ctrl + . 快速停用／啟用",
        "betaMobileGUI": "啟用後，小於 800px 的螢幕會使用 Beta 行動版 GUI。需要重新整理",
        "enableScrollToActiveChar": "啟用後，按下快捷鍵，或按住 Ctrl 拖曳角色時，會捲動至目前啟用的角色；若角色所在資料夾已收合，會自動展開",
        "unrecommended": "此為不建議使用的設定",
        "jsonSchema":
            "若 AI 模型支援 JSON Schema，此處的 JSON Schema 會一併送給模型。\n\n由於 JSON Schema 較難撰寫，PocketRisu 也允許使用 TypeScript interface 的子集，並在執行時自動轉換。\n\n" +
            '例如，若希望模型輸出下列 JSON：\n\n```js\n{\n  "name": "PocketRisu", // name 必須為 PocketRisu\n  "age": 1, // age 必須是數字\n  "icon": "slim", // icon 必須為 \'slim\' 或 \'rounded\'\n  "thoughts": ["Good View!", "Lorem"] // thoughts 必須是字串陣列\n}\n```\n\n' +
            "可填入下列 TypeScript interface：\n\n```typescript\ninterface Schema {\n  name: string;\n  age: number;\n  icon: 'slim'|'rounded'\n  thoughts: string[]\n}\n```\n\n" +
            "interface 名稱不影響結果。更多資訊請參閱 TypeScript 說明文件（https://www.typescriptlang.org/docs/handbook/interfaces.html）。支援的 TypeScript 子集如下：\n\n" +
            "<details><summary>支援的 TypeScript 子集</summary>\n\n" +
            `支援的型別有 \`boolean\`、\`number\`、\`string\`、\`Array\`。除下列情況外，不支援 unit type、intersection type、union type、optional、literal type 等進階型別：\n
        - 基本型別陣列（例如 \`string[]\`、\`Array<boolean>\`）
        - 字串常值的聯集型別（例如 \`'slim' | 'rounded'\`）。

        每個屬性必須各自占一行；同一行定義多個屬性會產生錯誤。屬性名稱與 interface 名稱只能使用 ASCII 範圍內的拉丁字元。屬性名稱不可包在單引號或雙引號中。不支援 interface 內的巢狀結構；定義屬性的行內也不可出現 \`{\` 或 \`}\`。若需要更進階的型別，請改用 JSON Schema。
        ` +
            "</details>",
        "strictJsonSchema": "啟用後，部分模型會嚴格遵循提供的 JSON Schema；停用時，模型可能忽略 JSON Schema",
        "extractJson":
            '此欄位有內容時，會從回應中擷取指定 JSON 資料。例如，要從 `{"response": {"text": ["hello"]}}` 擷取 `response.text[0]`，可填入 `response.text.0`',
        "translatorNote":
            "可在此為每個角色加入專屬翻譯提示詞。僅在使用 Ax 模型翻譯時生效。若要套用，請在語言設定中加入 `{{slot::tnote}}`。群組對話不支援此功能",
        "groupInnerFormat":
            "設定群組對話中非發言角色使用的格式。此欄位有內容時，會使用此格式取代預設格式；若「群組中非發言角色的身分」為 `assistant`，也會套用至正在發言的角色",
        "chatHTML": "插入每則對話的 HTML。\n\n可使用 CBS 與特殊標籤：\n- `<risutextbox>`：用來顯示文字的文字框\n- `<risuicon>`：user 或 assistant 的圖示\n- `<risubuttons>`：編輯、翻譯等對話操作按鈕\n- `<risugeninfo>`：生成資訊按鈕",
        "systemContentReplacement": "模型不支援 system 身分時，會先用此格式改寫原本 system 訊息的內容，再以「system 身分替代值」指定的身分送出；`{{slot}}` 代表原始內容",
        "systemRoleReplacement": "若模型不支援 system 身分，會改用此身分送出原本的 system 訊息",
        "summarizationPrompt":
            "摘要時使用的提示詞。留空會使用預設提示詞。也可使用 ChatML 格式，並以 {{slot}} 代表對話資料。摘要輸出會以兩個換行（\n\n）切分成區塊，供相似度搜尋使用",
        "translatorPrompt":
            "翻譯時使用的提示詞。留空會使用預設提示詞。也可使用 ChatML 格式，其中 {{slot}} 代表目標語言、{{slot::content}} 代表內容、{{slot::tnote}} 代表翻譯備註",
        "translateBeforeHTMLFormatting":
            "啟用後，會在 Regex 腳本與 HTML 格式處理前先翻譯文字。這可能減少 Token 使用量，但也可能破壞格式",
        "autoTranslateCachedOnly": "與自動翻譯同時啟用時，只會自動翻譯先前已有翻譯快取的訊息",
        "presetChain":
            "此欄位有內容時，每次使用者送出訊息，都會從清單中隨機選取並套用一個預設集。多個預設集請以逗號分隔，例如 `preset1,preset2`",
        "legacyMediaFindings": "啟用後，使用舊版方式搜尋媒體資源，不使用額外搜尋演算法",
        "comfyWorkflow":
            "填入 ComfyUI 的 API Workflow。可在 ComfyUI 按下「Workflow > Export (API)」匯出。Workflow 內容也必須包含 {{risu_prompt}}，Risu 會將它替換為實際提示詞",
        "automaticCachePoint": "若對話結束時不存在快取點，會自動建立快取點",
        "experimentalChatCompressionDesc":
            "將未使用的對話資料壓縮並存到獨立檔案，可大幅減少對話資料大小並改善效能。但此功能仍屬實驗性，可能不穩定，也可能造成備份等功能出現問題",
        "promptInfoInsideChatDesc":
            "啟用後會將提示詞預設集資訊存入對話中繼資料，包括預設集名稱、啟用中的開關與提示詞文字。可能略微增加處理時間與儲存空間用量",
        "autoAdjustSchema": "啟用後，會自動調整「動態輸出」使用的 JSON Schema",
        "dynamicMessages": "啟用後，AI 可以連續送出多則訊息，而非一次只送一則",
        "dynamicMemory": "啟用後，AI 會在生成回應時建立記憶筆記。要實際使用此功能，仍需搭配額外提示詞",
        "dynamicResponseTiming": "啟用後，會動態調整回應時機",
        "dynamicRequest": "啟用後，PocketRisu 會在隨機時間向模型送出請求，不必等待使用者輸入",
        "settingsCloseButtonSize": "調整設定視窗右上角關閉（X）按鈕大小。預設為 24",
        "showTypingEffect": "啟用後，AI 生成回應期間會顯示「正在輸入」指示器",
        "dynamicOutputPrompt": "啟用後，請求中會包含 Schema 資訊",
        "realmDirectOpen": "啟用後，在 RisuRealm 預覽中按一下角色會直接開啟角色描述",
        "openRouterProviderOrder":
            "設定供應商使用順序。會優先使用清單中的第一個供應商；若不可用則依序改用下一個。詳見 https://openrouter.ai/docs/guides/routing/provider-selection#ordering-specific-providers",
        "openRouterProviderOnly":
            "只允許使用清單中的供應商；若全部都不可用，請求會失敗。詳見 https://openrouter.ai/docs/guides/routing/provider-selection#allowing-only-specific-providers",
        "openRouterProviderIgnore":
            "忽略清單中的供應商；若因此沒有任何可用供應商，請求會失敗。詳見 https://openrouter.ai/docs/guides/routing/provider-selection#ignoring-providers",
        "additionalPrompt":
            "啟用「提示詞預處理（Prompt Preprocess）」時，會附加到主要提示詞末尾的文字。預設為「The assistant must act as {{char}}. user is {{user}}.」，用來建立基本角色扮演上下文",
        "hideAllImagesDesc": "隱藏角色圖示、角色圖片資源與 RisuRealm 封面圖片",
        "hideMessagePageCountDesc": "隱藏重新生成訊息與開局訊息的分頁計數（例如 1/3）。導覽箭頭與重新生成按鈕仍會顯示",
        "embedding":
            "Embedding 模型會用於多項功能的相似度搜尋：\n\n" +
            "- **長期記憶**：HypaMemory V2、HypaMemory V3、HanuraiMemory，以及啟用 HypaMemory 的 SupaMemory\n" +
            "- **額外描述**：依上下文比對角色的額外資訊\n" +
            "- **動態資源**：找不到完全相符的資源名稱時，尋找相似名稱\n" +
            "- **Trigger 腳本**：Trigger 腳本中的相似度條件\n" +
            "- **檔案附件**：搜尋 PDF／TXT／XML 附件內容\n" +
            "- **Playground**：在 Playground 測試 Embedding",
        "keepSessionAlive":
            "維持分頁活動狀態，避免工作階段因閒置而失效。可能需要重新整理才會生效。\n\n" +
            "- **透過音訊**：定期播放無聲音訊以維持工作階段。此方式在大多數瀏覽器中相容性最佳，也通常最有效。\n",
        "reSummarizationPrompt":
            "使用批次編輯將多個已選摘要合併成一個摘要時使用的提示詞。留空則使用預設提示詞。摘要輸出會以兩個換行（\n\n）切分成區塊，供相似度搜尋使用",
        "hypaV3MemoryTokensRatio":
            "提示詞中分配給長期記憶區塊 {{slot}} 的 Token 額度，占最大上下文長度的比例",
        "hypaV3ExtraSummarizationRatio":
            "控制摘要要持續到多低的 Token 數才停止。設為 0 時，Token 降到最大上下文長度以下就停止；數值越高，會繼續進行更多摘要後才停止",
        "hypaV3MaxChatsPerSummary":
            "建立單一摘要時最多包含的對話訊息數量",
        "hypaV3RecentMemoryRatio":
            "分配給近期記憶的記憶 Token 比例。會從最新建立的摘要開始自動填入，直到分配額度用滿",
        "hypaV3SimilarMemoryRatio":
            "分配給相似記憶的記憶 Token 比例。會依與近期對話的相似度分數由高至低填入摘要，直到分配額度用滿",
        "hypaV3RandomMemoryRatio":
            "從尚未被其他類別選中的摘要中隨機填入",
        "hypaV3PreserveOrphanedMemory":
            "啟用後，來源對話訊息已被刪除的摘要仍會保留；停用時，來源訊息已不存在的摘要會自動移除",
        "hypaV3ProcessRegexScript":
            "啟用後，在 HypaV3 視窗重新生成摘要時，會先對輸入對話訊息套用 Regex 腳本",
        "hypaV3DoNotSummarizeUserMessage":
            "啟用後，HypaV3 建立摘要時會略過使用者訊息；使用者訊息也不會計入每份摘要的最大訊息數",
        "hypaV3EnableSimilarityCorrection":
            "啟用後，會額外使用近期對話摘要作為相似度搜尋的查詢內容。無法與實驗版 HypaMemory V3 搭配使用",
        "hypaV3SummaryChunkSeparator":
            "用來將摘要切成多個區塊、供相似度搜尋使用的 Regex",
        "hypaV3UseExperimentalImpl":
            "切換至實驗版 HypaMemory V3。會啟用速率限制設定，並改變相似度查詢方式",
        "hypaV3AlwaysToggleOn":
            "啟用後，選擇角色時會自動開啟 HypaMemory",
        "memoryPresetBinding":
            "設定此對話使用的長期記憶預設集。\n\n- **預設**：跟隨「設定 → 長期記憶」中的「預設套用的預設集」，之後該預設值變更時也會跟著變更。\n- **關閉**：超出上下文長度的訊息會直接被截除，不會送給模型。\n- **指定預設集**：此對話固定使用該預設集（摘要模型、比例等），不受全域預設值影響。\n\n此設定會分別儲存在每個對話中，因此不會影響同一角色的其他對話",
        "memoryPresetDefault":
            "未另外指定長期記憶預設集的對話會使用此預設值。設為「關閉」時，只有自行指定預設集的對話會啟用長期記憶",
        "toggleHypaMemory":
            "設定此對話是否使用 HypaMemory（長期記憶）。\n\n- 啟用：上下文填滿後，較舊訊息會自動摘要成長期記憶，之後回應時再取回相關摘要。\n- 關閉：超出上下文長度的訊息會直接被截除，不會送給模型。\n\n此設定會分別儲存在每個對話中，不受角色預設值影響，因此不會改變同一角色的其他對話。摘要本身的行為請在預設集中的 HypaV3 設定調整",
        "useModelPresetBinding":
            "將模型預設集綁定至此對話。\n\n啟用：使用模型預設集，並為各對話分別綁定模型。\n關閉：使用既有的「聊天 Bot」設定（預設）",
        "promptPresetParams":
            "此對話透過模型預設集送出主要請求時，目前套用的提示詞預設集取樣參數（Temperature、Top P、各類懲罰等）會覆寫模型預設集中的對應參數。\n\n- 只套用至目前對話，而且只影響主要模型請求，不影響輔助模型。\n- 只會覆寫模型預設集本身支援的參數。輸出 Token 上限（Max Tokens）與思考設定屬於模型能力，因此一律由模型預設集決定。\n- 若您在模型預設集的自訂 Request Body／額外參數中明確指定值，仍會優先採用該值。\n- 舊版模型模式本來就會套用提示詞預設集參數，因此此選項在該模式下不會產生效果",
        "hypaV3SummarizationRequestsPerMinute":
            "每分鐘最多可送出的摘要模型請求數。僅在摘要模型設為「輔助模型」時生效",
        "hypaV3SummarizationMaxConcurrent":
            "可同時進行的摘要模型請求上限。僅在摘要模型設為「輔助模型」時生效",
        "hypaV3EmbeddingRequestsPerMinute":
            "相似度搜尋每分鐘最多可送出的 Embedding 模型請求數",
        "hypaV3EmbeddingMaxConcurrent":
            "相似度搜尋可同時進行的 Embedding 模型請求上限",
        "hypaV3QueryChatCount":
            "用於相似度搜尋的近期對話訊息數量。數值越高，搜尋查詢就會涵蓋更多對話內容",
        "nodeOnlyRestoreLastChat": "啟動或重新載入應用程式時，重新開啟您最後查看角色的對話。這可避免行動瀏覽器回收背景分頁後，重新回到 PocketRisu 時被送回首頁。若您原本是從首頁離開，仍會停留在首頁",
        "nodeOnlyScrollButtonType": "設定對話捲動按鈕的顯示方式。「4 個按鈕」會加入跳到頂端／底端；「2 個按鈕」只保留上一則／下一則訊息導覽；「關閉」則隱藏所有捲動按鈕",
        "nodeOnlyServerSideRequests": "由伺服器代替瀏覽器送出請求並儲存回應。即使螢幕關閉或連線中斷，生成仍會繼續；重新連線後會自動還原完成的回應。只套用於模型預設集請求；關閉後會恢復先前由用戶端直接送出請求的方式",
        "confirmReroll": "重新生成訊息前先要求確認",
        "sendWithEnter": "按 Enter 送出訊息",
        "sendKeyPC": "設定電腦上用哪個按鍵送出訊息",
        "sendKeyMobile": "設定行動裝置上的訊息送出方式",
        "fixedChatTextarea": "將對話輸入框固定在畫面底部，捲動時仍維持原位",
        "clickToEdit": "點選對話訊息後立即進入編輯模式",
        "enableBlockPartialEdit": "滑鼠移到訊息中的段落／區塊上時，顯示各區塊的編輯控制項",
        "longPressToPopupEditor": "長按訊息時開啟彈出式編輯器",
        "showInputActionBar": "在多行文字欄位底部顯示工具列，提供複製、重設與展開至編輯器等按鈕",
        "enableDragPartialEdit": "允許只編輯在訊息中拖曳選取的文字",
        "botSettingAtStart": "每次啟動應用程式時自動開啟「Bot 設定」頁面",
        "showMenuChatList": "直接在側邊選單中顯示目前角色的對話清單",
        "showMenuHypaMemoryModal": "在側邊欄顯示按鈕，用來開啟 HypaMemory（HypaV3）管理視窗",
        "goCharacterOnImport": "匯入角色卡後自動切換至該角色",
        "sideMenuRerollButton": "在對話側邊選單顯示重新生成按鈕",
        "localActivationInGlobalLorebook":
            "允許全域 Lorebook 使用個別啟用條件，例如只對目前角色啟用",
        "requestInfoInsideChat": "允許在對話區域顯示 LLM 請求資訊，例如送出的提示詞與 Token 數",
        "inlayErrorResponse": "模型請求失敗時，將錯誤以內嵌訊息顯示在對話中",
        "bulkEnabling": "在 Lorebook 編輯器中顯示可一次啟用或停用多個條目的按鈕",
        "showTranslationLoading": "訊息翻譯進行中時顯示載入指示",
        "autoScrollToNewMessage": "收到新訊息時自動捲動至該訊息",
        "alwaysScrollToNewMessage": "收到新訊息時一律捲動到底部，即使您先前已手動往上捲動",
        "newMessageButtonStyle": "選擇「新訊息」按鈕的顯示位置與樣式",
        "createFolderOnBranch":
            "從對話建立分支時自動建立資料夾，將原對話與分支對話歸在一起",
        "hamburgerButtonBottom": "將漢堡選單按鈕移到側邊欄底部",
        "hideLeftBarCollapseButton": "在窄畫面（小於 400px）隱藏左側角色欄的收合按鈕",
        "hideRecentChats": "未選取角色時，隱藏側邊欄中的最近對話清單",
        "hideDeactivatedCharacters": "從側邊欄角色列隱藏已停用角色，而不是以淡化方式顯示。這些角色仍會列在角色管理與儲存空間儀表板中",
        "loreBookDepth":
            "搜尋 Lorebook 啟用關鍵字時，從最新訊息往前檢查幾則訊息。`0` 代表停用搜尋；數值越高越能檢查較舊的訊息，但也可能啟用不必要的條目。（0–20）",
        "loreBookToken":
            "每次建立提示詞時，Lorebook 條目可占用的最大 Token 數。超過上限時會優先截除低優先順序的條目。（0–4096）",
        "autoContinueMinTokens":
            "「防止回應未完成（自動繼續）」的最低 Token 數。回應短於此數值時不會自動繼續生成",
        "descriptionPrefix":
            "送給模型時加在角色描述前方的前綴文字。留空會使用預設值。只有需要自訂標頭或格式時才建議修改",
        "assetMaxDifference":
            "動態資源名稱比對時允許的差異程度。數值越高，比對越寬鬆，但也更可能選到錯誤資源。通常建議使用預設值",
        "heightMode":
            "設定對話畫面高度使用的 CSS 單位。若行動瀏覽器網址列遮住畫面，可嘗試其他單位（`svh`、`lvh`、`dvh`）。\n\n- **一般**：自動（`100%`）\n- **百分比／VH**：傳統單位，在部分行動瀏覽器可能有問題\n- **DVH**：動態視窗高度，會隨網址列大小改變\n- **SVH**：小視窗高度，確保內容位於可見範圍\n- **LVH**：大視窗高度，以網址列隱藏時的畫面為準",
        "removeIncompleteResponse":
            "自動移除回應結尾未完成的句子，例如因網路錯誤、Token 上限或其他中斷造成的截斷內容。關閉時會保留原始截斷回應，方便檢查或手動重新生成",
        "newOAIHandle":
            "使用新版 OpenAI 回應處理流程。若模型或回應在舊版處理流程下出現問題，可嘗試啟用。一般情況建議維持預設值",
        "noWaitForTranslate":
            "自動翻譯完成前先顯示原文；翻譯完成後再以譯文取代或補充",
        "newImageHandlingBeta":
            "使用新版內嵌圖片處理流程。此為測試中功能，部分特殊情況下的行為可能與舊版不同",
        "allowAllExtentionFiles":
            "停用檔案選擇器的副檔名篩選，允許選擇所有檔案類型。適合匯入使用特殊或錯誤副檔名儲存的角色卡",
        "dynamicModelRegistry":
            "執行期間從 OpenRouter 等供應商動態取得模型清單。關閉時只顯示內建的靜態清單",
        "disableSeperateParameterChangeOnPresetChange":
            "切換提示詞預設集時，不要連動變更各輔助功能的獨立參數（記憶、情緒、翻譯模型設定等）。若希望輔助模型獨立固定，不受預設集影響，可啟用此選項",
        "googleCloudTokenization":
            "使用 Google Cloud／Vertex／Gemini 的 Tokenizer API 計算 Token。準確度較高，但可能增加 API 請求與費用。此為實驗性功能，只會在啟用實驗性設定時顯示",
        "localNetworkTimeoutSec":
            "本機網路模式等待的最長秒數。本機 LLM 生成首個 Token 可能較慢，因此建議至少設定 30 秒。（30–3600）",
        "enableDevTools":
            "顯示用於偵錯對話與 UI 行為的開發者工具。一般使用者可維持關閉",
        "promptTextInfoInsideChat":
            "啟用「將提示詞資訊儲存至對話」後，同時儲存並顯示實際送給模型的提示詞文字。這會增加對話資料量，建議主要用於偵錯",
        "returnCSSError":
            "自訂 CSS 編譯失敗時顯示詳細通知。關閉後會靜默忽略 CSS 錯誤",
        "antiServerOverload":
            "API 伺服器回報過載（例如 429 或 503）時，自動增加重試間隔。有助於減輕不穩定供應商的負載",
        "claude1HourCaching":
            "使用 Claude 的 1 小時提示詞快取 TTL，而不是預設的 5 分鐘。重複上下文可進一步降低成本，但 1 小時快取的計價方式不同",
        "claudeBatching":
            "使用 Claude Batch API 批次處理請求。成本較低，但不會立即收到回應，可能需要數分鐘到數小時；較適合背景工作",
        "rememberToolUsage":
            "將工具使用結果保留在對話中，讓之後的回應可以參照。關閉時，工具結果只會當作一次性資料",
        "bookmark":
            "允許為對話訊息加入書籤，並在選單中集中查看。適合在長對話中快速找到重要訊息",
        "simplifiedToolUse":
            "以較簡化、適合在對話中閱讀的格式顯示工具呼叫結果。原始工具輸出過長或雜訊過多時可啟用",
        "useTokenizerCaching":
            "快取重複文字的 Token 計算結果，不必每次重新計算。可改善長對話效能，一般情況下可維持啟用",
        "auxModelUnderModelSettings":
            "在主要模型設定下方直接顯示輔助模型設定，方便在同一處比較與調整",
        "pluginDevelopMode":
            "啟用外掛開發輔助功能，例如記錄、重新載入與 Hot Reload 支援。一般使用者應維持關閉",
        "unrecommendedNewGoogleTrans":
            "使用新版實驗性 Google 翻譯流程。可能比舊版更快，但部分情況下可能發生問題",
        "unrecommendedClaudeCachingRetrival":
            "嘗試對重複請求重用 Claude 快取回應。由於快取失效判斷較複雜，可能回傳非預期結果，因此不建議使用",
        "lightningRealmImport":
            "帳號同步啟用時，從 RisuRealm 匯入角色會使用較快的匯入流程。此為實驗性功能",
        "unrecommendedTriggerV1":
            "允許新增與編輯 Trigger V1。Trigger V1 已棄用；新內容請使用 V2／V3。只有為了相容舊版 V1 內容時才應保留",
        "themePresets":
            "將目前的「顯示與音訊」設定（版面、顏色／字型、大小、音效開關等）儲存為預設集並快速切換。目前使用中的預設集會自動同步下方設定的變更；點選後可開啟預設集清單，進行新增、切換、重新命名或刪除",
        "theme": "整體對話版面主題",
        "waifuWidth": "Waifulike 主題中的對話區域寬度",
        "waifuWidth2": "Waifulike 主題中的角色立繪區域寬度",
        "nodeOnlyStandardChatWidth": "PocketRisu Standard 主題中的對話卡片最大寬度",
        "colorScheme": "Risu UI 全域使用的配色",
        "textColor": "訊息文字配色主題",
        "font": "訊息字型",
        "customFont": "要使用的字型名稱",
        "UISize": "全域 UI 縮放比例",
        "lineHeight": "訊息文字的行高",
        "iconSize": "角色／使用者人設圖示大小",
        "textAreaSize": "角色、Lorebook、提示詞等編輯用文字框的高度級距。不影響對話輸入框",
        "textAreaTextSize": "上述編輯用文字框中的文字大小級距。不影響對話輸入框",
        "sideBarSize": "側邊欄寬度級距",
        "assetWidth": "對話內資源圖片的最大寬度",
        "animationSpeed": "UI 動畫速度倍率",
        "memoryLimitThickness": "記憶上限線條粗細",
        "fullscreen":
            "將瀏覽器切換為全螢幕模式。在行動裝置上可隱藏網址列等瀏覽器 UI，讓對話區域更大",
        "showMemoryLimit":
            "在對話區域以線條標示目前的最大上下文範圍。線條以上的訊息可能不會送給模型，可用來判斷模型目前仍能「記住」哪些內容",
        "hideRealm":
            "首頁的「最近上傳」區塊預設收合。收合時會略過 RisuRealm 資料請求，加快首次載入；之後仍可隨時在首頁展開",
        "showRequestStatus":
            "模型預設集請求執行期間顯示浮動狀態提示，包含即時階段（連線／思考／回應／停滯）、思考與回應 Token 數，以及每秒 Token。狀態只儲存在記憶體中；關閉後完全不顯示",
        "customBackground": "用作對話背景的自訂圖片",
        "playMessageOnTranslateEnd":
            "翻譯完成時播放另一個通知音效。啟用自動翻譯時，可用聲音提示翻譯已完成",
        "roundIcons":
            "將角色與使用者人設圖示顯示為圓形，而不是方形",
        "textScreenColor":
            "設定訊息文字區域後方的背景顏色。停用即可恢復透明背景",
        "textBorder":
            "在訊息文字周圍加上細框線，提高文字在背景圖片上的可讀性",
        "textScreenRound":
            "將訊息文字區域的角落設為圓角。在有文字背景或外框的主題中最明顯",
        "showSavingIcon":
            "資料儲存期間顯示小型儲存中指示圖示。頻繁儲存的頁面特別實用",
        "showPromptComparison":
            "在提示詞比較視窗顯示組合完成的提示詞。可用於提示詞偵錯或降低 Token 使用量",
        "textScreenBorder":
            "設定對話文字區域的外框顏色。停用即可移除外框",
        "useChatCopy":
            "在每則訊息旁顯示複製按鈕。關閉後仍可從訊息選單複製",
        "useAdditionalAssetsPreview":
            "在角色的額外資源清單顯示縮圖預覽。資源數量很大時可能稍微降低載入速度",
        "hideApiKeys":
            "遮蔽設定中的 API 金鑰輸入欄位。螢幕分享或截圖時特別實用",
        "unformatQuotes":
            "停用預設的引號格式，例如斜體或顏色，改以一般文字顯示。若文字本身已有自訂格式，可啟用此選項",
        "blockquoteStyling":
            "將 Markdown `>` 引用內容顯示為樣式化引用區塊。關閉時則顯示為一般縮排文字",
        "customQuotes":
            "自動將單引號與雙引號替換為自訂字元。可用來強制使用特定語言的引號形式",
        "customQuotesDoubleLeading":
            "雙引號開頭使用的字元，例如 `\"`、`“`、`「`、`«`",
        "customQuotesDoubleTrailing":
            "雙引號結尾使用的字元，例如 `\"`、`”`、`」`、`»`",
        "customQuotesSingleLeading":
            "單引號開頭使用的字元，例如 `'`、`‘`、`『`",
        "customQuotesSingleTrailing":
            "單引號結尾使用的字元，例如 `'`、`’`、`』`",
        "menuSideBar":
            "以常駐側邊選單取代傳統漢堡選單。在較寬畫面上可加快導覽",
        "notification":
            "啟用新訊息的瀏覽器通知。首次啟用時瀏覽器可能會要求權限；若拒絕權限，此選項會自動關閉",
        "unrecommendedChatSticker":
            "啟用舊版對話貼圖功能。此功能已不建議使用，未來版本可能移除",
        "UiLanguage":
            "Risu UI 的顯示語言。變更後請先關閉一次設定視窗，讓新語言完整套用。\n\n- **[以您的語言翻譯]**：下載目前語言的 JSON，您可以完成翻譯後提交給開發者收錄",
        "translatorLanguage":
            "角色回應要翻譯成的目標語言，不是原文語言。選擇 `停用` 可關閉翻譯",
        "translatorType":
            "選擇使用的翻譯引擎。\n\n- **Google**：免費、快速；支援語言的品質尚可\n- **DeepL**：譯文自然，需要免費或付費金鑰\n- **Ax 模型**：透過輔助模型進行 LLM 翻譯，通常最自然，但速度較慢且會消耗 Token\n- **DeepL X**：自架的 DeepL 相容代理伺服器\n- **Firefox**：瀏覽器內建 Bergamot 翻譯，會下載本機模型",
        "deeplKey":
            "DeepL API 驗證金鑰，可從 https://www.deepl.com/account 取得。免費金鑰使用不同端點，因此還需要啟用下方的 DeepL Free 選項",
        "deeplFreeKey":
            "使用 DeepL Free 金鑰。啟用後，請求會送至 `https://api-free.deepl.com/v2/translate`；使用 Pro 金鑰時請關閉此選項",
        "deeplXUrl":
            "自架 DeepL X／DeepL 相容翻譯伺服器的 URL，例如 `https://my-server.com/translate`",
        "deeplXToken":
            "DeepL X 伺服器的驗證 Token。伺服器不需要驗證時可留空",
        "sourceLanguage":
            "設定 Google 翻譯要自動偵測原文語言，或固定假設某個原文語言。通常建議使用自動偵測；短訊息容易誤判時可改成固定語言",
        "htmlTranslation":
            "使用 Firefox／Bergamot 翻譯器時，同時翻譯 HTML 標記。若標記因此損壞，而您只想翻譯純文字，可關閉",
        "autoTranslation":
            "收到角色回應後立即自動翻譯。關閉時可使用每則訊息的翻譯按鈕。若希望先看到原文，再等待翻譯，可搭配「不等待翻譯完成」",
        "translationResponseSize":
            "LLM 翻譯時要求的最大回應 Token。過低可能截斷長篇翻譯；過高會增加成本，常見設定約為 1000–4000",
        "translatorPreset":
            "要編輯並使用的 LLM 翻譯預設集。每個預設集都會儲存自己的回應長度上限與翻譯提示詞，因此切換預設集會同步變更下方欄位",
        "postEndInnerFormat":
            "群組對話中，角色回應結束時附加到模型輸入的格式。留空可停用。可幫助模型辨識下一位發言者的回合，例如 `\\n[end_of_turn]\\n`",
        "maxThoughtTagDepth":
            "模型輸出中 `<thought>...</thought>` 等巢狀思考標籤允許的最大層級。巢狀層級過深可能浪費 Token；通常 `1` 到 `3` 已足夠。`0` 代表停用思考標籤處理",
        "predictedOutput":
            "OpenAI Predicted Outputs 可提供預期的靜態輸出內容；若模型實際生成的結果大致相符，可加快回應。適合程式碼修改等只有少量內容變動的工作，對角色扮演通常幫助有限",
        "moduleName":
            "模組在 UI 中顯示的名稱；模組與角色之間互相引用時，則使用下方的 Namespace",
        "moduleDescription":
            "模組說明，只會顯示在 UI，不會送給模型",
        "moduleHideChatIcon":
            "套用此模組的對話中隱藏模組圖示。啟用大量模組時可讓 UI 更簡潔",
        "moduleBackgroundEmbedding":
            "附加至此模組的背景 HTML／CBS。模組啟用時會套用到對話背景；語法請參閱全域「對話背景 HTML」說明",
        "moduleRegexList":
            "附加至此模組的 Regex 腳本。語法與行為請參閱全域「Regex 腳本」說明",
        "moduleAdditionalAssets":
            "隨模組一起封裝的額外資源，可由模組背景 HTML、Regex 腳本、Trigger 與提示詞引用",
        "googleAIKey":
            "Google AI Studio（https://aistudio.google.com）的 API 金鑰，用於直接呼叫 Gemini API。若使用企業版 Vertex AI，請改填下方 Vertex 欄位",
        "vertexProjectId":
            "Vertex AI 使用的 Google Cloud 專案 ID。所用服務帳戶必須具有此專案的 Vertex AI 權限",
        "vertexClientEmail":
            "Vertex 驗證所用的服務帳戶電子郵件（`...@<project>.iam.gserviceaccount.com`），可從服務帳戶 JSON 金鑰檔案複製",
        "vertexPrivateKey":
            "服務帳戶 JSON 金鑰檔案中的 `private_key` 值。請貼上完整的 `-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----` 區塊。此資訊極為敏感，分享備份時請特別留意",
        "vertexRegion":
            "Vertex AI 請求要送往的區域。`global` 會自動路由；美國使用者常用 `us-central1` 或 `us-west1`。若有資料駐留需求，請選擇符合規範的區域",
        "novellistKey":
            "NovelList 的 API 金鑰。可用模型與存取規則經常變動，使用前請先確認 NovelList 官方說明",
        "mancerKey":
            "Mancer API 金鑰。使用 Mancer（https://mancer.tech/）代管的開源模型時需要設定",
        "claudeApiKey":
            "Anthropic API 金鑰（以 `sk-ant-` 開頭），可從 https://console.anthropic.com/settings/keys 取得。\n\n若選擇的是 AWS Bedrock 模型，則不會使用此金鑰；Bedrock 驗證需另外設定",
        "mistralKey":
            "Mistral AI API 金鑰，可從 https://console.mistral.ai/api-keys/ 取得。只有直接呼叫 Mistral 時才需要；若透過其他供應商（例如 OpenRouter）使用 Mistral 模型，可留空",
        "novelaiToken":
            "NovelAI API 使用的 Bearer Token。NovelAI 沒有提供官方 API 金鑰頁面；登入後可透過瀏覽器開發者工具擷取 Token，或使用輔助工具",
        "proxyAPIKey":
            "反向代理用來驗證的 API 金鑰。若代理不需要驗證可留空；送出時會以 `Authorization: Bearer <key>` 傳送",
        "proxyRequestModel":
            "送給代理的模型名稱。部分 OpenAI 相容代理有自己的命名方式，請填入代理實際要求的模型 ID（例如 `gpt-4o`、`claude-3-5-sonnet-20241022`）",
        "proxyFormat":
            "反向代理使用的 Request Body 格式。\n\n- **OpenAI Compatible**：最常見，使用 OpenAI Chat Completions 格式\n- **OpenAI Responses API**：新版 Responses API（僅支援的模型可用）\n- **Anthropic**：Claude API 格式\n- **Mistral**：Mistral 原生格式\n- **Google Cloud**：Vertex／Gemini\n- **Cohere**：Cohere 原生格式\n\n請選擇代理實際接受的格式；不確定時可先從 OpenAI Compatible 開始",
        "cohereKey":
            "Cohere API 金鑰（https://dashboard.cohere.com/api-keys）。使用 Cohere 自家模型（例如 `command-r`）時需要設定",
        "ollamaURL":
            "本機或遠端 Ollama 伺服器 URL（例如 `http://localhost:11434`）。搭配 PocketRisu 的本機網路模式，可更穩定地存取區域網路內的 LLM",
        "ollamaModel":
            "要在 Ollama 伺服器呼叫的模型名稱。執行 `ollama list` 查看已安裝模型，並完整複製名稱（例如 `llama3:8b`）",
        "nanogptKey":
            "NanoGPT API 金鑰（https://nano-gpt.com）。NanoGPT 同時支援按次計費與訂閱制；若使用訂閱方案，也請啟用下方的訂閱端點選項",
        "nanoGPTUseSubscriptionEndpoint":
            "使用 NanoGPT 訂閱方案時請啟用。請求會送往訂閱端點，而不是按次計費端點，因此不會扣除預付餘額。非訂閱使用者啟用後，請求會被拒絕",
        "nanogptModelMode":
            "設定 NanoGPT 模型的選擇方式。**從清單選擇**會使用 NanoGPT 提供的熱門模型下拉清單；**手動輸入**可直接填入模型 ID，適合較冷門或剛新增的模型",
        "nanogptManualModel":
            "送給 NanoGPT 的模型 ID。請從 NanoGPT 模型清單頁面完整複製",
        "openrouterKey":
            "OpenRouter API 金鑰（https://openrouter.ai/keys）。一組金鑰即可存取多家供應商的模型，費用會從 OpenRouter 餘額扣除",
        "openrouterModel":
            "要透過 OpenRouter 呼叫的模型。模型選擇器會顯示熱門模型，可透過搜尋縮小範圍。各模型的價格與上下文長度不同，選用前請先確認模型資訊",
        "tokenizer":
            "用於計算 Token 的 Tokenizer。若與實際模型不一致，最大上下文限制與顯示的 Token 使用量可能產生偏差，因此請選擇與模型相符的 Tokenizer",
        "koboldURL":
            "Kobold／KoboldCpp 伺服器 URL（例如 `http://localhost:5001`）。需要另外啟動一個 KoboldCpp 執行個體",
        "echoMessage":
            "Echo 模型不會呼叫任何 LLM，只會原樣回傳您在此填入的內容。可用來測試 UI 流程或偵錯提示詞，而且不會消耗 Token",
        "echoDelay":
            "Echo 模型回傳回應前的延遲秒數。可用來測試串流與載入 UI 行為",
        "hordeKey":
            "AI Horde API 金鑰（https://stablehorde.net）。可匿名使用 Horde，但優先順序較低且回應較慢；設定金鑰後即可使用並累積自己帳號的 Kudos",
        "textgenBlockingURL":
            "TextGen WebUI 的同步（blocking）API 端點。WebUI 必須以 `--api` 旗標啟動（例如 `https://server.local/api/v1/generate`）",
        "textgenStreamURL":
            "TextGen WebUI 的串流 WebSocket 端點，讓回應可逐 Token 傳回。留空即可停用串流",
        "streaming":
            "即時逐 Token 顯示模型回應（僅支援串流的模型可用）。關閉後會等生成完成再一次顯示完整回應，體感上可能稍慢",
        "streamGeminiThoughts":
            "同時即時串流 Gemini 的 `thinking` Token。只有啟用串流，而且所選 Gemini 模型支援思考時才有效",
        "reverseProxyOobaMode":
            "反向代理使用 Oobabooga 風格 generate 端點時啟用。請求會改走 Ooba 處理流程，而不是 OpenAI Chat Completions",
        "textAdventureNAI":
            "以文字冒險模式呼叫 NovelAI。輸出會帶有冒險遊戲風格；只有支援此模式的 NovelAI 模型才有效",
        "appendNameNAI":
            "自動將角色／使用者人設名稱注入 NovelAI 提示詞。關閉時只會送出提示詞本體，不附加名稱",
        "customPlugin":
            "自訂模型由外掛提供。請選擇要用來生成回應的外掛；若該外掛已停用，回應會是空白",
        "maxContextSize":
            "送給模型的最大輸入 Token 數。超過模型本身的上限（例如 GPT-4o 的 128K）會發生錯誤，因此請維持在實際限制內。數值越大，輸入成本越高",
        "profileVisibilityLevel":
            "在模型目錄與更新通知中，隱藏舊版或已棄用的模型設定檔",
        "useCustomRegistry":
            "改從您自訂的模型目錄分支或衍生版本下載模型設定檔，而不使用官方模型目錄",
        "customRegistryUrl":
            "以斜線結尾的 HTTPS 基底 URL；系統會從該位置取得 index.json 與 catalog.json。留空或非 HTTPS URL 都會被拒絕",
        "maxResponseSize":
            "單次回應的最大輸出 Token。過低會截斷回應；過高會增加成本，也可能讓回應變得過於冗長。大多數情況 256–1024 即可",
        "seed":
            "用於生成可重現輸出的 Seed。相同輸入加上相同 Seed，回應通常會近似一致；可用於比較提示詞時降低隨機差異。僅 OpenAI／反向代理／OpenRouter 模型支援",
        "thinkingType":
            "Claude 思考模式。\n\n- **關閉**：不使用思考（較快、較便宜）\n- **Budget（手動 Token）**：最多使用「思考 Token」設定值進行思考\n- **Adaptive**：Claude 依工作難度自行調整思考預算（僅較新的 Claude 模型支援）",
        "thinkingTokens":
            "Budget 模式下可用於思考的最大 Token。複雜推理可提高，若要節省成本可降低；`-1` 使用模型預設值",
        "adaptiveThinkingEffort":
            "Claude 在 Adaptive 模式使用的思考強度。\n\n- **Low**：快速、簡單工作\n- **Medium**：一般用途\n- **High**：複雜推理或程式設計\n- **Max**：最高強度，同時也會增加成本與延遲",
        "topK":
            "只保留機率最高的前 K 個候選 Token。數值較低會更保守、較重複；較高會增加多樣性。約 40 是常見中間值。並非所有模型都支援",
        "minP":
            "移除機率低於最高機率 Token 某一比例的候選 Token。常見約 0.05–0.1。相較 Top P 更能依分布動態調整，因此近年較常使用",
        "topA":
            "依最高機率 Token 的平方（或其比例）動態裁切候選 Token。`0` 代表停用。NovelAI 與部分本機模型會使用此參數",
        "repetitionPenalty":
            "降低已出現 Token 再次出現的機率。`1.0` 為不懲罰；`1.1` 是常見的輕度懲罰。設太高會讓模型連自然的重複都刻意避開，使文句變得生硬",
        "reasoningEffort":
            "設定支援 `reasoning_effort` 參數的模型要投入多少推理。數值越高，通常推理會更深入，但速度較慢、成本也較高。\n\n- **-1**：最低（Minimal）\n- **0**：低（Low）\n- **1**：中（Medium）\n- **2**：高（High）",
        "verbosity":
            "部分 OpenAI 模型的回應長度控制。`0` 偏精簡，`2` 偏長篇；只有支援此參數的模型才有效",
        "promptPreprocess":
            "在主要提示詞結尾附加額外提示詞（`additionalPrompt`，預設為 \"The assistant must act as {{char}}. user is {{user}}.\"），可進一步固定角色扮演上下文。關閉時只送出原始主要提示詞",
        "usePromptTemplate":
            "使用自訂提示詞模板（設定 → 提示詞模板），取代上方四個提示詞欄位（主要／越獄／備註／順序）。模板可組合更複雜的提示詞，但學習成本也較高",
        "customFlags":
            "強制指定目前模型的能力旗標。例如模型本身沒有回報圖片輸入能力時，啟用 `hasImageInput` 會讓系統假設它支援。適合相容性修正與暫時繞過問題；若旗標設錯，請求可能失敗",
        "enableCustomFlags":
            "設定上方自訂旗標是否實際生效。關閉時仍會保留設定值，但不會套用",
        "tools":
            "允許模型在回應途中呼叫工具（搜尋、函式呼叫等）。模型本身必須支援工具呼叫",
        "searchTool":
            "允許模型在生成回應時呼叫外部搜尋工具。可提高事實準確度，但會增加 Token 使用量與延遲；模型本身必須支援工具呼叫",
        "botRegexScript":
            "只套用於此提示詞預設集的 Regex 腳本，會與全域 Regex 腳本一起執行。語法請參閱全域 Regex 腳本說明",
        "botIcon":
            "此提示詞預設集的預設圖示，與角色卡圖示獨立；會用作 assistant 訊息圖示",
        "botPromptTemplate":
            "選擇提示詞模板。相較主要／越獄／備註欄位，模板可建立更複雜的提示詞結構。只有啟用「使用提示詞模板」時才會生效",
        "personaName":
            "目前使用者人設的名稱。對話中的 `{{user}}` 變數會填入此名稱，也是角色用來稱呼您的名稱",
        "personaNote":
            "此使用者人設的備註／識別文字（只有啟用「進階 → personaNote」時顯示）。可用來區分顯示名稱相同的多個人設",
        "personaDescription":
            "使用者人設資訊。會嵌入送給模型的系統提示詞，讓模型了解使用者是誰。例如：「<user> 是一名 20 歲女性，平常說話冷靜。」",
        "personaLargePortrait":
            "Waifulike 等主題會以大型立繪取代使用者人設圖示。想顯示人設全身立繪時可使用",
        "openRouterFallback":
            "所選模型暫時不可用時，OpenRouter 會自動將請求路由至相容的備援模型，以提高可靠性。關閉後會直接顯示原始錯誤",
        "openRouterMiddleOut":
            "OpenRouter 的上下文壓縮功能。當請求超過模型的上下文上限時，會從中段移除或截短部分訊息，盡量保留前後內容，直到符合上下文限制",
        "useInstructPrompt":
            "透過 OpenRouter 送出請求時使用 instruct 格式，而不是 Chat Completions。需要直接呼叫 base／instruct 模型時可啟用",
        "chatFormating":
            "Instruct 模型使用的對話模板。模板必須符合模型訓練時使用的格式，否則回應可能異常。\n\n- **ChatML**：OpenAI／Qwen 系列（`<|im_start|>` Token）\n- **Llama2／Llama3**：Meta Llama 系列\n- **Gemma／Mistral／Vicuna／Alpaca／GPT2**：各模型官方格式\n- **Custom (Jinja)**：自行撰寫 Jinja 模板\n\n若使用反向代理或本機模型時輸出異常，請切換到該模型實際訓練使用的格式",
        "jinjaTemplate":
            "Jinja 模板原始內容。建議直接複製模型卡中的 `chat_template`。可使用 `{{ messages }}`、`{{ bos_token }}` 等處理訊息陣列。（只有選擇 `Custom (Jinja)` 時顯示。）",
        "customStopWords":
            "使用停止字串。模型回應一出現其中任一字串就會立即截斷。可用來阻止角色接著模仿下一位發言者（例如 `{{user}}: ...`）",

        "memType":
            "長期記憶模式。\n\n- **無**：停用長期記憶；只使用目前上下文範圍內的對話，超過最大上下文長度的舊訊息會被截除\n- **HypaV3**：PocketRisu 長期記憶，會自動摘要並取回較舊對話，再注入上下文。成本與延遲會略增，但長對話的一致性通常會明顯改善",
        "hypaV3SummaryModel":
            "用於摘要對話的模型。\n\n- **subModel**：使用輔助模型（最常見）\n- **Qwen3 4B/14B**：免費本機摘要（直接在瀏覽器或 Node 執行個體中執行，首次使用會下載模型）\n\n使用比主要模型更輕量的模型可降低成本",
        "hypaV3Preset":
            "HypaV3 設定預設集。可儲存與載入常用的一整組設定；切換預設集時，上方所有比例與模型選項也會一起切換",
        "embeddingOpenAIKey":
            "選擇 OpenAI Embedding 模型時使用的 API 金鑰。只有希望將 Embedding 費用與主要模型金鑰分開管理時才需要設定；留空則沿用主要 OpenAI 金鑰",
        "embeddingCustomURL":
            "自訂 Embedding 模型的 OpenAI 相容端點 URL。自架或使用開源 Embedding 伺服器時可設定",
        "embeddingCustomKey":
            "自訂 Embedding 伺服器的驗證金鑰。伺服器不需要驗證時可留空",
        "embeddingCustomModel":
            "送往自訂端點的模型名稱，必須與伺服器要求完全相同（例如 `nomic-embed-text-v1.5`）",
        "embeddingVoyageKey":
            "Voyage AI API 金鑰（https://www.voyageai.com/）。Embedding 模型設為 voyageContext3 等 Voyage 模型時需要設定",

        "ttsAutoSpeech":
            "收到角色回應後自動播放語音。行動瀏覽器可能會在背景阻擋播放；啟用後請先點選一次畫面以授予播放權限",
        "ttsElevenLabsKey":
            "ElevenLabs（https://elevenlabs.io）API 金鑰。可提供自然度很高的語音，具有少量免費額度與付費方案",
        "ttsVoicevoxUrl":
            "本機執行中的 VOICEVOX（https://voicevox.hiroshiba.jp/）引擎 URL（例如 `http://localhost:50021`），特別適合日文語音合成",
        "ttsOpenAIKey":
            "OpenAI TTS API 金鑰。可直接使用主要 OpenAI 金鑰；若希望分開追蹤 TTS 費用，也可使用另一組金鑰",
        "ttsNAIKey":
            "NovelAI 語音合成 API 金鑰，與一般 NovelAI Bearer Token 相同",
        "ttsHuggingfaceKey":
            "HuggingFace Inference API 金鑰。呼叫 HuggingFace 免費或付費 TTS 模型時需要設定",
        "ttsFishSpeechKey":
            "Fish-speech（https://fish.audio/）API 金鑰，可提供自然的多說話者語音",

        "emotionMethod":
            "用來偵測角色回應中的情緒，並選擇對應情緒立繪的方法。\n\n- **Ax 模型**：由輔助 LLM 分類情緒（準確度高，但會產生少量費用）\n- **MiniLM-L6-v2**：本機 Embedding 分類器（免費、快速，但準確度較低）\n\n仍需先在角色卡中註冊情緒資源，情緒立繪功能才能運作",

        "webuiUrl":
            "AUTOMATIC1111 或相容 WebUI 的 URL（例如 `http://localhost:7860`）。WebUI 必須以 `--api` 旗標啟動",
        "webuiSteps":
            "取樣步數。常見為 20–50；增加步數通常只能小幅提升品質，但生成時間會近似線性增加。（0–100）",
        "webuiCFG":
            "提示詞遵循強度（CFG）。數值低時模型解讀較自由，數值高時更強制貼近提示詞；約 7 是常見中間值。（0–20）",
        "webuiWidth":
            "圖片寬度（像素）。SDXL 可用 1024 作為基準，SD1.5 可用 512；非標準解析度可能降低品質",
        "webuiHeight":
            "圖片高度（像素）。SDXL 可用 1024 作為基準，SD1.5 可用 512；非標準解析度可能降低品質",
        "webuiSampler":
            "Sampler 名稱。請填入 WebUI 實際支援的完整名稱（例如 `Euler a`、`DPM++ 2M Karras`）",
        "webuiEnableHr":
            "啟用 Hires fix。先以較低解析度生成，再放大並重新去噪以增加細節，生成時間大約會加倍",
        "webuiDenoising":
            "Hires fix 重新去噪的強度。數值較低會更接近原圖；較高會增加細節，但也更容易偏離原圖。常見範圍約 0.4–0.6",
        "webuiHrScale":
            "Hires fix 使用的放大倍率（例如 2 = 2×）。記憶體用量與生成時間會隨倍率增加",
        "webuiUpscaler":
            "Upscaler 名稱（例如 `Latent`、`R-ESRGAN 4x+`、`4x-UltraSharp`）。請使用 WebUI 設定中實際可用的名稱",

        "naiImgUrl":
            "NovelAI 圖片生成端點。通常不需要更改預設值；留空即可使用預設端點",
        "naiImgKey":
            "NovelAI Bearer Token，與文字模型使用的 Token 相同",
        "naiModel":
            "要使用的 NovelAI 圖片模型。較新的模型通常畫質更好，但會消耗稍多 Anlas（由您的訂閱方案扣除）",
        "naiWidth":
            "圖片寬度。NAI 建議使用 832×1216 等預先定義的解析度",
        "naiHeight":
            "圖片高度。NAI 建議使用 832×1216 等預先定義的解析度",
        "naiSampler":
            "所選模型支援的 Sampler。各模型建議的 Sampler 請參考 NovelAI 官方說明",
        "naiNoiseSchedule":
            "Noise Schedule。大多數設定使用 `native`（模型建議）或 `karras`；其他選項需確認模型是否相容",
        "naiSteps":
            "取樣步數。NAI 建議約 28；大幅提高通常只會增加 Anlas 成本",
        "naiCFG":
            "提示詞遵循強度（CFG）。NAI 常見為 5–7，但建議值會依模型而不同",
        "naiCFGRescale":
            "CFG Rescale 修正。0 代表停用；常見為 0.5–0.7，可改善部分模型的顏色與對比",
        "naiImageReference":
            "圖片參考模式。\n\n- **無**：只使用文字\n- **Vibe Transfer**：借用參考圖片的整體氛圍\n- **Character Reference**：參考圖片中的角色特徵（僅 NAI Diffusion 4–5）",
        "naiVibeModel":
            "用來擷取 Vibe Transfer 編碼的 NAI 模型。通常選擇與實際生成相同的模型",
        "naiInfoExtracted":
            "設定要從參考圖片擷取哪類資訊（整體氛圍／只取顏色／構圖等）",
        "naiRefStrength":
            "參考強度。低值只會輕微借用，高值會更接近原圖；一般建議介於 0.5–0.8",
        "naiStyleAware":
            "Style-aware 模式。搭配 Character Reference 時，會更強調參考角色的畫風",
        "naiUseSMEA":
            "使用 SMEA（Smea）取樣，可改善部分 NAI 模型的細節",
        "naiUseDYN":
            "使用 Dynamic Thresholding（DYN），有助於平衡顏色與曝光",
        "naiVarietyPlus":
            "Variety+ 模式。相同提示詞下會生成更多樣化的結果",
        "naiDecrisp":
            "Decrisp 模式。降低過度銳利感，效果會依模型而不同",
        "naiLegacyUC":
            "使用舊版 unconditional（負面提示詞）處理方式。只對 NAI Diffusion 4 full／curated 模型有效",
        "naiEnableI2I":
            "啟用 Image-to-Image，依參考圖片生成變體",

        "dalleKey":
            "DALL·E 使用的 OpenAI API 金鑰，可直接使用文字模型的同一組金鑰",
        "dalleQuality":
            "圖片品質（`standard`／`hd`）。HD 成本約高 2 倍",

        "stabilityKey":
            "Stability Platform API 金鑰（https://platform.stability.ai/）",
        "stabilityModel":
            "要使用的 Stability 模型（`ultra`／`core`／`sd3-large`／`sd3-medium`）。Ultra 成本最高、品質也最高；Core 較快且便宜",
        "stabilityCoreStyle":
            "SD Core 模型的風格預設（Photographic／Anime／3D Model 等）。其他模型會忽略此設定",

        "comfyUrl":
            "本機 ComfyUI 伺服器 URL（例如 `http://localhost:8188`）",
        "comfyTimeout":
            "等待 ComfyUI 回應的最長秒數。複雜 Workflow 可設定較長時間。（1–120）",

        "falKey":
            "Fal.ai API 金鑰（https://fal.ai/dashboard/keys），用於呼叫 Flux 模型",
        "falWidth":
            "建議的 Flux 圖片寬度。概念與 SDXL 類似，建議使用 1024×1024 或 16:9 等常見比例",
        "falHeight":
            "建議的 Flux 圖片高度。概念與 SDXL 類似，建議使用 1024×1024 或 16:9 等常見比例",
        "falModel":
            "要使用的 Flux 版本。**dev** = 標準、**dev+lora** = 套用 LoRA、**pro** = 高品質、**schnell** = 快速且便宜",
        "falLoraWeight":
            "LoRA 套用強度。0 = 不套用，1 = 完整套用；高於 1.2 時結果較容易失真",

        "imagenKey":
            "Google AI Studio API 金鑰，可直接使用主要 Gemini 的同一組金鑰",
        "imagenModel":
            "要使用的 Imagen 模型（第 3／4 版等）。較新版本通常能生成更高品質的圖片",
        "imagenImageSize":
            "1K／2K。2K 成本較高，而且只有部分模型支援",
        "imagenAspectRatio":
            "1:1、4:3、16:9 等比例。若使用模型不建議的比例，品質可能下降",
        "imagenPersonGeneration":
            "人物生成政策。\n\n- **allow_all**：允許所有人物\n- **allow_adult**：只允許成年人\n- **dont_allow**：不允許人物\n\n不符合政策的提示詞可能會被拒絕",

        "oaiImgUrl":
            "OpenAI 相容圖片 API 的 URL，必須使用標準路徑，例如 `/v1/images/generations`",
        "oaiImgKey":
            "API 金鑰。若伺服器不需要驗證，可在此填入任意值",
        "oaiImgModel":
            "伺服器註冊的圖片模型名稱，必須與伺服器要求完全一致",
        "oaiImgSize":
            "圖片尺寸。只有伺服器支援的尺寸才可使用",
        "oaiImgQuality":
            "品質選項。只有伺服器支援 `quality` 參數時才有效",

        "waveKey":
            "WaveSpeed.ai API 金鑰（https://wavespeed.ai/）。WaveSpeed 是速度快、成本低的圖片生成路由服務",
        "waveModel":
            "要使用的 WaveSpeed 模型。可按上方「重新整理模型」更新可用清單，再用搜尋框縮小範圍",
        "waveLoras":
            "最多可設定 3 組 LoRA URL 與權重。只有模型支援 LoRA 時才會套用",
        "waveImageReference":
            "參考圖片模式（無／上傳／使用角色圖片）。只有模型支援圖片輸入時才有效",

        "bootBackupReminder":
            "啟用後，每次啟動 PocketRisu 都會先詢問是否立即建立伺服器備份，可作為每次使用前的簡易安全措施。確認後會執行完整伺服器備份，載入畫面會等待備份完成；略過則直接進入應用程式",
}
