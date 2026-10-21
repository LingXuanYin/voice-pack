// SPDX-License-Identifier: Apache-2.0
//
// 字节和文本的互转：十六进制、Base64。输入输出都是 Uint8Array 和字符串，浏览器和 Node 都能跑。
//
// 为什么自己写：Node 24.14 没有 Uint8Array.prototype.toHex / fromHex / toBase64 / fromBase64（2026-10-14 实测），
// 浏览器里没有 Buffer。05（音频进模型要 Base64）、06（哈希要十六进制）、07（公钥和签名是 Base64）都要用，只写这一份。
// 约定见 protocol/README.md「模块约定」。
import { VoicePackError } from './errors.mjs';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const CHUNK = 0x8000; // 一次最多展开 32768 个字节：音频、zip 成员动辄几十 MB，不能整个展开成函数参数

/**
 * 字节转小写十六进制，每字节两位。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

/**
 * 十六进制转字节。大小写都认，长度必须是偶数，不允许前缀和空白。
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {VoicePackError} invalid_hex
 */
export function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new VoicePackError('invalid_hex', '不是合法的十六进制：只能有 0-9、a-f，长度必须是偶数');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 字节转 Base64（RFC 4648 第 4 节的标准字母表，带 = 填充）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * Base64 转字节。认 atob 认的写法：标准字母表，空白会被忽略，填充可有可无。
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {VoicePackError} invalid_base64
 */
export function fromBase64(text) {
  // atob 会把参数转成字符串（null 变成 "null"，恰好是合法的 Base64），所以先自己核对类型
  if (typeof text !== 'string') throw new VoicePackError('invalid_base64', 'Base64 必须是字符串');
  let binary;
  try {
    binary = atob(text);
  } catch (cause) {
    throw new VoicePackError('invalid_base64', '不是合法的 Base64（标准字母表）', { cause });
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
