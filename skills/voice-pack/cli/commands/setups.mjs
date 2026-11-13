// SPDX-License-Identifier: Apache-2.0
//
// setups：原地保存、删除一个包当前版本的设定（setups），不出新版本。make-pack --previous 改设定必出新版本；这里只改这一个目录里的 manifest.json（设定在清单里），
// 以及清单里记着 size 和 sha256 的 SKILL.md（骨架里有一句取决于有没有设定写了 referenceTag，改完按现在的清单重新生成，字节没变就不写）。规则、校验和错误只在 lib/pack-setups.mjs 的文件头写。
//
//   node cli.mjs setups save <包目录> --setup <一套设定.json> [--json]
//     保存一套设定：文件是一个 JSON 对象 { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }（字段同 make-pack 的 --setups 的每一项，写法见 protocol/FORMAT.md 4.4）。
//     同名就覆盖，没有就新增；带 default: true 时别的设定的 default 去掉。文件名写 - 是从标准输入读。
//   node cli.mjs setups delete <包目录> --name <名字> [--json]
//     删一套设定。删到一套不剩，清单里就没有 setups 这个字段；删掉默认的那一套，包就没有默认设定，不自动指定别的。
//   node cli.mjs setups save --help、setups delete --help：打印这个子命令的用法，退出 0。
//
// 只改给的这一个目录。装在别处的同一个包的副本、已经导出的分享文件不会变，要各改各的。
// 包目录里有符号链接、特殊文件，或者超过解包上限，拒绝；包本身不完好（文件对不上清单……）也拒绝，报它原来的错，什么都不写。
//
// 写盘：要换的文件（最多两个）先在包目录里写成临时文件 .tmp-setups-<进程号>-<序号>（同一个盘，写完才改名），再 rename 盖过去：先换 SKILL.md，再换 manifest.json。
// 换第二个失败，就把第一个用事先留好的旧字节换回来；任何一步失败，临时文件都清掉，目录和原来一样（回滚也失败的，错误的 details.rollbackFailed 列出哪些文件没能换回来）。
// 同一个目录两个进程同时改不处理，不加锁：后写的盖掉先写的，每一次写盘本身不会写出半个文件。
// 新保存的和旧的一模一样：照常成功，不写盘。
//
// 退出码：0 成功（含「什么都没变」）；1 失败（包有问题、设定过不了、名字不存在、读写失败）；2 用法错误。
// 错误（退出 1，报告里是 code）：来自 lib/pack-setups.mjs 的（pack_setup_invalid、setup_not_found、pack_not_role、pack_protocol_old，以及包本身不完好的 code），
//   setup_file_invalid   --setup 的文件不是合法的 UTF-8 JSON，或者内容不是一个 JSON 对象。details: { file }
//   pack_setup_invalid   除了 lib/pack-setups.mjs 报的，还有设定的名字是 --json：命令行把它当输出格式的选项，存进去以后 setups delete 删不掉。details: { name, problems }
//   file_unreadable      读不了包目录或 --setup 的文件（cli/input.mjs、protocol/cli/disk.mjs）
//   file_unwritable      换文件失败（已经回滚）。details: { file, rollbackFailed? }
//   还有读目录时的 symlink_not_allowed、file_type_unsupported、too_many_members、member_too_large、total_too_large（protocol/cli/disk.mjs）。
// --json：成功时输出 { status: 'added' | 'replaced' | 'deleted', name, setups }，setups 是改完的整份（没有了是空数组）。不加 --json：一两行说明。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError, isVoicePackError } from '../../protocol/lib/errors.mjs';
import { MANIFEST_FILE, readManifest } from '../../protocol/lib/manifest.mjs';
import { readDirectory } from '../../protocol/cli/disk.mjs';
import { saveSetup, deleteSetup } from '../../lib/pack-setups.mjs';
import { isPlainObject, parseArgs, readText, usageProblem } from '../input.mjs';

const SAVE_USAGE = 'setups save <pack directory> --setup <setup.json> [--json]';
const DELETE_USAGE = 'setups delete <pack directory> --name <name> [--json]';

export const summary = 'Save or delete a setup of the current version of a pack in place (no new version): save overwrites one with the same name or adds a new one, delete removes by name';
export const usage = `${SAVE_USAGE}\n      or: node cli.mjs ${DELETE_USAGE}`;

/** 命令认的选项：save 和 delete 两个子命令的合起来（--json 由 runner 取走）。约定见 cli/input.mjs 文件头。 */
export const FLAGS = { setup: 'string', name: 'string' };

const SUBCOMMANDS = {
  save: { usage: SAVE_USAGE, summary: 'Save a setup: one with the same name is overwritten, otherwise a new one is added; only manifest.json (and SKILL.md if it changed) in this one directory is changed, and no new version is made' },
  delete: { usage: DELETE_USAGE, summary: 'Delete a setup by name; when none is left, the manifest has no setups; only this one directory is changed, and no new version is made' },
};

const TEMP_PREFIX = '.tmp-setups-';

// ---------------------------------------------------------------- 写盘

/**
 * 把 changed（路径 -> 新字节）写进包目录 dir：先写临时文件，再 rename 盖过去，SKILL.md 在 manifest.json 前面；
 * 后一个失败，前一个用 original 里的旧字节换回来。任何一步失败，临时文件都清掉再抛 file_unwritable。
 * @param {string} dir 包目录（绝对路径）
 * @param {Map<string, Uint8Array>} changed
 * @param {Map<string, Uint8Array>} original 读目录时的文件集（旧字节从这里来，提前留好的）
 * @param {{ rename?: (from: string, to: string) => void }} [options] rename 是换文件用的函数，默认 fs.renameSync（测试注入一个会失败的）
 */
export function replaceFiles(dir, changed, original, { rename = fs.renameSync } = {}) {
  const order = ['SKILL.md', MANIFEST_FILE].filter((name) => changed.has(name));
  const target = (name) => path.join(dir, ...name.split('/'));
  const leftovers = []; // 还留在目录里的临时文件：写好了没改名的、换回来用的
  const swapped = []; // 已经换过去的路径
  let working = dir; // 正在处理的目标文件，出错时点名它
  try {
    order.forEach((name, index) => {
      working = target(name);
      const temp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${index}`);
      try {
        fs.writeFileSync(temp, changed.get(name), { flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') leftovers.push(temp); // 位置上本来就有东西（不是这一趟建的）：不动它；别的原因写了一半的，清掉
        throw error;
      }
      leftovers.push(temp);
    });
    order.forEach((name, index) => {
      working = target(name);
      rename(leftovers[index], working);
      swapped.push(name);
    });
  } catch (cause) {
    const rollbackFailed = [];
    for (const name of swapped.reverse()) {
      const back = path.join(dir, `${TEMP_PREFIX}${process.pid}-back-${leftovers.length}`);
      leftovers.push(back);
      try {
        fs.writeFileSync(back, original.get(name), { flag: 'wx' });
        fs.renameSync(back, target(name)); // 换回来用真的 rename：注入的 rename 只管往前换
      } catch {
        rollbackFailed.push(name);
      }
    }
    for (const temp of leftovers) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // 清不掉也不盖过真正的错误；它留在目录里，下一次读包会当成多出来的文件报出来
      }
    }
    const reason = cause?.code ?? 'unknown reason';
    throw new VoicePackError('file_unwritable', `Cannot write ${working} (${reason}): ${rollbackFailed.length === 0 ? 'the directory was restored to how it was' : `it could not be fully restored; these files could not be put back: ${rollbackFailed.join(', ')}`}`, { details: { file: working, ...(rollbackFailed.length > 0 ? { rollbackFailed } : {}) }, cause });
  }
}

// ---------------------------------------------------------------- 读输入

/** 读 --setup 指的文件：UTF-8 的 JSON 对象。 */
function readSetupFile(ctx, argument) {
  let text;
  try {
    text = readText(ctx, argument);
  } catch (cause) {
    if (isVoicePackError(cause, 'input_not_text')) throw new VoicePackError('setup_file_invalid', `The --setup file is not UTF-8 text: ${argument}`, { details: { file: argument }, cause });
    throw cause;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('setup_file_invalid', `The --setup file is not valid JSON: ${argument}`, { details: { file: argument }, cause });
  }
  if (!isPlainObject(value)) throw new VoicePackError('setup_file_invalid', `The content of the --setup file must be a JSON object (one setup): ${argument}`, { details: { file: argument } });
  return value;
}

/** 读包目录成文件集；读不出完整的（符号链接、特殊文件、超过上限）就拒绝，报读目录给的第一个问题。 */
function readPack(ctx, argument) {
  const dir = path.resolve(ctx.cwd, argument);
  const { files, problems } = readDirectory(dir);
  if (problems.length > 0) {
    const [first] = problems;
    throw new VoicePackError(first.code, first.message, { details: { ...first.details, problems } });
  }
  return { dir, files };
}

// ---------------------------------------------------------------- 输出

const SENTENCE = {
  added: (name, count) => `Added setup ${JSON.stringify(name)}; the pack now has ${count} ${count === 1 ? 'setup' : 'setups'}`,
  replaced: (name, count) => `Saved setup ${JSON.stringify(name)} (overwrote the one with the same name); the pack now has ${count} ${count === 1 ? 'setup' : 'setups'}`,
  deleted: (name, count) => `Deleted setup ${JSON.stringify(name)}; ${count === 0 ? 'the pack now has no setups' : `${count} ${count === 1 ? 'setup' : 'setups'} left`}`,
};

function respond(ctx, { dir, files, changed, report }) {
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const manifest = readManifest(files.get(MANIFEST_FILE)).manifest;
  const written = [...changed.keys()];
  ctx.stdout(`${SENTENCE[report.status](report.name, report.setups.length)} (pack ${manifest.id}, version ${manifest.version} unchanged)\n`);
  ctx.stdout(written.length === 0 ? 'No file was changed (the new content is identical to the old)\n' : `Changed ${written.map((name) => path.join(dir, name)).join(', ')}\n`);
  return 0;
}

// ---------------------------------------------------------------- 子命令

async function runSave(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, SAVE_USAGE, parsed.problem ?? 'Give one pack directory (only one)');
  if (parsed.options.setup === undefined) return usageProblem(ctx, SAVE_USAGE, 'Give --setup <setup.json>');
  if (parsed.options.name !== undefined) return usageProblem(ctx, SAVE_USAGE, 'save does not take --name: the name is written in the setup file');
  const setup = readSetupFile(ctx, parsed.options.setup);
  if (setup.name === '--json') {
    const message = 'A setup cannot be named --json: the command line treats it as the output-format option, so once stored under this name, setups delete could not delete it';
    throw new VoicePackError('pack_setup_invalid', message, { details: { name: setup.name, problems: [{ code: 'setup_name_reserved', message, details: { name: setup.name } }] } });
  }
  const { dir, files } = readPack(ctx, parsed.positional[0]);
  const { changed, report } = await saveSetup(files, setup);
  replaceFiles(dir, changed, files);
  return respond(ctx, { dir, files, changed, report });
}

async function runDelete(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, DELETE_USAGE, parsed.problem ?? 'Give one pack directory (only one)');
  if (parsed.options.name === undefined) return usageProblem(ctx, DELETE_USAGE, 'Give --name <name>');
  if (parsed.options.setup !== undefined) return usageProblem(ctx, DELETE_USAGE, 'delete does not take --setup');
  const { dir, files } = readPack(ctx, parsed.positional[0]);
  const { changed, report } = await deleteSetup(files, parsed.options.name);
  replaceFiles(dir, changed, files);
  return respond(ctx, { dir, files, changed, report });
}

export async function run(args, ctx) {
  const [subcommand, ...rest] = args;
  if (Object.hasOwn(SUBCOMMANDS, subcommand ?? '') && (rest[0] === '--help' || rest[0] === '-h')) {
    ctx.stdout(`Usage: node cli.mjs ${SUBCOMMANDS[subcommand].usage}\n${SUBCOMMANDS[subcommand].summary}\n`);
    return 0;
  }
  if (subcommand === 'save') return runSave(rest, ctx);
  if (subcommand === 'delete') return runDelete(rest, ctx);
  return usageProblem(ctx, usage, subcommand === undefined ? 'Give a subcommand: save (save a setup) or delete (delete a setup)' : `Unknown subcommand ${subcommand} (there are: save, delete)`);
}
