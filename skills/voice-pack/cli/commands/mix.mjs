// SPDX-License-Identifier: Apache-2.0
//
// mix 命令：把 dub 的输出目录里做好的各句接成一个 WAV 成品（规则在 lib/mix.mjs）。纯本地：不调能力，不花钱（运行环境里有没有 voice-cloning 都照常）。
//
//   node cli.mjs mix <dub 输出目录> --out <文件.wav> [--json]
//
// 输出目录：dub 写的那一个（里面有 dub.json 和每一句的音频文件）。
// --out：成品写到这个 .wav 文件。已经存在就拒绝（file_exists），不覆盖。
// 不出成品（退出 1，错误码 mix_incomplete）：有句子没做成（details.failed 列出是哪几句，提示先用 dub --only 重做）；dub 中途停下来了（details.stoppedBy）。
// 其他错误：mix_input_invalid（没有 dub.json，或它不是 dub 的报告）；file_unreadable（某一句的文件读不了）；runtime_missing（句子是 mp3 等非 WAV，要 ffmpeg，点名 ffmpeg）。
// 退出码：0 成品写好了；1 出错（错误码在标准错误）；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { writeNewFile } from '../../protocol/cli/disk.mjs';
import { planMix, mixParts } from '../../lib/mix.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, usageProblem } from '../input.mjs';

export const summary = '把 dub 做好的各句接成一个 WAV 成品（停顿、次序、语速；本地计算，不花钱）';
export const usage = 'mix <dub 输出目录> --out <文件.wav> [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，不在表里）。 */
export const FLAGS = { out: 'string' };

const REPORT_FILE = 'dub.json';

/** 读 dub 的报告。没有、读不了、或者不是报告的，都是 mix_input_invalid。 */
function readReport(dir) {
  const file = path.join(dir, REPORT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `${dir} 里没有 ${REPORT_FILE}（要先用 dub 把台本配成这个目录，再 mix）`, { details: { dir, reason: cause?.code ?? 'unknown' } });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `${file} 不是 JSON：${cause.message}`, { details: { file } });
  }
  if (!isPlainObject(value) || !Array.isArray(value.units)) throw new VoicePackError('mix_input_invalid', `${file} 不是 dub 的报告（没有 units）`, { details: { file } });
  return value;
}

function render(result) {
  const lines = [`成品：${result.file}`];
  const layout = result.channels === 1 ? '单声道' : `${result.channels} 声道`;
  lines.push(`总时长 ${result.durationSeconds.toFixed(2)} 秒（${result.frames} 帧，${result.sampleRate} Hz，${layout}），接了 ${result.units} 句`);
  lines.push(`插了 ${result.silences.count} 段静音，共 ${result.silences.totalMs} 毫秒`);
  if (result.speedChanged.length > 0) lines.push(`变了速（保持音高）：${result.speedChanged.map((item) => `第 ${item.number} 句（${item.speed}）`).join('、')}`);
  if (result.converted.length > 0) lines.push(`统一成第一句的格式：第 ${result.converted.join('、')} 句`);
  for (const note of result.notes) lines.push(`注意：${note.message}`);
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem ?? '要给 dub 的输出目录（一个位置参数）和 --out <文件.wav>');
  const { options } = parsed;
  if (options.out === undefined) return usageProblem(ctx, usage, '要给 --out <文件.wav>（成品写到这里）');
  if (!/\.wav$/i.test(options.out)) return usageProblem(ctx, usage, `--out 要以 .wav 结尾，收到 ${options.out}`);
  const dir = path.resolve(ctx.cwd, parsed.positional[0]);
  const file = path.resolve(ctx.cwd, options.out);
  assertFresh(file);

  const plan = planMix(readReport(dir));
  if (plan.stopped !== null) {
    throw new VoicePackError('mix_incomplete', `dub 中途停下来了（${plan.stopped.code}：${plan.stopped.message}），没做完的句子不出成品；先用 dub --only 重做没做的几句，再 mix`, { details: { stoppedBy: plan.stopped } });
  }
  if (!plan.ok) {
    const numbers = plan.incomplete.map((item) => item.number);
    throw new VoicePackError('mix_incomplete', `有 ${numbers.length} 句没做成（第 ${numbers.join('、')} 句），不出成品：先用 dub --only ${numbers.join(',')} 重做这几句，再 mix`, { details: { failed: plan.incomplete } });
  }

  const parts = plan.units.map((unit) => ({ number: unit.number, bytes: readBytes(ctx, path.join(dir, unit.file)), speed: unit.speed, pauseBeforeMs: unit.pauseBeforeMs, pauseAfterMs: unit.pauseAfterMs }));
  const { wav, report } = await mixParts(ctx.env, parts);
  writeNewFile(file, wav);
  const result = { file, ...report };
  ctx.stdout(ctx.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return 0;
}
