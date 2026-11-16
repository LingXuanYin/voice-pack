// SPDX-License-Identifier: Apache-2.0
//
// 一段文字念出来至少要多长（配音，lib/dub.mjs 第 9a 步「念完没有」）：按语速估，往短里估，只用来找出明显没念完的成品。只做计算，不用模型。
//
//   数什么   去掉提示（方括号里的）和尖括号标签（lib/line-hints.mjs 的 wordsOf；音素标记、语言标签包住的另一种语言的字不算，往短里估）以后的字：汉字、假名、谚文每个按 SPEECH_RATE.cjk 算，别的字母和数字按 SPEECH_RATE.other 算；
//            标点、空白不算（停顿、标点只会让念出来的更长，不算它们，估的就偏短）。
//   语速     SPEECH_RATE（每秒几个字）：汉字、假名、谚文每秒 6 个，别的字母和数字每秒 20 个。比量过的快：
//            models/scene3.md「Limits of one request」2026-11-05 量的，说完的请求中文每秒 4.2 到 4.7 个字，英文按字母和数字数每秒 11 到 13 个，
//            所以说完的请求出来的都比这里估的长（量过的是估的 1.46 到 1.81 倍）。语速只写在这一处。
//   没念完   出来的不到估的 UNFINISHED_BELOW（一半）：可能没念完（模型超了不一定报错，是念到一半就停）。量过的五次没念完，只有停得最早的一次
//            （2906 字只念了开头 98 字）不到一半；念到一半上下才停的四次，出来的是估的 0.69 到 0.92 倍，这一条认不出来。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { wordsOf } from './line-hints.mjs';

/** 每秒几个字（往快里取，估的念出来的长度就偏短）：cjk 是汉字、假名、谚文，other 是别的字母和数字。 */
export const SPEECH_RATE = Object.freeze({ cjk: 6, other: 20 });

/** 出来的音频不到估的这么多倍，就是可能没念完。 */
export const UNFINISHED_BELOW = 0.5;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * 这段文字念出来至少要多少毫秒（往短里估，规则见文件头）。提示（方括号里的）不算；没有要念的字是 0。
 * @param {string} text 交给模型的文字（提示在原位）
 * @returns {number} 毫秒，取整
 */
export function expectedSpeechMs(text) {
  let cjk = 0;
  let other = 0;
  for (const char of wordsOf(text)) {
    if (CJK.test(char)) cjk += 1;
    else if (WORD.test(char)) other += 1;
  }
  return Math.round((cjk / SPEECH_RATE.cjk + other / SPEECH_RATE.other) * 1000);
}
