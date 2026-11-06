// SPDX-License-Identifier: Apache-2.0
//
// 合成请求的上限，基础部分自己定的那一条（流程层）：环境声明的 maxChars（合成能力一次最多多少个字，适配器的 limits.maxChars，app 的 contract）最少是多少。
// 配音按 maxChars 切请求、往请求开头补提示（lib/dub.mjs 第 5、7a 步），切出来的一个请求至少要留得下这么多字；做包把它交给配音配卡片试听那一句（lib/make-pack-input.mjs），
// 适配器检查核适配器声明的 limits（lib/adapter-check.mjs）：都按这一个数查，不各写一份。
//
//   MIN_MAX_CHARS   maxChars 的下限（整数，含）
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export const MIN_MAX_CHARS = 10;
