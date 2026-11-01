// 第一梯队修复的单测：错误分类 + SSE 解析 + 双路兜底行为
// 运行：node tier1-fix.test.js
const fs = require('fs');

const SCRIPT = process.env.BCS_SCRIPT
  || '/Users/jinzihan/.zcode/workspace/draft-cd30c590-2277-4c95-9cc1-48e10c14d4e3/bilibili-copy-subtitles/bilibili-copy-subtitles.user.js';
const src = fs.readFileSync(SCRIPT, 'utf8');

// 注意两点，否则会静默取错：
// 1) 要从声明开头取，否则 "async function" 的 async 前缀会被丢掉；
// 2) 函数体的 { 要跳过参数列表里可能出现的 {} 默认值（如 options = {}）。
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('未找到函数: ' + name);
  const start = src.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const paren = src.indexOf(')', at);
  let i = src.indexOf('{', paren), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  const code = src.slice(start, end);
  if (!code.trimEnd().endsWith('}')) throw new Error('提取不完整: ' + name);
  return code;
}

// ---- 环境桩 ----
const SSE_DONE = t => `data: ${JSON.stringify({ type: 'transcript.text.done', text: t })}\n\n`;
const SSE_DELTA = (t, end_time) => `data: ${JSON.stringify({ type: 'transcript.text.delta', text: t, end_time })}\n\n`;
const SSE_ERR = m => `data: ${JSON.stringify({ type: 'error', message: m })}\n\n`;

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  \u2705 ' : '  \u274c ') + name + (ok ? '' : `\n       got : ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

// ============ 1. describeRequestError ============
console.log('--- describeRequestError 错误分类 ---');
{
  const describeRequestError = eval('(' + extract('describeRequestError') + ')');
  const location = { href: 'https://www.bilibili.com/video/BV1xx/' };

  const e1 = describeRequestError(new TypeError('Failed to fetch'), 'https://api.stepfun.com/step_plan/v1/audio/asr/sse');
  t('TypeError -> 含域名', /api\.stepfun\.com/.test(e1.message), true);
  t('TypeError -> 含代理建议', /代理/.test(e1.message), true);
  t('TypeError -> 含无痕窗口建议', /无痕窗口/.test(e1.message), true);
  t('TypeError -> 含 @connect 建议', /@connect/.test(e1.message), true);
  t('TypeError -> 不再出现原始 Failed to fetch 字样', /Failed to fetch/.test(e1.message), false);

  const e2 = describeRequestError(new TypeError('Failed to fetch'), 'https://api.bilibili.com/x/player/v2', true);
  t('双通道失败 -> 明说两条都失败', /两条请求通道都失败/.test(e2.message), true);

  const e3 = describeRequestError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'https://x.com/a');
  t('AbortError -> 超时提示', /超时/.test(e3.message), true);

  const e4 = describeRequestError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'https://x.com/a');
  t('TimeoutError -> 超时提示', /超时/.test(e4.message), true);

  const e5 = describeRequestError(new Error('ECONNREFUSED 1.2.3.4:443'), 'https://cdn.example.com/f.m4s');
  t('普通错误 -> 保留原文并带域名', e5.message, 'cdn.example.com 请求失败：ECONNREFUSED 1.2.3.4:443');

  // location.href 也不可解析时（正常页面不会发生，属防御分支）
  location.href = 'also-not-a-url';
  const e6 = describeRequestError(new TypeError('Failed to fetch'), 'not-a-url');
  t('URL 与 location 均不可解析 -> 未知地址兜底不抛异常', /未知地址/.test(e6.message), true);
  location.href = 'https://www.bilibili.com/video/BV1xx/';

  const e6b = describeRequestError(new TypeError('Failed to fetch'), 'not-a-url');
  t('相对地址 -> 基于 location.href 解析出域名', /www\.bilibili\.com/.test(e6b.message), true);

  const e7 = describeRequestError(new TypeError('NetworkError when attempting to fetch resource.'), 'https://a.com/x');
  t('Firefox NetworkError 措辞也命中分类', /无法连接 a\.com/.test(e7.message), true);

  const e8 = describeRequestError(new TypeError('load failed'), 'https://a.com/x');
  t('Safari load failed 措辞也命中分类', /无法连接 a\.com/.test(e8.message), true);
}

// ============ 2. createSseParser ============
console.log('\n--- createSseParser SSE 解析 ---');
{
  const createSseParser = eval('(' + extract('createSseParser') + ')');

  let deltas = [];
  const p1 = createSseParser(v => deltas.push(v));
  p1.push(SSE_DELTA('你', 100) + SSE_DELTA('好', 250) + SSE_DONE('你好'));
  t('完整块 -> 取到 text', p1.text, '你好');
  t('delta -> onDelta 回调', deltas, [100, 250]);

  const p2 = createSseParser(() => {});
  p2.push(SSE_DONE('第一段'));
  p2.push(SSE_DONE('最终段'));
  t('多个 done -> 取最后一个', p2.text, '最终段');

  const p3 = createSseParser(() => {});
  p3.push('data: {"type":"transcript.text.done","text":"跨');
  t('半个块 -> 先不产出', p3.text, '');
  p3.push('块"}\n\n');
  t('补齐后 -> 完整产出', p3.text, '跨块');

  const p4 = createSseParser(() => {});
  const full = SSE_DELTA('甲', 10) + SSE_DELTA('乙', 20) + SSE_DONE('甲乙');
  for (const ch of full) p4.push(ch);   // 逐字符喂，模拟流式
  t('逐字符流式 -> 不丢事件', p4.text, '甲乙');

  const p5 = createSseParser(() => {});
  p5.push(SSE_DONE('a') + SSE_DONE('b') + 'data: {"type":"transcript.text.done","text":"c"}');
  t('两个完整块 + 一个残块 -> 产出最后一个完整块', p5.text, 'b');

  const d6 = [];
  const p6 = createSseParser(v => d6.push(v));
  p6.push(SSE_DELTA('忽略', 0));
  t('end_time=0 -> 不上报进度', d6, []);

  const p7 = createSseParser(() => {});
  let threw = null;
  try { p7.push(SSE_ERR('quota exceeded')); } catch (e) { threw = e.message; }
  t('error 事件 -> 抛出服务端消息', threw, 'quota exceeded');

  const p8 = createSseParser(() => {});
  let threw8 = null;
  try { p8.push('data: {坏 JSON}\n\n'); } catch (e) { threw8 = e.constructor.name; }
  t('坏 JSON -> 抛出 SyntaxError', threw8, 'SyntaxError');

  // 同一事件块内多行 data: 按 SSE 规范以 \n 连接，连接后不是合法 JSON 会抛错。
  // 这与重构前的实现行为一致（StepFun 实际每事件只发一行 data:），此处固化以免将来被无意改掉。
  const p9 = createSseParser(() => {});
  let threw9 = null;
  try {
    p9.push('data: {"type":"transcript.text.done","text":"a"}\ndata: {"type":"transcript.text.done","text":"b"}\n\n');
  } catch (e) { threw9 = e.constructor.name; }
  t('同块多行 data: -> 以 \\n 连接后解析（保持原行为）', threw9, 'SyntaxError');

  // 单事件单行 data: 是真实形态，必须正常
  const p9b = createSseParser(() => {});
  p9b.push('data: {"type":"transcript.text.done","text":"单行"}\n\n');
  t('单行 data: -> 正常产出', p9b.text, '单行');

  const p10 = createSseParser(() => {});
  p10.push(': 这是注释行\n\ndata: {"type":"transcript.text.done","text":"ok"}\n\n');
  t('无 data: 的块 -> 安全跳过', p10.text, 'ok');

  const p11 = createSseParser(() => {});
  p11.push('');
  t('空输入 -> 不抛异常', p11.text, '');
}

// ============ 3. transcribeAudioChunk 双路行为 ============
(async () => {
console.log('--- transcribeAudioChunk 双路兜底 ---');
{
  const code = [
    extract('createSseParser'),
    extract('transcribeChunkByFetch'),
    extract('transcribeChunkByGM'),
    extract('transcribeAudioChunk'),
    extract('describeRequestError'),
  ].join('\n');

  const ENDPOINT = 'https://api.stepfun.com/step_plan/v1/audio/asr/sse';
  const sandbox = {
    getAsrEndpoint: () => ENDPOINT,
    getAsrLanguage: () => 'zh',
    ASR_MODEL: 'stepaudio-2.5-asr',
    ASR_REQUEST_TIMEOUT_MS: 1000,
    bytesToBase64: () => 'QUJD',
    GM_xmlhttpRequest: null,
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    location: { href: 'https://www.bilibili.com/video/BV1xx/' },
  };
  // 抽出的函数体里含 await，必须包在 async 函数里才能用 new Function 构造。
  // new Function 按值传参，改了 sandbox 必须重建，所以包一层 buildFn()。
  const buildFn = async () => {
    const make = new Function(...Object.keys(sandbox),
      'return (async () => { ' + code + '; return transcribeAudioChunk; })()');
    return make(...Object.values(sandbox));
  };
  let fn = await buildFn();

  function readerFrom(chunks) {
    let i = 0;
    return { getReader: () => ({ read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }, releaseLock: () => {} }) };
  }
  const okResp = txt => ({ ok: true, status: 200, body: readerFrom([new TextEncoder().encode(txt)]) });

  // 3.1 fetch 成功 -> 不走 GM
  let gmCalls = 0;
  sandbox.GM_xmlhttpRequest = d => { gmCalls++; d.onload({ status: 200, responseText: SSE_DONE('GM 文本') }); };
  fn = await buildFn();
  global.fetch = async () => okResp(SSE_DONE('fetch 文本'));
  t('fetch 成功 -> 返回 fetch 结果', await fn(new Uint8Array([1]), 'KEY', null), 'fetch 文本');
  t('fetch 成功 -> 不调 GM', gmCalls, 0);

  // 3.2 fetch 抛 TypeError -> 回退 GM 并成功
  gmCalls = 0;
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  t('fetch 失败 -> GM 兜底成功', await fn(new Uint8Array([1]), 'KEY', null), 'GM 文本');
  t('fetch 失败 -> 确实调了 GM', gmCalls, 1);

  // 3.3 两条都失败 -> 分类错误
  sandbox.GM_xmlhttpRequest = d => d.onerror({ status: 0 });
  fn = await buildFn();
  let err3 = null;
  try { await fn(new Uint8Array([1]), 'KEY', null); } catch (e) { err3 = e; }
  t('双通道失败 -> 抛错', err3 instanceof Error, true);
  t('双通道失败 -> 提示两条都失败', /两条请求通道都失败/.test(err3.message), true);
  t('双通道失败 -> 不再是裸 Failed to fetch', /^Failed to fetch/.test(err3.message), false);

  // 3.4 HTTP 4xx -> 不换通道（换也无意义）
  gmCalls = 0;
  sandbox.GM_xmlhttpRequest = d => { gmCalls++; d.onload({ status: 200, responseText: SSE_DONE('x') }); };
  fn = await buildFn();
  global.fetch = async () => ({ ok: false, status: 401, body: null });
  let err4 = null;
  try { await fn(new Uint8Array([1]), 'KEY', null); } catch (e) { err4 = e; }
  t('HTTP 401 -> 报 HTTP 401', /HTTP 401/.test(err4.message), true);
  t('HTTP 401 -> 不调 GM', gmCalls, 0);

  // 3.5 无 GM_xmlhttpRequest -> 直接分类抛出
  sandbox.GM_xmlhttpRequest = undefined;
  fn = await buildFn();
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let err5 = null;
  try { await fn(new Uint8Array([1]), 'KEY', null); } catch (e) { err5 = e; }
  t('无 GM -> 仍给出分类提示', /无法连接 api\.stepfun\.com/.test(err5.message), true);

  // 3.6 请求体确实带上了模型/语言/时间戳
  sandbox.GM_xmlhttpRequest = d => d.onload({ status: 200, responseText: SSE_DONE('x') });
  fn = await buildFn();
  let sentBody = null;
  global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return okResp(SSE_DONE('ok')); };
  await fn(new Uint8Array([1]), 'MYKEY', null);
  t('请求体 -> 端点正确', sentBody.audio.input.transcription.model, 'stepaudio-2.5-asr');
  t('请求体 -> 语言正确', sentBody.audio.input.transcription.language, 'zh');
  t('请求体 -> 开启时间戳', sentBody.audio.input.transcription.enable_timestamp, true);
  t('请求体 -> 带 base64 音频', sentBody.audio.data, 'QUJD');

  // 3.7 流式分多片 -> delta 进度回调按顺序上报
  const deltas = [];
  global.fetch = async () => ({
    ok: true, status: 200,
    body: readerFrom([
      new TextEncoder().encode(SSE_DELTA('一', 500)),
      new TextEncoder().encode(SSE_DELTA('二', 900) + SSE_DONE('一二')),
    ]),
  });
  await fn(new Uint8Array([1]), 'K', v => deltas.push(v));
  t('多片流式 -> 进度按序上报', deltas, [500, 900]);

  // 3.8 GM 通路返回的 SSE 与 fetch 通路解析结果一致（双路不漂移）
  sandbox.GM_xmlhttpRequest = d => d.onload({
    status: 200,
    responseText: SSE_DELTA('甲', 100) + SSE_DELTA('乙', 200) + SSE_DONE('甲乙'),
  });
  fn = await buildFn();
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  t('GM 通路 -> 与 fetch 通路解析一致', await fn(new Uint8Array([1]), 'K', null), '甲乙');

  // 3.9 浏览器网络失败 + GM 拿到服务端错误：不能包装成"无法连接"
  // （回归：曾经把 StepFun 的 audio.data 校验失败误报成代理/扩展问题）
  sandbox.GM_xmlhttpRequest = d => d.onload({ status: 200, responseText: SSE_ERR('audio.data or audio.url is required') });
  fn = await buildFn();
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let err9 = null;
  try { await fn(new Uint8Array([1]), 'K', null); } catch (e) { err9 = e; }
  t('服务端错误 -> 不被误报成连接问题', /无法连接/.test(err9.message), false);
  t('服务端错误 -> 原样呈现服务端消息', /audio\.data or audio\.url is required/.test(err9.message), true);
  t('服务端错误 -> 仍带域名便于定位', /api\.stepfun\.com/.test(err9.message), true);
}

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
