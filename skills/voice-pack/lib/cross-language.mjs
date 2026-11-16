// SPDX-License-Identifier: Apache-2.0
//
// 跨语言怎么说（流程层，纯计算）：配音停下来报 dub_cross_language（lib/dub.mjs 第 3a 步），做包说试听句没配（lib/material-hints.mjs 的 card_line_cross_language），
// 都要说「参考段是哪种语言、台词是哪种语言」，使用者自己要补参考的，还要说补的参考从哪来。写法只在这里。
//
//   languageOfText(language, text) -> { language, given? }
//     第 3a 步拿哪种语言去和参考段比。language 是这一行挑参考时认的语言（lib/reference-pick.mjs 的 picks[i].language：{ wanted, source, script }，不是 null），text 是这一行要念的字。
//     从文字认的（source 是 text）：照旧。调用方、设定给的（source 是 caller、setup）：文字对得上给的语言就照给的；文字看得出不是这种语言的
//     （lib/line-hints.mjs 的 scriptFitsLanguage：英文台词给了 ja 或 zh），改按文字认的比：language 换成 { wanted: 这种文字可能的语言, source: 'text', script }，
//     given 是给语言的那一层（'caller' 是调用方的 --language、labels.language，'setup' 是设定的 labels.language），停下来的错按它说怎么改。
//     看不出文字的（只有数字、标点），和同一种文字写的几种语言（英语、法语都是拉丁字母，给了 en、台词是法语），查不出来，照给的比。
//   lineTarget(language, text) -> { to, script? }
//     一行台词的语言写成报告里的样子。language 同上（languageOfText 换过的就用换过的），text 是这一行要念的字。
//     调用方、设定给的（source 是 caller、setup）照写：to 是给的那个标签。
//     从文字认的（source 是 text）：文字本身只可能是一种语言的（假名是日语，谚文是韩语，lib/line-hints.mjs 的 detectLanguages 只给一种的）就是它；
//     别的不猜（拉丁字母可能是英语也可能是法语，汉字可能是普通话也可能是粤语）：to 是 null，script 是文字系统（Latin、Han……）。
//     包里有哪种语言也不拿来猜：说的是台词，不是包。
//   languagePair({ from, to, script? }) -> string
//     「参考段的语言→台词的语言」：ja→en；to 是 null 的写文字系统的中文名，ja→拉丁字母（名字在 SCRIPT_NAMES，表里没有的照写文字系统）。
//   referenceSources(from) -> string
//     使用者自己要给包补一段这种语言的参考时，参考从哪来：有这个角色说这种语言的录音就用录音；没有的（设计出来的声音也一样），默认用这个包跨语言配一段这种语言的话当参考
//     （dub 带 --no-setup：要的是声音本身，不套包里的设定；配一条就用它，不让使用者挑，素材标 synthetic），配之前说一句可能带一点参考那种语言的口音；也可以用使用者在库里挑的另一个声音；平台能指定模型的，选项里另列一项
//     「先用 <模型名> 念一遍再克隆：想压一压口音可以试」（基础部分自己不换模型）。from 是参考段的语言，写进「可能带一点 ja 的口音」；不知道是哪一种（几段不一样）给 undefined。
//     配音停下来的 dub_cross_language（lib/dub.mjs 第 3a 步）和试听句的 card_line_cross_language（lib/material-hints.mjs）用同一句，末尾指到做法：references/character-voice.md「Add a reference segment in this language」。
//   namePairOf(text) -> { cue, reference, line } | null
//     一行开头的名字对（[参考语言里的名字|台词语言里的名字]，跨语言的行这样写，models/scene3.md「Cross-language and accent」）：cue 是整个方括号，reference、line 是两个名字。开头不是名字对给 null。
//   lineNameOnly(text) -> string
//     发给模型的文字：每一行开头的名字对只留参考语言里的名字（[Harry Potter|哈利·波特] 换成 [Harry Potter]）。不开头的方括号不动。
//   lineLanguage({ to }, text) -> string
//     语言提示写台词的哪种语言：lineTarget 给了的照写；认不出是哪一种的，取这种文字的第一种（汉字 zh，拉丁字母 en，lib/line-hints.mjs 的 LANGUAGES_OF）。
//   markLanguage(tag) -> string
//     语言提示里写的语言：标签的主语言（lib/line-hints.mjs 的 primaryLanguage：zh-CN、cmn 都是 zh）。
//   withLineLanguage(text, language) -> string
//     台词的结尾写这一次的语言：听着，罗恩…… [language: zh]。
//   withReferenceMarks(text, { referenceName, referenceLanguage }) -> string
//     参考的文字：开头写台词语言里的名字（referenceName 是 null 就不写），结尾写参考的语言：[哈利·波特]标注全文 [language: en]。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { detectLanguages, primaryLanguage, scriptFitsLanguage } from './line-hints.mjs';

/** 认不出是哪一种语言时说是什么文字写的（lib/line-hints.mjs 的 detectLanguages 给的文字系统）。 */
export const SCRIPT_NAMES = Object.freeze({ Latin: 'Latin script', Han: 'Chinese characters', Cyrillic: 'Cyrillic script', Arabic: 'Arabic script', Devanagari: 'Devanagari script', Hebrew: 'Hebrew script', Hangul: 'Hangul', Japanese: 'Japanese script', Thai: 'Thai script', Greek: 'Greek script' });

/** 拿哪种语言去和参考段比（文件头）：给了的语言文字看得出对不上，换成按文字认的，given 是给的那一层。 */
export function languageOfText(language, text) {
  if (language.source === 'text') return { language };
  const detected = detectLanguages(text);
  if (detected === null || scriptFitsLanguage(detected, language.wanted)) return { language };
  return { language: { wanted: [...detected.languages], source: 'text', script: detected.script }, given: language.source };
}

/** 一行台词的语言写成 { to, script? }（文件头）。 */
export function lineTarget(language, text) {
  if (language.source !== 'text') return { to: language.wanted };
  const detected = detectLanguages(text);
  if (detected !== null && detected.languages.length === 1) return { to: detected.languages[0] };
  return { to: null, script: language.script };
}

/** 「参考段的语言→台词的语言」（文件头）。 */
export const languagePair = (entry) => `${entry.from}→${entry.to ?? SCRIPT_NAMES[entry.script] ?? entry.script}`;

const NAME_PAIR = /^\s*\[([^[\]|\n]+)\|([^[\]|\n]+)\]/;
const NAME_PAIR_ON_LINES = /^([^\S\n]*)\[([^[\]|\n]+)\|[^[\]|\n]+\]/gm;

/** 一行开头的名字对（文件头）。 */
export function namePairOf(text) {
  const found = NAME_PAIR.exec(text);
  return found === null ? null : { cue: found[0].trimStart(), reference: found[1].trim(), line: found[2].trim() };
}

/** 每一行开头的名字对只留参考语言里的名字（文件头）。 */
export const lineNameOnly = (text) => text.replace(NAME_PAIR_ON_LINES, (_all, space, name) => `${space}[${name.trim()}]`);

/** 语言提示写台词的哪种语言（文件头）。 */
export const lineLanguage = (target, text) => target.to ?? detectLanguages(text).languages[0];

/** 语言提示里写的语言（文件头）。 */
export const markLanguage = (tag) => primaryLanguage(tag);

/** 台词的结尾写这一次的语言（文件头）。 */
export const withLineLanguage = (text, language) => `${text.trimEnd()} [language: ${language}]`;

/** 参考的文字：开头的名字，结尾的语言（文件头）。 */
export const withReferenceMarks = (text, { referenceName, referenceLanguage }) => `${referenceName === null ? '' : `[${referenceName}]`}${text.trimEnd()} [language: ${referenceLanguage}]`;

/** 补一段这种语言的参考，参考从哪来（文件头）。 */
export const referenceSources = (from) => `Where the reference comes from: if there is a recording of this character speaking this language, use the recording; if there is none (also for a designed voice), by default use this pack to dub a passage in this language across languages as the reference (dub --language <this language> --allow-cross-language --no-setup, which does not apply the setup in the pack; dub one passage and use it, and mark "synthetic": true in the materials), and tell the user once before dubbing that it may carry a slight accent${from === undefined ? ' of the reference language' : ` of ${from}`}; or use a voice that speaks this language and that the user picked from the library (that is a different voice, so tell the user clearly first). When the platform can name the model, list one more option: "speak it with <model name> first, then clone: worth trying if you want to reduce the accent" (for the model name and how to set it, see the platform's adapter). How to do it: references/character-voice.md「Add a reference segment in this language」`;
