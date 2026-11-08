// SPDX-License-Identifier: Apache-2.0
//
// 一条提示有几个词，和提示的两个上限（流程层，纯计算）。几处共用，数法和上限只写在这里：
//   做包查设定合成的开头的提示（lib/make-pack-input.mjs 的 checkSetupOpeningCues），配音查合成以后的整条（lib/dub.mjs 第 7a 步「限长」），
//   配音的规划里列出台本里长的提示（lib/dub.mjs 的 long_cues）。
//
// 给调用方用的稳定接口：cueWords、MAX_CUE_WORDS、MAX_OPENING_CUE_WORDS 可以直接 import，调用方用它们在交给 make-pack、dub 之前自己先查。数法和上限只在这里改。
//
// 为什么限长：配音的模型只收文字，情绪、风格、能量写进方括号里随文字发出去（lib/opening-cue.mjs）。厂商的技术报告说一处提示「typically a few words」，没有给数。上限是我们自己定的：
//   MAX_CUE_WORDS          台本里的一处提示最多几个词（超过的 dub 在 long_cues 里提醒）。「压低声音慢慢说」7 个汉字算 4 个词，正好放得下。
//   MAX_OPENING_CUE_WORDS  合成以后整条开头的提示（情绪、风格、能量，lib/opening-cue.mjs）最多几个词。厂商例子里最长的一条是 9 个词；
//                          情绪、风格、能量都是词表里的短词，一般碰不到这一条，留着兜底。
//
// 怎么数（cueWords）：
//   - 汉字、假名（连长音符号、叠字符号）两个算一个词，加起来向上取整：「压低声音慢慢说」7 个字算 4 个词。依据：厂商同一句说戏，英文 7 个词，中文 13 个字。
//   - 别的字按空白分开，一截里有字母就算一个词：拼音文字（拉丁、西里尔、希腊字母，谚文……）按空格数，连字符、撇号连着的算一个（matter-of-fact、don't）。
//     汉字、假名先当成空白拿掉，所以紧挨着汉字的英文词照样单独数（压低声音whisper 是 2 + 1）。
//   - 数字、标点、符号不算（1.5、，、……都是 0）。
//   - 泰文、老挝文、高棉文、缅甸文这类词和词之间不写空格的字，按空白数不准（一长串算一个词）：这个上限管不住它们，没有按字数另数（要数准，在这里加）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 台本里的一处提示最多几个词。 */
export const MAX_CUE_WORDS = 4;
/** 合成以后整条开头的提示最多几个词。 */
export const MAX_OPENING_CUE_WORDS = 10;

// 汉字、假名：字母（\p{L}，所以不含全角标点）里，文字归属含汉字、平假名或片假名的（ー、々 也算）
const HAN_OR_KANA = /(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])\p{L}/gu;
const HAS_LETTER = /\p{L}/u;

/**
 * 一段提示文字有几个词（数法见文件头）。
 * @param {string} text
 * @returns {number}
 */
export function cueWords(text) {
  const value = String(text);
  const hanOrKana = value.match(HAN_OR_KANA)?.length ?? 0;
  const spaced = value.replace(HAN_OR_KANA, ' ').split(/\s+/u).filter((piece) => HAS_LETTER.test(piece)).length;
  return Math.ceil(hanOrKana / 2) + spaced;
}
