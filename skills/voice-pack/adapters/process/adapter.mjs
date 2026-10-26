// SPDX-License-Identifier: Apache-2.0
//
// 进程适配器的工厂：命令行上的 --adapter process --command "python my_tts.py" 加载的就是它；自己的适配器里也可以 use('process', { command, capabilities })。
// 它把能力调用转成对用户自己的程序的请求（标准输入输出，一行一个 JSON），所以用户的模型是 Python 之类的程序时，不用写适配器代码。
// 进程协议、选项、出错、程序怎么被收掉，正本都是 README.md（本目录）；适配器的一般约定见 ../README.md。这里只读选项、起会话、把能力接上去。
//
// 选项（命令行上用 --adapter-option 键=值，--command 是 command 的简写；use() 里给对象）：
//   command        必给。程序怎么起：一个字符串（按空白分开，"…" 和 '…' 里的空白不分开，没有别的转义，Windows 的路径里的反斜杠照原样），
//                  或者一个字符串数组（use() 里给，每项就是一个参数）。不经 shell：.cmd、.bat 这类脚本起不来
//   capabilities   这个适配器提供哪些能力，逗号隔开或数组。给了：不起程序，能力（结构检查看到的）就是它，程序在第一次调用时才起，
//                  起来以后核对程序在 ready 里说的有没有这些；不给：现在就起程序，它在 ready 里说它有什么，就有什么
//   timeout        一个请求最多等多少秒，默认 300。超时就结束程序
//   startTimeout   等程序说 ready 最多多少秒，默认 300（载入模型可能很慢）
//   cwd            程序的当前目录，默认是适配器自己的目录（dir）；相对的写法相对 dir
//
// 返回：{ capabilities }。能力名在 DECLARED_CAPABILITIES（只是声明的能力，例如 style-instruction、style-cues）里的，值是 true，不会发请求。
// 这个文件在适配器的主人一侧运行：可以用 Node 专有的东西（node:path），规则见 ../README.md「Node 专有的东西放哪」。
//
// 抛出的错误：process_option_invalid（选项不对，details.key）；别的 process_* 来自 cli/session.mjs，文件头写着。
import path from 'node:path';
import { DECLARED_CAPABILITIES } from '../../protocol/lib/env.mjs';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { createSession } from './cli/session.mjs';

/** 认的选项（README.md 的选项表和它一致）。 */
export const OPTION_KEYS = Object.freeze(['command', 'capabilities', 'timeout', 'startTimeout', 'cwd']);
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_START_TIMEOUT_SECONDS = 300;

const invalid = (key, message) => new VoicePackError('process_option_invalid', `进程适配器的选项 ${key} 不对：${message}`, { details: { key } });

/** 一行命令 → 参数数组。按空白分开；"…" 和 '…' 里的空白不分开，引号本身不留；没有反斜杠转义（Windows 的路径）。 */
export function splitCommand(text) {
  const out = [];
  let current = '';
  let started = false; // 一对引号（哪怕是空的）也算一个参数
  let quote = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current !== '') out.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) throw invalid('command', `引号没有配对（${quote} 开了没关）`);
  if (started || current !== '') out.push(current);
  return out;
}

function commandOf(value) {
  if (value === undefined) throw invalid('command', '要给：程序怎么起，例如 --command "python my_tts.py"');
  const argv = typeof value === 'string' ? splitCommand(value) : value;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string') || argv[0] === '') {
    throw invalid('command', '要是一个字符串，或者一个字符串数组，第一项是程序');
  }
  return argv;
}

function capabilitiesOf(value) {
  if (value === undefined) return undefined;
  const names = (typeof value === 'string' ? value.split(',') : value);
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw invalid('capabilities', '要是逗号隔开的能力名，或者能力名的数组');
  const cleaned = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))];
  if (cleaned.length === 0) throw invalid('capabilities', '给了就要有能力名；要让程序自己说，就别给这个选项');
  return cleaned;
}

function secondsOf(value, key, fallback) {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number <= 0) throw invalid(key, `要是大于 0 的秒数，收到 ${JSON.stringify(value)}`);
  return number;
}

export default async function createProcessAdapter({ dir, options }) {
  const given = options ?? {};
  for (const key of Object.keys(given)) {
    if (!OPTION_KEYS.includes(key)) throw invalid(key, `不认识这个选项（认：${OPTION_KEYS.join('、')}）`);
  }
  const argv = commandOf(given.command);
  const declared = capabilitiesOf(given.capabilities);
  const session = createSession({
    argv,
    cwd: given.cwd === undefined ? dir : path.resolve(dir, String(given.cwd)),
    timeoutMs: secondsOf(given.timeout, 'timeout', DEFAULT_TIMEOUT_SECONDS) * 1000,
    startTimeoutMs: secondsOf(given.startTimeout, 'startTimeout', DEFAULT_START_TIMEOUT_SECONDS) * 1000,
    expect: declared ?? [],
  });
  const names = declared ?? (await session.start()).capabilities;
  const capabilities = {};
  for (const name of names) capabilities[name] = DECLARED_CAPABILITIES.includes(name) ? true : (params) => session.call(name, params);
  return { capabilities };
}
