// SPDX-License-Identifier: Apache-2.0
//
// zip 格式的共用部分：魔数、字段偏移里用到的常量、CRC-32、小端读写。读（zip-read.mjs）和写（zip-write.mjs）都用。
// 格式依据：PKWARE APPNOTE.TXT 6.3.x（中央目录、本地头、数据描述符、结尾记录），本库只用其中不需要 zip64 的那部分。
//
// 为什么自己写 CRC-32：zip 的校验和必须是 CRC-32（IEEE 802.3，多项式 0xEDB88320），平台自带的 crypto.subtle 没有，
// node:zlib.crc32 浏览器里没有。查表法，约 15 行。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_EOCD64_LOCATOR = 0x07064b50;
export const SIG_DESCRIPTOR = 0x08074b50;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

/** 通用用途标志位：第 3 位 = 数据描述符，第 11 位 = 文件名是 UTF-8。 */
export const FLAG_DESCRIPTOR = 0x0008;
export const FLAG_UTF8 = 0x0800;

/** 写出的字节里固定的字段：1980-01-01 00:00:00（DOS 时间），创建者 = Unix、版本 2.0，普通文件 0644。 */
export const FIXED_DOS_TIME = 0;
export const FIXED_DOS_DATE = 0x21;
export const VERSION_MADE_BY = 0x0314;
export const VERSION_NEEDED = 20;
export const MODE_FILE_0644 = 0o100644;

/** 外部属性高 16 位里的 Unix 文件类型（st_mode & 0o170000）。 */
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 字节的 CRC-32（zip 用的那个）。
 * @param {Uint8Array} bytes 可以是一段大缓冲区的视图，只算视图里的字节
 * @returns {number} 无符号 32 位整数
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concatBytes(chunks, total) {
  const size = total ?? chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
