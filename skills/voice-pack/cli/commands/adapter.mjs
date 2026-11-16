// SPDX-License-Identifier: Apache-2.0
//
// adapter 命令：做自己的适配器。new 生成一个骨架，check 检查它。适配器的约定、命令怎么用，只写在 adapters/README.md「Making your own adapter」；这里只管读文件、写文件，把结果变成输出和退出码。
// 骨架怎么生成在 lib/adapter-skeleton.mjs，检查的规则在 lib/adapter-check.mjs（两个都是纯函数，app 也能直接用），加载适配器走 cli/adapters.mjs（统一的入口）。
//
//   node cli.mjs adapter new <目录> --capabilities <能力,…> [--kind <种类>] [--json]
//     生成一个新目录，里面是适配器的骨架：每项能力一个函数（还没有实现，调用会抛 adapter_not_implemented），注释从 vocab/capability-signatures.md 生成。
//     种类：module（默认，一个 ES 模块）；别的种类由官方适配器提供（adapters/<名字>/skeleton.mjs），用法见 --help。<目录> 必须还不存在，不覆盖任何东西。
//     能力名取自能力词表（vocab/capabilities.json），不认识的在写任何文件之前报用法错误。
//
//   node cli.mjs adapter check <名字|模块文件|目录> [--live] [--capability <能力,…>] [--text <文字>] [--adapter-option <键=值>]... [--json]
//     检查一个适配器。默认只看结构，不调用任何能力：能加载，返回的形状对，能力名都在能力词表里，能力是函数、只是声明的能力（phoneme-in-text、phoneme-markers、scene-in-request、seed-in-request）是 true。
//     --live：再把每项能力用一段很短的输入真调一次，核对返回（音频能解码、长度大于 0、mimeType 和字节对得上、有没有 model）。会真的调用模型，可能花钱、占算力：
//             调之前在标准错误里说明调哪几项、各几次（适配器给了费用说明时也写上；--json 时不说，免得弄脏机器读的输出，计划在输出的 live.plan 里）。
//             输入：一句 Hello, this is a check.（或 --text 给的；有的模型一次至少 15 个字符，所以不用 Hello.），要音频的给基础部分附带的一段人声
//             （lib/adapter-check-voice.wav，5–8 秒，逐字文本在旁边的 .json 里，voice-cloning 的 ref_text 用它）；声音设计（voice-design）是固定的、够长的试听文本加一句短描述
//             （它不收 Hello. 这样的短句），不跟 --text 走（lib/adapter-check.mjs 文件头）。会花钱的项都算进这份说明。
//     --capability 只查点名的（结构检查里点名的能力必须有；--live 只调点名的）；--text 换掉真调用时说的话（默认 Hello, this is a check.）。不调用的能力写明原因：
//             只是声明、签名表里还没有它的调用写法（no_signature）、签名表里有但检查还没接上（not_wired）、不在词表里、不是函数、适配器没提供。
//     适配器要什么参数用 --adapter-option 给，官方适配器声明的专有参数也认（写法见 adapters/README.md「How to pass it on the command line」）。适配器要放在第一个位置，一次只查一个。
//     适配器加载不了（找不到、写坏了、起程序失败……）也是一次不通过的检查，不是命令出错：错误写在结果里。
//
//   node cli.mjs adapter new --help、node cli.mjs adapter check --help（或 -h）：打印这个子命令的用法，退出 0。
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
import voiceInfo from '../../lib/adapter-check-voice.json' with { type: 'json' };
import { checkAdapterLive, checkAdapterStructure, DEFAULT_TEXT, planLiveCalls } from '../../lib/adapter-check.mjs';
import { NOT_IMPLEMENTED, parseSignatureDoc, skeletonContext } from '../../lib/adapter-skeleton.mjs';
import { billingSentence, buildSkeleton, describeCheckTarget, loadAdapter, quoteArgument, skeletonKinds, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, usageProblem } from '../input.mjs';

const CLI_FILE = fileURLToPath(new URL('../../cli.mjs', import.meta.url));
const SIGNATURES_FILE = fileURLToPath(new URL('../../vocab/capability-signatures.md', import.meta.url));
/** 真调用检查用的人声（基础部分附带的，逐字文本在旁边的 adapter-check-voice.json 里）。 */
const VOICE_FILE = fileURLToPath(new URL('../../lib/adapter-check-voice.wav', import.meta.url));
const KINDS = skeletonKinds();
const NEW_USAGE = `adapter new <directory> --capabilities <capability,…> [--kind ${KINDS.join('|')}] [--json]`;
const CHECK_USAGE = 'adapter check <name|module file|directory> [--live] [--capability <capability,…>] [--text <text>] [--adapter-option <key=value>]... [--json]';
const NEW_FLAGS = { capabilities: 'string', kind: 'string' };
const CHECK_FLAGS = { live: 'boolean', capability: 'string', text: 'string' };

export const summary = 'Make your own adapter: new generates a skeleton, check checks it (add --live to call each capability once for real)';
export const usage = `${NEW_USAGE}\n      or: node cli.mjs ${CHECK_USAGE}`;

/** 命令认的选项：new 和 check 两个子命令的合起来（--adapter-option 由 takeAdapterArguments 先取走；--json 由 runner 取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { ...NEW_FLAGS, ...CHECK_FLAGS };

const names = (text) => [...new Set(text.split(',').map((name) => name.trim()).filter((name) => name !== ''))];
const unknownNames = (list) => list.filter((name) => !Object.hasOwn(vocabulary.capabilities, name));
const vocabularyHint = () => `The capability vocabulary (vocab/capabilities.json) has: ${Object.keys(vocabulary.capabilities).join(', ')}`;
const issueLine = (issue) => `  [${issue.level === 'error' ? 'error' : 'warning'}] ${issue.code}: ${issue.message}`;

// ---------------------------------------------------------------- new

async function runNew(args, ctx) {
  const parsed = parseArgs(args, NEW_FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, NEW_USAGE, parsed.problem ?? 'Give one new directory (the adapter is put in it)');
  const { capabilities: capabilitiesArgument, kind = 'module' } = parsed.options;
  if (capabilitiesArgument === undefined) return usageProblem(ctx, NEW_USAGE, `Give --capabilities <capability,…>: the capabilities this adapter provides. ${vocabularyHint()}`);
  if (!KINDS.includes(kind)) return usageProblem(ctx, NEW_USAGE, `Unknown skeleton kind ${kind} (available: ${KINDS.join(', ')})`);
  const wanted = names(capabilitiesArgument);
  if (wanted.length === 0) return usageProblem(ctx, NEW_USAGE, `--capabilities has no capability in it. ${vocabularyHint()}`);
  const unknown = unknownNames(wanted);
  if (unknown.length > 0) return usageProblem(ctx, NEW_USAGE, `Unknown capability names: ${unknown.join(', ')} (most likely a typo). ${vocabularyHint()}`);

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
    use: `node ${quoteArgument(CLI_FILE)} dub <pack directory> <script file> --out <output directory> --adapter ${target}`,
  };
  const files = skeleton.files.map((file) => file.path);
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ kind, directory, files, capabilities: wanted, next })}\n`);
    return 0;
  }
  ctx.stdout([
    `Adapter skeleton generated (${kind}): ${directory}`,
    ...files.map((file) => `  ${file}`),
    '',
    'Next steps:',
    `  1. Fill in: ${next.fillIn}`,
    `  2. Check: ${next.check}`,
    '     (this only looks at the structure and calls no model; add --live to call each capability once for real with a very short input, check the result, may cost money)',
    `  3. Use: ${next.use}`,
    'The contract (the factory arguments, the shape of the returns, how errors are reported) is written only in adapters/README.md of the base part.',
    '',
  ].join('\n'));
  return 0;
}

// ---------------------------------------------------------------- check

/** 真调用不调一项能力的原因，各给一句话（键就是 lib/adapter-check.mjs 的 SKIP_REASONS，测试逐个核对；导出只为让测试能核对）。 */
export const SKIPPED = {
  declaration: 'only a declaration, not called',
  no_signature: 'the signature table (vocab/capability-signatures.md) has no call form for it yet, not called',
  not_wired: 'the signature table has a call form for it, but this check does not make the real call for it yet, not called',
  unknown: 'not in the capability vocabulary, not called',
  not_callable: 'not a function, not called',
  not_provided: 'the adapter does not provide it, not called',
};

/** 一次真调用返回的东西的摘要（checkCapabilityResult 给的 summary）写成一句话。 */
function describeSummary(summary) {
  if (summary === undefined || summary === null) return null;
  const audio = (clip) => `audio ${clip.mimeType}${clip.durationSeconds === undefined ? '' : `, ${clip.durationSeconds} s`}`;
  switch (summary.kind) {
    case 'audio': return audio(summary);
    case 'text': return `text, ${summary.characters} characters${summary.language === undefined ? '' : `, language ${summary.language}`}`;
    case 'number': return `similarity ${summary.similarity}`;
    case 'separation': return `vocals: ${audio(summary.vocals)}${summary.accompaniment === undefined ? '' : `; accompaniment: ${audio(summary.accompaniment)}`}`;
    case 'speech': return `${summary.regions} speech ${summary.regions === 1 ? 'region' : 'regions'}`;
    default: return null;
  }
}

const isNotImplemented = (result) => result.issues.some((issue) => issue.code === 'call_failed' && issue.details.errorCode === NOT_IMPLEMENTED);

function structureLines(structure) {
  const lines = [`Structure check: ${structure.ok ? 'passed' : 'failed'}`];
  if (structure.capabilities.length > 0) lines.push(`  Capabilities: ${structure.capabilities.map((item) => `${item.name} (${item.kind === 'declaration' ? 'declaration' : 'function'})`).join(', ')}`);
  if (structure.runtimes.length > 0) lines.push(`  Runtimes: ${structure.runtimes.join(', ')}`);
  lines.push(...structure.issues.map(issueLine));
  return lines;
}

function liveLines(live) {
  const lines = [`Live check: ${live.ok ? 'passed' : 'failed'} (once per capability, the text spoken is ${JSON.stringify(live.text)})`];
  for (const result of live.results) {
    if (result.status === 'skipped') {
      lines.push(`  ${result.capability}: ${SKIPPED[result.reason] ?? result.reason}`);
    } else if (result.status === 'passed') {
      const facts = [`${result.elapsedMs} ms`, result.model === null ? 'no model in the result' : `model ${result.model}`, describeSummary(result.summary)].filter((fact) => fact !== null);
      lines.push(`  ${result.capability}: passed (${facts.join(', ')})`);
      lines.push(...result.issues.map((issue) => `  ${issueLine(issue)}`));
    } else if (isNotImplemented(result)) {
      lines.push(`  ${result.capability}: not implemented yet (that line in the skeleton has not been replaced by a real call)`);
    } else {
      lines.push(`  ${result.capability}: failed`);
      lines.push(...result.issues.map((issue) => `  ${issueLine(issue)}`));
    }
  }
  if (live.results.every((result) => result.status === 'skipped')) lines.push('  No capability could be called for real; nothing was called');
  return lines;
}

/** 真调用之前的说明（标准错误）：调哪几项、各几次，适配器的费用说明。 */
function announcement(label, plan, adapter) {
  const lines = [`Live check: these capabilities will be called for real, ${plan.calls.length} in all (adapter ${label}), ${plan.calls[0].times} ${plan.calls[0].times === 1 ? 'time' : 'times'} each, with a very short input; may cost money and compute:`, `  ${plan.calls.map((call) => call.capability).join(', ')}`];
  if (plan.skipped.length > 0) lines.push(`  Not called: ${plan.skipped.map((item) => `${item.capability} (${SKIPPED[item.reason] ?? item.reason})`).join(', ')}`);
  const billing = billingSentence([{ billing: adapter.billing }]);
  if (billing !== null) lines.push(`${billing}.`);
  return `${lines.join('\n')}\n`;
}

function report(ctx, result, lines) {
  ctx.stdout(ctx.json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}

async function runCheck(args, ctx) {
  const [spec, ...others] = args;
  if (spec === undefined || spec.startsWith('--')) return usageProblem(ctx, CHECK_USAGE, 'Give the adapter to check first (the name for an official one, a module file or directory for your own), then the options');
  const taken = takeAdapterArguments(['--adapter', spec, ...others]);
  if (taken.problem) return usageProblem(ctx, CHECK_USAGE, taken.problem);
  if (taken.requests.length !== 1) return usageProblem(ctx, CHECK_USAGE, 'Check only one adapter at a time');
  const parsed = parseArgs(taken.rest, CHECK_FLAGS);
  if (parsed.problem || parsed.positional.length > 0) return usageProblem(ctx, CHECK_USAGE, parsed.problem ?? `Extra arguments: ${parsed.positional.join(' ')}`);
  const wanted = parsed.options.capability === undefined ? undefined : names(parsed.options.capability);
  if (wanted !== undefined && wanted.length === 0) return usageProblem(ctx, CHECK_USAGE, `--capability has no capability in it. ${vocabularyHint()}`);
  const unknown = wanted === undefined ? [] : unknownNames(wanted);
  if (unknown.length > 0) return usageProblem(ctx, CHECK_USAGE, `Unknown capability names: ${unknown.join(', ')} (most likely a typo). ${vocabularyHint()}`);
  const live = parsed.options.live === true;
  const text = parsed.options.text;
  if (text !== undefined && !live) return usageProblem(ctx, CHECK_USAGE, '--text is the text spoken in the live check; give it together with --live');

  let loaded;
  try {
    loaded = await loadAdapter(ctx, ctx.env, taken.requests[0]);
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    const failure = { code: error.code, message: error.message, details: error.details ?? {} };
    return report(ctx, { ok: false, adapter: { spec }, error: failure }, [`Adapter ${spec}: cannot be loaded`, `  Error (${error.code}): ${error.message}`]);
  }
  const { adapter, label, file } = loaded;
  const structure = checkAdapterStructure(adapter, { expect: wanted ?? [] });
  const result = { ok: structure.ok, adapter: { spec, label, file }, structure };
  const lines = [`Adapter ${label} (${file})`, ...structureLines(structure)];
  if (live && !structure.ok) lines.push('The structure check did not pass, so no live check was made');
  // 建议的命令照着跑得通：适配器在第一个位置（不带 --adapter），后面是它的参数，cli.mjs 写全路径（同 new 给的「检查」那一条）
  if (!live && structure.ok) lines.push(`No capability was called. To call each capability once for real with a very short input and check the result (may cost money): node ${quoteArgument(CLI_FILE)} adapter check ${describeCheckTarget(taken.requests[0])} --live`);
  if (live && structure.ok) {
    const env = { capabilities: adapter.capabilities ?? {}, runtimes: { ...ctx.env.runtimes, ...adapter.runtimes } }; // 返回的音频不是 WAV 时，解码要用命令自己的 ffmpeg
    const plan = planLiveCalls(env, { capabilities: wanted });
    if (plan.calls.length > 0 && !ctx.json) ctx.stderr(announcement(label, plan, adapter));
    const voice = { bytes: new Uint8Array(fs.readFileSync(VOICE_FILE)), mimeType: 'audio/wav', text: voiceInfo.text };
    const outcome = await checkAdapterLive(env, { capabilities: wanted, voice, ...(text === undefined ? {} : { text }) });
    result.live = { ok: outcome.ok, text: text ?? DEFAULT_TEXT, plan, results: outcome.results };
    result.ok = result.ok && outcome.ok;
    lines.push(...liveLines(result.live));
  }
  return report(ctx, result, lines);
}

// ---------------------------------------------------------------- 入口

/** 子命令的 --help（-h）：打印它的用法和一行说明，退出 0，和 runner 给别的命令的 --help 一样（runner 只看命令名后面的第一个参数，子命令的由这里看）。 */
const SUBCOMMANDS = {
  new: { usage: NEW_USAGE, summary: 'Generate an adapter skeleton: one not-yet-implemented function per capability, with comments generated from the signature table; the directory must not exist yet' },
  check: { usage: CHECK_USAGE, summary: 'Check an adapter: by default it only looks at the structure and calls no capability; add --live to call each capability once for real with a very short input (may cost money)' },
};
function subcommandHelp(ctx, { usage: subUsage, summary: subSummary }) {
  ctx.stdout(`Usage: node cli.mjs ${subUsage}\n${subSummary}\n`);
  return 0;
}

export async function run(args, ctx) {
  const [subcommand, ...rest] = args;
  if (Object.hasOwn(SUBCOMMANDS, subcommand ?? '') && (rest[0] === '--help' || rest[0] === '-h')) return subcommandHelp(ctx, SUBCOMMANDS[subcommand]);
  if (subcommand === 'new') return runNew(rest, ctx);
  if (subcommand === 'check') return runCheck(rest, ctx);
  return usageProblem(ctx, usage, subcommand === undefined ? 'Give a subcommand: new (generate a skeleton) or check (check an adapter)' : `Unknown subcommand ${subcommand} (available: new, check)`);
}
