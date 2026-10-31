// SPDX-License-Identifier: Apache-2.0
//
// 命令行层读输入、解析选项的几个小函数。命令的文件放在 cli/commands/（那里的每个 .mjs 都会被当成命令），所以公共的东西放在命令之外的模块里：
// 一个命令的文件不引用另一个命令的文件；小函数放在这里（isPlainObject 也只在这里定义一份），成块的东西放在 cli/ 下各自的模块
// （例如 audio-files.mjs 管音频后缀和 MIME 类型，evaluation-set.mjs 管评测集的读写，fidelity-report.mjs 管还原度报告的文字，两个命令都要用）。
// 只有命令行层能用 node:fs。
//
// 命令的选项：每个命令导出 FLAGS（传给 parseArgs 的那份选项表，没有选项的导出 {}）和 usage（--help 只显示它）。用法里要写出 FLAGS 里的每个选项，写的每个选项也要真的认
// （--json 由 runner 在命令看到参数之前取走，适配器的参数由 cli/adapters.mjs 的 takeAdapterArguments 取走，这两类不在表里）。
//
// 错误码（谁抛谁定义）：
//   file_unreadable   读不了命令行给的输入（和 protocol/cli/signing.mjs 抛的是同一个错误码，意思相同）。details.file 是命令行里写的那个参数（标准输入是 '-'），details.reason 是系统给的原因（例如 ENOENT）；
//                     不带文件内容，也不带底层错误。
//   input_not_text    输入不是 UTF-8 的文字。details.file 同上。台本、分句的输入要 UTF-8。
//   file_exists       要写出的路径已经存在（assertFresh；和 protocol/cli/disk.mjs 抛的是同一个错误码，意思相同）。details.file 是那个路径。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../protocol/lib/errors.mjs';

/** 是不是 JSON 里的对象：{} 算，数组、null、字符串、数字都不算。命令行层读进来的 JSON 先过这一关。 */
export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 要写出的路径（文件或目录）必须还不存在：已经有了就拒绝，不覆盖，也不往已有的目录里写（file_exists）。
 * 花钱的命令在花钱之前就用它查，免得做完才发现写不下；真的写的时候，写文件的函数（protocol/cli/disk.mjs）还会再拒绝一次（两次之间有人建了它的话）。
 * 悬空的符号链接也算「已经存在」（写文件时它同样会被拒绝）。查不了（没有权限之类）的不在这里报，留给真的写的时候说清原因。
 */
export function assertFresh(target) {
  let exists = false;
  try {
    exists = fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // 查不了：让真的写的时候报
  }
  if (exists) throw new VoicePackError('file_exists', `${target} 已经存在，不覆盖：换一个新的名字，或者先自己挪走旧的`, { details: { file: String(target) } });
}

/** 读输入的全部字节：参数是路径（相对 ctx.cwd）或 `-`（标准输入）。 */
export function readBytes(ctx, argument) {
  try {
    return new Uint8Array(argument === '-' ? fs.readFileSync(0) : fs.readFileSync(path.resolve(ctx.cwd, argument)));
  } catch (cause) {
    const reason = cause?.code ?? 'unknown';
    throw new VoicePackError('file_unreadable', `读不了输入 ${argument}（${reason}）`, { details: { file: argument, reason } });
  }
}

/** 读 UTF-8 文字。不是合法的 UTF-8 就报错，不悄悄换成乱码。开头的 BOM 去掉。 */
export function readText(ctx, argument) {
  const bytes = readBytes(ctx, argument);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new VoicePackError('input_not_text', `${argument} 不是 UTF-8 的文字（先转成 UTF-8）`, { details: { file: argument } });
  }
}

/**
 * 解析命令的参数：`--名字 值` 形式的选项和位置参数。`-` 单独出现算位置参数（标准输入）。
 * @param {string[]} args
 * strings 的选项可以给好几次：值是数组，次序就是命令行上的次序（没给就没有这个键）。
 * @param {Record<string, 'string'|'number'|'boolean'|'strings'>} [flags] 认识的选项（不带 --）和它的值的类型；boolean 的选项不跟值，出现了就是 true
 * @returns {{ positional: string[], options: Record<string, string|number|boolean|string[]> } | { problem: string }} 用法有问题时返回 { problem }
 */
export function parseArgs(args, flags = {}) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-' || !arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!Object.hasOwn(flags, name)) return { problem: `不认识的选项 ${arg}` };
    if (flags[name] === 'boolean') {
      options[name] = true;
      continue;
    }
    if (flags[name] === 'strings') {
      const value = args[++i];
      if (value === undefined) return { problem: `选项 ${arg} 后面要跟一个值` };
      options[name] = [...(options[name] ?? []), value];
      continue;
    }
    const value = args[++i];
    if (value === undefined) return { problem: `选项 ${arg} 后面要跟一个值` };
    if (flags[name] === 'number') {
      const number = Number(value);
      if (value.trim() === '' || !Number.isFinite(number)) return { problem: `选项 ${arg} 要的是数字，收到 ${value}` };
      options[name] = number;
    } else options[name] = value;
  }
  return { positional, options };
}

/** 用法有问题：把用法和问题写到标准错误，返回退出码 2。 */
export function usageProblem(ctx, usage, problem) {
  ctx.stderr(`用法：node cli.mjs ${usage}\n${problem ? `${problem}\n` : ''}`);
  return 2;
}
