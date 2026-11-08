// SPDX-License-Identifier: Apache-2.0
//
// 两截文字接起来，中间放不放空格：中文、日文的字之间本来不空格；英文、韩文这类词和词之间写空格。规则和字符类只写在这里，用它的：
// 基础部分做包的句子合段（lib/make-pack-sentences.mjs，句子的文字接成段的文字）、提示标注推逐字文本（lib/make-pack-input.mjs，去掉提示的地方），
// 配音把几句、几段接成一个请求（lib/dub.mjs 的 joinSpoken，lib/pause-in-request.mjs 的停顿写法和两段之间放的字），提示和正文之间空不空格（lib/opening-cue.mjs 的 cueThenText、
// lib/dub.mjs 的 cueAfter，用的是下面的 SPACED_WORD、LATIN_CLOSING，cueAfter 还用 lastWrittenChar）；
// 协议核心的预览卡片去掉卡片那一句的台本标记（spoken-words.mjs，去掉标记的地方）。卡片要用，所以放在核心层。
//
//   writtenWithoutSpaceBetween(before, after)  接的地方本来不空格：前一截的结尾（隔着收尾的引号、括号、省略号、破折号，CLOSING）或者后一截的开头
//                                              （隔着开头的这些，OPENING）是汉字、假名或它们的全角标点（WRITTEN_WITHOUT_SPACES）。谚文不算：韩文和英文一样加一个空格。
//                                              例：「用的是iPhone」「好的,」后面接中文、「OK.」后面接一句中文都不加；「“走吧。”」的结尾隔着引号是句号，不加；
//                                              「안녕하세요」后面接「반갑습니다」加一个。
//   joinWritten(before, after)                 两截接起来：前一截是空的，或者已经以空白结尾，直接接；不然照上一条，本来不空格的直接接，别的中间加一个空格。
//   endsWrittenWithoutSpaces(text)             结尾（隔着收尾的引号、括号、省略号、破折号）是汉字、假名或它们的全角标点：后面接的写法用中文的那一种（lib/pause-in-request.mjs）。
//
//   spaceAfterCue(before, after, hadSpace, edges)  去掉一处提示（标记）以后前后两截之间留不留一个空格，规则写在它上面。做包从提示标注推逐字文本（lib/make-pack-input.mjs）、
//                                              预览卡片去掉台本标记（spoken-words.mjs）用同一条。
//
// spaceAfterCue 另有几条细的，用到的字符类也在这里：
//   HAN_OR_KANA             汉字、假名（含长音符「ー」，和 々〇〆 这几个当字用的符号）
//   FULL_WIDTH_PUNCTUATION  全角标点（。、，！？「」（）……，含半角的「｡｢｣､･」和「・」）；全角的字母、数字不算，々〇〆 也不算（它们是 HAN_OR_KANA）
//   SPACED_WORD             词和词之间写空格的字：拉丁、希腊、西里尔字母，韩文，数字
//   LATIN_CLOSING           英文的收尾标点（. , ! ? ; : ) ] }）：挨着它的前面不空格
//   opensAtEnd(before, touchesCut)  前一截结尾是开头的括号、引号（西文的 ¿ ¡ 也算）：挨着它的后面不空格。括号看字（Ps），引号看挨着的字，还要数前面同一种引号，
//                           单引号紧挨着去掉的地方另看（touchesCut），规则写在 spaceAfterCue 上面「开头、收尾」
//   closesAtStart(after, before, touchesCut, endsLine)  后一截开头是收尾的括号、引号：挨着它的前面不空格。括号看字（Pe），引号看挨着的字，还要数 before 里同一种引号，同上
//
// 两截的接缝挨着尖括号标签的（「<whisper>快走！</whisper>」接「<whisper>他们来了。</whisper>」），隔着标签看里面的字（TRAILING_TAGS；音素标记不隔着看）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { PLAIN_TAG_PATTERN } from './script-markup.mjs';

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
/**
 * 一截两头的尖括号标签（tools/markup.mjs「尖括号标签」：<whisper>、</whisper>、<|speaker:0|>，音素标记不算）：不念，看接缝两边的字时隔着它们看
 * （「<whisper>快走！</whisper>」的结尾是感叹号）。音素标记代替一个词，不隔着它看。
 */
export const TRAILING_TAGS = new RegExp(`(?:${PLAIN_TAG_PATTERN})+$`, 'u');
const LEADING_TAGS = new RegExp(`^(?:${PLAIN_TAG_PATTERN})+`, 'u');

/** 英文的收尾标点：前面紧挨着一个词写，不空格。 */
export const LATIN_CLOSING = /^[.,!?;:)\]}]$/u;
/**
 * 引号：Unicode 的 Pi、Pf（“ ” ‘ ’ « » ‹ ›）和英文的直引号（" '）。是开头的还是收尾的，看它挨着什么，一般不看它是哪一个字（spaceAfterCue 上面「开头、收尾」）：
 * 德文写 „…“、丹麦文写 »…«、瑞典文写 ”…”，和英文的方向不一样；’ 又常是撇号（’em、’92）。„ ‚ 只做开头用，Unicode 归在 Ps，算开头的括号。
 */
const QUOTE = /^[\p{Pi}\p{Pf}"']$/u;
const INITIAL_QUOTE = /^\p{Pi}$/u;
const FINAL_QUOTE = /^\p{Pf}$/u;
const STRAIGHT_QUOTE = /^["']$/u;
/** 开头的括号（Unicode 的 Ps：( [ { （ 【 「 『 《，和 „ ‚）、收尾的括号（Pe：) ] } ） 】 」 』 》）：看字就知道是哪一头。 */
const OPENING_BRACKET = /^\p{Ps}$/u;
const CLOSING_BRACKET = /^\p{Pe}$/u;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
/** 汉字、假名、谚文：中文、日文、韩文的引号照字的方向用（“ 开头，” 收尾），挨着它们的弯引号看字。 */
const CJK_LETTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー〆]$/u;
const SPACE = /^\s$/u;
/** 中文、日文里引号前面的句中标点：后面的直引号是开头的（「他说："」）。 */
const LEAD_IN = /^[：，、；]$/u;
/** 一串收尾的标点（. , ! ? ; : … 破折号、连字符，收尾的括号、引号），后面是空白或结尾：引号后面紧跟着它的，引号是收尾的（「",」「".」「"),」「"...」）。 */
const TRAILING_RUN = /^[.,!?;:…—–\-"'\p{Pe}\p{Pf}]+(?:\s|$)/u;
/** 英文的句中、收句标点、省略号、破折号：引号前面是它的，引号是收尾的（「"Hi!"」「„Gut!“」「"Wait—"」）。 */
const SENTENCE_MARK = /^[.,!?;:…—–-]$/u;
/** 西文开头的 ¿ ¡：照开头的括号算，后面紧挨着写字（「¿De verdad?」「¡Cuidado!」）。 */
const INVERTED_MARK = /^[¿¡]$/u;
/** 单引号（直的 '，弯的 ‘ ’ ‛）：和撇号（twins'、'em、'92、twins’）写成同一个字，前面的撇号会被数进去；紧挨着去掉的地方时另看（spaceAfterCue 上面「开头、收尾」）。 */
const SINGLE_QUOTE = /^['‘’‛]$/u;
/** 开头的符号里面、收尾的符号里面挨着的空白和标点：作者在引号、括号里面写了空格的，隔着它们看里面那个字（「« … Bon »」「« Bonjour ! »」）。 */
const INSIDE_START = /^[\s"'“‘«(\[{…—–.\-¿¡]+/u;
const INSIDE_END = /[\s"'”’»)\]}…—–.,!?;:\-]+$/u;
/** 开头的引号、括号里面第一个字（隔着开头的标签、空白、省略号、破折号、¿ ¡）；没有是空串。 */
const firstInside = (after) => [...after.replace(LEADING_TAGS, '').replace(INSIDE_START, '')][0] ?? '';
/** 收尾的引号、括号里面最后一个字（隔着结尾的标签、空白、收句标点、省略号、破折号）；没有是空串。 */
const lastInside = (before) => [...before.replace(TRAILING_TAGS, '').replace(INSIDE_END, '')].at(-1) ?? '';
/** 结尾的一串省略号、破折号（…、两个以上的点，— –、两个以上的 -）。 */
const ELLIPSIS_OR_DASH_RUN = /(?:[…—–]|\.{2,}|-{2,})+$/u;
/**
 * 前一截结尾是一串省略号、破折号，这一串前面没有字：是一句的开头，或者是开头的引号、括号（「……」「“……」「他说：“……」）。
 * 这时空不空格只看后一截（spaceAfterCue）。
 */
function onlyRunAtStart(before) {
  const text = before.replace(TRAILING_TAGS, '');
  if (!ELLIPSIS_OR_DASH_RUN.test(text)) return false;
  const rest = text.replace(ELLIPSIS_OR_DASH_RUN, '').trimEnd();
  return rest === '' || opensAtEnd(rest);
}

/**
 * chars[i] 是两个字母、数字中间的撇号（don't、rock'n'roll、don’t 里的 ' ’）：不是引号。两边是汉字、假名、谚文的不算撇号
 * （「“自由”只是」里的 ” 是引号），别的引号字也不算。
 */
const isApostrophe = (chars, i) => (chars[i] === "'" || chars[i] === '’')
  && [chars[i - 1], chars[i + 1]].every((ch) => WORD_CHAR.test(ch ?? '') && !CJK_LETTER.test(ch));

/**
 * 同一种引号：弯的双引号（“ ” „ ‟）、弯的单引号（‘ ’ ‚ ‛）、« »、‹ › 各是一种，直的 " 和 ' 各是一种，别的引号各算各的。
 * 开头、收尾写同一个字的（"…"、”…”）和方向反过来的（»…«）也都在一种里，所以数前面有几个就知道它是第几个。
 */
const QUOTE_KIND = new Map([['“”„‟', '“'], ['‘’‚‛', '‘'], ['«»', '«'], ['‹›', '‹']].flatMap(([chars, kind]) => [...chars].map((ch) => [ch, kind])));
const kindOf = (ch) => QUOTE_KIND.get(ch) ?? ch;

/** 接在 text 后面的引号 quote 是收尾的：text 里同一种引号（两个字母中间的撇号不算）有单数个；双数个（含没有）是开头的。 */
function closesByCount(text, quote) {
  const chars = [...text];
  const kind = kindOf(quote);
  return chars.filter((ch, i) => kindOf(ch) === kind && !isApostrophe(chars, i)).length % 2 === 1;
}

/**
 * 一截的最后一个字是开头的括号、引号，或者西文的 ¿ ¡（规则见 spaceAfterCue 上面「开头、收尾」）。隔着结尾的标签看。
 * touchesCut：这一截后面紧挨着去掉的地方（中间没有空白）。
 * @param {string} before
 * @param {boolean} [touchesCut]
 * @returns {boolean}
 */
export function opensAtEnd(before, touchesCut = false) {
  const chars = [...before.replace(TRAILING_TAGS, '')];
  const ch = chars.at(-1) ?? '';
  if (OPENING_BRACKET.test(ch) || INVERTED_MARK.test(ch)) return true;
  if (!QUOTE.test(ch)) return false;
  const previous = chars.at(-2);
  if (touchesCut && SINGLE_QUOTE.test(ch) && (previous === undefined || SPACE.test(previous) || OPENING_BRACKET.test(previous))) return true;
  const earlier = chars.slice(0, -1).join('');
  return looksOpening(previous, ch, earlier) && !closesByCount(earlier, ch);
}

/** 引号 ch 前面紧挨着 previous（没有是 undefined），单看这个像不像开头的（spaceAfterCue 上面「开头、收尾」）；还要数，见 opensAtEnd。 */
function looksOpening(previous, ch, earlier) {
  if (previous === undefined || SPACE.test(previous)) return true;
  if (CJK_LETTER.test(previous)) return !FINAL_QUOTE.test(ch);
  if (WORD_CHAR.test(previous)) return false;
  if (OPENING_BRACKET.test(previous) || (QUOTE.test(previous) && opensAtEnd(earlier))) return true;
  if (SENTENCE_MARK.test(previous)) return false;
  return INITIAL_QUOTE.test(ch) || (STRAIGHT_QUOTE.test(ch) && LEAD_IN.test(previous));
}

/**
 * 一截的第一个字是收尾的括号、引号（规则见 spaceAfterCue 上面「开头、收尾」）。隔着开头的标签看。
 * before 是接在它前面的字：数它里面同一种引号。touchesCut：这一截前面紧挨着去掉的地方（中间没有空白）；
 * endsLine：这一截后面就是一句的结尾（不给当作后面还紧挨着去掉的地方：只剩一个引号时，看不到它后面是什么）。
 * @param {string} after
 * @param {string} [before]
 * @param {boolean} [touchesCut]
 * @param {boolean} [endsLine]
 * @returns {boolean}
 */
export function closesAtStart(after, before = '', touchesCut = false, endsLine = false) {
  const chars = [...after.replace(LEADING_TAGS, '')];
  const ch = chars[0] ?? '';
  if (CLOSING_BRACKET.test(ch)) return true;
  if (!QUOTE.test(ch)) return false;
  const rest = chars.slice(1).join('').replace(LEADING_TAGS, '');
  if (touchesCut && SINGLE_QUOTE.test(ch) && (rest === '' ? endsLine : SPACE.test([...rest][0]) || TRAILING_RUN.test(rest))) return true;
  return looksClosing(rest, ch) && closesByCount(before, ch);
}

/** 引号 ch 后面紧接着 rest，单看这个像不像收尾的（spaceAfterCue 上面「开头、收尾」）；还要数，见 closesAtStart。 */
function looksClosing(rest, ch) {
  const next = [...rest][0];
  if (next === undefined || SPACE.test(next)) return true;
  if (CJK_LETTER.test(next)) return !INITIAL_QUOTE.test(ch);
  if (WORD_CHAR.test(next)) return false;
  if (TRAILING_RUN.test(rest)) return true;
  if (FULL_WIDTH_PUNCTUATION.test(next)) return !INITIAL_QUOTE.test(ch);
  return false;
}

/** 一截文字的最后一个字，隔着收尾的标签、引号、括号、省略号、破折号；没有是空串。 */
export const lastWrittenChar = (text) => [...text.replace(TRAILING_TAGS, '').replace(CLOSING, '')].at(-1) ?? '';
/** 一截文字的第一个字，隔着开头的标签、引号、括号、省略号、破折号；没有是空串。 */
export const firstWrittenChar = (text) => [...text.replace(LEADING_TAGS, '').replace(OPENING, '')][0] ?? '';

/** 结尾（隔着收尾的引号、括号、省略号、破折号）是汉字、假名或它们的全角标点。 */
export const endsWrittenWithoutSpaces = (text) => WRITTEN_WITHOUT_SPACES.test(lastWrittenChar(text));

/** 两截接起来的地方本来不空格（规则见文件头）。 */
export const writtenWithoutSpaceBetween = (before, after) => endsWrittenWithoutSpaces(before) || WRITTEN_WITHOUT_SPACES.test(firstWrittenChar(after));

/** 两截接起来（规则见文件头）。 */
export function joinWritten(before, after) {
  if (before === '' || /\s$/u.test(before)) return `${before}${after}`;
  return `${before}${writtenWithoutSpaceBetween(before, after) ? '' : ' '}${after}`;
}

/**
 * 去掉一处提示（标记）以后，前后两截之间留不留一个空格。hadSpace 是提示两边原来有没有空白；edges 说那空白是不是紧挨着前一截的结尾（before）、
 * 后一截的开头（after），只用在下面「作者在引号、括号里面写了空格」和「单引号一边紧挨着去掉的地方」两条，不给的话这两条都不用；
 * edges.end 说后一截后面就是一句的结尾（不给当作不是）。
 * 看的是前一截的结尾、后一截的开头那个字（隔着收尾、开头的引号、括号、省略号、破折号），按这个次序：
 *   有一边是全角标点（挨着的那个字，或者隔着引号看到的），或者两边都是汉字、假名：不留（々〇〆 照汉字算，不是标点：「々 [sigh] hello」是「々 hello」）；
 *   前一截结尾是一串省略号、破折号，这一串前面没有字（一句的开头，或者开头的引号、括号：「……」「“……」「他说：“——」），后一截是汉字、假名：不留
 *   （「……[哽咽] 对不起。」是「……对不起。」；前面有字的照上一条看两边：「我……[哽咽] 我不想走。」是「我……我不想走。」）；
 *   后一截开头是英文的收尾标点（. , ! ? ; : ) ] }）：不留（「That's enough [sigh].」是「That's enough.」，「Wait [laughs]! Really?」是「Wait! Really?」）；
 *   前一截结尾是开头的括号、引号，或者后一截开头是收尾的括号、引号（opensAtEnd、closesAtStart，见下面「开头、收尾」）：不留
 *   （「He said, "[softly] come here."」是「He said, "come here."」，「"Go away [sighs]" she said.」是「"Go away" she said.」，「“[叹气] 不要”」是「“不要”」）。
 *     例外，作者在引号、括号里面写了空格（法文的「« Bonjour »」）：原来的空白紧挨着这个开头的符号（或者紧挨着这个收尾的符号），
 *     符号里面那个字（隔着空白、省略号、破折号、收句标点、¿ ¡ 看）又是拉丁、希腊、西里尔字母、数字或韩文，照作者的留一个
 *     （「« [sigh] Bonjour »」是「« Bonjour »」，「« Bonjour [sigh] »」也是，「« Bonjour ! [rire] »」是「« Bonjour ! »」，「« [soupir] … Bon »」是「« … Bon »」；
 *     「«[sigh] Bonjour»」是「«Bonjour»」；里面是汉字的不留：「“ [叹气] 不要”」是「“不要”」，「“好! [笑]”」是「“好!”」）。收尾的 ) ] } 照上一条，不留；
 *   原来有空白：留一个（「Hello there [laughs] 你好」是「Hello there 你好」，「OK [sigh] 好的」是「OK 好的」）；
 *   两边都是拉丁、希腊、西里尔字母、数字（或韩文这类词间写空格的字），又紧挨着：也留一个（「I told you[sigh]already」是「I told you already」）；
 *   剩下的不留（提示挨着英文标点：「already[sigh]. Now」是「already. Now」）。
 * 开头、收尾：括号看字（Unicode 的 Ps 开头、Pe 收尾；„ ‚ 归在 Ps）；西文的 ¿ ¡ 照开头的括号算（「¿[susurra] De verdad?」是「¿De verdad?」）。引号（Pi、Pf 和英文的直引号）看它挨着什么，隔着标签看：德文 „Hallo“、丹麦文 »Hallo«、
 * 瑞典文 ”Hej” 的方向和英文不一样，’ 又是撇号，所以一般不看是哪一个字。
 *   两样都要对上：挨着的字像开头（收尾）的（下面几条），还要数前面的字里同一种引号有几个（弯的双引号 “ ” „ ‟、弯的单引号 ‘ ’ ‚ ‛、« »、‹ ›、
 *     直的 "、直的 ' 各是一种；两个拉丁这类字母中间的撇号 ' ’ 不算）：双数个（含没有）才是开头的，单数个才是收尾的。对不上的两头都不算，空格照作者的。
 *     一边是空白或者一句的头尾，单看那一边分不出（法文在引号里面也写空格：「« Oui »」），就只看数。套着别的一种引号不碍事（「« Il a dit “ oui ” »」里 » 只数 «）；
 *     「„Sie sagte ‚Nein!‘“ [seufzt] — und ging.」里的 “ 跟在收尾的 ‘ 后面，像开头的，可前面有一个 „，是收尾的。
 *   单引号（' ‘ ’ ‛）一边紧挨着去掉的地方（edges 说中间没有空白），另一边是空白、一句的头尾（或者开头的括号；收尾那边也可以是一串收尾的标点再空白），
 *     它归去掉的那一边，不数：在前一截结尾的是开头的，在后一截开头的是收尾的。撇号（twins'、'em、'92）和单引号是同一个字，数会数错
 *     （「The twins' mum shouted, '[angry] Get inside!'」是「…, 'Get inside!'」，「The Joneses' dog barked, 'Woof [laughs]' and ran.」是「…, 'Woof' and ran.」）。
 *     两边都紧挨着去掉的地方（「[sigh]'[softly]」），或者单引号是后一截唯一的字、又不知道后面是一句的结尾的，照下面数。« » ‹ › 和双引号照下面数。
 *   挨着汉字、假名、谚文的弯引号看字（Pi：“ ‘ 像开头，Pf：” ’ 像收尾；「他说“」「”她说」「”이라고」）：这几种文字照字的方向写引号。直引号两样都像，只看数。
 *   前一截结尾的引号像开头的：它是这一截的第一个字，或者前面是空白；前面是汉字、假名、谚文，见上一条；前面是开头的括号、开头的引号。
 *     前面是别的字母、数字（„Hallo“、dogs'、dogs’），或者英文的句中、收句标点、省略号、破折号（"Hi!"、„Gut!“、"Wait—"）的，不像。
 *     前面是别的（全角标点、收尾的引号括号）的，弯的开头引号（Pi：“ ‘ «）像（「他说：“」「”“」），直引号前面是「：，、；」才像（「他说："」）。
 *   后一截开头的引号像收尾的：后面是空白、结尾，或者只有它（夹在两处提示中间，看不到后面）；后面是汉字、假名、谚文，见上面；
 *     后面是一串收尾的标点（. , ! ? ; : … 破折号、连字符，收尾的括号、引号）再后面是空白、结尾（「",」「".」「"...」）；后面是全角标点的，
 *     除了弯的开头引号都像（「”，」）。后面是别的字母、数字（’em、’92、»Hallo«、”Hej”），或者别的（"...fine."、"¿Qué?"、"—no."），不像。
 *   例：「He said [sigh] "[softly] come here."」是「He said "come here."」，「"Go away [sighs]"[sobs] she said.」是「"Go away" she said.」；
 *     「Il a dit : [soupir] « Bonjour ! »」是「Il a dit : « Bonjour ! »」（« 前面没有引号，是开头的；提示在它外面，作者的空格留着），
 *     「Il a dit « Bonjour »[soupir].」是「Il a dit « Bonjour ».」，「« Oui » [soupir] « Non »」是「« Oui » « Non »」。
 * @param {string} before 前一截（已经去掉了结尾的空白）
 * @param {string} after 后一截（已经去掉了开头的空白）
 * @param {boolean} hadSpace
 * @param {{ before?: boolean, after?: boolean, end?: boolean }} [edges]
 * @returns {boolean}
 */
export function spaceAfterCue(before, after, hadSpace, edges = {}) {
  const touching = [[...before].at(-1) ?? '', [...after][0] ?? ''];
  const last = lastWrittenChar(before);
  const first = firstWrittenChar(after);
  if ([...touching, last, first].some((ch) => FULL_WIDTH_PUNCTUATION.test(ch))) return false;
  if (HAN_OR_KANA.test(last) && HAN_OR_KANA.test(first)) return false;
  if (HAN_OR_KANA.test(first) && onlyRunAtStart(before)) return false;
  if (LATIN_CLOSING.test(touching[1])) return false;
  if (opensAtEnd(before, edges.before === false)) return edges.before === true && SPACED_WORD.test(firstInside(after));
  if (closesAtStart(after, before, edges.after === false, edges.end === true)) return edges.after === true && SPACED_WORD.test(lastInside(before));
  if (hadSpace) return true;
  return SPACED_WORD.test(last) && SPACED_WORD.test(first);
}
