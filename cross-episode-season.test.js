// 合集（ugc_season）跨集复制的回归测试（零依赖，仓库既有测试风格：从源码提取函数+桩依赖）
// 背景：v2.7.5 的「跨集复制」只认多分P（videoData.pages.length > 1）；合集视频
// 右侧同样是“视频选集”面板但每集是独立 BV，pages 恒为 1，入口永远不显示。
// v2.8.0 把 ugc_season.sections[].episodes[] 展开成带各自 bvid/aid 的伪分P，
// 逐集管线按每集自己的 bvid+cid 工作。
// 运行：node cross-episode-season.test.js
const fs = require('fs');
const path = require('path');

const SCRIPT = process.env.BCS_SCRIPT
  || path.join(__dirname, 'bilibili-copy-subtitles.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// ---- 从源码提取函数（花括号配平；函数体字符串里无未配平花括号，与仓库其他测试同前提）----
function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let at = -1;
  for (const marker of markers) {
    at = src.indexOf(marker);
    if (at >= 0) break;
  }
  if (at < 0) throw new Error('未找到函数: ' + name);
  const bodyStart = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('函数体未闭合: ' + name);
  return src.slice(at, end);
}

// ---- 回放数据：真实形状（BV1aeUWYUEiT「考研数学大观全系列」合集的裁剪版，18 集 4 小节 → 7 集 3 小节）----
const CURRENT = { bvid: 'BV1aeUWYUEiT', aid: 113503436478466, cid: 26822053135, title: '线性代数大观（上篇)', duration: 12301 };
const SEASON_SECTIONS = [
  { title: '高等数学公共部分', episodes: [
    { bvid: 'BV1gmReBDEUz', aid: 116515936475335, cid: 38083824531, title: '积分计算大观', duration: 15940 },
    { bvid: 'BV1yHE56FEaf', aid: 116717833491840, cid: 38973344958, title: '积分应用大观', duration: 465 },
  ]},
  { title: '线性代数', episodes: [
    CURRENT,
    { bvid: 'BV1shzdYqEXq', aid: 113576702383881, cid: 27120502085, title: '线性代数大观（下篇)', duration: 25021 },
  ]},
  { title: '概率统计', episodes: [
    { bvid: 'BV1LDqJB6ELz', aid: 115737742023659, cid: 34808074194, title: '概率论', duration: 7671 },
  ]},
];
const seasonOf = sections => ({ title: '考研数学大观全系列', sections: sections.map(sec => ({
  title: sec.title,
  episodes: sec.episodes.map(ep => ({
    bvid: ep.bvid, aid: ep.aid, cid: ep.cid, title: ep.title,
    page: { cid: ep.cid, page: 1, duration: ep.duration, part: ep.title },
  })),
})) });
const viewOf = ({ pages, season }) => ({ code: 0, data: {
  aid: CURRENT.aid,
  title: 'CXY-003素人教師の线性代数大观（上篇)',
  pages,
  ...(season ? { ugc_season: season } : {}),
} });
const SINGLE_PAGE = [{ page: 1, cid: CURRENT.cid, part: 'EREN122B素人教師エレンの线性代数大観（上篇）', duration: 12301 }];

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(JSON.stringify(detail)).slice(0, 300) : ''}`); }
}

(async () => {
  // ===== 一、数据层 fetchVideoPages：合集 episodes → 伪分P =====
  console.log('--- fetchVideoPages：合集展开 ---');
  let viewRequests = 0;
  const store = new Map();
  const fetchVideoPages = new Function('PAGES_CACHE_PREFIX', 'readCache', 'writeCache', 'requestJson',
    extractFunction('fetchVideoPages') + '\nreturn fetchVideoPages;')(
    'video-pages-v2:',
    (prefix, key) => store.get(prefix + key),
    (prefix, key, value) => store.set(prefix + key, value),
    async () => { viewRequests++; return viewOf({ pages: SINGLE_PAGE, season: seasonOf(SEASON_SECTIONS) }); },
  );

  const info = await fetchVideoPages(CURRENT.bvid);
  check('isSeason=true，集数=合集全集数（5）', info.isSeason === true && info.pages.length === 5, { len: info.pages.length });
  check('seasonTitle 透传', info.seasonTitle === '考研数学大观全系列');
  check('序号跨小节连续（P1..P5）', info.pages.every((p, i) => p.page === i + 1), info.pages.map(p => p.page));
  const p1 = info.pages[0], p3 = info.pages[2];
  check('每集带自己的 bvid/aid/cid', p1.bvid === 'BV1gmReBDEUz' && p1.aid === 116515936475335 && p1.cid === 38083824531, p1);
  check('标题取合集短标题（episode.title）', p1.part === '积分计算大观' && p3.part === '线性代数大观（上篇)', { p1: p1.part, p3: p3.part });
  check('时长取 episode.page.duration', p1.duration === 15940 && p3.duration === 12301);
  check('小节名带出（section）', p1.section === '高等数学公共部分' && p3.section === '线性代数');
  await fetchVideoPages(CURRENT.bvid);
  check('第二次调用命中缓存（view 仅请求 1 次）', viewRequests === 1, viewRequests);

  console.log('--- fetchVideoPages：非合集不回归 ---');
  const fetchVideoPages2 = new Function('PAGES_CACHE_PREFIX', 'readCache', 'writeCache', 'requestJson',
    extractFunction('fetchVideoPages') + '\nreturn fetchVideoPages;')(
    'video-pages-v2:', () => undefined, () => {},
    async () => viewOf({ pages: SINGLE_PAGE, season: undefined }),
  );
  const single = await fetchVideoPages2(CURRENT.bvid);
  check('单P无合集：isSeason=false、pages=1、无 bvid 字段',
    single.isSeason === false && single.pages.length === 1 && !('bvid' in single.pages[0]), single.pages[0]);

  const multiPages = [
    { page: 1, cid: 111, part: 'P1', duration: 60 },
    { page: 2, cid: 222, part: 'P2', duration: 61 },
  ];
  const fetchVideoPages3 = new Function('PAGES_CACHE_PREFIX', 'readCache', 'writeCache', 'requestJson',
    extractFunction('fetchVideoPages') + '\nreturn fetchVideoPages;')(
    'video-pages-v2:', () => undefined, () => {},
    async () => viewOf({ pages: multiPages, season: seasonOf(SEASON_SECTIONS) }),
  );
  const multi = await fetchVideoPages3(CURRENT.bvid);
  check('多分P+合集并存：优先分P（维持 v2.3 行为）',
    multi.isSeason === false && multi.pages.length === 2 && multi.pages[0].part === 'P1', multi.pages);

  // ===== 二、挂载条件 mountEpisodeButton：DOM 桩探针 =====
  console.log('--- mountEpisodeButton：挂载门槛 ---');
  const mountEpisodeButton = new Function('site', 'location', 'unsafeWindowOrWindow', 'document', 'EPISODE_BUTTON_ID',
    extractFunction('mountEpisodeButton') + '\nreturn mountEpisodeButton;');
  const runMount = ({ pages, season, pathname = '/video/BV1aeUWYUEiT/' }) => {
    const probed = [];
    const doc = {
      getElementById: () => null,
      querySelector: sel => { probed.push(sel); return null; }, // 通过页数门槛才会来查 header-top
      createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {} }),
    };
    mountEpisodeButton('bilibili', { pathname },
      () => ({ __INITIAL_STATE__: { videoData: { pages, ...(season ? { ugc_season: season } : {}) } } }),
      doc, 'test-episode-button')();
    return probed.includes('.video-pod .header-top');
  };
  check('合集页（pages=1 + season 5 集）：通过门槛（去挂 header-top）',
    runMount({ pages: SINGLE_PAGE, season: seasonOf(SEASON_SECTIONS) }) === true);
  check('单P无合集：不挂（门槛拦下）', runMount({ pages: SINGLE_PAGE, season: undefined }) === false);
  check('多分P无合集：照常挂（不回归）',
    runMount({ pages: multiPages, season: undefined }) === true);
  check('合集仅 1 集：不挂', runMount({ pages: SINGLE_PAGE, season: seasonOf([{ title: '单集小节', episodes: [CURRENT] }]) }) === false);
  check('非 /video/ 路径：不挂（site/pathname 门槛）',
    runMount({ pages: SINGLE_PAGE, season: seasonOf(SEASON_SECTIONS), pathname: '/bangumi/play/ep1' }) === false);

  // ===== 三、执行器 runCrossEpisodeCopy：每集用自己的 bvid =====
  console.log('--- runCrossEpisodeCopy：逐集 bvid 隔离 ---');
  const metaCalls = [];
  const clip = { text: null };
  const runCrossEpisodeCopy = new Function(
    'episodeCopyCancelled', 'fetchEpisodeSubtitleMeta', 'chooseSubtitle', 'normalizeSubtitle',
    'loadSubtitleLines', 'transcribeEpisodeViaAsr', 'writeClipboard', 'showToast', 'document', 'window', 'console',
    extractFunction('runCrossEpisodeCopy') + '\nreturn runCrossEpisodeCopy;');
  const makeRun = () => runCrossEpisodeCopy(
    false,
    async video => { metaCalls.push({ bvid: video.bvid, aid: video.aid, cid: video.cid }); // 记录每集请求
      // 概率论（P5）无字幕；其余有
      if (video.bvid === 'BV1LDqJB6ELz') return [];
      return [{ lan: 'zh-CN', subtitle_url: `https://x/sub-${video.bvid}.json` }]; },
    subs => subs[0] || null,
    lines => lines.join('\n'),
    async video => ({ lines: [`${video.bvid} 的字幕行一。`, `${video.bvid} 的字幕行二。`] }),
    async () => '', // ASR 兜底：返回空（视为无 Key 跳过）
    async text => { clip.text = text; },
    () => {},
    { cookie: 'DedeUserID=1' },
    { setTimeout: fn => Promise.resolve().then(fn) },
    { warn: () => {} },
  );
  const pages = info.pages; // P1 积分计算 / P2 积分应用 / P3 线代上 / P4 线代下 / P5 概率论(无字幕)
  const combined = await makeRun()(CURRENT.bvid, CURRENT.aid, pages, 'auto', { progress: () => {}, note: () => {} });
  check('5 集全部发了字幕请求，bvid/cid 一一对应', metaCalls.length === 5
    && metaCalls[0].bvid === 'BV1gmReBDEUz' && metaCalls[0].cid === 38083824531
    && metaCalls[2].bvid === 'BV1aeUWYUEiT' && metaCalls[2].cid === 26822053135
    && metaCalls[4].bvid === 'BV1LDqJB6ELz', metaCalls);
  check('aid 也随集切换（不为全局当前页 aid）', metaCalls[0].aid === 116515936475335 && metaCalls[2].aid === CURRENT.aid, metaCalls.map(c => c.aid));
  check('输出按 【Pn】【标题】 分段且内容来自各自 bvid',
    combined.includes('【P1】积分计算大观') && combined.includes('BV1gmReBDEUz 的字幕行一。')
    && combined.includes('【P3】线性代数大观（上篇)') && combined.includes('BV1aeUWYUEiT 的字幕行一。'), combined && combined.slice(0, 120));
  check('无字幕集不出现在正文（跳过）', !combined.includes('概率论') && !combined.includes('BV1LDqJB6ELz 的字幕行'), null);
  check('剪贴板写入与返回值一致', clip.text === combined && !!combined);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
