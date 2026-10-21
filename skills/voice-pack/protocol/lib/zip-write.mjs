// SPDX-License-Identifier: Apache-2.0
//
// 写 zip：条目按调用方给的顺序原样写出，全部用存储（不压缩）条目，时间戳、创建者、权限都是固定值。
// 所以同一份输入写出的字节永远相同，在 Node、Bun、浏览器里也相同（要求是「内容相同，打出的 zip 字节也相同」）。
//
// 为什么不压缩：
//   1. 压缩出来的字节依赖运行时的 zlib：同一份输入，Node 和 Bun 压出的字节数不一样，浏览器又是另一个实现
//      （实测的数字和输入的做法写在 FORMAT.md 8.3「为什么不压缩」，这里不重抄）。存储条目不看运行时，字节只由输入决定。
//   2. 包里的大头是音频：MP3、OGG/Opus、FLAC、M4A 本来就是压缩过的，WAV 用 deflate 也只能省一两成；
//      文本（SKILL.md、清单、程序）加起来是几百 KB 的量级，不压缩只多这么一点。
//   读的一侧照样认 deflate 条目（别人用系统自带的工具重新打的包），见 zip-read.mjs。
//
// 额外字段不带，不写数据描述符（写的时候已经知道大小和 CRC），条目的外部属性固定是普通文件 0644。
// 条目的名字要过 paths.mjs 的检查，也不能重名、不能大小写撞车、不能既是文件又是目录；不写目录条目。
//
// 错误：
//   path_unsafe / path_conflict          名字不能要（见 paths.mjs）；path_conflict 的 details: { kind, path, other }
//   too_many_members / member_too_large / total_too_large   超过解包上限（见 limits.mjs），写出去的 zip 自己的读取方不能拒绝它
//   zip_too_large                        超过 zip 不带 zip64 能表示的范围（65534 个条目、4 GiB）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { assertPackPath, findPathConflict } from './paths.mjs';
import { resolveLimits, assertMemberCount, assertMemberSize, assertTotalSize } from './limits.mjs';
import * as Z from './zip-format.mjs';

const encoder = new TextEncoder();
const MAX_ENTRIES = 0xfffe; // 0xFFFF 在结尾记录里是 zip64 的标记，不带 zip64 最多 65534 个条目
const MAX_BYTES = 0xffffffff;

/**
 * @param {{ name: string, data: Uint8Array }[]} entries 按这个顺序写。分享文件要求类型标识在第一项，顺序由调用方（share.mjs）定
 * @param {{ limits?: Partial<import('./limits.mjs').DEFAULT_LIMITS> }} [options]
 * @returns {Uint8Array}
 */
export function writeZip(entries, options = {}) {
  const limits = resolveLimits(options.limits);
  if (!Array.isArray(entries)) throw new TypeError('entries 必须是数组');
  assertMemberCount(entries.length, limits);
  if (entries.length > MAX_ENTRIES) throw new VoicePackError('zip_too_large', `条目太多：${entries.length} 个，不带 zip64 的 zip 最多 ${MAX_ENTRIES} 个`, { details: { count: entries.length, limit: MAX_ENTRIES } });

  const prepared = [];
  let totalData = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('每个条目必须是 { name, data } 对象');
    if (typeof entry.name !== 'string') throw new TypeError('条目的 name 必须是字符串');
    if (!(entry.data instanceof Uint8Array)) throw new TypeError(`条目 ${JSON.stringify(entry.name)} 的 data 必须是 Uint8Array`);
    assertPackPath(entry.name);
    assertMemberSize(entry.name, entry.data.length, limits);
    totalData += entry.data.length;
    assertTotalSize(totalData, limits);
    prepared.push({ name: entry.name, nameBytes: encoder.encode(entry.name), data: entry.data, crc: Z.crc32(entry.data) });
  }
  const conflict = findPathConflict(prepared.map((p) => p.name));
  if (conflict) {
    throw new VoicePackError('path_conflict', `路径 ${JSON.stringify(conflict.path)} 和 ${JSON.stringify(conflict.other)} 冲突（${conflict.kind}）：解到磁盘上会互相覆盖`, { details: conflict });
  }

  const localSize = prepared.reduce((sum, p) => sum + Z.LOCAL_HEADER_SIZE + p.nameBytes.length + p.data.length, 0);
  const centralSize = prepared.reduce((sum, p) => sum + Z.CENTRAL_HEADER_SIZE + p.nameBytes.length, 0);
  const total = localSize + centralSize + Z.EOCD_SIZE;
  if (total > MAX_BYTES) throw new VoicePackError('zip_too_large', `zip 太大：${total} 字节，不带 zip64 的 zip 最多 ${MAX_BYTES} 字节`, { details: { size: total, limit: MAX_BYTES } });

  const out = new Uint8Array(total);
  const dv = Z.viewOf(out);
  let at = 0;
  const u16 = (n) => { dv.setUint16(at, n, true); at += 2; };
  const u32 = (n) => { dv.setUint32(at, n, true); at += 4; };
  const raw = (bytes) => { out.set(bytes, at); at += bytes.length; };

  const offsets = [];
  for (const p of prepared) {
    offsets.push(at);
    u32(Z.SIG_LOCAL);
    u16(Z.VERSION_NEEDED);
    u16(Z.FLAG_UTF8);
    u16(Z.METHOD_STORE);
    u16(Z.FIXED_DOS_TIME);
    u16(Z.FIXED_DOS_DATE);
    u32(p.crc);
    u32(p.data.length);
    u32(p.data.length);
    u16(p.nameBytes.length);
    u16(0);
    raw(p.nameBytes);
    raw(p.data);
  }
  const centralStart = at;
  prepared.forEach((p, i) => {
    u32(Z.SIG_CENTRAL);
    u16(Z.VERSION_MADE_BY);
    u16(Z.VERSION_NEEDED);
    u16(Z.FLAG_UTF8);
    u16(Z.METHOD_STORE);
    u16(Z.FIXED_DOS_TIME);
    u16(Z.FIXED_DOS_DATE);
    u32(p.crc);
    u32(p.data.length);
    u32(p.data.length);
    u16(p.nameBytes.length);
    u16(0); // 额外字段
    u16(0); // 文件注释
    u16(0); // 起始磁盘号
    u16(0); // 内部属性
    u32(((Z.MODE_FILE_0644 << 16) >>> 0));
    u32(offsets[i]);
    raw(p.nameBytes);
  });
  u32(Z.SIG_EOCD);
  u16(0);
  u16(0);
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSize);
  u32(centralStart);
  u16(0);
  return out;
}
