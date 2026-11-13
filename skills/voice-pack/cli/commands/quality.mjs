// SPDX-License-Identifier: Apache-2.0
//
// quality：量一段音频的时长、采样率、削波、静音占比、信噪比（外加响度和底噪），给出提醒。量法、阈值和依据见 tools/audio-quality.mjs 的文件头。
// WAV（PCM 16、24、32 位整数，32 位浮点）自己解；别的格式（mp3、flac、ogg、m4a……）要本机 PATH 上有 ffmpeg，没有就报 runtime_missing。
//
// 退出码：0 量出来了（结论是 ok 或 warn）；1 读不了、解不了；2 用法错误。
// 不加 --json：几行说明和每条原因。加 --json：输出 { decoder, metrics, verdict, reasons }（解不了的错误仍然是 stderr 上的一行 JSON）。
import { checkAudioQuality } from '../../tools/audio-quality.mjs';
import { parseArgs, readBytes, usageProblem } from '../input.mjs';

export const summary = "Measure an audio file's duration, sample rate, clipping, silence and signal-to-noise ratio, and report warnings";
export const usage = 'quality <audio file|-> [--json]';

/** 命令认的选项：没有（--json 由 runner 取走）。约定见 cli/input.mjs 文件头。 */
export const FLAGS = {};

const VERDICT = { ok: 'no warnings', warn: 'has warnings' };
const SEVERITY = { warn: 'warning' };
const show = (value, unit, digits = 1) => (value === null ? 'n/a' :`${Number(value.toFixed(digits))}${unit}`);

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem);
  const result = await checkAudioQuality(ctx.env, readBytes(ctx, parsed.positional[0]));
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const m = result.metrics;
  ctx.stdout(`${parsed.positional[0]} (decoder: ${result.decoder})\n`);
  ctx.stdout(`Duration ${m.durationSec} s | Sample rate ${m.sampleRate} Hz | Channels ${m.channels}\n`);
  ctx.stdout(
    `Loudness ${show(m.loudnessLufs, ' LUFS')} | Peak ${show(m.peakDbfs, ' dBFS')} | Clipping ${show(m.clipping.ratio * 100, '%', 2)} | ` +
      `Silence ${show(m.silenceRatio === null ? null : m.silenceRatio * 100, '%')} | Noise floor ${show(m.noiseFloorDbfs, ' dBFS')} | SNR ${show(m.snrDb, ' dB')}\n`,
  );
  ctx.stdout(`Verdict: ${VERDICT[result.verdict]}${result.reasons.length ? ` (${result.reasons.length} ${result.reasons.length === 1 ? 'reason' : 'reasons'})` : ''}\n`);
  for (const reason of result.reasons) ctx.stdout(`  [${SEVERITY[reason.severity]}] ${reason.message}\n`);
  return 0;
}
