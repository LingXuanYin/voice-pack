// SPDX-License-Identifier: Apache-2.0
//
// design 命令：按一段描述和一段试听文本，用 voice-design 设计一个候选声音（用户没有录音时的第一步）。流程的正本是 SKILL.md 第 2 节「Voice design」和 references/make-pack.md「Making a pack from a designed voice」。
//   @capability voice-design  签名见 vocab/capability-signatures.md
//
//   node cli.mjs design (--description <描述> | --description-file <文件>) (--text <试听文本> | --text-file <文件>) --out <新目录> --adapter <适配器> [--dry-run] [--json]
//
// 一次一个候选。再要一个：换一个 --out 再跑（不满意时怎么改描述，见 references/character-voice.md「Finishing a round without asking, and switching to another」）。
// --out 是一个新目录，存在就报 file_exists，一次能力都不调。写出三个文件，接得上后面的做包：
//   intro.<扩展名>        设计出来的试听（扩展名按内容认）
//   material.json         临时的包的素材：{ segments: [{ id: 'intro', audio, text }] }，text 是试听文本原文
//   design-source.json    设计来源（make-pack 的 --design-source）：{ description, model?, date, auditionLines }，model 是能力返回的（没返回就不写）
// 文字输出列出这三个文件，和后面几步的完整命令（lib/designed-pack-steps.mjs）。
// --json：{ output, audio, material, designSource, format, bytes, attempts, model? }。--dry-run：只规划，不调能力、不写文件，--out 可以不给，--json 时是 { plan: { capability, calls, extraCalls, description, text, notes } }。
//
// 费用：适配器给了 billing 时，调用之前在标准错误里说明调几次、估多少钱（--json 时不说）。暂时出错照 lib/call-attempts.mjs 再来，最多 3 次。
// 退出码：0 做完；1 出错（错误码在标准错误）；2 用法错误。
//
// 抛出的错误（VoicePackError；code 小写下划线）：
//   capability_missing          环境没有 voice-design（protocol/lib/env.mjs）
//   capability_input_invalid    适配器拒绝了描述或试听文本（太长、处理不了的字），花钱之前（vocab/capability-signatures.md）
//   file_exists                 --out 的目录已经存在
//   design_audio_unrecognized   返回的不是认得出的音频（wav、mp3、flac、ogg、m4a），什么都没写。details.mimeType
//   file_unreadable、input_not_text  读不了 --description-file、--text-file，或者不是 UTF-8（来自 cli/input.mjs）
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { requireCapability } from '../../protocol/lib/env.mjs';
import { sniffAudio } from '../../protocol/lib/audio.mjs';
import { writeDirectory } from '../../protocol/cli/disk.mjs';
import { callWithRetries, MAX_ATTEMPTS } from '../../lib/call-attempts.mjs';
import { designedPackSteps } from '../../lib/designed-pack-steps.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, moneySentence, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = 'Design a voice: design one candidate with voice-design from a description and a design audition text, and write the audition and the files needed to carry on making the pack';
export const usage = `design (--description <description> | --description-file <file>) (--text <design audition text> | --text-file <file>) --out <new directory> ${ADAPTER_USAGE} [--dry-run] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { description: 'string', 'description-file': 'string', text: 'string', 'text-file': 'string', out: 'string', 'dry-run': 'boolean' };

const CAPABILITY = 'voice-design';
const encoder = new TextEncoder();
const jsonFile = (value) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

/** --<名字> 和 --<名字>-file 取一个，读成字符串，去掉两头空白。 */
function textOption(ctx, options, name) {
  const given = options[name] ?? (options[`${name}-file`] === undefined ? undefined : readText(ctx, options[`${name}-file`]));
  return given?.trim();
}

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  if (parsed.positional.length > 0) return usageProblem(ctx, usage, `No positional arguments are accepted; extra given: ${parsed.positional.join(' ')}`);
  const { options } = parsed;
  for (const name of ['description', 'text']) {
    if (options[name] !== undefined && options[`${name}-file`] !== undefined) return usageProblem(ctx, usage, `Give only one of --${name} and --${name}-file`);
  }
  const dryRun = options['dry-run'] === true;
  if (!dryRun && options.out === undefined) return usageProblem(ctx, usage, 'Give --out <new directory> (the audition and the files needed to carry on making the pack are written there); to see only the plan, use --dry-run');
  const description = textOption(ctx, options, 'description');
  const text = textOption(ctx, options, 'text');
  if (!description) return usageProblem(ctx, usage, 'Give --description or --description-file (the timbre of this voice, one or two sentences; how to write it is in SKILL.md section 2「Voice design」)');
  if (!text) return usageProblem(ctx, usage, 'Give --text or --text-file (the design audition text; how to write it is in references/character-voice.md「Design audition text when designing」)');

  const out = options.out === undefined ? null : path.resolve(ctx.cwd, options.out);
  if (out !== null && fs.existsSync(out)) throw new VoicePackError('file_exists', `${out} already exists, and nothing is written into an existing directory: use a new directory name`, { details: { file: out } });

  const { env, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  const design = requireCapability(env, CAPABILITY);
  const billing = billingSentence(adapters);
  const calls = { [CAPABILITY]: 1 };
  const extraCalls = { [CAPABILITY]: MAX_ATTEMPTS - 1 };
  const money = billing === null ? null : moneySentence(adapters, calls, extraCalls);

  if (dryRun) {
    const notes = money === null ? [] : [{ code: 'money_estimate', message: money, details: {} }];
    if (ctx.json) {
      ctx.stdout(`${JSON.stringify({ plan: { capability: CAPABILITY, calls: 1, extraCalls: MAX_ATTEMPTS - 1, description, text, notes } }, null, 2)}\n`);
      return 0;
    }
    ctx.stdout([
      'Plan: nothing is designed, and no required capability is called',
      `  description: ${description}`,
      `  design audition text: ${text}`,
      `  ${CAPABILITY} 1 call (at most ${MAX_ATTEMPTS - 1} retries after a temporary error)`,
      ...notes.map((note) => `  ${note.message}`),
      '',
    ].join('\n'));
    return 0;
  }

  if (billing !== null && !ctx.json) ctx.stderr(`${billing}:\n  design: 1 call (${CAPABILITY}, at most ${MAX_ATTEMPTS - 1} retries after a temporary error)\n  ${money}\n`);
  const outcome = await callWithRetries(() => design({ text, voice_prompt: description }));
  if ('error' in outcome) throw outcome.error;
  const { result, attempts } = outcome;
  const sniffed = sniffAudio(result.bytes);
  if (sniffed === null) throw new VoicePackError('design_audio_unrecognized', 'The design capability returned something that is not recognizable audio (wav, mp3, flac, ogg, m4a), and nothing was written', { details: { mimeType: result.mimeType } });

  const audioName = `intro.${sniffed.format}`;
  const designSource = {
    description,
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
    date: new Date().toISOString().slice(0, 10),
    auditionLines: [text],
  };
  writeDirectory(out, new Map([
    [audioName, result.bytes],
    ['material.json', jsonFile({ segments: [{ id: 'intro', audio: audioName, text }] })],
    ['design-source.json', jsonFile(designSource)],
  ]));

  const audioFile = path.join(out, audioName);
  const materialFile = path.join(out, 'material.json');
  const designSourceFile = path.join(out, 'design-source.json');
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ output: out, audio: audioFile, material: materialFile, designSource: designSourceFile, format: sniffed.format, bytes: result.bytes.length, attempts, ...(typeof result.model === 'string' ? { model: result.model } : {}) }, null, 2)}\n`);
    return 0;
  }
  ctx.stdout([
    `Candidate written to ${out}${typeof result.model === 'string' ? ` (model ${result.model})` : ''}:`,
    `  ${audioName.padEnd('design-source.json    '.length)}audition: for the user to listen to; the user decides whether to use this voice`,
    '  material.json         the material for step a below',
    '  design-source.json    the design source, used in step c below',
    '',
    `Not satisfied: change the description and run again with a different --out (references/character-voice.md「Finishing a round without asking, and switching to another」).`,
    '',
    'If you are satisfied, next:',
    ...designedPackSteps({ material: materialFile, designSource: designSourceFile, adapter: describeRequests(taken.requests) }),
    '',
  ].join('\n'));
  return 0;
}
