// joinSubtitleLines 新旧实现等价性 + 性能基准；md5 标准向量
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'bilibili-copy-subtitles.user.js'), 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let at = -1;
  for (const m of markers) { at = src.indexOf(m); if (at >= 0) break; }
  if (at < 0) throw new Error('未找到: ' + name);
  const sigEnd = src.indexOf(')', at);
  const bodyStart = src.indexOf('{', sigEnd);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(at, end);
}

// 新实现（从源文件提取，连同它依赖的常量）
const NEW = new Function(
  'SUBTITLE_END_PUNCT', 'SUBTITLE_START_PUNCT', 'isAsciiAlnum',
  extractFunction('joinSubtitleLines') + '\nreturn joinSubtitleLines;'
)(
  new Set(['。','，','、','；','：','！','？','…','—',',','.','!','?',';',':','”','’','」','』','）',')']),
  new Set(['。','，','、','；','：','！','？','…','—',',','.','!','?',';',':','“','‘','「','『','（','(']),
  ch => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
);

// 旧实现（原样复刻）
function OLD(lines) {
  let text = '';
  for (const line of lines) {
    if (!text) { text = line; continue; }
    const prevEndsPunct = /[。，、；：！？…—,.!?;:”’」』）)]$/.test(text);
    const lineStartsPunct = /^[。，、；：！？…—,.!?;:“‘「『（(]/.test(line);
    const lineStartsLatin = /^[A-Za-z0-9]/.test(line);
    const needsSpace = !lineStartsPunct && (lineStartsLatin || !prevEndsPunct);
    text += needsSpace ? ` ${line}` : line;
  }
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

let pass = 0, fail = 0;
const t = (name, ok, detail) => { ok ? pass++ : (fail++, console.log('  ❌', name, detail || '')); console.log(ok ? '  ✅ ' + name : ''); };

// 等价性：边界用例 + 随机
const cases = [
  [], ['单行'], ['带句号。', '下一句'], ['无标点', '再一条'], ['英文', 'Word next'], ['123', '456'],
  ['中文）', '括号后'], ['中文”', '引号后'], ['（开头'], ['“开头'], ['行内\n换行', '下一行'],
  ['end.', 'dot'], ['end!', 'bang'], ['…省略', '后'], ['—破折', '后'], ['tab\t内', '后'],
  ['a', 'b', 'c', 'd'], ['。', '。', '。'], ['x', '。', 'y'], ['中文', 'English', '中文', '，', 'tail'],
];
for (let i = 0; i < 300; i++) {
  const n = 1 + Math.floor(Math.random() * 12);
  const pool = ['中文词', 'word', '。', '，', '123', 'end.', '）', '（开', 'a b', 'x', '中文！', '…', '\n', '带空格 '];
  cases.push(Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]));
}
let allEq = true;
for (const c of cases) {
  if (NEW(c) !== OLD(c)) { allEq = false; console.log('  不一致:', JSON.stringify(c), '\n   new=', JSON.stringify(NEW(c)), '\n   old=', JSON.stringify(OLD(c))); break; }
}
t('等价性：' + cases.length + ' 组用例逐字节一致', allEq);

// 性能：模拟长视频字幕（中文无标点 AI 字幕是最坏情形）
function bench(fn, lines, label) {
  const t0 = process.hrtime.bigint();
  fn(lines);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    ${label}: ${ms.toFixed(1)}ms`);
  return ms;
}
for (const n of [5000, 10000, 20000, 32000]) {
  const lines = Array.from({ length: n }, (_, i) => `这是第${i}条没有标点的中文字幕内容`);
  const o = bench(OLD, lines, `旧 × ${n} 行`);
  const w = bench(NEW, lines, `新 × ${n} 行`);
  t(`新实现 ${n} 行输出一致且 ≥50 倍提速`, NEW(lines) === OLD(lines) && w * 20 < o, `${w.toFixed(1)}ms vs ${o.toFixed(1)}ms`);
}

// md5 标准向量（修正后应通过）
const md5Hex = new Function(extractFunction('md5Hex') + '\nreturn md5Hex;')();
t('md5("") = d41d8cd9…', md5Hex('') === 'd41d8cd98f00b204e9800998ecf8427e', md5Hex(''));
t('md5("abc") = 90015098…', md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72', md5Hex('abc'));
t('md5(55字节边界)', md5Hex('a'.repeat(55)) === 'ef1772b6dff9a122358552954ad0df65', md5Hex('a'.repeat(55)));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
