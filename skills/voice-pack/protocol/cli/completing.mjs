// SPDX-License-Identifier: Apache-2.0
//
// 补全的命令行层（complete 命令用）：库（protocol/lib/complete.mjs）不碰文件系统，读目录、找环境里已有的基础部分、把补全来的基础部分写进包里，都在这里。
// 这是命令行层（protocol/cli/ 里），可以用 node:fs；核心层的程序不碰文件系统。
//
// environmentCandidates(packDir, cwd)
//   找环境里已有的基础部分（目录名跟包的协议版本走，names.mjs 的表；<名字> 就是它），按这个次序，找得到的才算（不存在的、不是目录的略过）：
//     1 和包放在同一个 skill 目录里的：<包目录的上一级>/<名字>
//     2 项目的 .agents/skills/<名字>
//     3 项目的 .claude/skills/<名字>
//   项目根：包放在 <项目>/.agents/skills/<包 ID> 或 <项目>/.claude/skills/<包 ID> 里，项目根就是那个 <项目>；再加当前目录。两个都有就都看，先看包的。
//   同一个目录（符号链接指过去的也算）只看一次。只读它的四个文件：基础部分的清单和签名、里面协议核心的清单和签名（环境里原有的那一部分，不重新算哈希）。
//   这四个文件都不大（清单不超过 JSON 的上限 1 MiB，签名文件几百字节）；大得离谱的、不是普通文件的，当作没有。
//   返回库要的样子：[{ location（绝对路径）, manifest, signature, coreManifest, coreSignature }]（字节，没有的是 null）。
//
// installBasePart(packDir, files, { rename })
//   把补全来的基础部分（文件集，路径相对基础部分的目录）放进 <包目录>/<名字>/（名字同上，由调用方给：补全的结果里有 directory）。先在临时目录里写好，最后一步才改名成 <名字>/：
//   任何一步失败，都把这一趟自己创建的临时目录清掉再抛错，包目录和补全之前一样，不留下半个目录。
//   临时目录建在包目录里面，名字是 .<名字>.completing-<随机>：和 <名字>/ 在同一个目录，所以最后一步一定是同一个文件系统里的一次改名（包目录是符号链接、
//   是挂载点，也不会因为跨文件系统改不了名）。进程被杀掉时可能留下它（没来得及清）：名字说明了是什么，手动删掉就行；包里多出它，check 会报 file_extra，点名是它。
//   <包目录>/<名字> 已经存在（哪怕是空目录）就拒绝，什么都不写。
//   刚写完的文件在 Windows 上可能被杀毒软件、索引服务短暂占着，最后一步改名遇到 EPERM、EBUSY、EACCES 时隔一会儿重试几次，再不行才报错。
//   rename 是改名用的函数，默认 fs.renameSync；测试用来注入失败。返回写好的目录的绝对路径。
//
// 抛的 code（VoicePackError）：
//   file_exists           <包目录>/<名字> 已经存在，不往里写（也不覆盖）；包括写临时目录的时候，同一个包的另一次补全抢先放好了它（改名那一刻才发现，不重试，临时目录清掉）
//   file_unwritable       包目录不存在（不替它新建）；或者写不了（磁盘满、没有权限、最后一步改名不成），写了一半的临时目录已清掉
//   以及 disk.mjs 的 path_unsafe 等（写之前核对每个路径）
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../lib/errors.mjs';
import { toHex } from '../lib/bytes.mjs';
import { MANIFEST_FILE, SIGNATURE_FILE, PROTOCOL_DIRECTORY } from '../lib/manifest.mjs';
import { CURRENT_NAMES } from '../lib/names.mjs';
import { DEFAULT_LIMITS } from '../lib/limits.mjs';
import { writeDirectory } from './disk.mjs';

const SKILL_ROOTS = [['.agents', 'skills'], ['.claude', 'skills']];
const MAX_SMALL_FILE = DEFAULT_LIMITS.maxJsonBytes;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_RETRY_MS = 50;

/** 读一个小文件：不存在、不是普通文件、大得离谱，都是 null。 */
function readSmall(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SMALL_FILE) return null;
    const bytes = fs.readFileSync(file);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}

/** 环境里可能放着基础部分的几个位置，按次序（绝对路径，不管存不存在）。 */
export function searchLocations(packDir, cwd, directory = CURRENT_NAMES.baseDirectory) {
  const skillsDir = path.dirname(packDir);
  const found = [path.join(skillsDir, directory)];
  const roots = [];
  const holder = path.dirname(skillsDir);
  if (path.basename(skillsDir) === 'skills' && ['.agents', '.claude'].includes(path.basename(holder))) roots.push(path.dirname(holder));
  roots.push(cwd);
  for (const skillRoot of SKILL_ROOTS) for (const root of roots) found.push(path.join(root, ...skillRoot, directory));
  return found;
}

export function environmentCandidates(packDir, cwd, directory = CURRENT_NAMES.baseDirectory) {
  const seen = new Set();
  const candidates = [];
  for (const location of searchLocations(path.resolve(packDir), path.resolve(cwd), directory)) {
    let real;
    try {
      real = fs.realpathSync(location);
      if (!fs.statSync(real).isDirectory()) continue;
    } catch {
      continue; // 没有这个目录
    }
    if (seen.has(real)) continue;
    seen.add(real);
    candidates.push({
      location,
      manifest: readSmall(path.join(location, MANIFEST_FILE)),
      signature: readSmall(path.join(location, SIGNATURE_FILE)),
      coreManifest: readSmall(path.join(location, PROTOCOL_DIRECTORY, MANIFEST_FILE)),
      coreSignature: readSmall(path.join(location, PROTOCOL_DIRECTORY, SIGNATURE_FILE)),
    });
  }
  return candidates;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function renameInto(rename, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (cause) {
      // 改名前一刻还不存在的目标现在存在了：别的进程（同一个包同时在补全）抢先放好了。说实话，不当成「被占着」重试，也不去覆盖它
      if (pathExists(to)) throw new VoicePackError('file_exists', `${to} 已经存在（别的进程刚补好了？）：这一趟写好的临时目录已清掉，没有覆盖它。先用 check 看看它是不是完整的`, { details: { file: to }, cause });
      if (RENAME_RETRY_CODES.has(cause?.code) && attempt < RENAME_ATTEMPTS) {
        await sleep(RENAME_RETRY_MS * attempt);
        continue;
      }
      throw new VoicePackError('file_unwritable', `最后一步把写好的基础部分改名成 ${to} 没成（${cause?.code ?? '未知原因'}），临时目录已清掉，包目录和补全之前一样`, { details: { file: to }, cause });
    }
  }
}

/** lstat：悬空的符号链接也算存在。 */
function pathExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export async function installBasePart(packDir, files, { rename = fs.renameSync, directory = CURRENT_NAMES.baseDirectory } = {}) {
  const pack = path.resolve(packDir);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(pack).isDirectory();
  } catch {
    // 不存在，或者读不了：下面一并报
  }
  if (!isDirectory) throw new VoicePackError('file_unwritable', `${pack} 不是一个已存在的目录：补全是往已有的包目录里放基础部分，不新建包目录`, { details: { file: pack } });
  const destination = path.join(pack, directory);
  let exists = true;
  try {
    fs.lstatSync(destination); // lstat：悬空的符号链接也算存在
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw new VoicePackError('file_unwritable', `读不了 ${destination}（${cause?.code ?? '未知原因'}）`, { details: { file: destination } });
    exists = false;
  }
  if (exists) throw new VoicePackError('file_exists', `${destination} 已存在，不往里写，也不覆盖：先自己把它移走，再补全`, { details: { file: destination } });

  const staging = path.join(pack, `.${directory}.completing-${toHex(globalThis.crypto.getRandomValues(new Uint8Array(4)))}`);
  writeDirectory(staging, files); // 写不下去时它自己把这一趟创建的目录清掉
  try {
    await renameInto(rename, staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true }); // 这一趟自己创建的：writeDirectory 确认过它原来不存在
    throw error;
  }
  return destination;
}
