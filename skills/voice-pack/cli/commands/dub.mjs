// SPDX-License-Identifier: Apache-2.0
//
// dub 命令：用一个音色包给一段台本配音。流程在 lib/dub.mjs（每句挑参考、读音词表、配音指引、增强件、包里的脚本），这个命令只管读包目录和台本、
// 组装运行环境、把每一句的音频写成文件、把报告写出来。
//
//   node cli.mjs dub <包目录> <台本文件|-> --out <目录> [--adapter <名字|模块文件>]... [--adapter-option <键=值>]...
//                    [--language <标签>] [--emotion <标签>] [--style <标签>] [--energy low|medium|high]
//                    [--instructions <文字>] [--only <序号,序号>] [--max-chars <数>] [--concurrency <1-8>] [--dry-run] [--json]
//
// 包目录：角色部分的根（里面有 manifest.json、SKILL.md、reference/……）。放进环境以后就是 .agents/skills/<包 ID>/，见 install 命令。
// 台本：带台本标记的文本（章节、[pause]、[slow]……，舞台提示（耳语）、*笑*，语法见基础部分 SKILL.md 和 tools/markup.mjs）；
//   文件名以 .json 结尾的是数组，每项 { text, labels?, instructions? }：这一项自己的标签（language、emotion、style、energy）和说明。
//   `-` 是标准输入。
// 选项：
//   --out        输出目录：每一句一个音频文件（<序号>-<参考段>.<扩展名>，序号从 1 起、补零到 3 位），加一份 dub.json（报告，不含音频）。
//                目录可以已经存在（重做时往里补）；同名文件会被盖掉。--dry-run 时不要。
//   --dry-run    只规划，不合成：每一句要说什么、挑哪段参考、为什么、读音词表换了什么、缺什么运行时。不花钱，不写文件。
//   --language --emotion --style --energy
//                调用方给的标签，用在每一句上（这是最优先的一层：台本里的舞台提示和 text-generation 的判断都不再看）。
//   --instructions
//                用这段文字代替包里的配音指引，作为通过 instructions 传给模型的说明（环境有 style-instruction 才传）。
//   --only       只合成这几句（序号从 1 起，和输出里、文件名里的一致）。重做失败的几句用它：已经做好的文件原样留着，dub.json 把上一次的结果合进来。
//   --max-chars  一次合成最多多少个字，超过的按句子切开。不给就不切；接进来的适配器给了 limits.maxChars 就默认取它的（规则见 adapters/README.md）。
//   --concurrency 并发数，默认 2。
//   --adapter, --adapter-option, 官方适配器声明的简写和参数
//                模型从适配器接进来：官方的给名字，自己的给模块文件，可以给多个，后给的盖过先给的（统一的入口和合并规则只在 cli/adapters.mjs 写）。
//                适配器给了费用说明（billing）时，合成开始之前会在标准错误里说明要生成几次（--json 时不说，免得弄脏机器读的输出）。
//   --json       标准输出是一份 JSON（和 dub.json 一样的内容）。
//   文字输出      不给 --json 时，每一句下面，有停顿或语速要求就写一行括号：前面停顿、后面停顿（毫秒）、语速，和 JSON 里这一句的 pauseBeforeMs、pauseAfterMs、speed 一一对上。
//
// 包里的脚本：登记在 dub 功能名下的，用本机的解释器直接运行（node 一定有，python 等按 PATH 找），不让用户确认，不隔离。
//   环境没有脚本要的运行时：在合成之前就报 runtime_missing（--dry-run 不报，只在输出里说缺什么）。
//
// 退出码：0 全部做完；1 有失败的句子（暂时出错，输出里说了怎么重做）或者出错停下来了（错误码在标准错误）；2 用法错误。
// 出错停下来时，已经做完的音频文件和一份记着是怎么停的 dub.json（stoppedBy）都留着。
//
// 抛出的错误：dub_input_invalid（.json 台本写坏了、形状不对）；adapter_invalid、adapter_not_found（cli/adapters.mjs）、适配器自己抛的错、file_unreadable、symlink_not_allowed 等
//   来自各自的模块，lib/dub.mjs、lib/voice-pack.mjs 的 code 见它们的文件头。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { planDub, dubScript } from '../../lib/dub.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, maxCharsOf, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';
import { openPackDirectory } from '../pack-directory.mjs';
import { createScriptRuntimes } from '../script-runtimes.mjs';
import { extensionOfMime } from '../audio-files.mjs';

export const summary = '用音色包给台本配音：每句挑参考，读音词表，配音指引，增强件，包里的脚本';
export const usage = `dub <包目录> <台本文件|-> --out <目录> ${ADAPTER_USAGE} [--language|--emotion|--style|--energy <标签>] [--instructions <文字>] [--only <序号,序号>] [--max-chars <数>] [--concurrency <1-8>] [--dry-run] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  out: 'string', 'dry-run': 'boolean', only: 'string', 'max-chars': 'number', concurrency: 'number',
  language: 'string', emotion: 'string', style: 'string', energy: 'string', instructions: 'string',
};
const LABEL_FLAGS = ['language', 'emotion', 'style', 'energy'];
const REPORT_FILE = 'dub.json';

const pad = (number) => String(number).padStart(3, '0');
const fileNameOf = (unit) => `${pad(unit.number)}-${unit.pick.segmentId}.${extensionOfMime(unit.audio.mimeType)}`;

/** 台本文件：.json 是数组，别的是带标记的文本。 */
function readScript(ctx, argument) {
  const text = readText(ctx, argument);
  if (!argument.toLowerCase().endsWith('.json')) return text;
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('不是数组');
    return value;
  } catch (cause) {
    throw new VoicePackError('dub_input_invalid', `${argument} 不是台本数组（要 [{ "text": "…", "labels": {…}? }, …]）：${cause.message}`, { details: { field: 'script' }, cause });
  }
}

/** --only 2,5 -> [1, 4]（库里的下标从 0 起，命令行上的序号从 1 起）。 */
function parseOnly(text) {
  const numbers = text.split(',').map((part) => part.trim());
  if (numbers.some((part) => !/^[1-9][0-9]*$/.test(part))) return null;
  return [...new Set(numbers.map((part) => Number(part) - 1))];
}

/** 给每一段加上命令行层的序号（从 1 起）和文件名。 */
function decorate(units) {
  for (const unit of units) unit.number = unit.index + 1;
  return units;
}

/** 报告里的一段：去掉音频字节。 */
function reportUnit(unit) {
  const { audio, ...rest } = unit;
  void audio;
  return rest;
}

function pickLabel(unit) {
  const { pick } = unit;
  const parts = [pick.segmentId, pick.rule];
  if (pick.matched.length > 0) parts.push(`匹配 ${pick.matched.join('、')}`);
  if (pick.missed.length > 0) parts.push(`没有对得上的 ${pick.missed.join('、')}`);
  return `[${parts.join(' · ')}]`;
}

function render(report, { packArgument, scriptArgument, out, planOnly }) {
  const lines = [];
  lines.push(`包：${report.pack.name}（${report.pack.id} ${report.pack.version}）`);
  const { lexicon } = report;
  if (lexicon.applied.length > 0 || lexicon.unapplied.length > 0) {
    const applied = lexicon.applied.map((item) => `${item.term} → ${item.say}（${item.count} 处）`).join('；');
    const unapplied = lexicon.unapplied.map((item) => `${item.term}（${item.reason === 'phoneme' ? '读法是音素，要合成的模型自己会读' : '按词性挑读法，这里没有语法信息'}）`).join('；');
    lines.push(`读音词表：${applied === '' ? '这份台本里没有用到' : `换了 ${applied}`}${unapplied === '' ? '' : `；做不到的：${unapplied}`}`);
  }
  if (report.guidance.present) {
    const sent = report.units.some((unit) => unit.instructions.sent);
    lines.push(report.capabilities['style-instruction']
      ? `配音指引：环境有 style-instruction，${sent ? '随每句通过 instructions 传给了模型' : '这次没有可传的内容'}${report.guidance.truncated ? '（过长，截短了）' : ''}`
      : '配音指引：环境没有 style-instruction，没传 instructions（照指引写的话、选的参考，仍然生效）');
  }
  if (report.enhancers.offered.length > 0) {
    const describe = (list) => list.map((item) => `${item.id}（${item.model} ${item.modelVersion}）`).join('、');
    if (planOnly) lines.push(`增强件：包里有 ${describe(report.enhancers.offered)}；合成时递给环境，环境认识对应的模型才会用上`);
    else if (report.enhancers.used.length > 0) lines.push(`增强件：用上了 ${report.enhancers.used.join('、')}${report.enhancers.notUsed.length > 0 ? `；没用上 ${describe(report.enhancers.notUsed)}` : ''}`);
    else if (report.enhancers.statement === 'enhancers_not_used') lines.push(`增强件：这次没用增强件（环境没有对应的模型），照常生成。包里有 ${describe(report.enhancers.notUsed)}${report.verification.length > 0 ? `；验证记录见 ${REPORT_FILE}` : ''}`);
  }
  if (report.scripts.length > 0) lines.push(`脚本：${report.scripts.map((item) => `${item.entry}（${item.runtime}）`).join('、')}`);
  if (report.missingRuntimes.length > 0) lines.push(`缺运行时：${report.missingRuntimes.map((item) => `${item.runtime}（脚本 ${item.entry}）`).join('、')}；真合成会在开始前报 runtime_missing`);
  if (!report.capabilities['voice-cloning']) lines.push('缺所需能力：voice-cloning；真合成会在开始前报 capability_missing');
  if (report.judge.status === 'used') lines.push(`情绪判断：台本里没有提示的句子，让 text-generation 判断了${report.judge.model ? `（${report.judge.model}）` : ''}`);
  else if (report.judge.status === 'unavailable') lines.push('情绪判断：台本里有句子没有任何提示，环境没有 text-generation，用了默认参考');
  else if (report.judge.status === 'planned') lines.push(`情绪判断：正式运行会用 text-generation 判 ${report.judge.lines} 句（台本里没有提示的句子）；试运行不调它（要计费），这几句现在用默认参考`);
  else if (report.judge.status === 'unusable') {
    const fell = report.units.filter((unit) => unit.pick.judgeFailed === true).map((unit) => unit.number);
    lines.push(`情绪判断：text-generation 的回答不能用（${report.judge.error?.message ?? report.judge.reason}），这几句用了默认参考：${fell.join('、')}`);
  }
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push('', `共 ${report.units.length} 句：`);
  for (const unit of report.units) {
    const where = unit.file !== undefined ? ` → ${path.join(out, unit.file)}` : unit.status === 'failed' ? `（失败：${unit.error.code}）` : unit.status === 'skipped' ? '（这次没做）' : '';
    lines.push(`  ${unit.number}. ${pickLabel(unit)}${where}`);
    lines.push(`     ${unit.spoken}`);
    // 停顿和语速：和 --json 里这一句的 pauseBeforeMs、pauseAfterMs、speed 说的是一回事（前面的停顿挂在后一句上，以前文字输出里看不到）
    const timing = [
      ...(unit.pauseBeforeMs > 0 ? [`前面停顿 ${unit.pauseBeforeMs} 毫秒`] : []),
      ...(unit.pauseAfterMs > 0 ? [`后面停顿 ${unit.pauseAfterMs} 毫秒`] : []),
      ...(unit.speed === null ? [] : [`语速 ${unit.speed}`]),
    ];
    if (timing.length > 0) lines.push(`     （${timing.join('，')}）`);
  }
  const failed = report.units.filter((unit) => unit.status === 'failed');
  if (failed.length > 0) {
    lines.push('', `失败 ${failed.length} 句（服务暂时出错，稍后重做）：node cli.mjs dub ${packArgument} ${scriptArgument} --out ${out} --only ${failed.map((unit) => unit.number).join(',')}`);
  }
  return `${lines.join('\n')}\n`;
}

function costNote({ billing, plan, count }) {
  const lines = [`${billing}：`, `  合成 ${count} 次（voice-cloning）`];
  if (plan.judge.status === 'used') lines.push(`  台本里没有提示的句子，已经让 text-generation 判断了一次`);
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem || parsed.positional.length !== 2) return usageProblem(ctx, usage, parsed.problem ?? '要给包目录和台本（两个位置参数）');
  const { options } = parsed;
  const [packArgument, scriptArgument] = parsed.positional;
  const dryRun = options['dry-run'] === true;
  if (!dryRun && options.out === undefined) return usageProblem(ctx, usage, '要给 --out <目录>（音频和 dub.json 放这里）；只想看规划用 --dry-run');
  let only;
  if (options.only !== undefined) {
    only = parseOnly(options.only);
    if (only === null) return usageProblem(ctx, usage, `--only 要的是句子的序号（从 1 起，用逗号隔开，例如 2,5），收到 ${options.only}`);
  }

  // 环境：命令已有的，加适配器的（后给的盖过先给的，命令行上明说的盖过默认的），再加这个包的脚本要的运行时
  const { env: adapted, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  let env = adapted;
  const billing = billingSentence(adapters);
  const { pack, dir } = await openPackDirectory(ctx, packArgument, { env });
  const names = pack.scripts('dub').map((entry) => entry.runtime);
  env = { ...env, runtimes: { ...createScriptRuntimes({ packDir: dir, names, existing: env.runtimes }), ...env.runtimes } };

  const script = readScript(ctx, scriptArgument);
  const labels = Object.fromEntries(LABEL_FLAGS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  const adapterMaxChars = maxCharsOf(adapters);
  const dubOptions = {
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(options.instructions === undefined ? {} : { guidance: options.instructions }),
    ...(only === undefined ? {} : { only }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options['max-chars'] !== undefined ? { maxChars: options['max-chars'] } : adapterMaxChars !== undefined ? { maxChars: adapterMaxChars } : {}),
  };
  const render_ = (report, planOnly) => render(report, { packArgument, scriptArgument, out: options.out === undefined ? '' : path.resolve(ctx.cwd, options.out), planOnly });

  if (dryRun) {
    const plan = await planDub(env, pack, script, dubOptions);
    decorate(plan.units);
    ctx.stdout(ctx.json ? `${JSON.stringify(plan, null, 2)}\n` : render_(plan, true));
    return 0;
  }

  const out = path.resolve(ctx.cwd, options.out);
  const reportFile = path.join(out, REPORT_FILE);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // 没有上一次的报告，或者读不了：当作第一次
  }
  const finished = [];
  const writeAudio = (unit) => {
    fs.mkdirSync(out, { recursive: true });
    unit.file = fileNameOf(unit);
    fs.writeFileSync(path.join(out, unit.file), unit.audio.bytes);
  };
  const dubbed = dubScript(env, pack, script, {
    ...dubOptions,
    onPlan: (plan) => {
      decorate(plan.units);
      if (billing !== null && !ctx.json) {
        const count = only === undefined ? plan.units.length : only.length;
        ctx.stderr(costNote({ billing, plan, count }));
      }
    },
    onUnit: (unit) => {
      unit.number ??= unit.index + 1;
      if (unit.status === 'ok') writeAudio(unit);
      finished.push(unit);
    },
  });
  let result;
  try {
    result = await dubbed;
  } catch (error) {
    // 出错停下来：已经做完的文件留着，写一份记着怎么停的报告（让人知道留下来的是什么），再把错误交给 runner 报告。
    // 一句都没做完就出错（缺能力、缺运行时、台本不对……）什么都不写：没有东西要交代。
    if (finished.length > 0) {
      const stoppedBy = { code: error.code ?? 'internal_error', message: String(error.message), details: error.details ?? {} };
      fs.writeFileSync(reportFile, `${JSON.stringify({ ok: false, stoppedBy, units: finished.map(reportUnit) }, null, 2)}\n`);
    }
    throw error;
  }

  // 重做时把上一次做好的合进来：这次没做的句子，如果上一次已经做好了同一句（话、参考段都没变）、文件还在，就沿用
  for (const unit of result.units) {
    if (unit.status !== 'skipped') continue;
    const before = previous?.units?.find((candidate) => candidate.index === unit.index); // 出错停下来的那份报告里只有做完的几句，所以按 index 找，不按位置
    if (before?.status === 'ok' && before.spoken === unit.spoken && before.pick?.segmentId === unit.pick.segmentId && typeof before.file === 'string' && fs.existsSync(path.join(out, before.file))) {
      unit.status = 'ok';
      unit.file = before.file;
      unit.carriedOver = true;
    }
  }
  const report = { ...result, units: result.units.map(reportUnit) };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  ctx.stdout(ctx.json ? `${JSON.stringify(report, null, 2)}\n` : render_(report, false));
  return result.ok ? 0 : 1;
}
