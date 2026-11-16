// SPDX-License-Identifier: Apache-2.0
//
// fidelity 命令：读一份评测集（JSON，里面是真人录音和用这个包合成出来的录音），量还原度，输出报告。
// 流程层量还原度的入口是 lib/fidelity.mjs 的 measureFidelity；这个命令只管读文件、组装运行环境、把报告写出来。
//   @capability voice-cloning  评测集里没给 generated 的留出录音，在这里现场合成一条（synthesizeMissing）：念留出录音的 text，参考是它的 reference 指的那段（省略用第一段），
//                              ref_text 交参考自己的 text，不给 seed，不经过配音（lib/dub.mjs），暂时出错不重试。说话人相似度、盲听由 lib/fidelity.mjs 调，见那里的 @capability
//
//   node cli.mjs fidelity <评测集.json> [--adapter <名字|模块文件>]... [--adapter-option <键=值>]... [--seed <整数>] [--max-error-rate <数>]
//                                       [--redo <上一次的报告.json>] [--save-report <文件>] [--json]
//
// 评测集的写法（文件的样子、每个字段的意思、读不了或不合约定时报什么错）只在 cli/evaluation-set.mjs 的文件头写一处：make-pack 的 --save-evaluation 写出来的就是它，这里读的也是它。
//
// 输出：给人看的报告；给了 --json 就输出一份 JSON 报告（形状见 lib/fidelity.mjs 的文件头；这次合成过的话多一项 synthesis：
//   用的哪项能力、合成了几条、报了哪些模型）。量不出来的一项报「量不了」并点名缺的能力，不是错误，退出码仍是 0；
//   只有真的出错（评测集读不了、缺能力、上游失败）才退出 1，参数写错退出 2。
//   单条服务出错（5xx、网关超时、网络错误、超时）不让整份报告作废：那一条的那一项记成「没听成」，退出码仍是 0。
//   回答被模型的服务商拦下（能力抛 provider_blocked）也不让整份报告作废：那一条盲听记成「作废」，另外说明有几条是被拦下的，退出码仍是 0。
//   它不记成「没听成」：同一段录音再问还是被拦，补做（--redo）也不会重做它。
//   某一段录音里没有能嵌声纹的语音（说话人验证报标准的 no_speech）也不让整份报告作废：那一条的说话人相似度记成「量不到」，
//   写明是生成的还是留出的那一段，不进比例，不能补做，退出码仍是 0。
//   怎么显示照 lib/fidelity.mjs 文件头「How to read this report」：规则（判成同一人的比例分档、有效的不到 5 条不下结论、没听成和量不到单独报）
//   在 lib/fidelity-reading.mjs 的 readReport 里，cli/fidelity-report.mjs 的 renderFidelityReport 从它的返回值写成文字，不另写一份阈值（make-pack 命令也用它）。
//
// 补做没听成的（--redo）：库不替调用方重试（建任务和补全可能已经计费），要补做由调用方明确地要。
//   --redo <上一次的报告.json> 读上一次的 JSON 报告（--json 的输出，或 --save-report 存的文件），用同一份评测集，
//   只重新调用没听成的那几项，输出合并以后的报告（形状同上；上一次的报告文件不改）。花多少次调用事先写在报告里（文字报告的「没听成」一栏），
//   接进来的适配器给了费用说明（billing）时，开始之前再在标准错误里说一遍。评测集里没给 generated 的留出录音，上一次是现场合成的，那条录音没有留下来，
//   补做它的话要重新合成一条（所以也要花一次合成，开销说明里写着）；给了 generated 的就用同一条，补做的结果和一次做完的一样。
//   补做要用同一个评测模型和同一个 --max-error-rate（报告里没记，自己保证）。上一次的报告里没有没听成的，什么也不做（也不加载适配器），原样输出。
//   --save-report <文件> 把这次的 JSON 报告同时写到文件（不管有没有 --json），留着下次 --redo 用；文字报告看完就没了，所以用文字报告又想补做的话要加它。
//
// 环境：
//   - 不给 --adapter：用命令行层注入的运行环境（node cli.mjs 里什么能力都没有），所以只会得到两份「量不了」。测试和只想摆出缺什么时用。
//   - 给了 --adapter（或官方适配器声明的简写和参数）：模型从适配器接进来，统一的入口和合并规则只在 cli/adapters.mjs 写，和 dub、make-pack 一样。
//     适配器给了费用说明（billing）时，开始之前会在标准错误里说明要调多少次（--json 时不说，免得弄脏机器读的一行 JSON 错误）。
//   - 环境没有 speaker-verification 时说话人相似度量不了，要用的话接一个有它的适配器，或者由调用方在 ctx.env 里补上（嵌入这个 skill 的应用要用它自己的本机声纹，就是这么接进来的）。
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   evaluation_set_unreadable、evaluation_set_invalid  评测集或它指到的音频读不了、不合约定（cli/evaluation-set.mjs 文件头）；补做时上一次报告里没听成的留出录音不在评测集里，
//                              也是 evaluation_set_invalid（details.field 是 holdouts）
//   redo_report_unreadable、redo_report_invalid  --redo 给的报告文件读不了、不是 JSON（cli/evaluation-set.mjs 文件头）。（是 JSON 但不是报告的形状，由 lib 报 fidelity_input_invalid，details.field 从 previous 起写）
//   report_unwritable          --save-report 给的文件写不了。details.file
//   另外 capability_missing 来自核心层，adapter_invalid、adapter_not_found 来自 cli/adapters.mjs（适配器自己抛的错原样往上），fidelity_* 等来自 lib/fidelity.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { requireCapability } from '../../protocol/lib/env.mjs';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { measureFidelity, planRedo, redoNotHeard, seededRandom, UNMEASURABLE_LABEL } from '../../lib/fidelity.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, takeAdapterArguments } from '../adapters.mjs';
import { invalidEvaluationSet, readEvaluationSet, readPreviousReport } from '../evaluation-set.mjs';
import { renderFidelityReport } from '../fidelity-report.mjs';
import { isPlainObject } from '../input.mjs';

export const summary = 'Measure the fidelity of a pack: the ratio of speaker similarity to the real-person baseline, plus blind listening (reads an evaluation set JSON); can redo only the items that were not heard last time';
export const usage = `fidelity <evaluation-set.json> ${ADAPTER_USAGE} [--seed <integer>] [--max-error-rate <number>] [--redo <previous-report.json>] [--save-report <file>] [--json]`;

/**
 * 命令认的选项（--json 由 runner 取走，适配器的参数由 takeAdapterArguments 先取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。
 * 这个命令的参数是自己解析的（每一项的错误说明比 parseArgs 的细）：认哪些选项以这份表为准，值的类型照它在 run 里逐项核对。
 */
export const FLAGS = { seed: 'number', 'max-error-rate': 'number', redo: 'string', 'save-report': 'string' };

// ---------------------------------------------------------------- 合成

/**
 * 给还没有 generated 的留出录音合成一条：用 reference 指的参考（省略用第一段），把它的 text 念出来。
 * @throws {VoicePackError} capability_missing（点名缺 voice-cloning）、evaluation_set_invalid（没有参考可用）
 */
async function synthesizeMissing(env, references, holdouts) {
  const missing = holdouts.filter((track) => track.generated === undefined);
  if (missing.length === 0) return { count: 0, models: [] };
  const clone = requireCapability(env, 'voice-cloning');
  const models = new Set();
  for (const track of missing) {
    const reference = references.find((item) => item.id === (track.reference ?? references[0]?.id));
    if (reference === undefined) {
      throw invalidEvaluationSet('references', `held-out recording ${track.id} needs a synthesized clip, but the reference set has no reference segment: give a reference segment, or give this recording's generated directly`);
    }
    const generated = await clone({ text: track.text, ref_audio: reference.audio, ...(reference.text === undefined ? {} : { ref_text: reference.text }) });
    if (isPlainObject(generated) && typeof generated.model === 'string') models.add(generated.model);
    track.generated = generated;
  }
  return { count: missing.length, models: [...models] };
}

/** 开始之前的开销说明（只给人看，写到标准错误）。 */
function costNote({ billing, references, holdouts, missing, hasVerifier }) {
  const real = references.length + holdouts.length;
  const lines = [`${billing}:`];
  if (missing > 0) lines.push(`  synthesis: ${timesOf(missing)} (voice-cloning)`);
  if (hasVerifier) lines.push(`  speaker similarity: ${timesOf((real * (real - 1)) / 2 + holdouts.length)} (speaker-verification: ${real} real recordings compared in pairs, plus each held-out recording against its synthesized recording)`);
  else lines.push(`  speaker similarity: this environment has no speaker-verification, so this item will be reported as "${UNMEASURABLE_LABEL}"`);
  lines.push(`  blind listening: ${timesOf(holdouts.length * 2)} (audio-text-to-text: each held-out recording is asked twice)`);
  lines.push('  An item that hits a service error is recorded as "not heard" and is not retried automatically; to redo it later, add --save-report <file> now to save the JSON report (or use --json)');
  return `${lines.join('\n')}\n`;
}

/** 补做之前的开销说明（只给人看，写到标准错误）：只重新调用没听成的那几项。 */
function redoCostNote({ billing, plan, resynthesize }) {
  const lines = [`${billing}. Redoing the ${plan.items.length} ${plan.items.length === 1 ? 'item' : 'items'} that were not heard last time (the rest are left alone):`];
  if (resynthesize > 0) lines.push(`  synthesis: ${timesOf(resynthesize)} (voice-cloning: the evaluation set gives no generated for these recordings, and the clip synthesized live last time was not kept, so one has to be synthesized again)`);
  for (const [capability, count] of Object.entries(plan.calls)) lines.push(`  ${CALL_NOTE[capability] ?? capability}: ${timesOf(count)} (${capability})`);
  return `${lines.join('\n')}\n`;
}
const CALL_NOTE = { 'audio-text-to-text': 'blind listening', 'speaker-verification': 'speaker similarity' };
const timesOf = (count) => `${count} ${count === 1 ? 'call' : 'calls'}`;

// ---------------------------------------------------------------- 命令

export async function run(args, ctx) {
  const usageError = (message) => {
    ctx.stderr(`Usage error: ${message}\nUsage: ${usage}\n`);
    return 2;
  };

  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageError(taken.problem);
  const options = { seed: null, maxErrorRate: undefined, redo: null, saveReport: null };
  let file = null;
  for (let index = 0; index < taken.rest.length; index++) {
    const arg = taken.rest[index];
    if (arg.startsWith('--') && Object.hasOwn(FLAGS, arg.slice(2))) {
      const value = taken.rest[++index];
      if (value === undefined) return usageError(`${arg} needs a value after it`);
      if (arg === '--seed') {
        if (!/^-?[0-9]+$/.test(value)) return usageError(`--seed needs an integer (the random seed that fixes the order of blind listening), got ${value}`);
        options.seed = Number(value);
      } else if (arg === '--redo' || arg === '--save-report') {
        if (value === '') return usageError(`${arg} needs a file after it`);
        options[arg === '--redo' ? 'redo' : 'saveReport'] = value;
      } else {
        const rate = Number(value);
        if (value.trim() === '' || !Number.isFinite(rate) || rate < 0) return usageError(`--max-error-rate needs a number not less than 0 (the threshold of the listening check), got ${value}`);
        options.maxErrorRate = rate;
      }
    } else if (arg.startsWith('-')) {
      return usageError(`unknown option ${arg}`);
    } else if (file === null) {
      file = arg;
    } else {
      return usageError(`only one evaluation set file is expected, extra argument: ${arg}`);
    }
  }
  if (file === null) return usageError('an evaluation set file (JSON) is required');

  const set = readEvaluationSet(path.resolve(ctx.cwd, file));
  const previous = options.redo === null ? null : readPreviousReport(path.resolve(ctx.cwd, options.redo));
  const plan = previous === null ? null : planRedo(previous);
  const measureOptions = {
    ...(options.seed === null ? {} : { random: seededRandom(options.seed) }),
    ...(options.maxErrorRate === undefined ? {} : { maxErrorRate: options.maxErrorRate }),
    // 评测集里写了 designSource（设计出来的声音）就照设计来源读（lib/fidelity.mjs 文件头第 10 点）；没写就照真人录音读
    designSource: set.designSource === true,
  };

  // 补做时要用到的留出录音：上一次没听成的那几条。不在评测集里就在加载适配器、花钱之前报
  const wanted = plan === null ? new Set() : new Set(plan.items.map((entry) => entry.id));
  const planned = set.holdouts.filter((track) => wanted.has(track.id));
  for (const id of wanted) {
    if (!planned.some((track) => track.id === id)) throw invalidEvaluationSet('holdouts', `the held-out recording "${id}" that was not heard in the previous report is not in this evaluation set: a redo needs the evaluation set used for that measurement`);
  }

  // 补做时没有要补做的：什么也不做，不加载适配器（不碰外面的服务），原样输出
  const nothingToDo = plan !== null && plan.total === 0;
  let env = ctx.env;
  let billing = null;
  if (taken.requests.length > 0 && !nothingToDo) {
    const applied = await applyAdapters(ctx, ctx.env, taken.requests);
    env = applied.env;
    billing = billingSentence(applied.adapters);
  }

  if (nothingToDo && !ctx.json) ctx.stderr('The previous report has no items that were not heard, so there is nothing to redo; the report is printed unchanged.\n');

  let synthesis;
  let report;
  if (plan === null) {
    if (billing !== null && !ctx.json) {
      const missing = set.holdouts.filter((track) => track.generated === undefined).length;
      ctx.stderr(costNote({ billing, references: set.references, holdouts: set.holdouts, missing, hasVerifier: typeof env.capabilities['speaker-verification'] === 'function' }));
    }
    synthesis = await synthesizeMissing(env, set.references, set.holdouts);
    report = await measureFidelity(env, set, measureOptions);
  } else {
    if (billing !== null && !ctx.json) ctx.stderr(redoCostNote({ billing, plan, resynthesize: planned.filter((track) => track.generated === undefined).length }));
    // 先看补做要用的能力够不够，再合成（合成要花钱）
    if (!nothingToDo) for (const capability of Object.keys(plan.calls)) requireCapability(env, capability);
    synthesis = await synthesizeMissing(env, set.references, planned);
    report = await redoNotHeard(env, { holdouts: planned }, previous, measureOptions);
  }

  const full = synthesis.count > 0 ? { ...report, synthesis: { capability: 'voice-cloning', count: synthesis.count, models: synthesis.models } } : report;
  if (options.saveReport !== null) {
    const target = path.resolve(ctx.cwd, options.saveReport);
    try {
      fs.writeFileSync(target, `${JSON.stringify(full, null, 2)}\n`);
    } catch (cause) {
      throw new VoicePackError('report_unwritable', `cannot write the file given to --save-report: ${target}`, { details: { file: target }, cause });
    }
  }
  if (ctx.json) ctx.stdout(`${JSON.stringify(full, null, 2)}\n`);
  else ctx.stdout(renderFidelityReport(report, { redone: plan === null || nothingToDo ? null : { items: plan.items.length, calls: plan.total } }));
  return 0;
}
