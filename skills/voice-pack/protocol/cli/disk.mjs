// SPDX-License-Identifier: Apache-2.0
//
// 命令行层读写磁盘：目录和文件集（Map<路径, Uint8Array>）互转，写出单个文件。库不碰文件系统（protocol/README.md「模块约定」第 4 条），
// 要读写目录的命令（pack、unpack、check、seal）都走这里，所以「目录里什么算一个文件」只在这一处定。
//
// readDirectory(root, { limits })  →  { files, problems }
//   读一个目录里的全部文件，路径用 /，相对 root，按 UTF-8 字节序排。空目录不产生任何条目（和读 zip 一致）。
//   不跟着链接走：符号链接（Windows 上的目录联接也一样）、设备、管道、套接字都不收，报成问题而不是悄悄略过。
//   root 本身是符号链接时照常跟着走：用户把包目录链接进 .agents/skills/ 是正当的做法，不算「包里有链接」。
//   同样的解包上限（成员数、单个大小、总大小）在读之前按文件大小核对，超了的不读进内存。
//   problems[]  { code, message, part: '', details }，形状和 checkPart 的问题一样，命令可以直接并进报告：
//     symlink_not_allowed     details: { path }
//     file_type_unsupported   details: { path }
//     too_many_members        details: { count, limit }（读到上限就停，count 是读到这里数到的，文字写「至少 count 个」）
//     member_too_large        details: { path, size, limit }（这个文件不读，其余照读）
//     total_too_large         details: { total, limit }（读到上限就停，total 同样是读到这里的，文字写「至少」）
//   三种超限的文字和 details 来自 lib/limits.mjs，和读写 zip、检查文件集时说的一样。
//   有问题时 files 只是读到的那一部分，调用方不能当作这个目录的内容去用。
//   抛 file_unreadable：root 不存在、不是目录，或者读不了（没有权限）。
//
// writeDirectory(dest, files)
//   把文件集写成一个新目录。dest 必须不存在：不往已有的目录里写，也就不会盖掉里面的东西。
//   写之前先核对每个路径（过 paths.mjs 的检查，并且解出来的位置确实在 dest 里面），任何一个不过就一个文件都不写。
//   中途写失败（磁盘满、重名）时，把这一趟自己创建的 dest 清掉再抛错，不留半个包。
//   抛 file_exists、path_unsafe（details.reason 同 paths.mjs；escapes 是解出来跑到了 dest 外面）、file_unwritable。
//
// writeNewFile(file, bytes, { overwrite })
//   写一个文件，需要时创建上级目录。已经存在就拒绝，除非 overwrite。抛 file_exists、file_unwritable（建不出上级目录、写不进去都是它；
//   「路径上有一段是文件」是建不出目录，报 file_unwritable，不报 file_exists）。pack、sign 都走这里。
//
// pathKind(target, what)
//   'directory' 或 'file'（跟着链接走）。不存在、或者既不是目录也不是文件，抛 file_unreadable，what 写进说明里。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../lib/errors.mjs';
import { resolveLimits, memberCountProblem, memberSizeProblem, totalSizeProblem } from '../lib/limits.mjs';
import { compareUtf8, assertPackPath } from '../lib/paths.mjs';

const MAX_PROBLEMS = 50; // 一个满是链接的目录不会刷出海量的报告

const unreadable = (file, what, cause) => new VoicePackError('file_unreadable', `读不了${what}：${file}（${cause?.code ?? '未知原因'}）`, { details: { file: String(file), what } });

/**
 * @param {string} root 要读的目录
 * @param {{ limits?: object }} [options]
 * @returns {{ files: Map<string, Uint8Array>, problems: object[] }}
 */
export function readDirectory(root, options = {}) {
  const limits = resolveLimits(options.limits);
  const base = String(root);
  let stat;
  try {
    stat = fs.statSync(base); // 跟着 root 本身的链接走
  } catch (cause) {
    throw unreadable(base, '目录', cause);
  }
  if (!stat.isDirectory()) throw new VoicePackError('file_unreadable', `不是目录：${base}`, { details: { file: base, what: '目录' } });

  const files = new Map();
  const problems = [];
  const add = (code, message, details) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ code, message, part: '', details });
  };
  const addLimit = ({ code, message, details }) => add(code, message, details); // 超限的文字在 lib/limits.mjs 里写一份
  let members = 0;
  let total = 0;
  let stopped = false;

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      throw unreadable(dir, '目录', cause);
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      if (stopped) return;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        add('symlink_not_allowed', `${JSON.stringify(rel)} 是符号链接：音色包里不允许符号链接（它可能指到包外面去）`, { path: rel });
      } else if (entry.isDirectory()) {
        walk(full, rel);
      } else if (!entry.isFile()) {
        add('file_type_unsupported', `${JSON.stringify(rel)} 不是普通文件（设备、管道或套接字）：音色包里只能有普通文件`, { path: rel });
      } else {
        members += 1;
        if (members > limits.maxMembers) {
          addLimit(memberCountProblem(members, limits, { atLeast: true }));
          stopped = true;
          return;
        }
        let size;
        try {
          size = fs.lstatSync(full).size;
        } catch (cause) {
          throw unreadable(full, '文件', cause);
        }
        if (size > limits.maxMemberBytes) {
          addLimit(memberSizeProblem(rel, size, limits));
          continue;
        }
        total += size;
        if (total > limits.maxTotalBytes) {
          addLimit(totalSizeProblem(total, limits, { atLeast: true }));
          stopped = true;
          return;
        }
        let bytes;
        try {
          bytes = fs.readFileSync(full);
        } catch (cause) {
          throw unreadable(full, '文件', cause);
        }
        files.set(rel, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
    }
  };
  walk(base, '');
  // 一层一层读出来的次序是「先目录后文件」那样的，整条路径的字节序（'-' < '.' < '/'）不一样：最后按整条路径排一遍
  return { files: new Map([...files].sort((a, b) => compareUtf8(a[0], b[0]))), problems };
}

/**
 * @param {string} dest 要创建的目录，必须不存在
 * @param {Map<string, Uint8Array>} files
 */
export function writeDirectory(dest, files) {
  const root = path.resolve(String(dest));
  let exists = true;
  try {
    fs.lstatSync(root); // lstat：悬空的符号链接也算存在
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw new VoicePackError('file_unwritable', `写不了 ${root}（${cause?.code ?? '未知原因'}）`, { details: { file: root } });
    exists = false;
  }
  if (exists) throw new VoicePackError('file_exists', `${root} 已存在，不往已有的目录里写：换一个位置，或者先自己挪走旧的`, { details: { file: root } });

  const targets = [];
  for (const [rel, data] of files) {
    assertPackPath(rel);
    const target = path.resolve(root, ...rel.split('/'));
    const within = path.relative(root, target);
    if (within === '' || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      throw new VoicePackError('path_unsafe', `文件名不能要（解出来会跑到目录外面）：${JSON.stringify(rel)}`, { details: { path: rel, reason: 'escapes' } });
    }
    targets.push({ rel, target, data });
  }

  try {
    fs.mkdirSync(root, { recursive: true });
    for (const { target, data } of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flag: 'wx' });
    }
  } catch (cause) {
    fs.rmSync(root, { recursive: true, force: true }); // 只清这一趟自己创建的目录：上面确认过它原来不存在
    throw new VoicePackError('file_unwritable', `写不了 ${root}（${cause?.code ?? '未知原因'}），已把写了一半的目录清掉`, { details: { file: root }, cause });
  }
}

/**
 * @param {string} file
 * @param {Uint8Array} bytes
 * @param {{ overwrite?: boolean }} [options]
 */
export function writeNewFile(file, bytes, options = {}) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(String(file))), { recursive: true });
  } catch (cause) {
    // 建不出它所在的目录（路径上有一段是文件、没有权限……）：说的是目录建不出来，不是文件已经存在，所以不报 file_exists
    throw new VoicePackError('file_unwritable', `写不了 ${file}：建不出它所在的目录（${cause?.code ?? '未知原因'}）`, { details: { file: String(file) }, cause });
  }
  try {
    fs.writeFileSync(file, bytes, { flag: options.overwrite ? 'w' : 'wx' });
  } catch (cause) {
    if (cause?.code === 'EEXIST') throw new VoicePackError('file_exists', `${file} 已存在，不覆盖：换一个位置，或者先自己挪走旧的`, { details: { file: String(file) } });
    throw new VoicePackError('file_unwritable', `写不了 ${file}（${cause?.code ?? '未知原因'}）`, { details: { file: String(file) }, cause });
  }
}

/**
 * @param {string} target
 * @param {string} what 写进错误说明的名字，例如「要检查的路径」
 * @returns {'directory' | 'file'}
 */
export function pathKind(target, what) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (cause) {
    throw unreadable(target, what, cause);
  }
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  throw new VoicePackError('file_unreadable', `${what}既不是文件也不是目录：${target}`, { details: { file: String(target), what } });
}
