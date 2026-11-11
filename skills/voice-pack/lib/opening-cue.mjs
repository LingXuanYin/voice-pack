// SPDX-License-Identifier: Apache-2.0
//
// 请求开头的提示（流程层，纯计算，配音用：lib/dub.mjs）：调用方和设定给的情绪、风格、能量，合成一条方括号的提示，写在每个请求的文字前面。
// 不调能力，不碰音频。在每个请求的哪里加、哪个请求不加，由 lib/dub.mjs 定（文件头「设定」和第 7 步）；这里只管怎么合、怎么写进文字。
// 设定、调用方的说明（instructions，例如口音）不在这里：它不发给模型（概括的标签，模型不知道具体怎么念），是给写台本的人看的，由 lib/dub.mjs 在规划的 notes 里列出来。
//
// 怎么合：
//   - 三项，次序固定：情绪（emotion）、风格（style）、能量（energy）。每一项分别取：调用方给的，没有再取设定的（不是整组取：
//     调用方只给了情绪，风格照样取设定的）。都没有就没有这条提示（openingCueOf 返回的 cue 是 null）。
//   - 取到了也不合进去的（返回的 skipped 里列着，lib/dub.mjs 照它在规划的 notes 里说明）：
//       一下子的声音（规范名字在 vocab/cues.json 的 oneShot 里：笑、叹气、咳嗽、吸一口气这类）。开头的提示管整句怎么说，
//       一下子的声音是一件事，要写在它发生的地方（[sighs]）；并进开头的提示（[sad, sigh, …]）就成了整句的说法。设定的、调用方给的都一样，填在风格里、情绪里也一样
//       （oneShot 按风格的规范名字列。风格的值按词表认（canonicalLabel）；情绪的值整个就得是风格词表里一下子的声音的一个词（wholeLabel：笑、laugh、叹气、冷笑），
//       词表里认得的情绪（微笑是 happy）和只是字里含着笑、叹的（惊叹、感叹）都是普通的情绪，照合）。
//     没有这种的，合成的提示和以前一字不差。
//   - 情绪、风格写成标签词表（vocab/cues.json）的规范名字（lib/line-hints.mjs 的 canonicalLabel：生气、愤怒都写成 angry）；词表里没有的，照写（去掉两头空白）。
//   - 能量写成 `<low|medium|high> energy`。
//   - 几项用「, 」接起来，外面一对方括号：[angry, low energy]。
//   返回 { cue, parts, skipped }：cue 是这条提示（一项都没合进去是 null）；parts 是用上的每一项 { value, from }，value 是写进提示的样子，from 是 'caller'（调用方给的）或 'setup'（设定的），
//   没用上的项不出现；skipped 是取到了、没合进去的一下子的声音 [{ item, value, from }]（item 是 'emotion' 或 'style'，value 是它的规范名字），没有是空数组。
//
// 怎么写进文字（withOpeningCue）：写在最前面。挨着的是词和词之间写空格的字（拉丁字母，带重音的也算，希腊、西里尔字母，谚文，数字：protocol/lib/word-spacing.mjs 的 SPACED_WORD，
//   字符类只写在那里）留一个空格（[angry] Stop it.、[angry] Ça suffit.、[angry] Стой.），挨着中文、假名、引号、标点的直接接（[angry]站住！、[angry]"Stop it," he said.）。
//   台本里只有提示的一截接到下一句开头（lib/dub.mjs）也是这一条（cueThenText）。
//   提示先写进文字，SSML 的拼音音素（只声明了 phoneme-in-text 的环境，<speak> 包着，lib/dub.mjs 第 4 步）后换，所以提示在 <speak> 里面的最前面，提示里面不换。音素标签（phoneme-markers）在第 4 步就写进了要说的话，提示里面同样不换。
// 文字开头是不是已经有一条提示（opensWithCue）：去掉开头的空白，第一个是方括号的提示。lib/dub.mjs 用它认「台本在这一段开头自己写了提示」。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { CUE_PATTERN } from '../tools/markup.mjs';
import { canonicalLabel, wholeLabel } from './line-hints.mjs';
import { SPACED_WORD } from '../protocol/lib/word-spacing.mjs';
import cues from '../vocab/cues.json' with { type: 'json' };

/** 合成提示的几项，次序就是写进提示的次序。 */
export const OPENING_ITEMS = Object.freeze(['emotion', 'style', 'energy']);

/** 一下子的声音（规范名字）：vocab/cues.json 的 oneShot 是唯一的来源，这里只读。 */
const ONE_SHOT_STYLES = new Set(cues.oneShot.style);

const OPENS_WITH_CUE = new RegExp(`^\\s*${CUE_PATTERN}`, 'u');

/** 一项给了没有：字符串，去掉两头空白以后不是空的。 */
const given = (value) => typeof value === 'string' && value.trim() !== '';

/** 一项写进提示的样子（规则见文件头「怎么合」）。 */
function written(item, value) {
  if (item === 'emotion' || item === 'style') return canonicalLabel(item, value);
  return value.trim();
}

/** 能量在提示里的说法。 */
const phrase = (item, value) => (item === 'energy' ? `${value} energy` : value);

/**
 * 取到的情绪、风格是不是一下子的声音（文件头「取到了也不合进去的」）：是，返回它的规范名字；不是 null。
 * 风格按词表认（canonicalLabel）；情绪整个值得是一下子的声音的一个词才算（wholeLabel）：微笑是 happy，惊叹、感叹只是含着「叹」，都是普通的情绪。
 */
const oneShotOf = (item, value) => {
  if (item === 'energy') return null;
  const style = item === 'style' ? canonicalLabel('style', value) : wholeLabel('style', value);
  return ONE_SHOT_STYLES.has(style) ? style : null;
};

/**
 * 合成开头的提示。caller、setup 各是 { emotion?, style?, energy? }（调用方给的、设定的；没给的项是 undefined、null 或空字符串）。
 * 写法（能量是 low、medium、high 之一）由调用的一方先查过：这里不再查。
 * @returns {{ cue: string|null, parts: Record<string, { value: string, from: 'caller'|'setup' }>, skipped: { item: string, value: string, from: 'caller'|'setup' }[] }}
 *   一项都没合进去，cue 是 null
 */
export function openingCueOf(caller, setup) {
  const parts = {};
  const skipped = [];
  for (const item of OPENING_ITEMS) {
    const source = given(caller?.[item]) ? ['caller', caller[item]] : given(setup?.[item]) ? ['setup', setup[item]] : null;
    if (source === null) continue;
    const oneShot = oneShotOf(item, source[1]);
    if (oneShot === null) parts[item] = { value: written(item, source[1]), from: source[0] };
    else skipped.push({ item, value: oneShot, from: source[0] });
  }
  const items = OPENING_ITEMS.filter((item) => parts[item] !== undefined);
  return { cue: items.length === 0 ? null : `[${items.map((item) => phrase(item, parts[item].value)).join(', ')}]`, parts, skipped };
}

/** 文字开头（去掉空白）是不是一条方括号的提示。 */
export const opensWithCue = (text) => OPENS_WITH_CUE.test(text);

/**
 * 一条提示后面接文字（规则见文件头「怎么写进文字」）：文字的第一个字是词和词之间写空格的字（SPACED_WORD），中间留一个空格；别的直接接。
 * 请求开头的提示（withOpeningCue）和台本里只有提示的一截接到下一句的开头（lib/dub.mjs）都用它。
 */
export function cueThenText(cue, text) {
  const first = text === '' ? '' : String.fromCodePoint(text.codePointAt(0));
  return SPACED_WORD.test(first) ? `${cue} ${text}` : `${cue}${text}`;
}

/**
 * 把提示写在一个请求的文字最前面（规则见文件头「怎么写进文字」）。cue 是 null 就原样返回。
 */
export function withOpeningCue(text, cue) {
  if (cue === null || cue === undefined) return text;
  return cueThenText(cue, text.trimStart());
}
