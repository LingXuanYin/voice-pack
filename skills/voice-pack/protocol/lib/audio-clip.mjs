// SPDX-License-Identifier: Apache-2.0
//
// 音频片段：音频在库里统一用「字节加 MIME 类型」传，所有所需能力的签名（vocab/capability-signatures.md）、
// 流程层（lib/）和环境适配层（adapters/）都用这一种写法：
//
//   { bytes: Uint8Array, mimeType: 'audio/wav' }
//
// 不传 URL、Base64 字符串、文件路径：这样库的接口不绑定某个环境的存储。要 URL 的模型（例如只收 URL 的参考音频），
// 由适配器自己去上传，再把返回的 URL 用在它自己的请求里，URL 不会回到库的接口上。
//
// 为什么放在核心层：流程层和环境适配层都要用，而适配器只允许依赖核心层（protocol/README.md「模块约定」）。
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

// audio/ 开头，后面是类型名，可以带参数（例如 audio/webm;codecs=opus）
const AUDIO_MIME = /^audio\/[^\s;/]+(?:\s*;.*)?$/i;

function problemOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '必须是 { bytes, mimeType } 对象（不收 URL、Base64 字符串、文件路径）';
  if (!(value.bytes instanceof Uint8Array)) return 'bytes 必须是 Uint8Array（Buffer 也行；不收 Base64 字符串、普通数组、ArrayBuffer）';
  if (value.bytes.length === 0) return 'bytes 不能是空的';
  if (typeof value.mimeType !== 'string' || !AUDIO_MIME.test(value.mimeType)) return 'mimeType 必须是 audio/ 开头的 MIME 类型，例如 audio/wav、audio/mpeg';
  return null;
}

/**
 * 是不是合法的音频片段。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAudioClip(value) {
  return problemOf(value) === null;
}

/**
 * 核对一个值是合法的音频片段，不是就抛错。
 * @template T
 * @param {T} value
 * @param {string} [field] 调用方的参数名，写进报错里，例如 `ref_audio`、`audios[1]`
 * @returns {T} 原样返回
 * @throws {VoicePackError} audio_clip_invalid：不是 { bytes, mimeType }。details.field 是参数名，details.problem 说哪里不对
 */
export function assertAudioClip(value, field = 'audio') {
  const problem = problemOf(value);
  if (problem !== null) {
    throw new VoicePackError('audio_clip_invalid', `${field} 不是合法的音频片段：${problem}`, { details: { field, problem } });
  }
  return value;
}
