<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu — 自架 AI 角色扮演聊天平台" width="900" />
</p>

<h1 align="center">PocketRisu — 自架 AI 角色扮演聊天</h1>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

<p align="center">
  <a href="https://github.com/PocketRisu/PocketRisu/releases">
    <img alt="Latest Release" src="https://img.shields.io/github/v/release/PocketRisu/PocketRisu?label=latest" />
  </a>
  <a href="../LICENSE">
    <img alt="License: GPL-3.0" src="https://img.shields.io/github/license/PocketRisu/PocketRisu" />
  </a>
  <a href="https://nodejs.org/">
    <img alt="Node" src="https://img.shields.io/badge/node-≥22.12-brightgreen" />
  </a>
</p>

> 🌐 此 README 由機器翻譯生成。如需獲取最準確的資訊,請參閱 [English](../README.md) 或 [한국어](README.ko.md) 版本。歡迎貢獻翻譯。

PocketRisu 是一個自託管的 AI 角色扮演聊天平臺,您可以在自己的 PC 或個人伺服器上執行,並透過網頁瀏覽器從 PC、平板和智慧型手機存取。

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="../assets/screenshots/screenshot-pc-chat.png" alt="PC 聊天" height="420" /></td>
      <td align="center"><img src="../assets/screenshots/screenshot-mobile-chat.png" alt="行動裝置聊天" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>行動裝置</b></td>
    </tr>
  </table>
</p>


## 文件

- [安裝指南](../docs/zh-Hant/install.md)
- [RisuAI 遷移指南](../docs/zh-Hant/migration.md)
- [遠端存取指南](../docs/zh-Hant/remote.md)
- [Termux 安裝指南 (Android)](../docs/zh-Hant/termux.md)


## RisuAI 相容性

PocketRisu 衍生自 [RisuAI](https://github.com/kwaroran/RisuAI),針對自託管環境進行了改進。現有的 RisuAI 資料可以完整遷移,所有 RisuAI 生態系統資源都可以原樣使用。

- RisuRealm 角色下載
- 角色卡(`.charx`、`.risum`、`.risup` 等)
- 模組、世界書、預設
- 備份檔案(`.bin`)雙向相容

從現有 RisuAI 遷移的方法請參考[遷移指南](../docs/zh-Hant/migration.md)。


## 主要功能

- **多種 AI 提供者**:支援 OpenAI、Claude、Gemini、DeepInfra、OpenRouter、Ollama 等
- **多裝置存取**:執行一個伺服器,透過網頁瀏覽器從 PC、平板和智慧型手機存取
- **伺服器端生成**:即使螢幕熄滅或連線中斷,伺服器也會繼續生成,重新連線後自動還原完成的回覆
- **統一資料儲存**:所有資料(角色、對話、設定、插圖)都儲存在伺服器上的單一 SQLite 資料庫中(無需依賴外部雲端服務)
- **便利的伺服器備份**:伺服器直接處理備份和還原,也支援本地 `.bin` 備份匯出匯入
- **強大的儀表板**:磁碟使用情況(按角色/模組)、可回收快照空間、SQLite 最佳化等,一屏管理
- **世界書 & 長期記憶**:世界資訊/記憶書、HypaMemoryV3 等上下文保留功能
- **自動翻譯**:自動翻譯輸入輸出,實現跨語言角色扮演
- **正則指令碼 & 外掛**:修改模型輸出,擴展功能
- **TTS & 附加資源**:語音合成、聊天中嵌入圖像/音訊/影片
- **自我更新**:自動偵測新版本,可攜版可透過網頁介面更新
- **行動裝置遠端存取**:Quick Tunnel(URL + QR)或 Tailscale
- **多語言介面**:韓語、英語、日語、中文等


## 社群與聯絡

- 錯誤回報/功能請求:[GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- 電子郵件:contact@pocketrisu.com


## 授權條款

[GPL-3.0](../LICENSE)
