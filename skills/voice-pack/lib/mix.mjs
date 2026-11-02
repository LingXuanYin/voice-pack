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
//      统一过格式的句子（converted：号数）、换人处削了静音的（turnTrims：几处、共几毫秒）、notes（speed_not_applied、silent_unit 等）。
//   7. 换人处（相邻两句的包 unit.pack 不同）：上一句的尾、下一句的头，静音各削到 TURN_EDGE_MS（50 毫秒），再插这一处标的停顿（规则 2）。
//      只削、不补：头或尾本来就不到 50 毫秒的，原样。同一个包接着说的两句不削。只有一个包（没有换人处）时，成品和没有这一条以前一字节不差。
//      静音的判法：每 SILENCE_FRAME_MS（10 毫秒）取一次 RMS，低于 SILENCE_DBFS（-40 dBFS）的算静音。整句都低于门限的不削，notes 里记 silent_unit。
//   8. 长度：停顿没有上限，写多长停多长。成品超过一份 16 位 WAV 能装的（RIFF 长度字段 32 位，单声道 44.1 kHz 时约 13.5 小时），抛 mix_too_long，
//      details 点名是哪一句、哪一边、多长。先按长度查，再分配：超大的停顿只是一个数字，不占内存。
//
// 输入的 dub.json 形状（dub 命令写的）：{ units: [{ index, status, file, audio?… , pauseBeforeMs, pauseAfterMs, speed, pack, stoppedBy? }], pack?, packs?, stoppedBy? }。
// 这里只用 units 里的 status、file、pauseBeforeMs、pauseAfterMs、speed、pack；音频字节由命令行层按 file 读出来，作为 parts 传进来。
//
// 导出：
//   planMix(report)          检查报告，返回 { ok, stopped, incomplete, units }：stopped 是 dub 中途停下的 stoppedBy（没有就 null）；incomplete 是没做成的句子
//                            （{ number, status, error? }）；units 是要接的句子（{ number, file, pack, pauseBeforeMs, pauseAfterMs, speed }）。ok 为假时命令行层不读音频、不写文件。
//   mixParts(env, parts)     parts 是 [{ number, bytes, speed, pauseBeforeMs, pauseAfterMs, pack }]（次序就是台本的次序；pack 没有就是 null）。返回 { wav, report }：wav 是 Uint8Array（16 位 PCM 的 WAV），
//                            report 见第 6 条（不含文件名，文件名由命令行层加）。
//   resampleChannel、remixChannels：内部用，导出给测试。
import { decodeAudio } from '../tools/audio-decode.mjs';
import { encodeWav, RIFF_SIZE_MAX, wavFileBytes } from '../tools/wav.mjs';
import { VoicePackError } from '../protocol/lib/errors.mjs';

/**
 * 换人处的静音（规则 7）。出处：对话里换人的间隔，众数在 0 到 200 毫秒（Stivers et al. 2009，PNAS 106(26)）；700 毫秒以上的多和不情愿的回应一起出现
 * （Levinson & Torreira 2015，Frontiers in Psychology 6:731）。两边各留 50 毫秒，没标停顿的换人处约 100 毫秒，落在众数里。
 * 静音的判法（每 10 毫秒一帧，低于 -40 dBFS 算静音）是量合成句子头尾静音时用的那一套（-30、-50 dBFS 只用来看敏感度）。
 */
const TURN_EDGE_MS = 50;
const SILENCE_DBFS = -40;
const SILENCE_FRAME_MS = 10;

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
  return { ok: true, stopped: null, incomplete: [], units: units.map((unit) => ({ number: unit.index + 1, file: unit.file, pack: unit.pack ?? null, pauseBeforeMs: unit.pauseBeforeMs ?? 0, pauseAfterMs: unit.pauseAfterMs ?? 0, speed: unit.speed ?? null })) };
}

/**
 * 计划阶段核长度（规则 8 的下限，dub 的 --dry-run 和正式运行在花钱之前都核）：照拼接的次序（每一句前面的停顿、一句的声音、后面的停顿）只加停顿的帧数。
 * 句子的声音要生成了才知道有多长，所以这里是下限：停顿加起来已经放不下，成品就一定放不下；放得下的，拼接时照常核。
 * 放不下，抛 mix_too_long，和拼接时抛的是同一个错（tooLongError）：点名是哪一句、哪一边的停顿、多长。
 * @param {{ number: number, pauseBeforeMs: number, pauseAfterMs: number }[]} units 按台本的次序；number 是句号（从 1 数）
 * @param {{ sampleRate: number, channels: number }} format 成品的采样率和声道（计划阶段按参考段估的）
 */
export function checkPausesFit(units, { sampleRate, channels }) {
  let frames = 0;
  for (const unit of units) {
    for (const [side, ms] of [['before', unit.pauseBeforeMs ?? 0], ['after', unit.pauseAfterMs ?? 0]]) {
      if (ms <= 0) continue;
      const pieceFrames = framesOf(ms, sampleRate);
      if (!fitsWav(frames + pieceFrames, channels)) throw tooLongError({ number: unit.number, pause: { side, ms } }, frames, channels, sampleRate);
      frames += pieceFrames;
    }
  }
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

/** 毫秒换成帧（四舍五入）。 */
const framesOf = (ms, rate) => Math.round((ms * rate) / 1000);
/** 一份 16 位 PCM 的 WAV 能装的最多帧数：RIFF 长度字段是 32 位，数据最多 4294967258 字节，单声道是 2147483629 帧（见 tools/wav.mjs 的 wavFileBytes）。 */
const maxFramesOf = (channels) => Math.floor((RIFF_SIZE_MAX + 8 - wavFileBytes(0, channels, 'pcm16')) / (2 * channels));
/** 接上以后的总帧数装得下一份 WAV 吗（和 encodeWav 查的是同一条）。 */
const fitsWav = (frames, channels) => frames <= maxFramesOf(channels);
/** 秒数的读法：毫秒换成秒；超出浮点数能表示的范围（解析器已经挡住，这里是直接递进来的）就照实说。 */
const secondsOf = (ms) => (Number.isFinite(ms) ? Math.round(ms) / 1000 : '超出能表示的范围');

/**
 * 放不下：piece（一处停顿，或一句的声音）接在 framesBefore 帧后面，成品超过一份 WAV。按长度查出来的，不分配。
 * details：number（句号）、side（停顿在这一句的前面 'before' 还是后面 'after'；是一句的声音时为 null）、pauseMs（停顿毫秒，同上为 null）、
 * framesBefore（放这一段之前已经有的帧数）、maxFrames（一份 WAV 最多的帧数）、sampleRate、channels。
 */
function tooLongError(piece, framesBefore, channels, sampleRate) {
  const maxFrames = maxFramesOf(channels);
  const limit = Math.floor(maxFrames / sampleRate);
  const before = framesBefore >= sampleRate ? `前面已经有 ${Math.floor(framesBefore / sampleRate)} 秒，` : '';
  const what = piece.pause
    ? `第 ${piece.number} 句${piece.pause.side === 'before' ? '前面' : '后面'}的停顿（${secondsOf(piece.pause.ms)} 秒）放不下`
    : `第 ${piece.number} 句放不下`;
  const message = `${what}：${before}接上它以后，成品超过一份 WAV 能装的长度（${sampleRate} Hz、${channels} 声道时最长 ${limit} 秒）。请把停顿写短，或者把稿子分成几份出（每份装得下）。`;
  const details = {
    number: piece.number,
    side: piece.pause ? piece.pause.side : null,
    pauseMs: piece.pause ? piece.pause.ms : null,
    framesBefore,
    maxFrames,
    sampleRate,
    channels,
  };
  return new VoicePackError('mix_too_long', message, { details });
}

/**
 * 长度上装得下，可是这台机器的内存放不下（拼的时候分配失败，是 RangeError）：也是 mix_too_long，details.reason 为 'memory'，
 * 点名最长的一处停顿（没有停顿就是 null），frames 是成品的总帧数。
 */
function outOfMemoryError(pieces, frames, channels, sampleRate, cause) {
  let longest = null;
  for (const piece of pieces) {
    if (piece.pause && (longest === null || piece.pause.ms > longest.pause.ms)) longest = piece;
  }
  const where = longest ? `最长的一处停顿是第 ${longest.number} 句${longest.pause.side === 'before' ? '前面' : '后面'}的 ${secondsOf(longest.pause.ms)} 秒。` : '';
  const message = `成品有 ${Math.round(frames / sampleRate)} 秒，长度上装得下一份 WAV，可是这台机器的内存放不下它（${cause.message}）。${where}请把停顿写短，或者把稿子分成几份出（每份装得下）。`;
  const details = {
    reason: 'memory',
    number: longest ? longest.number : null,
    side: longest ? longest.pause.side : null,
    pauseMs: longest ? longest.pause.ms : null,
    frames,
    maxFrames: maxFramesOf(channels),
    sampleRate,
    channels,
  };
  return new VoicePackError('mix_too_long', message, { details, cause });
}

/** 有声的范围（样本）：第一帧的开头、最后一帧的末尾（超过门限的）。整句都低于门限就是 null。每帧按各声道平均后的 RMS 算。 */
function activeSpan(channels, rate) {
  const length = channels[0].length;
  const frame = Math.max(1, Math.round((rate * SILENCE_FRAME_MS) / 1000));
  let first = -1;
  let last = -1;
  for (let start = 0; start < length; start += frame) {
    const end = Math.min(length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i];
      mono /= channels.length;
      sum += mono * mono;
    }
    const rms = Math.sqrt(sum / (end - start));
    if (rms > 0 && 20 * Math.log10(rms) > SILENCE_DBFS) {
      if (first < 0) first = start;
      last = end;
    }
  }
  return first < 0 ? null : { first, last };
}

/**
 * 换人处的一句：头（head）、尾（tail）的静音削到 TURN_EDGE_MS 毫秒，只削、不补。整句静音返回 null。
 * 返回削完的声道数列，和削掉的样本数 cutHead、cutTail（在这一句自己的采样率下算）。
 */
function trimTurnEdges(audio, { head, tail }) {
  const { samples, sampleRate } = audio;
  const span = activeSpan(samples, sampleRate);
  if (span === null) return null;
  const keep = Math.round((sampleRate * TURN_EDGE_MS) / 1000);
  const length = samples[0].length;
  const cutHead = head ? Math.max(0, span.first - keep) : 0;
  const cutTail = tail ? Math.max(0, length - (span.last + keep)) : 0;
  return { samples: samples.map((channel) => channel.slice(cutHead, length - cutTail)), cutHead, cutTail };
}

/**
 * 把几句接成一个 WAV。parts：[{ bytes, speed, pauseBeforeMs, pauseAfterMs, number, file, pack }]，次序就是台本的次序。
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
  // 换人处（规则 7）：相邻两句的包不同。第 i 句的头削的是它和第 i-1 句之间的那一处，尾削的是它和第 i+1 句之间的那一处
  const packOf = (part) => part.pack ?? null;
  const turnBefore = decoded.map((item, i) => i > 0 && packOf(decoded[i - 1]) !== packOf(item));
  const turnAfter = decoded.map((item, i) => i + 1 < decoded.length && packOf(decoded[i + 1]) !== packOf(item));
  const trimmedTurns = new Set(); // 削了静音的换人处（用前一句的下标）
  let trimmedMs = 0;
  const silentTurnUnits = []; // 整句低于门限的（号数）：它的静音不削
  decoded.forEach((item, i) => {
    if (!turnBefore[i] && !turnAfter[i]) return;
    const cut = trimTurnEdges(item.audio, { head: turnBefore[i], tail: turnAfter[i] });
    if (cut === null) {
      silentTurnUnits.push(item.number);
      return;
    }
    if (cut.cutHead > 0) {
      trimmedTurns.add(i - 1);
      trimmedMs += (cut.cutHead * 1000) / item.audio.sampleRate;
    }
    if (cut.cutTail > 0) {
      trimmedTurns.add(i);
      trimmedMs += (cut.cutTail * 1000) / item.audio.sampleRate;
    }
    item.audio = { ...item.audio, samples: cut.samples, frames: cut.samples[0].length };
  });
  if (silentTurnUnits.length > 0) {
    notes.push({ code: 'silent_unit', message: `第 ${silentTurnUnits.join('、')} 句整句低于 ${SILENCE_DBFS} dBFS（是静音），换人处不削它的静音，照原样接上`, details: { units: silentTurnUnits } });
  }
  // 成品的格式：第一句的采样率和声道。别的句子统一过去（记下是哪几句）
  const sampleRate = decoded[0].audio.sampleRate;
  const channels = decoded[0].audio.channels;
  const converted = decoded.filter((item) => item.audio.sampleRate !== sampleRate || item.audio.channels !== channels).map((item) => item.number);
  // 段：一句的声音（samples），或者一处停顿（只记长度，不分配：静音要到拼的时候才写成零）。
  // 长度按段加起来查：哪一段接上以后，成品就超过一份 WAV 能装的，就在那一段报错（点名是哪一句、哪一边、多长）。这一步在分配成品的数组之前。
  const pieces = [];
  let silences = 0;
  let silenceMs = 0;
  const pushSilence = (ms, number, side) => {
    if (ms <= 0) return;
    silences += 1;
    silenceMs += ms;
    pieces.push({ number, frames: framesOf(ms, sampleRate), pause: { side, ms } });
  };
  for (const item of decoded) {
    const samples = remixChannels(item.audio.samples, channels).map((channel) => resampleChannel(channel, item.audio.sampleRate, sampleRate));
    pushSilence(item.pauseBeforeMs ?? 0, item.number, 'before');
    pieces.push({ number: item.number, frames: samples[0].length, samples });
    pushSilence(item.pauseAfterMs ?? 0, item.number, 'after');
  }
  let frames = 0;
  for (const piece of pieces) {
    if (!fitsWav(frames + piece.frames, channels)) throw tooLongError(piece, frames, channels, sampleRate);
    frames += piece.frames;
  }
  let wav;
  try {
    const total = Array.from({ length: channels }, () => new Float32Array(frames));
    let at = 0;
    for (const piece of pieces) {
      if (piece.samples) for (let c = 0; c < channels; c++) total[c].set(piece.samples[c], at);
      at += piece.frames;
    }
    wav = encodeWav({ sampleRate, samples: total }, { encoding: 'pcm16' });
  } catch (error) {
    // 长度上装得下，可是这台机器的内存放不下（分配失败是 RangeError）：说成同一个错，点名最长的一处停顿，不当成程序崩了
    if (!(error instanceof RangeError)) throw error;
    throw outOfMemoryError(pieces, frames, channels, sampleRate, error);
  }
  const report = {
    sampleRate,
    channels,
    frames,
    durationSeconds: frames / sampleRate,
    units: parts.length,
    silences: { count: silences, totalMs: silenceMs },
    speedChanged,
    converted,
    turnTrims: { count: trimmedTurns.size, totalMs: Math.round(trimmedMs) },
    notes,
  };
  return { wav, report };
}

