// SPDX-License-Identifier: Apache-2.0
//
// 读 zip：把分享文件的字节读成「名字 + 内容」的列表。结构上的检查在 zip-structure.mjs（不解压），这里取数据：
//   - 本地头要和中央目录对得上（名字、压缩方法、没有数据描述符时的 CRC 和大小）：两处说的不一样，是 zip 混淆攻击的写法；
//   - 各个条目的数据区不能互相重叠，也不能压到别的条目的头：重叠是 zip 炸弹（一份压缩数据被几百个条目共用）的写法；
//   - 存储条目直接切出来；deflate 条目用平台自带的 DecompressionStream('deflate-raw')，边解边数，
//     超过头里声明的大小就立刻停（头里可以说谎，不能信）；解出来的大小和 CRC-32 都要对上。
//
// 返回的 data 是各自独立的数组，不是整个 zip 缓冲区的视图（拿 .buffer 的人不会读到别的成员）。
// 目录条目不给内容，名字（去掉结尾的 /）放在 directories 里。
//
// 错误：除 zip-structure.mjs 里的以外：
//   zip_malformed      reason: local_header_signature | local_name_mismatch | local_method_mismatch | local_flags_mismatch
//                              | local_size_mismatch | data_outside_file | entries_overlap | data_before_first_entry | stored_size_mismatch
//   zip_size_mismatch  解出来的大小和声明的不一样：{ path, declared, actual? }（解到超过声明就停，不知道真实大小）
//   zip_crc_mismatch   CRC-32 对不上：{ path }
//   zip_corrupt_entry  deflate 数据坏了：{ path }
//   platform_unsupported   平台没有 DecompressionStream（只有读 deflate 条目才要它）
//   total_too_large    zip 文件本身比解包上限允许的还大
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { resolveLimits } from './limits.mjs';
import * as Z from './zip-format.mjs';
import { readStructure, malformed } from './zip-structure.mjs';

const HEADER_ALLOWANCE = 2200; // 每个条目的本地头和中央目录头，最多 (30 + 46 + 2 × 1024) 字节
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * @param {Uint8Array} bytes 整个 zip
 * @param {{ limits?: Partial<import('./limits.mjs').DEFAULT_LIMITS> }} [options]
 * @returns {Promise<{ entries: { name: string, data: Uint8Array, method: number, offset: number }[], directories: string[] }>}
 */
export async function readZip(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('The input of readZip must be a Uint8Array');
  const limits = resolveLimits(options.limits);
  const ceiling = limits.maxTotalBytes + limits.maxMembers * HEADER_ALLOWANCE + 0x10000;
  if (bytes.length > ceiling) {
    throw new VoicePackError('total_too_large', `The zip file itself is ${bytes.length} bytes, more than the ${ceiling} bytes the unpack limit allows`, { details: { total: bytes.length, limit: ceiling } });
  }
  const { records, files, directories, centralOffset } = readStructure(bytes, limits);
  locateData(bytes, records, centralOffset);

  const entries = [];
  for (const rec of files) {
    const compressed = bytes.subarray(rec.dataStart, rec.dataEnd);
    let data;
    if (rec.method === Z.METHOD_STORE) {
      if (rec.compressedSize !== rec.size) throw malformed('stored_size_mismatch', `${JSON.stringify(rec.path)} is a stored entry, but its compressed size differs from its original size`, { path: rec.path });
      data = compressed.slice();
    } else {
      data = await inflate(compressed, rec.size, rec.path);
    }
    if (Z.crc32(data) !== rec.crc) throw new VoicePackError('zip_crc_mismatch', `The CRC-32 of ${JSON.stringify(rec.path)} does not match: the content was modified or the file is damaged`, { details: { path: rec.path } });
    entries.push({ name: rec.path, data, method: rec.method, offset: rec.offset });
  }
  return { entries, directories };
}

/** 检查本地头，算出每个条目数据区的起止；检查数据区互不重叠。 */
function locateData(bytes, records, centralOffset) {
  const dv = Z.viewOf(bytes);
  for (const rec of records) {
    const at = rec.offset;
    if (at + Z.LOCAL_HEADER_SIZE > centralOffset) throw malformed('data_outside_file', `The local header of ${JSON.stringify(rec.path)} is outside the file`, { path: rec.path });
    if (dv.getUint32(at, true) !== Z.SIG_LOCAL) throw malformed('local_header_signature', `The local header of ${JSON.stringify(rec.path)} does not have the PK\\x03\\x04 marker`, { path: rec.path });
    const flags = dv.getUint16(at + 6, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const nameEnd = at + Z.LOCAL_HEADER_SIZE + nameLen;
    if (nameEnd + extraLen > centralOffset) throw malformed('data_outside_file', `The local header of ${JSON.stringify(rec.path)} is truncated`, { path: rec.path });
    if (flags & ENCRYPTION_FLAGS) throw malformed('local_flags_mismatch', `The local header of ${JSON.stringify(rec.path)} is marked encrypted, but the central directory is not`, { path: rec.path });
    if (!sameBytes(bytes.subarray(at + Z.LOCAL_HEADER_SIZE, nameEnd), rec.nameBytes)) {
      throw malformed('local_name_mismatch', `The name of ${JSON.stringify(rec.path)} in the local header differs from the one in the central directory`, { path: rec.path });
    }
    if (dv.getUint16(at + 8, true) !== rec.method) throw malformed('local_method_mismatch', `The compression method of ${JSON.stringify(rec.path)} differs between the local header and the central directory`, { path: rec.path });
    if (!(flags & Z.FLAG_DESCRIPTOR)) {
      const same = dv.getUint32(at + 14, true) === rec.crc && dv.getUint32(at + 18, true) === rec.compressedSize && dv.getUint32(at + 22, true) === rec.size;
      if (!same) throw malformed('local_size_mismatch', `The CRC or size of ${JSON.stringify(rec.path)} differs between the local header and the central directory`, { path: rec.path });
    }
    rec.dataStart = nameEnd + extraLen;
    rec.dataEnd = rec.dataStart + rec.compressedSize;
    if (rec.dataEnd > centralOffset) throw malformed('data_outside_file', `The data of ${JSON.stringify(rec.path)} extends beyond the file`, { path: rec.path });
  }
  const byOffset = [...records].sort((a, b) => a.offset - b.offset);
  if (byOffset.length > 0 && byOffset[0].offset !== 0) throw malformed('data_before_first_entry', 'There are extra bytes before the first entry');
  for (let i = 0; i + 1 < byOffset.length; i++) {
    if (byOffset[i].dataEnd > byOffset[i + 1].offset) throw malformed('entries_overlap', `The data of ${JSON.stringify(byOffset[i].path)} runs into the header of ${JSON.stringify(byOffset[i + 1].path)}`, { path: byOffset[i].path, other: byOffset[i + 1].path });
  }
}

/** deflate-raw 解压，解到超过声明的大小就停。 */
async function inflate(compressed, declared, path) {
  if (typeof DecompressionStream !== 'function') {
    throw new VoicePackError('platform_unsupported', `This platform has no DecompressionStream, so the compressed entry ${JSON.stringify(path)} cannot be read (browsers need Chrome 103+, Firefox 113+, Safari 16.4+)`, { details: { path } });
  }
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let produced = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      produced += value.length;
      if (produced > declared) {
        await reader.cancel().catch(() => {});
        throw new VoicePackError('zip_size_mismatch', `${JSON.stringify(path)} inflates to more than the ${declared} bytes declared in its header: the header is lying, or this is a decompression bomb`, { details: { path, declared } });
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (isVoicePackError(cause)) throw cause;
    throw new VoicePackError('zip_corrupt_entry', `The compressed data of ${JSON.stringify(path)} is corrupt`, { details: { path }, cause });
  }
  if (produced !== declared) throw new VoicePackError('zip_size_mismatch', `${JSON.stringify(path)} inflates to ${produced} bytes, but its header declares ${declared} bytes`, { details: { path, declared, actual: produced } });
  return Z.concatBytes(chunks, produced);
}
