<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <strong>简体中文</strong> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI 迁移指南

> 🌐 此指南由机器翻译生成。如需获取最准确的信息,请参阅 [English](../en/migration.md) 或 [한국어](../ko/migration.md) 版本。

从现有 RisuAI 安装(Web RisuAI、本地 RisuAI)迁移数据到 PocketRisu 有三种方式。根据您的源环境和数据规模选择。

- [1. 本地备份文件(.bin)](#1-本地备份文件bin) — 在所有环境中工作。最常用的方法。
- [2. Save 文件夹 zip 上传](#2-save-文件夹-zip-上传) — 本地 RisuAI,小规模数据。
- [3. Save 文件夹直接复制](#3-save-文件夹直接复制) — 本地 RisuAI,大规模数据。


## 开始之前

> ⚠️ 迁移前**请备份现有数据**。可从 RisuAI 的 设置 > 备份 导出 `.bin` 文件。


---

## 1. 本地备份文件(.bin)

从现有 RisuAI 导出 `.bin` 备份文件,然后导入 PocketRisu。无论源环境(web / Tauri / Capacitor / 本地)如何均可使用。

1. **在现有 RisuAI 中**: 设置 > 备份 > "保存本地备份" 导出 `.bin` 文件。
2. **在 PocketRisu 中**: 设置 > 数据迁移 > "导入原版 Risu 本地备份" 导入 `.bin` 文件。

> ⚠️ **如果您在网页版 RisuAI 中登录账号使用**(数据同步到 RisuAI 服务器的状态),用"保存本地备份"生成的文件其数据库已被加密,PocketRisu 无法读取。导入时会被拒绝并显示说明。请改用以下方式之一导出:
> - **先退出账号再备份**(推荐):在设置 > 账号中退出登录后,数据会转移到浏览器(设备)。之后点击"保存本地备份"即可生成包含资源的普通备份。
> - **部分备份**:登录状态下使用"部分备份"不会加密,但只包含角色头像图片。



---

## 2. Save 文件夹 zip 上传

如果您使用的是本地 RisuAI(Node 服务器版),可以将 `save` 文件夹压缩为 zip 并上传。

1. 将现有 RisuAI 项目的 `save` 文件夹压缩为 zip 文件。
2. 在 PocketRisu 中打开 设置 > 数据迁移 > "从 NodeOnly Risu 导入 save 文件夹" 折叠面板。
3. 通过 "从 save 文件夹导入(Zip 上传)" 上传 zip 文件。

> 如果 zip 文件过大,上传可能失败。这种情况请使用 [3. Save 文件夹直接复制](#3-save-文件夹直接复制)。


---

## 3. Save 文件夹直接复制

适合大规模数据(数 GB 以上)。需要服务器文件系统的直接访问权限。

1. 停止 PocketRisu 服务器。
2. 用现有 RisuAI 的 `save` 文件夹整体覆盖 PocketRisu 的 `save` 文件夹。
3. 重启 PocketRisu 服务器 — 自动迁移开始。
    - 可在终端或 PM2 日志中查看进度。
4. 迁移完成后,使用 设置 > 数据迁移 > "从 NodeOnly Risu 导入 save 文件夹" 折叠面板 > "清理已迁移的 save 文件" 移除原始文件并回收磁盘空间。


---

## 该选择哪种方式?

| 情况                                              | 推荐方式                        |
| ------------------------------------------------- | ------------------------------- |
| 从 Web RisuAI 迁移                                | 1. `.bin` 备份                  |
| 从本地 RisuAI 迁移,数据小规模                     | 2. Zip 上传                     |
| 从本地 RisuAI 迁移,数据大规模(10GB+)            | 3. Save 文件夹直接复制          |
| 不确定                                            | 1. `.bin` 备份                  |


---

← [返回 README](../../i18n/README.cn.md)
