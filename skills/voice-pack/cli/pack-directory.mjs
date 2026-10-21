// SPDX-License-Identifier: Apache-2.0
//
// 命令行层打开一个包目录来用：按需读文件（lib/voice-pack.mjs 的 read 回调），不把整个包读进内存。Node 专有（node:fs），所以放在命令行层。
//
//   openPackDirectory(ctx, argument, { env })   argument 是命令行里写的包目录（相对 ctx.cwd）；返回 { pack, dir }，pack 是 openVoicePack 打开的角色部分，
//                                               dir 是包目录的绝对路径（脚本在这里运行，输出的下一步命令里也用它）
//
// 读文件的规则：路径是清单里的路径（用 /，相对包目录），解出来必须在包目录里面；符号链接不跟（包里不允许符号链接，和 protocol/cli/disk.mjs 一致），
// 读到的是符号链接就抛 symlink_not_allowed；文件不存在给 null（由 openVoicePack 报 file_missing，带着它知道的清单路径）。
// 包目录本身是符号链接时照常跟着走：把包目录链接进 .agents/skills/ 是正当的做法。
//
// 抛出的错误（VoicePackError）：
//   file_unreadable       包目录不存在、不是目录，或者读不了文件（来自 protocol/cli/disk.mjs 的同名 code，意思相同）
//   symlink_not_allowed   包里有符号链接。details.path
//   另外 manifest_missing、manifest_*、pack_not_role 来自 lib/voice-pack.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { openVoicePack } from '../lib/voice-pack.mjs';

function directorySource(root) {
  return {
    async read(relative) {
      const target = path.resolve(root, ...relative.split('/'));
      const within = path.relative(root, target);
      if (within === '' || within.startsWith('..') || path.isAbsolute(within)) return null; // 路径在 voice-pack 里已经核对过，这里再守一道
      let stat;
      try {
        stat = fs.lstatSync(target);
      } catch (cause) {
        if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') return null;
        throw new VoicePackError('file_unreadable', `读不了 ${target}（${cause?.code ?? '未知原因'}）`, { details: { file: target, what: '包里的文件' } });
      }
      if (stat.isSymbolicLink()) throw new VoicePackError('symlink_not_allowed', `${JSON.stringify(relative)} 是符号链接：音色包里不允许符号链接（它可能指到包外面去）`, { details: { path: relative } });
      if (!stat.isFile()) return null;
      try {
        return new Uint8Array(fs.readFileSync(target));
      } catch (cause) {
        throw new VoicePackError('file_unreadable', `读不了 ${target}（${cause?.code ?? '未知原因'}）`, { details: { file: target, what: '包里的文件' } });
      }
    },
  };
}

export async function openPackDirectory(ctx, argument, { env } = {}) {
  const requested = path.resolve(ctx.cwd, argument);
  let dir;
  try {
    dir = fs.realpathSync(requested);
    if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
  } catch (cause) {
    throw new VoicePackError('file_unreadable', `读不了包目录：${requested}（${cause?.code ?? '未知原因'}）`, { details: { file: requested, what: '包目录' } });
  }
  return { pack: await openVoicePack(directorySource(dir), { env }), dir };
}
