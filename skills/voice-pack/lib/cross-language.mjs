// SPDX-License-Identifier: Apache-2.0
//
// 跨语言怎么说（流程层，纯计算）：配音停下来报 dub_cross_language（lib/dub.mjs 第 3a 步），做包说卡片试听那一句没配（lib/material-hints.mjs 的 card_line_cross_language），
// 都要说「参考段是哪种语言、台词是哪种语言」。写法只在这里。
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
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { detectLanguages, scriptFitsLanguage } from './line-hints.mjs';

/** 认不出是哪一种语言时说是什么文字写的（lib/line-hints.mjs 的 detectLanguages 给的文字系统）。 */
export const SCRIPT_NAMES = Object.freeze({ Latin: '拉丁字母', Han: '汉字', Cyrillic: '西里尔字母', Arabic: '阿拉伯字母', Devanagari: '天城文', Hebrew: '希伯来字母', Hangul: '谚文', Japanese: '日文', Thai: '泰文', Greek: '希腊字母' });

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
