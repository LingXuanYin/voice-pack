// SPDX-License-Identifier: Apache-2.0
//
// 清单里的哈希：SHA-256，对文件的原始字节算（不转换换行，不先解码再编码）。
// 用平台自带的 crypto.subtle，浏览器和 Node 都能跑；不引入第三方库。
// 同样的字节，在任何系统、任何运行时上算出同样的哈希：这个函数不看路径、不看换行、不看编码，只看字节。
//
// 浏览器里 crypto.subtle 只在安全上下文（https 页面、localhost）里有。没有就抛 crypto_unavailable，不悄悄换一个别的值。
//
// 错误：
//   crypto_unavailable   平台没有 crypto.subtle（例如 http 页面）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { toHex } from './bytes.mjs';

function subtle() {
  const impl = globalThis.crypto?.subtle;
  if (!impl || typeof impl.digest !== 'function') {
    throw new VoicePackError('crypto_unavailable', '这个平台没有 crypto.subtle（浏览器里只有 https 页面和 localhost 才有），算不了 SHA-256');
  }
  return impl;
}

function assertBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`哈希的输入必须是 Uint8Array（原始字节），收到 ${typeof bytes}`);
  }
}

/**
 * 原始字节的 SHA-256。
 * @param {Uint8Array} bytes 输入可以是一段大缓冲区的视图，只算视图里的字节
 * @returns {Promise<Uint8Array>} 32 字节
 * @throws {VoicePackError} crypto_unavailable
 */
export async function sha256(bytes) {
  assertBytes(bytes);
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/**
 * 原始字节的 SHA-256，小写十六进制（64 个字符）。清单里的 sha256 字段就是这个写法。
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 * @throws {VoicePackError} crypto_unavailable
 */
export async function sha256Hex(bytes) {
  return toHex(await sha256(bytes));
}
