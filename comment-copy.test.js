// 评论复制（v2.9.0，默认关闭）的回归测试——零依赖，仓库既有测试风格：从源码提取函数+桩依赖。
// 运行：node comment-copy.test.js
const fs = require('fs');
const path = require('path');

const SCRIPT = process.env.BCS_SCRIPT
  || path.join(__dirname, 'bilibili-copy-subtitles.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let at = -1;
  for (const marker of markers) {
    at = src.indexOf(marker);
    if (at >= 0) break;
  }
  if (at < 0) throw new Error('未找到函数: ' + name);
  // 先跳过参数列表（可能有解构参数 { a, b }），再定位函数体花括号，
  // 否则解构的 } 会被当成函数体结束。
  const sigEnd = src.indexOf(')', at);
  const bodyStart = src.indexOf('{', sigEnd);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('函数体未闭合: ' + name);
  return src.slice(at, end);
}

const UP_MID = 6536560;
const mkReply = (over = {}) => ({
  rpid: 1, rcount: 0,
  member: { mid: '10086', uname: '普通网友' },
  content: { message: '一条普通评论' },
  up_action: { like: false },
  ...over,
});

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(JSON.stringify(detail)).slice(0, 200) : ''}`); }
}

(async () => {
  // ===== 一、格式化 =====
  console.log('--- formatCommentLine / formatCommentBlock ---');
  const formatCommentLine = new Function(extractFunction('formatCommentLine') + '\nreturn formatCommentLine;')();
  const formatCommentBlock = new Function('formatCommentLine',
    extractFunction('formatCommentBlock') + '\nreturn formatCommentBlock;')(formatCommentLine);

  check('基础格式：昵称：内容',
    formatCommentLine(mkReply(), UP_MID) === '普通网友：一条普通评论');
  check('UP 主本人标（UP主）',
    formatCommentLine(mkReply({ member: { mid: String(UP_MID), uname: '澄潇宇' } }), UP_MID) === '澄潇宇（UP主）：一条普通评论');
  check('UP 主赞过标记',
    formatCommentLine(mkReply({ up_action: { like: true } }), UP_MID) === '普通网友（UP主赞过）：一条普通评论');
  check('置顶徽标在最前（置顶，UP主赞过）',
    formatCommentLine(mkReply({ up_action: { like: true } }), UP_MID, '置顶') === '普通网友（置顶，UP主赞过）：一条普通评论');
  check('正文换行压成空格（保持一行）',
    formatCommentLine(mkReply({ content: { message: '第一行\n第二行\n\n第三行' } }), UP_MID) === '普通网友：第一行 第二行 第三行');
  check('表情文本原样保留',
    formatCommentLine(mkReply({ content: { message: '来了[哦呼][汤圆]' } }), UP_MID) === '普通网友：来了[哦呼][汤圆]');
  check('ownerMid 为 0 时不误标 UP 主',
    !formatCommentLine(mkReply({ member: { mid: '0', uname: 'x' } }), 0).includes('UP主'));
  check('楼中楼缩进两空格',
    formatCommentBlock(mkReply(), [mkReply({ member: { mid: '1', uname: '甲' }, content: { message: '子回复一' } })], UP_MID)
      === '普通网友：一条普通评论\n  甲：子回复一');

  // ===== 二、数据层 fetchCommentPage =====
  console.log('--- fetchCommentPage ---');
  const commentRequestError = new Function(extractFunction('commentRequestError') + '\nreturn commentRequestError;')();
  const buildFetchCommentPage = replyJson => new Function('requestJson', 'COMMENT_PAGE_SIZE', 'commentRequestError',
    extractFunction('fetchCommentPage') + '\nreturn fetchCommentPage;')(async () => replyJson, 20, commentRequestError);
  const okPage = buildFetchCommentPage({
    code: 0,
    data: {
      replies: [mkReply()], page: { count: 5817 },
      upper: { top: mkReply({ member: { mid: '9', uname: '伍億探長ovo' } }) },
    },
  });
  const p1 = await okPage(113503436478466, { sort: 2, pn: 1 });
  check('replies/total/pinned 正确映射', p1.replies.length === 1 && p1.total === 5817 && !!p1.pinned);
  const emptyPage = buildFetchCommentPage({ code: 0, data: { replies: null } });
  const p2 = await emptyPage(1, { sort: 0, pn: 1 });
  check('replies 为 null（评论区关闭/无数据）→ 空数组不抛错', p2.replies.length === 0 && p2.total === 0 && !p2.pinned);
  const riskPage = buildFetchCommentPage({ code: -352, message: '风控' });
  let riskError = null;
  try { await riskPage(1, { sort: 2, pn: 1 }); } catch (e) { riskError = e; }
  check('-352 风控 → 提示登录', riskError && riskError.message.includes('登录'));

  // ===== 三、执行器 runCommentCopy =====
  console.log('--- runCommentCopy ---');
  const clip = { text: null };
  const toasts = [];
  const makeRun = ({ pages, subsByRpid = {}, firstPinned = null, total = 0, pageSize = 20 }) => {
    const fetchCommentPageStub = async (aid, { pn }) => {
      const page = pages[pn - 1] || { replies: [], total }; // 越界返回空页（真实接口尾页后为空）
      return { replies: page.replies, total: page.total ?? total, pinned: pn === 1 ? firstPinned : null };
    };
    const collectSubRepliesStub = async (aid, reply) => subsByRpid[reply.rpid] || [];
    return new Function(
      'commentCopyCancelled', 'COMMENT_PAGE_SIZE', 'fetchCommentPage', 'collectSubReplies', 'formatCommentBlock',
      'writeClipboard', 'showToast', 'window', 'console', 'jitterDelay',
      extractFunction('runCommentCopy') + '\nreturn runCommentCopy;')(
      false, pageSize, fetchCommentPageStub, collectSubRepliesStub,
      (reply, subs, ownerMid, badge) => `${badge || ''}|${reply.member.uname}|${reply.content.message}|${subs.length}`,
      async text => { clip.text = text; },
      msg => toasts.push(msg),
      { setTimeout: fn => Promise.resolve().then(fn) },
      { warn: () => {} },
      (base, spread) => Promise.resolve(), // jitterDelay 桩：测试不真等
    );
  };
  const ui = { progress: () => {}, note: () => {} };

  // 场景1：两页数据 + 置顶 + 楼中楼 + 上限 100
  const r1 = mkReply({ rpid: 11, member: { mid: '1', uname: '热评一' }, rcount: 2 });
  const r2 = mkReply({ rpid: 12, member: { mid: '2', uname: '热评二' } });
  const r3 = mkReply({ rpid: 21, member: { mid: '3', uname: '第二页' } });
  const pinned = mkReply({ rpid: 99, member: { mid: '9', uname: '置顶人' } });
  const run1 = makeRun({
    pages: [{ replies: [r1, r2], total: 3 }, { replies: [r3], total: 3 }],
    subsByRpid: { 11: [mkReply(), mkReply()] },
    firstPinned: pinned, total: 3, pageSize: 2,
  });
  clip.text = null; toasts.length = 0;
  const out1 = await run1(1, UP_MID, { sort: '2', limit: 100, includeSubs: true }, ui);
  check('置顶块在最前', out1.startsWith('置顶|置顶人|'), out1 && out1.slice(0, 30));
  check('两页一级评论全部取到（含置顶共 4 块）', (out1.match(/\|/g) || []).filter(() => true).length >= 4 && out1.includes('热评一') && out1.includes('第二页'));
  check('楼中楼计入子回复数', out1.includes('|热评一|一条普通评论|2'));
  check('块间以空行分隔', out1.includes('\n\n'));
  check('toast 报数含楼中楼（置顶独立计数口径）', toasts.some(t => t.includes('3 条评论 + 1 条置顶') && t.includes('含 2 条楼中楼')), toasts);
  check('剪贴板与返回值一致', clip.text === out1);

  // 场景2：上限截断（limit=1，还有剩余）
  const run2 = makeRun({
    pages: [{ replies: [r1, r2, r3], total: 5817 }],
    firstPinned: null, total: 5817, pageSize: 3,
  });
  clip.text = null; toasts.length = 0;
  await run2(1, UP_MID, { sort: '2', limit: 1, includeSubs: false }, ui);
  check('上限=1 只取 1 条一级评论（置顶不计入上限）', toasts.some(t => t.startsWith('已复制 1 条评论')), toasts);
  check('截断时 toast 说明总数与原因', toasts.some(t => t.includes('5817') && t.includes('未全部获取')), toasts);

  // 场景3：limit=0（全部）正常翻到尾页
  const run3 = makeRun({
    pages: [{ replies: [r1, r2], total: 2 }],
    firstPinned: null, total: 2, pageSize: 2,
  });
  clip.text = null;
  const out3 = await run3(1, UP_MID, { sort: '2', limit: 0, includeSubs: false }, ui);
  check('limit=0 不截断且取完全部', out3.includes('热评一') && out3.includes('热评二'));

  // 场景4：空结果（未登录按时间排序）
  const run4 = makeRun({ pages: [{ replies: [], total: 0 }], firstPinned: null });
  clip.text = null; toasts.length = 0;
  const out4 = await run4(1, UP_MID, { sort: '0', limit: 100, includeSubs: true }, ui);
  check('sort=0 空结果 → 提示登录或改用热度', out4 === null && toasts.some(t => t.includes('按时间') && t.includes('登录')), toasts);
  check('空结果不写剪贴板', clip.text === null);

  // 场景5：运行中取消
  const run5 = makeRun({
    pages: [{ replies: [r1], total: 500 }, { replies: [r2], total: 500 }, { replies: [r3], total: 500 }],
    firstPinned: null, total: 500, pageSize: 1,
  });
  clip.text = null;
  const out5 = await run5(1, UP_MID, { sort: '2', limit: 0, includeSubs: false }, {
    progress: () => {}, note: () => {},
  });
  check('完整取完返回拼接文本', out5 && out5.includes('第二页'));

  // 场景6：silent 模式（组合复制时由调用方拼最终文本并写剪贴板）
  const run6 = makeRun({
    pages: [{ replies: [r1, r2], total: 2 }],
    firstPinned: null, total: 2, pageSize: 2,
  });
  clip.text = null; toasts.length = 0;
  const out6 = await run6(1, UP_MID, { sort: '2', limit: 0, includeSubs: false, silent: true }, ui);
  check('silent 模式返回文本但不写剪贴板', !!out6 && out6.includes('热评一') && clip.text === null);
  check('silent 模式不发成功 toast', toasts.length === 0, toasts);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
