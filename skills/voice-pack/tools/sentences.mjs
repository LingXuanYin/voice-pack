// SPDX-License-Identifier: Apache-2.0
//
// 分句：把一段文字切成句子。只做计算，不用模型。
//
// 做法：先交给平台自带的 Intl.Segmenter（Unicode UAX #29 的句子边界规则，granularity 'sentence'），再把它切错的地方接回去。
// 它在「Mr. 」「J. 」「U.S. 」后面也会断句，这样切出来的「Mr.」单独成一句，配音时会在人名前停一下，所以要接。
// 语言固定用 'en'（不跟随本机语言，免得同一段文字在不同机器上切得不一样）；中、日、韩、俄文的句末标点 UAX #29 本身就认。
// 在 Node 24.14 和 Bun 1.4 里，同样的输入切出同样的结果（2026-10-14 在 45 条难例上对比过）。
//
// 规则（先后顺序就是判断顺序）。「接」是把相邻两段合成一句：
//   1. 换行永远断句：一段以换行（LF、CR、LS、PS）结束，就不接下一段。台本一行一句，所以硬折行的文章要先自己合并行再来分。
//      只有空白的段（空行）不成句，最后丢掉。
//   2. 前一段的最后一个词是称谓、缩写，接：
//        称谓和固定缩写  mr mrs ms mx messrs mmes dr drs prof rev hon gen col capt lt sgt gov sen rep fr st mt vs cf viz，后面带句号
//        单个大写字母    首字母（J. K. Rowling）、编号（A. B.）
//        大写字母缩写    U.S.  U.K.  E.U.
//        e.g.  i.e.  a.k.a.
//        整段只有「数字加句号」  编号（1. 2.）
//   3. 前一段的最后一个词是 no nos fig figs vol vols ch chap sec art p pp pt ed eds op，或者 jan feb mar apr jun jul aug sep sept oct nov dec，
//      后面带句号，并且下一段以数字开头，接（No. 5、Fig. 3、Jan. 6）。
//   4. 下一段以小写字母开头（跳过开头的引号、括号），接：引号后面的说话人（"Why?" he asked.）。
//      小写字母开头几乎一定是同一句里被切断的，除非整段文字是全小写的口语；那种会被接上（done? ok then 这样问号后面接小写的一行，会被接成一句）。
//   都不是就不接。
//
// 有意的取舍：宁可接错，不要切错。接错只是两句合成一行（配音时句号照样停顿）；切错会把「Mr.」「St.」单独念成一句。
// 所以以缩写结尾的真句末（He lives on Main St. He walks.）、以单个大写字母结尾的句子（Take Plan B. It works.）、以 U.S. 结尾的句子，
// 会和下一句接在一起。a.m. p.m. Inc. etc. 不在名单里：它们常常是句末，也常常后面接小写（Segmenter 本来就不在那里切）。
//
// 输入是不带标记的文字，例如 parseScript 给出的 span 的 text；带标记的台本先过 markup.mjs。
// 输出：句子的数组，每句去掉两头空白（ECMAScript trim 的空白），句子里面的空白不改；没有空句。输入是空串、null、undefined、只有空白，结果是 []。
// 不是字符串（也不是空值）抛 TypeError；环境没有 Intl.Segmenter（Chrome 87、Firefox 125、Safari 14.1 之前）抛 segmenter_missing。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';

const TITLES = new Set([
  'mr', 'mrs', 'ms', 'mx', 'messrs', 'mmes', 'dr', 'drs', 'prof', 'rev', 'hon', 'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'fr',
  'st', 'mt', 'vs', 'cf', 'viz',
]);
const DOTTED_LOWER = new Set(['e.g', 'i.e', 'a.k.a']);
const BEFORE_NUMBER = new Set([
  'no', 'nos', 'fig', 'figs', 'vol', 'vols', 'ch', 'chap', 'sec', 'art', 'p', 'pp', 'pt', 'ed', 'eds', 'op',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

// 开头的引号和括号：ASCII 的 " ' ( [，弯引号 U+2018 U+201C，直角引号 U+300C U+300E
const OPENERS = new Set([...'"\'(['].map((c) => c.charCodeAt(0)).concat([0x2018, 0x201c, 0x300c, 0x300e]));

let segmenter;
function sentenceSegmenter() {
  if (segmenter) return segmenter;
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    // 环境没有分句所需的 Intl.Segmenter，没有退路（按标点硬切会切坏缩写和小数）。details.api 是缺的那一项
    throw new VoicePackError('segmenter_missing', '运行环境没有 Intl.Segmenter（Chrome 87、Firefox 125、Safari 14.1 起才有），不能分句', { details: { api: 'Intl.Segmenter' } });
  }
  segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return segmenter;
}

function endsWithLineBreak(text) {
  const code = text.charCodeAt(text.length - 1);
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

// 去掉开头的引号和括号
function skipOpeners(text) {
  let i = 0;
  while (i < text.length && OPENERS.has(text.charCodeAt(i))) i++;
  return text.slice(i);
}

// 一段文字的最后一个词（按空白分），去掉开头的引号和括号
function lastWord(text) {
  const trimmed = text.trimEnd();
  const parts = trimmed.split(/\s+/);
  return skipOpeners(parts[parts.length - 1]);
}

const startsWith = (text, pattern) => pattern.test(skipOpeners(text.trimStart()));
const INITIAL = /^\p{Lu}$/u;
const CAPS_ACRONYM = /^(?:\p{Lu}\.)+\p{Lu}$/u;
const LIST_NUMBER = /^[0-9]{1,3}\.$/;
const DIGIT = /^[0-9]/;
const LOWERCASE = /^\p{Ll}/u;

function shouldJoin(previous, next) {
  if (endsWithLineBreak(previous)) return false;
  const word = lastWord(previous);
  if (word.endsWith('.')) {
    const bare = word.slice(0, -1);
    const key = bare.toLowerCase();
    if (TITLES.has(key) || DOTTED_LOWER.has(key) || INITIAL.test(bare) || CAPS_ACRONYM.test(bare)) return true;
    if (LIST_NUMBER.test(word) && previous.trim() === word) return true;
    if (BEFORE_NUMBER.has(key) && startsWith(next, DIGIT)) return true;
  }
  return startsWith(next, LOWERCASE);
}

/**
 * 分句。规则和取舍见文件头。
 * @param {string|null|undefined} text 不带标记的文字
 * @returns {string[]} 句子，每句去掉两头空白
 */
export function splitSentences(text) {
  if (text === null || text === undefined || text === '') return [];
  if (typeof text !== 'string') throw new TypeError('文字必须是字符串');
  const sentences = [];
  let current = '';
  for (const { segment } of sentenceSegmenter().segment(text)) {
    if (current !== '' && shouldJoin(current, segment)) current += segment;
    else {
      if (current !== '') sentences.push(current);
      current = segment;
    }
  }
  if (current !== '') sentences.push(current);
  return sentences.map((s) => s.trim()).filter((s) => s !== '');
}
