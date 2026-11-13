// 字幕检索（Ctrl+F）功能的单测
// 运行：node subtitle-find.test.js
const fs = require('fs');
const path = require('path');

const SCRIPT = process.env.BCS_SCRIPT
  || path.join(__dirname, 'bilibili-copy-subtitles.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// 从声明开头取（保留 async 前缀），并跳过参数列表里可能出现的 {} 默认值
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

const buildSubtitleMatches = eval('(' + extract('buildSubtitleMatches') + ')');

let pass = 0, fail = 0;

// 花括号配平提取 function 声明（先跳过参数列表，避免解构参数干扰）
function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let at = -1;
  for (const marker of markers) {
    at = src.indexOf(marker);
    if (at >= 0) break;
  }
  if (at < 0) throw new Error('未找到函数: ' + name);
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

function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  \u2705 ' : '  \u274c ') + name
    + (ok ? '' : `\n       got : ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const shape = ms => ms.map(m => ({ i: m.index, from: m.from, to: m.to, at: m.matchStart, len: m.matchLength }));

console.log('--- buildSubtitleMatches ---');

const L = [
  { from: 0,    to: 3.5,  content: '哈喽大家好，我是 BOK。' },
  { from: 3.5,  to: 9.2,  content: '本节课我们来复习数据的表示与运算' },
  { from: 9.2,  to: 14.0, content: '数据的表示与运算这个模块难度最高' },
];

t('单行单命中', shape(buildSubtitleMatches(L, 'BOK')),
  [{ i: 0, from: 0, to: 3.5, at: 9, len: 3 }]);
t('跨行命中按行序排列', shape(buildSubtitleMatches(L, '数据的表示与运算')).map(x => x.i), [1, 2]);
t('时间戳取该行的 from', buildSubtitleMatches(L, '数据的表示与运算').map(m => m.from), [3.5, 9.2]);
t('行内多次出现算多个命中', buildSubtitleMatches(L, '运算').length, 2);
t('行内多次出现的位置各自正确',
  shape(buildSubtitleMatches(L, '运算')).map(x => x.at), [14, 6]);
t('大小写不敏感（中文不受影响）', buildSubtitleMatches(L, 'bok').length, 1);
t('大小写不敏感（英文）',
  shape(buildSubtitleMatches([{ from: 1, to: 2, content: 'Hello World hello' }], 'HELLO')).map(x => x.at),
  [0, 12]);
t('无命中返回空数组', buildSubtitleMatches(L, '不存在的词'), []);
t('空 query 返回空数组', buildSubtitleMatches(L, ''), []);
t('纯空格 query 返回空数组', buildSubtitleMatches(L, '   '), []);
t('null query 返回空数组', buildSubtitleMatches(L, null), []);
t('undefined query 返回空数组', buildSubtitleMatches(L, undefined), []);
t('lines 非数组返回空数组', buildSubtitleMatches(null, 'x'), []);
t('空 lines 返回空数组', buildSubtitleMatches([], 'x'), []);
t('跳过 null 行不抛异常', buildSubtitleMatches([null, { from: 1, to: 2, content: 'abc' }], 'abc').length, 1);
t('跳过非对象行不抛异常', buildSubtitleMatches(['abc', { from: 1, to: 2, content: 'abc' }], 'abc').length, 1);
t('content 为空的行被跳过', buildSubtitleMatches([{ from: 1, to: 2, content: '' }], 'a'), []);
t('content 缺失视为空', buildSubtitleMatches([{ from: 1, to: 2 }], 'a'), []);
t('content 含 \\N 也能匹配', buildSubtitleMatches(
  [{ from: 0, to: 1, content: '第一行\\N第二行关键字' }], '关键字').length, 1);
t('from/to 为 0 时保留 0 而不是 NaN', (() => {
  const m = buildSubtitleMatches([{ from: 0, to: 0, content: 'x' }], 'x')[0];
  return [m.from, m.to];
})(), [0, 0]);
t('from/to 非数字时归零', (() => {
  const m = buildSubtitleMatches([{ from: 'abc', to: null, content: 'x' }], 'x')[0];
  return [m.from, m.to];
})(), [0, 0]);
t('命中保留原始 content 未转义', buildSubtitleMatches(
  [{ from: 0, to: 1, content: 'a<b>&c' }], '<b>')[0].content, 'a<b>&c');
// 重叠出现取非重叠：与浏览器 find-in-page、编辑器查找的行为一致。
// 字幕检索场景下用户关心"这句话在哪"，非重叠计数不会让人漏跳，也不会重复计数。
t('重叠出现按非重叠计（aaa 搜 aa）', buildSubtitleMatches(
  [{ from: 0, to: 1, content: 'aaa' }], 'aa').length, 1);
t('非重叠连续出现不漏（abab 搜 ab）', buildSubtitleMatches(
  [{ from: 0, to: 1, content: 'abab' }], 'ab').length, 2);
t('单字符 query', buildSubtitleMatches(L, '。').length, 1);
t('匹配结果带 index 字段指向原行', buildSubtitleMatches(L, '模块')[0].index, 2);
t('长 query 跨整行', buildSubtitleMatches(
  [{ from: 0, to: 1, content: 'abcdefgh' }], 'abcdefgh').length, 1);

// 与 normalizeSubtitle 的分工：检索用原始 body，不走拼接字符串
console.log('\n--- 与既有链路的衔接 ---');
t('fetchSubtitleBodyFresh 返回的 body 可直接喂给 buildSubtitleMatches', (() => {
  const body = [{ from: 12.5, to: 16.0, content: '测试句子' }];
  return buildSubtitleMatches(body, '测试')[0].from;
})(), 12.5);

// buildPseudoSubtitleLines：ASR 纯文本 → 伪时间行（v2.9.0 检索面板回填已识别结果用）
console.log('\n--- buildPseudoSubtitleLines（ASR 回填分句） ---');
const buildPseudoSubtitleLines = new Function(extractFunction('buildPseudoSubtitleLines') + '\nreturn buildPseudoSubtitleLines;')();
t('按句末标点与换行切句', buildPseudoSubtitleLines('第一句。第二句！第三句？\n第四句', 100).map(x => x.content).join('|'),
  '第一句。|第二句！|第三句？|第四句');
t('伪时间均摊到每句', buildPseudoSubtitleLines('a。b。c。', 90).map(x => Math.round(x.from)).join(','),
  '0,30,60');
t('空文本/纯空白返回空数组', buildPseudoSubtitleLines('   \n  ', 100).length, 0);
t('时长缺失按 1 秒兜底不抛错', buildPseudoSubtitleLines('x。', 0).length, 1);
t('每句 to 与下一句 from 衔接', (() => {
  const rows = buildPseudoSubtitleLines('a。b。', 60);
  return Math.abs(rows[0].to - rows[1].from) < 1e-9;
})(), true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
