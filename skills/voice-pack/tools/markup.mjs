// SPDX-License-Identifier: Apache-2.0
//
// 台本标记解析：把带标记的台本变成 [{ title, spans }]。每个 span 是要用同一个声音说完的一段文字，
// 外加它后面的停顿。只做计算，不用模型。
//
// 这个文件头是语法的正本。tools/cases/markup.json 是它的标准用例；嵌入这个库的 app 要是自己带了解析器，也拿这份用例来对，
// 结果不一致就是有一边错了，先定哪个对，再一起改。
// 语法的来源只有这份说明（Apache-2.0 这边自己写的）：下面几个正则（停顿、声音、提示、空行）是照语法里的词素拼出来的（见「标记的正则」），
// 写它们时没有对照 app 的解析器，也没有复制上游 VoiceStudio 的代码（它们是 AGPL-3.0-only，这里是 Apache-2.0）。
//
// 台本标记只有三种：章节、换声音、停顿（名单在 vocab/markup.json）。这三种是基础部分自己要处理的：在哪里切开、用哪个包、拼接时插多长的静音。
// 别的方括号内容一律是**提示**（写给模型的「怎么说」：[sad and surprised]、[小声]、[laughs]……），不是标记：原样留在文字里它所在的位置，交给模型。
// 以前的 [slow]、[fast]、[emphasis]、[spell] 也不再单列，写了就是提示，原样留着（配音用的模型上，用标记放慢按时长量过没有效果，见 models/ 里的模型说明）。
// 外层先于内层，顺序是 章节 > 声音 > 停顿；内层的标记不会跨过外层的标记。标记的关键字（pause、voice）不分大小写。
//
//   换行    CRLF、单独的 CR 都当作 LF；文本开头的 BOM（U+FEFF）去掉。LS（U+2028）、PS（U+2029）在找章节标题时也算换行。
//   空白    ECMAScript 的 WhiteSpace 加换行符，也就是 String.prototype.trim 去掉的那些字符。
//   章节    行首的 `# 标题`：行首可以有空格、制表符；一个 #；后面至少一个空格或制表符；标题从第一个非空白字符到行尾，去掉两头空白。
//           `##`、`#标题`、行中间的 # 都是正文。标题是纯文字，里面的标记不起作用。
//           第一个标题之前有正文，它就是一章，标题是 `Chapter 1`。没有 span 的章节丢掉。
//   声音    `[voice:名字]`：这以后的文字用这个声音，到下一个声音标记或这一章结束为止（不跨章）。
//           名字不能含方括号，去掉两头空白，保留大小写；名字是空的（`[voice:]`）就回到默认声音（options.defaultVoice，没给就是 null）。
//   停顿    `[pause]`（350 ms）、`[pause 数字]`、`[pause 数字s]`、`[pause 数字ms]`。数字是 ASCII 数字，可以带小数，点两边都要有数字；
//           没有单位按毫秒；四舍六入五取偶。没有上限：写多长就停多长，两个标记相加也不封顶。括号里两头可以有空白，数字和单位之间也可以有。
//           上限只有一处，是一份 WAV 能装的：超过 2147483629 秒（按最低采样率 1 Hz 算，见下面的 PAUSE_FORMAT_MAX_MS）的，任何采样率的音频都放不下，
//           这里抛 pause_out_of_range。按实际采样率放不下的，拼接时（lib/mix.mjs）报错，不在这里截。
//           停顿属于它前面的那段文字（pause_ms_after）。两个标记紧挨着（中间一个字符也没有）就相加；
//           中间隔着空白就不合并，后一个成为文字为空的 span（下游把它的停顿加到前一个 span 上，所以只是表示不同）。
//           长得像停顿、不合这个写法的（`[pause1s]`、`[pause 1sec]`、`[break 1s]`）不是停顿，是提示，原样留着。
//   提示    方括号里一个以上不是方括号、不是换行的字，又不是上面的声音、停顿：`[sad and surprised]`、`[小声]`、`[slow]`、`[/slow]`。
//           它是文字的一部分，不切开 span，不改声音，原样（连方括号）留在它所在的位置。读音词表不碰它（见下面「和读音词表的关系」）。
//           中文全角括号、星号写的舞台说明（`（耳语）`、`*笑*`）不是这里的事：配音把它们换成同样意思的提示，规则在 lib/line-hints.mjs 的 cuesInPlace。
//
// 输出  [{ title, spans: [{ voice_id, text, pause_ms_after, line_start?, pause_line? }] }]
//   voice_id  声音名；没有声音标记、也没给默认声音就是 null
//   text      去掉两头空白的文字（提示在原位）；只有停顿的 span 是空串
//   line_start  只在选项 lineStarts 为真时出现（为真才有这个键）：这一段和前一段之间有换行（LF），或者换了声音，或者是一章的第一段。
//             一段和前一段之间只隔着停顿标记、没有换行的，没有这个键。配音读舞台说明读的是同一行里的（lib/line-hints.mjs），靠它断开。
//   pause_line  只在选项 pauseLines 为真时出现（为真才有这个键）：这一段后面的停顿里，有一个标记所在的那一行只有停顿标记和空白（单独一行的停顿）。
//             写在一行行尾、行首的停顿没有这个键。配音认场景的边界靠它（lib/dub.mjs 第 5c 步）。
// 台本是空串、null、undefined 或者没有任何内容，结果是 []。台本不是字符串（也不是空值）抛 TypeError。
// 选项：defaultVoice（见上）；lineStarts、pauseLines（见「输出」）。
//
// 和读音词表的关系：词表只替换标记和提示以外的文字。标记里的词（pause、voice、声音名）是语法，提示里的词是写给模型的，都不是要念的话：
// 词表先于解析器跑的话，把 pause 改成 break，`[pause 1s]` 就不再是停顿；改了提示里的词，提示就不是作者写的了。
// 做法是 lib/pronunciation-lexicon.mjs 的 applyLexicon（用本文件导出的 MARKER_PATTERN 把标记和提示隔开）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

import { RIFF_SIZE_MAX, wavFileBytes } from './wav.mjs';
import { VoicePackError } from '../protocol/lib/errors.mjs';

// 停顿的默认时长（语法「停顿」：`[pause]` 是 350 ms）：数值是语法里写明的事实
const PAUSE_DEFAULT_MS = 350;
// 停顿的格式上限：一份 16 位单声道的 WAV 最多 RIFF 长度字段装得下的采样数（tools/wav.mjs 的 RIFF_SIZE_MAX 和 wavFileBytes 算出来的：
// 44 字节的头，之后每个采样 2 字节）。采样率按最低 1 Hz 算（再低的没有意义），所以停顿最长这么多毫秒：超过的，任何采样率的音频都放不下。
const PAUSE_FORMAT_MAX_FRAMES = Math.floor((RIFF_SIZE_MAX + 8 - wavFileBytes(0, 1)) / 2);
const PAUSE_FORMAT_MAX_MS = PAUSE_FORMAT_MAX_FRAMES * 1000;

// ---------------------------------------------------------------- 标记的正则
// 停顿、声音的正则是照上面语法里写的话写出来的，关键字不分大小写（语法开头一句），所以带 i。

// 语法「停顿」列出的写法有两种：不带数字的 `[pause]`，和带数字的 `[pause 数字]`、`[pause 数字s]`、`[pause 数字ms]`。
// 所以是两个分支：括号里两头可以有空白；数字是 ASCII 数字，可以带小数，点的两边都要有数字，和 pause 之间至少一个空白；
// 单位（ms 或 s）可有可无，和数字之间可以有空白。第二个分支的捕获组 1 是数字，2 是单位（没写就没有）。
const PAUSE_RE = new RegExp(['\\[\\s*pause\\s*\\]', '\\[\\s*pause\\s+(\\d+(?:\\.\\d+)?)(?:\\s*(ms|s))?\\s*\\]'].join('|'), 'gi');
// 语法「声音」：关键字 voice 和冒号紧挨着，冒号后面到右方括号之间是名字：除了方括号什么字符都行，可以是空。捕获组 1 是名字，两头的空白由用它的人去掉
const VOICE_RE = new RegExp('\\[voice:([^\\]\\[]*)\\]', 'gi');
/**
 * 语法「提示」：方括号里一个以上不是方括号、不是换行的字。用 new RegExp(CUE_PATTERN, 'g') 建正则。声音、停顿的标记也长这个样子：
 * 解析器先认出它们（外层先于内层），剩在文字里的方括号才是提示。给要找出提示的代码用：配音去掉提示认语种（lib/line-hints.mjs），读音词表绕开提示（MARKER_PATTERN）。
 */
export const CUE_PATTERN = '\\[[^\\[\\]\\n]+\\]';
// 所有标记和提示合成一个正则的源码，给必须绕开它们的代码用（读音词表：lib/pronunciation-lexicon.mjs 的 applyLexicon、applyPhonemes）；用 new RegExp(MARKER_PATTERN, 'gi') 建正则。
// 正则在这个文件里只有一份，写法改了，这里跟着变。
export const MARKER_PATTERN = [PAUSE_RE.source, VOICE_RE.source, CUE_PATTERN].join('|');

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

// 每一章的正文（body）从规范化的台本的 start 位置开始：标记的行和列要从台本的开头数
function splitChapters(text) {
  const headings = findHeadings(text);
  if (!headings.length) return [{ title: null, body: text, start: 0 }];
  const parts = [];
  const intro = text.slice(0, headings[0].start);
  if (intro.trim()) parts.push({ title: null, body: intro, start: 0 });
  headings.forEach((h, i) => {
    parts.push({ title: h.title, body: text.slice(h.end, i + 1 < headings.length ? headings[i + 1].start : text.length), start: h.end });
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
    if (m.index > last) runs.push({ voice, text: body.slice(last, m.index), start: last });
    voice = m[1].trim() || defaultVoice;
    last = m.index + m[0].length;
  }
  runs.push({ voice, text: body.slice(last), start: last });
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
 * 一个停顿的毫秒数：数字（字符串，ASCII 数字，可带小数）和单位（'s' 按秒，其余按毫秒），四舍六入五取偶，没有上限。
 * 超过 PAUSE_FORMAT_MAX_MS（一份 WAV 能装的）抛 pause_out_of_range：不截，也不当成别的数。没给数字就是默认的 350。
 * 导出给 lib/line-hints.mjs：舞台提示里写的时长用同一条规则。
 * @param {string|undefined} number
 * @param {string|undefined} unit
 * @param {{ marker: string, text: string, index: number }} [where] 标记的原文、规范化以后的台本、标记在台本里的位置：报错时说清是哪一处（没有就不说）
 */
export function pauseMs(number, unit, where) {
  if (number === undefined) return PAUSE_DEFAULT_MS;
  const value = Number.parseFloat(number) * (unit !== undefined && unit.toLowerCase() === 's' ? 1000 : 1);
  const ms = roundHalfToEven(value);
  // 写不出一个有限的数（数字多到超出浮点数），或者超出一份 WAV 的采样数，都是放不下：照实说，不截
  if (!(ms <= PAUSE_FORMAT_MAX_MS)) throw pauseOutOfRange(where);
  return Math.max(0, ms);
}

/**
 * 停顿超出一份 WAV：说清是台本的哪一处。details 是 { marker, line, column, limitSeconds }（标准用例的 expected_error 比对它）。
 * where 是 { marker, text, index }（标记的原文、规范化以后的台本、标记在台本里的位置），或者 { marker, place }（位置已经由别处算好：{ line, column }，见 placeOfMarker）。
 * where 没有 text 也没有 place 时（舞台提示的停顿：lib/line-hints.mjs 读的是一句话的文字，不知道它在台本的哪里）line、column 是 null，marker 照给；什么都没给时三个都是 null。
 * 导出给 lib/line-hints.mjs：它给舞台提示的停顿补上位置时用。
 */
export function pauseOutOfRange(where) {
  const limitSeconds = PAUSE_FORMAT_MAX_MS / 1000;
  const at = where?.place ?? (where?.text === undefined ? null : placeIn(where.text, where.index));
  const marker = where?.marker ?? null;
  let what = '一处停顿';
  if (at !== null) what = `台本第 ${at.line} 行第 ${at.column} 列的停顿 ${marker}`;
  else if (marker !== null) what = `台本里的舞台提示 ${marker}`;
  return new VoicePackError('pause_out_of_range', `${what}超过一份 WAV 能装的（${limitSeconds} 秒，按最低采样率 1 Hz 算）：任何采样率的音频都放不下它`, {
    details: { marker, line: at?.line ?? null, column: at?.column ?? null, limitSeconds },
  });
}

/** 规范化以后的台本里，index 在第几行第几列（都从 1 数；行以 LF 分，列是这一行里 UTF-16 的位置）。 */
function placeIn(text, index) {
  const before = text.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

/**
 * 一处标记第一次写在台本的哪里：{ line, column }，数法和 [pause] 报错的一样（规范化以后的台本，都从 1 数）；找不到是 null。章节标题（# 开头的行）里写的不算：标题是纯文字。
 * 给读出来的东西找位置用：舞台提示是从一句话的文字里读出来的，那句话不带它在台本里的位置。同一个提示写了几处，每一处都一样长，说第一处就是说清了「哪一个」。
 * @param {string} script 台本（没规范化的原文）
 * @param {string} marker 标记的原文
 */
export function placeOfMarker(script, marker) {
  if (typeof script !== 'string' || typeof marker !== 'string' || marker === '') return null;
  const text = normalize(script);
  for (const chapter of splitChapters(text)) {
    const at = chapter.body.indexOf(marker);
    if (at >= 0) return placeIn(text, chapter.start + at);
  }
  return null;
}

// 按停顿标记把一段正文切开：[{ text, pause, alone }]，pause 是这段文字后面的停顿（毫秒），alone 是这些停顿里有没有单独一行的标记。
// script 是这段文字所在的规范化台本（text）和它从哪里开始（start），用来算标记的位置；script.aloneAt 给了才算 alone（选项 pauseLines，见 pauseOnlyLines）。
// 两个标记紧挨着（中间一个字符都没有）时，后一个并入前一个，相加（没有上限）；中间隔着空白就不并。
function splitAtPauses(text, script) {
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(PAUSE_RE)) {
    const before = text.slice(last, m.index);
    last = m.index + m[0].length;
    const pause = pauseMs(m[1], m[2], { marker: m[0], text: script.text, index: script.start + m.index });
    const alone = script.aloneAt !== null && script.aloneAt(script.start + m.index);
    if (before === '' && pieces.length) {
      pieces[pieces.length - 1].pause += pause;
      pieces[pieces.length - 1].alone ||= alone;
    } else pieces.push({ text: before, pause, alone });
  }
  const tail = text.slice(last);
  if (tail !== '' || !pieces.length) pieces.push({ text: tail, pause: 0, alone: false });
  return pieces;
}

// 规范化台本的每一行（LF 之间）是不是只有停顿标记和空白：返回 (index) => boolean，index 处所在的那一行是不是。输出里的 pause_line（选项 pauseLines）用它。
// 整份台本只扫一遍（一行几万个停顿也不慢），按位置找行用二分。
function pauseOnlyLines(text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const only = starts.map((start, k) => text.slice(start, k + 1 < starts.length ? starts[k + 1] - 1 : text.length).replace(PAUSE_RE, '').trim() === '');
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return only[low];
  };
}

// ---------------------------------------------------------------- 一个声音的一段正文 -> span

// body：这一章的正文。script：这一章的正文所在的规范化台本（text）和正文从哪里开始（start）。
// 每一段停顿之间的文字去掉两头空白，就是一个 span（提示留在文字里）；只有空白、后面又没有停顿的不出 span。
// 行首（line_start）：这一段和前一段之间有换行，或者是这个声音、这一章的第一段。
function bodyToSpans(body, defaultVoice, script, options) {
  const spans = [];
  for (const run of splitAtVoices(body, defaultVoice)) {
    let sawLineFeed = false; // 上一个出了 span 的段之后，见过换行
    let fresh = true; // 这个声音（或这一章）还没有出过 span
    const startsLine = () => {
      const lineStart = sawLineFeed || fresh;
      sawLineFeed = false;
      fresh = false;
      return lineStart;
    };
    for (const piece of splitAtPauses(run.text, { text: script.text, start: script.start + run.start, aloneAt: script.aloneAt })) {
      const text = piece.text.trim();
      if (text === '') {
        if (piece.text.includes('\n')) sawLineFeed = true;
        if (piece.pause <= 0) continue;
        const span = { voice_id: run.voice, text: '', pause_ms_after: piece.pause };
        if (startsLine() && options.lineStarts) span.line_start = true; // 要不要行首标记都要问：问了，换行和 fresh 的状态就用掉了
        if (piece.alone && options.pauseLines) span.pause_line = true;
        spans.push(span);
        continue;
      }
      if (piece.text.slice(0, piece.text.length - piece.text.trimStart().length).includes('\n')) sawLineFeed = true;
      const span = { voice_id: run.voice, text, pause_ms_after: piece.pause };
      if (startsLine() && options.lineStarts) span.line_start = true;
      if (piece.alone && options.pauseLines) span.pause_line = true;
      spans.push(span);
      if (piece.text.slice(piece.text.trimEnd().length).includes('\n')) sawLineFeed = true;
    }
  }
  return spans;
}

/**
 * 解析台本标记。语法和输出的形状见文件头。
 * @param {string|null|undefined} text 台本
 * @param {{ defaultVoice?: string|null, lineStarts?: boolean, pauseLines?: boolean }} [options]
 * @returns {{ title: string, spans: { voice_id: string|null, text: string, pause_ms_after: number, line_start?: true, pause_line?: true }[] }[]}
 */
export function parseScript(text, { defaultVoice = null, lineStarts = false, pauseLines = false } = {}) {
  if (text === null || text === undefined || text === '') return [];
  if (typeof text !== 'string') throw new TypeError('台本必须是字符串');
  const chapters = [];
  const script = normalize(text);
  const options = { lineStarts: lineStarts === true, pauseLines: pauseLines === true };
  const aloneAt = options.pauseLines ? pauseOnlyLines(script) : null;
  for (const { title, body, start } of splitChapters(script)) {
    const spans = bodyToSpans(body, defaultVoice, { text: script, start, aloneAt }, options);
    if (spans.length) chapters.push({ title: title ?? `Chapter ${chapters.length + 1}`, spans });
  }
  return chapters;
}
