// SPDX-License-Identifier: Apache-2.0
//
// 台本标记解析：把带标记的台本变成 [{ title, spans }]。每个 span 是要用同一个声音、同一个语速说完的一段文字，
// 外加它后面的停顿。只做计算，不用模型。
//
// 这个文件头是语法的正本。和它是同一份契约的另一份实现，是 app 里自带的解析器：
// 两份实现都跑 tools/cases/markup.json 里的标准用例，结果不一致就是有一边错了，先定哪个对，再一起改。
// 语法的来源只有这份说明（Apache-2.0 这边自己写的）：下面三个正则（停顿、声音、空行）是照语法里的词素拼出来的（见「标记的正则」），
// 写它们时没有对照 app 的解析器，也没有复制上游 VoiceStudio 的代码（它们是 AGPL-3.0-only，这里是 Apache-2.0）。
// 两边的行为一致靠标准用例和随机台本的逐条比较钉着，不靠两边的写法相像。
//
// 语法：外层先于内层，顺序是 章节 > 声音 > 停顿 > 语速和拼读标签；内层的标记不会跨过外层的标记。
// 标记的关键字（pause、voice、slow、fast、emphasis、spell）不分大小写。
//
//   换行    CRLF、单独的 CR 都当作 LF；文本开头的 BOM（U+FEFF）去掉。LS（U+2028）、PS（U+2029）在找章节标题时也算换行。
//   空白    ECMAScript 的 WhiteSpace 加换行符，也就是 String.prototype.trim 去掉的那些字符。
//   章节    行首的 `# 标题`：行首可以有空格、制表符；一个 #；后面至少一个空格或制表符；标题从第一个非空白字符到行尾，去掉两头空白。
//           `##`、`#标题`、行中间的 # 都是正文。标题是纯文字，里面的标记不起作用。
//           第一个标题之前有正文，它就是一章，标题是 `Chapter 1`。没有 span 的章节丢掉。
//   声音    `[voice:名字]`：这以后的文字用这个声音，到下一个声音标记或这一章结束为止（不跨章）。
//           名字不能含方括号，去掉两头空白，保留大小写；名字是空的（`[voice:]`）就回到默认声音（options.defaultVoice，没给就是 null）。
//   停顿    `[pause]`（350 ms）、`[pause 数字]`、`[pause 数字s]`、`[pause 数字ms]`。数字是 ASCII 数字，可以带小数，点两边都要有数字；
//           没有单位按毫秒；四舍六入五取偶；限制在 0–10000 ms。括号里两头可以有空白，数字和单位之间也可以有。
//           停顿属于它前面的那段文字（pause_ms_after）。两个标记紧挨着（中间一个字符也没有）就相加，封顶；
//           中间隔着空白就不合并，后一个成为文字为空的 span（下游把它的停顿加到前一个 span 上，所以只是表示不同）。
//   语速和拼读
//           `[slow]`（0.85）、`[fast]`（1.15）、`[emphasis]`（0.92）、`[spell]`，各有结束标记 `[/slow]` 等；标签名紧贴方括号，不能有空白。
//           嵌套时语速取最里层的；结束标记关掉最近的同名标签，多余的结束标记忽略；
//           没关的标签管到这一段文字的末尾（声音标记、停顿标记会把它截断）。
//           `[spell]` 把里面的文字去掉全部空白，再按字素簇（用户看到的一个字符）拆开，用空格连起来："USA" → "U S A"。
//           环境没有 Intl.Segmenter 时按码点拆：普通文字结果一样，组合符号、旗帜、零宽连接的表情会被拆开。
//           `[emphasis]` 只改语速；它还把括在里面的文字和括在外面的隔开，即使语速相同也不合并成一个 span。其他标签没有这个效果。
//           相邻、语速和拼读状态相同的片段合并；只有空白的片段不出 span，但仍然隔开它两边的片段。
//
// 输出  [{ title, spans: [{ voice_id, text, pause_ms_after, speed, join? }] }]
//   voice_id  声音名；没有声音标记、也没给默认声音就是 null
//   text      去掉两头空白的文字；只有停顿的 span 是空串
//   speed     标签给的语速；没有就取 options.defaultSpeed，再没有就是 null；文字为空的 span 是 null
//   join      只出现在「一段文字被行内标签切成几个 span」的、不是最后一个的 span 上：
//             `continue` 下一个 span 接着说；`paragraph` 两个 span 之间隔着空行（一个换行、若干空格或制表符、再一个换行）
// 台本是空串、null、undefined 或者没有任何内容，结果是 []。台本不是字符串（也不是空值）抛 TypeError。
//
// 和读音词表的关系：词表只替换标记以外的文字。标记里的词（pause、voice、声音名、slow 等标签名）是语法，不是要念的话：词表先于解析器跑的话，
// 把 pause 改成 break，`[pause 1s]` 就不再是停顿。做法是 lib/pronunciation-lexicon.mjs 的 applyLexicon（用本文件导出的 MARKER_PATTERN 把标记隔开）。
// agent 配音和 app 走的是同一个函数：app 里用户自己的词典和声音自带的词表，都由 app 交给它。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

// 停顿的默认时长和上限（语法「停顿」：`[pause]` 是 350 ms，限制在 0–10000 ms）：数值是语法里写明的事实
const PAUSE_DEFAULT_MS = 350;
// 停顿的上限，和下面的 pauseMs 一起导出给舞台提示用（lib/line-hints.mjs 的「停顿的时长」）：（停顿 3 秒）的单位、取整和上限就是 [pause 3s] 的，只在这里写一处
export const PAUSE_MAX_MS = 10000;
// 导出给按台词配音的流程用（lib/dub.mjs）：舞台提示里的「放慢」「加快」和 [slow]、[fast] 用同一份数
export const SPEED = Object.freeze({ slow: 0.85, fast: 1.15, emphasis: 0.92 });
// 成对的标签：三个给语速的，加 [spell]。名字只在这里列一次，标签的正则和状态表都从它来
const TAG_NAMES = [...Object.keys(SPEED), 'spell'];

// ---------------------------------------------------------------- 标记的正则
// 三个标记的正则（停顿、声音、空行）都是照上面语法里写的话写出来的，关键字不分大小写（语法开头一句），所以带 i。

// 语法「停顿」列出的写法有两种：不带数字的 `[pause]`，和带数字的 `[pause 数字]`、`[pause 数字s]`、`[pause 数字ms]`。
// 所以是两个分支：括号里两头可以有空白；数字是 ASCII 数字，可以带小数，点的两边都要有数字，和 pause 之间至少一个空白；
// 单位（ms 或 s）可有可无，和数字之间可以有空白。第二个分支的捕获组 1 是数字，2 是单位（没写就没有）。
const PAUSE_RE = new RegExp(['\\[\\s*pause\\s*\\]', '\\[\\s*pause\\s+(\\d+(?:\\.\\d+)?)(?:\\s*(ms|s))?\\s*\\]'].join('|'), 'gi');
// 语法「声音」：关键字 voice 和冒号紧挨着，冒号后面到右方括号之间是名字：除了方括号什么字符都行，可以是空。捕获组 1 是名字，两头的空白由用它的人去掉
const VOICE_RE = new RegExp('\\[voice:([^\\]\\[]*)\\]', 'gi');
// 语法「语速和拼读」：成对的标签，标签名紧贴方括号，结束标记在标签名前多一个斜杠。捕获组 1 是斜杠（有就是结束标记），2 是标签名
const TAG_RE = new RegExp(`\\[(/?)(${TAG_NAMES.join('|')})\\]`, 'gi');
// 所有标记合成一个正则的源码，给必须绕开标记的代码用（读音词表：lib/pronunciation-lexicon.mjs 的 applyLexicon，配音和 app 都走它）；用 new RegExp(MARKER_PATTERN, 'gi') 建正则。
// 三个正则在这个文件里只有一份，标记的写法改了，这里跟着变。app 自带的解析器不导出这样的正则：app 里替换读音词表也走上面那个函数。
export const MARKER_PATTERN = [PAUSE_RE.source, VOICE_RE.source, TAG_RE.source].join('|');
// 语法「语速和拼读」的 join：两个 span 之间隔着空行，也就是一个换行，接若干空格或制表符，再一个换行
const BLANK_LINE_RE = new RegExp('\\n[\\t ]*\\n');

function normalize(text) {
  const lf = text.replace(/\r\n?/g, '\n');
  return lf.charCodeAt(0) === 0xfeff ? lf.slice(1) : lf;
}

// ---------------------------------------------------------------- 章节

const isLineBreak = (code) => code === 0x0a || code === 0x2028 || code === 0x2029;
const isBlank = (ch) => ch.trim() === '';

// 标题行：行首可有空格和制表符，接一个 #，再接至少一个空格或制表符，然后是以非空白字符开头的标题
function headingTitle(text, from, to) {
  let i = from;
  while (i < to && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] !== '#') return null;
  i++;
  const afterHash = i;
  while (i < to && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i === afterHash || i >= to || isBlank(text[i])) return null;
  return text.slice(i, to).trim();
}

function findHeadings(text) {
  const found = [];
  const n = text.length;
  let lineStart = 0;
  while (lineStart <= n) {
    let lineEnd = lineStart;
    while (lineEnd < n && !isLineBreak(text.charCodeAt(lineEnd))) lineEnd++;
    const title = headingTitle(text, lineStart, lineEnd);
    if (title !== null) found.push({ start: lineStart, end: lineEnd, title });
    if (lineEnd >= n) break;
    lineStart = lineEnd + 1;
  }
  return found;
}

function splitChapters(text) {
  const headings = findHeadings(text);
  if (!headings.length) return [{ title: null, body: text }];
  const parts = [];
  const intro = text.slice(0, headings[0].start);
  if (intro.trim()) parts.push({ title: null, body: intro });
  headings.forEach((h, i) => {
    parts.push({ title: h.title, body: text.slice(h.end, i + 1 < headings.length ? headings[i + 1].start : text.length) });
  });
  return parts;
}

// ---------------------------------------------------------------- 声音

// 按声音标记把一章的正文切成若干段：[{ voice, text }]
function splitAtVoices(body, defaultVoice) {
  const runs = [];
  let voice = defaultVoice;
  let last = 0;
  for (const m of body.matchAll(VOICE_RE)) {
    if (m.index > last) runs.push({ voice, text: body.slice(last, m.index) });
    voice = m[1].trim() || defaultVoice;
    last = m.index + m[0].length;
  }
  runs.push({ voice, text: body.slice(last) });
  return runs;
}

// ---------------------------------------------------------------- 停顿

// 四舍六入五取偶（IEEE 754 的默认舍入）
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 一个停顿的毫秒数：数字（字符串，ASCII 数字，可带小数）和单位（'s' 按秒，其余按毫秒），四舍六入五取偶，限制在 0–PAUSE_MAX_MS。
 * 没给数字就是默认的 350。导出给 lib/line-hints.mjs：舞台提示里写的时长用同一条规则。
 * @param {string|undefined} number
 * @param {string|undefined} unit
 */
export function pauseMs(number, unit) {
  if (number === undefined) return PAUSE_DEFAULT_MS;
  const value = Number.parseFloat(number) * (unit !== undefined && unit.toLowerCase() === 's' ? 1000 : 1);
  return Math.max(0, Math.min(roundHalfToEven(value), PAUSE_MAX_MS));
}

// 按停顿标记把一段文字切开：[{ text, pause }]，pause 是这段文字后面的停顿（毫秒）。
// 两个标记紧挨着（中间一个字符都没有）时，后一个并入前一个，相加后封顶；中间隔着空白就不并。
function splitAtPauses(text) {
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(PAUSE_RE)) {
    const before = text.slice(last, m.index);
    last = m.index + m[0].length;
    const pause = pauseMs(m[1], m[2]);
    if (before === '' && pieces.length) {
      const prev = pieces[pieces.length - 1];
      prev.pause = Math.min(prev.pause + pause, PAUSE_MAX_MS);
    } else pieces.push({ text: before, pause });
  }
  const tail = text.slice(last);
  if (tail !== '' || !pieces.length) pieces.push({ text: tail, pause: 0 });
  return pieces;
}

// ---------------------------------------------------------------- 语速和拼读

// 按标签把一段文字切成片段：[{ text, speed, spell, emphasis }]；状态相同的相邻片段合并。
// 每种标签一个栈，栈里是「它是整段文字里第几个打开的标签」：结束标记弹出同名的最近一个（语法里的「关掉最近的同名标签」），
// 当前语速取三种给语速的标签里栈顶最大的那个（最里层、也就是最后打开的），拼读和强调看栈空不空。
// 每一步都是 O(1)，所以嵌套很深的台本也不会变慢。
function splitAtTags(text) {
  const open = Object.fromEntries(TAG_NAMES.map((name) => [name, []]));
  let opened = 0;
  const state = () => {
    let speed = null;
    let innermost = -1;
    for (const name of Object.keys(SPEED)) {
      const top = open[name][open[name].length - 1];
      if (top > innermost) {
        innermost = top;
        speed = SPEED[name];
      }
    }
    return { speed, spell: open.spell.length > 0, emphasis: open.emphasis.length > 0 };
  };
  const segments = [];
  const add = (chunk) => {
    if (chunk === '') return;
    const props = state();
    const prev = segments[segments.length - 1];
    if (prev && prev.speed === props.speed && prev.spell === props.spell && prev.emphasis === props.emphasis) prev.text += chunk;
    else segments.push({ text: chunk, ...props });
  };
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    add(text.slice(last, m.index));
    last = m.index + m[0].length;
    const stack = open[m[2].toLowerCase()];
    if (m[1] === '/') stack.pop();
    else stack.push(opened++);
  }
  add(text.slice(last));
  return segments;
}

let graphemes;
// 去掉全部空白，按字素簇拆开，用空格连起来。用字素簇而不是码元或码点：
// 带组合符号的字母、码点在 BMP 之外的字、旗帜、用零宽连接符拼出来的表情，都是一个字符。
// 环境没有 Intl.Segmenter（Chrome 87、Firefox 125、Safari 14.1 之前）就退回按码点拆：普通文字结果一样，
// 组合符号、旗帜、零宽连接的表情会被拆开，但不会拆出半个字符。app 的解析器同样退回
function spellOut(text) {
  graphemes ??= typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  const letters = text.replace(/\s+/g, '');
  return (graphemes ? Array.from(graphemes.segment(letters), (part) => part.segment) : Array.from(letters)).join(' ');
}

// 一段（已经去掉两头空白的）文字，加上它后面的停顿，变成 span
function renderPiece(text, voice, pause, defaultSpeed) {
  const shown = [];
  let gap = ''; // 上一个出了 span 的片段的尾部空白，加上中间被跳过的纯空白片段
  for (const seg of splitAtTags(text)) {
    const spoken = (seg.spell ? spellOut(seg.text) : seg.text).trim();
    if (spoken === '') {
      gap += seg.text;
      continue;
    }
    const leading = seg.text.slice(0, seg.text.length - seg.text.trimStart().length);
    shown.push({ text: spoken, speed: seg.speed ?? defaultSpeed, paragraphBefore: BLANK_LINE_RE.test(gap + leading) });
    gap = seg.text.slice(seg.text.trimEnd().length);
  }
  if (!shown.length) return pause > 0 ? [{ voice_id: voice, text: '', pause_ms_after: pause, speed: null }] : [];
  return shown.map((s, i) => {
    const last = i === shown.length - 1;
    const span = { voice_id: voice, text: s.text, pause_ms_after: last ? pause : 0, speed: s.speed };
    if (!last) span.join = shown[i + 1].paragraphBefore ? 'paragraph' : 'continue';
    return span;
  });
}

function bodyToSpans(body, defaultVoice, defaultSpeed) {
  const spans = [];
  for (const run of splitAtVoices(body, defaultVoice)) {
    for (const { text, pause } of splitAtPauses(run.text)) spans.push(...renderPiece(text.trim(), run.voice, pause, defaultSpeed));
  }
  return spans;
}

/**
 * 解析台本标记。语法和输出的形状见文件头。
 * @param {string|null|undefined} text 台本
 * @param {{ defaultVoice?: string|null, defaultSpeed?: number|null }} [options]
 * @returns {{ title: string, spans: { voice_id: string|null, text: string, pause_ms_after: number, speed: number|null, join?: 'continue'|'paragraph' }[] }[]}
 */
export function parseScript(text, { defaultVoice = null, defaultSpeed = null } = {}) {
  if (text === null || text === undefined || text === '') return [];
  if (typeof text !== 'string') throw new TypeError('台本必须是字符串');
  const chapters = [];
  for (const { title, body } of splitChapters(normalize(text))) {
    const spans = bodyToSpans(body, defaultVoice, defaultSpeed);
    if (spans.length) chapters.push({ title: title ?? `Chapter ${chapters.length + 1}`, spans });
  }
  return chapters;
}
