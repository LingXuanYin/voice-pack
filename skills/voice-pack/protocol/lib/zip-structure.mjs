// SPDX-License-Identifier: Apache-2.0
//
// 读 zip 的第一步：只看结构，不解压任何东西。找结尾记录、读中央目录、检查每个条目的名字、类型和声明的大小。
// 全部通过以后，zip-read.mjs 才去取数据。顺序照上游 VoiceStudio 的安全解包：成员数、名字、声明的单个大小、声明的总大小。
//
// 原则：
//   - 成员名从来不当文件系统路径用。名字先解码、过 paths.mjs 的检查；要写到磁盘上，由调用方自己拼路径（见 cli/commands/unpack.mjs）。
//   - 宁可拒绝，不要猜：zip64、分卷、加密、不认识的压缩方法、结构上自相矛盾的 zip，都报错并点名是哪一种。
//   - 符号链接和设备文件一律不要。外部属性高 16 位是 Unix 的 st_mode：zip 规范只说外部属性随系统而定，把 st_mode 放在高 16 位是 Unix 上写 zip 的工具（Info-ZIP、bsdtar）的惯例，
//     用 bsdtar 3.8.8 真生成过一个带符号链接的 zip 来验证（条目 link.txt 的高 16 位是 0o120666）。
//     不看「创建者」字节：别的系统写的 zip 里高 16 位也可能是 Unix 模式，看到符号链接就拒绝。
//
// 错误（code，details）：
//   zip_malformed      结构不对：{ reason, ... }。reason 见下面各处
//   zip_unsupported    不支持：{ reason: 'zip64' | 'multi_disk' | 'encrypted' | 'method', ... }
//   zip_bad_name       成员名不是合法的 UTF-8：{ index }。名字一律按 UTF-8 读，不管「UTF-8」标志位有没有设：
//                      能按 UTF-8 解码的就收（路径里能用来跳出目录的字符都是 ASCII，各种代码页下读出来一样）
//   path_unsafe        成员名不能要（paths.mjs）：{ path, reason }
//   path_conflict      成员名之间冲突：{ kind, path, other }
//   symlink_not_allowed        成员是符号链接：{ path, mode }
//   member_type_not_allowed    成员是设备文件、管道之类：{ path, mode }
//   too_many_members / member_too_large / total_too_large   见 limits.mjs
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { assertPackPath, findPathConflict, collisionKey } from './paths.mjs';
import { assertMemberCount, assertMemberSize, assertTotalSize } from './limits.mjs';
import * as Z from './zip-format.mjs';

const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000; // 第 0 位加密，第 6 位强加密，第 13 位中央目录加密
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const malformed = (reason, message, details = {}) =>
  new VoicePackError('zip_malformed', `zip 结构不对：${message}`, { details: { reason, ...details } });
export const unsupported = (reason, message, details = {}) =>
  new VoicePackError('zip_unsupported', `不支持的 zip 写法：${message}`, { details: { reason, ...details } });

/** 找结尾记录：从文件末尾往前找，它的注释必须正好结束在文件末尾。 */
function findEndRecord(bytes, dv) {
  if (bytes.length < Z.EOCD_SIZE) throw malformed('too_short', '文件太短，不是 zip');
  const lowest = Math.max(0, bytes.length - Z.EOCD_SIZE - 0xffff);
  for (let pos = bytes.length - Z.EOCD_SIZE; pos >= lowest; pos--) {
    if (dv.getUint32(pos, true) !== Z.SIG_EOCD) continue;
    if (pos + Z.EOCD_SIZE + dv.getUint16(pos + 20, true) !== bytes.length) continue;
    return pos;
  }
  throw malformed('no_end_record', '找不到结尾记录：这不是 zip，或者文件被截断，或者末尾多了别的字节');
}

/**
 * 读结尾记录和中央目录，检查每个条目，给出条目的清单。
 * @returns {{ records: object[], files: object[], directories: string[], centralOffset: number }}
 */
export function readStructure(bytes, limits) {
  const dv = Z.viewOf(bytes);
  const eocd = findEndRecord(bytes, dv);
  const diskNo = dv.getUint16(eocd + 4, true);
  const centralDisk = dv.getUint16(eocd + 6, true);
  const onDisk = dv.getUint16(eocd + 8, true);
  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  if (diskNo !== 0 || centralDisk !== 0) throw unsupported('multi_disk', '分卷的 zip');
  if (onDisk !== count) throw malformed('entry_count_mismatch', '结尾记录里两处条目数不一样');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || (eocd >= 20 && dv.getUint32(eocd - 20, true) === Z.SIG_EOCD64_LOCATOR)) {
    throw unsupported('zip64', 'zip64（条目超过 65535 个或者文件超过 4 GiB）');
  }
  assertMemberCount(count, limits);
  if (centralOffset + centralSize !== eocd) throw malformed('central_directory_position', '中央目录的位置和大小，对不上结尾记录的位置（前面多了字节，或者中央目录和结尾记录之间多了字节）');

  const records = [];
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    if (at + Z.CENTRAL_HEADER_SIZE > eocd) throw malformed('central_header_truncated', `第 ${index + 1} 个条目的头被截断`, { index });
    if (dv.getUint32(at, true) !== Z.SIG_CENTRAL) throw malformed('central_header_signature', `第 ${index + 1} 个条目的头没有 PK\\x01\\x02 标记`, { index });
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const end = at + Z.CENTRAL_HEADER_SIZE + nameLen + extraLen + dv.getUint16(at + 32, true);
    if (end > eocd) throw malformed('central_header_truncated', `第 ${index + 1} 个条目的头被截断`, { index });
    records.push({
      index,
      flags: dv.getUint16(at + 8, true),
      method: dv.getUint16(at + 10, true),
      crc: dv.getUint32(at + 16, true),
      compressedSize: dv.getUint32(at + 20, true),
      size: dv.getUint32(at + 24, true),
      diskStart: dv.getUint16(at + 34, true),
      attr: dv.getUint32(at + 38, true),
      offset: dv.getUint32(at + 42, true),
      nameBytes: bytes.subarray(at + Z.CENTRAL_HEADER_SIZE, at + Z.CENTRAL_HEADER_SIZE + nameLen),
      extra: bytes.subarray(at + Z.CENTRAL_HEADER_SIZE + nameLen, at + Z.CENTRAL_HEADER_SIZE + nameLen + extraLen),
    });
    at = end;
  }
  if (at !== eocd) throw malformed('central_directory_size', '中央目录里，最后一个条目之后还有多余的字节');

  const files = [];
  const directories = [];
  let total = 0;
  for (const rec of records) {
    describe(rec);
    if (rec.isDirectory) directories.push(rec.name);
    else files.push(rec);
  }
  for (const rec of records) {
    assertMemberSize(rec.path, rec.size, limits);
    total += rec.size;
    assertTotalSize(total, limits);
  }
  checkNameConflicts(files, directories);
  return { records, files, directories, centralOffset };
}

/** 解码名字，检查类型、压缩方法、声明的大小，把结果写回记录。 */
function describe(rec) {
  if (rec.diskStart !== 0) throw unsupported('multi_disk', '分卷的 zip');
  if (rec.flags & ENCRYPTION_FLAGS) throw unsupported('encrypted', '加密的 zip');
  if (rec.method !== Z.METHOD_STORE && rec.method !== Z.METHOD_DEFLATE) throw unsupported('method', `压缩方法 ${rec.method}（只认存储 0 和 deflate 8）`, { method: rec.method });
  if (rec.compressedSize === 0xffffffff || rec.size === 0xffffffff || rec.offset === 0xffffffff) throw unsupported('zip64', 'zip64');
  let name;
  try {
    name = decoder.decode(rec.nameBytes);
  } catch (cause) {
    throw new VoicePackError('zip_bad_name', `第 ${rec.index + 1} 个条目的名字不是合法的 UTF-8`, { details: { index: rec.index }, cause });
  }
  rec.isDirectory = name.endsWith('/');
  rec.path = rec.isDirectory ? name.slice(0, -1) : name;
  rec.name = rec.path;
  assertPackPath(rec.path);
  const mode = rec.attr >>> 16;
  const type = mode & Z.S_IFMT;
  if (type === Z.S_IFLNK) throw new VoicePackError('symlink_not_allowed', `${JSON.stringify(rec.path)} 是符号链接：音色包里不允许有符号链接`, { details: { path: rec.path, mode } });
  if (type !== 0 && type !== Z.S_IFREG && type !== Z.S_IFDIR) throw new VoicePackError('member_type_not_allowed', `${JSON.stringify(rec.path)} 不是普通文件或目录（设备文件、管道之类不允许）`, { details: { path: rec.path, mode } });
  if (rec.isDirectory && (type === Z.S_IFREG || rec.size !== 0)) throw malformed('directory_entry_has_data', `${JSON.stringify(name)} 的名字是目录，属性或大小却说它是文件`, { path: rec.path });
  if (!rec.isDirectory && (type === Z.S_IFDIR || (rec.attr & 0x10) !== 0)) throw malformed('file_entry_marked_directory', `${JSON.stringify(name)} 的名字是文件，属性却说它是目录`, { path: rec.path });
}

/** 文件之间、目录之间、文件和目录之间不能撞车。目录可以嵌套，所以目录只比对精确重名和文件名。 */
function checkNameConflicts(files, directories) {
  const conflict = findPathConflict(files.map((f) => f.path));
  if (conflict) throw new VoicePackError('path_conflict', `成员 ${JSON.stringify(conflict.path)} 和 ${JSON.stringify(conflict.other)} 冲突（${conflict.kind}）：解到磁盘上会互相覆盖`, { details: conflict });
  const fileKeys = new Map(files.map((f) => [collisionKey(f.path), f.path]));
  const seen = new Map();
  for (const dir of directories) {
    const key = collisionKey(dir);
    if (fileKeys.has(key)) throw new VoicePackError('path_conflict', `目录 ${JSON.stringify(dir)} 和文件 ${JSON.stringify(fileKeys.get(key))} 同名`, { details: { kind: 'file_dir_conflict', path: dir, other: fileKeys.get(key) } });
    if (seen.has(key)) throw new VoicePackError('path_conflict', `目录 ${JSON.stringify(dir)} 出现了两次`, { details: { kind: 'duplicate', path: dir, other: seen.get(key) } });
    seen.set(key, dir);
  }
}
