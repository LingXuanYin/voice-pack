// SPDX-License-Identifier: Apache-2.0
//
// 台本带的提示标注（纯计算，做包用）：素材只给了台本（scriptText，没给 text，台本念出来有字：lib/make-pack-input.mjs 的 scriptIsText），
// 台本里的提示就是这一段的提示标注。谁合成了这段，谁写文字也写提示标注（这是定下的）：台本就是这段配出来时照着念的说法，
// 所以不听音频，不调模型（lib/make-pack-annotation.mjs 把它当成素材给的）。停顿也是写台本的人写的：台本里的 [pause …] 在标注里写成 [pause]，不从录音量。
//
//   scriptAnnotationOf(script, { text, names })   台本 → { annotatedText, cues }，或者 null（这一段的标注就是不带提示的台本，lib/make-pack-input.mjs，见下「做不了」）
//     script 是台本原文（带标记）；text 是它念出来的字（protocol/lib/spoken-words.mjs 的 spokenWords，就是这一段的文字）；
//     names 是这个包认的名字（lib/reference-names.mjs 的 namesOfPack 的 recognized：素材的 name 和配音指引「名字」项的全名）。
//   cutScriptAnnotation(annotatedText, text, keptLength)   切过的段（lib/make-pack-take-audio.mjs）：文字切成前 keptLength 个字，
//     标注只留这些字前面的提示，返回切好的标注；留下的没有提示、或者去掉方括号对不上，是 null。
//
// 哪些方括号是提示（写法的正本是 tools/markup.mjs 的文件头：标记只有章节、声音、停顿三种，别的方括号都是提示）：
//   名字：一行开头（前面只有空白）的方括号，是名字对（里面有 |），或者 names 里的一个名字，不是提示，去掉（每一行都认，同 lib/opening-cue.mjs 的 nameAtHead）。
//   名字对在行中间也去掉：它只能是名字，不会是提示。行中间的名字（names 里的）不去：名字只在行首认，行中间的方括号是提示。
//   停顿 [pause]、[pause 1s] 留在它的位置，写成 [pause]（参考标注里停顿的写法，不带时长）；声音 [voice:…] 是标记，去掉（tools/markup.mjs 的 PAUSE_VOICE_PATTERN）；写法不对的（[pause1s]、[pause 1sec]）不是标记，是提示，留着。
//   语言标签 [language: …] 不是提示，去掉（它是跨语言台词的语言，lib/cross-language.mjs 写的那一种；听出来的标注里也不会有它）。
//   别的方括号都是提示，留在文字里它所在的位置。
// 怎么拼（和听出来的提示标注一样，lib/segment-annotation.mjs「拼」）：文字一个字都不改；每个提示插在它后面的第一个非空白字前面，
//   空白留在前一个字的后面。例：[Mira Lindqvist][calm] Good morning. [sad] I missed you. → [calm]Good morning. [sad]I missed you.
//   （去掉方括号以后一字不差地等于文字，这是 segment-annotation 的校验；台本里提示后面的空白不带过来，文字里的空白才是文字的。）
// 怎么找位置：每个提示先换成一个占位的字（私用区的字符，spokenWords 不认它、不当成字），别的标记照 spokenWords 去掉。
//   占位前面有几个非空白的字，提示就插在文字里第几个非空白的字前面。占位数、去掉占位以后的字，都得和台本对得上，对不上就做不了。
// 做不了（返回 null，这一段的标注就是不带提示的台本，不听）：
//   台本里没有提示和停顿（只剩名字、标记）。
//   一行开头没认出来的方括号（不是名字、名字对，也不是停顿、声音、语言标签），后面紧跟（中间只有空白）另一个方括号：[德拉科][smug]哟。、[Mira][Harry][calm]……
//     （dub 会在前面换上包的全名，留着就写了两次）。每一行都看（unrecognizedHeadBeforeBracket）。一个没认出来的方括号后面跟着字（[calm]Good morning.）还是提示，留着。
//   提示贴着的标点被 spokenWords 合并掉或者去掉了（[sighs], fine.；好。[笑]，你来了）；提示在舞台说明（（…）、(…)、【…】、*…*）里；嵌套的方括号（[[笑] 得意]）。
//   拼出来去掉方括号和文字对不上，或者超过 ANNOTATED_TEXT_MAX 个字符。
//   台本里有私用区的字符（占位用）。
// 切过的段：文字是 cut-at-sentence-end.mjs 的 keptScript 切留下的字，它是台本的前缀，标注只留文字前 keptLength 个字之前的提示；
//   切口后面的提示（包括开在切掉的那几句前面的）跟着切掉。提示紧跟在句末（。！？等）后面的，放在下一句第一个字的前面（和听出来的标注一样），
//   所以切在那一句后面时它跟着切掉。
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { spokenWords } from '../protocol/lib/spoken-words.mjs';
import { CUE_PATTERN, PAUSE_VOICE_PATTERN } from '../tools/markup.mjs';
import { ANNOTATED_TEXT_MAX } from './manifest-limits.mjs';
import { nameAtHead } from './opening-cue.mjs';
import { withoutBrackets } from './segment-annotation.mjs';

const CUE_EVERYWHERE = new RegExp(CUE_PATTERN, 'gu');
const CUE_AT = new RegExp(CUE_PATTERN, 'uy');
const HAS_CUE = new RegExp(CUE_PATTERN, 'u');
const PAUSE_OR_VOICE = new RegExp(`^(?:${PAUSE_VOICE_PATTERN})$`, 'iu');
/** 写台本的人写的停顿：[pause]、[pause 1s]（写法同 tools/markup.mjs 的 PAUSE_RE）。 */
const PAUSE_MARK = /^\[\s*pause(?:\s+\d+(?:\.\d+)?(?:\s*(?:ms|s))?)?\s*\]$/iu;
/** 语言标签 [language: zh]：跨语言台词的语言（lib/cross-language.mjs 写的那一种）。不是提示，是台本的标签：不进提示标注。 */
const LANGUAGE_TAG = /^\[language\s*:[^\]\n]*\]$/iu;
/** 占位用的私用区字符：一个提示一个，从 PLACEHOLDER_FIRST 起。台本里有这些字符的不做（见 scriptAnnotationOf）。 */
const PLACEHOLDER_FIRST = 0xe000;
const PLACEHOLDER_LAST = 0xf8ff;
const HAS_PLACEHOLDER_CHAR = /[\uE000-\uF8FF]/u;
const SPACE = /\s/u;

/** 一行开头（前面只有空白）的方括号是名字：名字对，或者 names 里的一个。 */
function isNameAtLineStart(script, at, names) {
  const lineBefore = script.slice(0, at).split('\n').pop();
  return /^\s*$/u.test(lineBefore) && nameAtHead(script.slice(at), names) !== null;
}

/**
 * 行首（前面只有空白）的方括号没认出来（不是名字、名字对，也不是停顿、声音、语言标签），后面紧跟（中间只有空白）另一个方括号：
 * [德拉科][smug]哟。、[Mira][Harry][calm]……。dub 会在前面换上包的全名，留着就写了两次，所以这样的一行所在的台本整段不派生。每一行都看。
 */
function unrecognizedHeadBeforeBracket(script, names) {
  let lineStart = 0;
  for (const line of script.split('\n')) {
    const head = line.search(/\S/u);
    if (head !== -1 && line[head] === '[') {
      const at = lineStart + head;
      CUE_AT.lastIndex = at;
      const bracket = CUE_AT.exec(script)?.[0];
      const recognized = bracket === undefined || bracket.includes('|') || PAUSE_OR_VOICE.test(bracket) || LANGUAGE_TAG.test(bracket) || nameAtHead(script.slice(at), names) !== null;
      if (!recognized && /^[ \t]*\[/u.test(script.slice(at + bracket.length))) return true;
    }
    lineStart += line.length + 1;
  }
  return false;
}

/** 去掉空白和占位字符，只剩字（比对用）。 */
const wordsOnly = (text) => text.replace(/[\s\uE000-\uF8FF]/gu, '');

/**
 * 台本里的提示标注（文件头）。返回 { annotatedText, cues }（cues 是提示的条数，至少一条），做不了是 null。
 * @param {string} script 台本原文（带标记）
 * @param {{ text: string, names?: string[] }} options text 是台本念出来的字（spokenWords(script)）；names 是这个包认的名字
 * @returns {{ annotatedText: string, cues: number } | null}
 */
export function scriptAnnotationOf(script, { text, names = [] }) {
  if (HAS_PLACEHOLDER_CHAR.test(script)) return null;
  if (unrecognizedHeadBeforeBracket(script, names)) return null;
  // 提示：方括号里不是名字、不是标记的。名字对在哪都不是提示
  const cues = [];
  for (const match of script.matchAll(CUE_EVERYWHERE)) {
    const bracket = match[0];
    if (PAUSE_MARK.test(bracket)) {
      cues.push({ at: match.index, length: bracket.length, bracket: '[pause]' });
      continue;
    }
    if (bracket.includes('|') || PAUSE_OR_VOICE.test(bracket) || LANGUAGE_TAG.test(bracket) || isNameAtLineStart(script, match.index, names)) continue;
    cues.push({ at: match.index, length: bracket.length, bracket });
  }
  if (cues.length === 0 || cues.length > PLACEHOLDER_LAST - PLACEHOLDER_FIRST + 1) return null;
  // 每个提示换成占位字，别的标记留着，让 spokenWords 去掉它们
  let marked = '';
  let from = 0;
  cues.forEach(({ at, length }, k) => {
    marked += script.slice(from, at) + String.fromCharCode(PLACEHOLDER_FIRST + k);
    from = at + length;
  });
  marked += script.slice(from);
  const spoken = spokenWords(marked);
  // 占位前面有几个非空白的字（按字数对位置），每个占位只出现一次
  const slots = [];
  let words = 0;
  for (const ch of spoken) {
    const code = ch.codePointAt(0);
    if (code >= PLACEHOLDER_FIRST && code < PLACEHOLDER_FIRST + cues.length) {
      slots.push({ k: code - PLACEHOLDER_FIRST, before: words });
      continue;
    }
    if (!SPACE.test(ch)) words += 1;
  }
  if (slots.length !== cues.length || new Set(slots.map((slot) => slot.k)).size !== cues.length) return null;
  if (wordsOnly(spoken) !== wordsOnly(text)) return null;
  // 文字里每个非空白的字从哪里开始（按代码单位，和字符串的下标一致）
  const starts = [];
  let index = 0;
  for (const ch of text) {
    if (!SPACE.test(ch)) starts.push(index);
    index += ch.length;
  }
  const inserts = slots
    .map(({ k, before }) => ({ k, at: before < starts.length ? starts[before] : text.length }))
    .sort((a, b) => a.at - b.at || a.k - b.k);
  let annotatedText = '';
  let cursor = 0;
  for (const { k, at } of inserts) {
    annotatedText += text.slice(cursor, at) + cues[k].bracket;
    cursor = at;
  }
  annotatedText += text.slice(cursor);
  // 和听出来的标注同一条校验：去掉方括号一字不差、不超过长度上限
  if (withoutBrackets(annotatedText) !== text) return null;
  if ([...annotatedText].length > ANNOTATED_TEXT_MAX) return null;
  return { annotatedText, cues: cues.length };
}

/**
 * 切过的段的提示标注（文件头「切过的段」）：只留文字前 keptLength 个字之前的提示。返回切好的标注（字符串），做不了是 null：
 * 留下的没有提示，或者去掉方括号和 text 的前 keptLength 个字对不上。
 * @param {string} annotatedText 切之前的提示标注（scriptAnnotationOf 拼的）
 * @param {string} text 切之前的文字
 * @param {number} keptLength 留下的文字的长度（代码单位，keptScript 的结果）
 * @returns {string | null}
 */
export function cutScriptAnnotation(annotatedText, text, keptLength) {
  let out = '';
  let seen = 0; // 文字里已经留下了几个字
  let i = 0;
  while (i < annotatedText.length) {
    CUE_AT.lastIndex = i;
    const cue = CUE_AT.exec(annotatedText);
    if (cue !== null) {
      if (seen >= keptLength) break; // 开在切口后面的提示：跟着切掉的那几句走
      out += cue[0];
      i += cue[0].length;
      continue;
    }
    if (seen >= keptLength) break;
    out += annotatedText[i];
    seen += 1;
    i += 1;
  }
  if (seen !== keptLength || withoutBrackets(out) !== text.slice(0, keptLength) || !HAS_CUE.test(out)) return null;
  return out;
}
