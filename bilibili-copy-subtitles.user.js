// ==UserScript==
// @name         Bilibili 一键复制全部字幕
// @namespace    https://github.com/dongyu23/bilibili-copy-subtitles
// @version      1.4.1
// @description  一键复制当前 Bilibili 视频的纯文字字幕，去除时间戳和字幕边界并保留正文标点。
// @author       dongyu23
// @homepageURL  https://github.com/dongyu23/bilibili-copy-subtitles
// @supportURL   https://github.com/dongyu23/bilibili-copy-subtitles/issues
// @downloadURL  https://raw.githubusercontent.com/dongyu23/bilibili-copy-subtitles/main/bilibili-copy-subtitles.user.js
// @updateURL    https://raw.githubusercontent.com/dongyu23/bilibili-copy-subtitles/main/bilibili-copy-subtitles.user.js
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/medialist/play/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      *.hdslb.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'bili-copy-all-subtitles-button';
  const SELECT_ID = 'bili-copy-all-subtitles-language';
  const CONTROLS_ID = 'bili-copy-all-subtitles-controls';
  const TOAST_ID = 'bili-copy-all-subtitles-toast';
  const HIDDEN_KEY = 'bili-copy-subtitles-button-hidden';
  // v5 在当前标签页生命周期内缓存；关闭标签页后由浏览器自动清除。
  const META_CACHE_PREFIX = 'bili-copy-subtitles-meta-v5:';
  const BODY_CACHE_PREFIX = 'bili-copy-subtitles-body-v5:';
  const memoryCache = new Map();
  const playerApiUrls = [];

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

  performance.getEntriesByType('resource').forEach(entry => rememberPlayerApiUrl(entry.name));
  new PerformanceObserver(list => {
    list.getEntries().forEach(entry => rememberPlayerApiUrl(entry.name));
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
      z-index: 100002;
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
    @media (max-width: 760px) {
      #${CONTROLS_ID} { left: 6px; bottom: 76px; width: 118px; }
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

  function unsafeWindowOrWindow() {
    return typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  }

  function resolveCurrentVideo() {
    const pageIds = getIdFromPage();
    if (pageIds.cid && (pageIds.bvid || pageIds.aid)) return pageIds;
    throw new Error('没有从当前播放器识别到视频编号，请刷新页面后重试');
  }

  function videoCacheKey(video) {
    return `${video.bvid || `av${video.aid}`}:${video.cid}`;
  }

  function readCache(prefix, key) {
    const memory = memoryCache.get(`${prefix}${key}`);
    if (memory) return memory.value;
    try {
      const raw = sessionStorage.getItem(`${prefix}${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'value')) return null;
      memoryCache.set(`${prefix}${key}`, parsed);
      return parsed.value;
    } catch (_) {
      return null;
    }
  }

  function writeCache(prefix, key, value) {
    const entry = { value, cachedAt: new Date().toISOString() };
    memoryCache.set(`${prefix}${key}`, entry);
    try { sessionStorage.setItem(`${prefix}${key}`, JSON.stringify(entry)); } catch (_) { /* storage may be disabled */ }
  }

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

  async function fetchSubtitleMeta(video) {
    const cacheKey = videoCacheKey(video);
    const cached = readCache(META_CACHE_PREFIX, cacheKey);
    if (cached) return cached;
    let subtitles;
    try {
      const playerApiUrl = await waitForPlayerSubtitleApiUrl(video);
      const result = await requestJson(playerApiUrl);
      if (result.code !== 0) throw new Error(result.message || '无法读取播放器字幕列表');
      subtitles = result.data?.subtitle?.subtitles;
    } catch (error) {
      // SPA 切换分 P 时播放器可能暂时不重发签名请求，使用当前 cid 的兼容接口兜底。
      console.warn('[Bilibili 复制字幕] 当前选集播放器请求未出现，尝试按当前 cid 读取', error);
      subtitles = await fetchLegacySubtitleMeta(video);
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

  function chooseSubtitle(subtitles, selectedLanguage = 'auto') {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
    if (selectedLanguage && selectedLanguage !== 'auto') {
      const exact = subtitles.find(subtitle => subtitle.lan === selectedLanguage);
      if (exact) return exact;
    }
    return subtitles.find(isChineseSubtitle)
      || subtitles.find(subtitle => !/ai-/.test(subtitle.lan || ''))
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
      if (!video.cid) throw new Error('没有识别到当前分P');
      const videoKey = videoCacheKey(video);
      const subtitles = await fetchSubtitleMeta(video);
      if (videoCacheKey(resolveCurrentVideo()) !== videoKey) {
        throw new Error('检测到页面已切换视频，请重试以避免读取到其他视频字幕');
      }
      populateLanguageSelect(subtitles, videoKey);
      const selectedLanguage = document.getElementById(SELECT_ID)?.value || 'auto';
      const subtitle = chooseSubtitle(subtitles, selectedLanguage);
      if (!subtitle?.subtitle_url) {
        throw new Error('当前视频没有可用字幕（UP 主可能未上传字幕）');
      }
      const url = subtitle.subtitle_url.startsWith('//')
        ? `https:${subtitle.subtitle_url}`
        : subtitle.subtitle_url;
      // 字幕 CDN 的跨域响应不接受携带 Cookie 的凭据请求。
      const bodyCacheKey = `${videoCacheKey(video)}:${subtitle.lan || url}`;
      let text = readCache(BODY_CACHE_PREFIX, bodyCacheKey);
      if (!text) {
        const subtitleData = await requestJson(url, { credentials: 'omit' });
        text = normalizeSubtitle(subtitleData.body);
        if (text) writeCache(BODY_CACHE_PREFIX, bodyCacheKey, text);
      }
      if (videoCacheKey(resolveCurrentVideo()) !== videoKey) {
        throw new Error('检测到页面已切换视频，已停止复制旧字幕');
      }
      if (!text) throw new Error('字幕内容为空');

      await writeClipboard(text);
      const language = subtitle.lan_doc || subtitle.lan || '字幕';
      showToast(`已复制${language}，共 ${text.length} 个字符`);
    } catch (error) {
      console.error('[Bilibili 复制字幕]', error);
      showToast(`复制失败：${error.message || error}`);
    } finally {
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
    button.title = '复制当前视频的纯文字字幕';
    button.dataset.hidden = String(isHidden());
    button.addEventListener('click', copyAllSubtitles);
    controls.appendChild(button);
    controls.dataset.hidden = String(isHidden());
    document.body.appendChild(controls);
  }

  GM_registerMenuCommand('复制当前视频全部字幕', copyAllSubtitles);
  GM_registerMenuCommand('显示/隐藏页面按钮', () => {
    const hidden = !isHidden();
    localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
    const button = document.getElementById(BUTTON_ID);
    if (button) button.dataset.hidden = String(hidden);
    const controls = document.getElementById(CONTROLS_ID);
    if (controls) controls.dataset.hidden = String(hidden);
  });

  mountButton();
  new MutationObserver(mountButton).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
