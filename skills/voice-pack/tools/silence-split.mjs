// SPDX-License-Identifier: Apache-2.0
//
// 按能量把一段长录音切成段：找出哪里在说话、哪里是停顿，在停顿里切，每一段长度落在参考段的要求里（每段 5–20 秒，
// 数值取自音质检查 REFERENCE_THRESHOLDS.duration，不另写一份）。只做计算，不用模型，不取所需能力，确定性：同样的输入，逐字段同样的输出。
//
// 为什么有它：切长录音，环境有 voice-activity-detection 就用它；没有的环境，原先的设想是用转写的时间戳切。转写的返回里没有时间戳
// （vocab/capability-signatures.md），所以没有 voice-activity-detection 的环境改用这里的按能量找静音来切；切好以后逐段转写，文字自然就对上了段。
//
//   splitBySilence(audio, options?)                 -> { segments, dropped, analysis }
//   segmentSpeechRegions(audio, regions, options?)  -> { segments, dropped, analysis }   自己已经知道哪里在说话（例如 voice-activity-detection 给的区间）
//
// audio 是解码出来的 { sampleRate, samples: Float32Array[] }（tools/audio-decode.mjs 的 decodeAudio 的结果可以直接给），整段放在内存里：
// 一小时 16 kHz 单声道约 230 MB（Float32），更长的先分几块处理。
//
// ---------------------------------------------------------------- 怎么切
//   1 电平      每 20 毫秒一个窗口，各声道功率相加再取有效值（dBFS；单声道就是它自己的有效值），同音质检查用的那一把尺（tools/audio-quality.mjs 的 windowLevels，定义写在它的文件头）。
//               多个声道时电平是相加的：两个声道一样的录音比单声道高 3.01 dB，反相的两个声道也不会抵消。下面 2 的阈值是相对的，不受影响，
//               夹的范围（−60 到 −35 dBFS）和「没有说话」的 −50 dBFS 是绝对的，按这个电平比。lib/long-recording.mjs 切之前自己先把多个声道取平均成单声道，交进来的是单声道，不受这一条影响。
//   2 阈值      没给 thresholdDbfs 就按这段录音自己估：noise = 所有窗口电平的第 10 百分位（最安静的一成），speech = 第 95 百分位，
//               阈值 = noise + 0.35 × (speech − noise)，夹在 −60 到 −35 dBFS 之间。所以房间底噪高（−45 dBFS）的录音也找得到停顿。
//               speech 低于 −50 dBFS：整段没有说话（全是静音、底噪），不切，丢弃里写 no_speech。
//               speech 和 noise 差不到 10 dB：分不出哪里是停顿（一直有背景音乐、持续的噪声），analysis.discernible 是 false，
//               整段当作一直在响，只能硬切（下面第 5 条）。
//   3 说话的区间  电平高于阈值的窗口是「有声音」。短于 minPauseSeconds 的静音当作字词、音节之间的间隙，填上；填完以后短于 0.1 秒的零星小声音（点击声、
//               咳嗽）不算说话。这一步不分人声和别的声音：背景音乐、掌声、噪声都算有声音。要先分出人声，用 audio-source-separation（lib/long-recording.mjs）。
//   4 合并成段  从前往后，把相邻的说话区间并成一段，在这几种停顿处切：
//                 · 停顿长于 joinGapSeconds（1.5 秒）：一定切，段里不留这么长的静音；
//                 · 再并一个区间会超过 maxSeconds：切；
//                 · 这一段已经够 minSeconds，而且停顿不短于 sentencePauseSeconds（0.5 秒，句间停顿的长度）：切；
//               所以一句话够长就自己一段，几句短话合成一段，逗号那样的短停顿（minPauseSeconds 到 sentencePauseSeconds）只在「还没够长」时跨过去。
//               最后一段（或者因为「再并就超长」而剩下的短段）不够 minSeconds，能并进上一段（停顿不长于 joinGapSeconds、并起来不超过 maxSeconds）就并进去。
//   5 硬切      一个说话区间长于 maxSeconds，里面没有停顿（说话一口气不停，或者分不出停顿）：在允许的长度范围里找最安静的地方切
//               （电平平滑 0.1 秒以后的最小值，有几个一样低取最前面的），每段不超过 maxSeconds、不短于 minSeconds。这样的边界标成 forced。
//   6 留边      每段前后各留 paddingSeconds（0.15 秒）的静音；两段之间的停顿不够留，就各留一半；录音的头尾夹在录音里。硬切的边界没有留边（两段首尾相接）。
//   7 零头      没够 minSeconds、也并不进上一段的：够 shortestSeconds（3 秒，音质检查的「拒绝」线）留着，标 short: true；不够就丢掉，写进 dropped（too_short）。
//
// ---------------------------------------------------------------- 选项（都可选，单位秒；写错名字抛 TypeError）
//   minSeconds            一段至少多长，默认 5（REFERENCE_THRESHOLDS.duration.warnBelow）
//   maxSeconds            一段至多多长，默认 20（…warnAbove）
//   shortestSeconds       短于 minSeconds 的零头最短留多长，默认 3（…rejectBelow）
//   paddingSeconds        前后各留多长的静音，默认 0.15
//   minPauseSeconds       短于它的静音是字词之间的间隙，默认 0.3
//   sentencePauseSeconds  不短于它的停顿是句间停顿，默认 0.5
//   joinGapSeconds        长于它的停顿一定要切开，默认 1.5
//   thresholdDbfs         手动给阈值；不给就自动估
//
// ---------------------------------------------------------------- 返回
//   segments  [{ startSec, endSec, durationSec, startSample, endSample, speechSec, short, cut: { start, end } }]
//             时间是秒（保留到毫秒），采样点是整数（endSample 不含），两者对得上；speechSec 是段里有声音的时长；short 是不够 minSeconds
//             （只有零头会）；cut 说这一段的两头是怎么来的：'pause'（切在停顿或头尾的静音里）、'forced'（硬切）、'edge'（就是录音的头或尾）。
//             段按时间先后排，互不重叠。
//   dropped   [{ startSec, endSec, durationSec, reason }]，reason 是 'too_short'（零头不够 shortestSeconds）或 'no_speech'（整段都没有说话，
//             这时范围是整段录音）。头尾和段之间纯静音的部分不算丢弃，不列出。
//   analysis  { durationSec, noiseDbfs, speechDbfs, thresholdDbfs, discernible, regions, forcedCuts }：这段录音自己的电平、用的阈值（分不出停顿时是 null）、
//             说话的区间有几个、硬切了几处。调用方可以据此提醒用户（例如 discernible 是 false，或者硬切了很多处）。
//
// 抛出的错误：TypeError（audio 的形状不对、选项写错）。没有 VoicePackError：这里不碰运行环境。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { REFERENCE_THRESHOLDS, WINDOW_SECONDS, checkedAudio, windowLevels } from './audio-quality.mjs';

const NOISE_PERCENTILE = 0.1;
const SPEECH_PERCENTILE = 0.95;
const THRESHOLD_FRACTION = 0.35;
const THRESHOLD_FLOOR_DBFS = -60;
const THRESHOLD_CEILING_DBFS = -35;
const MIN_CONTRAST_DB = 10;
const NO_SPEECH_DBFS = -50;
const BLIP_SECONDS = 0.1;
const SMOOTH_FRAMES = 5;

/** 选项的默认值。时长的三个数取自音质检查，不另写一份。 */
export const DEFAULTS = Object.freeze({
  minSeconds: REFERENCE_THRESHOLDS.duration.warnBelow,
  maxSeconds: REFERENCE_THRESHOLDS.duration.warnAbove,
  shortestSeconds: REFERENCE_THRESHOLDS.duration.rejectBelow,
  paddingSeconds: 0.15,
  minPauseSeconds: 0.3,
  sentencePauseSeconds: 0.5,
  joinGapSeconds: 1.5,
});

const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

function readOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options 必须是对象，例如 { minSeconds: 4 }');
  const known = [...Object.keys(DEFAULTS), 'thresholdDbfs'];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw new TypeError(`不认识的选项 ${key}（有：${known.join('、')}）`);
  }
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] === undefined) continue;
    if (typeof options[key] !== 'number' || !Number.isFinite(options[key]) || options[key] < 0) throw new TypeError(`${key} 必须是不小于 0 的有限数（秒），收到 ${JSON.stringify(options[key])}`);
    merged[key] = options[key];
  }
  if (options.thresholdDbfs !== undefined) {
    if (typeof options.thresholdDbfs !== 'number' || !Number.isFinite(options.thresholdDbfs)) throw new TypeError(`thresholdDbfs 必须是有限数（dBFS），收到 ${JSON.stringify(options.thresholdDbfs)}`);
    merged.thresholdDbfs = options.thresholdDbfs;
  }
  if (!(merged.minSeconds > 0)) throw new TypeError('minSeconds 必须大于 0');
  if (!(merged.maxSeconds > merged.minSeconds)) throw new TypeError(`maxSeconds（${merged.maxSeconds}）必须大于 minSeconds（${merged.minSeconds}）`);
  if (merged.shortestSeconds > merged.minSeconds) throw new TypeError(`shortestSeconds（${merged.shortestSeconds}）不能比 minSeconds（${merged.minSeconds}）长`);
  if (merged.maxSeconds - 2 * merged.paddingSeconds < merged.minSeconds) throw new TypeError(`paddingSeconds（${merged.paddingSeconds}）太大：前后各留这么多，maxSeconds 里放不下 minSeconds`);
  if (!(merged.minPauseSeconds > 0)) throw new TypeError('minPauseSeconds 必须大于 0');
  if (merged.minPauseSeconds > merged.sentencePauseSeconds) throw new TypeError(`minPauseSeconds（${merged.minPauseSeconds}）不能比 sentencePauseSeconds（${merged.sentencePauseSeconds}）长`);
  if (merged.sentencePauseSeconds > merged.joinGapSeconds) throw new TypeError(`sentencePauseSeconds（${merged.sentencePauseSeconds}）不能比 joinGapSeconds（${merged.joinGapSeconds}）长`);
  return merged;
}

/** 填上短于 minPause 的静音（只填两段有声音之间的，不碰头尾），再去掉短于 blip 的零星小声音。active 是 0/1 数组，原地改。 */
function smooth(active, minPauseFrames, blipFrames) {
  const n = active.length;
  let i = 0;
  while (i < n) {
    if (active[i] === 1) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && active[j] === 0) j++;
    if (i > 0 && j < n && j - i < minPauseFrames) active.fill(1, i, j);
    i = j;
  }
  i = 0;
  while (i < n) {
    if (active[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && active[j] === 1) j++;
    if (j - i < blipFrames) active.fill(0, i, j);
    i = j;
  }
}

/** 有声音的区间，[{ start, end }]，帧下标，end 不含。 */
function regionsOf(active) {
  const regions = [];
  let i = 0;
  while (i < active.length) {
    if (active[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < active.length && active[j] === 1) j++;
    regions.push({ start: i, end: j });
    i = j;
  }
  return regions;
}

/** 电平平滑 SMOOTH_FRAMES 帧（取平均）的前缀和，硬切时找最安静的地方用。 */
function prefixOf(levels) {
  const prefix = new Float64Array(levels.length + 1);
  for (let i = 0; i < levels.length; i++) prefix[i + 1] = prefix[i] + levels[i];
  return prefix;
}

/** 在 [lo, hi]（帧下标，含）里找平滑电平最低的那一帧，一样低取最前面的。 */
function quietest(prefix, count, lo, hi) {
  const half = Math.floor(SMOOTH_FRAMES / 2);
  let best = lo;
  let bestLevel = Infinity;
  for (let f = lo; f <= hi; f++) {
    const from = Math.max(0, f - half);
    const to = Math.min(count, f + half + 1);
    const level = (prefix[to] - prefix[from]) / (to - from);
    if (level < bestLevel) {
      bestLevel = level;
      best = f;
    }
  }
  return best;
}

/**
 * 把「有声音的区间」切成段（第 4 到 7 步，文件头）。
 * @returns {{ segments: object[], dropped: object[], forcedCuts: number }}
 */
function plan({ regions, levels, activeFrames, frames, rate, frameSamples, o }) {
  const fs = frameSamples / rate; // 一帧多少秒
  const count = levels.length;
  const limit = Math.max(1, Math.floor((o.maxSeconds - 2 * o.paddingSeconds) / fs)); // 一段里有声音的跨度最多多少帧（留边以后不超过 maxSeconds）
  const want = Math.max(1, Math.ceil((o.minSeconds - 2 * o.paddingSeconds) / fs)); // 至少多少帧，才算够长
  const prefix = prefixOf(levels);

  // 5 硬切：太长的区间在最安静的地方切开。硬切的边界不留边，所以这里的上下限按整个 minSeconds、maxSeconds 算（区间的头尾还要留边，所以第一段少算一份）
  const forcedMin = Math.max(1, Math.ceil(o.minSeconds / fs));
  let forcedCuts = 0;
  const pieces = [];
  for (const region of regions) {
    let start = region.start;
    let first = true;
    while (region.end - start > limit) {
      const lo = start + forcedMin;
      const hi = Math.max(lo, Math.min(start + Math.floor((o.maxSeconds - (first ? o.paddingSeconds : 0)) / fs), region.end - forcedMin));
      const cut = quietest(prefix, count, lo, hi);
      pieces.push({ start, end: cut, forcedBefore: !first });
      forcedCuts++;
      start = cut;
      first = false;
    }
    pieces.push({ start, end: region.end, forcedBefore: !first });
  }

  // 4 合并成段
  const merged = [];
  let current = null;
  for (const piece of pieces) {
    if (current === null) {
      current = { ...piece, forcedAfter: false };
      continue;
    }
    const gapSeconds = (piece.start - current.end) * fs;
    const span = piece.end - current.start;
    const mustBreak = piece.forcedBefore || gapSeconds > o.joinGapSeconds || span > limit;
    const longEnough = current.end - current.start >= want;
    if (mustBreak || (longEnough && gapSeconds >= o.sentencePauseSeconds)) {
      current.forcedAfter = piece.forcedBefore;
      merged.push(current);
      current = { ...piece, forcedAfter: false };
    } else current.end = piece.end;
  }
  if (current !== null) merged.push(current);

  // 7 零头：没够长的，能并进上一段就并进去
  const segments = [];
  for (const seg of merged) {
    const prev = segments.at(-1);
    const short = seg.end - seg.start < want;
    if (short && prev !== undefined && !prev.forcedAfter && (seg.start - prev.end) * fs <= o.joinGapSeconds && seg.end - prev.start <= limit) {
      prev.end = seg.end;
      prev.forcedAfter = seg.forcedAfter;
    } else segments.push(seg);
  }

  // 6 留边：先算出每一段的采样点，再看是不是零头
  const pad = Math.round(o.paddingSeconds * rate);
  const raw = segments.map((seg) => ({ seg, from: seg.start * frameSamples, to: Math.min(seg.end * frameSamples, frames) }));
  raw.forEach((item, i) => {
    const before = raw[i - 1];
    const after = raw[i + 1];
    const contiguousBefore = item.seg.forcedBefore && before !== undefined && before.seg.forcedAfter;
    const room = (a, b) => Math.max(0, Math.floor((b - a) / 2)); // 两段之间的停顿，各留一半
    item.startSample = contiguousBefore ? item.from : Math.max(0, item.from - (before === undefined ? pad : Math.min(pad, room(before.to, item.from))));
    item.endSample = item.seg.forcedAfter ? item.to : Math.min(frames, item.to + (after === undefined ? pad : Math.min(pad, room(item.to, after.from))));
  });

  const kept = [];
  const dropped = [];
  for (const item of raw) {
    const { seg, startSample, endSample } = item;
    const durationSec = (endSample - startSample) / rate;
    const startSec = round(startSample / rate, 3);
    const endSec = round(endSample / rate, 3);
    if (durationSec < o.shortestSeconds - 1e-9) {
      dropped.push({ startSec, endSec, durationSec: round(durationSec, 3), reason: 'too_short' });
      continue;
    }
    kept.push({
      startSec,
      endSec,
      durationSec: round(durationSec, 3),
      startSample,
      endSample,
      speechSec: round((activeFrames[Math.min(seg.end, count)] - activeFrames[seg.start]) * fs, 3),
      short: durationSec < o.minSeconds - 1e-9,
      cut: {
        start: seg.forcedBefore ? 'forced' : startSample === 0 ? 'edge' : 'pause',
        end: seg.forcedAfter ? 'forced' : endSample === frames ? 'edge' : 'pause',
      },
    });
  }
  return { segments: kept, dropped, forcedCuts };
}

function analyse(audio, o, givenRegions) {
  const { sampleRate: rate, samples } = checkedAudio(audio);
  const frames = samples[0].length;
  const frameSamples = Math.max(1, Math.round(rate * WINDOW_SECONDS));
  const levels = windowLevels(samples, rate);
  const count = levels.length;
  const durationSec = round(frames / rate, 3);
  const analysis = { durationSec, noiseDbfs: null, speechDbfs: null, thresholdDbfs: null, discernible: false, regions: 0, forcedCuts: 0 };
  if (count === 0) return { segments: [], dropped: [], analysis };

  const sorted = Float64Array.from(levels).sort();
  const at = (p) => sorted[Math.floor((sorted.length - 1) * p)];
  const noise = at(NOISE_PERCENTILE);
  const speech = at(SPEECH_PERCENTILE);
  analysis.noiseDbfs = round(noise, 1);
  analysis.speechDbfs = round(speech, 1);
  analysis.discernible = speech - noise >= MIN_CONTRAST_DB;

  const active = new Uint8Array(count);
  let regions;
  if (givenRegions !== null) {
    // 调用方已经知道哪里在说话：秒换成帧，不再看电平
    for (const r of givenRegions) active.fill(1, Math.max(0, Math.floor((r.start_sec * rate) / frameSamples)), Math.min(count, Math.ceil((r.end_sec * rate) / frameSamples)));
    regions = regionsOf(active);
  } else {
    let threshold = null;
    if (o.thresholdDbfs !== undefined) threshold = o.thresholdDbfs;
    else if (speech >= NO_SPEECH_DBFS && analysis.discernible) threshold = round(Math.min(THRESHOLD_CEILING_DBFS, Math.max(THRESHOLD_FLOOR_DBFS, noise + THRESHOLD_FRACTION * (speech - noise))), 1);
    analysis.thresholdDbfs = threshold;
    const quietEverywhere = o.thresholdDbfs === undefined ? speech < NO_SPEECH_DBFS : false;
    if (quietEverywhere) active.fill(0);
    else if (threshold === null) active.fill(1); // 分不出停顿：整段当作一直在响
    else for (let i = 0; i < count; i++) active[i] = levels[i] > threshold ? 1 : 0;
    smooth(active, Math.max(1, Math.round(o.minPauseSeconds / (frameSamples / rate))), Math.max(1, Math.round(BLIP_SECONDS / (frameSamples / rate))));
    regions = regionsOf(active);
  }
  analysis.regions = regions.length;
  if (regions.length === 0) {
    return { segments: [], dropped: [{ startSec: 0, endSec: durationSec, durationSec, reason: 'no_speech' }], analysis };
  }
  const activeFrames = new Int32Array(count + 1); // 前缀和：到第 i 帧为止有多少有声音的帧
  for (let i = 0; i < count; i++) activeFrames[i + 1] = activeFrames[i] + active[i];
  const planned = plan({ regions, levels, activeFrames, frames, rate, frameSamples, o });
  analysis.forcedCuts = planned.forcedCuts;
  return { segments: planned.segments, dropped: planned.dropped, analysis };
}

/**
 * 按能量切长录音。选项、返回、怎么切见文件头。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio decodeAudio 的结果可以直接给
 * @param {object} [options]
 * @returns {{ segments: object[], dropped: object[], analysis: object }}
 * @throws {TypeError} audio 的形状不对，或者选项写错（点名）
 */
export function splitBySilence(audio, options = {}) {
  return analyse(audio, readOptions(options), null);
}

/**
 * 调用方已经知道哪里在说话（例如 voice-activity-detection 给的区间）：用它们当「有声音的区间」，后面的合并、长度上限、硬切都和 splitBySilence 一样。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio 同 splitBySilence；硬切要用它的电平找最安静的地方
 * @param {{ start_sec: number, end_sec: number }[]} regions 说话的区间，秒，按先后排，互不重叠
 * @param {object} [options] 同 splitBySilence（thresholdDbfs 用不上）
 * @throws {TypeError} audio、regions、选项写错
 */
export function segmentSpeechRegions(audio, regions, options = {}) {
  const o = readOptions(options);
  if (!Array.isArray(regions)) throw new TypeError('regions 必须是数组：[{ start_sec, end_sec }]');
  let previousEnd = 0;
  regions.forEach((r, i) => {
    const ok = r !== null && typeof r === 'object' && Number.isFinite(r.start_sec) && Number.isFinite(r.end_sec) && r.start_sec >= previousEnd && r.end_sec > r.start_sec;
    if (!ok) throw new TypeError(`regions[${i}] 必须是 { start_sec, end_sec }，0 <= start_sec < end_sec，并且不早于上一个区间的结束`);
    previousEnd = r.end_sec;
  });
  return analyse(audio, o, regions);
}
