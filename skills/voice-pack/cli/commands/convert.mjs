// SPDX-License-Identifier: Apache-2.0
//
// convert 命令：把一段音频换成音色包的声音（变声，或者唱歌）。流程在 lib/convert.mjs；这个命令只管读包目录和音频、组装运行环境、写出换好的音频。
//
//   node cli.mjs convert <包目录> <音频文件> --out <文件> [--singing] [--adapter <名字|模块文件>]... [--adapter-option <键=值>]...
//                          [--language <标签>] [--reference-tag <标签>] [--json]
//
// 用到的所需能力：说话用 voice-conversion，--singing 用 singing-voice-conversion（输入应当是人声分轨，没有伴奏）。不是每个环境都有这两项，
// 要靠接进来的适配器提供：--adapter（统一的入口和合并规则只在 cli/adapters.mjs 写，适配器的约定见 adapters/README.md）。环境没有这一项，退出 1，capability_missing 点名缺的是哪一项，不写文件。
// 参考用包里的哪一段、这句的语言怎么定（--language 交的就是它），见 lib/convert.mjs 的文件头（取的顺序和找段在 lib/reference-pick.mjs）。
//   --reference-tag 只给一次，整个字符串就是标签（convert 一次只用一个包，没有 dub 的「<包>=<标签>」写法；给两次、给空的退出 2）；
//   标签包里没有，退出 1，reference_tag_unknown 列出包里每种语言有哪些标签，不调能力、不说费用、不写文件。
//   输出里写用的哪一段、它的标签、为什么、是不是跨语言克隆（说法同 dub，在 cli/pick-text.mjs）。
// 输出文件已经存在就拒绝（file_exists），不覆盖。包里登记在 convert 功能名下的脚本在换声之后处理音频（lib/pack-script.mjs）。
//
// 花钱之前先做的事（次序就是这个）：
//   1 查 --out 还不存在：已经有了，在加载适配器、读包之前就拒绝，不花一分钱；
//   2 适配器给了费用说明（billing）时，等该核对的都核对过（环境有这一项能力、脚本要的运行时、用哪一段参考，lib/convert.mjs 的 onPlan），
//     把「要……：变声 1 次（voice-conversion）」写到标准错误里（唱歌是「唱歌变声 1 次（singing-voice-conversion）」；
//     --json 时不说，免得弄脏机器读的输出）；环境没有这项能力、标签包里没有，就不说，因为不会调用；
//   3 才换声。
//
// 退出码：0 换好了；1 出错（错误码在标准错误）；2 用法错误。
import path from 'node:path';
import { convertAudio } from '../../lib/convert.mjs';
import { writeNewFile } from '../../protocol/cli/disk.mjs';
import { assertFresh, parseArgs, usageProblem } from '../input.mjs';
import { openPackDirectory } from '../pack-directory.mjs';
import { createScriptRuntimes } from '../script-runtimes.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, moneySentence, takeAdapterArguments } from '../adapters.mjs';
import { readAudioFile } from '../audio-files.mjs';
import { pickText } from '../pick-text.mjs';

export const summary = 'Turn a piece of audio into the voice of a voice pack: voice conversion, or singing with --singing';
export const usage = `convert <pack directory> <audio file> --out <file> [--singing] ${ADAPTER_USAGE} [--language <tag>] [--reference-tag <tag>] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { out: 'string', singing: 'boolean', language: 'string', 'reference-tag': 'strings' };
/** 换声要调的能力，和费用说明里怎么叫它（lib/convert.mjs 里是同一张对应）。 */
const CONVERSION = { speech: { capability: 'voice-conversion', name: 'voice conversion' }, singing: { capability: 'singing-voice-conversion', name: 'singing voice conversion' } };

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem || parsed.positional.length !== 2) return usageProblem(ctx, usage, parsed.problem ?? 'Give a pack directory and an audio file (two positional arguments)');
  const { options } = parsed;
  if (options.out === undefined) return usageProblem(ctx, usage, 'Give --out <file> (the converted audio is written there)');
  const referenceTags = options['reference-tag'] ?? [];
  if (referenceTags.length > 1) return usageProblem(ctx, usage, '--reference-tag can be given only once: convert uses only one reference segment at a time');
  if (referenceTags.some((tag) => tag === '')) return usageProblem(ctx, usage, '--reference-tag needs a tag (it may not be empty)');
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
  const { name } = CONVERSION[kind];
  // 费用说明等到该核对的都核对过（能力、运行时、用哪一段参考）才说：标签包里没有、缺能力，都不会调用
  const onPlan = (_pick, { capability }) => {
    if (billing !== null && !ctx.json) ctx.stderr(`${billing}:\n  ${name}: 1 call (${capability})\n  ${moneySentence(adapters, { [capability]: 1 })}\n`);
  };
  const result = await convertAudio(env, pack, audio, {
    kind,
    onPlan,
    ...(options.language === undefined ? {} : { labels: { language: options.language } }),
    ...(referenceTags.length === 0 ? {} : { referenceTag: referenceTags[0] }),
  });

  writeNewFile(out, result.audio.bytes);
  const { audio: converted, ...report } = result;
  void converted;
  const summaryReport = { ...report, file: out };
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(summaryReport, null, 2)}\n`);
    return 0;
  }
  const lines = [`Pack: ${result.pack.name} (${result.pack.id} ${result.pack.version})`, `Converted (${result.capability}${result.model ? `, model ${result.model}` : ''}) → ${out}`];
  const { pick } = result;
  lines.push(`Reference: [${pickText(pick).join(' · ')}]`);
  if (result.enhancers.offered.length > 0) {
    lines.push(result.enhancers.used.length > 0 ? `Enhancers: used ${result.enhancers.used.join(', ')}` : `Enhancers: none used this time (the environment has no matching model); converted as usual. The pack has ${result.enhancers.notUsed.map((item) => `${item.id} (${item.model} ${item.modelVersion})`).join(', ')}`);
  }
  if (result.scripts.length > 0) lines.push(`Scripts: ${result.scripts.map((item) => `${item.entry} (${item.runtime})`).join(', ')}`);
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}
