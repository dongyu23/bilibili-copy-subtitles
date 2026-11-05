// 字幕行紧凑序列化 + 缓存淘汰的单测
// 运行：node subtitle-cache.test.js
const fs = require('fs');

const SCRIPT = process.env.BCS_SCRIPT
  || '/Users/jinzihan/.zcode/workspace/draft-cd30c590-2277-4c95-9cc1-48e10c14d4e3/bilibili-copy-subtitles/bilibili-copy-subtitles.user.js';
const src = fs.readFileSync(SCRIPT, 'utf8');

// 抽出 const 箭头函数（escapeSubtitleText 等）与 function 声明
function extractConst(name) {
  const at = src.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('未找到: ' + name);
  let i = src.indexOf('=>', at), depth = 0, end = -1;
  // 从 => 后的函数体开始配平
  const bodyStart = src.indexOf('{', i);
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(at, end).replace(/^const /, 'var ');
}
function extractFn(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('未找到: ' + name);
  const start = src.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const paren = src.indexOf(')', at);
  let i = src.indexOf('{', paren), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

eval([
  extractConst('escapeSubtitleText'),
  extractConst('unescapeSubtitleText'),
  extractFn('encodeSubtitleLines'),
  extractFn('decodeSubtitleLines'),
  extractFn('normalizeSubtitleLines'),
].join('\n'));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  \u2705 ' : '  \u274c ') + name
    + (ok ? '' : `\n       got : ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

console.log('--- 紧凑序列化往返 ---');

const L = [
  { from: 0, to: 3.5, content: '你好' },
  { from: 3.5, to: 9.2, content: '带\\N换行' },
  { from: 9.2, to: 14, content: '含|竖线\t和制表符' },
  { from: 0, to: 0, content: '' },
];
t('往返一致（含 \\N / 竖线 / 制表符 / 空内容）', decodeSubtitleLines(encodeSubtitleLines(L)), L);
t('空数组往返', decodeSubtitleLines(encodeSubtitleLines([])), []);
t('反斜杠原样保留', decodeSubtitleLines(encodeSubtitleLines(
  [{ from: 1, to: 2, content: 'C:\\path\\x' }]))[0].content, 'C:\\path\\x');
t('真换行原样保留', decodeSubtitleLines(encodeSubtitleLines(
  [{ from: 1, to: 2, content: 'a\nb' }]))[0].content, 'a\nb');
t('真制表符原样保留', decodeSubtitleLines(encodeSubtitleLines(
  [{ from: 1, to: 2, content: 'a\tb' }]))[0].content, 'a\tb');
t('混合转义符', decodeSubtitleLines(encodeSubtitleLines(
  [{ from: 1, to: 2, content: '\\n\\t\\\\ 全都有' }]))[0].content, '\\n\\t\\\\ 全都有');
t('中文与 emoji', decodeSubtitleLines(encodeSubtitleLines(
  [{ from: 1, to: 2, content: '中文 🎬 test' }]))[0].content, '中文 🎬 test');

console.log('\n--- 体积 ---');
// 用贴近真实 B 站字幕的行长（短句，平均十余字）
const samples = ['大家好', '我们来复习这一个知识点', '首先看它的定时方式', '同步和异步', '这个是比较重要的', '考试当中经常会出现'];
const big = [];
for (let i = 0; i < 2356; i++) {
  big.push({ from: i * 3.1, to: (i + 1) * 3.1, content: samples[i % samples.length] });
}
const enc = encodeSubtitleLines(big);
// 落盘体积：紧凑字符串还要套 {value,cachedAt} 的 JSON wrapper，
// 其中的 \t 与 \n 会被 JSON 转义成两字符序列，这部分膨胀要算进去。
const storedCompact = JSON.stringify({ value: enc, cachedAt: '2026-11-05T00:00:00.000Z' }).length;
const storedJson = JSON.stringify({ value: big, cachedAt: '2026-11-05T00:00:00.000Z' }).length;
t('落盘体积小于 JSON', storedCompact < storedJson, true);
t('落盘压缩比 < 0.6', +(storedCompact / storedJson).toFixed(2) < 0.6, true);
console.log(`     （2356 条短句：JSON ${Math.round(storedJson / 1024)}KB → 紧凑 ${Math.round(storedCompact / 1024)}KB，比值 ${(storedCompact / storedJson).toFixed(2)}）`);

console.log('\n--- 脏数据容错 ---');
t('非字符串', decodeSubtitleLines(null), []);
t('空字符串', decodeSubtitleLines(''), []);
t('无分隔符的行被跳过', decodeSubtitleLines('没有分隔符'), []);
t('只有一个分隔符被跳过', decodeSubtitleLines('1\t只有两个字段'), []);
t('时间非数字归零', decodeSubtitleLines('abc\tdef\tghi')[0].from, 0);
t('空 content 保留为空串', decodeSubtitleLines('1\t2\t')[0].content, '');

console.log('\n--- normalizeSubtitleLines（兼容旧 JSON 数组） ---');
t('数组直通（旧格式）', normalizeSubtitleLines(L), L);
t('字符串走紧凑解码', normalizeSubtitleLines(encodeSubtitleLines(L)), L);
t('null 返回空数组', normalizeSubtitleLines(null), []);
t('undefined 返回空数组', normalizeSubtitleLines(undefined), []);
t('数字返回空数组', normalizeSubtitleLines(123), []);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
