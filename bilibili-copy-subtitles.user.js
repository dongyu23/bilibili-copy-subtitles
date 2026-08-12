// ==UserScript==
// @name         Bilibili 一键复制全部字幕
// @namespace    https://github.com/dongyu23/bilibili-copy-subtitles
// @version      1.3.0
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
  const TOAST_ID = 'bili-copy-all-subtitles-toast';
  const HIDDEN_KEY = 'bili-copy-subtitles-button-hidden';

  GM_addStyle(`
    #${BUTTON_ID} {
      position: fixed;
      z-index: 100001;
      left: 18px;
      bottom: 24px;
      width: 48px;
      min-height: 116px;
      padding: 12px 10px;
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: #00aeec;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      cursor: pointer;
      transition: background .18s ease, transform .18s ease, opacity .18s ease;
    }
    #${BUTTON_ID}:hover { background: #009bd3; transform: translateY(-2px); }
    #${BUTTON_ID}:disabled { cursor: wait; opacity: .72; transform: none; }
    #${BUTTON_ID}[data-hidden="true"] { display: none; }
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
      #${BUTTON_ID} { left: 10px; bottom: 86px; }
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
      bvid: videoData.bvid || state.bvid || urlBvid || '',
      aid: videoData.aid || state.aid || epInfo.aid || playInfo.aid || 0,
      cid: currentPage?.cid || videoData.cid || state.cid || epInfo.cid || playInfo.cid || 0,
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

  function chooseSubtitle(subtitles) {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
    const preference = [
      subtitle => /^(zh|ai-zh)/i.test(subtitle.lan || ''),
      subtitle => /中文|汉语|简体|繁体/.test(subtitle.lan_doc || ''),
      subtitle => !/ai-/.test(subtitle.lan || ''),
    ];
    for (const matcher of preference) {
      const match = subtitles.find(matcher);
      if (match) return match;
    }
    return subtitles[0];
  }

  async function fetchSubtitleMeta(video) {
    const query = new URLSearchParams({ cid: String(video.cid) });
    if (video.bvid) query.set('bvid', video.bvid);
    else query.set('aid', String(video.aid));

    const result = await requestJson(`https://api.bilibili.com/x/player/v2?${query}`);
    if (result.code !== 0) throw new Error(result.message || '无法读取字幕列表');
    return chooseSubtitle(result.data?.subtitle?.subtitles);
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
      const subtitle = await fetchSubtitleMeta(video);
      if (!subtitle?.subtitle_url) {
        throw new Error('当前视频没有可用字幕（UP 主可能未上传字幕）');
      }
      const url = subtitle.subtitle_url.startsWith('//')
        ? `https:${subtitle.subtitle_url}`
        : subtitle.subtitle_url;
      // 字幕 CDN 的跨域响应不接受携带 Cookie 的凭据请求。
      const subtitleData = await requestJson(url, { credentials: 'omit' });
      const text = normalizeSubtitle(subtitleData.body);
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
    if (!document.body || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '复制全部字幕';
    button.title = '复制当前视频的纯文字字幕';
    button.dataset.hidden = String(isHidden());
    button.addEventListener('click', copyAllSubtitles);
    document.body.appendChild(button);
  }

  GM_registerMenuCommand('复制当前视频全部字幕', copyAllSubtitles);
  GM_registerMenuCommand('显示/隐藏页面按钮', () => {
    const hidden = !isHidden();
    localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
    const button = document.getElementById(BUTTON_ID);
    if (button) button.dataset.hidden = String(hidden);
  });

  mountButton();
  new MutationObserver(mountButton).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
