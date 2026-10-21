// SPDX-License-Identifier: Apache-2.0
//
// convert 命令：把一段音频换成音色包的声音（变声，或者唱歌）。流程在 lib/convert.mjs；这个命令只管读包目录和音频、组装运行环境、写出换好的音频。
//
//   node cli.mjs convert <包目录> <音频文件> --out <文件> [--singing] [--adapter <名字|模块文件>]... [--adapter-option <键=值>]...
//                          [--language <标签>] [--emotion <标签>] [--style <标签>] [--energy low|medium|high] [--json]
//
// 用到的所需能力：说话用 voice-conversion，--singing 用 singing-voice-conversion（输入应当是人声分轨，没有伴奏）。不是每个环境都有这两项，
// 要靠接进来的适配器提供：--adapter（统一的入口和合并规则只在 cli/adapters.mjs 写，适配器的约定见 adapters/README.md）。环境没有这一项，退出 1，capability_missing 点名缺的是哪一项，不写文件。
// 参考用包里的：没给标签就是默认参考段，给了 --language 等就按标签挑（规则同配音，lib/reference-pick.mjs）。
// 输出文件已经存在就拒绝（file_exists），不覆盖。包里登记在 convert 功能名下的脚本在换声之后处理音频（lib/pack-script.mjs）。
//
// 花钱之前先做的事（次序就是这个）：
//   1 查 --out 还不存在：已经有了，在加载适配器、读包之前就拒绝，不花一分钱；
//   2 适配器给了费用说明（billing）、环境又有这一项能力时，把「要……：变声 1 次（voice-conversion）」写到标准错误里（唱歌是「唱歌变声 1 次（singing-voice-conversion）」；
//     --json 时不说，免得弄脏机器读的输出）；环境没有这项能力就不说，因为不会调用；
//   3 才换声。
//
// 退出码：0 换好了；1 出错（错误码在标准错误）；2 用法错误。
import path from 'node:path';
import { convertAudio } from '../../lib/convert.mjs';
import { hasCapability } from '../../protocol/lib/env.mjs';
import { writeNewFile } from '../../protocol/cli/disk.mjs';
import { assertFresh, parseArgs, usageProblem } from '../input.mjs';
import { openPackDirectory } from '../pack-directory.mjs';
import { createScriptRuntimes } from '../script-runtimes.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, takeAdapterArguments } from '../adapters.mjs';
import { readAudioFile } from '../audio-files.mjs';

export const summary = '把一段音频换成音色包的声音：变声，或者 --singing 唱歌';
export const usage = `convert <包目录> <音频文件> --out <文件> [--singing] ${ADAPTER_USAGE} [--language|--emotion|--style|--energy <标签>] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { out: 'string', singing: 'boolean', language: 'string', emotion: 'string', style: 'string', energy: 'string' };
const LABEL_FLAGS = ['language', 'emotion', 'style', 'energy'];
/** 换声要调的能力，和费用说明里怎么叫它（lib/convert.mjs 里是同一张对应）。 */
const CONVERSION = { speech: { capability: 'voice-conversion', name: '变声' }, singing: { capability: 'singing-voice-conversion', name: '唱歌变声' } };

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem || parsed.positional.length !== 2) return usageProblem(ctx, usage, parsed.problem ?? '要给包目录和音频文件（两个位置参数）');
  const { options } = parsed;
  if (options.out === undefined) return usageProblem(ctx, usage, '要给 --out <文件>（换好的音频写在这里）');
  const [packArgument, audioArgument] = parsed.positional;
  const kind = options.singing === true ? 'singing' : 'speech';

  const out = path.resolve(ctx.cwd, options.out);
  assertFresh(out);

  const { env: adapted, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  const billing = billingSentence(adapters);
  const { pack, dir } = await openPackDirectory(ctx, packArgument, { env: adapted });
  const names = pack.scripts('convert').map((entry) => entry.runtime);
  const env = { ...adapted, runtimes: { ...createScriptRuntimes({ packDir: dir, names, existing: adapted.runtimes }), ...adapted.runtimes } };

  const audio = readAudioFile(ctx, audioArgument);
  const labels = Object.fromEntries(LABEL_FLAGS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  const { capability, name } = CONVERSION[kind];
  if (billing !== null && !ctx.json && hasCapability(env, capability)) ctx.stderr(`${billing}：\n  ${name} 1 次（${capability}）\n`);
  const result = await convertAudio(env, pack, audio, { kind, ...(Object.keys(labels).length > 0 ? { labels } : {}) });

  writeNewFile(out, result.audio.bytes);
  const { audio: converted, ...report } = result;
  void converted;
  const summaryReport = { ...report, file: out };
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(summaryReport, null, 2)}\n`);
    return 0;
  }
  const lines = [`包：${result.pack.name}（${result.pack.id} ${result.pack.version}）`, `换好了（${result.capability}${result.model ? `，模型 ${result.model}` : ''}）→ ${out}`];
  const { pick } = result;
  lines.push(`参考：[${[pick.segmentId, pick.rule, ...(pick.matched.length > 0 ? [`匹配 ${pick.matched.join('、')}`] : []), ...(pick.missed.length > 0 ? [`没有对得上的 ${pick.missed.join('、')}`] : [])].join(' · ')}]`);
  if (result.enhancers.offered.length > 0) {
    lines.push(result.enhancers.used.length > 0 ? `增强件：用上了 ${result.enhancers.used.join('、')}` : `增强件：这次没用增强件（环境没有对应的模型），照常换声。包里有 ${result.enhancers.notUsed.map((item) => `${item.id}（${item.model} ${item.modelVersion}）`).join('、')}`);
  }
  if (result.scripts.length > 0) lines.push(`脚本：${result.scripts.map((item) => `${item.entry}（${item.runtime}）`).join('、')}`);
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}
