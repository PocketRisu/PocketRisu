/**
 * PocketRisu NodeOnly — English help texts (`language.help`).
 *
 * Extracted from `src/lang/en.ts` for maintainability. See
 * `.agent/notes/help-audit/` (workspace) for the audit, structure rationale,
 * and the `scripts/check-help-keys.mjs` validator.
 *
 * Convention: keep this object as the canonical source of help-text keys.
 * Other locales (e.g. `help.ko.ts`) override entries by key; the merge happens
 * via `lodash/merge` in `src/lang/index.ts`.
 */

export const helpEn = {
        model: "Model option is a main model used in chat.",
        submodel: "Auxiliary Model is a model that used in analyzing emotion images and auto suggestions and etc. gpt3.5 is recommended.",
        oaiapikey: "API key for OpenAI. you can get it in https://platform.openai.com/account/api-keys",
        mainprompt: "The main prompt option sets the default model behavior.",
        jailbreak: "The jailbreak prompt option activates when jailbreak toggle is on in character.",
        globalNote: "A note that strongly affects model behavior, also known as UJB. Works in all characters.",
        autoSuggest: "Prompts used to generate options when automatically suggesting user responses.",
        formatOrder: "formating order of prompt. lower blocks does more effect to the model.",
        forceUrl: "if it is not blank, the request will go to the url that you had inputed.",
        tempature:
            "lower values make character follow prompts closely, but it will more likely to response like a machine.\nHigher values will result in creative behavior, but the character's response can break down more easily.",
        frequencyPenalty: "Higher values prevent the use of duplicate words in response, but character's response can break down more easily.",
        presensePenalty: "Higher values prevent the use of duplicate words in all context, but character's response can break down more easily.",
        sdProvider: "provider for image generation.",
        msgSound: "Plays *ding* sound when character responses",
        charDesc: "Brief description of the character. This affects characters response.",
        charFirstMessage: "First message of the character. This highly affects characters response.",
        charNote: "A note that strongly affects model behavior. Embbedded to current character, also known as UJB.",
        toggleNsfw: "toggles jailbreak prompt on and off.",
        lorebook: "Lorebook is a user-made dictionary for AI. AI only sees it when where is an activation keys in the context.",
        loreName: "Name of the lore. It doesn't affect the Ai.",
        loreActivationKey: "If one of the activation key exists in context, the lore will be activated and prompt will go in. seperated by commas.",
        loreorder: "If insert Order is higher, it will effect the model more, and it will more lessly cuted when activated lore are many.",
        bias: "bias is a key-value data which modifies the likelihood of string appearing.\nit can be -100 to 100, higher values will be more likely to appear, and lower values will be more unlikely to appear. \nAdditionaly, if its set to -101, it would work as 'strong ban word' for some models. \nWarning: if the tokenizer is wrong, it not work properly.",
        emotion:
            "Emotion Images option shows image depending at character's emotion which is analized by character's response. you must input emotion name as words *(like joy, happy, fear and etc.)* .emotion named **neutral** will be default emotion if it exists. must be more then 3 images to work properly.",
        imggen: "After analyzing the chat, apply the prompt to {{slot}}.",
        regexScript:
            "Regex Script is a custom regex that replaces string that matches IN to OUT.\n\nThere four type options." +
            "\n\n- **Modify Input** modifies user's input" +
            "\n\n- **Modify Output** modifies character's output" +
            "\n\n- **Modify Request Data** modifies current chat data when sent." +
            "\n\n- **Modify Display** just modifies the text when shown without modifying chat data." +
            "\n\nIN must be a regex without flags and without slashes in start and end.\n\nOUT is a string which can include replacement patterns. these are the patterns:" +
            "\n\n- $$\n\n    - inserts $" +
            "\n\n- $&\n\n    - inserts the matched substring." +
            "\n\n- $`\n\n    - inserts the portion of the string that precedes the matched substring." +
            "\n\n- $1\n\n    - inserts the first matching group. works with other number like 2, 3..." +
            "\n\n- $(name)\n\n    - inserts the named group" +
            "\n\nFor flags, you can not only use native supported flags, but also use these flags, which are designed for advanced users:" +
            "\n\n- `<inject>` - injects the result to the current string." +
            "\n- `<move_top>` - moves the result to the top of the string." +
            "\n- `<move_bottom>` - moves the result to the bottom of the string." +
            "\n- `<repeat_back>` - if the match is not found, it carries the result from the previous match." +
            "\n- `<order n>` - sets the order of the result. higher order will be shown first. `n` is a number. (like `<order 1>`) if this flag is not set, it will be set to 0." +
            "\n- `<cbs>` - parses curly braced synatxes in IN." +
            "\n\nTo use with native flags, you can use like `gi<cbs><move_top>`.",
        experimental: "This is a experimental feature. it might be unstable.",
        oogaboogaURL:
            "If your WebUI supports older version of api, your url should look *like https:.../run/textgen*\n\n" +
            "If your WebUI supports newVersion of api, your url should look like *https://.../api/v1/generate* and use the api server as host, and add --api to arguments.",
        exampleMessage:
            "Example conversations that affects output of the character. It doesn't uses tokens permanently." +
            "\n\nExample format of conversations:" +
            "\n\n```\n<START>\n{{user}}: hi\n{{char}}: hello\n<START>\n{{user}}: hi\nHaruhi: hello\n```" +
            "\n\n```<START>``` Marks the beginning of a new conversation.",
        creatorQuotes: "Note that appearances on top of first message. Used to inform users about this character. It doesn't go into prompt.",
        systemPrompt: "A prompt that replaces main prompt in settings if its not blank.",
        chatNote: "A note that strongly affects model behavior. Embbedded to current chat, also known as memory or UJB.",
        personality: "A brief description about character's personality. \n\n**It is not recommended to use this option. Describe it in character description instead.**",
        scenario: "A brief description about character's scenario. \n\n**It is not recommended to use this option. Describe it in character description instead.**",
        utilityBot: "When activated, it ignores main prompt, jailbreak and other prompts. used for bot made for utility, not for roleplay.",
        loreSelective: "If Selective mode is toggled, both Activation Key and Secondary key should have a match to activate the lore.",
        loreRandomActivation:
            "If Use Probability Condition is abled, if the lore's other conditions are all met, the lore will be activated with a set probability which is set by 'Probability' each time a chat is sent.",
        additionalAssets:
            "Additional assets to display in your chat. \n\n - use `{{raw::<asset name>}}` to use as path.\n - use `{{image::<asset name>}}` to use as image\n - use `{{video::<asset name>}}` to use as video\n - use `{{audio::<asset name>}}` to use as audio\n    - recommended to put in Background HTML",
        replaceGlobalNote: "If its not blank, it replaces current global note to this.",
        backgroundHTML:
            "A Markdown/HTML Data that would be injected to the background of chat screen.\n\n you can also use additional assets. for example, you can use `{{audio::<asset name}}` for background music." +
            "\n\n Additionaly, you can use these with additional assets:" +
            "\n - `{{bg::<asset name>}}`: inject the background as asset",
        additionalText: "The text that would be added to Character Description only when ai thinks its needed, so you can put long texts here. seperate with double newlines.",
        charjs: "A javascript code that would run with character. for example, you can check `https://github.com/kwaroran/Risuai/blob/main/src/etc/example-char.js` CURRENTLY NOT RECOMMENDED TO USE DUDE TO SECURITY REASONS. EXPORTING WOULD NOT INCLUDE THIS.",
        romanizer:
            "Romanizer is a plugin that converts non-roman characters to roman characters to reduce tokens when using non-roman characters while requesting data. this can result diffrent output from the original model. it is not recommended to use this plugin when using roman characters on chat.",
        inlayImages: "If enabled, images could be inlayed to the chat and AIs can see it if they support it.",
        metrica:
            "Metric Systemizer is a plugin that converts metrics to imperial units when request, and vice versa on output to show user metric system while using imperial for performace. it is not recommended to use this plugin when using imperial units on chat.",
        topP: "Top P is a probability threshold for nucleus sampling. model considers the results of the tokens with top_p probability mass.",
        openAIFixer: "OpenAI Fixer is a plugin that fixes some of the problems of OpenAI.",
        sayNothing: "If enabled, it will input 'say nothing' when no string inputed.",
        showUnrecommended: "If enabled, it will show unrecommended, deprecated settings. it is NOT RECOMMENDED to use these settings.",
        allowV2Plugin: "Warning: This enables deprecated V2.0 plugin execution. V2.0 plugins bypass the V2.1 safety check and may be unsafe. Leave this disabled unless you explicitly trust the plugin and cannot migrate it to V3 yet.",
        imageCompression: "If enabled, it will compress images when exporting character. if animated images doesn't works, try disabling this option.",
        inlayImageLossless: "If enabled, inlay images will be saved as lossless PNG instead of compressed WebP. This preserves original quality but uses significantly more storage.",
        inlayImagePriority: "If enabled, inlays render as images first for faster loading. Video/audio inlays auto-switch after image load fails. Disable if you use many video/audio inlays.",
        modelModeLock: "Choose how chats pick their model system. Lock everything to the legacy model system or to the model preset binding system, or leave it unlocked so each chat decides.",
        newChatModelMode: "Which model system new chats start in when the mode is not locked.",
        showModelInSidebar: "Show the current AI model name in the sidebar for quick reference.",
        showPresetInSidebar: "Show the active prompt preset name in the sidebar for quick reference.",
        showPersonaInSidebar: "Show the active persona name in the sidebar for quick reference.",
        disableMobileDragDrop: "Disable drag-and-drop for chat reordering on mobile devices. Enable this if you experience accidental drags while scrolling.",
        disableToggleBinding: "Disable the toggle binding feature that pins toggle values to individual chats. When disabled, the bind/save/preset buttons are hidden and previously bound values are not restored on chat switch.",
        useExperimental: "If enabled, it will show some experimental features.",
        forceProxyAsOpenAI: "If enabled, it will force to use OpenAI format when using reverse proxy.",
        forcePlainFetch: "If enabled, it will use the browser Fetch API instead of the native HTTP request. This can cause CORS errors.",
        autoFillRequestURL: "If enabled, it will automatically fill the request URL to match the current model.",
        localNetworkModeDesc: "Routes private/LAN model URLs through the local server instead of browser direct fetch.\n\n**Purpose**\n- Avoid browser private-network/CORS restrictions\n- Mitigate timeout risk for slow first-token local inference\n\n**How it works**\n- Streaming uses experimental Job+WebSocket relay first (fallback to /proxy2)\n- Non-streaming uses /proxy2 relay\n\n**Constraints**\n- Scope is OpenAI-compatible request paths only",
        chainOfThought: "If enabled, it will add chain of thought prompt to the prompt.",
        gptVisionQuality: "This option is used to set the quality of the image detection model. the higher the quality, the more accurate the detection, but more tokens are used.",
        genTimes:
            "This option is used to set the number of responses to generate on support models. other then first response will be act as cached reroll. this can reduce the cost of the model, but it can also increase the cost if you use it without reroll.",
        requestretrys: "This option is used to set the number of request retrys when request fails.",
        emotionPrompt: "This option is used to set the prompt that is used to detect emotion. if it is blank, it will use the default prompt.",
        additionalParams:
            'Additional parameters that would be added to the request body. if you want to exclude some parameters, you can put `{{none}}` to the value. if you want to add a header instead of body, you can put `header::` in front of the key like `header::Authorization`. if you want value as json, you can put `json::` in front of the value like `json::{"key":"value"}`. otherwise, type of the value would be determined automatically.',
        antiClaudeOverload:
            "If Claude overload happens, PocketRisu would try to prevent it by continuing with same prompt, making it less likely to happen. works only for streamed responses. this could not work for non-official api endpoints.",
        triggerScript:
            'Trigger Script is a custom script that runs when a condition is met. it can be used to modify the chat data, run a command, change variable, and etc. the type depends when it is triggered. it can also be run by buttons, which can be used with {{button::Display::TriggerName}}, or HTML buttons with `risu-trigger="<TriggerName>"` attribute.',
        autoContinueChat: "If enabled, it will try to continue the chat if it doesn't ends with a punctuation. DONT USE THIS WITH LANGUAGES THAT DOESN'T USE PUNCTUATION.",
        combineTranslation:
            "If enabled, text that is one sentence but separated by HTML tags will be combined together and translated, then Modify Display script will be reapplied to the translated output.\nThis helps the translator to make the correct translation.\nIf the UI becomes weird when you enable this option, please turn off the option and report it.",
        dynamicAssets:
            "If enabled, if the asset name is not found when processing data, it will try to find the closest asset name by using vector search and replace it with the closest asset name.",
        dynamicAssetsEditDisplay: "If enabled, the dynamic assets will be applied to the Modify Display stage too. however, this can cause performance issues.",
        nickname: "Nickname would used be in {{char}} or <char> in chat instead of character's name if it is set.",
        useRegexLorebook: "If enabled, it will use regex for lorebook search, instead of string matching. it uses /regex/flags format.",
        customChainOfThought: "Warning: chain of thought toggle is no longer recommended to use. put chain of thought prompt in other prompt entries instead.",
        customPromptTemplateToggle:
            "Here you can define your own prompt toggles. use `<toggle variable>=<toggle name>` format, seperated by newline. for example, `cot=Toggle COT`. you can use these toggles in prompt by using `{{getglobalvar::toggle_<toggle variable>}}`. like `{{getglobalvar::toggle_cot}}`.",
        defaultVariables:
            "Here you can define your own default variables. use `<variable name>=<variable value>` format, seperated by newline. for example, `name=PocketRisu`, which then can be used with trigger scripts and variables CBS like `{{getvar::A}}`, `{{setvar::A::B}}` or `{{? $A + 1}}`. if prompt template's default variable and character's default variable has same name, character's default variable will be used.",
        lowLevelAccess:
            "If enabled, it will enable access to features that requires high computing powers and executing AI model via triggers in the character. do not enable this unless you really need these features.",
        triggerLLMPrompt:
            "A prompt that would be sent to the model. you can use multi turns and roles by using `@@role user`, `@@role system`, `@@role assistant`. for example, \n```\n@@role system\nrespond as hello\n@@role assistant\nhello\n@@role user\nhi\n```",
        legacyTranslation:
            "If enabled, it will use the old translation method, which preprocess markdown and quotes before translations instead of postprocessing after translations.",
        luaHelp:
            "You can use Lua scripts as a trigger script. you can define onInput, onOutput, onStart functions. onInput is called when user sends a message, onOutput is called when character sends a message, onStart is called when the chat starts. for more information, see the documentation.",
        claudeCachingExperimental:
            "Caching in Claude is experimental feature that can reduce the cost of the model, but it can also increase the cost if you use it without reroll. since this is a experimental feature, it can be unstable and behavior can be changed in the future.",
        urllora:
            "You can use direct download link of the model file. you can make direct url from google drive like website like https://sites.google.com/site/gdocs2direct/ , or use civitai URL, copy the the AIR (looks like `urn:air:flux1:lora:civitai:180891@776656` or just `civitai:180891@776656`) and paste it.",
        v2GetAlertSelect: "Options are separated by | (pipe) character.",
        v2RegexTest: "Returns 1 if the regex matches, 0 if it doesn't match.",
        v2Calculate:
            "Evaluates mathematical expressions with support for basic arithmetic (+, -, *, /, %, ^), comparison operators (<, >, <=, >=, =, !=), logical operators (&&, ||, !), parentheses for precedence, and variable substitution using $variableName format. Variables are automatically converted to numbers (defaults to 0 if invalid).",
        namespace:
            "Namespace is a unique identifier for the module. it is used to prevent conflicts between modules, and for interaction of presets, other modules and etc. if you are not sure what to put, leave it blank.",
        moduleIntergration:
            "You can enable modules by putting the module namespace in the module intergartion sections. if you want to enable multiple modules, you can seperate them by comma. for example, `module1,module2,module3`. this is for advanced users, who wants to vary the use of modules by presets.",
        customCSS: "Custom CSS for styling.",
        betaMobileGUI: "If enabled, it will use beta mobile GUI on small (less than 800px) screens. requires refresh.",
        enableScrollToActiveChar: "If enabled, pressing the hotkey or holding Ctrl while dragging a character will scroll to the currently active character. Folders will be opened automatically if closed.",
        unrecommended: "This is a unrecommended setting. it is not recommended to use this setting.",
        jsonSchema:
            "This is a JSON Schema that will be sent to the AI model if AI model supports JSON Schema.\n\nHowever, since JSON Schema is hard to learn, In PocketRisu, you can use subset of TypeScript interface instead of JSON Schema. PocketRisu will convert it in runtime." +
            'For example, if you want to send a JSON like this:\n\n```js\n{\n  "name": "PocketRisu", //name must be PocketRisu,\n  "age": 1, //age must be number,\n  "icon": "slim", //icon must be \'slim\' or \'rounded\'\n  "thoughts": ["Good View!", "Lorem"] //thoughts must be array of strings\n}\n```\n\n' +
            "You can put this TypeScript interface:\n\n```typescript\ninterface Schema {\n  name: string;\n  age: number;\n  icon: 'slim'|'rounded'\n  thoughts: string[]\n}\n```\n\n" +
            "Name of the interface doesn't matter. for more information, see the typescript documentation. (https://www.typescriptlang.org/docs/handbook/interfaces.html), and to Check what subset of TypeScript is supported, see the below." +
            "<details><summary>Supported TypeScript Subset</summary>\n\n" +
            `Supported types are \`boolean\`, \`number\`, \`string\`, \`Array\`. Advanced typing like unit types, intersection types, union types, optional, literal types, and etc. are not supported except for these cases:\n
        - Array of primitive types: (ex. \`string[]\`, \`Array<boolean>)\`
        - Unit types between strings: (ex. \`'slim'|'rounded'\`).

        Properties must be one in a line. if there is multiple properties in a line, it will throw an error. Properties and name of the interface must be only in latin characters, in ASCII range. name of the properties must not be surrounded by quotes or double quotes. Nesting inside the interface is not supported. it is not allowed to put \`{\` or \`}\` in the line that properties are defined. If you want to use more advanced types, use JSON Schema instead.
        ` +
            "</details>",
        strictJsonSchema: "If enabled, it will strictly follow the Provided Schema for JSON on some models. if it is disabled, it may ignore the JSON Schema.",
        extractJson:
            'If it is not blank, it will extract specific JSON data from the response. for example, if you want to extract `response.text[0]` in response `{"response": {"text": ["hello"]}}`, you can put `response.text.0`.',
        translatorNote:
            "Here, you can add a unique translation prompt for each character. This option only applies when using the Ax. model for translation. To apply it, include `{{slot::tnote}}` in the language settings. It doesn't work in group chats.",
        groupInnerFormat:
            "This defines a format that is used in group chat for characters that isn't speaker. if it is not blank, it will use this format instead of the default format. if `Group Other Bot Role` is `assistant`, it will also be applied to the speaker.",
        chatHTML: "A HTML that would be inserted as each chat.",
        systemContentReplacement: "The prompt format that replaces system prompt if the model doesn't support system prompt.",
        systemRoleReplacement: "The role that replaces system role if the model doesn't support system role.",
        summarizationPrompt:
            "The prompt that is used for summarization. if it is blank, it will use the default prompt. you can also use ChatML formating with {{slot}} for the chat data. The summary output is split by double newlines (\\n\\n) into chunks for similarity search.",
        translatorPrompt:
            "The prompt that is used for translation. if it is blank, it will use the default prompt. you can also use ChatML formating with {{slot}} for the dest language, {{solt::content}} for the content, and {{slot::tnote}} for the translator note.",
        translateBeforeHTMLFormatting:
            "If enabled, it will translate the text before Regex scripts and HTML formatting. this could make the token lesser but could break the formatting.",
        autoTranslateCachedOnly: "If enabled with Auto Translation option on, it will automatically translate only the messages that the user has translated previously.",
        presetChain:
            "If it is not blank, the preset will be changed and applied randomly every time when user sends a message in the preset list in this input. preset list should be seperated by comma, for example, `preset1,preset2`.",
        legacyMediaFindings: "If enabled, it will use the old method to find media assets, without using the additional search algorithm.",
        comfyWorkflow:
            "Put the API workflow of comfy UI. you can get your API workflow in comfy UI by pressing the 'Workflow > Export (API)' button. you must also put {{risu_prompt}} in you workflow text. the {{risu_prompt}} will be replaced with the prompt provided by the Risu.",
        automaticCachePoint: "Automatically creates cache point after the chat ends, if the caching point doesn't exist.",
        experimentalChatCompressionDesc:
            "Compresses the unused chat data and saves in seperate file. this greatly reduces the size of the chat data, and greatly improves the performance, however its experimental and can be unstable, causing issues in backup feature and more.",
        promptInfoInsideChatDesc:
            "When enabled, this stores prompt preset information in the chat metadata. The stored data includes the preset name, active toggles, and the prompt text. This may slightly increase processing time and storage usage.",
        autoAdjustSchema: "When enabled, it will automatically adjust the JSON schema for Dynamic Output.",
        dynamicMessages: "When enabled, it will allow the assistant to send multiple messages in a row, instead of one at a time.",
        dynamicMemory: "When enabled, assistant will make memory notes on response time. additional prompting is required to utilize this feature.",
        dynamicResponseTiming: "When enabled, it will adjust the response timing dynamically.",
        dynamicRequest: "When enabled, it will request to model at random timing without waiting for user input.",
        settingsCloseButtonSize: "Size of the settings close button.",
        showTypingEffect: "When enabled, it will show a typing indicator while the assistant is generating a response.",
        dynamicOutputPrompt: "When enabled, the schema information will be included in the request.",
        realmDirectOpen: "If enabled, clicking a character in RisuRealm preview will directly open the character description.",
        openRouterProviderOrder:
            "The order of providers to use, the first provider will be used first, if the provider is not available, it will use the next provider. See datail on https://openrouter.ai/docs/guides/routing/provider-selection#ordering-specific-providers",
        openRouterProviderOnly:
            "Only use the providers in this list, if all the provider is not available, the request will failed. See detail on https://openrouter.ai/docs/guides/routing/provider-selection#allowing-only-specific-providers",
        openRouterProviderIgnore:
            "Ignore the providers in this list, if all the provider is ingored, the request will failed. See detail on https://openrouter.ai/docs/guides/routing/provider-selection#ignoring-providers",
        additionalPrompt:
            "Text that gets appended to the Main Prompt when Prompt Preprocess is enabled. Default is 'The assistant must act as {{char}}. user is {{user}}.' This helps set up basic roleplay context.",
        hideAllImagesDesc: "Hides bot icons, bot image assets, and RisuRealm cover images.",
        hideMessagePageCountDesc: "Hides the page counter (e.g. 1/3) for regenerated messages and first message greetings. Navigation arrows and the regenerate button remain visible.",
        embedding:
            "Embedding model is used for similarity search across multiple features:\n\n" +
            "- **Long Term Memory**: HypaV2, HypaV3, Hanurai Memory, and SupaMemory (with HypaMemory enabled)\n" +
            "- **Additional Text**: Matching character additional info based on context\n" +
            "- **Dynamic Assets**: Finding similar asset names when exact match is not found\n" +
            "- **Trigger Scripts**: Similarity conditions in trigger scripts\n" +
            "- **File Attachments**: Searching within PDF/TXT/XML attachments",
        keepSessionAlive:
            "Keeps the tab active and prevents the session from expiring due to inactivity in browsers. This may require refresh to take effect.\n\n" +
            "- **Via Sound**: Plays a silent audio at regular intervals to keep the session alive. This method is known as most compatible and effective in most browsers.\n",
        reSummarizationPrompt:
            "The prompt used when merging multiple selected summaries into one via bulk edit. If blank, the default prompt is used. The summary output is split by double newlines (\\n\\n) into chunks for similarity search.",
        hypaV3MemoryTokensRatio:
            "The fraction of the max context size allocated to the long-term memory block {{slot}} in the prompt.",
        hypaV3ExtraSummarizationRatio:
            "Lowers the threshold at which summarization stops. At 0, summarization stops as soon as tokens fall below the max context. Higher values cause more summarization before stopping.",
        hypaV3MaxChatsPerSummary:
            "Maximum number of chat messages to include when creating a single summary.",
        hypaV3RecentMemoryRatio:
            "The fraction of memory tokens allocated to recent memory. Automatically filled with the most recently created summaries until the allocated tokens are full.",
        hypaV3SimilarMemoryRatio:
            "The fraction of memory tokens allocated to similar memory. Automatically filled with summaries that have the highest similarity scores to recent chats until the allocated tokens are full.",
        hypaV3RandomMemoryRatio:
            "Randomly filled from summaries not already selected by other categories.",
        hypaV3PreserveOrphanedMemory:
            "If enabled, summaries that reference deleted chat messages will be preserved. If disabled, summaries whose source messages no longer exist are automatically removed.",
        hypaV3ProcessRegexScript:
            "If enabled, regex scripts will be applied to the input chat messages when regenerating summaries in the HypaV3 modal.",
        hypaV3DoNotSummarizeUserMessage:
            "If enabled, user messages are excluded from the max messages per summary count.",
        hypaV3EnableSimilarityCorrection:
            "If enabled, a summary of recent chats is additionally used as a query. Does not work with the experimental HypaMemory V3.",
        hypaV3UseExperimentalImpl:
            "Switches to the experimental HypaMemory V3 implementation. Enables rate limit settings and changes the query method.",
        hypaV3AlwaysToggleOn:
            "If enabled, the HypaMemory toggle is automatically activated when selecting a character.",
        toggleHypaMemory:
            "Whether to use HypaMemory (long-term memory) for this chat.\n\n" +
            "- When on, past messages are automatically summarized into long-term memory once the context fills up, and relevant summaries are pulled back into later responses.\n" +
            "- When off, messages beyond the context window are simply truncated and never reach the model.\n\n" +
            "This setting is stored per-chat (independent of the character default), so other chats with the same character are unaffected. Tune the summarization behavior itself under HypaV3 in the preset.",
        useModelPresetBinding:
            "Bind a model preset to this chat.\n\n" +
            "On : Use a model preset, binding a model per chat.\n" +
            "Off : Use the existing chatbot settings. (default)",
        hypaV3SummarizationRequestsPerMinute:
            "Maximum summarization model requests per minute. Only applies when the summarization model is set to Auxiliary Model.",
        hypaV3SummarizationMaxConcurrent:
            "Maximum concurrent summarization model requests. Only applies when the summarization model is set to Auxiliary Model.",
        hypaV3EmbeddingRequestsPerMinute:
            "Maximum embedding model requests per minute for similarity search.",
        hypaV3EmbeddingMaxConcurrent:
            "Maximum concurrent embedding model requests for similarity search.",
        hypaV3QueryChatCount:
            "The number of recent chat messages used as the query for similarity search. " +
            "Higher values use more chat context to determine similarity.",
        nodeOnlyScrollButtonType: "How the chat scroll buttons are shown. 4 Buttons adds jump-to-top and jump-to-bottom controls; 2 Buttons keeps only previous/next message navigation; Off hides them.",
        confirmReroll: "Ask for confirmation before regenerating a message.",
        sendWithEnter: "Send the message with Enter.",
        sendKeyPC: "Which key sends a message on desktop.",
        sendKeyMobile: "How messages are sent on mobile.",
        fixedChatTextarea: "Pin the chat input to the bottom of the screen so it stays in place while scrolling.",
        clickToEdit: "Enter edit mode immediately when clicking a chat message.",
        enableBlockPartialEdit: "Show per-block edit controls when hovering over a paragraph/block in a message.",
        longPressToPopupEditor: "Open the popup editor when long-pressing a message.",
        enableDragPartialEdit: "Allow editing only the text selected by dragging inside a message.",
        botSettingAtStart: "Open the bot settings page automatically whenever the app starts.",
        showMenuChatList: "Show the current character's chat list directly in the sidebar menu.",
        showMenuHypaMemoryModal: "Show a sidebar button that opens the HypaMemory (HypaV3) management modal.",
        goCharacterOnImport: "After importing a character card, switch to that character automatically.",
        sideMenuRerollButton: "Show a regenerate/reroll button in the chat side menu.",
        localActivationInGlobalLorebook:
            "Allow global lorebooks to use local activation options such as activating only for the current character.",
        requestInfoInsideChat: "Allow LLM request information such as sent prompts and token counts to be displayed inside the chat area.",
        inlayErrorResponse: "When a model request fails, show the error as an inlaid chat response.",
        bulkEnabling: "Show buttons in the lorebook editor for enabling or disabling multiple entries at once.",
        showTranslationLoading: "Show a loading indicator while message translation is in progress.",
        autoScrollToNewMessage: "Automatically scroll to a newly arrived message.",
        alwaysScrollToNewMessage: "Always scroll down when a new message arrives, even if you have manually scrolled upward.",
        newMessageButtonStyle: "Choose where and how the \"new message\" button appears.",
        createFolderOnBranch:
            "Automatically create a folder when branching a chat, grouping the original and branched chats together.",
        hamburgerButtonBottom: "Move the hamburger/menu button to the bottom of the sidebar.",
        hideLeftBarCollapseButton: "Hide the toggle button that collapses the left character grid bar on narrow screens (under 400px).",
        loreBookDepth:
            "Number of previous messages to scan for lorebook activation keywords. `0` disables scanning; higher values can find older keywords but may activate unnecessary lore. (0-20)",
        loreBookToken:
            "Maximum number of tokens lorebook entries may occupy in one response. When the limit is exceeded, lower-priority entries are cut first. (0-4096)",
        autoContinueMinTokens:
            "Minimum token count for Auto Continue Chat. Responses shorter than this value will not trigger automatic continuation.",
        descriptionPrefix:
            "Prefix string added before the character description when sending it to the model. Leave blank to use the default. Change this only if you need a custom header or formatting style.",
        assetMaxDifference:
            "Allowed difference when matching dynamic asset names. Higher values match more loosely, but may pick the wrong asset. The default is usually best.",
        heightMode:
            "CSS unit used to measure chat screen height. If the mobile browser address bar cuts off the screen, try another unit (`svh`, `lvh`, `dvh`).\n\n- **Normal**: automatic (`100%`)\n- **Percent / VH**: traditional units, sometimes broken on mobile\n- **DVH**: dynamic viewport, changes with address-bar size\n- **SVH**: small viewport, safest visible area\n- **LVH**: large viewport, address bar hidden",
        removeIncompleteResponse:
            "Automatically remove responses that were cut off by a network error, token limit, or similar interruption. When off, truncated responses stay in chat so you can inspect or reroll them manually.",
        newOAIHandle:
            "Use the newer OpenAI response-handling path. Try this when a model or response breaks under the legacy handler. The default is recommended for normal use.",
        noWaitForTranslate:
            "Show the original message before automatic translation finishes. The translated result replaces or augments it when ready.",
        newImageHandlingBeta:
            "Use the newer inlay image handling path. This is beta behavior and may differ in some edge cases.",
        allowAllExtentionFiles:
            "Disable extension filtering in file pickers and allow every file type. Useful for importing character cards saved with unusual or incorrect extensions.",
        dynamicModelRegistry:
            "Fetch model lists dynamically from providers such as OpenRouter at runtime. When off, only the built-in static list is shown.",
        disableSeperateParameterChangeOnPresetChange:
            "Keep separate auxiliary parameters (memory, emotion, translation model settings, etc.) from following prompt preset changes. Enable when you want helper models fixed independently from presets.",
        googleCloudTokenization:
            "Use the Google Cloud / Vertex / Gemini tokenizer API to count tokens. More accurate, but may add API calls and cost. Experimental; shown only when experimental settings are enabled.",
        localNetworkTimeoutSec:
            "Maximum seconds to wait in Local Network Mode. Local LLMs can be slow to produce the first token, so 30 seconds or more is recommended. (30-3600)",
        enableDevTools:
            "Show developer tools for debugging chat and UI behavior. Most users can leave this off.",
        promptTextInfoInsideChat:
            "When prompt info inside chat is enabled, also store and display the actual prompt text sent to the model. This can make chats heavier, so use it mainly for debugging.",
        returnCSSError:
            "Show notification details when custom CSS compilation fails. When off, CSS errors are ignored silently.",
        antiServerOverload:
            "Automatically increase retry intervals when an API server responds as overloaded (for example 429 or 503). Helps reduce pressure on unstable providers.",
        claude1HourCaching:
            "Use Claude's 1-hour prompt cache TTL instead of the default 5-minute cache. This can save more cost for repeated contexts, but 1-hour cache pricing differs.",
        claudeBatching:
            "Use Claude Batch API to process requests in batches. Cheaper, but responses are not immediate and may take minutes to hours. Best for background work.",
        rememberToolUsage:
            "Keep tool-use results in chat so later responses can refer to them. When off, tool results are treated as one-off data.",
        bookmark:
            "Enable bookmarks on chat messages and collect them in the menu. Useful for finding important messages in long chats.",
        simplifiedToolUse:
            "Show tool-call results in a simplified chat-friendly format. Use this when raw tool output is too long or noisy.",
        useTokenizerCaching:
            "Cache token counts for repeated text instead of recalculating them. This improves performance in long chats and is generally safe to keep enabled.",
        auxModelUnderModelSettings:
            "Show auxiliary model settings directly below the main model settings, making it easier to compare and adjust both in one place.",
        pluginDevelopMode:
            "Enable plugin development helpers such as logs, reload behavior, and hot-reload support. Regular users should leave this off.",
        unrecommendedNewGoogleTrans:
            "Use the new experimental Google Translate path. It may be faster than the old path, but can break in some cases.",
        unrecommendedClaudeCachingRetrival:
            "Try reusing cached Claude responses for repeated requests. Cache invalidation is tricky and can return unintended results, so this is not recommended.",
        lightningRealmImport:
            "Use a faster import path when importing characters from RisuRealm while account sync is enabled. Experimental.",
        unrecommendedTriggerV1:
            "Allow adding and editing Trigger V1. Trigger V1 is deprecated; use V2/V3 for new work. Keep this only for legacy V1 compatibility.",
        themePresets:
            "Bundle the current Sound & Display settings (layout, color/font, sizes, sound toggles, etc.) as a preset and switch between them. The active preset auto-syncs with edits you make below; clicking opens the preset list to add, switch, rename, or delete.",
        theme: "Overall chat layout theme.",
        waifuWidth: "Width of the character illustration in the Waifulike theme.",
        waifuWidth2: "Width of the second character or secondary visual in the Waifulike theme.",
        nodeOnlyStandardChatWidth: "Maximum chat card width in the PocketRisu Standard theme.",
        colorScheme: "Color palette used across the Risu UI.",
        textColor: "Message text color theme.",
        font: "Message font.",
        customFont: "Font name to use.",
        UISize: "Global UI zoom scale.",
        lineHeight: "Line height for message text.",
        iconSize: "Character/persona icon size.",
        textAreaSize: "Height step for editing text boxes (character, lorebook, prompt, etc.). Does not affect the chat input.",
        textAreaTextSize: "Text size step inside those editing text boxes. Does not affect the chat input.",
        sideBarSize: "Sidebar width step.",
        assetWidth: "Maximum width for in-chat asset images.",
        animationSpeed: "UI animation speed multiplier.",
        memoryLimitThickness: "Thickness of the memory-limit line.",
        fullscreen:
            "Switch the browser into fullscreen mode. On mobile, this can hide browser UI such as the address bar and give the chat more space.",
        showMemoryLimit:
            "Show the current max-context limit as a visual line in the chat area. Messages above the line may not be sent to the model, so this helps show what the model can still remember.",
        hideRealm:
            "Start the Recently Uploaded section on the home screen collapsed. While collapsed it skips the RisuRealm fetch, speeding up initial load. You can expand it any time from the home screen.",
        showFolderNameInIcon:
            "Show folder names on folder icons in the character grid. Makes large folder collections easier to scan.",
        customBackground: "A custom image used as the chat background.",
        playMessageOnTranslateEnd:
            "Play a separate notification sound when translation finishes. Useful when automatic translation is enabled and you want an audible completion cue.",
        roundIcons:
            "Display character and persona icons as circles instead of squares.",
        textScreenColor:
            "Set a background color behind the message text area. Disable it to make the text area transparent again.",
        textBorder:
            "Draw a subtle outline around message text to improve readability over background images.",
        textScreenRound:
            "Round the corners of the message text area. Most visible on themes with text backgrounds or borders.",
        showSavingIcon:
            "Show a small saving indicator while data is being saved. Helpful on pages where frequent saves happen.",
        showPromptComparison:
            "Show the built prompt in the prompt-comparison modal. Useful for debugging prompts or reducing token usage.",
        textScreenBorder:
            "Set the outline color around the chat text area. Disable it to remove the outline.",
        useChatCopy:
            "Show a copy button next to each message. When off, copy through the message menu instead.",
        useAdditionalAssetsPreview:
            "Show thumbnail previews in the character additional-assets list. Large asset collections may load a bit more slowly.",
        hideApiKeys:
            "Mask API key input fields in settings. Useful when sharing your screen or taking screenshots.",
        unformatQuotes:
            "Disable the default quote formatting such as italics or colors and render quotes as normal text. Enable if your text already includes its own formatting.",
        blockquoteStyling:
            "Render Markdown `>` blockquotes with the styled quote design. When off, they appear as plain indented text.",
        customQuotes:
            "Automatically replace single and double quote marks with custom characters. Useful for forcing language-specific quote marks.",
        customQuotesDoubleLeading:
            "Character to use at the start of double quotes. Examples: `\"`, `“`, `「`, `«`.",
        customQuotesDoubleTrailing:
            "Character to use at the end of double quotes. Examples: `\"`, `”`, `」`, `»`.",
        customQuotesSingleLeading:
            "Character to use at the start of single quotes. Examples: `'`, `‘`, `『`.",
        customQuotesSingleTrailing:
            "Character to use at the end of single quotes. Examples: `'`, `’`, `』`.",
        menuSideBar:
            "Use an always-visible sidebar menu instead of the classic hamburger menu. Useful on wider screens for faster navigation.",
        notification:
            "Enable browser notifications for new messages. Your browser may ask for permission the first time; if permission is denied, the option is turned back off.",
        unrecommendedChatSticker:
            "Enable the old chat-sticker feature. This is no longer recommended and may be removed in a future version.",
        UiLanguage:
            "Risu UI display language. Close the settings once after changing it so the new language fully applies.\n\n- **[Translate in your own language]** downloads the current language JSON so you can translate it and send it to the developer for inclusion.",
        translatorLanguage:
            "Language to translate character responses into. This is the output language, not your source language. Choose `Disabled` to turn translation off.",
        translatorType:
            "Translation engine to use.\n\n- **Google**: free, fast, acceptable quality for supported languages\n- **DeepL**: natural output, requires free or paid key\n- **Ax. Model**: LLM translation through the auxiliary model, most natural but slower and costs tokens\n- **DeepL X**: self-hosted DeepL-compatible proxy\n- **Firefox**: browser built-in Bergamot translation, downloads local models",
        deeplKey:
            "DeepL API auth key from https://www.deepl.com/account. Free keys require the DeepL Free toggle below because they use a different endpoint.",
        deeplFreeKey:
            "Use a DeepL Free key. Free keys are routed to the `*-free.com.deepl.com` endpoint. Turn this off for Pro keys.",
        deeplXUrl:
            "URL of your self-hosted DeepL X / DeepL-compatible translation server, such as `https://my-server.com/translate`.",
        deeplXToken:
            "Auth token for your DeepL X server. Leave blank if the server does not require authentication.",
        sourceLanguage:
            "Choose whether Google Translate should auto-detect the source language or assume a fixed source language. Auto is usually best, but fixing it can help short messages that get misdetected.",
        htmlTranslation:
            "When using the Firefox/Bergamot translator, translate HTML markup too. Turn this off if markup breaks and you only want plain text translated.",
        autoTranslation:
            "Automatically translate character responses as soon as they arrive. When off, use the per-message translate button. Pairs well with No Wait For Translate if you want the original shown first.",
        translationResponseSize:
            "Maximum response tokens to request during LLM translation. Too low can cut long translations; too high increases cost. 1000-4000 is common.",
        translatorPreset:
            "LLM translation preset to edit and use. Each preset stores its own response-size limit and translation prompt, so switching presets changes the fields below.",
        postEndInnerFormat:
            "Format appended to model input when a character response ends in group chat. Leave blank to disable. Helps the model recognize the next speaker turn, for example `\\n[end_of_turn]\\n`.",
        maxThoughtTagDepth:
            "Maximum allowed depth for nested thought tags such as `<thought>...</thought>` in model output. Deep thoughts can waste tokens; `1` to `3` is usually enough. `0` disables thought-tag handling.",
        predictedOutput:
            "OpenAI Predicted Outputs content. Tells the model what the response is expected to start with so generation can be faster. Useful for low-variance tasks such as code edits; usually minor for roleplay.",
        moduleName:
            "Display name of the module. This is for humans in the UI; references between modules and characters use the namespace below.",
        moduleDescription:
            "A note describing the module. It is shown only in the UI and is not sent to the model.",
        moduleHideChatIcon:
            "Hide this module's icon in chats where the module is applied. Useful for keeping the UI clean when many modules are active.",
        moduleBackgroundEmbedding:
            "Background HTML/CBS attached to this module. When the module is active, it is applied to the chat background. See the global Background HTML help for syntax.",
        moduleRegexList:
            "Regex scripts attached to this module. See the global Regex Script help for syntax and behavior.",
        moduleAdditionalAssets:
            "Additional assets bundled with this module. They can be referenced by module background HTML, regex scripts, triggers, and prompts.",
        googleAIKey:
            "API key from Google AI Studio (https://aistudio.google.com). Used for direct Gemini API calls. For enterprise Vertex AI, fill in the Vertex fields below instead.",
        vertexProjectId:
            "Google Cloud project ID for Vertex AI. The service account used must have Vertex AI permissions on this project.",
        vertexClientEmail:
            "Service account email used for Vertex authentication (`...@<project>.iam.gserviceaccount.com`). Copy from your service account JSON key file.",
        vertexPrivateKey:
            "The `private_key` value from your service account JSON key file. Paste the full `-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----` block. This is highly sensitive — be careful when sharing backups.",
        vertexRegion:
            "Region to send Vertex AI requests to. `global` auto-routes; for US users `us-central1` or `us-west1` are common. Pick a region that matches any data residency requirements you have.",
        novellistKey:
            "API key for NovelList (the Korean AI Novelist service). The model lineup and access rules change frequently — check NovelList's own guidance before use.",
        mancerKey:
            "API key for Mancer. Required when using open-source models hosted on Mancer (https://mancer.tech/).",
        claudeApiKey:
            "Anthropic API key (starts with `sk-ant-`). Get one at https://console.anthropic.com/settings/keys.\n\nIf you've selected an AWS Bedrock model, this key is not used — Bedrock auth is configured separately.",
        mistralKey:
            "Mistral AI API key from https://console.mistral.ai/api-keys/. Only needed for direct Mistral calls. If you reach Mistral models through another provider (e.g. OpenRouter), leave this blank.",
        novelaiToken:
            "Bearer token for the NovelAI API. NovelAI does not expose an official API-key page — extract the token via your browser's dev tools after signing in, or use a helper tool.",
        proxyAPIKey:
            "API key the reverse proxy expects for authentication. Leave blank if your proxy doesn't require one. The value is sent as `Authorization: Bearer <key>`.",
        proxyRequestModel:
            "Model name to send to the proxy. Some OpenAI-compatible proxies use their own naming conventions, so paste the exact model id the proxy expects (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`).",
        proxyFormat:
            "Request body format for the reverse proxy.\n\n- **OpenAI Compatible**: most common, OpenAI Chat Completions shape\n- **OpenAI Response API**: the new Response API (only on supporting models)\n- **Anthropic**: Claude API shape\n- **Mistral**: Mistral's own format\n- **Google Cloud**: Vertex / Gemini\n- **Cohere**: Cohere's own format\n\nPick whichever the proxy accepts. If unsure, start with OpenAI Compatible.",
        cohereKey:
            "Cohere API key (https://dashboard.cohere.com/api-keys). Required when using Cohere's own models such as `command-r`.",
        ollamaURL:
            "URL of your local or remote Ollama server (e.g. `http://localhost:11434`). Pairs well with PocketRisu's local-network mode for stable access to private LAN LLMs.",
        ollamaModel:
            "Model name to call on the Ollama server. Run `ollama list` to see installed models and copy the name verbatim (e.g. `llama3:8b`).",
        nanogptKey:
            "API key for NanoGPT (https://nano-gpt.com). NanoGPT supports both pay-per-message and subscription billing — if you're on a subscription plan, also enable the toggle below.",
        nanoGPTUseSubscriptionEndpoint:
            "Enable this if you're on a NanoGPT subscription plan. Requests are routed to the subscription endpoint instead of pay-per-message, so they don't draw down your prepaid balance. Non-subscribers will get rejected requests with this on.",
        nanogptModelMode:
            "How to choose the NanoGPT model. **Select from List** picks from a dropdown of popular models NanoGPT exposes; **Manual Input** lets you type a model id directly (useful for niche or newly added models).",
        nanogptManualModel:
            "Model id to send to NanoGPT. Copy the exact id from NanoGPT's model list page.",
        openrouterKey:
            "OpenRouter API key (https://openrouter.ai/keys). One key gives you access to models from many providers; usage is billed against your OpenRouter balance.",
        openrouterModel:
            "Model to call through OpenRouter. The grid shows popular models — use the search to narrow down. Pricing and context limits vary per model, so check before committing.",
        tokenizer:
            "Tokenizer used to count tokens. Picking one that doesn't match the actual model can make the max-context limit and the displayed token usage drift apart, so choose the tokenizer that matches your model.",
        koboldURL:
            "URL of your Kobold / KoboldCpp server (e.g. `http://localhost:5001`). You need to be running a KoboldCpp instance separately.",
        echoMessage:
            "The Echo model doesn't call any LLM — it just returns whatever you put here. Useful for testing UI flow or debugging prompts without spending tokens.",
        echoDelay:
            "Delay (in seconds) before the Echo model returns its response. Handy for testing streaming and loading UI behavior.",
        hordeKey:
            "API key for AI Horde (https://stablehorde.net). You can use Horde anonymously, but priority is low and responses are slow. Setting a key lets you spend (and earn) your own kudos.",
        textgenBlockingURL:
            "Synchronous (blocking) API endpoint for TextGen WebUI. The WebUI must be launched with the `--api` flag (e.g. `https://server.local/api/v1/generate`).",
        textgenStreamURL:
            "Streaming WebSocket endpoint for TextGen WebUI. Lets responses arrive token by token. Leave blank to disable streaming.",
        streaming:
            "Display the model's response token-by-token in real time (only on models that support it). When off, the full response appears all at once after generation finishes, which can feel slightly slower.",
        streamGeminiThoughts:
            "Also stream Gemini's `thinking` tokens in real time. Only meaningful when streaming is on and the chosen Gemini model supports thinking.",
        reverseProxyOobaMode:
            "Enable this when your reverse proxy uses an Oobabooga-style generate endpoint. Requests are routed through the Ooba code path instead of OpenAI Chat Completions.",
        textAdventureNAI:
            "Call NovelAI in text-adventure mode. Output takes on an adventure-game tone — only meaningful for the NovelAI models that support this mode.",
        appendNameNAI:
            "Automatically inject the character/persona name into the NovelAI prompt. Off sends just the body without the name.",
        customPlugin:
            "Custom models are powered by a plugin. Pick the plugin provider that should generate responses. If the plugin is disabled the response will come back empty.",
        maxContextSize:
            "Maximum input tokens to send to the model. Going over the model's own limit (e.g. 128K for GPT-4o) causes errors, so keep it within bounds. Larger values increase input cost.",
        profileVisibilityLevel:
            "Hide outdated or deprecated model profiles from the catalog list and update notices.",
        useCustomRegistry:
            "Download model profiles from your own registry fork or branch instead of the official one.",
        customRegistryUrl:
            "An https base URL ending in a slash; index.json and catalog.json are fetched from it. An empty or non-https URL is rejected.",
        maxResponseSize:
            "Maximum output tokens for a single response. Too low and replies get cut off; too high costs more and can let the model ramble. 256–1024 covers most cases.",
        seed:
            "Seed for deterministic output. Same input + same seed ≈ same response. Use it to remove variance when comparing prompts. Only honored on OpenAI / reverse-proxy / OpenRouter models.",
        thinkingType:
            "Claude thinking mode.\n\n- **Off**: no thinking (faster and cheaper)\n- **Budget (Manual Tokens)**: spend up to the \"Thinking Tokens\" amount on thinking\n- **Adaptive**: Claude adjusts its thinking budget to the difficulty of the task (newest Claude models only)",
        thinkingTokens:
            "Maximum tokens to spend on thinking when in Budget mode. Raise it for harder reasoning, lower it to save cost. `-1` uses the model default.",
        adaptiveThinkingEffort:
            "Effort level Claude applies in Adaptive mode.\n\n- **Low**: fast, simple tasks\n- **Medium**: general use\n- **High**: complex reasoning or coding\n- **Max**: maximum effort, with the cost and latency to match",
        topK:
            "Limit candidate tokens to the top K most likely. Lower values feel conservative and repetitive; higher values pull in more variety. Around 40 is a common middle ground. Not all models honor this.",
        minP:
            "Drop tokens whose probability falls below this fraction of the most likely token's probability. Around 0.05–0.1 is typical. More adaptive than Top P, which is why it's gained popularity.",
        topA:
            "Dynamically clip candidates based on the squared probability (or a fraction) of the top token. `0` disables it. Used by NovelAI and some local models.",
        repetitionPenalty:
            "Lowers the probability of tokens that have already appeared. `1.0` is neutral; `1.1` is a typical light penalty. Push it too high and the model will avoid even natural repetitions, sounding stilted.",
        reasoningEffort:
            "For OpenAI o-series reasoning models. Controls how much effort goes into reasoning.\n\n- **-1**: model default\n- **0–2**: low / medium / high (deeper reasoning is slower and more expensive)",
        verbosity:
            "Response-length control on some OpenAI models. `0` is concise, `2` is long-form. Only meaningful on models that support it.",
        promptPreprocess:
            "Append an extra prompt (the `additionalPrompt` setting, default \"The assistant must act as {{char}}. user is {{user}}.\") to the end of the main prompt. Helps lock in roleplay context. When off, only the raw main prompt is sent.",
        usePromptTemplate:
            "Use a custom prompt template (Settings → Prompt Template) instead of the four prompt fields above (main / jailbreak / note / order). Templates allow more sophisticated prompt composition but have a steeper learning curve.",
        customFlags:
            "Force capability flags on the current model. For example, even if the model doesn't natively report image input support, turning on `hasImageInput` makes the system assume it does. Useful for compatibility shims and workarounds — set the wrong flag and requests will break.",
        enableCustomFlags:
            "Whether the custom flags above actually take effect. When off, the configured flags are stored but not applied.",
        tools:
            "Tools the model is allowed to call mid-response (search, function calls, …). The model itself must support tool use, and only some providers honor it.",
        searchTool:
            "Allow the model to call an external search tool while generating its response. This can improve factual accuracy at the cost of extra tokens and latency. Requires a tools-capable model.",
        botRegexScript:
            "Regex scripts that apply only to this bot configuration, in addition to global regex scripts. See the global regex script help for syntax details.",
        botIcon:
            "Default icon for this bot configuration. Independent of the character card's icon — used as the assistant message icon.",
        botPromptTemplate:
            "Pick a prompt template. Templates allow more elaborate prompt construction than the main / jailbreak / note fields. Only active when \"Use Prompt Template\" is enabled.",
        personaName:
            "Name of the current persona. This fills the `{{user}}` variable in chats and is the name the character uses to address you.",
        personaNote:
            "A memo / identifier for this persona (only shown when Advanced → personaNote is enabled). Useful for distinguishing multiple personas that share the same display name.",
        personaDescription:
            "Persona information. Embedded into the system prompt sent to the model so it recognizes who the user is. Example: \"<user> is a 20 year old woman who normally speaks calmly.\"",
        personaLargePortrait:
            "Themes such as Waifulike will display a large portrait instead of the persona icon. Use when you want to show a full-body illustration of the persona.",
        openRouterFallback:
            "When the selected model is temporarily unavailable, OpenRouter automatically routes the request to a compatible fallback model. Improves reliability. Turn off to surface the original error instead.",
        openRouterMiddleOut:
            "OpenRouter's context compression feature. For requests that exceed the model's max context, middle messages are auto-summarized. Some models do not support this.",
        useInstructPrompt:
            "Send the request to OpenRouter using the instruct format instead of Chat Completions. Turn on when you want to call a base / instruct model raw.",
        chatFormating:
            "Chat template for instruct models. The template must match the format the model was trained on, otherwise responses break.\n\n- **ChatML**: OpenAI / Qwen family (`<|im_start|>` tokens)\n- **Llama2 / Llama3**: Meta Llama family\n- **Gemma / Mistral / Vicuna / Alpaca / GPT2**: each model's official format\n- **Custom (Jinja)**: write your own Jinja template\n\nIf responses look broken with a proxy or local model, switch to the format the model was actually trained on.",
        jinjaTemplate:
            "Jinja template source. The safest approach is to copy the model card's `chat_template` verbatim. Use `{{ messages }}`, `{{ bos_token }}` etc. to tokenize the message array. (Only shown when `Custom (Jinja)` is selected.)",
        customStopWords:
            "Use stop strings. The model's response is cut as soon as one of these strings appears. Useful for blocking patterns where the character impersonates the next speaker (e.g. `{{user}}: ...`).",

        memType:
            "Long-term memory mode.\n\n- **None**: disabled (chat is sent as-is up to the max context limit)\n- **HypaV3**: PocketRisu's long-term memory that auto-summarizes and retrieves older chat to inject into the context. Slightly more cost / latency, but consistency in long chats improves a lot.",
        hypaV3SummaryModel:
            "Model used to summarize chat.\n\n- **subModel**: use the auxiliary model (most common)\n- **Qwen3 4B/14B**: free local summarization (runs in the browser or Node instance directly, downloads on first use)\n\nUsing a lighter model than the main model saves cost.",
        hypaV3Preset:
            "HypaV3 settings preset. Save and load groups of frequently used settings; switching presets also swaps every ratio / model option above.",
        embeddingOpenAIKey:
            "API key used when an OpenAI embedding model is selected. Set this only if you want to manage embedding cost separately from the main-model key. If empty, the main OpenAI key is reused.",
        embeddingCustomURL:
            "OpenAI-compatible endpoint URL of a custom embedding model. Use this when you self-host or run an open-source embedding server.",
        embeddingCustomKey:
            "Auth key for the custom embedding server. Leave blank if your server does not require auth.",
        embeddingCustomModel:
            "Model name to send to the custom endpoint, exactly as the server expects (e.g. `nomic-embed-text-v1.5`).",
        embeddingVoyageKey:
            "Voyage AI API key (`https://www.voyageai.com/`). Required when the embedding model is set to voyageContext3 etc.",

        ttsAutoSpeech:
            "Automatically play the character's response as speech when it arrives. Mobile browsers may block this in the background — after enabling, tap the screen once to grant permission.",
        ttsElevenLabsKey:
            "ElevenLabs (`https://elevenlabs.io`) API key. Provides the most natural-sounding voices, with a small free tier and paid plans.",
        ttsVoicevoxUrl:
            "URL of a locally running VOICEVOX (`https://voicevox.hiroshiba.jp/`) engine (e.g. `http://localhost:50021`). Strong on Japanese synthesis.",
        ttsOpenAIKey:
            "OpenAI TTS API key. The same key as your main OpenAI key works, but use a separate one if you want to track TTS spend separately.",
        ttsNAIKey:
            "API key for NovelAI voice synthesis. Same as the regular NovelAI Bearer token.",
        ttsHuggingfaceKey:
            "HuggingFace Inference API key. Required to call HuggingFace's free or paid TTS models.",
        ttsFishSpeechKey:
            "Fish-speech (`https://fish.audio/`) API key. Provides natural-sounding multi-speaker voices.",

        emotionMethod:
            "Method used to detect emotion in the character's response and pick the matching emotion image.\n\n- **Ax. Model**: ask the auxiliary LLM to classify the emotion (high accuracy, small cost)\n- **MiniLM-L6-v2**: local embedding-based classifier (free, fast, lower accuracy)\n\nThe emotion images themselves work only after you register emotion assets on the character card.",

        webuiUrl:
            "URL of an AUTOMATIC1111 or compatible WebUI (e.g. `http://localhost:7860`). The WebUI must be launched with the `--api` flag.",
        webuiSteps:
            "Sampling steps. 20–50 is typical. More steps slightly improve quality but linearly increase generation time. (0–100)",
        webuiCFG:
            "Prompt adherence (CFG). Lower = freer interpretation, higher = forced match to the prompt. Around 7 is a common middle ground. (0–20)",
        webuiWidth:
            "Image width in pixels. Use 1024 as a baseline for SDXL and 512 for SD1.5. Non-standard resolutions can hurt quality.",
        webuiHeight:
            "Image height in pixels. Use 1024 as a baseline for SDXL and 512 for SD1.5. Non-standard resolutions can hurt quality.",
        webuiSampler:
            "Sampler name. Type the exact name supported by your WebUI (e.g. `Euler a`, `DPM++ 2M Karras`).",
        webuiEnableHr:
            "Use Hires fix. Generates at a smaller resolution first, then upscales and re-denoises to add detail. Roughly doubles generation time.",
        webuiDenoising:
            "Strength of the re-denoise pass during Hires fix. Lower stays close to the original; higher adds more detail but drifts further. 0.4–0.6 is a typical range.",
        webuiHrScale:
            "Upscale ratio used during Hires fix (e.g. 2 = 2×). Memory and time cost scale linearly.",
        webuiUpscaler:
            "Upscaler name (e.g. `Latent`, `R-ESRGAN 4x+`, `4x-UltraSharp`). Use a name available in your WebUI's settings.",

        naiImgUrl:
            "NovelAI image generation endpoint. Rarely needs to be changed from the default — leave blank to use it.",
        naiImgKey:
            "NovelAI Bearer token. Same as the token used for the text models.",
        naiModel:
            "NovelAI image model to use. Newer models look better and cost slightly more (Anlas drawn from your subscription plan).",
        naiWidth:
            "Image width. NAI recommends predefined resolutions like 832×1216.",
        naiHeight:
            "Image height. NAI recommends predefined resolutions like 832×1216.",
        naiSampler:
            "Sampler supported by the selected model. Refer to NovelAI's official guide for per-model recommended samplers.",
        naiNoiseSchedule:
            "Noise schedule. Most setups use `native` (model recommended) or `karras`. Other options require model compatibility checks.",
        naiSteps:
            "Sampling steps. NAI recommends around 28. Going much higher just increases Anlas cost.",
        naiCFG:
            "Prompt adherence (CFG). 5–7 is typical for NAI; the recommended value varies by model.",
        naiCFGRescale:
            "CFG rescale correction. 0 disables; 0.5–0.7 is typical. Helps with color / contrast on some models.",
        naiImageReference:
            "Image reference mode.\n\n- **None**: text only\n- **Vibe Transfer**: borrow the mood of the reference image\n- **Character Reference**: borrow the character from the reference image (NAI Diffusion 4-5 only)",
        naiVibeModel:
            "NAI model used to extract the Vibe Transfer encoding. Usually pick the same model you generate with.",
        naiInfoExtracted:
            "What kind of information to extract from the reference (overall vibe / colors only / composition etc).",
        naiRefStrength:
            "Reference strength. Low = subtle borrowing, high = near-replica. 0.5–0.8 is a good range.",
        naiStyleAware:
            "Style-aware mode. With Character Reference, also matches the character's style more strongly.",
        naiUseSMEA:
            "Use SMEA (Smea) sampling. Improves detail on some NAI models.",
        naiUseDYN:
            "Use Dynamic Thresholding (DYN). Helps with color and exposure balance.",
        naiVarietyPlus:
            "Variety+ mode. Produces more varied results from the same prompt.",
        naiDecrisp:
            "Decrisp mode. Softens excessive sharpness (effect varies by model).",
        naiLegacyUC:
            "Use the legacy unconditional (negative-prompt) handling. Only meaningful on NAI Diffusion 4 full / curated models.",
        naiEnableI2I:
            "Enable image-to-image. Generate variations based on a reference image.",

        dalleKey:
            "OpenAI API key for Dall-E. The same key used for text models works.",
        dalleQuality:
            "Image quality (`standard` / `hd`). HD costs roughly 2× more.",

        stabilityKey:
            "Stability Platform API key (`https://platform.stability.ai/`).",
        stabilityModel:
            "Stability model to use (`ultra` / `core` / `sd3-large` / `sd3-medium`). Ultra is the most expensive and highest quality; Core is fast and cheap.",
        stabilityCoreStyle:
            "Style preset for the SD Core model (Photographic / Anime / 3D Model etc). Ignored on other models.",

        comfyUrl:
            "URL of your local ComfyUI server (e.g. `http://localhost:8188`).",
        comfyTimeout:
            "Maximum seconds to wait for a ComfyUI response. Use a longer value for complex workflows. (1–120)",

        falKey:
            "Fal.ai API key (`https://fal.ai/dashboard/keys`). Used to call Flux models.",
        falWidth:
            "Recommended Flux width. Same idea as SDXL — 1024×1024 or 16:9 aspect ratios are recommended.",
        falHeight:
            "Recommended Flux height. Same idea as SDXL — 1024×1024 or 16:9 aspect ratios are recommended.",
        falModel:
            "Which Flux variant to use. **dev** = standard, **dev+lora** = LoRA-applied, **pro** = high quality, **schnell** = fast and cheap.",
        falLoraWeight:
            "LoRA application strength. 0 = ignored, 1 = fully applied. Above 1.2 results tend to break.",

        imagenKey:
            "Google AI Studio API key. The same key as your main Gemini key works.",
        imagenModel:
            "Imagen model to use (version 3 / 4 etc). Newer versions produce higher quality.",
        imagenImageSize:
            "1K / 2K. 2K costs more and is supported only on some models.",
        imagenAspectRatio:
            "1:1, 4:3, 16:9 and so on. Quality may suffer outside the model's recommended ratios.",
        imagenPersonGeneration:
            "Person-generation policy.\n\n- **allow_all**: all people\n- **allow_adult**: adults only\n- **dont_allow**: no people\n\nPrompts that don't match the policy may be rejected.",

        oaiImgUrl:
            "URL of an OpenAI-compatible image API. Must follow a standard path like `/v1/images/generations`.",
        oaiImgKey:
            "API key. If your server doesn't require auth, you can put any value here.",
        oaiImgModel:
            "Name of the image model registered on the server (exactly as the server expects).",
        oaiImgSize:
            "Image size. Only sizes supported by the server work.",
        oaiImgQuality:
            "Quality option. Only meaningful when the server supports a `quality` parameter.",

        waveKey:
            "WaveSpeed.ai API key (`https://wavespeed.ai/`). A fast, low-cost image generation router.",
        waveModel:
            "WaveSpeed model to use. Use the \"Refresh Models\" button above to refresh the available list, and the search box to narrow it down.",
        waveLoras:
            "Register up to 3 LoRA URLs and weights. Applied only when the model supports LoRA.",
        waveImageReference:
            "Reference image mode (None / Upload / Use Character Image). Works only when the model supports image input.",

        bootBackupReminder:
            "When enabled, PocketRisu prompts you on every boot whether to create a server backup right away. Useful as a lightweight safety net before opening the app each session. Confirming runs a full server backup (the loading screen waits while it finishes); skipping continues straight to the app.",
}
