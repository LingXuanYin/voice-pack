// SPDX-License-Identifier: Apache-2.0
//
// 合成请求的上限，基础部分自己定的那几条（流程层）。
// 环境声明的 maxChars（合成能力一次最多多少个字，适配器的 limits.maxChars，app 的 contract）最少是多少：配音按 maxChars 切请求、往请求开头补提示（lib/dub.mjs 第 5、7a 步），
// 切出来的一个请求至少要留得下这么多字；做包把它交给配音配试听句（lib/make-pack-input.mjs），适配器检查核适配器声明的 limits（lib/adapter-check.mjs）：都按这一个数查，不各写一份。
// 配音默认一个请求要念多少字（软上限）、这个字怎么数，也只写在这里：配音切请求（lib/dub.mjs 第 5、5a、5b、5c 步）和 dub --dry-run 汇总里的字数（cli/commands/dub.mjs）都用 spokenLength。
//
//   MIN_MAX_CHARS             maxChars 的下限（整数，含）
//   DEFAULT_MAX_SPOKEN_CHARS  配音默认一个请求最多多少个要念的字（1000 个字符，英文约 170 个词）。不是适配器报错的硬上限，是配音自己默认的切法：超过了就在段落、换人、句子的边界切开，
//                             每个请求里照旧并。旁白和一场戏都适用。调用方给了自己的上限（命令行 --max-chars）就照给的，这个默认不再管。
//                             出处：要求，不是实测，见 models/scene3.md「Limits of one request」。
//   spokenLength(text)        要念的字有几个（按字符数，一个汉字、一个字母、一个标点各算一个）：方括号的提示不算，尖括号标签的名字不算（成对的标签包住的字照算，
//                             语言标签包住的另一种语言的字也照算），一个音素标签算一个字；连着的空白（空格、换行）算一个，两头的不算。
//                             所以英文词和词之间的空格算，一个请求里行与行之间的换行也算一个。
//                             适配器的硬上限（maxChars）数的是发出去的字（码位，提示、标签、每个空白都算），不用它。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { CUE_PATTERN, PHONEME_MARKER_PATTERN, TAG_PATTERN } from '../tools/markup.mjs';

export const MIN_MAX_CHARS = 10;

export const DEFAULT_MAX_SPOKEN_CHARS = 1000;

const CUE_RE = new RegExp(CUE_PATTERN, 'g');
const PHONEME_MARKER_RE = new RegExp(PHONEME_MARKER_PATTERN, 'g');
const TAG_RE = new RegExp(TAG_PATTERN, 'g');
const SPACES = /\s+/gu;

/**
 * 要念的字有几个（数法见文件头）。音素标签先换成一个字，再去掉别的标签（TAG_PATTERN 里也有音素标签，顺序不能反）；去掉提示、标签以后再折空白，
 * 所以提示两边的空白也折成一个（「Hi [laughs] there」是 8 个），一行开头的提示后面的空白在两头，不算。
 * 不能逐段相加：两段接起来，接的地方的空白、换行只在接起来以后才数得到（lib/pause-in-request.mjs 的 requestsOf 量缝的办法）。
 * @param {string} text 台本或发出去的文字（提示、标签在原位）
 * @returns {number}
 */
export function spokenLength(text) {
  return [...text.replace(CUE_RE, '').replace(PHONEME_MARKER_RE, '\u{fffc}').replace(TAG_RE, '').replace(SPACES, ' ').trim()].length;
}
