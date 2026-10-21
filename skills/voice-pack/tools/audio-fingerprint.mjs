// SPDX-License-Identifier: Apache-2.0
//
// 音频指纹（官方小工具，只做计算，不用模型）：找两段音频里有没有「直接复用」的部分，也就是同一段录音，不管它后来重新编码、改了响度、重采样、
// 截头去尾、混进一段更长的录音。查重（lib/duplicate-check.mjs）用它比新包的录音和来源包的录音：音频用指纹找有没有直接复用的片段；
// 不比说话人像不像（同一个配音演员给几个角色配音很正常），所以同一个人说的另一句话不会被认成复用。
//
//   fingerprintAudio(audio, options?)         一段音频的指纹
//   indexFingerprints(entries, options?)      把一组指纹（来源包的所有录音）建成一个索引，entries 是 [{ id, fingerprint }]
//   findReuse(query, index, options?)         一段音频的指纹，和索引里的哪些录音「是同一段录音」，一共有多少秒
//   MATCHING                                  找复用时的默认设置
//
// 做法（地标指纹，Wang 2003，https://www.ee.columbia.edu/~dpwe/papers/Wang03-shazam.pdf；Ellis 的 audfprint 的参数也是参考）：
//   1. 变成单声道，重采样到 8000 Hz（带窗口的 sinc 插值，先低通），预加重（0.97，把语音偏低的频谱压平，高频的峰也有机会入选）。
//   2. 短时傅立叶变换：汉宁窗 512 点（64 毫秒），每 128 点（16 毫秒）一帧；取 300–3400 Hz（语音的主要频段）的对数功率谱。
//   3. 找谱峰：一个点同时是它周围 ±6 帧（±96 毫秒）× ±8 个频点（±125 Hz）里最大的，并且比这一帧里它两边各 20 个频点（±312 Hz）的平均高至少 9 dB（有谐波结构才有这样的峰，噪声和
//      清音没有），还要比整段音频最响的地方低不到 70 dB。这三条都是相对的量，所以改整体的响度、加一点噪声，选出来的峰基本不变；压缩器、限幅器改的是各处的相对响度，
//      峰的位置（时间和频率）不变，选峰靠的是局部比较，不靠绝对电平。
//   4. 把相隔不远的峰配成对：每个峰（锚点）和它后面 1–63 帧之内、频率差不超过 63 个频点（约 1 kHz）的最多 6 个峰配对，一对的哈希是（锚点的频率，两个峰的频率差，两个峰的时间差）三个量拼成的
//      21 位整数。一个哈希在这一对峰所在的两处时间上都出现，才算「对上」。
//   5. 比较：来源的每个哈希按（哪一段录音，哈希出现的时间）存进索引；查询的每个哈希去索引里找，每找到一个，记一票「来源时间 − 查询时间」。
//      同一段录音的任何一个片段，所有票的「来源时间 − 查询时间」都一样（就是这个片段在两边的位置差），所以票集中在一个位置差上；
//      不是同一段录音，票零零散散落在各处，最多的位置差上也只有几票。位置差 ±1 帧都算同一个（帧是 16 毫秒，两边的帧对不齐时峰的时间会差一帧）。
//   6. 一个位置差上的票超过 minMatches，才认为这两段录音有一部分是同一段；票落在查询的哪些时间上（锚点的时间），每一票覆盖锚点到它配的那个峰（最多 1 秒以后）；
//      覆盖的区间接着前一个覆盖的地方、中间的空隙不超过 gapSec 的连成一段，票数不到 minRunMatches 的一小段不算，剩下的各段的时间长度加起来就是「复用了多少秒」。
//      所有来源录音的结果合起来，查询时间上重叠的只算一次。静音没有谱峰，所以量出来的是「有声音的那一段」，不含两头的静音。
//   这不是比说话人像不像：哈希里是具体的谱峰的时间和频率，同一个人说的另一句话，谱峰的位置不一样，票不会集中在一个位置差上。
//
// 能抗什么、不能抗什么（标定的数字写在 lib/duplicate-check.mjs 的文件头；标定的数据和脚本不随基础部分发布）：
//   抗：重新编码（mp3、opus、aac）、改整体响度、压缩器和限幅器、重采样、截头去尾、整段混进更长的录音、叠上别人的声音、加噪声。
//   不抗：变速、变调（谱峰整体移了位置）、重新念一遍（不是同一段录音）、先分离人声再比（分离改了声音，抗得住多少没量）。这些不是「直接复用」，查重也不管。
//
// 输入的形状同 tools/wav.mjs 的 parseWav：{ sampleRate, samples: Float32Array[] }（每个声道一个数组）。很长的录音（十几分钟）按秒数线性地花时间和内存。
//
// 指纹的形状：{ version, durationSec, hopSec, peaks, hashes: Uint32Array, times: Int32Array }，hashes[i] 在 times[i]（帧号）处出现；按时间排好。
// findReuse 的返回：
//   { reusedSeconds, clips: [{ id, matches, offsetSec, runs: [{ startSec, endSec, matches }] }] }
//   reusedSeconds   查询里有多少秒是来源里的录音（所有来源录音合起来）
//   clips           每一段对上了的来源录音（票数超过 minMatches 的）：matches 是最集中的位置差上的票数；
//                   offsetSec 是来源时间减查询时间（秒）；runs 是查询里对上的各段（startSec、endSec 是查询里的时间）
//
// 错误：选项写错抛 TypeError。音频太短（不到一帧）不抛错，指纹是空的，findReuse 给 0 秒。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export const FINGERPRINT_VERSION = 1;

const SAMPLE_RATE = 8000;
const FFT_SIZE = 512;
const HOP = 128;
const PREEMPHASIS = 0.97;
const BAND_LOW_HZ = 300;
const BAND_HIGH_HZ = 3400;

/** 找谱峰、配对用的设置。 */
const PEAKS = Object.freeze({
  /** 周围多少帧、多少个频点里它得是最大的。 */
  timeRadius: 6,
  binRadius: 8,
  /** 比这一帧里它两边各 contrastBins 个频点的平均至少高多少 dB。 */
  contrastBins: 20,
  contrastDb: 9,
  /** 比整段音频里最响的谱峰至少低多少 dB 的，不要。 */
  rangeDb: 70,
  /** 每秒最多留多少个峰（超过的留最突出的），防止噪声很大的录音峰多得算不动。 */
  maxPerSecond: 90,
  /** 配对：锚点后面 minDt 到 maxDt 帧之内，频率差不超过 maxDf 个频点，每个锚点最多 fanout 对。 */
  minDt: 1,
  maxDt: 63,
  maxDf: 63,
  fanout: 6,
});

/** 找复用时的默认设置，依据和标定的数字在文件头和 lib/duplicate-check.mjs 的文件头里。 */
export const MATCHING = Object.freeze({
  /** 一个位置差上至少多少票，才认为这两段录音有一部分是同一段。 */
  minMatches: 16,
  /** 相邻的票隔多少秒以内连成一段。 */
  gapSec: 0.75,
  /** 一小段至少多少票才算。 */
  minRunMatches: 8,
  /** 索引里同一个哈希出现多少次以上就不要了（太常见，不说明什么）。 */
  maxBucket: 60,
});

const HOP_SEC = HOP / SAMPLE_RATE;
const FRAMES_PER_SECOND = SAMPLE_RATE / HOP;
const BIN_LOW = Math.ceil((BAND_LOW_HZ * FFT_SIZE) / SAMPLE_RATE);
const BIN_HIGH = Math.floor((BAND_HIGH_HZ * FFT_SIZE) / SAMPLE_RATE);
const BANDS = BIN_HIGH - BIN_LOW + 1;

// ---------------------------------------------------------------- 单声道、重采样

function toMono(audio) {
  const { samples } = audio;
  if (samples.length === 1) return samples[0];
  const out = new Float32Array(samples[0].length);
  for (const channel of samples) for (let i = 0; i < out.length; i++) out[i] += channel[i];
  const k = 1 / samples.length;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

const SINC_ZEROS = 8;
const TABLE_RESOLUTION = 64;

/** 带窗口的 sinc 插值重采样。目标比来源低时先低通到目标的奈奎斯特频率，所以不会混叠。 */
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const cutoff = Math.min(1, to / from);
  const half = Math.ceil(SINC_ZEROS / cutoff);
  const table = new Float32Array(2 * half * TABLE_RESOLUTION + 2);
  for (let i = 0; i < table.length; i++) {
    const d = i / TABLE_RESOLUTION - half;
    const z = cutoff * d;
    const sinc = z === 0 ? 1 : Math.sin(Math.PI * z) / (Math.PI * z);
    table[i] = cutoff * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / half));
  }
  const length = Math.floor((input.length - 1) / ratio) + 1;
  const out = new Float32Array(Math.max(0, length));
  for (let n = 0; n < out.length; n++) {
    const center = n * ratio;
    const first = Math.max(0, Math.ceil(center - half));
    const last = Math.min(input.length - 1, Math.floor(center + half));
    let sum = 0;
    for (let i = first; i <= last; i++) sum += input[i] * table[Math.round((i - center + half) * TABLE_RESOLUTION)];
    out[n] = sum;
  }
  return out;
}

// ---------------------------------------------------------------- 短时傅立叶变换

const hann = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
const cosTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE));
const sinTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / FFT_SIZE));
const reversed = (() => {
  const bits = Math.log2(FFT_SIZE);
  return Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    return r;
  });
})();

/** 原地基 2 傅立叶变换。 */
function fft(re, im) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = reversed[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const halfSize = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0, t = 0; k < halfSize; k++, t += step) {
        const a = start + k;
        const b = a + halfSize;
        const wr = cosTable[t];
        const wi = sinTable[t];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

const DB = 10 / Math.LN10;

/**
 * 每一帧 300–3400 Hz 的对数功率谱（dB），一帧 BANDS 个数，帧挨着放。一次变换算两帧（一帧放实部、一帧放虚部）。
 * @returns {{ frames: number, db: Float32Array }}
 */
function spectrogram(x) {
  const frames = x.length >= FFT_SIZE ? Math.floor((x.length - FFT_SIZE) / HOP) + 1 : 0;
  const db = new Float32Array(frames * BANDS);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const emphasized = new Float32Array(x.length);
  emphasized[0] = x.length > 0 ? x[0] : 0;
  for (let i = 1; i < x.length; i++) emphasized[i] = x[i] - PREEMPHASIS * x[i - 1];
  for (let t = 0; t < frames; t += 2) {
    const a = t * HOP;
    const b = (t + 1) * HOP;
    const hasSecond = t + 1 < frames;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = emphasized[a + i] * hann[i];
      im[i] = hasSecond ? emphasized[b + i] * hann[i] : 0;
    }
    fft(re, im);
    for (let k = BIN_LOW; k <= BIN_HIGH; k++) {
      const m = (FFT_SIZE - k) % FFT_SIZE;
      const ar = (re[k] + re[m]) / 2;
      const ai = (im[k] - im[m]) / 2;
      db[t * BANDS + (k - BIN_LOW)] = DB * Math.log(ar * ar + ai * ai + 1e-12);
      if (hasSecond) {
        const br = (im[k] + im[m]) / 2;
        const bi = (re[k] - re[m]) / 2;
        db[(t + 1) * BANDS + (k - BIN_LOW)] = DB * Math.log(br * br + bi * bi + 1e-12);
      }
    }
  }
  return { frames, db };
}

// ---------------------------------------------------------------- 谱峰

/** 找谱峰：[{ t, f, strength }]，按时间再按频率排。 */
function findPeaks({ frames, db }, settings) {
  const { timeRadius, binRadius, contrastBins, contrastDb, rangeDb, maxPerSecond } = settings;
  if (frames === 0) return [];
  // 沿频率的局部最大（±binRadius）
  const alongFrequency = new Float32Array(db.length);
  for (let t = 0; t < frames; t++) {
    const base = t * BANDS;
    for (let f = 0; f < BANDS; f++) {
      const from = Math.max(0, f - binRadius);
      const to = Math.min(BANDS - 1, f + binRadius);
      let m = -Infinity;
      for (let k = from; k <= to; k++) if (db[base + k] > m) m = db[base + k];
      alongFrequency[base + f] = m;
    }
  }
  // 再沿时间取最大（±timeRadius）：一个点等于这个二维邻域里的最大值，才是峰
  const neighbourhood = new Float32Array(db.length);
  for (let t = 0; t < frames; t++) {
    const from = Math.max(0, t - timeRadius);
    const to = Math.min(frames - 1, t + timeRadius);
    for (let f = 0; f < BANDS; f++) {
      let m = -Infinity;
      for (let u = from; u <= to; u++) {
        const v = alongFrequency[u * BANDS + f];
        if (v > m) m = v;
      }
      neighbourhood[t * BANDS + f] = m;
    }
  }
  let loudest = -Infinity;
  for (let i = 0; i < db.length; i++) if (db[i] > loudest) loudest = db[i];
  const floor = loudest - rangeDb;
  const prefix = new Float64Array(BANDS + 1);
  const found = [];
  for (let t = 0; t < frames; t++) {
    const base = t * BANDS;
    prefix[0] = 0;
    for (let f = 0; f < BANDS; f++) prefix[f + 1] = prefix[f] + db[base + f];
    for (let f = 0; f < BANDS; f++) {
      const value = db[base + f];
      if (value < floor || value < neighbourhood[base + f]) continue;
      // 这一帧里两边各 contrastBins 个频点（不含它自己）的平均
      const from = Math.max(0, f - contrastBins);
      const to = Math.min(BANDS - 1, f + contrastBins);
      const count = to - from;
      if (count <= 0) continue;
      const mean = (prefix[to + 1] - prefix[from] - value) / count;
      const strength = value - mean;
      if (strength >= contrastDb) found.push({ t, f, strength });
    }
  }
  // 每秒最多 maxPerSecond 个：超过的留最突出的
  const perBlock = Math.max(1, Math.round(maxPerSecond));
  const blockFrames = Math.round(FRAMES_PER_SECOND);
  const kept = [];
  for (let i = 0; i < found.length;) {
    const block = Math.floor(found[i].t / blockFrames);
    let j = i;
    while (j < found.length && Math.floor(found[j].t / blockFrames) === block) j++;
    const slice = found.slice(i, j);
    if (slice.length > perBlock) slice.sort((x, y) => y.strength - x.strength).length = perBlock;
    kept.push(...slice);
    i = j;
  }
  return kept.sort((x, y) => x.t - y.t || x.f - y.f);
}

// ---------------------------------------------------------------- 配对、哈希

function hashesOf(peaks, settings) {
  const { minDt, maxDt, maxDf, fanout } = settings;
  const hashes = [];
  const times = [];
  for (let i = 0; i < peaks.length; i++) {
    const anchor = peaks[i];
    let paired = 0;
    for (let j = i + 1; j < peaks.length && paired < fanout; j++) {
      const dt = peaks[j].t - anchor.t;
      if (dt > maxDt) break;
      if (dt < minDt) continue;
      const df = peaks[j].f - anchor.f;
      if (df > maxDf || df < -maxDf) continue;
      hashes.push(((anchor.f & 0xff) << 13) | (((df + 64) & 0x7f) << 6) | (dt & 0x3f));
      times.push(anchor.t);
      paired++;
    }
  }
  return { hashes: Uint32Array.from(hashes), times: Int32Array.from(times) };
}

// ---------------------------------------------------------------- 对外的函数

function checkedAudio(audio) {
  if (audio === null || typeof audio !== 'object' || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !Array.isArray(audio.samples) || audio.samples.length === 0
    || !audio.samples.every((channel) => channel instanceof Float32Array && channel.length === audio.samples[0].length)) {
    throw new TypeError('音频必须是 { sampleRate, samples: Float32Array[] }（每个声道一个数组，长度一样）');
  }
  return audio;
}

/**
 * 一段音频的指纹。
 * @param {{ sampleRate: number, samples: Float32Array[] }} audio
 * @param {object} [options] 找谱峰、配对的设置，覆盖 PEAKS 里的同名项（给标定和测试用，平时不用给）
 * @returns {{ version: number, durationSec: number, hopSec: number, peaks: number, hashes: Uint32Array, times: Int32Array }}
 */
export function fingerprintAudio(audio, options = {}) {
  checkedAudio(audio);
  const unknown = Object.keys(options).filter((key) => !Object.hasOwn(PEAKS, key));
  if (unknown.length > 0) throw new TypeError(`不认识的选项：${unknown.join('、')}`);
  const settings = { ...PEAKS, ...options };
  const durationSec = audio.samples[0].length / audio.sampleRate;
  const mono = resample(toMono(audio), audio.sampleRate, SAMPLE_RATE);
  const peaks = findPeaks(spectrogram(mono), settings);
  return { version: FINGERPRINT_VERSION, durationSec, hopSec: HOP_SEC, peaks: peaks.length, ...hashesOf(peaks, settings) };
}

/**
 * 把一组指纹建成索引。
 * @param {{ id: string, fingerprint: object }[]} entries
 * @param {{ maxBucket?: number }} [options]
 */
export function indexFingerprints(entries, { maxBucket = MATCHING.maxBucket } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries 必须是数组 [{ id, fingerprint }]');
  const buckets = new Map();
  entries.forEach((entry, clip) => {
    const { hashes, times } = entry.fingerprint;
    for (let i = 0; i < hashes.length; i++) {
      let bucket = buckets.get(hashes[i]);
      if (bucket === undefined) { bucket = []; buckets.set(hashes[i], bucket); }
      bucket.push(clip, times[i]);
    }
  });
  for (const [hash, bucket] of buckets) if (bucket.length / 2 > maxBucket) buckets.delete(hash);
  return { ids: entries.map((entry) => entry.id), buckets };
}

const OFFSET_BIAS = 2_000_000;
const CLIP_SPAN = 4_000_000;

/**
 * 查询的这段音频里，有多少是索引里的录音。规则见文件头。
 * @param {{ hashes: Uint32Array, times: Int32Array, durationSec: number }} query 一段音频的指纹
 * @param {{ ids: string[], buckets: Map }} index indexFingerprints 的结果
 * @param {{ minMatches?: number, gapSec?: number, minRunMatches?: number }} [options]
 */
export function findReuse(query, index, options = {}) {
  const settings = { ...MATCHING, ...options };
  const votes = new Map();
  for (let i = 0; i < query.hashes.length; i++) {
    const bucket = index.buckets.get(query.hashes[i]);
    if (bucket === undefined) continue;
    for (let k = 0; k < bucket.length; k += 2) {
      const key = bucket[k] * CLIP_SPAN + (bucket[k + 1] - query.times[i] + OFFSET_BIAS);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  // 每段来源录音里票最集中的位置差（±1 帧合起来数）
  const best = new Map();
  for (const [key, count] of votes) {
    if (count < 2) continue;
    const total = count + (votes.get(key - 1) ?? 0) + (votes.get(key + 1) ?? 0);
    const clip = Math.floor(key / CLIP_SPAN);
    const current = best.get(clip);
    if (current === undefined || total > current.total) best.set(clip, { total, offset: (key % CLIP_SPAN) - OFFSET_BIAS });
  }
  const chosen = new Map([...best].filter(([, entry]) => entry.total >= settings.minMatches));
  if (chosen.size === 0) return { reusedSeconds: 0, clips: [] };

  // 第二遍：票落在查询的哪些时间上（锚点的时间），每个时间记下这些票里配的那一对峰最远伸到哪里（锚点后 dt 帧）
  const at = new Map([...chosen.keys()].map((clip) => [clip, new Map()]));
  for (let i = 0; i < query.hashes.length; i++) {
    const bucket = index.buckets.get(query.hashes[i]);
    if (bucket === undefined) continue;
    const reach = query.hashes[i] & 0x3f;
    for (let k = 0; k < bucket.length; k += 2) {
      const entry = chosen.get(bucket[k]);
      if (entry === undefined || Math.abs(bucket[k + 1] - query.times[i] - entry.offset) > 1) continue;
      const times = at.get(bucket[k]);
      if ((times.get(query.times[i]) ?? 0) < reach) times.set(query.times[i], reach);
    }
  }
  const gapFrames = Math.round(settings.gapSec * FRAMES_PER_SECOND);
  const clips = [];
  const intervals = [];
  for (const [clip, entry] of chosen) {
    // 一段 = 锚点按时间排好，下一个锚点离已经覆盖到的地方不超过 gapFrames 就接在同一段里
    const sorted = [...at.get(clip)].sort((x, y) => x[0] - y[0]);
    const runs = [];
    let from = 0;
    let covered = -Infinity;
    for (let i = 0; i <= sorted.length; i++) {
      if (i === sorted.length || (i > from && sorted[i][0] - covered > gapFrames)) {
        if (i - from >= settings.minRunMatches) runs.push({ startSec: sorted[from][0] * HOP_SEC, endSec: covered * HOP_SEC, matches: i - from });
        from = i;
        covered = -Infinity;
      }
      if (i < sorted.length) covered = Math.max(covered, sorted[i][0] + sorted[i][1]);
    }
    if (runs.length === 0) continue;
    for (const run of runs) intervals.push([run.startSec, run.endSec]);
    clips.push({ id: index.ids[clip], matches: entry.total, offsetSec: entry.offset * HOP_SEC, runs });
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let reusedSeconds = 0;
  let end = -Infinity;
  for (const [start, stop] of intervals) {
    const from = Math.max(start, end);
    if (stop > from) reusedSeconds += stop - from;
    end = Math.max(end, stop);
  }
  return { reusedSeconds, clips };
}
