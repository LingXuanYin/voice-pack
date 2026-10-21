// SPDX-License-Identifier: Apache-2.0
//
// 命令行层的主体：把命令行参数变成对库的调用，把库的结果和错误变成输出和退出码。
// Node 专有的东西（node:fs、process……）只允许出现在这一层：名为 cli.mjs 的文件和名为 cli/ 的目录里，
// 库代码（protocol/lib、lib、tools、adapters 里的其他 .mjs）不碰它们。规则见 protocol/README.md「模块约定」。
//
// 命令
//   一个命令就是 <命令目录>/<名字>.mjs。名字是小写字母、数字和连字符，不能叫 help（内置）。
//   加命令只加文件，不改别的文件：协议核心的命令放 protocol/cli/commands/，流程层的命令放基础部分根上的 cli/commands/。
//   两层的命令名不能重复：重复就退出 2，不让一层悄悄盖住另一层。
//
//   export const summary = '一行说明（help 里显示）';   // 必填
//   export const usage = 'check <路径> [--json]';         // 可选，<命令> --help 和 help <命令> 里显示
//   export async function run(args, ctx) { ... return 0; } // 必填；args 是命令名之后的参数
//
//   run 的返回值是退出码（0–255 的整数；不返回就是 0）。抛出 VoicePackError，这里统一报告 code 并退出 1；
//   抛出别的错误算内部错误，也退出 1。
//
//   ctx 是这一层给命令的上下文：
//     env        注入的运行环境 { capabilities, fetch, runtimes }（形状见 protocol/README.md「运行环境」）。
//                缺了的东西用 protocol/lib/env.mjs 的 requireCapability / requireRuntime / requireFetch 取，缺了就会报错并点名。
//     stdout(s)  写标准输出（不自动加换行）；stderr(s) 写标准错误
//     cwd        当前目录（绝对路径）
//     json       用户给了 --json：命令应当把结果也输出成 JSON（--json 已经从 args 里去掉）
//     command    命令名
//
// 退出码：0 成功；1 失败（命令抛了错，或命令自己返回 1）；2 用法错误（未知命令、命令重名）；命令也可以返回别的值。
// 报告错误：默认一行带 code 的文字写到 stderr；给了 --json 就是一行 {"error":{"code","message","details"}}。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VoicePackError, isVoicePackError } from '../lib/errors.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const NL = '\n';
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BUILTIN = 'help';

/** 用法错误：未知命令、命令重名。报告时退出 2。 */
class UsageError extends Error {}

/**
 * 命令行这一层能提供的运行环境：没有任何所需能力和运行时（核心层的命令不用模型），网络读取用本机的 fetch。
 * 要接具体环境（例如适配器，见 adapters/README.md）的入口，把自己的函数传给 main 的 createEnvironment。
 */
export function createNodeEnvironment() {
  const env = { capabilities: {}, runtimes: {} };
  if (typeof globalThis.fetch === 'function') env.fetch = (...args) => globalThis.fetch(...args);
  return env;
}

const toPath = (dir) => (dir instanceof URL ? fileURLToPath(dir) : String(dir));

/** 在命令目录里找命令，返回 Map(名字 -> 文件路径)。目录不存在就是没有命令；文件名不合规的忽略。 */
function discover(commandDirs) {
  const found = new Map();
  for (const dir of commandDirs) {
    const base = toPath(dir);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // 不同系统 readdir 的顺序不一样，按名字排
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const name = entry.name.slice(0, -'.mjs'.length);
      if (!NAME_RE.test(name)) continue;
      const file = path.join(base, entry.name);
      if (name === BUILTIN) throw new UsageError(`命令名 ${BUILTIN} 是内置的，不能再定义（${file}）`);
      if (found.has(name)) throw new UsageError(`命令 ${name} 重名：${found.get(name)} 和 ${file}`);
      found.set(name, file);
    }
  }
  return found;
}

async function loadCommand(name, file) {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new VoicePackError('command_load_failed', `命令 ${name} 加载失败：${cause?.message ?? cause}`, { details: { command: name, file }, cause });
  }
  if (typeof mod.run !== 'function') {
    throw new VoicePackError('command_load_failed', `命令 ${name} 没有导出 run 函数`, { details: { command: name, file } });
  }
  return mod;
}

async function helpOverview({ commands, programName, stdout }) {
  const rows = [[BUILTIN, '列出命令；help <命令> 看某个命令的用法']];
  for (const [name, file] of commands) {
    try {
      const mod = await loadCommand(name, file);
      rows.push([name, mod.summary ?? '']);
    } catch (error) {
      rows.push([name, `（加载失败：${error.message}）`]);
    }
  }
  const width = Math.max(...rows.map(([name]) => name.length));
  stdout(
    [
      `用法：${programName} [--json] <命令> [参数...]`,
      '',
      '命令：',
      ...rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
      '',
      '选项：',
      '  --json      错误改用一行 JSON 报告；命令也可以据此把结果输出成 JSON',
      '  -h, --help  同 help',
      '',
    ].join(NL),
  );
}

function helpCommand({ name, mod, programName, stdout }) {
  stdout([`用法：${programName} ${mod.usage ?? `${name} [参数...]`}`, mod.summary ?? '', ''].join(NL));
}

function normalizeExit(code) {
  if (code === undefined) return EXIT_OK;
  if (Number.isInteger(code) && code >= 0 && code <= 255) return code;
  throw new Error(`命令返回的退出码必须是 0–255 的整数，收到 ${JSON.stringify(code)}`);
}

function report(error, { json, stderr }) {
  if (error instanceof UsageError) {
    stderr(json ? JSON.stringify({ error: { code: 'usage', message: error.message, details: {} } }) + NL : `用法错误：${error.message}${NL}`);
    return EXIT_USAGE;
  }
  if (isVoicePackError(error)) {
    const details = error.details ?? {};
    if (json) stderr(JSON.stringify({ error: { code: error.code, message: error.message, details } }) + NL);
    else stderr(`错误（${error.code}）：${error.message}${NL}` + (Object.keys(details).length ? `  详情：${JSON.stringify(details)}${NL}` : ''));
    return EXIT_FAILURE;
  }
  const message = String(error?.message ?? error);
  stderr(json ? JSON.stringify({ error: { code: 'internal_error', message, details: {} } }) + NL : `内部错误：${error?.stack ?? message}${NL}`);
  return EXIT_FAILURE;
}

/**
 * 命令行的主函数，返回退出码（入口文件把它赋给 process.exitCode，不直接 process.exit，这样输出能写完）。
 * @param {object} options
 * @param {string[]} options.argv 命令行参数（已去掉 node 和脚本路径）
 * @param {(string|URL)[]} options.commandDirs 命令目录，按顺序找，名字不能重复
 * @param {string} [options.programName] help 里显示的调用方式，例如 `node protocol/cli.mjs`
 * @param {() => object | Promise<object>} [options.createEnvironment] 组装注入的运行环境，默认 createNodeEnvironment
 * @param {(text: string) => void} [options.stdout]
 * @param {(text: string) => void} [options.stderr]
 * @param {string} [options.cwd]
 * @returns {Promise<number>}
 */
export async function main({
  argv,
  commandDirs,
  programName = 'node cli.mjs',
  createEnvironment = createNodeEnvironment,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  cwd = process.cwd(),
}) {
  const json = argv.includes('--json');
  const rest = argv.filter((arg) => arg !== '--json');
  try {
    const commands = discover(commandDirs);
    const [first, ...args] = rest;
    if (first === undefined || first === BUILTIN || first === '-h' || first === '--help') {
      const wanted = first === BUILTIN ? args[0] : undefined;
      if (wanted === undefined) {
        await helpOverview({ commands, programName, stdout });
        return EXIT_OK;
      }
      if (!commands.has(wanted)) throw new UsageError(`未知命令 ${wanted}；用 ${programName} help 列出可用的命令`);
      helpCommand({ name: wanted, mod: await loadCommand(wanted, commands.get(wanted)), programName, stdout });
      return EXIT_OK;
    }
    if (!commands.has(first)) throw new UsageError(`未知命令 ${first}；用 ${programName} help 列出可用的命令`);
    const mod = await loadCommand(first, commands.get(first));
    if (args[0] === '--help' || args[0] === '-h') {
      helpCommand({ name: first, mod, programName, stdout });
      return EXIT_OK;
    }
    const env = await createEnvironment();
    return normalizeExit(await mod.run(args, { env, stdout, stderr, cwd, json, command: first }));
  } catch (error) {
    return report(error, { json, stderr });
  }
}
