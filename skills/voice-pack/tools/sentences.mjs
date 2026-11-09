// SPDX-License-Identifier: Apache-2.0
//
// 分句：把一段文字切成句子。只做计算，不用模型。
//
// 做法：先交给平台自带的 Intl.Segmenter（Unicode UAX #29 的句子边界规则，granularity 'sentence'），再把它切错的地方接回去。
// 它在「Mr. 」「J. 」「U.S. 」后面也会断句，这样切出来的「Mr.」单独成一句，配音时会在人名前停一下，所以要接。
// 语言固定用 'en'（不跟随本机语言，免得同一段文字在不同机器上切得不一样）；中、日、韩、俄文的句末标点 UAX #29 本身就认。
// 在 Node 24.14 和 Bun 1.4 里，同样的输入切出同样的结果（2026-10-14 在 45 条难例上对比过）。
//
// 方括号的提示（tools/markup.mjs「提示」：[whispering]、[Sigh]、[小声]）不是要念的字，交给 Segmenter 之前把每个提示整个换成同样长的一串 X（当成一个大写开头的词），
// 切完照位置取回原文。不这样，Segmenter 会看提示里面的字：句号后面接一个小写开头的提示（「…the line. [whispering] Then…」），它当成同一句不切；
// 句号后面紧接着提示（「你好。[小声]我说」），它切在提示的方括号中间。换了以后，句末后面的提示跟着后一段，接不接照下面规则 4 看提示后面的字。
// 例外：英文句号后面不空格就接提示（「The end.[sigh]Then more.」）不切，和不带提示的「end.Then」一样（UAX #29 的 SB7：字母加句号后面紧跟大写字母不断句，
// 提示换成的 X 算大写字母）；问号、叹号和中、日文的句号后面紧接着提示照样切。
// 尖括号标签（tools/markup.mjs「尖括号标签」）也一样不让 Segmenter 看见里面的字，换成同样长的一串：开头的标签（<whisper>、<|speaker:0|>）和音素标记换成 X，
// 跟着后面的字；收尾的标签（</whisper>）换成 )，UAX #29 里它是 Close，跟着前面的句末标点。不这样，句号后面的 <whisper> 里的小写字母让 Segmenter 不切
// （「I waited. <whisper>Go now.</whisper> They…」整个成了一句），中文句号后面紧接着的 </whisper> 被切到后一句的开头。
// 规则 2、4 看词的时候也隔着标签看（不算音素标记：它代替一个词）。
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
//   4. 下一段以小写字母开头（跳过开头的引号、括号和方括号的提示），接：引号后面的说话人（"Why?" he asked.）。
//      小写字母开头几乎一定是同一句里被切断的，除非整段文字是全小写的口语；那种会被接上（done? ok then 这样问号后面接小写的一行，会被接成一句）。
//      开头的提示看它后面的第一个字：「…the line. [whispering] Then…」是两句，「He paused. [sighs] and then…」是一句。
//      一段去掉开头的提示就没有字了（「It was over. [Sigh]」的「[Sigh]」），接：没有字的不成一句。规则 3 看的「下一段以数字开头」也隔着提示看。
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
import { CUE_PATTERN, PLAIN_TAG_PATTERN, TAG_PATTERN } from './markup.mjs';

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

/** 提示（方括号，写法只在 tools/markup.mjs 的 CUE_PATTERN）。LEADING_CUE 是一段开头的一个提示，连同它后面的空白。 */
const CUES = new RegExp(CUE_PATTERN, 'gu');
const LEADING_CUE = new RegExp(`^${CUE_PATTERN}\\s*`, 'u');
/** 尖括号标签（写法只在 tools/markup.mjs）：TAGS 是全部，交给 Segmenter 之前遮住（文件头）；PLAIN_TAGS、LEADING_TAG 不算音素标记，看词的时候隔着它们看。 */
const TAGS = new RegExp(TAG_PATTERN, 'gu');
const PLAIN_TAGS = new RegExp(PLAIN_TAG_PATTERN, 'gu');
const LEADING_TAG = new RegExp(`^(?:${PLAIN_TAG_PATTERN})\\s*`, 'u');
/** 遮住一个尖括号标签的一串字（同样长）：收尾的标签是 )（Close，跟着前面的字），别的是 X（跟着后面的字）。见文件头。 */
const maskOfTag = (tag) => (tag.startsWith('</') ? ')' : 'X').repeat(tag.length);

// 一段文字的最后一个词（按空白分），去掉标签（音素标记除外）和开头的引号、括号
function lastWord(text) {
  const trimmed = text.replace(PLAIN_TAGS, '').trimEnd();
  const parts = trimmed.split(/\s+/);
  return skipOpeners(parts[parts.length - 1]);
}

/** 一段文字开头要念的第一个字从哪起：跳过开头的空白、引号、括号、方括号的提示，和尖括号标签（音素标记除外）（规则 4）。 */
function firstWords(text) {
  let rest = text.trimStart();
  for (;;) {
    const skip = LEADING_CUE.exec(rest) ?? LEADING_TAG.exec(rest);
    if (skip !== null) rest = rest.slice(skip[0].length);
    else if (rest !== '' && OPENERS.has(rest.charCodeAt(0))) rest = rest.slice(1);
    else return rest;
  }
}

const startsWith = (text, pattern) => pattern.test(firstWords(text));
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
  return startsWith(next, LOWERCASE) || firstWords(next) === '';
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
  // Segmenter 看的是把提示换成 X、尖括号标签遮住的文字（文件头），切出来的一段按它的长短从原文里取回
  const seen = text.replace(CUES, (cue) => 'X'.repeat(cue.length)).replace(TAGS, maskOfTag);
  let at = 0;
  for (const { segment: masked } of sentenceSegmenter().segment(seen)) {
    const segment = text.slice(at, at + masked.length);
    at += masked.length;
    if (current !== '' && shouldJoin(current, segment)) current += segment;
    else {
      if (current !== '') sentences.push(current);
      current = segment;
    }
  }
  if (current !== '') sentences.push(current);
  return sentences.map((s) => s.trim()).filter((s) => s !== '');
}
