// SPDX-License-Identifier: Apache-2.0
//
// adapter 命令：做自己的适配器。new 生成一个骨架，check 检查它。适配器的约定、命令怎么用，只写在 adapters/README.md「做自己的适配器」；这里只管读文件、写文件，把结果变成输出和退出码。
// 骨架怎么生成在 lib/adapter-skeleton.mjs，检查的规则在 lib/adapter-check.mjs（两个都是纯函数，app 也能直接用），加载适配器走 cli/adapters.mjs（统一的入口）。
//
//   node cli.mjs adapter new <目录> --capabilities <能力,…> [--kind <种类>] [--json]
//     生成一个新目录，里面是适配器的骨架：每项能力一个函数（还没有实现，调用会抛 adapter_not_implemented），注释从 vocab/capability-signatures.md 生成。
//     种类：module（默认，一个 ES 模块）；别的种类由官方适配器提供（adapters/<名字>/skeleton.mjs），用法见 --help。<目录> 必须还不存在，不覆盖任何东西。
//     能力名取自能力词表（vocab/capabilities.json），不认识的在写任何文件之前报用法错误。
//
//   node cli.mjs adapter check <名字|模块文件|目录> [--live] [--capability <能力,…>] [--text <文字>] [--adapter-option <键=值>]... [--json]
//     检查一个适配器。默认只看结构，不调用任何能力：能加载，返回的形状对，能力名都在能力词表里，能力是函数、只是声明的能力（style-instruction）是 true。
//     --live：再把每项能力用一段很短的输入真调一次，核对返回（音频能解码、长度大于 0、mimeType 和字节对得上、有没有 model）。会真的调用模型，可能花钱、占算力：
//             调之前在标准错误里说明调哪几项、各几次（适配器给了费用说明时也写上；--json 时不说，免得弄脏机器读的输出，计划在输出的 live.plan 里）。
//             输入：一句 Hello.（或 --text 给的），要音频的给一秒的合成音频；声音设计（voice-design）是固定的、够长的试听文本加一句短描述（它不收 Hello. 这样的短句），
//             不跟 --text 走（lib/adapter-check.mjs 文件头）。会花钱的项都算进这份说明。
//     --capability 只查点名的（结构检查里点名的能力必须有；--live 只调点名的）；--text 换掉真调用时说的话（默认 Hello.）。不调用的能力写明原因：
//             只是声明、签名表里还没有它的调用写法（no_signature）、签名表里有但检查还没接上（not_wired）、不在词表里、不是函数、适配器没提供。
//     适配器要什么参数用 --adapter-option 给，官方适配器声明的专有参数也认（写法见 adapters/README.md「命令行上怎么给」）。适配器要放在第一个位置，一次只查一个。
//     适配器加载不了（找不到、写坏了、起程序失败……）也是一次不通过的检查，不是命令出错：错误写在结果里。
//
// 退出码：0 通过；1 不通过（加载不了、结构有错、真调用有一项没通过），或者要写的目录已经存在；2 用法错误。
// --json：输出一份 JSON。new：{ kind, directory, files, capabilities, next: { fillIn, check, use } }。
//   check：{ ok, adapter: { spec, label?, file? }, error?（加载不了时：{ code, message, details }）, structure?: { ok, issues, capabilities, runtimes }, live?: { ok, text, plan, results } }。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vocabulary from '../../vocab/capabilities.json' with { type: 'json' };
import { isVoicePackError } from '../../protocol/lib/errors.mjs';
import { writeDirectory } from '../../protocol/cli/disk.mjs';
import { checkAdapterLive, checkAdapterStructure, planLiveCalls } from '../../lib/adapter-check.mjs';
import { NOT_IMPLEMENTED, parseSignatureDoc, skeletonContext } from '../../lib/adapter-skeleton.mjs';
import { billingSentence, buildSkeleton, describeRequests, loadAdapter, quoteArgument, skeletonKinds, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, usageProblem } from '../input.mjs';

const CLI_FILE = fileURLToPath(new URL('../../cli.mjs', import.meta.url));
const SIGNATURES_FILE = fileURLToPath(new URL('../../vocab/capability-signatures.md', import.meta.url));
const KINDS = skeletonKinds();
const NEW_USAGE = `adapter new <目录> --capabilities <能力,…> [--kind ${KINDS.join('|')}] [--json]`;
const CHECK_USAGE = 'adapter check <名字|模块文件|目录> [--live] [--capability <能力,…>] [--text <文字>] [--adapter-option <键=值>]... [--json]';
const NEW_FLAGS = { capabilities: 'string', kind: 'string' };
const CHECK_FLAGS = { live: 'boolean', capability: 'string', text: 'string' };

export const summary = '做自己的适配器：new 生成骨架，check 检查它（加 --live 真调用每项能力一次）';
export const usage = `${NEW_USAGE}\n      或者：node cli.mjs ${CHECK_USAGE}`;

/** 命令认的选项：new 和 check 两个子命令的合起来（--adapter-option 由 takeAdapterArguments 先取走；--json 由 runner 取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { ...NEW_FLAGS, ...CHECK_FLAGS };

const names = (text) => [...new Set(text.split(',').map((name) => name.trim()).filter((name) => name !== ''))];
const unknownNames = (list) => list.filter((name) => !Object.hasOwn(vocabulary.capabilities, name));
const vocabularyHint = () => `能力词表（vocab/capabilities.json）里有：${Object.keys(vocabulary.capabilities).join('、')}`;
const issueLine = (issue) => `  [${issue.level === 'error' ? '错误' : '警告'}] ${issue.code}：${issue.message}`;

// ---------------------------------------------------------------- new

async function runNew(args, ctx) {
  const parsed = parseArgs(args, NEW_FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, NEW_USAGE, parsed.problem ?? '要给一个新目录（适配器放在里面）');
  const { capabilities: capabilitiesArgument, kind = 'module' } = parsed.options;
  if (capabilitiesArgument === undefined) return usageProblem(ctx, NEW_USAGE, `要给 --capabilities <能力,…>：这个适配器提供哪些能力。${vocabularyHint()}`);
  if (!KINDS.includes(kind)) return usageProblem(ctx, NEW_USAGE, `不认识的骨架种类 ${kind}（有：${KINDS.join('、')}）`);
  const wanted = names(capabilitiesArgument);
  if (wanted.length === 0) return usageProblem(ctx, NEW_USAGE, `--capabilities 里一项能力都没有。${vocabularyHint()}`);
  const unknown = unknownNames(wanted);
  if (unknown.length > 0) return usageProblem(ctx, NEW_USAGE, `不认识的能力名：${unknown.join('、')}（多半是拼错了）。${vocabularyHint()}`);

  const directory = path.resolve(ctx.cwd, parsed.positional[0]);
  const name = path.basename(directory) || 'adapter';
  const { context } = skeletonContext({ name, names: wanted, vocabulary, signatures: parseSignatureDoc(fs.readFileSync(SIGNATURES_FILE, 'utf8')) });
  const skeleton = await buildSkeleton(kind, context);
  const encoder = new TextEncoder();
  writeDirectory(directory, new Map(skeleton.files.map((file) => [file.path, encoder.encode(file.content)])));

  const target = quoteArgument(directory);
  const next = {
    fillIn: skeleton.fillIn,
    check: `node ${quoteArgument(CLI_FILE)} adapter check ${target}`,
    use: `node ${quoteArgument(CLI_FILE)} dub <包目录> <台本文件> --out <输出目录> --adapter ${target}`,
  };
  const files = skeleton.files.map((file) => file.path);
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ kind, directory, files, capabilities: wanted, next })}\n`);
    return 0;
  }
  ctx.stdout([
    `已生成适配器骨架（${kind}）：${directory}`,
    ...files.map((file) => `  ${file}`),
    '',
    '下一步：',
    `  1. 填写：${next.fillIn}`,
    `  2. 检查：${next.check}`,
    '     （只看结构，不调用模型；加 --live 用很短的输入把每项能力真调一次，核对返回，可能花钱）',
    `  3. 使用：${next.use}`,
    '约定（工厂的参数、返回的形状、出错怎么报）只写在基础部分的 adapters/README.md。',
    '',
  ].join('\n'));
  return 0;
}

// ---------------------------------------------------------------- check

/** 真调用不调一项能力的原因，各给一句话（键就是 lib/adapter-check.mjs 的 SKIP_REASONS，测试逐个核对；导出只为让测试能核对）。 */
export const SKIPPED = {
  declaration: '只是声明，没有调用',
  no_signature: '签名表（vocab/capability-signatures.md）里还没有这一项的调用写法，没有调用',
  not_wired: '签名表里有这一项的调用写法，但这个检查还没接上它的真调用，没有调用',
  unknown: '不在能力词表里，没有调用',
  not_callable: '不是函数，没有调用',
  not_provided: '适配器没有提供它，没有调用',
};

/** 一次真调用返回的东西的摘要（checkCapabilityResult 给的 summary）写成一句话。 */
function describeSummary(summary) {
  if (summary === undefined || summary === null) return null;
  const audio = (clip) => `音频 ${clip.mimeType}${clip.durationSeconds === undefined ? '' : `，${clip.durationSeconds} 秒`}`;
  switch (summary.kind) {
    case 'audio': return audio(summary);
    case 'text': return `文字 ${summary.characters} 个字符${summary.language === undefined ? '' : `，语言 ${summary.language}`}`;
    case 'number': return `相似度 ${summary.similarity}`;
    case 'separation': return `人声：${audio(summary.vocals)}${summary.accompaniment === undefined ? '' : `；伴奏：${audio(summary.accompaniment)}`}`;
    case 'speech': return `${summary.regions} 个说话区间`;
    default: return null;
  }
}

const isNotImplemented = (result) => result.issues.some((issue) => issue.code === 'call_failed' && issue.details.errorCode === NOT_IMPLEMENTED);

function structureLines(structure) {
  const lines = [`结构检查：${structure.ok ? '通过' : '不通过'}`];
  if (structure.capabilities.length > 0) lines.push(`  能力：${structure.capabilities.map((item) => `${item.name}（${item.kind === 'declaration' ? '声明' : '函数'}）`).join('、')}`);
  if (structure.runtimes.length > 0) lines.push(`  运行时：${structure.runtimes.join('、')}`);
  lines.push(...structure.issues.map(issueLine));
  return lines;
}

function liveLines(live) {
  const lines = [`真调用检查：${live.ok ? '通过' : '不通过'}（每项一次，说的话是 ${JSON.stringify(live.text)}）`];
  for (const result of live.results) {
    if (result.status === 'skipped') {
      lines.push(`  ${result.capability}：${SKIPPED[result.reason] ?? result.reason}`);
    } else if (result.status === 'passed') {
      const facts = [`${result.elapsedMs} 毫秒`, result.model === null ? '返回里没有 model' : `model ${result.model}`, describeSummary(result.summary)].filter((fact) => fact !== null);
      lines.push(`  ${result.capability}：通过（${facts.join('，')}）`);
      lines.push(...result.issues.map((issue) => `  ${issueLine(issue)}`));
    } else if (isNotImplemented(result)) {
      lines.push(`  ${result.capability}：还没有实现（骨架里的那一行还没有换成真的调用）`);
    } else {
      lines.push(`  ${result.capability}：不通过`);
      lines.push(...result.issues.map((issue) => `  ${issueLine(issue)}`));
    }
  }
  if (live.results.every((result) => result.status === 'skipped')) lines.push('  没有能真调用的能力，什么都没调');
  return lines;
}

/** 真调用之前的说明（标准错误）：调哪几项、各几次，适配器的费用说明。 */
function announcement(label, plan, adapter) {
  const lines = [`真调用检查：下面这些能力会真的调用 ${plan.calls.length} 项（适配器 ${label}），每项 ${plan.calls[0].times} 次，用很短的输入；可能花钱、占算力：`, `  ${plan.calls.map((call) => call.capability).join('、')}`];
  if (plan.skipped.length > 0) lines.push(`  不调用：${plan.skipped.map((item) => `${item.capability}（${SKIPPED[item.reason] ?? item.reason}）`).join('、')}`);
  const billing = billingSentence([{ billing: adapter.billing }]);
  if (billing !== null) lines.push(`${billing}。`);
  return `${lines.join('\n')}\n`;
}

function report(ctx, result, lines) {
  ctx.stdout(ctx.json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}

async function runCheck(args, ctx) {
  const [spec, ...others] = args;
  if (spec === undefined || spec.startsWith('--')) return usageProblem(ctx, CHECK_USAGE, '先给要检查的适配器（官方的给名字，自己的给模块文件或目录），再给选项');
  const taken = takeAdapterArguments(['--adapter', spec, ...others]);
  if (taken.problem) return usageProblem(ctx, CHECK_USAGE, taken.problem);
  if (taken.requests.length !== 1) return usageProblem(ctx, CHECK_USAGE, '一次只检查一个适配器');
  const parsed = parseArgs(taken.rest, CHECK_FLAGS);
  if (parsed.problem || parsed.positional.length > 0) return usageProblem(ctx, CHECK_USAGE, parsed.problem ?? `多了参数 ${parsed.positional.join(' ')}`);
  const wanted = parsed.options.capability === undefined ? undefined : names(parsed.options.capability);
  if (wanted !== undefined && wanted.length === 0) return usageProblem(ctx, CHECK_USAGE, `--capability 里一项能力都没有。${vocabularyHint()}`);
  const unknown = wanted === undefined ? [] : unknownNames(wanted);
  if (unknown.length > 0) return usageProblem(ctx, CHECK_USAGE, `不认识的能力名：${unknown.join('、')}（多半是拼错了）。${vocabularyHint()}`);
  const live = parsed.options.live === true;
  const text = parsed.options.text;
  if (text !== undefined && !live) return usageProblem(ctx, CHECK_USAGE, '--text 是真调用时说的话，要和 --live 一起给');

  let loaded;
  try {
    loaded = await loadAdapter(ctx, ctx.env, taken.requests[0]);
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    const failure = { code: error.code, message: error.message, details: error.details ?? {} };
    return report(ctx, { ok: false, adapter: { spec }, error: failure }, [`适配器 ${spec}：加载不了`, `  错误（${error.code}）：${error.message}`]);
  }
  const { adapter, label, file } = loaded;
  const structure = checkAdapterStructure(adapter, { expect: wanted ?? [] });
  const result = { ok: structure.ok, adapter: { spec, label, file }, structure };
  const lines = [`适配器 ${label}（${file}）`, ...structureLines(structure)];
  if (live && !structure.ok) lines.push('结构检查没通过，没有做真调用');
  if (!live && structure.ok) lines.push(`没有调用任何能力。要用很短的输入把每项能力真调一次、核对返回（可能花钱）：node cli.mjs adapter check ${describeRequests(taken.requests)} --live`);
  if (live && structure.ok) {
    const env = { capabilities: adapter.capabilities ?? {}, runtimes: { ...ctx.env.runtimes, ...adapter.runtimes } }; // 返回的音频不是 WAV 时，解码要用命令自己的 ffmpeg
    const plan = planLiveCalls(env, { capabilities: wanted });
    if (plan.calls.length > 0 && !ctx.json) ctx.stderr(announcement(label, plan, adapter));
    const outcome = await checkAdapterLive(env, { capabilities: wanted, ...(text === undefined ? {} : { text }) });
    result.live = { ok: outcome.ok, text: text ?? 'Hello.', plan, results: outcome.results };
    result.ok = result.ok && outcome.ok;
    lines.push(...liveLines(result.live));
  }
  return report(ctx, result, lines);
}

// ---------------------------------------------------------------- 入口

export async function run(args, ctx) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'new') return runNew(rest, ctx);
  if (subcommand === 'check') return runCheck(rest, ctx);
  return usageProblem(ctx, usage, subcommand === undefined ? '要给子命令：new（生成骨架）或 check（检查）' : `不认识的子命令 ${subcommand}（有：new、check）`);
}
