// ==UserScript==
// @name         一键复制视频全部字幕（B站 / YouTube / 视频号）
// @namespace    https://github.com/dongyu23/bilibili-copy-subtitles
// @version      2.0.0
// @description  一键复制 Bilibili / YouTube / 微信视频号视频的纯文字内容，去除时间戳和字幕边界并保留正文标点；无字幕视频可回退到 StepFun 语音识别（视频号经元宝解析直链后整包送识别），支持 Key 图形化配置、端点与调试设置、识别进度、耗时统计与缓存留存时间。v2 新增章节选择、流式分段识别、断点续传与独立工作标签页隔离，超长视频不再撑爆渲染进程。
// @author       dongyu23
// @homepageURL  https://github.com/dongyu23/bilibili-copy-subtitles
// @supportURL   https://github.com/dongyu23/bilibili-copy-subtitles/issues
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/404
// @match        https://www.youtube.com/watch*
// @match        https://channels.weixin.qq.com/*
// @match        https://yuanbao.tencent.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_cookie
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      *.hdslb.com
// @connect      *.bilivideo.com
// @connect      *.akamaized.net
// @connect      api.stepfun.com
// @connect      www.youtube.com
// @connect      *.googlevideo.com
// @connect      channels.weixin.qq.com
// @connect      yuanbao.tencent.com
// @connect      finder.video.qq.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dongyu23/bilibili-copy-subtitles/main/bilibili-copy-subtitles.user.js
// @updateURL    https://raw.githubusercontent.com/dongyu23/bilibili-copy-subtitles/main/bilibili-copy-subtitles.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'bili-copy-all-subtitles-button';
  const SELECT_ID = 'bili-copy-all-subtitles-language';
  const CONTROLS_ID = 'bili-copy-all-subtitles-controls';
  const TOAST_ID = 'bili-copy-all-subtitles-toast';
  const HIDDEN_KEY = 'bili-copy-subtitles-button-hidden';
  const WX_BUTTON_ID = 'bili-copy-wxchannels-button';
  const SETTINGS_BUTTON_ID = 'bili-copy-settings-button';
  // v6 起缓存带留存时间；仅本次会话的缓存走 sessionStorage，跨会话走 Tampermonkey 存储。
  const META_CACHE_PREFIX = 'video-subtitles-meta-v6:';
  const BODY_CACHE_PREFIX = 'video-subtitles-body-v6:';
  const memoryCache = new Map();
  const playerApiUrls = [];
  const playerPlayApiUrls = [];
  let asrConsentGiven = false;

  // 站点识别与 YouTube 接口。
  const YOUTUBE_INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const YOUTUBE_PLAYER_API = videoId => `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(YOUTUBE_INNERTUBE_KEY)}&prettyPrint=false`;
  const YOUTUBE_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };

  // 视频号（微信 Channels）转文字：元宝解析分享链接 → finder 接口取直链 → 整包送 StepFun。
  const YUANBAO_PARSE_API = 'https://yuanbao.tencent.com/api/weixin/get_parse_result';
  const YUANBAO_HOME = 'https://yuanbao.tencent.com/chat/';
  const WXCHANNELS_FEED_API = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
  const YUANBAO_COOKIE_SETTING = 'bili-copy-subtitles-yuanbao-cookie-v1';
  const ASR_ENDPOINT_SETTING = 'bili-copy-subtitles-asr-endpoint-v1';
  const ASR_LANGUAGE_SETTING = 'bili-copy-subtitles-asr-language-v1';
  const DEBUG_SETTING = 'bili-copy-subtitles-debug-v1';
  const WX_PANEL_ID = 'bili-copy-wxchannels-panel';
  // 小于该体积的视频整包按 m4a 送识别；超过则浏览器内解码提取 16k 单声道 WAV 后分片送。
  const WX_MAX_WHOLE_BYTES = 20 * 1024 * 1024;
  const WX_WAV_CHUNK_BYTES = 10 * 1024 * 1024;

  function detectSite() {
    const host = location.hostname;
    if (host.endsWith('bilibili.com')) return 'bilibili';
    if (host.endsWith('youtube.com')) return 'youtube';
    if (host.endsWith('channels.weixin.qq.com')) return 'wxchannels';
    if (host.endsWith('yuanbao.tencent.com')) return 'yuanbao';
    return '';
  }
  const site = detectSite();

  // 无字幕视频的语音识别兜底（Step Plan）。
  const ASR_SSE_ENDPOINT = 'https://api.stepfun.com/step_plan/v1/audio/asr/sse';
  const ASR_MODELS_ENDPOINT = 'https://api.stepfun.com/v1/models';
  const ASR_MODEL = 'stepaudio-2.5-asr';
  const ASR_LANGUAGE = 'zh';
  const ASR_API_KEY_SETTING = 'bili-copy-subtitles-asr-key-v1';
  const ASR_HISTORY_KEY = 'bili-copy-subtitles-asr-history-v1';
  // 默认不内置 Key：首次使用无字幕视频时会自动弹出配置面板，Key 仅保存在浏览器本地。
  const DEFAULT_ASR_API_KEY = '';
  // B 站 DASH 音轨为自包含 fMP4（ftyp+moov+sidx+moof/mdat），按 moof 边界分片后每片都可独立识别。
  const MAX_AUDIO_CHUNK_BYTES = 12 * 1024 * 1024;
  // 分片之间无依赖，可并行送识别；StepFun 未公布单 Key 并发上限，保守取 3，触发限流再调低。
  const ASR_CONCURRENCY = 3;
  const ASR_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

  // ===== Fork v2：章节选择 / 流式分段下载 / 断点续传 / 独立工作标签页 =====
  const CHAPTER_CACHE_PREFIX = 'video-chapters-v1:';
  const CHECKPOINT_PREFIX = 'asr-checkpoint-v2:';
  const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const AUDIO_WINDOW_BYTES = 32 * 1024 * 1024;   // 流式下载滑动窗口
  const ASR_INFLIGHT_BUDGET = 24 * 1024 * 1024;  // 在途分片总字节上限（控制并发瞬态）
  const PROBE_BYTES = 128 * 1024;                // 时间->字节 探测窗口（128KB 足够容纳多个音频分片）
  const LONG_VIDEO_WARN_S = 3600;                // 超过 1 小时给出提示
  const WORKER_TAB_NAME = 'bili-asr-worker';
  const WORKER_TAB_URL = 'https://www.bilibili.com/404';

  const isWorkerTab = () => { try { return window.name === WORKER_TAB_NAME; } catch (_) { return false; } };
  const PROGRESS_PANEL_ID = 'bili-copy-asr-progress';
  const KEY_PANEL_ID = 'bili-copy-asr-key-panel';

  // 缓存留存时间（毫秒）；0 = 仅本次会话，-1 = 永久。
  const CACHE_TTL_SETTING = 'bili-copy-subtitles-cache-ttl-v1';
  const CACHE_TTL_OPTIONS = [
    { label: '仅本次会话（刷新保留，关闭标签页清除）', value: 0 },
    { label: '1 小时', value: 60 * 60 * 1000 },
    { label: '24 小时', value: 24 * 60 * 60 * 1000 },
    { label: '7 天', value: 7 * 24 * 60 * 60 * 1000 },
    { label: '30 天', value: 30 * 24 * 60 * 60 * 1000 },
    { label: '永久', value: -1 },
  ];

  function getCacheTtlMs() {
    const value = Number(GM_getValue(CACHE_TTL_SETTING, 0));
    if (Number.isNaN(value)) return 0;
    return CACHE_TTL_OPTIONS.some(option => option.value === value) ? value : 0;
  }

  // ===== 可配置项：识别端点 / 语言 / 调试 / 元宝 Cookie =====

  function getAsrEndpoint() {
    return String(GM_getValue(ASR_ENDPOINT_SETTING, ASR_SSE_ENDPOINT) || ASR_SSE_ENDPOINT).trim() || ASR_SSE_ENDPOINT;
  }

  function getAsrLanguage() {
    const value = String(GM_getValue(ASR_LANGUAGE_SETTING, ASR_LANGUAGE) || ASR_LANGUAGE).trim();
    return value || ASR_LANGUAGE;
  }

  function getDebugEnabled() {
    return GM_getValue(DEBUG_SETTING, false) === true;
  }

  function getYuanbaoCookie() {
    return String(GM_getValue(YUANBAO_COOKIE_SETTING, '') || '').trim();
  }

  function debugLog(...args) {
    if (getDebugEnabled()) console.log('[复制字幕][调试]', ...args);
  }

  // GM_cookie 是回调式 API（个别版本返回 Promise），统一包成 Promise。
  function gmCookieList(details) {
    return new Promise((resolve, reject) => {
      if (typeof GM_cookie === 'undefined' || typeof GM_cookie.list !== 'function') {
        reject(new Error('当前脚本管理器不支持 GM_cookie'));
        return;
      }
      const maybe = GM_cookie.list(details, cookies => resolve(cookies || []));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    });
  }

  // 统计/追踪类 Cookie 对接口解析没有用处，读取时过滤掉，只保留有效字段。
  const COOKIE_NOISE_PATTERN = /^(_qimei|_ga|_gid|_gat|_gtag|_TDID|_gcl|_fbp|_hj|_paq)/i;

  // 通过油猴特权读取元宝域下全部 Cookie（含 HttpOnly，网页本身读不到），过滤后拼成 Cookie 头。
  async function readYuanbaoCookieAutomatically() {
    const cookies = await gmCookieList({ url: YUANBAO_HOME, domain: 'yuanbao.tencent.com' });
    const useful = (cookies || []).filter(cookie => cookie && cookie.name && !COOKIE_NOISE_PATTERN.test(cookie.name));
    if (useful.length === 0) {
      throw new Error('未读取到元宝 Cookie，请先点「打开元宝」并登录');
    }
    const cookieString = useful.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    debugLog('自动读取元宝 Cookie', { total: (cookies || []).length, useful: useful.length });
    return { cookieString, total: (cookies || []).length, useful: useful.length };
  }

  function rememberPlayerApiUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.hostname !== 'api.bilibili.com' || url.pathname !== '/x/player/wbi/v2') return;
      const href = url.href;
      const previousIndex = playerApiUrls.indexOf(href);
      if (previousIndex >= 0) playerApiUrls.splice(previousIndex, 1);
      playerApiUrls.push(href);
      if (playerApiUrls.length > 30) playerApiUrls.splice(0, playerApiUrls.length - 30);
    } catch (_) {
      // Ignore malformed resource URLs.
    }
  }

  // 播放器自身发出的音频地址请求，与字幕请求分开存放，避免互相干扰。
  function rememberPlayerPlayApiUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.hostname !== 'api.bilibili.com') return;
      if (url.pathname !== '/x/player/playurl' && url.pathname !== '/x/player/wbi/playurl') return;
      const href = url.href;
      const previousIndex = playerPlayApiUrls.indexOf(href);
      if (previousIndex >= 0) playerPlayApiUrls.splice(previousIndex, 1);
      playerPlayApiUrls.push(href);
      if (playerPlayApiUrls.length > 30) playerPlayApiUrls.splice(0, playerPlayApiUrls.length - 30);
    } catch (_) {
      // Ignore malformed resource URLs.
    }
  }

  performance.getEntriesByType('resource').forEach(entry => {
    rememberPlayerApiUrl(entry.name);
    rememberPlayerPlayApiUrl(entry.name);
  });
  new PerformanceObserver(list => {
    list.getEntries().forEach(entry => {
      rememberPlayerApiUrl(entry.name);
      rememberPlayerPlayApiUrl(entry.name);
    });
  }).observe({ type: 'resource', buffered: true });

  GM_addStyle(`
    #${CONTROLS_ID} {
      position: fixed;
      z-index: 100001;
      left: 8px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: stretch;
      width: 124px;
    }
    #${BUTTON_ID} {
      width: 100%;
      min-height: 44px;
      padding: 8px 7px;
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: #00aeec;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      cursor: pointer;
      transition: background .18s ease, transform .18s ease, opacity .18s ease;
    }
    #${BUTTON_ID}:hover { background: #009bd3; transform: translateY(-2px); }
    #${BUTTON_ID}:disabled { cursor: wait; opacity: .72; transform: none; }
    #${CONTROLS_ID}[data-hidden="true"] { display: none; }
    /* 视频号入口：次级样式，不抢主按钮视觉。 */
    #${WX_BUTTON_ID} {
      width: 100%;
      min-height: 30px;
      padding: 5px 7px;
      border: 1px solid rgba(0, 0, 0, .12);
      border-radius: 6px;
      color: #61666d;
      background: rgba(255, 255, 255, .92);
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      transition: background .18s ease, color .18s ease;
    }
    #${WX_BUTTON_ID}:hover { background: #fff; color: #00aeec; }
    /* 设置入口：刻意弱化的齿轮，平时不显眼；淡底保证暗色主题下也找得到。 */
    #${SETTINGS_BUTTON_ID} {
      width: 28px;
      min-height: 24px;
      align-self: flex-end;
      padding: 0;
      border: 0;
      border-radius: 5px;
      color: #9499a0;
      background: rgba(127, 127, 127, .14);
      font: 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      opacity: .6;
      transition: opacity .18s ease, color .18s ease, background .18s ease;
    }
    #${SETTINGS_BUTTON_ID}:hover { opacity: 1; color: #61666d; background: rgba(127, 127, 127, .26); }
    #${WX_PANEL_ID} {
      position: fixed;
      z-index: 100002;
      left: 8px;
      bottom: 16px;
      width: 300px;
      max-width: calc(100vw - 24px);
      padding: 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .97);
      box-shadow: 0 6px 24px rgba(0, 0, 0, .22);
      display: flex;
      flex-direction: column;
      gap: 8px;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #18191c;
    }
    #${WX_PANEL_ID}[data-hidden="true"] { display: none; }
    #${WX_PANEL_ID} .wx-title { font-size: 13px; font-weight: 600; }
    #${WX_PANEL_ID} .wx-input {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid rgba(0, 0, 0, .15);
      border-radius: 6px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      word-break: break-all;
    }
    #${WX_PANEL_ID} .wx-row { display: flex; gap: 8px; }
    #${WX_PANEL_ID} .wx-row button {
      flex: 1;
      padding: 6px 0;
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: #00aeec;
      cursor: pointer;
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${WX_PANEL_ID} .wx-row button:hover { background: #009bd3; }
    #${WX_PANEL_ID} .wx-row button.ghost { background: #e3e5e7; color: #18191c; }
    #${WX_PANEL_ID} .wx-row button.ghost:hover { background: #d7d9dc; }
    #${WX_PANEL_ID} .wx-row button:disabled { cursor: wait; opacity: .6; }
    #${WX_PANEL_ID} .wx-status { min-height: 16px; color: #61666d; font-size: 11px; word-break: break-all; }
    #${WX_PANEL_ID} .wx-result {
      width: 100%;
      box-sizing: border-box;
      min-height: 120px;
      max-height: 260px;
      padding: 8px;
      border: 1px solid rgba(0, 0, 0, .12);
      border-radius: 6px;
      font: 12px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      resize: vertical;
      word-break: break-all;
    }
    #${SELECT_ID} {
      width: 100%;
      min-height: 30px;
      padding: 5px 6px;
      border: 1px solid rgba(0, 0, 0, .12);
      border-radius: 6px;
      color: #18191c;
      background: #fff;
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${TOAST_ID} {
      position: fixed;
      z-index: 100006;
      left: 50%;
      top: 72px;
      max-width: min(560px, calc(100vw - 40px));
      padding: 11px 18px;
      border-radius: 6px;
      color: #fff;
      background: rgba(20, 20, 20, .9);
      box-shadow: 0 5px 20px rgba(0, 0, 0, .2);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      text-align: center;
      transform: translateX(-50%);
      pointer-events: none;
    }
    #${KEY_PANEL_ID} {
      position: fixed;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 100005;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, .45);
    }
    #${KEY_PANEL_ID} .panel {
      width: 360px;
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 40px);
      overflow: auto;
      padding: 18px;
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 8px 30px rgba(0, 0, 0, .25);
      display: flex;
      flex-direction: column;
      gap: 10px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #18191c;
    }
    #${KEY_PANEL_ID} .panel-title { font-size: 15px; font-weight: 600; }
    #${KEY_PANEL_ID} .panel-status { color: #61666d; font-size: 12px; word-break: break-all; }
    #${KEY_PANEL_ID} .key-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid rgba(0, 0, 0, .15);
      border-radius: 6px;
      font: 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      /* 视觉遮罩：用 text 输入 + CSS 打点，避免被浏览器密码管理器识别为密码框。 */
      -webkit-text-security: disc;
    }
    #${KEY_PANEL_ID} .panel-test {
      min-height: 16px;
      font-size: 12px;
      color: #9499a0;
      word-break: break-all;
    }
    #${KEY_PANEL_ID} .panel-row { display: flex; gap: 8px; }
    #${KEY_PANEL_ID} .panel-row button {
      flex: 1;
      padding: 7px 0;
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: #00aeec;
      cursor: pointer;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${KEY_PANEL_ID} .panel-row button:hover { background: #009bd3; }
    #${KEY_PANEL_ID} .panel-row button.ghost { background: #e3e5e7; color: #18191c; }
    #${KEY_PANEL_ID} .panel-row button.ghost:hover { background: #d7d9dc; }
    #${KEY_PANEL_ID} .panel-row button:disabled { cursor: wait; opacity: .6; }
    #${KEY_PANEL_ID} .panel-hint { color: #9499a0; font-size: 12px; }
    #${KEY_PANEL_ID} .panel-label { font-size: 12px; font-weight: 600; color: #61666d; }
    #${KEY_PANEL_ID} .text-input {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid rgba(0, 0, 0, .15);
      border-radius: 6px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #${KEY_PANEL_ID} .cookie-input {
      width: 100%;
      box-sizing: border-box;
      min-height: 64px;
      padding: 7px 9px;
      border: 1px solid rgba(0, 0, 0, .15);
      border-radius: 6px;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      resize: vertical;
      word-break: break-all;
    }
    #${KEY_PANEL_ID} .check-line {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: #61666d;
      cursor: pointer;
    }
    #${KEY_PANEL_ID} .check-line input { margin: 0; cursor: pointer; }
    #${KEY_PANEL_ID} .ttl-select {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 8px;
      border: 1px solid rgba(0, 0, 0, .15);
      border-radius: 6px;
      background: #fff;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #18191c;
    }
    #${KEY_PANEL_ID} .cache-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #61666d; }
    #${KEY_PANEL_ID} .cache-line button {
      padding: 4px 10px;
      border: 0;
      border-radius: 4px;
      color: #fff;
      background: #f56c6c;
      cursor: pointer;
      font-size: 12px;
    }
    #${PROGRESS_PANEL_ID} {
      position: fixed;
      z-index: 100004;
      left: 8px;
      bottom: 76px;
      width: 232px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(20, 20, 20, .92);
      color: #fff;
      box-shadow: 0 5px 20px rgba(0, 0, 0, .25);
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #${PROGRESS_PANEL_ID} .stage { font-weight: 600; }
    #${PROGRESS_PANEL_ID} .bar {
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      background: rgba(255, 255, 255, .18);
    }
    #${PROGRESS_PANEL_ID} .fill {
      height: 100%;
      width: 0;
      border-radius: 3px;
      background: #00aeec;
      transition: width .2s ease;
    }
    #${PROGRESS_PANEL_ID} .fill.indeterminate {
      width: 100%;
      background: linear-gradient(90deg, #00aeec 0%, #8fe3ff 50%, #00aeec 100%);
      background-size: 200% 100%;
      animation: bili-asr-slide 1.2s linear infinite;
    }
    @keyframes bili-asr-slide {
      from { background-position: 100% 0; }
      to { background-position: -100% 0; }
    }
    #${PROGRESS_PANEL_ID} .detail { color: rgba(255, 255, 255, .75); font-size: 11px; }
    @media (max-width: 760px) {
      #${CONTROLS_ID} { left: 6px; bottom: 76px; width: 118px; }
      #${PROGRESS_PANEL_ID} { left: 6px; bottom: 136px; width: 206px; }
    }
  `);

  function requestJsonByGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`油猴请求返回 HTTP ${response.status}`);
            }
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(error);
          }
        },
        ontimeout: () => reject(new Error('油猴请求超时')),
        onerror: response => reject(
          new Error(`油猴请求失败${response?.status ? `（HTTP ${response.status}）` : ''}`)
        ),
      });
    });
  }

  async function requestJson(url, options = {}) {
    const credentials = options.credentials || 'include';
    let fetchError;
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`浏览器请求返回 HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      fetchError = error;
    }

    try {
      return await requestJsonByGM(url);
    } catch (gmError) {
      const host = (() => {
        try { return new URL(url, location.href).host; } catch (_) { return '未知地址'; }
      })();
      throw new Error(
        `${host} 请求失败：${gmError.message}；浏览器请求：${fetchError?.message || '失败'}`
      );
    }
  }

  // 文本响应（YouTube 字幕为 XML）。
  async function requestText(url) {
    let fetchError;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`浏览器请求返回 HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      fetchError = error;
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`油猴请求返回 HTTP ${response.status}`));
            return;
          }
          resolve(response.responseText);
        },
        ontimeout: () => reject(new Error('油猴请求超时')),
        onerror: response => reject(
          new Error(`油猴请求失败${response?.status ? `（HTTP ${response.status}）` : ''}`)
        ),
      });
    }).catch(error => {
      throw new Error(`${error.message || error}；浏览器请求：${fetchError?.message || '失败'}`);
    });
  }

  async function requestJsonPost(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
    return response.json();
  }

  // ===== 缓存（带留存时间） =====

  function readCache(prefix, key) {
    const fullKey = `${prefix}${key}`;
    const memory = memoryCache.get(fullKey);
    if (memory) return memory.value;
    try {
      const raw = sessionStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'value')) {
          memoryCache.set(fullKey, parsed);
          return parsed.value;
        }
      }
    } catch (_) {
      // 忽略存储异常
    }

    const ttl = getCacheTtlMs();
    if (ttl === 0) return null; // 仅本次会话，不读持久层
    try {
      const raw = GM_getValue(fullKey, '');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'value')) return null;
      if (ttl > 0 && Date.now() - Date.parse(parsed.cachedAt) > ttl) return null; // 已过期
      memoryCache.set(fullKey, parsed);
      return parsed.value;
    } catch (_) {
      return null;
    }
  }

  function writeCache(prefix, key, value) {
    const fullKey = `${prefix}${key}`;
    const entry = { value, cachedAt: new Date().toISOString() };
    memoryCache.set(fullKey, entry);
    try { sessionStorage.setItem(fullKey, JSON.stringify(entry)); } catch (_) { /* storage may be disabled */ }
    if (getCacheTtlMs() !== 0) {
      try { GM_setValue(fullKey, JSON.stringify(entry)); } catch (_) { /* 忽略存储异常 */ }
    }
  }

  function listCacheKeys() {
    if (typeof GM_listValues !== 'function') return [];
    try {
      return GM_listValues().filter(key => key.startsWith(META_CACHE_PREFIX) || key.startsWith(BODY_CACHE_PREFIX));
    } catch (_) {
      return [];
    }
  }

  function clearAllCaches() {
    memoryCache.clear();
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(META_CACHE_PREFIX) || key.startsWith(BODY_CACHE_PREFIX)) {
          sessionStorage.removeItem(key);
        }
      }
    } catch (_) {
      // 忽略存储异常
    }
    for (const key of listCacheKeys()) {
      try { GM_deleteValue(key); } catch (_) { /* 忽略存储异常 */ }
    }
  }

  // ===== Fork：章节 / 流式分段 / 断点 =====

  function concatU8(a, b) {
    if (!a.length) return b;
    if (!b.length) return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function readU32(bytes, off) {
    return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  }
  function readU64(bytes, off) {
    return readU32(bytes, off) * 0x100000000 + readU32(bytes, off + 4);
  }
  function boxTypeAt(bytes, off) {
    return String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
  }
  function walkBoxes(bytes, start, end) {
    const boxes = [];
    let off = start;
    while (off + 8 <= end) {
      const size = readU32(bytes, off);
      if (size < 8 || off + size > end) break; // 半包，留给下一轮补窗口
      boxes.push({ type: boxTypeAt(bytes, off), start: off, size });
      off += size;
    }
    return boxes;
  }
  const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'moof']);
  function collectBoxes(bytes, start, end, type, out = [], depth = 0) {
    if (depth > 6) return out;
    for (const box of walkBoxes(bytes, start, end)) {
      if (box.type === type) out.push(box);
      if (CONTAINER_BOXES.has(box.type)) {
        collectBoxes(bytes, box.start + 8, Math.min(box.start + box.size, end), type, out, depth + 1);
      }
    }
    return out;
  }
  function parseTimescale(bytes, start, end) {
    const mdhd = collectBoxes(bytes, start, end, 'mdhd')[0];
    if (!mdhd) return 1000;
    const version = bytes[mdhd.start + 8];
    return version === 1 ? readU32(bytes, mdhd.start + 28) : readU32(bytes, mdhd.start + 20);
  }
  function parseMoofTimeMs(bytes, moofStart, timescale) {
    const moofSize = readU32(bytes, moofStart);
    const tfdt = collectBoxes(bytes, moofStart + 8, moofStart + moofSize, 'tfdt')[0];
    if (!tfdt) return null;
    const version = bytes[tfdt.start + 8];
    const raw = version === 1 ? readU64(bytes, tfdt.start + 12) : readU32(bytes, tfdt.start + 12);
    return (raw / timescale) * 1000;
  }

  // 带 Range 的请求；CDN 忽略 Range 返回 200 全量时直接拒绝（调用方走兜底）
  let gmRangeUsable = true;

  async function gmRangeRequest(url, start, end) {
    const rangeValue = end == null ? `bytes=${start}-` : `bytes=${start}-${end}`;
    let host = url;
    try { host = new URL(url).host; } catch (_) { /* ignore */ }
    const span = (end == null ? 0 : end - start) + 1;
    const timeoutMs = span <= 256 * 1024 ? 20000 : span <= 2 * 1024 * 1024 ? 45000 : 180000;
    // 优先油猴特权请求（无跨域限制）；传输层失败一次即熔断，后续全部直接走页面 fetch
    if (gmRangeUsable) {
      try {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: { Range: rangeValue },
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            onload: r => {
              if (r.status !== 206 && r.status !== 200) { reject(new Error(`HTTP ${r.status}（${host}）`)); return; }
              if (r.status === 200 && start > 0) { reject(new Error('CDN 不支持 Range')); return; }
              const bytes = new Uint8Array(r.response || []);
              let total = null;
              const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(r.responseHeaders || '');
              if (m) total = Number(m[1]);
              resolve({ bytes, total });
            },
            onerror: () => { gmRangeUsable = false; reject(new Error(`油猴请求失败（${host}）`)); },
            ontimeout: () => { gmRangeUsable = false; reject(new Error(`请求超时（${host}）`)); },
          });
        });
      } catch (gmError) {
        console.warn('[复制字幕] 油猴 Range 请求失败，本次起改走页面 fetch', gmError.message);
      }
    }
    const resp = await fetch(url, { headers: { Range: rangeValue }, cache: 'no-store' });
    if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}（${host}）`);
    if (resp.status === 200 && start > 0) throw new Error('CDN 不支持 Range');
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(resp.headers.get('Content-Range') || '');
    return { bytes, total: m ? Number(m[1]) : null };
  }

  // 取音频头部（ftyp+moov+sidx）与 timescale
  // sidx（分段索引）：给出每个媒体分片的字节位置与时长，可把章节定位从上百次探测降到 1 次校验
  function parseSidx(bytes, sidxStart) {
    try {
      const size = readU32(bytes, sidxStart);
      const version = bytes[sidxStart + 8];
      let off = sidxStart + 12 + 4; // version/flags + reference_ID
      const timescale = readU32(bytes, off); off += 4;
      let firstOffset = 0;
      if (version === 0) { off += 4; firstOffset = readU32(bytes, off); off += 4; }
      else { off += 8; firstOffset = Number(readU64(bytes, off)); off += 8; }
      off += 2; // reserved
      const refCount = readU32(bytes, off) & 0xFFFF; off += 2;
      if (!refCount || refCount > 100000) return null;
      const base = sidxStart + size + firstOffset; // 常见布局：首个分片紧跟 sidx 之后
      const refs = [];
      let cursor = base;
      let totalMs = 0;
      for (let i = 0; i < refCount && off + 12 <= sidxStart + size; i++) {
        const word = readU32(bytes, off);
        const refSize = word & 0x7FFFFFFF;
        const durationRaw = readU32(bytes, off + 4);
        off += 12;
        if (refSize <= 0) return null;
        const durationMs = (durationRaw / timescale) * 1000;
        refs.push({ start: cursor, size: refSize, durationMs });
        cursor += refSize;
        totalMs += durationMs;
      }
      if (!refs.length) return null;
      return { timescale, refs, avgDurationMs: totalMs / refs.length };
    } catch (_) { return null; }
  }

  function byteFromSidx(sidx, tMs) {
    let t = 0;
    for (const ref of sidx.refs) {
      if (t + ref.durationMs > tMs) return { start: ref.start, durationMs: ref.durationMs };
      t += ref.durationMs;
    }
    const last = sidx.refs[sidx.refs.length - 1];
    return { start: last.start, durationMs: last.durationMs };
  }

  async function fetchAudioHeader(url) {
    let size = 1024 * 1024;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { bytes, total } = await gmRangeRequest(url, 0, size - 1);
      const boxes = walkBoxes(bytes, 0, bytes.length);
      const firstMoof = boxes.find(b => b.type === 'moof');
      if (firstMoof) {
        const sidxBox = boxes.find(b => b.type === 'sidx' && b.start < firstMoof.start);
        return {
          header: bytes.slice(0, firstMoof.start),
          headerEnd: firstMoof.start,
          timescale: parseTimescale(bytes, 0, firstMoof.start),
          sidx: sidxBox ? parseSidx(bytes, sidxBox.start) : null,
          total,
        };
      }
      size *= 8;
    }
    throw new Error('音频头部解析失败（未找到 moof，可能不是 fMP4/DASH 音轨）');
  }

  async function probeTimeAt(url, pos, headerInfo) {
    const { bytes } = await gmRangeRequest(url, pos, pos + PROBE_BYTES - 1);
    // 窗口起点可能落在 box 中间导致走包失步，先按 moof 四字节特征扫描再校验
    for (let i = 0; i + 8 <= bytes.length; i++) {
      if (bytes[i + 4] !== 0x6d || bytes[i + 5] !== 0x6f || bytes[i + 6] !== 0x6f || bytes[i + 7] !== 0x66) continue;
      const size = readU32(bytes, i);
      if (size < 8 || i + size > bytes.length) continue;
      const t = parseMoofTimeMs(bytes, i, headerInfo.timescale);
      if (t != null) return { timeMs: t, bytePos: pos + i };
    }
    return null;
  }

  // 时间 -> 字节：优先 sidx 索引快路径（1 次探测校验），不可信再二分
  async function findByteForTime(url, totalSize, tMs, headerInfo) {
    if (headerInfo.sidx && headerInfo.sidx.refs.length) {
      const candidate = byteFromSidx(headerInfo.sidx, tMs);
      if (candidate.start > 0 && candidate.start < totalSize) {
        try {
          const p = await probeTimeAt(url, candidate.start, headerInfo);
          if (p && p.timeMs >= tMs - candidate.durationMs && p.timeMs < tMs + candidate.durationMs * 2) {
            return p.bytePos;
          }
        } catch (_) { /* 索引不可信，走二分 */ }
      }
    }
    let lo = 0, hi = totalSize;
    for (let i = 0; i < 12 && hi - lo > PROBE_BYTES; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const p = await probeTimeAt(url, mid, headerInfo);
      if (!p) { hi = mid; continue; }
      if (p.timeMs < tMs) lo = mid; else hi = mid;
    }
    const { bytes } = await gmRangeRequest(url, lo, lo + PROBE_BYTES - 1);
    for (const b of walkBoxes(bytes, 0, bytes.length)) {
      if (b.type !== 'moof') continue;
      const t = parseMoofTimeMs(bytes, b.start, headerInfo.timescale);
      if (t != null && t >= tMs) return lo + b.start;
    }
    return lo;
  }

  // 流式分段：只保留滑动窗口，按 moof+mdat 边界凑片，每片拼头部保证可独立解码
  async function* streamRangeChunks(url, headerInfo, range, maxChunkBytes, onProgress, refreshTrack) {
    let curUrl = url;
    let pos = range.start;
    let buf = new Uint8Array(0);
    let pending = [];
    let pendingSize = 0;
    let seenMoof = false;
    let eof = false;
    const flush = () => {
      if (!pending.length) return null;
      let total = headerInfo.header.length;
      for (const f of pending) total += f.length;
      const chunk = new Uint8Array(total);
      chunk.set(headerInfo.header, 0);
      let c = headerInfo.header.length;
      for (const f of pending) { chunk.set(f, c); c += f.length; }
      pending = [];
      pendingSize = 0;
      return chunk;
    };
    while (!eof || buf.length) {
      while (!eof && buf.length < AUDIO_WINDOW_BYTES && pos + buf.length < range.end) {
        const start = pos + buf.length;
        const want = Math.min(AUDIO_WINDOW_BYTES - buf.length, range.end - start);
        try {
          const r = await gmRangeRequest(curUrl, start, start + want - 1);
          if (!r.bytes.length) { eof = true; break; }
          buf = concatU8(buf, r.bytes);
        } catch (error) {
          if (refreshTrack) {
            try {
              const t = await refreshTrack();
              if (t && t.url) { curUrl = t.url; continue; }
            } catch (_) { /* 交给外层抛出 */ }
          }
          throw error;
        }
      }
      let off = 0;
      while (off + 8 <= buf.length) {
        const size = readU32(buf, off);
        if (size < 8 || off + size > buf.length) break;
        const type = boxTypeAt(buf, off);
        if (type === 'moof') {
          const t = parseMoofTimeMs(buf, off, headerInfo.timescale);
          if (t != null && t >= range.endMs) { // 到达章节末尾，收尾
            eof = true;
            break;
          }
          seenMoof = true;
          if (pendingSize + size > maxChunkBytes && pending.length) {
            const chunk = flush();
            if (chunk) yield chunk;
          }
        }
        if (seenMoof) {
          pending.push(buf.slice(off, off + size));
          pendingSize += size;
        }
        off += size;
      }
      pos += off;
      if (off) buf = buf.slice(off);
      if (onProgress && range.end > range.start) {
        try { onProgress(Math.min(1, pos / range.end)); } catch (_) { /* ignore */ }
      }
      if (eof && !buf.length) {
        const chunk = flush();
        if (chunk) yield chunk;
      }
    }
  }

  // 断点：按片落 GM 存储，重跑跳过已完成片
  function checkpointKey(videoKey, selHash, rangeIdx, chunkIdx) {
    return `${CHECKPOINT_PREFIX}${videoKey}|${selHash}|${rangeIdx}|${chunkIdx}`;
  }
  function readCheckpoint(key) {
    try {
      const raw = GM_getValue(key, '');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - Date.parse(parsed.cachedAt) > CHECKPOINT_MAX_AGE_MS) return null;
      return parsed.value;
    } catch (_) { return null; }
  }
  function writeCheckpoint(key, value) {
    try { GM_setValue(key, JSON.stringify({ value, cachedAt: new Date().toISOString() })); } catch (_) { /* ignore */ }
  }
  function clearCheckpointsFor(videoKey, selHash) {
    if (typeof GM_listValues !== 'function') return;
    const prefix = `${CHECKPOINT_PREFIX}${videoKey}|${selHash}|`;
    for (const k of GM_listValues()) {
      if (k.startsWith(prefix)) { try { GM_deleteValue(k); } catch (_) { /* ignore */ } }
    }
  }

  // 有界并发：在途总字节不超过预算，顺序由 index 保证
  async function mapWithBudget(iter, fn, budgetBytes) {
    const out = [];
    let inflight = 0;
    let index = 0;
    let pullDone = false;
    let error = null;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const worker = async () => {
      while (!pullDone && !error) {
        while (inflight >= budgetBytes && !pullDone && !error) await sleep(60);
        if (pullDone || error) return;
        const r = await iter.next();
        if (r.done) { pullDone = true; return; }
        const idx = index++;
        inflight += r.value.length;
        try { out[idx] = await fn(r.value, idx); } catch (e) { error = e; }
        finally { inflight -= r.value.length; }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (error) throw error;
    return out;
  }

  async function fetchVideoChapters(video) {
    if (video.site !== 'bilibili') return null;
    try {
      const params = new URLSearchParams({ cid: String(video.cid) });
      if (video.bvid) params.set('bvid', video.bvid);
      else if (video.aid) params.set('aid', String(video.aid));
      const result = await requestJson(`https://api.bilibili.com/x/player/v2?${params.toString()}`);
      if (!result || result.code !== 0) return null;
      const raw = Array.isArray(result.data && result.data.view_points) ? result.data.view_points : [];
      const points = raw.filter(p => p && Number.isFinite(Number(p.from)) && Number.isFinite(Number(p.to)) && Number(p.to) > Number(p.from));
      if (points.length < 2) return null; // 0/1 个点等于没有章节
      return points.map((p, i) => ({
        id: `ch-${i}-${Number(p.from)}`,
        title: String(p.content || `章节 ${i + 1}`).slice(0, 60),
        startMs: Number(p.from) * 1000,
        endMs: Number(p.to) * 1000,
      }));
    } catch (error) {
      console.warn('[复制字幕] 章节获取失败，按无章节处理', error);
      return null;
    }
  }

  function selectionHash(selection) {
    if (!selection || selection.mode === 'full') return 'full';
    return 'ch:' + selection.ranges.map(r => r.id || r.startMs).join(',');
  }
  function selectionDurationMs(selection, totalMs) {
    if (!selection || selection.mode === 'full') return totalMs;
    return selection.ranges.reduce((sum, r) => sum + Math.max(0, r.endMs - r.startMs), 0);
  }
  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
  }

  function showChapterPanel(chapters, track) {
    return new Promise(resolve => {
      console.log('[复制字幕] 章节数据', chapters);
      const totalMs = (track && track.duration ? track.duration : 0) * 1000;
      // shadow DOM 承载，页面自身 CSS 无法穿透，杜绝样式干扰
      const host = document.createElement('div');
      host.id = 'bili-sub-chapter-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483646';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        .overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#222}
        .panel{background:#fff;color:#222;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.35);width:min(430px,92vw);max-height:80vh;display:flex;flex-direction:column}
        .title{font-size:16px;font-weight:600;padding:14px 16px 4px;color:#222}
        .hint{font-size:12px;color:#888;padding:0 16px 8px}
        .list{overflow-y:auto;padding:4px 16px;flex:1}
        .row{display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:6px;cursor:pointer;color:#222;font-size:14px}
        .row:hover{background:#f2f3f5}
        .row input{width:15px;height:15px;cursor:pointer;flex:none;margin:0}
        .row.dim{opacity:.45}
        .full{font-weight:600;border-bottom:1px solid #eee;margin-bottom:4px}
        .actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #eee}
        .actions button{border:1px solid #d9d9d9;background:#fff;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px;color:#222}
        .actions button.ok{background:#00aeec;border-color:#00aeec;color:#fff}
      `;
      root.appendChild(style);
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const panel = document.createElement('div');
      panel.className = 'panel';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = '选择识别范围';
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '默认全篇；取消“全篇”后可自由勾选章节，仅识别所选内容。';
      const list = document.createElement('div');
      list.className = 'list';

      const fullRow = document.createElement('label');
      fullRow.className = 'row full';
      const fullCb = document.createElement('input');
      fullCb.type = 'checkbox';
      fullCb.checked = true;
      const fullText = document.createElement('span');
      fullText.textContent = `全篇（${fmtClock(totalMs)}）`;
      fullRow.appendChild(fullCb);
      fullRow.appendChild(fullText);
      list.appendChild(fullRow);

      const boxes = [];
      chapters.forEach((ch, i) => {
        const row = document.createElement('label');
        row.className = 'row dim';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        const span = document.createElement('span');
        // 渲染期兜底：标题为空也显示“章节 N”，绝不留空行
        span.textContent = `${ch.title || `章节 ${i + 1}`}（${fmtClock(ch.startMs)} - ${fmtClock(ch.endMs)}）`;
        span.title = JSON.stringify(ch);
        row.appendChild(cb);
        row.appendChild(span);
        list.appendChild(row);
        boxes.push({ cb, row });
      });

      const syncMode = () => {
        const full = fullCb.checked;
        for (const b of boxes) b.row.classList.toggle('dim', full);
      };
      fullCb.addEventListener('change', () => {
        if (fullCb.checked) for (const b of boxes) b.cb.checked = false;
        syncMode();
      });
      for (const b of boxes) {
        b.cb.addEventListener('change', () => {
          if (b.cb.checked) fullCb.checked = false;
          syncMode();
        });
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.textContent = '开始识别';
      okBtn.className = 'ok';
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);

      const close = result => {
        window.removeEventListener('keydown', onKey);
        host.remove();
        resolve(result);
      };
      const onKey = e => { if (e.key === 'Escape') close(null); };
      cancelBtn.addEventListener('click', () => close(null));
      okBtn.addEventListener('click', () => {
        if (fullCb.checked) { close({ mode: 'full' }); return; }
        const picked = chapters.filter((_, i) => boxes[i].cb.checked);
        if (!picked.length) { showToast('请至少勾选一个章节，或保持全篇'); return; }
        close({ mode: 'chapters', ranges: picked });
      });
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      window.addEventListener('keydown', onKey);

      panel.appendChild(title);
      panel.appendChild(hint);
      panel.appendChild(list);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      root.appendChild(overlay);
      document.body.appendChild(host);
    });
  }

  // ===== Fork：工作标签页（重活隔离执行，崩溃也碰不到视频页的存储）=====
  function decorateWorkerPage() {
    try {
      document.title = '字幕识别 · 后台工作页';
      document.documentElement.style.background = '#f6f7f8';
      document.body.innerHTML = '<div style="font:14px/1.8 system-ui,\'Microsoft YaHei\',sans-serif;color:#333;max-width:440px;margin:14vh auto;padding:26px 30px;background:#fff;border-radius:12px;box-shadow:0 6px 28px rgba(0,0,0,.08)">'
        + '<div style="font-size:16px;font-weight:600;margin-bottom:6px">字幕识别 · 后台工作页</div>'
        + '<div style="color:#999;font-size:12px;margin-bottom:14px">语音识别正在此标签页后台运行，请勿关闭；完成后会自动关闭。</div>'
        + '<div id="asr-worker-status" style="padding:10px 12px;background:#f2f3f5;border-radius:8px;font-size:13px;min-height:20px">等待任务…</div>'
        + '</div>';
    } catch (_) { /* ignore */ }
  }

  function setWorkerStatus(text) {
    const el = document.getElementById('asr-worker-status');
    if (el) el.textContent = String(text || '');
  }

  function attachAsrWorker() {
    decorateWorkerPage();
    const announce = () => { try { window.opener && window.opener.postMessage({ type: 'asr-worker-ready' }, '*'); } catch (_) { /* ignore */ } };
    announce();
    window.addEventListener('message', async event => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'asr-ping') {
        try { event.source.postMessage({ type: 'asr-worker-ready' }, '*'); } catch (_) { /* ignore */ }
        return;
      }
      if (data.type !== 'asr-job') return;
      const reply = event.source;
      const post = msg => { try { reply.postMessage(Object.assign({ type: 'asr-progress', jobId: data.jobId }, msg), '*'); } catch (_) { /* ignore */ } };
      setWorkerStatus('已接收任务，开始读取音频结构');
      post({ stage: 'progress', text: '后台标签页已就绪，正在读取音频结构', fraction: null, detail: '' });
      const video = { site: 'bilibili', cid: data.cid, bvid: data.bvid, aid: data.aid, videoKey: data.videoKey };
      try {
        const result = await transcribeVideoAudio(video, data.track, data.selection, {
          onStage: (text, fraction, detail) => {
            setWorkerStatus(text);
            post({ stage: 'progress', text, fraction, detail });
          },
          onDownloadProgress: f => {
            setWorkerStatus(`正在下载音频 ${Math.round(f * 100)}%`);
            post({ stage: 'progress', text: '正在下载音频', fraction: f, detail: '' });
          },
          onChunkDelta: () => post({ stage: 'progress', text: '正在识别', fraction: null, detail: '' }),
          refreshTrack: () => fetchBilibiliAudioTrack(video),
        });
        setWorkerStatus('识别完成，正在回传结果…');
        post({ stage: 'done', text: result.text, chunkCount: result.chunkCount });
      } catch (error) {
        setWorkerStatus(`识别失败：${(error && error.message) || error}`);
        post({ stage: 'error', message: String((error && error.message) || error) });
      }
    });
  }

  function runAsrWithWorker(video, track, selection, ui) {
    return new Promise((resolve, reject) => {
      let worker = null;
      let settled = false;
      let lastBeat = Date.now();
      let beatTimer = null;
      const clean = () => {
        settled = true;
        window.removeEventListener('message', onMessage);
        window.removeEventListener('message', onReady);
        clearTimeout(readyTimer);
        if (beatTimer) clearInterval(beatTimer);
        try { worker && worker.close(); } catch (_) { /* ignore */ }
      };
      const onMessage = event => {
        const d = event.data;
        if (!d || d.type !== 'asr-progress') return;
        lastBeat = Date.now();
        if (d.stage === 'progress') ui.progress(d.text || '识别中', typeof d.fraction === 'number' ? d.fraction : null, d.detail || '');
        else if (d.stage === 'done') { clean(); resolve({ text: d.text, chunkCount: d.chunkCount }); }
        else if (d.stage === 'error') { clean(); reject(new Error(d.message)); }
      };
      const onReady = event => {
        if (!event.data || event.data.type !== 'asr-worker-ready') return;
        clearTimeout(readyTimer);
        window.removeEventListener('message', onReady);
        try {
          worker.postMessage({
            type: 'asr-job',
            jobId: Date.now(),
            track,
            selection,
            videoKey: videoCacheKey(video),
            cid: video.cid,
            bvid: video.bvid,
            aid: video.aid,
          }, '*');
        } catch (error) { clean(); reject(error); }
      };
      const readyTimer = setTimeout(() => {
        if (!settled) { clean(); reject(new Error('工作标签页未就绪')); }
      }, 10000);
      // 心跳：超过 12 秒没有消息就提示仍在工作，避免“准备中”假死观感
      beatTimer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastBeat > 12000) {
          ui.progress('仍在识别中，请稍候…', null, '后台标签页可查看实时状态');
        }
      }, 6000);

      try {
        worker = window.open(WORKER_TAB_URL, WORKER_TAB_NAME);
      } catch (_) { worker = null; }
      if (!worker) { clean(); reject(new Error('无法打开工作标签页')); return; }
      window.addEventListener('message', onMessage);
      window.addEventListener('message', onReady);
      try { worker.postMessage({ type: 'asr-ping' }, '*'); } catch (_) { /* ignore */ }
    });
  }

  // ===== Fork：工作标签页  // ===== 无字幕视频的语音识别兜底 =====

  function getAsrApiKey() {
    return String(GM_getValue(ASR_API_KEY_SETTING, DEFAULT_ASR_API_KEY) || '').trim();
  }

  function setAsrApiKey(key) {
    GM_setValue(ASR_API_KEY_SETTING, String(key || '').trim());
  }

  function readAsrHistory() {
    try {
      const list = JSON.parse(GM_getValue(ASR_HISTORY_KEY, '[]'));
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function pushAsrHistory(record) {
    const history = readAsrHistory();
    history.push(record);
    while (history.length > 20) history.shift();
    GM_setValue(ASR_HISTORY_KEY, JSON.stringify(history));
  }

  // 历史平均：每 1 分钟音频的识别耗时（毫秒），用于开始前预估。
  function estimateAsrSeconds(audioSeconds) {
    const ratios = readAsrHistory()
      .filter(item => item && item.audioSeconds > 30 && item.elapsedMs > 1000)
      .map(item => item.elapsedMs / (item.audioSeconds / 60));
    if (ratios.length === 0) return 0;
    const avg = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    return (avg * (audioSeconds / 60)) / 1000;
  }

  function formatAudioDuration(seconds) {
    if (!seconds || seconds <= 0) return '未知时长';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
  }

  function formatElapsed(ms) {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
  }

  function formatMB(bytes) {
    if (!bytes) return '0 MB';
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // 测试 Key 连通性：优先浏览器请求，失败时回退油猴请求（不受跨域限制）。
  async function testAsrKeyConnection(apiKey) {
    try {
      const response = await fetch(ASR_MODELS_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
      });
      if (response.ok) return '连接成功，Key 可用';
      if (response.status === 401 || response.status === 403) return `连接失败：Key 无效（HTTP ${response.status}）`;
      return `连接异常：HTTP ${response.status}`;
    } catch (error) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return `连接失败：${error.message || error}`;
      }
      try {
        const status = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: ASR_MODELS_ENDPOINT,
            timeout: 15000,
            headers: { Authorization: `Bearer ${apiKey}` },
            onload: response => resolve(response.status),
            ontimeout: () => reject(new Error('油猴请求超时')),
            onerror: () => reject(new Error('油猴请求失败')),
          });
        });
        if (status >= 200 && status < 300) return '连接成功，Key 可用';
        if (status === 401 || status === 403) return `连接失败：Key 无效（HTTP ${status}）`;
        return `连接异常：HTTP ${status}`;
      } catch (gmError) {
        return `连接失败：${gmError.message || gmError}`;
      }
    }
  }

  function openSettingsPanel(focusKey = true) {
    if (document.getElementById(KEY_PANEL_ID)) {
      if (focusKey) document.getElementById(KEY_PANEL_ID).querySelector('.key-input')?.focus();
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = KEY_PANEL_ID;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = '设置';
    const status = document.createElement('div');
    status.className = 'panel-status';
    const current = getAsrApiKey();
    status.textContent = current
      ? `当前已设置：${current.slice(0, 4)}****${current.slice(-4)}`
      : '当前未设置 Key';

    // ---- 分区：StepFun 语音识别 ----
    const keyLabel = document.createElement('div');
    keyLabel.className = 'panel-label';
    keyLabel.textContent = 'StepFun API Key';
    const input = document.createElement('input');
    input.className = 'key-input';
    // 用 text + CSS 遮罩代替 password 类型，避免触发浏览器“保存密码”提示。
    input.type = 'text';
    input.placeholder = '粘贴 StepFun API Key';
    input.value = current || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const endpointLabel = document.createElement('div');
    endpointLabel.className = 'panel-label';
    endpointLabel.textContent = '识别接口端点（SSE）';
    const endpointInput = document.createElement('input');
    endpointInput.className = 'text-input';
    endpointInput.type = 'text';
    endpointInput.placeholder = ASR_SSE_ENDPOINT;
    endpointInput.value = getAsrEndpoint();
    endpointInput.spellcheck = false;
    const langLabel = document.createElement('div');
    langLabel.className = 'panel-label';
    langLabel.textContent = '识别语言';
    const langSelect = document.createElement('select');
    langSelect.className = 'ttl-select';
    [['zh', '中文（默认）'], ['en', '英文'], ['ja', '日文']].forEach(([value, label]) => {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      langSelect.appendChild(item);
    });
    langSelect.value = getAsrLanguage();
    const testResult = document.createElement('div');
    testResult.className = 'panel-test';
    const row = document.createElement('div');
    row.className = 'panel-row';
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存';
    const clearButton = document.createElement('button');
    clearButton.textContent = '清除 Key';
    clearButton.className = 'ghost';
    const testButton = document.createElement('button');
    testButton.textContent = '测试连接';
    testButton.className = 'ghost';
    const cancelButton = document.createElement('button');
    cancelButton.textContent = '取消';
    cancelButton.className = 'ghost';
    row.appendChild(saveButton);
    row.appendChild(clearButton);
    row.appendChild(testButton);
    row.appendChild(cancelButton);
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'Key 与各配置仅保存在浏览器本地，不会上传到其他服务器。';

    // ---- 分区：视频号 · 元宝 Cookie ----
    const wxLabel = document.createElement('div');
    wxLabel.className = 'panel-label';
    wxLabel.textContent = '视频号解析 · 元宝 Cookie';
    const cookieInput = document.createElement('textarea');
    cookieInput.className = 'cookie-input';
    cookieInput.placeholder = '粘贴 yuanbao.tencent.com 的完整 Cookie（含 HttpOnly 项）';
    cookieInput.value = getYuanbaoCookie();
    cookieInput.spellcheck = false;
    const wxRow = document.createElement('div');
    wxRow.className = 'panel-row';
    const openYuanbaoButton = document.createElement('button');
    openYuanbaoButton.textContent = '打开元宝';
    openYuanbaoButton.className = 'ghost';
    const readCookieButton = document.createElement('button');
    readCookieButton.textContent = '一键读取 Cookie';
    readCookieButton.className = 'ghost';
    const clearCookieButton = document.createElement('button');
    clearCookieButton.textContent = '清空 Cookie';
    clearCookieButton.className = 'ghost';
    wxRow.appendChild(openYuanbaoButton);
    wxRow.appendChild(readCookieButton);
    wxRow.appendChild(clearCookieButton);
    const wxHint = document.createElement('div');
    wxHint.className = 'panel-hint';
    wxHint.textContent = '获取方式：先在元宝登录（点「打开元宝」扫码），再点「一键读取 Cookie」自动填入并保存（自动过滤统计类字段）；若自动读取不可用，再按 F12 → Application/应用 → Cookies → yuanbao.tencent.com 全选复制（需包含 HttpOnly 项）。视频号分享链接经元宝接口解析出视频直链，Cookie 过期后需重新获取。';

    // ---- 分区：调试 ----
    const debugLabel = document.createElement('div');
    debugLabel.className = 'panel-label';
    debugLabel.textContent = '调试';
    const debugLine = document.createElement('label');
    debugLine.className = 'check-line';
    const debugBox = document.createElement('input');
    debugBox.type = 'checkbox';
    debugBox.checked = getDebugEnabled();
    const debugText = document.createElement('span');
    debugText.textContent = '在浏览器控制台输出详细日志（排查接口问题时开启）';
    debugLine.appendChild(debugBox);
    debugLine.appendChild(debugText);

    // ---- 分区：字幕缓存 ----
    const ttlLabel = document.createElement('div');
    ttlLabel.className = 'panel-label';
    ttlLabel.textContent = '字幕缓存留存时间';
    const ttlSelect = document.createElement('select');
    ttlSelect.className = 'ttl-select';
    CACHE_TTL_OPTIONS.forEach(option => {
      const item = document.createElement('option');
      item.value = String(option.value);
      item.textContent = option.label;
      ttlSelect.appendChild(item);
    });
    ttlSelect.value = String(getCacheTtlMs());
    const cacheLine = document.createElement('div');
    cacheLine.className = 'cache-line';
    const cacheInfo = document.createElement('span');
    const clearCacheButton = document.createElement('button');
    clearCacheButton.textContent = '清除缓存';
    const refreshCacheLine = () => {
      const count = listCacheKeys().length;
      const sessionCount = (() => {
        try {
          return Object.keys(sessionStorage).filter(key => key.startsWith(META_CACHE_PREFIX) || key.startsWith(BODY_CACHE_PREFIX)).length;
        } catch (_) {
          return 0;
        }
      })();
      cacheInfo.textContent = `已缓存 ${count + sessionCount} 条字幕/识别结果`;
    };
    refreshCacheLine();
    cacheLine.appendChild(cacheInfo);
    cacheLine.appendChild(clearCacheButton);

    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(keyLabel);
    panel.appendChild(input);
    panel.appendChild(endpointLabel);
    panel.appendChild(endpointInput);
    panel.appendChild(langLabel);
    panel.appendChild(langSelect);
    panel.appendChild(testResult);
    panel.appendChild(row);
    panel.appendChild(hint);
    panel.appendChild(wxLabel);
    panel.appendChild(cookieInput);
    panel.appendChild(wxRow);
    panel.appendChild(wxHint);
    panel.appendChild(debugLabel);
    panel.appendChild(debugLine);
    panel.appendChild(ttlLabel);
    panel.appendChild(ttlSelect);
    panel.appendChild(cacheLine);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    input.focus();

    saveButton.addEventListener('click', () => {
      setAsrApiKey(input.value);
      const endpoint = endpointInput.value.trim();
      GM_setValue(ASR_ENDPOINT_SETTING, endpoint);
      GM_setValue(ASR_LANGUAGE_SETTING, langSelect.value);
      GM_setValue(YUANBAO_COOKIE_SETTING, cookieInput.value.trim());
      GM_setValue(CACHE_TTL_SETTING, Number(ttlSelect.value));
      const value = getAsrApiKey();
      status.textContent = value ? `当前已设置：${value.slice(0, 4)}****${value.slice(-4)}` : '当前未设置 Key';
      refreshCacheLine();
      showToast('设置已保存');
      // 保存后关闭：首次配置 Key 的场景可直接返回继续复制。
      closeSettingsPanel();
    });
    clearButton.addEventListener('click', () => {
      setAsrApiKey('');
      input.value = '';
      testResult.textContent = '';
      status.textContent = '当前未设置 Key';
      showToast('已清除 StepFun API Key，无字幕视频将不再自动识别');
    });
    testButton.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) {
        showToast('请先输入 Key');
        return;
      }
      testButton.disabled = true;
      testButton.textContent = '测试中…';
      testResult.textContent = '正在测试连接…';
      testResult.style.color = '#9499a0';
      try {
        const message = await testAsrKeyConnection(value);
        testResult.textContent = message;
        testResult.style.color = /成功/.test(message) ? '#00b42a' : '#f53f3f';
        showToast(message);
      } finally {
        testButton.disabled = false;
        testButton.textContent = '测试连接';
      }
    });
    cancelButton.addEventListener('click', closeSettingsPanel);
    openYuanbaoButton.addEventListener('click', () => {
      if (typeof window.open === 'function') window.open(YUANBAO_HOME, '_blank', 'noopener');
      showToast('已打开元宝，登录后点「一键读取 Cookie」');
    });
    readCookieButton.addEventListener('click', async () => {
      readCookieButton.disabled = true;
      readCookieButton.textContent = '读取中…';
      try {
        const { cookieString, useful } = await readYuanbaoCookieAutomatically();
        cookieInput.value = cookieString;
        GM_setValue(YUANBAO_COOKIE_SETTING, cookieString);
        showToast(`已读取并保存 ${useful} 个 Cookie 字段（已过滤统计类）`);
      } catch (error) {
        showToast(`自动读取失败：${error.message || error}，请按提示用 F12 手动复制`);
      } finally {
        readCookieButton.disabled = false;
        readCookieButton.textContent = '一键读取 Cookie';
      }
    });
    clearCookieButton.addEventListener('click', () => {
      cookieInput.value = '';
      GM_setValue(YUANBAO_COOKIE_SETTING, '');
      showToast('已清空元宝 Cookie');
    });
    debugBox.addEventListener('change', () => {
      GM_setValue(DEBUG_SETTING, debugBox.checked === true);
      showToast(debugBox.checked ? '调试日志已开启' : '调试日志已关闭');
    });
    ttlSelect.addEventListener('change', () => {
      GM_setValue(CACHE_TTL_SETTING, Number(ttlSelect.value));
      refreshCacheLine();
      showToast('缓存留存时间已更新');
    });
    clearCacheButton.addEventListener('click', () => {
      clearAllCaches();
      refreshCacheLine();
      showToast('已清除全部字幕缓存');
    });
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeSettingsPanel();
    });
  }

  function closeSettingsPanel() {
    document.getElementById(KEY_PANEL_ID)?.remove();
  }

  let progressTimer = 0;
  let progressStartedAt = 0;

  function showProgressPanel() {
    hideProgressPanel();
    const panel = document.createElement('div');
    panel.id = PROGRESS_PANEL_ID;
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.textContent = '准备中';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = '已用 0.0 秒';
    panel.appendChild(stage);
    panel.appendChild(bar);
    panel.appendChild(detail);
    document.body.appendChild(panel);
    progressStartedAt = Date.now();
    progressTimer = window.setInterval(() => {
      const current = document.getElementById(PROGRESS_PANEL_ID);
      const detailEl = current?.querySelector('.detail');
      if (!detailEl) return;
      const extra = detailEl.dataset.extra || '';
      detailEl.textContent = `${extra ? `${extra} · ` : ''}已用 ${formatElapsed(Date.now() - progressStartedAt)}`;
    }, 250);
    return panel;
  }

  // fraction 为 null 时展示不确定态动画（例如无法获取进度的下载）。
  function updateProgress(stageText, fraction, extra) {
    const panel = document.getElementById(PROGRESS_PANEL_ID);
    if (!panel) return;
    const stageEl = panel.querySelector('.stage');
    const fillEl = panel.querySelector('.fill');
    const detailEl = panel.querySelector('.detail');
    if (stageEl && stageText) stageEl.textContent = stageText;
    if (fillEl) {
      if (fraction === null || fraction === undefined) {
        fillEl.classList.add('indeterminate');
      } else {
        fillEl.classList.remove('indeterminate');
        fillEl.style.width = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
      }
    }
    if (detailEl) {
      detailEl.dataset.extra = extra || '';
      const elapsed = formatElapsed(Date.now() - progressStartedAt);
      detailEl.textContent = `${extra ? `${extra} · ` : ''}已用 ${elapsed}`;
    }
  }

  function hideProgressPanel() {
    clearInterval(progressTimer);
    progressTimer = 0;
    document.getElementById(PROGRESS_PANEL_ID)?.remove();
  }

  // ===== 视频信息 =====

  function getIdFromPage() {
    const state = unsafeWindowOrWindow().__INITIAL_STATE__ || {};
    const playInfo = unsafeWindowOrWindow().__playinfo__?.data || {};
    const videoData = state.videoData || {};
    const epInfo = state.epInfo || {};
    const urlBvid = location.pathname.match(/BV[\w]+/i)?.[0];
    const pageNumber = Math.max(1, Number(new URL(location.href).searchParams.get('p')) || Number(state.p) || 1);
    const currentPage = videoData.pages?.find(page => Number(page.page) === pageNumber);

    return {
      // URL 和当前播放信息在 B 站单页切换时通常比旧的 INITIAL_STATE 更快更新。
      bvid: urlBvid || playInfo.bvid || videoData.bvid || state.bvid || '',
      aid: playInfo.aid || videoData.aid || state.aid || epInfo.aid || 0,
      // 选集切换后 URL 的 p 参数对应 pages，优先使用该分 P 的 cid；其余状态可能仍停留在上一集。
      cid: currentPage?.cid || epInfo.cid || playInfo.cid || videoData.cid || state.cid || 0,
    };
  }

  function getYouTubeVideoId() {
    const fromUrl = new URL(location.href).searchParams.get('v');
    if (fromUrl) return fromUrl;
    const fromState = unsafeWindowOrWindow().ytInitialPlayerResponse?.videoDetails?.videoId;
    return fromState || '';
  }

  function unsafeWindowOrWindow() {
    return typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  }

  function resolveCurrentVideo() {
    if (site === 'youtube') {
      const videoId = getYouTubeVideoId();
      if (videoId) return { site: 'youtube', bvid: videoId, aid: 0, cid: 0 };
      throw new Error('没有识别到当前 YouTube 视频，请刷新页面后重试');
    }
    const pageIds = getIdFromPage();
    if (pageIds.cid && (pageIds.bvid || pageIds.aid)) return { site: 'bilibili', ...pageIds };
    throw new Error('没有从当前播放器识别到视频编号，请刷新页面后重试');
  }

  function videoCacheKey(video) {
    return `${video.bvid || `av${video.aid}`}:${video.cid}`;
  }

  // ===== 字幕元数据 =====

  function findPlayerSubtitleApiUrl(video) {
    performance.getEntriesByType('resource').forEach(entry => rememberPlayerApiUrl(entry.name));
    for (let index = playerApiUrls.length - 1; index >= 0; index -= 1) {
      try {
        const url = new URL(playerApiUrls[index]);
        if (Number(url.searchParams.get('cid')) !== Number(video.cid)) continue;
        if (video.aid && Number(url.searchParams.get('aid')) !== Number(video.aid)) continue;
        return url.href;
      } catch (_) {
        // Ignore non-URL performance entries.
      }
    }
    return '';
  }

  // 播放器侧音频地址请求兜底：无签名直连被风控时，直接复用播放器已经拿到的带签名链接。
  function findCapturedPlayApiUrl(video) {
    performance.getEntriesByType('resource').forEach(entry => rememberPlayerPlayApiUrl(entry.name));
    for (let index = playerPlayApiUrls.length - 1; index >= 0; index -= 1) {
      try {
        const url = new URL(playerPlayApiUrls[index]);
        if (Number(url.searchParams.get('cid')) !== Number(video.cid)) continue;
        if (video.aid && Number(url.searchParams.get('aid')) !== Number(video.aid)) continue;
        return url.href;
      } catch (_) {
        // Ignore non-URL performance entries.
      }
    }
    return '';
  }

  async function waitForPlayerSubtitleApiUrl(video) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const url = findPlayerSubtitleApiUrl(video);
      if (url) return url;
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    throw new Error('播放器字幕信息尚未加载，请等待视频开始播放后重试');
  }

  async function fetchLegacySubtitleMeta(video) {
    const query = new URLSearchParams({ cid: String(video.cid) });
    if (video.bvid) query.set('bvid', video.bvid);
    else query.set('aid', String(video.aid));
    const result = await requestJson(`https://api.bilibili.com/x/player/v2?${query}`);
    if (result.code !== 0) throw new Error(result.message || '无法读取字幕列表');
    return Array.isArray(result.data?.subtitle?.subtitles) ? result.data.subtitle.subtitles : [];
  }

  // YouTube：ANDROID 客户端的 innertube player 响应，字幕 URL 无需 po token 且音频为直链。
  async function fetchYouTubePlayerData(video) {
    return requestJsonPost(YOUTUBE_PLAYER_API(video.bvid), {
      context: { client: YOUTUBE_CLIENT },
      videoId: video.bvid,
    });
  }

  function mapYouTubeCaptionTracks(playerData) {
    const renderer = playerData?.captions?.playerCaptionsTracklistRenderer;
    const tracks = renderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map(track => {
      const name = track.name?.simpleText
        || (track.name?.runs || []).map(run => run.text).join('')
        || track.languageCode;
      return {
        lan: track.languageCode || '',
        lan_doc: name,
        subtitle_url: track.baseUrl || '',
        isAsr: track.kind === 'asr',
      };
    }).filter(track => track.subtitle_url);
  }

  async function fetchYouTubeSubtitleMeta(video) {
    const playerData = await fetchYouTubePlayerData(video);
    const playability = playerData?.playabilityStatus?.status;
    if (playability && playability !== 'OK') {
      throw new Error(playerData?.playabilityStatus?.reason || '视频不可播放');
    }
    return mapYouTubeCaptionTracks(playerData);
  }

  async function fetchSubtitleMeta(video) {
    const cacheKey = videoCacheKey(video);
    const cached = readCache(META_CACHE_PREFIX, cacheKey);
    if (cached) return cached;
    let subtitles;
    if (video.site === 'youtube') {
      subtitles = await fetchYouTubeSubtitleMeta(video);
    } else {
      try {
        const playerApiUrl = await waitForPlayerSubtitleApiUrl(video);
        const result = await requestJson(playerApiUrl);
        if (result.code !== 0) throw new Error(result.message || '无法读取播放器字幕列表');
        subtitles = result.data?.subtitle?.subtitles;
      } catch (error) {
        // SPA 切换分 P 时播放器可能暂时不重发签名请求，使用当前 cid 的兼容接口兜底。
        console.warn('[复制字幕] 当前选集播放器请求未出现，尝试按当前 cid 读取', error);
        subtitles = await fetchLegacySubtitleMeta(video);
      }
    }
    if (!Array.isArray(subtitles) || subtitles.length === 0) return [];
    writeCache(META_CACHE_PREFIX, cacheKey, subtitles);
    return subtitles;
  }

  function subtitleLanguageLabel(subtitle) {
    return subtitle.lan_doc || subtitle.lan || '未知语言';
  }

  function isChineseSubtitle(subtitle) {
    return /^(zh|ai-zh)/i.test(subtitle?.lan || '') || /中文|汉语|简体|繁体/.test(subtitle?.lan_doc || '');
  }

  function isGeneratedSubtitle(subtitle) {
    return /ai-/.test(subtitle?.lan || '') || !!subtitle?.isAsr;
  }

  function chooseSubtitle(subtitles, selectedLanguage = 'auto') {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
    if (selectedLanguage && selectedLanguage !== 'auto') {
      const exact = subtitles.find(subtitle => subtitle.lan === selectedLanguage);
      if (exact) return exact;
    }
    return subtitles.find(isChineseSubtitle)
      || subtitles.find(subtitle => !isGeneratedSubtitle(subtitle))
      || subtitles[0];
  }

  function populateLanguageSelect(subtitles, videoKey) {
    const select = document.getElementById(SELECT_ID);
    if (!select) return;
    const previous = select.dataset.videoKey === videoKey ? (select.value || 'auto') : 'auto';
    select.replaceChildren();
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = '中文（默认）';
    select.appendChild(autoOption);
    subtitles.forEach((subtitle, index) => {
      const option = document.createElement('option');
      option.value = subtitle.lan || `index:${index}`;
      option.textContent = subtitleLanguageLabel(subtitle);
      select.appendChild(option);
    });
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'auto';
    select.dataset.videoKey = videoKey;
  }

  // YouTube 字幕 XML 解析（兼容 <p t= d=> 与 <text start= dur=> 两种格式）。
  function decodeXmlEntities(text) {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#0*39;/g, "'")
      .replace(/&hellip;/g, '…')
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCharCode(parseInt(code, 16)));
  }

  function parseYouTubeTranscriptXml(xml) {
    const body = [];
    const push = (startMs, durationMs, rawText) => {
      const content = decodeXmlEntities(rawText).replace(/\s*\n\s*/g, '\n').trim();
      if (!content) return;
      body.push({ from: startMs / 1000, to: (startMs + durationMs) / 1000, content });
    };
    const pPattern = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    const textPattern = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = pPattern.exec(xml)) !== null) {
      push(Number(match[1]), Number(match[2]), match[3]);
    }
    while ((match = textPattern.exec(xml)) !== null) {
      const startSeconds = Number(match[1]) * 1000;
      const durationSeconds = (Number(match[2]) || 0) * 1000;
      push(startSeconds, durationSeconds, match[3]);
    }
    body.sort((a, b) => a.from - b.from);
    return body;
  }

  async function fetchSubtitleBody(video, subtitle) {
    if (video.site === 'youtube') {
      const xml = await requestText(subtitle.subtitle_url);
      return parseYouTubeTranscriptXml(xml);
    }
    const subtitleData = await requestJson(subtitle.subtitle_url, { credentials: 'omit' });
    return subtitleData.body;
  }

  function normalizeSubtitle(body) {
    const lines = (Array.isArray(body) ? body : [])
      .map(item => String(item?.content ?? ''))
      .map(line => line.replace(/\\N/gi, '\n').replace(/\r/g, '').trim())
      .filter(Boolean);

    let text = '';
    for (const line of lines) {
      if (!text) {
        text = line;
        continue;
      }
      const needsSpace = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(line);
      text += needsSpace ? ` ${line}` : line;
    }
    return text
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ===== 音频获取 =====

  async function fetchBilibiliAudioTrack(video) {
    const isBangumi = location.pathname.startsWith('/bangumi');
    const endpoint = isBangumi
      ? 'https://api.bilibili.com/pgc/player/web/playurl'
      : 'https://api.bilibili.com/x/player/playurl';
    const query = new URLSearchParams({
      cid: String(video.cid),
      qn: '16',
      otype: 'json',
      fourk: '1',
      fnver: '0',
      fnval: '4048',
    });
    if (video.aid) query.set('avid', String(video.aid));
    if (video.bvid) query.set('bvid', video.bvid);

    let data = null;
    try {
      const result = await requestJson(`${endpoint}?${query}`);
      if (result.code === 0) data = result.data;
      else console.warn('[复制字幕] 播放接口返回异常', result.code, result.message);
    } catch (error) {
      console.warn('[复制字幕] 播放接口请求失败，尝试复用播放器请求', error);
    }
    if (!data?.dash) {
      const captured = findCapturedPlayApiUrl(video);
      if (captured) {
        try {
          const result = await requestJson(captured);
          if (result.code === 0) data = result.data;
        } catch (error) {
          console.warn('[复制字幕] 复用播放器音频请求失败', error);
        }
      }
    }

    const audioList = data?.dash?.audio;
    if (!Array.isArray(audioList) || audioList.length === 0) {
      throw new Error('未获取到音频流（可能需要登录，或等待视频开始播放后重试）');
    }
    // 普通 AAC 音轨按最高码率选择；杜比/FLAC 音轨需要会员，兜底场景不使用。
    const best = audioList
      .slice()
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const url = (best.baseUrl || best.base_url || '').replace('http:', 'https:');
    const backups = (best.backupUrl || best.backup_url || [])
      .filter(Boolean)
      .map(item => item.replace('http:', 'https:'));
    if (!url) throw new Error('音频流地址为空');
    return {
      url,
      backups,
      duration: Number(data.dash?.duration) || 0,
      bandwidth: best.bandwidth || 0,
    };
  }

  async function fetchYouTubeAudioTrack(video) {
    const playerData = await fetchYouTubePlayerData(video);
    const audioList = ((playerData?.streamingData?.adaptiveFormats) || [])
      .filter(format => (format.mimeType || '').startsWith('audio/mp4') && format.url);
    if (audioList.length === 0) {
      throw new Error('未获取到音频流（该视频可能只有 opus 格式或需要登录）');
    }
    // 语音识别不需要高码率，选体积最小的 m4a 以控制请求体大小；其余地址作为备用 CDN。
    const sorted = audioList.slice().sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    const best = sorted[0];
    const backups = [...new Set(sorted.slice(1).map(format => format.url))];
    return {
      url: best.url,
      backups,
      duration: Number(playerData?.videoDetails?.lengthSeconds) || 0,
      bandwidth: best.bitrate || 0,
    };
  }

  async function fetchAudioTrack(video) {
    if (video.site === 'youtube') return fetchYouTubeAudioTrack(video);
    return fetchBilibiliAudioTrack(video);
  }

  function downloadByGM(url, onProgress) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 300000,
        responseType: 'arraybuffer',
        onprogress: event => onProgress?.(event.loaded || 0, event.total || 0),
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`油猴请求返回 HTTP ${response.status}`));
            return;
          }
          resolve(new Uint8Array(response.response));
        },
        ontimeout: () => reject(new Error('音频下载超时')),
        onerror: response => reject(
          new Error(`音频下载失败${response?.status ? `（HTTP ${response.status}）` : ''}`)
        ),
      });
    });
  }

  async function downloadByFetch(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  // 优先油猴请求（可获取下载进度），失败后回退浏览器 fetch；每个地址都有备用 CDN。
  // 所有地址都失败时，直链可能已过期或被 CDN 节点拒绝，重新拉取播放数据换取新地址再试。
  async function downloadAudioBytes(track, onProgress, refreshTrack) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const candidate of [track.url, ...track.backups]) {
        let bytes = null;
        if (typeof GM_xmlhttpRequest === 'function') {
          try {
            bytes = await downloadByGM(candidate, onProgress);
          } catch (error) {
            lastError = error;
            console.warn('[复制字幕] 油猴下载失败，尝试浏览器下载', candidate, error);
          }
        }
        if (!bytes) {
          try {
            bytes = await downloadByFetch(candidate);
          } catch (error) {
            lastError = error;
            console.warn('[复制字幕] 音频下载失败，尝试下一个地址', candidate, error);
          }
        }
        if (bytes) return bytes;
      }
      if (!refreshTrack || attempt === 2) break;
      try {
        track = await refreshTrack();
      } catch (error) {
        console.warn('[复制字幕] 重新获取音频地址失败', error);
        break;
      }
    }
    throw new Error(`音频下载失败：${lastError?.message || lastError}`);
  }

  function bytesToBase64(bytes) {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK_SIZE));
    }
    return btoa(binary);
  }

  // DASH 音轨是自包含 fMP4：头部（ftyp+moov+sidx）加若干 moof/mdat 片段。
  // 超长音频按 moof 边界切分，每片都重新拼上头信息，保证是可以独立解码的完整文件。
  function splitAudioChunks(bytes, maxBytes) {
    const boxes = [];
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      if (size < 8 || offset + size > bytes.length) break;
      boxes.push({
        type: String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]),
        start: offset,
        size,
      });
      offset += size;
    }

    const firstMoof = boxes.find(box => box.type === 'moof');
    if (!firstMoof) {
      if (bytes.length <= maxBytes) return [bytes];
      throw new Error('音频过大且无法按片段分片');
    }

    const header = bytes.subarray(0, firstMoof.start);
    const fragments = boxes.filter(box => box.start >= firstMoof.start);
    const groups = [];
    let current = [];
    let currentSize = header.length;
    for (const fragment of fragments) {
      if (currentSize + fragment.size > maxBytes && current.length > 0) {
        groups.push(current);
        current = [];
        currentSize = header.length;
      }
      current.push(fragment);
      currentSize += fragment.size;
    }
    if (current.length > 0) groups.push(current);

    return groups.map(group => {
      let total = header.length;
      for (const fragment of group) total += fragment.size;
      const chunk = new Uint8Array(total);
      chunk.set(header, 0);
      let cursor = header.length;
      for (const fragment of group) {
        chunk.set(bytes.subarray(fragment.start, fragment.start + fragment.size), cursor);
        cursor += fragment.size;
      }
      return chunk;
    });
  }

  async function transcribeAudioChunk(bytes, apiKey, onDelta, formatType = 'm4a') {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ASR_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(getAsrEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          audio: {
            data: bytesToBase64(bytes),
            input: {
              transcription: {
                model: ASR_MODEL,
                language: getAsrLanguage(),
                enable_itn: true,
                // 开启时间戳后 SSE 增量会带回每段文字在音频中的位置，用于计算识别进度。
                enable_timestamp: true,
              },
              format: { type: formatType },
            },
          },
        }),
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`语音识别接口返回 HTTP ${response.status}`);
    if (!response.body) throw new Error('语音识别接口不支持流式读取');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const payload = block
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('\n');
          if (payload) {
            const event = JSON.parse(payload);
            if (event.type === 'transcript.text.delta' && typeof event.end_time === 'number' && event.end_time > 0) {
              onDelta?.(event.end_time);
            }
            if (event.type === 'transcript.text.done') finalText = event.text || finalText;
            if (event.type === 'error') throw new Error(event.message || '语音识别失败');
          }
          separator = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!finalText) throw new Error('语音识别未返回文本');
    return finalText;
  }

  async function transcribeVideoAudio(video, track, selection, hooks = {}) {
    const apiKey = getAsrApiKey();
    if (!apiKey) throw new Error('尚未设置 StepFun API Key，请通过菜单设置');
    const videoKey = video.videoKey || videoCacheKey(video);
    const selHash = selectionHash(selection);

    const stage = (text, fraction, detail) => {
      if (hooks.onStage) { try { hooks.onStage(text, fraction, detail); } catch (_) { /* ignore */ } }
      updateProgress(text, fraction == null ? null : fraction, detail == null ? '' : detail);
    };
    stage('正在读取音频结构', null, '');
    let headerInfo = null;
    try {
      headerInfo = await fetchAudioHeader(track.url);
    } catch (error) {
      console.warn('[复制字幕] 流式管线初始化失败，回退整文件下载', error);
    }
    const totalSize = headerInfo ? (headerInfo.total || 0) : 0;
    const totalMs = (track.duration || 0) * 1000;

    // 兜底：流式管线不可用时退回 v1 的整文件下载（内存占用高；章节选择降级为全篇）
    if (!headerInfo || !totalSize) {
      const degraded = !!(selection && selection.mode === 'chapters');
      if (degraded) showToast('分段下载不可用，已回退整片识别（本次忽略章节选择）');
      stage('正在下载音频', null, '');
      const bytes = await downloadAudioBytes(track, (loaded, total) => {
        stage('正在下载音频', total ? loaded / total : null,
          `${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ''}`);
      }, () => fetchAudioTrack(video));
      const chunks = splitAudioChunks(bytes, MAX_AUDIO_CHUNK_BYTES);
      const fallbackHash = 'full-dl';
      const texts = await mapWithBudget(async function* iterateChunks() { for (const c of chunks) yield c; },
        async (chunk, idx) => {
          const ck = checkpointKey(videoKey, fallbackHash, 0, idx);
          const cached = readCheckpoint(ck);
          if (cached != null) return cached;
          const text = await transcribeAudioChunk(chunk, apiKey, hooks.onChunkDelta);
          writeCheckpoint(ck, text);
          return text;
        }, ASR_INFLIGHT_BUDGET);
      clearCheckpointsFor(videoKey, fallbackHash);
      return {
        text: normalizeSubtitle([{ content: texts.filter(t => typeof t === 'string').join('') }]),
        chunkCount: texts.length,
        degraded,
      };
    }

    // 组装字节区间：全篇或按章节（时间 -> 字节二分定位，重叠区间合并）
    let ranges;
    if (!selection || selection.mode === 'full') {
      ranges = [{ title: '', startMs: 0, endMs: Number.POSITIVE_INFINITY, start: 0, end: totalSize }];
    } else {
      const picked = [];
      for (let bi = 0; bi < selection.ranges.length; bi++) {
        const r = selection.ranges[bi];
        stage(`正在定位章节边界 ${bi + 1}/${selection.ranges.length}：${r.title || ''}`, bi / selection.ranges.length, '');
        const start = await findByteForTime(track.url, totalSize, r.startMs, headerInfo);
        const end = r.endMs >= totalMs ? totalSize : await findByteForTime(track.url, totalSize, r.endMs, headerInfo);
        picked.push({ title: r.title, startMs: r.startMs, endMs: r.endMs, start, end: Math.max(end, start + 4096) });
      }
      picked.sort((a, b) => a.start - b.start);
      ranges = [];
      for (const r of picked) {
        const last = ranges[ranges.length - 1];
        if (last && r.start - last.end < 1024 * 1024) {
          last.end = Math.max(last.end, r.end);
          last.title = last.title ? `${last.title} + ${r.title}` : r.title;
        } else {
          ranges.push(Object.assign({}, r));
        }
      }
    }

    stage('正在下载音频', null, '');
    const results = [];
    let chunkCount = 0;
    for (let ri = 0; ri < ranges.length; ri++) {
      const range = ranges[ri];
      const stream = streamRangeChunks(track.url, headerInfo, range, MAX_AUDIO_CHUNK_BYTES,
        hooks.onDownloadProgress, hooks.refreshTrack);
      const texts = await mapWithBudget(stream, async (chunk, idx) => {
        const ck = checkpointKey(videoKey, selHash, ri, idx);
        const cached = readCheckpoint(ck);
        if (cached != null) return cached;
        const text = await transcribeAudioChunk(chunk, apiKey, hooks.onChunkDelta);
        writeCheckpoint(ck, text);
        return text;
      }, ASR_INFLIGHT_BUDGET);
      chunkCount += texts.length;
      results.push({ title: range.title, text: texts.filter(t => typeof t === 'string').join('') });
      if (hooks.onRangeDone) hooks.onRangeDone(ri + 1, ranges.length);
    }

    const assembled = results.length === 1 && !results[0].title
      ? results[0].text
      : results.map(r => (r.title ? `【${r.title}】\n${r.text}` : r.text)).join('\n');
    return { text: normalizeSubtitle([{ content: assembled }]), chunkCount };
  }

  // ===== 视频号（微信 Channels）转文字 =====
  // 链路：元宝接口解析分享链接（取 token/eid）→ finder 接口取视频直链 → 下载 → 整包/分片送 StepFun。
  // 两个接口都必须在浏览器环境内发起（服务端有 TLS 指纹校验），跨域部分走 GM_xmlhttpRequest。

  function gmRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.data,
        responseType: options.responseType || 'text',
        timeout: options.timeout || 300000,
        onprogress: options.onprogress,
        onload: response => {
          if (response.status >= 200 && response.status < 300) resolve(response);
          else reject(new Error(`HTTP ${response.status}`));
        },
        onerror: response => reject(
          new Error(response?.status ? `HTTP ${response.status}` : '网络请求失败')
        ),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  // 归一化分享链接：接受完整 URL 或裸 ID（A8CFFBXJHP）。
  function wxNormalizeShareUrl(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[A-Za-z0-9_-]{6,}$/.test(text)) return `https://weixin.qq.com/sph/${text}`;
    return text;
  }

  function wxCacheKey(shareUrl) {
    const sph = String(shareUrl).match(/sph\/([A-Za-z0-9_-]+)/);
    if (sph) return sph[1];
    const id = String(shareUrl).match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (id) return id[1];
    return String(shareUrl);
  }

  async function wxParseShareUrl(shareUrl) {
    const cookie = getYuanbaoCookie();
    if (!cookie) {
      throw new Error('尚未设置元宝 Cookie，请在设置面板填写（点「打开元宝」登录后从开发者工具复制）');
    }
    const response = await gmRequest(YUANBAO_PARSE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Referer: YUANBAO_HOME,
        cookie,
      },
      data: JSON.stringify({ type: 'video_channel_url', url: shareUrl, scene: 1 }),
    });    let json;
    try { json = JSON.parse(response.responseText); } catch (_) {
      throw new Error('元宝解析响应异常');
    }
    if (json.code !== 0 || !json.data || !json.data.playable_url) {
      throw new Error(json.msg || '元宝解析失败（Cookie 可能已过期，请更新）');
    }
    const playable = new URL(json.data.playable_url);
    const token = playable.searchParams.get('token') || '';
    const eid = playable.searchParams.get('eid') || '';
    if (!token || !eid) throw new Error('解析结果缺少 token/eid');
    debugLog('元宝解析成功', { eid, desc: json.data.desc || '' });
    return { token, eid, desc: json.data.desc || '' };
  }

  async function wxGetFeedInfo(token, eid) {
    const rid = `${Math.floor(Date.now() / 1000).toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    const pageUrl = encodeURIComponent('https://channels.weixin.qq.com/finder-preview/pages/feed');
    const referer = `https://channels.weixin.qq.com/finder-preview/pages/feed`
      + `?entry_card_type=48&comment_scene=39&appid=0`
      + `&token=${encodeURIComponent(token)}&entry_scene=0&eid=${encodeURIComponent(eid)}`;
    const response = await gmRequest(`${WXCHANNELS_FEED_API}?_rid=${rid}&_pageUrl=${pageUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        // GM_xmlhttpRequest 不会自动携带浏览器 sec-* 头，显式补齐（接口侧有环境校验）。
        'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        Referer: referer,
      },
      data: JSON.stringify({ baseReq: { generalToken: token }, exportId: eid }),
    });
    let json;
    try { json = JSON.parse(response.responseText); } catch (_) {
      throw new Error('视频信息响应异常');
    }
    const feed = json.data && json.data.feedInfo;
    if (!feed) throw new Error('未获取到视频信息');
    const detail = json.data.errMsg;
    if (detail && (Number(detail.type) !== 0 || detail.title)) {
      throw new Error(`${detail.title || '视频不可用'}${detail.content ? `：${detail.content}` : ''}`);
    }
    return feed;
  }

  async function wxDownloadVideo(videoUrl, onProgress) {
    const response = await gmRequest(videoUrl, {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 300000,
      onprogress: onProgress,
    });
    return new Uint8Array(response.response);
  }

  // 视频号直链默认是明文 MP4（ftyp 头）；加密文件头部为随机字节。
  function wxIsEncrypted(bytes) {
    if (bytes.length < 12) return true;
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return type !== 'ftyp' && type !== 'moov' && type !== 'styp' && type !== 'free' && type !== 'skip';
  }

  // 读 moov/mvhd 得到时长（秒），用于预估与历史统计。
  function wxReadDuration(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let off = 0;
      while (off + 8 <= bytes.length) {
        const size = view.getUint32(off);
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        if (size < 8 || off + size > bytes.length) break;
        if (type === 'moov') {
          let p = off + 8;
          const end = off + size;
          while (p + 8 <= end) {
            const sz = view.getUint32(p);
            const ty = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
            if (ty === 'mvhd') {
              const version = bytes[p + 8];
              const timescaleOff = version === 1 ? p + 28 : p + 20;
              const durationOff = version === 1 ? p + 32 : p + 24;
              const timescale = view.getUint32(timescaleOff);
              const duration = version === 1 ? Number(view.getBigUint64(durationOff)) : view.getUint32(durationOff);
              return timescale > 0 ? duration / timescale : 0;
            }
            if (sz < 8) break;
            p += sz;
          }
          return 0;
        }
        off += size;
      }
    } catch (_) {
      // 忽略解析异常
    }
    return 0;
  }

  function wxBuildWav(pcm, sampleRate = 16000, channels = 1, bits = 16) {
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, 0x46464952, true); // "RIFF"
    view.setUint32(4, 36 + pcm.byteLength, true);
    view.setUint32(8, 0x45564157, true); // "WAVE"
    view.setUint32(12, 0x20746d66, true); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, (sampleRate * channels * bits) / 8, true);
    view.setUint16(32, (channels * bits) / 8, true);
    view.setUint16(34, bits, true);
    view.setUint32(36, 0x61746164, true); // "data"
    view.setUint32(40, pcm.byteLength, true);
    new Uint8Array(buffer, 44).set(pcm);
    return new Uint8Array(buffer);
  }

  // 浏览器内置解码器提取音轨并重采样为 16k 单声道 PCM（替代 ffmpeg）。
  function wxDecodeToPcm16k(bytes) {
    return new Promise((resolve, reject) => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        reject(new Error('当前浏览器不支持 AudioContext，无法提取音频'));
        return;
      }
      const ctx = new Ctx();
      const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ctx.decodeAudioData(slice, audio => {
        try {
          const targetRate = 16000;
          const channels = audio.numberOfChannels;
          const srcRate = audio.sampleRate;
          const srcLen = audio.length;
          const ratio = srcRate / targetRate;
          const outLen = Math.max(1, Math.floor(srcLen / ratio));
          const pcm = new Int16Array(outLen);
          const data = [];
          for (let c = 0; c < channels; c += 1) data.push(audio.getChannelData(c));
          for (let i = 0; i < outLen; i += 1) {
            const pos = i * ratio;
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            let sum = 0;
            for (let c = 0; c < channels; c += 1) {
              const ch = data[c];
              const a = ch[i0] || 0;
              const b = ch[Math.min(i0 + 1, srcLen - 1)] || 0;
              sum += a + (b - a) * frac;
            }
            const v = sum / channels;
            pcm[i] = Math.max(-32768, Math.min(32767, v * 32767));
          }
          ctx.close();
          resolve({ pcm, duration: audio.duration, sampleRate: targetRate });
        } catch (error) {
          ctx.close();
          reject(error);
        }
      }, error => {
        ctx.close();
        reject(new Error(`音频解码失败：${error?.message || error}`));
      });
    });
  }

  // 小文件整包按 m4a 送；大文件解码提 WAV 后分片送。
  async function wxTranscribeBytes(bytes, apiKey) {
    if (bytes.length <= WX_MAX_WHOLE_BYTES) {
      updateProgress('正在识别', null, formatMB(bytes.length));
      const text = await transcribeAudioChunk(bytes, apiKey, null, 'm4a');
      return { text, chunkCount: 1 };
    }
    updateProgress('正在提取音频', null, formatMB(bytes.length));
    const { pcm } = await wxDecodeToPcm16k(bytes);
    const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const chunkCount = Math.max(1, Math.ceil(pcmBytes.length / WX_WAV_CHUNK_BYTES));
    let text = '';
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * WX_WAV_CHUNK_BYTES;
      const piece = pcmBytes.subarray(start, Math.min(start + WX_WAV_CHUNK_BYTES, pcmBytes.length));
      updateProgress(`正在识别（第 ${index + 1}/${chunkCount} 段）`, index / chunkCount, formatMB(piece.length));
      text += await transcribeAudioChunk(wxBuildWav(piece), apiKey, null, 'wav');
    }
    return { text, chunkCount };
  }

  async function runWxchannelsTranscribe(shareUrlRaw) {
    const shareUrl = wxNormalizeShareUrl(shareUrlRaw);
    if (!shareUrl) {
      showToast('请先粘贴视频号分享链接');
      return;
    }
    if (typeof GM_xmlhttpRequest !== 'function') {
      showToast('当前脚本管理器不支持 GM_xmlhttpRequest，无法使用视频号功能');
      return;
    }
    const apiKey = getAsrApiKey();
    if (!apiKey) {
      openSettingsPanel();
      showToast('请先设置 StepFun API Key');
      return;
    }
    if (!getYuanbaoCookie()) {
      openSettingsPanel(false);
      showToast('请先在设置中填写元宝 Cookie');
      return;
    }
    if (!asrConsentGiven && !window.confirm(
      '将通过 StepFun 语音识别把视频号视频转成文字，音频会上传至 StepFun（按时长计费），是否继续？'
    )) return;
    asrConsentGiven = true;

    const panel = document.getElementById(WX_PANEL_ID);
    const statusEl = panel?.querySelector('.wx-status');
    const resultEl = panel?.querySelector('.wx-result');
    const startEl = panel?.querySelector('.wx-start');
    const setStatus = text => {
      if (statusEl) statusEl.textContent = text;
      debugLog(text);
    };

    const cacheKey = `wxchannels:${wxCacheKey(shareUrl)}`;
    const cached = readCache(BODY_CACHE_PREFIX, cacheKey);
    if (cached) {
      if (resultEl) resultEl.value = cached;
      setStatus('已命中标签页缓存');
      await writeClipboard(cached);
      showToast(`已通过语音识别复制，共 ${cached.length} 个字符（标签页缓存）`);
      return;
    }

    const startedAt = Date.now();
    if (startEl) startEl.disabled = true;
    showProgressPanel();
    try {
      setStatus('正在解析分享链接…');
      updateProgress('正在解析分享链接', null, '');
      const { token, eid, desc } = await wxParseShareUrl(shareUrl);

      setStatus('正在获取视频信息…');
      updateProgress('正在获取视频信息', null, desc || '');
      const feed = await wxGetFeedInfo(token, eid);
      const videoUrl = feed.videoUrl
        || (feed.h264VideoInfo || {}).videoUrl
        || (feed.h265VideoInfo || {}).videoUrl;
      if (!videoUrl) throw new Error('未获取到视频地址（视频可能已删除或仅作者可见）');
      debugLog('视频直链', videoUrl.slice(0, 140));

      setStatus('正在下载视频…');
      updateProgress('正在下载视频', null, desc || '');
      const bytes = await wxDownloadVideo(videoUrl, (loaded, total) => {
        updateProgress('正在下载视频', total ? loaded / total : null,
          `${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ''}`);
      });
      if (wxIsEncrypted(bytes)) {
        throw new Error('该视频已加密，暂不支持自动转写');
      }
      const duration = wxReadDuration(bytes);
      debugLog('下载完成', { bytes: bytes.length, duration });

      const { text, chunkCount } = await wxTranscribeBytes(bytes, apiKey);
      if (!text) throw new Error('语音识别结果为空');
      const elapsedMs = Date.now() - startedAt;
      writeCache(BODY_CACHE_PREFIX, cacheKey, text);
      pushAsrHistory({ audioSeconds: duration, elapsedMs, chunkCount, at: Date.now() });
      if (resultEl) resultEl.value = text;
      setStatus(`完成：${text.length} 字符 · 用时 ${formatElapsed(elapsedMs)}`);
      await writeClipboard(text);
      showToast(`已通过语音识别复制，共 ${text.length} 个字符 · 用时 ${formatElapsed(elapsedMs)}`);
    } catch (error) {
      console.error('[复制字幕][视频号]', error);
      setStatus(`失败：${error.message || error}`);
      showToast(`视频号转文字失败：${error.message || error}`);
    } finally {
      hideProgressPanel();
      if (startEl) startEl.disabled = false;
    }
  }

  function openWxchannelsPanel() {
    let panel = document.getElementById(WX_PANEL_ID);
    if (panel) {
      panel.dataset.hidden = 'false';
      panel.querySelector('.wx-input')?.focus();
      return;
    }
    panel = document.createElement('div');
    panel.id = WX_PANEL_ID;
    const title = document.createElement('div');
    title.className = 'wx-title';
    title.textContent = '视频号转文字';
    const input = document.createElement('input');
    input.className = 'wx-input';
    input.placeholder = '粘贴视频号分享链接（weixin.qq.com/sph/…）';
    input.spellcheck = false;
    // 在视频号页面打开时自动带上当前视频的短链。
    if (site === 'wxchannels') {
      const id = new URL(location.href).searchParams.get('id');
      if (id) input.value = `https://weixin.qq.com/sph/${id}`;
    }
    const row = document.createElement('div');
    row.className = 'wx-row';
    const startButton = document.createElement('button');
    startButton.className = 'wx-start';
    startButton.textContent = '开始转文字';
    const cancelButton = document.createElement('button');
    cancelButton.className = 'ghost';
    cancelButton.textContent = '收起';
    row.appendChild(startButton);
    row.appendChild(cancelButton);
    const status = document.createElement('div');
    status.className = 'wx-status';
    status.textContent = '需先在设置里配置 StepFun Key 与元宝 Cookie（右上角 ⚙）';
    const result = document.createElement('textarea');
    result.className = 'wx-result';
    result.placeholder = '转写结果会显示在这里，并自动复制到剪贴板';
    result.readOnly = true;
    const resultRow = document.createElement('div');
    resultRow.className = 'wx-row';
    const copyButton = document.createElement('button');
    copyButton.textContent = '复制文字';
    const closeButton = document.createElement('button');
    closeButton.className = 'ghost';
    closeButton.textContent = '关闭';
    resultRow.appendChild(copyButton);
    resultRow.appendChild(closeButton);

    startButton.addEventListener('click', () => runWxchannelsTranscribe(input.value));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') runWxchannelsTranscribe(input.value);
    });
    cancelButton.addEventListener('click', () => { panel.dataset.hidden = 'true'; });
    copyButton.addEventListener('click', async () => {
      const text = result.value || '';
      if (!text) {
        showToast('还没有转写结果');
        return;
      }
      await writeClipboard(text);
      showToast(`已复制 ${text.length} 个字符`);
    });
    closeButton.addEventListener('click', () => panel.remove());

    panel.appendChild(title);
    panel.appendChild(input);
    panel.appendChild(row);
    panel.appendChild(status);
    panel.appendChild(result);
    panel.appendChild(resultRow);
    document.body.appendChild(panel);
    input.focus();
  }

  async function writeClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  let toastTimer = 0;
  function showToast(message) {
    clearTimeout(toastTimer);
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.body.appendChild(toast);
    toastTimer = window.setTimeout(() => toast.remove(), 3200);
  }

  async function copyAllSubtitles() {
    const button = document.getElementById(BUTTON_ID);
    if (button) {
      button.disabled = true;
      button.textContent = '正在获取';
    }

    try {
      const video = resolveCurrentVideo();
      const videoKey = videoCacheKey(video);
      const subtitles = await fetchSubtitleMeta(video);
      if (videoCacheKey(resolveCurrentVideo()) !== videoKey) {
        throw new Error('检测到页面已切换视频，请重试以避免读取到其他视频字幕');
      }
      populateLanguageSelect(subtitles, videoKey);
      const selectedLanguage = document.getElementById(SELECT_ID)?.value || 'auto';
      const subtitle = chooseSubtitle(subtitles, selectedLanguage);
      if (!subtitle?.subtitle_url) {
        if (!getAsrApiKey()) {
          openSettingsPanel();
          showToast('当前视频没有字幕，请先设置 StepFun API Key');
          return;
        }
        // 先取音频信息（不含下载），用于展示时长与预估耗时。
        const track = await fetchAudioTrack(video);
        // Fork：章节选择（无章节则保持原行为）
        let chapters = readCache(CHAPTER_CACHE_PREFIX, videoKey);
        if (chapters === null || chapters === undefined) {
          chapters = await fetchVideoChapters(video);
          writeCache(CHAPTER_CACHE_PREFIX, videoKey, chapters);
        }
        let selection = { mode: 'full' };
        if (Array.isArray(chapters) && chapters.length) {
          const picked = await showChapterPanel(chapters, track);
          if (!picked) return; // 用户取消
          selection = picked;
        }
        const selHash = selectionHash(selection);
        const scopeMs = selectionDurationMs(selection, (track.duration || 0) * 1000);
        const estimateSeconds = estimateAsrSeconds(track.duration) * (track.duration ? scopeMs / (track.duration * 1000) : 1);
        if (!asrConsentGiven && !window.confirm(
          (selection.mode === 'full'
            ? `当前视频没有字幕，将下载音频（约 ${formatAudioDuration(track.duration)}）`
            : `当前视频没有字幕，将识别所选 ${selection.ranges.length} 个章节（约 ${formatAudioDuration(scopeMs / 1000)}）`)
          + `并通过 StepFun 语音识别生成文字，会产生费用并上传音频。`
          + `${estimateSeconds > 0 ? `根据历史记录预计用时约 ${Math.round(estimateSeconds)} 秒。` : ''}是否继续？`
        )) return;
        asrConsentGiven = true;

        const asrCacheKey = `${videoKey}:asr-v2:${selHash}`;
        let text = readCache(BODY_CACHE_PREFIX, asrCacheKey);
        const fromCache = !!text;
        const startedAt = Date.now();
        let chunkCount = 1;
        let asrDegraded = false;
        if (!text) {
          showProgressPanel();
          try {
            let result;
            const ui = { progress: (stage, fraction, detail) => updateProgress(stage, fraction, detail) };
            try {
              result = await runAsrWithWorker(video, track, selection, ui);
            } catch (workerError) {
              console.warn('[复制字幕] 工作标签页不可用，回退本页识别', workerError);
              showToast(`工作标签页不可用（${workerError.message || workerError}），已回退本页识别`);
              result = await transcribeVideoAudio(video, track, selection, {
                onDownloadProgress: f => updateProgress('正在下载音频', f, ''),
                onChunkDelta: () => updateProgress('正在识别', null, ''),
                refreshTrack: () => fetchAudioTrack(video),
              });
            }
            clearCheckpointsFor(videoKey, selHash);
            text = result.text;
            chunkCount = result.chunkCount;
            asrDegraded = !!result.degraded;
          } finally {
            hideProgressPanel();
          }
        }
        const elapsedMs = Date.now() - startedAt;
        if (videoCacheKey(resolveCurrentVideo()) !== videoKey) {
          throw new Error('检测到页面已切换视频，已停止识别');
        }
        if (!text) throw new Error('语音识别结果为空');
        // 仅统计真实发生的识别，缓存命中不写入历史。
        if (!fromCache) {
          pushAsrHistory({
            audioSeconds: Math.round(scopeMs / 1000),
            elapsedMs,
            chunkCount,
            at: Date.now(),
          });
        }
        if (text && !asrDegraded) writeCache(BODY_CACHE_PREFIX, asrCacheKey, text);
        await writeClipboard(text);
        showToast(fromCache
          ? `已通过语音识别复制，共 ${text.length} 个字符（标签页缓存）`
          : `已通过语音识别复制，共 ${text.length} 个字符 · 用时 ${formatElapsed(elapsedMs)}`);
        return;
      }
      const url = subtitle.subtitle_url.startsWith('//')
        ? `https:${subtitle.subtitle_url}`
        : subtitle.subtitle_url;
      // 字幕 CDN 的跨域响应不接受携带 Cookie 的凭据请求。
      const bodyCacheKey = `${videoCacheKey(video)}:${subtitle.lan || url}`;
      let text = readCache(BODY_CACHE_PREFIX, bodyCacheKey);
      if (!text) {
        const body = await fetchSubtitleBody(video, subtitle);
        text = normalizeSubtitle(body);
        if (text) writeCache(BODY_CACHE_PREFIX, bodyCacheKey, text);
      }
      if (videoCacheKey(resolveCurrentVideo()) !== videoKey) {
        throw new Error('检测到页面已切换视频，已停止复制旧字幕');
      }
      if (!text) throw new Error('字幕内容为空');

      await writeClipboard(text);
      const language = subtitleLanguageLabel(subtitle);
      showToast(`已复制${language}，共 ${text.length} 个字符`);
    } catch (error) {
      console.error('[复制字幕]', error);
      showToast(`复制失败：${error.message || error}`);
    } finally {
      hideProgressPanel();
      if (button) {
        button.disabled = false;
        button.textContent = '复制全部字幕';
      }
    }
  }

  

  function isHidden() {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  }

  function mountButton() {
    if (!document.body || document.getElementById(CONTROLS_ID)) return;
    const controls = document.createElement('div');
    controls.id = CONTROLS_ID;
    // 语言下拉与复制按钮仅在 B 站 / YouTube 页面有意义；视频号与元宝页面只保留功能入口。
    if (site === 'bilibili' || site === 'youtube') {
      const select = document.createElement('select');
      select.id = SELECT_ID;
      select.title = '选择要复制的字幕语言';
      const option = document.createElement('option');
      option.value = 'auto';
      option.textContent = '中文（默认）';
      select.appendChild(option);
      controls.appendChild(select);
      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.textContent = '复制全部字幕';
      button.title = '复制当前视频的纯文字字幕；无字幕视频可回退到语音识别';
      button.dataset.hidden = String(isHidden());
      button.addEventListener('click', copyAllSubtitles);
      controls.appendChild(button);
    }
    // 视频号入口：所有已匹配站点都显示，方便与另外两个站点统一使用。
    const wxButton = document.createElement('button');
    wxButton.id = WX_BUTTON_ID;
    wxButton.type = 'button';
    wxButton.textContent = '视频号转文字';
    wxButton.title = '粘贴视频号分享链接，经语音识别转成文字';
    wxButton.dataset.hidden = String(isHidden());
    wxButton.addEventListener('click', openWxchannelsPanel);
    controls.appendChild(wxButton);
    // 设置入口：刻意弱化的齿轮，鼠标悬停才清晰。
    const settingsButton = document.createElement('button');
    settingsButton.id = SETTINGS_BUTTON_ID;
    settingsButton.type = 'button';
    settingsButton.textContent = '⚙';
    settingsButton.title = '设置（Key / 端点 / 调试 / 元宝 Cookie / 缓存）';
    settingsButton.addEventListener('click', () => openSettingsPanel());
    controls.appendChild(settingsButton);
    controls.dataset.hidden = String(isHidden());
    document.body.appendChild(controls);
  }

  if (isWorkerTab()) {
    // Fork：工作标签页只接识别任务，不挂任何 UI
    attachAsrWorker();
  } else {
    GM_registerMenuCommand('复制当前视频全部字幕', copyAllSubtitles);
    GM_registerMenuCommand('视频号转文字', openWxchannelsPanel);
    GM_registerMenuCommand('设置（Key / 端点 / 调试 / 缓存）', () => openSettingsPanel());
    GM_registerMenuCommand('显示/隐藏页面按钮', () => {
      const hidden = !isHidden();
      localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
      const button = document.getElementById(BUTTON_ID);
      if (button) button.dataset.hidden = String(hidden);
      const controls = document.getElementById(CONTROLS_ID);
      if (controls) controls.dataset.hidden = String(hidden);
    });
    GM_registerMenuCommand('清除识别断点', () => {
      if (typeof GM_listValues !== 'function') return;
      let n = 0;
      for (const k of GM_listValues()) {
        if (k.startsWith(CHECKPOINT_PREFIX)) { try { GM_deleteValue(k); n++; } catch (_) { /* ignore */ } }
      }
      showToast(`已清除 ${n} 条识别断点`);
    });

    mountButton();
    new MutationObserver(mountButton).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
