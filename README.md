# Bilibili 一键复制全部字幕

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-用户脚本-00485b?logo=tampermonkey)](https://www.tampermonkey.net/)
[![Version](https://img.shields.io/badge/version-1.3.0-00aeec)](./bilibili-copy-subtitles.user.js)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

一个轻量的 Bilibili 油猴脚本。打开有字幕的视频，点击页面左下角的 **复制全部字幕**，即可把整理后的纯文字字幕复制到剪贴板。

复制结果保留正文标点，不包含时间戳、字幕序号、JSON 字段或其他字幕文件边界符号，适合整理笔记、检索内容和制作摘要。

## 安装

安装前需要浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/) 或其他兼容 UserScript 的脚本管理器。

### 一键安装

[点击安装脚本](https://raw.githubusercontent.com/dongyu23/bilibili-copy-subtitles/main/bilibili-copy-subtitles.user.js)

Tampermonkey 打开安装确认页后，点击“安装”即可。脚本后续可以通过脚本管理器自动检查更新。

### 手动安装

1. 打开 Tampermonkey 管理面板。
2. 新建脚本并删除编辑器中的默认内容。
3. 将 [`bilibili-copy-subtitles.user.js`](./bilibili-copy-subtitles.user.js) 的全部内容粘贴进去。
4. 保存脚本并刷新 Bilibili 视频页面。

## 使用

1. 登录 Bilibili。部分视频只有登录后才能读取字幕列表。
2. 打开一个带有字幕的视频。
3. 点击页面左下角的 **复制全部字幕**。
4. 页面显示复制成功及字符数量后，字幕正文已经进入剪贴板。

也可以从 Tampermonkey 菜单执行“复制当前视频全部字幕”。如果不想显示页面按钮，可以通过菜单中的“显示/隐藏页面按钮”关闭它。

## 功能

- 一键复制当前视频或当前分P的完整字幕
- 自动去除时间戳、序号和字幕格式边界
- 保留字幕正文原有标点
- 中英文相邻字幕行自动补充必要空格
- 支持普通视频、分P、合集、播放列表和番剧播放页
- 页面按钮支持显示或隐藏
- 原生请求失败时自动尝试油猴跨域请求
- 支持 Tampermonkey 自动更新

## 字幕选择规则

脚本默认优先复制中文字幕：

1. 语言代码为中文或 AI 中文的字幕
2. 名称包含“中文”“汉语”“简体”或“繁体”的字幕
3. 非 AI 字幕
4. 如果以上条件均不满足，使用视频提供的第一条字幕

因此，只要视频提供中文字幕，脚本就不会默认选择英文字幕。

## 支持的页面

```text
https://www.bilibili.com/video/*
https://www.bilibili.com/list/*
https://www.bilibili.com/bangumi/play/*
https://www.bilibili.com/medialist/play/*
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `GM_setClipboard` | 将整理后的字幕写入剪贴板 |
| `GM_addStyle` | 显示页面按钮和操作提示 |
| `GM_registerMenuCommand` | 提供复制及按钮显示开关 |
| `GM_xmlhttpRequest` | 原生请求失败时读取字幕文件 |
| `unsafeWindow` | 获取当前视频及分P编号 |
| `api.bilibili.com` | 获取当前视频的字幕列表 |
| `aisubtitle.hdslb.com` | 获取 Bilibili AI 字幕文件 |

脚本不上传字幕，不收集浏览记录，也不包含统计或追踪代码。

## 常见问题

### 提示“当前视频没有可用字幕”

该视频可能没有 UP 主字幕或 Bilibili AI 字幕。也可能是账号未登录，登录后刷新页面再试。

### 安装新版后行为没有变化

在 Tampermonkey 编辑器中确认脚本顶部的 `@version`。如果仍是旧版本，请删除旧内容后重新点击一键安装链接，并刷新视频页面。

### 点击后显示网络请求失败

确认脚本管理器已经授予 `api.bilibili.com` 和 `aisubtitle.hdslb.com` 的跨域访问权限。升级或重新安装脚本时，Tampermonkey 可能会再次显示权限确认页面。

### 为什么复制结果没有换行

Bilibili 字幕通常按短句切分。脚本会移除这些显示层面的分段并拼接为连续正文，同时保留字幕内容中真正存在的换行。

## 验证记录

`1.3.0` 已在登录状态下使用公开视频 `BV1LS9eBxEGD` 完成端到端测试：从最终用户脚本读取字幕列表、下载 AI 中文字幕、清洗内容并实际写入剪贴板，共复制 `9298` 个字符。检查结果不包含时间戳和字幕 JSON 边界字段。

## 开发检查

```powershell
node --check .\bilibili-copy-subtitles.user.js
```

提交问题时，请附上脚本版本、视频链接、页面提示，以及浏览器和脚本管理器版本。请勿公开账号 Cookie 或其他登录凭据。

## License

[MIT](./LICENSE)
