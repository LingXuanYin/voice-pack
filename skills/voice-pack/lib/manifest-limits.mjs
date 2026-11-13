// SPDX-License-Identifier: Apache-2.0
//
// 清单里自由文字字段的长度上限（流程层）：读协议核心的清单 schema（protocol/schema/manifest.schema.json 的 $defs），流程层不再自己抄一份数。
// 流程层要在花钱之前先卡一道的字段（变更说明、使用者的话、验证记录里的模型名……），上限都从这里拿；schema 改了，这里跟着变。
//
//   LONG_TEXT_MAX    longText 的长度上限（字符数）：变更说明、设计来源的描述……
//   SHORT_TEXT_MAX   shortText 的长度上限（字符数）：模型名、环境名……
//   ANNOTATED_TEXT_MAX  参考段的提示标注（annotatedText）的长度上限（字符数）：素材给的、模型标出来的都按它查
//   REFERENCE_TAG_MAX   参考段的音色基底标签（tag）的长度上限（按码点算）：素材给的、做包加了序号的都按它查
//
// schema 里读不到这几个定义（协议核心被改坏了）：加载时就抛 Error，不拿一个猜的数往下走。
// 语言标签的写法也在 schema 里，但它要留在不引别的模块的 lib/language-tag.mjs（app 的每个页面都读那一份），所以是那里手写的一处，
// 要和 schema 里的写法保持一致。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { MANIFEST_SCHEMA } from '../protocol/lib/manifest.mjs';

function limitOf(definition) {
  const max = MANIFEST_SCHEMA.$defs?.[definition]?.maxLength;
  if (!Number.isInteger(max) || max < 1) throw new Error(`Cannot read a positive integer from $defs.${definition}.maxLength in the manifest schema (protocol/schema/manifest.schema.json), got ${JSON.stringify(max)}`);
  return max;
}

export const LONG_TEXT_MAX = limitOf('longText');
export const SHORT_TEXT_MAX = limitOf('shortText');
export const ANNOTATED_TEXT_MAX = limitOf('annotatedText');
export const REFERENCE_TAG_MAX = limitOf('referenceTag');
