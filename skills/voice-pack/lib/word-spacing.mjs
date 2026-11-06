// SPDX-License-Identifier: Apache-2.0
//
// 两截文字接起来，中间放不放空格：中文、日文的字之间本来不空格；英文、韩文这类词和词之间写空格。字符类只写在这里，用它的：
// 做包的句子合段（lib/make-pack-sentences.mjs，句子的文字接成段的文字）、提示标注推逐字文本（lib/make-pack-input.mjs，去掉提示的地方），
// 配音把几句、几段接成一个请求（lib/dub.mjs 的 joinSpoken，lib/pause-in-request.mjs 的停顿写法和两段之间放的字）。
//
//   writtenWithoutSpaceBetween(before, after)  接的地方本来不空格：前一截的结尾（隔着收尾的引号、括号、省略号、破折号，CLOSING）或者后一截的开头
//                                              （隔着开头的这些，OPENING）是汉字、假名或它们的全角标点（WRITTEN_WITHOUT_SPACES）。谚文不算：韩文和英文一样加一个空格。
//                                              例：「用的是iPhone」「好的,」后面接中文、「OK.」后面接一句中文都不加；「“走吧。”」的结尾隔着引号是句号，不加；
//                                              「안녕하세요」后面接「반갑습니다」加一个。
//   joinWritten(before, after)                 两截接起来：前一截是空的，或者已经以空白结尾，直接接；不然照上一条，本来不空格的直接接，别的中间加一个空格。
//   endsWrittenWithoutSpaces(text)             结尾（隔着收尾的引号、括号、省略号、破折号）是汉字、假名或它们的全角标点：后面接的写法用中文的那一种（lib/pause-in-request.mjs）。
//
// 提示标注推逐字文本时另有几条细的（去掉提示的地方，lib/make-pack-input.mjs 的 spaceAfterCue），用到的字符类也在这里：
//   HAN_OR_KANA             汉字、假名（含长音符「ー」，和 々〇〆 这几个当字用的符号）
//   FULL_WIDTH_PUNCTUATION  全角标点（。、，！？「」（）……，含半角的「｡｢｣､･」和「・」）；全角的字母、数字不算，々〇〆 也不算（它们是 HAN_OR_KANA）
//   SPACED_WORD             词和词之间写空格的字：拉丁、希腊、西里尔字母，韩文，数字
//   LATIN_CLOSING           英文的收尾标点（. , ! ? ; : ) ] }）：挨着它的前面不空格
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 一个字：汉字、假名，或它们的全角标点（CJK 标点、片假名区、全角字符）。接的地方有一边是它就不空格。谚文不在里面。 */
export const WRITTEN_WITHOUT_SPACES = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u30a0-\u30ff\uff00-\uffef]$/u;
/** 一截收尾可能有的引号、括号、省略号、破折号：看空不空格时隔着它们看里面那个字（「“走吧。”」的结尾是句号）。 */
export const CLOSING = /["'”’»)\]}…—]+$/u;
/** 一截开头可能有的引号、括号、省略号、破折号（「……好吧。」）：隔着它们看后面那个字。 */
export const OPENING = /^["'“‘«(\[{…—]+/u;

/** 汉字、假名（含长音符「ー」）：中文、日文的字之间本来不空格。々（U+3005）、〇（U+3007）是汉字；〆（U+3006）不是，当字用，也算在这里。 */
export const HAN_OR_KANA = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\u3006]$/u;
const FULL_WIDTH_RANGE = /^[\u3000-\u303f\u30fb\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]$/u;
/** 全角标点（。、，！？「」（）……，含半角的「｡｢｣､･」和「・」）：挨着它本来不空格。全角的字母、数字不算；々〇〆 这几个当字用的不算（是 HAN_OR_KANA）。 */
export const FULL_WIDTH_PUNCTUATION = { test: (ch) => FULL_WIDTH_RANGE.test(ch) && !HAN_OR_KANA.test(ch) };
/** 词和词之间写空格的字：拉丁、希腊、西里尔字母，韩文，数字。 */
export const SPACED_WORD = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hangul}\p{Nd}]$/u;
/** 英文的收尾标点：前面紧挨着一个词写，不空格。 */
export const LATIN_CLOSING = /^[.,!?;:)\]}]$/u;

/** 一截文字的最后一个字，隔着收尾的引号、括号、省略号、破折号；没有是空串。 */
export const lastWrittenChar = (text) => [...text.replace(CLOSING, '')].at(-1) ?? '';
/** 一截文字的第一个字，隔着开头的引号、括号、省略号、破折号；没有是空串。 */
export const firstWrittenChar = (text) => [...text.replace(OPENING, '')][0] ?? '';

/** 结尾（隔着收尾的引号、括号、省略号、破折号）是汉字、假名或它们的全角标点。 */
export const endsWrittenWithoutSpaces = (text) => WRITTEN_WITHOUT_SPACES.test(lastWrittenChar(text));

/** 两截接起来的地方本来不空格（规则见文件头）。 */
export const writtenWithoutSpaceBetween = (before, after) => endsWrittenWithoutSpaces(before) || WRITTEN_WITHOUT_SPACES.test(firstWrittenChar(after));

/** 两截接起来（规则见文件头）。 */
export function joinWritten(before, after) {
  if (before === '' || /\s$/u.test(before)) return `${before}${after}`;
  return `${before}${writtenWithoutSpaceBetween(before, after) ? '' : ' '}${after}`;
}
