// SPDX-License-Identifier: Apache-2.0
//
// 成品（mix）：把 dub 做好的各句接成一个 WAV。纯本地计算：不调能力，不花钱。流程只看 dub.json（报告）和每一句的音频字节，不碰文件系统（读写在命令行层）。
//
// 规则：
//   1. 只接 dub.json 里状态为 ok 的句子，次序就是 units 的次序（dub 的次序就是台本的次序）。有一句不是 ok 就不出成品：planMix 返回 incomplete（列出是哪几句），
//      命令行层报 mix_incomplete，提示用 dub --only 重做。dub 中途停下（stoppedBy）的也不出成品：没做的句子是停下以后才没做的。
//   2. 停顿：每一句前面的 pauseBeforeMs、后面的 pauseAfterMs 插成静音（毫秒按这一句的采样率换算成帧）。前一句的后面和后一句的前面是两个缝，各插各的。
//      一句的停顿只在它自己的两头，不跨句。
//   3. 格式：成品的采样率和声道是第一句的。别的句子统一过去：声道按规则合（单声道时复制到每个声道，多声道时取平均），采样率用加窗 sinc 的重采样（纯 JS，不依赖 ffmpeg）。
//      音高不变：重采样只改采样率，不改时长以外的东西。
//   4. 语速：unit.speed 是台本要求的语速（0.85 放慢、1.15 加快）。有 ffmpeg（env.runtimes.ffmpeg）就用 atempo 变速（保持音高）；没有就照原速接上，报告里记一条 speed_not_applied，不报错。
//      变速只在拼之前对这一句做，所以它的时长会变，报告里记下是哪几句变了速（speedChanged）。
//   5. 非 WAV 的句子（mp3、flac 等）要解码：decodeAudio 会要 ffmpeg，没有就 runtime_missing（点名 ffmpeg）。WAV 自己能解，不要 ffmpeg。
//      即使没有语速要求，mp3 句子也要解码（拼起来要同一种 PCM），所以它需要 ffmpeg。报告不另记它（它不是「格式不同」，是解码）。
//   6. 报告：总时长（秒）、帧数、采样率、声道、接了几句（units）、插了几段静音（silences：次数和总毫秒数）、变了速的句子（speedChanged：{ number, speed }）、
//      统一过格式的句子（converted：号数）、notes（speed_not_applied 等）。
//
// 输入的 dub.json 形状（dub 命令写的）：{ units: [{ index, status, file, audio?… , pauseBeforeMs, pauseAfterMs, speed, stoppedBy? }], pack?, packs?, stoppedBy? }。
// 这里只用 units 里的 status、file、pauseBeforeMs、pauseAfterMs、speed；音频字节由命令行层按 file 读出来，作为 parts 传进来。
//
// 导出：
//   planMix(report)          检查报告，返回 { ok, stopped, incomplete, units }：stopped 是 dub 中途停下的 stoppedBy（没有就 null）；incomplete 是没做成的句子
//                            （{ number, status, error? }）；units 是要接的句子（{ number, file, pauseBeforeMs, pauseAfterMs, speed }）。ok 为假时命令行层不读音频、不写文件。
//   mixParts(env, parts)     parts 是 [{ number, bytes, speed, pauseBeforeMs, pauseAfterMs }]（次序就是台本的次序）。返回 { wav, report }：wav 是 Uint8Array（16 位 PCM 的 WAV），
//                            report 见第 6 条（不含文件名，文件名由命令行层加）。
//   resampleChannel、remixChannels：内部用，导出给测试。
import { decodeAudio } from '../tools/audio-decode.mjs';
import { encodeWav } from '../tools/wav.mjs';
import { VoicePackError } from '../protocol/lib/errors.mjs';

/** 变速（atempo）用的 ffmpeg 参数：输入、输出各一个文件（约定见 tools/audio-decode.mjs 的 @runtime ffmpeg；覆盖输出由运行环境加 -y）。 */
const ATEMPO_ARGS = (speed) => ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', '{input}', '-filter:a', `atempo=${speed}`, '-f', 'wav', '-acodec', 'pcm_f32le', '{output}'];

/** 检查 dub.json：能不能接成成品。 */
export function planMix(report) {
  const units = Array.isArray(report?.units) ? report.units : [];
  if (report?.stoppedBy !== undefined) {
    return { ok: false, stopped: report.stoppedBy, incomplete: [], units: [] };
  }
  const incomplete = units.filter((unit) => unit.status !== 'ok').map((unit) => ({ number: unit.index + 1, status: unit.status, ...(unit.error === undefined ? {} : { error: unit.error }) }));
  if (incomplete.length > 0) return { ok: false, stopped: null, incomplete, units: [] };
  return { ok: true, stopped: null, incomplete: [], units: units.map((unit) => ({ number: unit.index + 1, file: unit.file, pauseBeforeMs: unit.pauseBeforeMs ?? 0, pauseAfterMs: unit.pauseAfterMs ?? 0, speed: unit.speed ?? null })) };
}

/** 线性插值的窗口 sinc 重采样，单声道。from、to 是采样率。长度按时长取整（四舍五入）。 */
export function resampleChannel(samples, from, to) {
  if (from === to) return Float32Array.from(samples);
  const ratio = to / from;
  const length = Math.round(samples.length * ratio);
  const out = new Float32Array(length);
  // 截止频率取两者较低的那个（抗混叠），窗宽 16 个原采样点（Hann 窗）
  const cutoff = Math.min(1, ratio);
  const half = 16;
  for (let i = 0; i < length; i++) {
    const center = i / ratio;
    const first = Math.ceil(center - half);
    const last = Math.floor(center + half);
    let sum = 0;
    for (let k = Math.max(0, first); k <= Math.min(samples.length - 1, last); k++) {
      const x = center - k;
      const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
      const taper = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1));
      sum += samples[k] * sinc * taper;
    }
    out[i] = sum;
  }
  return out;
}

/** 声道合成：目标声道数 to。单声道变多声道：复制；多声道变单声道：平均；别的情况（比如 2 变 3）：按位置取，多出来的复制最后一个声道。 */
export function remixChannels(channels, to) {
  if (channels.length === to) return channels;
  if (to === 1) {
    const length = channels[0].length;
    const mono = new Float32Array(length);
    for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
    return [mono];
  }
  return Array.from({ length: to }, (_, c) => channels[Math.min(c, channels.length - 1)]);
}

/** 静音：frames 帧，每个声道 0。 */
const silence = (frames, channels) => Array.from({ length: channels }, () => new Float32Array(frames));
/** 毫秒换成帧（四舍五入）。 */
const framesOf = (ms, rate) => Math.round((ms * rate) / 1000);

/**
 * 把几句接成一个 WAV。parts：[{ bytes, speed, pauseBeforeMs, pauseAfterMs, number, file }]，次序就是台本的次序。
 * env：运行环境（只用 env.runtimes.ffmpeg：解码 WAV 以外的格式、有语速要求时的 atempo）。
 * @returns {Promise<{ wav: Uint8Array, report: object }>}
 */
export async function mixParts(env, parts) {
  if (parts.length === 0) throw new VoicePackError('mix_input_invalid', '没有可接的句子（dub.json 里一句都没有）');
  const ffmpeg = env?.runtimes?.ffmpeg;
  const notes = [];
  const speedChanged = [];
  const unapplied = []; // 有语速要求、没有 ffmpeg 的句子（号数）
  const decoded = [];
  for (const part of parts) {
    const slow = part.speed !== null && part.speed !== undefined && part.speed !== 1;
    let audio;
    if (slow && typeof ffmpeg === 'function') {
      // 变速：ffmpeg 吃这一句原来的字节（保持音高），吐出 WAV，再解。这一句的时长随之改变，拼接时用的就是变了的长度。
      audio = await decodeAudio(env, await ffmpeg(ATEMPO_ARGS(part.speed), part.bytes));
      speedChanged.push({ number: part.number, speed: part.speed });
    } else {
      audio = await decodeAudio(env, part.bytes); // 非 WAV 要 ffmpeg（没有就 runtime_missing）
      if (slow) unapplied.push(part.number);
    }
    decoded.push({ ...part, audio });
  }
  if (unapplied.length > 0) {
    notes.push({ code: 'speed_not_applied', message: `没有 ffmpeg，语速没有用上：第 ${unapplied.join('、')} 句照原速接上（dub.json 的 speed 记着台本要求的语速）`, details: { units: unapplied } });
  }
  // 成品的格式：第一句的采样率和声道。别的句子统一过去（记下是哪几句）
  const sampleRate = decoded[0].audio.sampleRate;
  const channels = decoded[0].audio.channels;
  const converted = decoded.filter((item) => item.audio.sampleRate !== sampleRate || item.audio.channels !== channels).map((item) => item.number);
  const pieces = [];
  let silences = 0;
  let silenceMs = 0;
  const pushSilence = (ms) => {
    if (ms <= 0) return;
    silences += 1;
    silenceMs += ms;
    pieces.push(silence(framesOf(ms, sampleRate), channels));
  };
  for (const item of decoded) {
    const samples = remixChannels(item.audio.samples, channels).map((channel) => resampleChannel(channel, item.audio.sampleRate, sampleRate));
    pushSilence(item.pauseBeforeMs ?? 0);
    pieces.push(samples);
    pushSilence(item.pauseAfterMs ?? 0);
  }
  const frames = pieces.reduce((sum, piece) => sum + piece[0].length, 0);
  const total = Array.from({ length: channels }, () => new Float32Array(frames));
  let at = 0;
  for (const piece of pieces) {
    for (let c = 0; c < channels; c++) total[c].set(piece[c], at);
    at += piece[0].length;
  }
  const wav = encodeWav({ sampleRate, samples: total }, { encoding: 'pcm16' });
  const report = {
    sampleRate,
    channels,
    frames,
    durationSeconds: frames / sampleRate,
    units: parts.length,
    silences: { count: silences, totalMs: silenceMs },
    speedChanged,
    converted,
    notes,
  };
  return { wav, report };
}

