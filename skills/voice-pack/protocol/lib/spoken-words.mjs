// SPDX-License-Identifier: Apache-2.0
//
// 念出来的字：一句台词去掉台本标记以后剩下的字，只给人看（预览卡片上试听句旁边写的就是它，preview-card.mjs）。
// 清单里存的、交给配音的，还是原样（带标记）：这里只管显示，不改数据。
//
//   spokenWords(text)   一句台词 → 去掉标记的字（字符串）；什么字都不剩是空串
//
// 认哪几种标记：配音的台本里能写的那几种（基础部分的 references/markup.md，和它指到的模型说明 models/ 里「提示」一节）。
// 写法的说明在基础部分的 tools/markup.mjs 文件头「提示」「尖括号标签」和 lib/line-hints.mjs 文件头「舞台提示的写法」，正则在 script-markup.mjs，这里引它，不另写。
//   方括号     [说戏]、[一下子的声音]、[pause 1s]、[voice:名字]：不论在哪，整个去掉。套着的也一样（[[笑] 得意]）：去掉一遍以后又露出提示、标签的，再去一遍。
//   成对的标签  <whisper>…</whisper>、<emphasis>…</emphasis>、语言标签 <french>…</french>：去掉 <名字>、</名字>，留中间的字。
//             只写了一头的，那一头照样去掉。`1 < 2`、`<b c>` 不是标签，原样。
//   音素标签   <|phoneme_start|>音素<|phoneme_end|>：去掉两头，留里面的音素（试听句照规矩不写音素，写了，卡片上至少不露标记）。
//             几个音素标签紧挨着（中文一个标签一个音节），音素之间空一格：gong1 cheng2 shi1。里面是空的，整个去掉。
//   单个的标签  <|名字|>、<|名字:数字|>：去掉。
//   说话人标签  <|speaker:数字|>：去掉；那里算有空白（换了一轮），拉丁字母这类写空格的文字照样隔开。
//   舞台说明   （…）、(…)（全角半角可以混着写）、【…】、*…*，括号里 1 到 30 个字：整个去掉（配音也不念它们：换成提示，或者拿掉）。
//             哪些算，和配音（lib/line-hints.mjs 的 cuesInPlace）一样只认一次：在去掉了加粗星号的字上认，括号里写的提示、标签照算字数
//             （「(<whisper>I miss you, I really do.</whisper>)」里有 43 个字，不是舞台说明，配音念它，卡片上写「(I miss you, I really do.)」）；
//             去掉里面的标记以后变短了，也不再当舞台说明。更长的、空的、只有空白的（「（ ）」，配音也原样留着）、只有开括号的，是台词的一部分，原样。
//             *…* 的星号和字之间不能有空白（3 * 4 * 5、* 笑 * 原样）：同配音，正则是 script-markup.mjs 的 STAR_DIRECTION_PATTERN。
//             和配音不一样的一处：配音先在 [pause …]、[voice:…] 那里切开再认，这里在整句上认。一对括号或星号跨过它们的
//             （「(ok [pause 1s] fine)」「a*b[pause 1s]* 笑 *好」里的「*b[pause 1s]*」），配音不当舞台说明、这里当，
//             后面落了单的星号也就不再原样（卡片上是「a 笑 *好」，配音念「a*b」「* 笑 *好」）。这种写法少见，没对齐。
//             **…**、***…***（加粗）不是舞台说明：先去掉星号，里面的字留着，接缝不另外收拾（同配音：「un**believ**able」是「unbelievable」）。
// 去掉以后收拾：只在去掉了东西的地方动，作者自己写的空格和标点不动。
//   空格      去掉的地方前后两截之间留不留一个空格，和做包从提示标注推逐字文本是同一条规矩：word-spacing.mjs 的 spaceAfterCue（规则写在它上面）。
//   两个标点   去掉以后挨在一起的两个标点只留一个。一个标点是一串省略号（…、两个以上的点）、一串破折号（— 或 –，两个以上的 -），
//             或者一个句中的（，、；：,;:）、收句的（。！？.!?）标点。
//             句中的挨着别的（收句的、省略号、破折号），留别的；别的情形留前一个（「我……[叹气]……算了」是「我……算了」，「好。[笑]，你来了」是「好。你来了」，
//             「Wait -- [sighs] -- fine」是「Wait -- fine」）。
//   开头      一句开头去掉了标记，留在开头的句中、收句的标点也去掉（「[sighs], fine.」是「fine.」）；省略号、破折号留着（「[笑]……好吧」是「……好吧」）。
//             开头的引号、括号（西文的 ¿ ¡ 也算）后面去掉了标记，也一样（「“[叹气]，算了。”」是「“算了。”」）。开头、收尾的引号怎么认，同 spaceAfterCue。
//   空的一对   去掉以后一对引号、括号中间什么都不剩，这一对也去掉（「"[sighs]" he said」是「he said」，「[[笑]] 好」是「好」）。
//             一对：两个都是引号（哪两个都行），或者配成对的括号；前一个要是开头的、后一个要是收尾的，引号怎么认同 spaceAfterCue
//             （一边是空白的数前面同一种引号：「« Oui. » (rires) « Non. »」中间的 » « 一个收尾一个开头，不是一对）。
//             套在别的引号里面的一对照样去掉（「“他说‘[笑]’好”」是「“他说好”」）。
//   两头      去掉两头的空白。去掉了标记、剩下的一个字都没有（没有字母、数字，只剩标点和空白），是空串（卡片上就不写这一行）；
//             没有标记的一句不管这一条，照原样。
// 同样的输入同样的输出：不看时间、随机数、运行环境。
//
// 参数不是字符串抛 TypeError。模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import {
  BAR_TAG_PATTERN, CUE_PATTERN, EMPHASIS_PATTERN, LENTICULAR_DIRECTION_PATTERN, PAIRED_TAG_PATTERN, PAREN_DIRECTION_PATTERN, PHONEME_MARKER_PATTERN, STAR_DIRECTION_PATTERN, phonemeOf,
} from './script-markup.mjs';
import { closesAtStart, opensAtEnd, spaceAfterCue } from './word-spacing.mjs';

/** 强调：加粗的去掉星号、留字，一颗星号的原样留给认舞台说明那一步（同配音：lib/line-hints.mjs 的 withoutEmphasis，选法「拿掉」）。 */
const EMPHASIS_RE = new RegExp(EMPHASIS_PATTERN, 'gu');
const withoutBold = (text) => text.replace(EMPHASIS_RE, (whole, stars, bold) => (stars === undefined ? whole : bold));
/** 舞台说明：（…）(…)、【…】、*…*（星号和字之间没有空白）。三个捕获组依次是括号里的字。 */
const DIRECTION_RE = new RegExp([PAREN_DIRECTION_PATTERN, LENTICULAR_DIRECTION_PATTERN, STAR_DIRECTION_PATTERN].join('|'), 'gu');
/** 一处标记：音素标记（命名的组 phoneme）、竖线写的标签（bar，音素标记的两头也长这样，所以音素标记排在前面先认）、成对标签的一头、方括号。 */
const MARKUP_RE = new RegExp([`(?<phoneme>${PHONEME_MARKER_PATTERN})`, `(?<bar>${BAR_TAG_PATTERN})`, PAIRED_TAG_PATTERN, CUE_PATTERN].join('|'), 'gu');
/** 说话人标签：换了一轮，那里算有空白。 */
const isTurn = (tag) => tag.startsWith('<|speaker:');

/** 一个标点：一串省略号（…、两个以上的点）、一串破折号（— 或 –，两个以上的 -），或者一个句中的（，、；：,;:）、收句的（。！？.!?）标点。 */
const MARK = '(?:…+|\\.{2,}|[—–]+|-{2,}|[，、；：,;:。！？.!?])';
const TRAILING_MARK = new RegExp(`${MARK}$`, 'u');
const LEADING_MARK = new RegExp(`^${MARK}`, 'u');
/** 句中的标点：和别的标点挨在一起时让给别的。 */
const MID_STOP = /^[，、；：,;:]$/u;
/** 开头的句中、收句的标点（一串省略号不算）：前面的标记去掉了，它们留在一句的开头、开头的引号括号后面不成话。 */
const LEADING_STOPS = /^(?:[，、；：,;:。！？!?]|\.(?!\.))+/u;
/** 去掉了标记、留在一句开头（或者开头的引号、括号后面）的字：开头的句中、收句的标点去掉。 */
const atStart = (text) => text.replace(LEADING_STOPS, '').trimStart();
/** 有字：字母（各种文字）、数字。只剩标点、空白的不算有字。 */
const HAS_WORDS = /[\p{L}\p{N}]/u;
/** 一对：两个都是引号（开头、收尾看位置，所以哪两个都行；„ ‚ 也是引号），或者配成对的括号。 */
const QUOTE = /^[\p{Pi}\p{Pf}"'„‚]$/u;
const BRACKET_PAIRS = new Set(['()', '[]', '{}', '（）', '【】', '「」', '『』', '《》', '〈〉', '［］', '｛｝', '〔〕', '〖〗']);
const isPair = (open, close) => (QUOTE.test(open) && QUOTE.test(close)) || BRACKET_PAIRS.has(open + close);

/**
 * 去掉标记的地方接起来：left 是已经写好的字（去掉了结尾的空白），right 是接上来的字（去掉了开头的空白），
 * space 是中间原来的空白：{ any: 有没有，before: 紧挨着 left 的结尾，after: 紧挨着 right 的开头 }，end：right 后面就是一句的结尾。
 */
function joinAtCut(left, right, space) {
  if (left === '') return atStart(right);
  let [before, after, any] = [left, right, space.any];
  if (opensAtEnd(before, !space.before)) {
    after = atStart(after); // 开头的引号、括号后面剩下的句中、收句标点去掉
    if (after === '') return before;
    const open = [...before].at(-1);
    const close = [...after][0];
    if (closesAtStart(after, before, !space.after, space.end) && isPair(open, close)) {
      // 去掉以后空了的一对引号、括号：整个去掉，两边再接一次
      const [inner, outer] = [before.slice(0, -open.length), after.slice(close.length)];
      const [trimmedBefore, trimmedAfter] = [inner.trimEnd(), outer.trimStart()];
      const edges = { before: trimmedBefore !== inner, after: trimmedAfter !== outer };
      if (trimmedAfter === '') return trimmedBefore;
      return joinAtCut(trimmedBefore, trimmedAfter, { any: any || edges.before || edges.after, ...edges, end: space.end });
    }
  }
  const lastMark = before.match(TRAILING_MARK)?.[0];
  const firstMark = after.match(LEADING_MARK)?.[0];
  if (lastMark !== undefined && firstMark !== undefined) {
    // 两个标点挨在一起，只留一个：句中的挨着别的，留别的；别的情形留前一个
    if (MID_STOP.test(lastMark) && !MID_STOP.test(firstMark)) before = before.slice(0, -lastMark.length);
    else after = after.slice(firstMark.length);
    const [trimmedBefore, trimmedAfter] = [before.trimEnd(), after.trimStart()];
    if (trimmedBefore !== before || trimmedAfter !== after) any = true;
    [before, after] = [trimmedBefore, trimmedAfter];
    if (before === '') return atStart(after);
    if (after === '') return before;
  }
  return spaceAfterCue(before, after, any, space) ? `${before} ${after}` : before + after;
}

/**
 * 一遍要去掉的标记，按位置排好：[{ index, length, groups }]。withDirections 为真时先认舞台说明（括号里只有空白的不算），
 * 舞台说明里面的提示、标签跟着它整个去掉；舞台说明以外的地方再认提示、标签、音素标记。
 */
function tokensOf(text, withDirections) {
  const directions = withDirections ? [...text.matchAll(DIRECTION_RE)].filter((m) => (m[1] ?? m[2] ?? m[3]).trim() !== '') : [];
  const tokens = [];
  let from = 0;
  for (const { index, length } of [...directions.map((m) => ({ index: m.index, length: m[0].length })), { index: text.length, length: 0 }]) {
    for (const m of text.slice(from, index).matchAll(MARKUP_RE)) tokens.push({ index: from + m.index, length: m[0].length, groups: m.groups });
    if (length > 0) tokens.push({ index, length, groups: {} });
    from = index + length;
  }
  return tokens;
}

/** 切成几块：{ text } 是留下的字，{ cut: true, space } 是去掉标记的地方（space：这里算有空白）。 */
function piecesOf(text, withDirections) {
  const pieces = [];
  let last = 0;
  let phonemeEnd = -1;
  for (const { index, length, groups } of tokensOf(text, withDirections)) {
    pieces.push({ text: text.slice(last, index) });
    const phoneme = groups.phoneme === undefined ? '' : phonemeOf(groups.phoneme).trim();
    if (phoneme !== '') {
      // 音素留下；紧挨着上一个音素标签的，两个音素之间算有空白（一个标签一个音节、一个词）
      pieces.push({ cut: true, space: phonemeEnd === index }, { text: phoneme }, { cut: true, space: false });
      phonemeEnd = index + length;
    } else {
      pieces.push({ cut: true, space: groups.bar !== undefined && isTurn(groups.bar) }); // 换了说话人的地方算有空白
    }
    last = index + length;
  }
  pieces.push({ text: text.slice(last) });
  return pieces;
}

/** 去掉一遍标记：{ text, removed }，removed 是这一遍去掉了东西。withDirections：这一遍也认舞台说明（只有第一遍）。 */
function onePass(text, withDirections) {
  let out = '';
  let seam = false;
  let space = { any: false, before: false, after: false, end: false };
  let removed = false;
  const pieces = piecesOf(text, withDirections);
  for (const [i, piece] of pieces.entries()) {
    if (piece.cut) {
      removed = true;
      const trimmed = out.trimEnd();
      if (!seam && trimmed !== out) space.before = true;
      if (trimmed !== out || piece.space) space.any = true;
      out = trimmed;
      seam = true;
      continue;
    }
    if (!seam) { out += piece.text; continue; }
    const right = piece.text.trimStart();
    if (right !== piece.text) space.any = true;
    if (right === '') continue;
    space.after = right !== piece.text;
    space.end = i === pieces.length - 1;
    out = joinAtCut(out, right, space);
    seam = false;
    space = { any: false, before: false, after: false, end: false };
  }
  return { text: out.trim(), removed };
}

/**
 * 一句台词去掉台本标记，剩下念出来的字。
 * 先去掉加粗的星号，再去一遍：舞台说明（只在这一遍认）、提示、标签、音素标记。去掉以后又露出提示、标签的（方括号套着方括号：[[笑] 得意]），
 * 再去一遍提示、标签、音素标记，直到没有可去的。去掉了东西的一遍，字只会变短，所以一定停得下来。
 * @param {string} text 台词（原样，带标记）
 * @returns {string} 去掉标记的字；什么都不剩是空串
 * @throws {TypeError} text 不是字符串
 */
export function spokenWords(text) {
  if (typeof text !== 'string') throw new TypeError(`text of spokenWords must be a string, got ${typeof text}`);
  const unbolded = withoutBold(text);
  let pass = onePass(unbolded, true);
  const removed = unbolded !== text || pass.removed;
  while (pass.removed) pass = onePass(pass.text, false);
  return removed && !HAS_WORDS.test(pass.text) ? '' : pass.text;
}
