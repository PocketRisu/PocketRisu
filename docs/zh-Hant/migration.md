<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

# RisuAI 遷移指南

> 🌐 此指南由機器翻譯生成。如需獲取最準確的資訊,請參閱 [English](../en/migration.md) 或 [한국어](../ko/migration.md) 版本。

從現有 RisuAI 安裝(Web RisuAI、本地 RisuAI)遷移資料到 PocketRisu 有三種方式。根據您的來源環境和資料規模選擇。

- [1. 本地備份檔案(.bin)](#1-本地備份檔案bin) — 在所有環境中可用。最常見的方法。
- [2. Save 資料夾 zip 上傳](#2-save-資料夾-zip-上傳) — 本地 RisuAI,小規模資料。
- [3. Save 資料夾直接複製](#3-save-資料夾直接複製) — 本地 RisuAI,大規模資料。


## 開始之前

> ⚠️ 遷移前**請備份現有資料**。可從 RisuAI 的 設定 > 備份 匯出 `.bin` 檔案。


---

## 1. 本地備份檔案(.bin)

從現有 RisuAI 匯出 `.bin` 備份檔案,然後匯入 PocketRisu。無論來源環境(web / Tauri / Capacitor / 本地)如何均可使用。

1. **在現有 RisuAI 中**: 設定 > 備份 > "儲存本地備份" 匯出 `.bin` 檔案。
2. **在 PocketRisu 中**: 設定 > 資料遷移 > "匯入原版 Risu 本地備份" 匯入 `.bin` 檔案。

> ⚠️ **如果您在網頁版 RisuAI 中登入帳號使用**(資料同步到 RisuAI 伺服器的狀態),用"儲存本地備份"產生的檔案其資料庫已被加密,PocketRisu 無法讀取。匯入時會被拒絕並顯示說明。請改用以下方式之一匯出:
> - **先登出帳號再備份**(建議):在設定 > 帳號中登出後,資料會轉移到瀏覽器(裝置)。之後點擊"儲存本地備份"即可產生包含素材的一般備份。
> - **部分備份**:登入狀態下使用"部分備份"不會加密,但只包含角色頭像圖片。



---

## 2. Save 資料夾 zip 上傳

若您使用的是本地 RisuAI(Node 伺服器版),可將 `save` 資料夾壓縮為 zip 並上傳。

1. 將現有 RisuAI 專案的 `save` 資料夾壓縮為 zip 檔案。
2. 在 PocketRisu 中開啟 設定 > 資料遷移 > "從 NodeOnly Risu 匯入 save 資料夾" 摺疊面板。
3. 透過 "從 save 資料夾匯入(Zip 上傳)" 上傳 zip 檔案。

> 若 zip 檔案過大,上傳可能失敗。此時請使用 [3. Save 資料夾直接複製](#3-save-資料夾直接複製)。


---

## 3. Save 資料夾直接複製

適合大規模資料(數 GB 以上)。需要伺服器檔案系統的直接存取權限。

1. 停止 PocketRisu 伺服器。
2. 用現有 RisuAI 的 `save` 資料夾整體覆蓋 PocketRisu 的 `save` 資料夾。
3. 重啟 PocketRisu 伺服器 — 自動遷移開始。
    - 可在終端機或 PM2 日誌中檢視進度。
4. 遷移完成後,使用 設定 > 資料遷移 > "從 NodeOnly Risu 匯入 save 資料夾" 摺疊面板 > "清理已遷移的 save 檔案" 移除原始檔案並回收磁碟空間。


---

## 我該選擇哪種方式?

| 情況                                              | 推薦方式                          |
| ------------------------------------------------- | --------------------------------- |
| 從 Web RisuAI 遷移                                | 1. `.bin` 備份                    |
| 從本地 RisuAI 遷移,資料小規模                    | 2. Zip 上傳                       |
| 從本地 RisuAI 遷移,資料大規模(10GB+)            | 3. Save 資料夾直接複製            |
| 不確定                                            | 1. `.bin` 備份                    |


---

← [返回 README](../../i18n/README.zh-Hant.md)
