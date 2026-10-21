// SPDX-License-Identifier: Apache-2.0
//
// quality：检查一段音频能不能当参考音频：时长、采样率、削波、静音占比、信噪比（外加响度和底噪）。量法、阈值和依据见 tools/audio-quality.mjs 的文件头。
// WAV（PCM 16、24、32 位整数，32 位浮点）自己解；别的格式（mp3、flac、ogg、m4a……）要本机 PATH 上有 ffmpeg，没有就报 runtime_missing。
//
// 退出码：0 能用（结论是 ok 或 warn）；1 不能用（reject），或者读不了、解不了；2 用法错误。
// 不加 --json：几行说明和每条原因。加 --json：输出 { decoder, metrics, verdict, usable, reasons }（解不了的错误仍然是 stderr 上的一行 JSON）。
import { checkAudioQuality } from '../../tools/audio-quality.mjs';
import { parseArgs, readBytes, usageProblem } from '../input.mjs';

export const summary = '检查音频能不能当参考：时长、采样率、削波、静音、信噪比；不能用时退出 1';
export const usage = 'quality <音频文件|-> [--json]';

/** 命令认的选项：没有（--json 由 runner 取走）。约定见 cli/input.mjs 文件头。 */
export const FLAGS = {};

const VERDICT = { ok: '可以当参考', warn: '可以当参考，但有提醒', reject: '不能当参考' };
const SEVERITY = { warn: '提醒', reject: '拒绝' };
const show = (value, unit, digits = 1) => (value === null ? '没有' : `${Number(value.toFixed(digits))}${unit}`);

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem);
  const result = await checkAudioQuality(ctx.env, readBytes(ctx, parsed.positional[0]));
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.usable ? 0 : 1;
  }
  const m = result.metrics;
  ctx.stdout(`${parsed.positional[0]}（解码：${result.decoder}）\n`);
  ctx.stdout(`时长 ${m.durationSec} 秒｜采样率 ${m.sampleRate} Hz｜声道 ${m.channels}\n`);
  ctx.stdout(
    `响度 ${show(m.loudnessLufs, ' LUFS')}｜峰值 ${show(m.peakDbfs, ' dBFS')}｜削波 ${show(m.clipping.ratio * 100, '%', 2)}｜` +
      `静音 ${show(m.silenceRatio === null ? null : m.silenceRatio * 100, '%')}｜底噪 ${show(m.noiseFloorDbfs, ' dBFS')}｜信噪比 ${show(m.snrDb, ' dB')}\n`,
  );
  ctx.stdout(`结论：${VERDICT[result.verdict]}${result.reasons.length ? `（${result.reasons.length} 条原因）` : ''}\n`);
  for (const reason of result.reasons) ctx.stdout(`  [${SEVERITY[reason.severity]}] ${reason.message}\n`);
  return result.usable ? 0 : 1;
}
