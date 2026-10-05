// ==UserScript==
// @name         Bilibili 一键复制全部字幕
// @namespace    https://github.com/dongyu23/bilibili-copy-subtitles
// @version      1.6.0
// @description  一键复制当前 Bilibili 视频的纯文字字幕，去除时间戳和字幕边界并保留正文标点；无字幕视频可回退到 StepFun 语音识别，支持 Key 图形化配置、识别进度与耗时统计。
// @author       dongyu23
// @homepageURL  https://github.com/dongyu23/bilibili-copy-subtitles
// @supportURL  https://github.com/dongyu23/bilibili-copy-subtitles/issues
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
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      *.hdslb.com
// @connect      *.bilivideo.com
// @connect      api.stepfun.com
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
  const playerPlayApiUrls = [];
  let asrConsentGiven = false;

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
  const ASR_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
  const PROGRESS_PANEL_ID = 'bili-copy-asr-progress';
  const KEY_PANEL_ID = 'bili-copy-asr-key-panel';

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
      width: 340px;
      max-width: calc(100vw - 40px);
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

  // ===== 无字幕视频的语音识别兜底 =====

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

  function openKeyConfigPanel() {
    if (document.getElementById(KEY_PANEL_ID)) {
      document.getElementById(KEY_PANEL_ID).querySelector('.key-input')?.focus();
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = KEY_PANEL_ID;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'StepFun API Key 设置';
    const status = document.createElement('div');
    status.className = 'panel-status';
    const current = getAsrApiKey();
    status.textContent = current
      ? `当前已设置：${current.slice(0, 4)}****${current.slice(-4)}`
      : '当前未设置 Key';
    const input = document.createElement('input');
    input.className = 'key-input';
    input.type = 'password';
    input.placeholder = '粘贴 StepFun API Key';
    input.value = current || '';
    const row = document.createElement('div');
    row.className = 'panel-row';
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存';
    const clearButton = document.createElement('button');
    clearButton.textContent = '清除';
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
    hint.textContent = 'Key 仅保存在浏览器本地，用于无字幕视频的语音识别兜底，不会上传到其他服务器。';
    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(input);
    panel.appendChild(row);
    panel.appendChild(hint);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    input.focus();

    saveButton.addEventListener('click', () => {
      setAsrApiKey(input.value);
      const value = getAsrApiKey();
      status.textContent = value ? `当前已设置：${value.slice(0, 4)}****${value.slice(-4)}` : '当前未设置 Key';
      showToast(value ? 'StepFun API Key 已保存' : '已清除 StepFun API Key');
      if (value) closeKeyConfigPanel();
    });
    clearButton.addEventListener('click', () => {
      setAsrApiKey('');
      input.value = '';
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
      try {
        showToast(await testAsrKeyConnection(value));
      } finally {
        testButton.disabled = false;
        testButton.textContent = '测试连接';
      }
    });
    cancelButton.addEventListener('click', closeKeyConfigPanel);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeKeyConfigPanel();
    });
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

  function closeKeyConfigPanel() {
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

  async function fetchAudioTrack(video) {
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
      else console.warn('[Bilibili 复制字幕] 播放接口返回异常', result.code, result.message);
    } catch (error) {
      console.warn('[Bilibili 复制字幕] 播放接口请求失败，尝试复用播放器请求', error);
    }
    if (!data?.dash) {
      const captured = findCapturedPlayApiUrl(video);
      if (captured) {
        try {
          const result = await requestJson(captured);
          if (result.code === 0) data = result.data;
        } catch (error) {
          console.warn('[Bilibili 复制字幕] 复用播放器音频请求失败', error);
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
  async function downloadAudioBytes(track, onProgress) {
    let lastError = null;
    for (const candidate of [track.url, ...track.backups]) {
      let bytes = null;
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          bytes = await downloadByGM(candidate, onProgress);
        } catch (error) {
          lastError = error;
          console.warn('[Bilibili 复制字幕] 油猴下载失败，尝试浏览器下载', candidate, error);
        }
      }
      if (!bytes) {
        try {
          bytes = await downloadByFetch(candidate);
        } catch (error) {
          lastError = error;
          console.warn('[Bilibili 复制字幕] 音频下载失败，尝试下一个地址', candidate, error);
        }
      }
      if (bytes) return bytes;
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

  async function transcribeAudioChunk(bytes, apiKey, onDelta) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ASR_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(ASR_SSE_ENDPOINT, {
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
                language: ASR_LANGUAGE,
                enable_itn: true,
                // 开启时间戳后 SSE 增量会带回每段文字在音频中的位置，用于计算识别进度。
                enable_timestamp: true,
              },
              format: { type: 'm4a' },
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

  async function transcribeVideoAudio(video, track) {
    const apiKey = getAsrApiKey();
    if (!apiKey) {
      throw new Error('尚未设置 StepFun API Key，请在 Tampermonkey 菜单中设置');
    }

    updateProgress('正在下载音频', null, '连接中');
    const bytes = await downloadAudioBytes(track, (loaded, total) => {
      updateProgress('正在下载音频', total ? loaded / total : null, `${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ''}`);
    });

    const chunks = splitAudioChunks(bytes, MAX_AUDIO_CHUNK_BYTES);
    const totalDurationMs = (track.duration || 0) * 1000;
    let text = '';
    for (let index = 0; index < chunks.length; index += 1) {
      // 分片时长按体积占比估算，用于把增量时间戳换算成总进度。
      const chunkDurationMs = bytes.length > 0
        ? (chunks[index].length / bytes.length) * totalDurationMs
        : 0;
      const stageText = chunks.length > 1 ? `正在识别（第 ${index + 1}/${chunks.length} 段）` : '正在识别';
      updateProgress(stageText, index / chunks.length, chunks.length > 1 ? formatMB(chunks[index].length) : '');
      text += await transcribeAudioChunk(chunks[index], apiKey, endTimeMs => {
        const fraction = chunkDurationMs > 0 ? Math.min(1, endTimeMs / chunkDurationMs) : 0;
        updateProgress(stageText, (index + fraction) / chunks.length, chunks.length > 1 ? formatMB(chunks[index].length) : '');
      });
    }
    return { text: normalizeSubtitle([{ content: text }]), chunkCount: chunks.length };
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
        if (!getAsrApiKey()) {
          openKeyConfigPanel();
          showToast('当前视频没有字幕，请先设置 StepFun API Key');
          return;
        }
        // 先取音频信息（不含下载），用于展示时长与预估耗时。
        const track = await fetchAudioTrack(video);
        const estimateSeconds = estimateAsrSeconds(track.duration);
        if (!asrConsentGiven && !window.confirm(
          `当前视频没有字幕，将下载音频（约 ${formatAudioDuration(track.duration)}）`
          + `并通过 StepFun 语音识别生成文字，会产生费用并上传音频。`
          + `${estimateSeconds > 0 ? `根据历史记录预计用时约 ${Math.round(estimateSeconds)} 秒。` : ''}是否继续？`
        )) return;
        asrConsentGiven = true;

        const asrCacheKey = `${videoCacheKey(video)}:asr-v1`;
        let text = readCache(BODY_CACHE_PREFIX, asrCacheKey);
        const fromCache = !!text;
        const startedAt = Date.now();
        let chunkCount = 1;
        if (!text) {
          showProgressPanel();
          try {
            const result = await transcribeVideoAudio(video, track);
            text = result.text;
            chunkCount = result.chunkCount;
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
            audioSeconds: track.duration || 0,
            elapsedMs,
            chunkCount,
            at: Date.now(),
          });
        }
        if (text) writeCache(BODY_CACHE_PREFIX, asrCacheKey, text);
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
      hideProgressPanel();
      if (button) {
        button.disabled = false;
        button.textContent = '复制全部字幕';
      }
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
    button.title = '复制当前视频的纯文字字幕；无字幕视频可回退到语音识别';
    button.dataset.hidden = String(isHidden());
    button.addEventListener('click', copyAllSubtitles);
    controls.appendChild(button);
    controls.dataset.hidden = String(isHidden());
    document.body.appendChild(controls);
  }

  GM_registerMenuCommand('复制当前视频全部字幕', copyAllSubtitles);
  GM_registerMenuCommand('设置 StepFun API Key（无字幕视频语音识别）', openKeyConfigPanel);
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
