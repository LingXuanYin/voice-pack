// SPDX-License-Identifier: Apache-2.0
//
// 把一段音频的整体响度统一到目标：整段乘一个增益（所有声道同一个）；加完增益峰值会超过上限的，用预读限幅器把过高的峰压下来。不动别的。
// 只做计算，不用模型，确定性。
// 为什么有它：生成时每句话挑不同的参考，参考之间响度差得多，配出来的整段就会一句响一句轻。
// 做包的流程（lib/make-pack-loudness.mjs）在量完音质和能量以后，把写进包里的参考和留出录音统一到这里的目标。
//
//   normalizeLoudness(audio, options?) -> { audio, status, gainDb, limitedDb, before, after }
//   limitPeaks(audio, options?)        -> { audio, limitedDb }                           预读峰值限幅器（下面「限幅器」），normalizeLoudness 在里面用它，单独也能用
//   loudnessOptions(options?)          -> { targetLufs, peakCeilingDbfs, limiter }       检查选项、补默认值（下面「选项」）
//   ceilingForPcm16(peakCeilingDbfs)   -> 数                                             写成 16 位 WAV 时用的峰值上限（下面「写成 16 位 WAV」）
//
// audio 是解码出来的 { sampleRate, samples: Float32Array[] }（tools/audio-decode.mjs 的 decodeAudio 的结果可以直接给）。
//
// ---------------------------------------------------------------- 怎么调
//   目标      整体响度（BS.1770-4 的集成响度，同 tools/audio-quality.mjs）默认 REFERENCE_LOUDNESS_LUFS = −20 LUFS。
//             参考音频的目标响度整个产品里只有这一个数：app 的克隆页把参考归一到 −20 LUFS，做包也统一到它，克隆出来的声音导出成包、
//             再补素材，前后的参考响度才对得上。−23 LUFS 是广播节目的响度标准，不是克隆参考的要求
//   上限      采样峰值（所有声道里绝对值最大的采样）不超过 PEAK_CEILING_DBFS = −1 dBFS。采样峰值，不是真峰值：不做过采样
//   增益      目标减原来的响度。降增益不受峰值限制（降了峰值只会更低）。加增益会让峰值超过上限的（峰值比响度高 19 dB 以上的录音：
//             说话里偶尔冒出来的瞬态，加到 −20 LUFS 峰值就过了 −1 dBFS），分两种：
//               限幅器关着（limiter: false）：只加到峰值正好顶到上限为止，增益 = min(目标 − 响度, 上限 − 峰值)，到不了目标就说明（peak_limited）。
//                 原来的峰值就已经超过上限、响度又低于目标的，增益是负的：峰值上限是硬的，宁可离目标远一点。这是加限幅器以前的行为
//               限幅器开着（默认）：照加，超过上限的峰交给限幅器压下来（下面「限幅器」），整体照样能到目标
//   不动      量不出响度的（短于 0.4 秒一个测量块、整段几乎无声：所有的块都低于 −70 LUFS）不动；响度已经在目标上（差不到 0.05 LU）、
//             峰值又没超过上限的不动，返回同一份音频。峰值超了上限的，响度再准也要处理（上限是硬的）：限幅器关着是整体降，开着是只限幅，增益取 0
//
// ---------------------------------------------------------------- 限幅器
//   为什么    只加增益，一条峰值比响度高出 20 dB 以上的录音加到峰值顶到 −1 dBFS 就停了，到不了目标。做包要的是整套参考响度一致，
//             所以把那几个瞬态压下去一点，整体才抬得到目标。量过（40 条真录音：英语 20、汉语 20，都是 5–17 秒的单句；目标 −20 LUFS、上限 −1 dBFS）：
//             只加增益有 12 条到不了（英语 10、汉语 2；其中响度最低的一条是 −26.5 LUFS，差 6.5 LU），限幅器开着只有 1 条到不了（峰值比响度高 25.5 dB，要压 6.5 dB，超过下面 6 dB 的上限，差 0.75 LU）；
//             目标 −23 LUFS 时，只加增益 4 条到不了，限幅器开着 0 条。
//   做法      预读峰值限幅器（look-ahead peak limiter），按采样走一遍，每个采样出一个增益（≤ 1）：
//             1. 要压多少：采样的绝对值超过上限，就压到正好是上限。所有声道里最大的那个说了算，所有声道乘同一个增益，声像不变
//             2. 预读 LIMITER_LOOKAHEAD_MS：增益在峰到来之前就开始往下走，到峰的时候已经压到位，压的过程是一个坡，不是一个切口
//             3. 释放 LIMITER_RELEASE_MS：压的量一到位就保持到预读窗口过去，之后按这个时间常数指数地回到 0（增益回到 1）。
//                两个峰靠得近、前一个的尾巴还没退完的，接着往下压的那个走
//             4. 平滑：每个采样的压低量，是预读窗口里每一步的压的量的平均。窗口都包含这个采样，所以平均不小于它自己要压的量，
//                压完不会超过上限；平均又让增益每步最多变 1/（窗口宽度），没有突变
//   保证      输出的采样峰值不超过上限（上限取到 Float32 存得下的最大值，存进去不会因为舍入超过它）；只压不放大，不改符号；
//             没有一个采样超过上限的，一个采样都不改，返回的就是输入那一份；超过上限的，增益离开 1 的地方只在峰的前后，
//             尾巴小到比 Float32 的一个刻度（2^-26）还小就算回到 1，此后的采样一个也不改（压 6 dB 的峰，约 0.9 秒以后）
//   参数      上限、预读、释放、压的量最多多少、到目标算差多少，下面逐个说依据。EBU 没有给预读和释放的数，那两个是实现的选择，不是规定
//             上限 −1 dBFS  EBU R 128（2023）建议 m)：制作中的节目真峰值不超过 −1 dBTP。EBU Tech 3343 §3.4：安全限幅器要设在允许的最大真峰值上。
//                           EBU Tech 3344（2016）§6.9：正增益之后接限幅器，防止数值过载——也就是这里「先加增益再限幅」的顺序。
//                           这里量的是采样峰值（不做过采样），数同上
//             预读 5 毫秒、释放 50 毫秒
//                           ffmpeg 的 alimiter 滤镜的默认值（attack 5 ms、release 50 ms；用 ffmpeg 8.1 的 -h filter=alimiter 核对过）。
//                           5 毫秒盖得住一两毫秒宽的瞬态，又短得不会让前面的音节提前变轻；50 毫秒的尾巴让瞬态过去以后增益很快回来，不拖累后面的音节
//             最多压 6 dB（LIMITER_MAX_DB）
//                           建议值。压得更深，瞬态就削得更狠，不如到不了目标并说明。可以改（limiter: { maxDb }）
//             差 0.5 LU 以内算到了目标
//                           定下的验收线，不是 EBU 现行的数。EBU R 128 的修订记录里，2014 年 6 月的 V3 把目标响度的容差定为 ±0.5 LU（直播节目除外）；
//                           2020 年的 V4 改了：质检里 ±0.2 LU 吸收测量误差，实在到不了的（直播）±1.0 LU（R 128 2023 年版建议 h、i；Tech 3343 §3.1 同）。
//                           本模块的响度表和 ffmpeg 的 ebur128 对过，差到 0.10 LU，再收紧就和量的误差一个量级了。限幅会压掉一点响度，
//                           两轮之后差在 0.5 LU 以内的算调到了
//   流程      限幅器开着时（limiter 开）：
//             1. 第一轮：增益 = min(目标 − 响度, 上限 − 峰值 + maxDb)，也就是加到「加完以后峰超出上限的部分」正好等于最多能压的量为止。
//                乘上去，限幅，再量一次响度。（响度已经在目标上、只是峰值超了的，增益取 0，只限幅）
//             2. 第二轮：限幅了，而且离目标差 0.05 LU 以上的，补一次：比目标轻的（增益还没到上面那个界限才补）加一点，比目标响的减一点。
//                按第一轮量出来的结果估一个「加 1 dB 增益，响度涨多少」
//                （两个点：增益等于「峰值恰好顶到上限」时没有限幅，响度就是原来的加增益；第一轮的增益和量出来的响度。斜率取 0.25 到 1 之间），
//                算出该改多少，乘、限幅、再量。两轮里取离目标近的：整体响度按 BS.1770 的相对门限算，短的、停顿多的录音里压低瞬态会让一些测量块掉到门限以下，
//                响度不按比例变，第二轮有时反而冲过目标（第一轮也有比目标还响的），这时用第一轮的
//             最多两轮，不再迭代。第一轮就没限幅的（峰没超上限）只有第一轮，哪怕响度因为绝对门限（−70 LUFS）随增益变，量出来差了零点几 LU 也不补：
//             结果和限幅器关着时逐采样一样（限幅器没动过它，不改它的字节）
//
// ---------------------------------------------------------------- 选项（都可选；写错抛 TypeError）
//   targetLufs        目标，默认 REFERENCE_LOUDNESS_LUFS；−60 到 0 之间（不含 0）的数
//   peakCeilingDbfs   峰值上限，默认 PEAK_CEILING_DBFS；−60 到 0 之间的数
//   limiter           限幅器：true（默认）、false 或 null（关，回到只加增益）、{ maxDb }（最多压多少 dB，默认 LIMITER_MAX_DB，大于 0、不超过 24）。
//                     预读和释放不能改（改了就不是这里说的依据了），写了抛 TypeError
//   选项的检查单独拿出来：loudnessOptions(options) 返回补上默认值的 { targetLufs, peakCeilingDbfs, limiter }（limiter 是 { maxDb } 或 null），
//   写错抛同样的 TypeError；它的结果再交给它，不变
//
// ---------------------------------------------------------------- 写成 16 位 WAV
//   调好的采样是浮点数；写成 16 位整数要四舍五入，一个正好顶在上限的采样会被舍入到上限之上（−1 dBFS 的峰值写成 16 位以后是 −0.99985 dBFS）。
//   要让写出去的文件的峰值也不超过上限，调之前用 ceilingForPcm16(peakCeilingDbfs) 换一个留出一个刻度（1/32768）的上限当 peakCeilingDbfs 给。
//
// ---------------------------------------------------------------- 返回
//   audio     调好的音频 { sampleRate, samples }：新的数组，不改输入；不动的（unchanged、unmeasurable）是输入本身
//   status    'adjusted'      调到了目标：限幅器关着，差不到 0.05 LU；开着，对输出的采样量出来，差不超过 0.5 LU
//             'peak_limited'  没到目标：限幅器关着，是增益被峰值限住了（加增益只加到峰值顶到上限）；开着，是调完（限幅、再量，最多两轮）还是差 0.5 LU 以上，
//                             多半是限幅量加到了最多（maxDb）；上面说的相对门限让响度不按比例变的录音，两轮也可能调不准，同样是这个状态，limitedDb 没到 maxDb
//             'unchanged'     本来就在目标上（差不到 0.05 LU）、峰值也没超过上限
//             'unmeasurable'  量不出响度，没动
//   gainDb    乘上去的增益，dB，取到 0.01（限幅压掉的不算在里面）
//   limitedDb 限幅压得最深的地方压了多少 dB（增益压缩，正数，不超过 maxDb），取到 0.01；没限幅、限幅器关着、不动的是 0
//   before    { loudnessLufs, peakDbfs }：调之前，响度量不出是 null，取到 0.1
//   after     { loudnessLufs, peakDbfs }：调之后（对输出的采样重新量的），取到 0.1
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { checkedAudio, integratedLoudness } from './audio-quality.mjs';

/** 参考音频的目标响度（LUFS）：产品里只有这一个数，做包（lib/make-pack-loudness.mjs）和 app 的克隆页都用它。 */
export const REFERENCE_LOUDNESS_LUFS = -20;
/** 采样峰值的上限（dBFS）。 */
export const PEAK_CEILING_DBFS = -1;
/** 限幅器最多压多少 dB（增益压缩）：加完增益以后峰比上限高出这么多，就是能加的增益的尽头。 */
export const LIMITER_MAX_DB = 6;
/** 限幅器预读多少毫秒（依据见文件头「限幅器」）。 */
export const LIMITER_LOOKAHEAD_MS = 5;
/** 限幅器释放的时间常数（毫秒）。 */
export const LIMITER_RELEASE_MS = 50;
/** 差不到这么多 LU 算在目标上，不动。 */
const TOLERANCE_LU = 0.05;
/** 开了限幅器，输出的响度和目标差不超过这么多 LU 就算调到了（验收线，依据和 EBU 的数见文件头「限幅器」）。 */
const REACHED_LU = 0.5;
const OPTION_NAMES = ['targetLufs', 'peakCeilingDbfs', 'limiter'];
const LIMITER_OPTION_NAMES = ['maxDb'];
/** limiter.maxDb 的上界：压 24 dB 已经不是限幅，是把峰削平了；再大的数多半是写错。 */
const LIMITER_MAX_DB_LIMIT = 24;
/** 目标和上限的下界（−60 比任何有用的值都低，又远在一个 16 位刻度之上，ceilingForPcm16 的减法不会减成负数）。 */
const LOWEST_DB = -60;
/** 释放的尾巴小于这个数（比 Float32 的一个刻度小）就算回到 0：这以后的采样一个也不改。 */
const RELEASE_SNAP = 2 ** -26;

const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
const dbOf = (amplitude) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/** 峰值上限的检查（loudnessOptions 的 peakCeilingDbfs、limitPeaks 的 ceilingDbfs 同一条规矩）：−60 到 0 之间的数（dBFS）。 */
function checkedCeiling(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > 0 || value < LOWEST_DB) throw new TypeError(`${name} 必须是 ${LOWEST_DB} 到 0 之间的数（dBFS），收到 ${JSON.stringify(value)}`);
  return value;
}

/** limiter 选项的检查：true、undefined 是默认，false、null 是关（返回 null），对象是 { maxDb }。 */
function checkedLimiter(value) {
  if (value === undefined || value === true) return { maxDb: LIMITER_MAX_DB };
  if (value === false || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`limiter 必须是 true、false 或 { maxDb }，收到 ${JSON.stringify(value)}`);
  for (const key of Object.keys(value)) {
    if (!LIMITER_OPTION_NAMES.includes(key)) throw new TypeError(`limiter 里不认识的选项 ${key}（有：${LIMITER_OPTION_NAMES.join('、')}；预读和释放不能改）`);
  }
  const maxDb = value.maxDb === undefined ? LIMITER_MAX_DB : value.maxDb;
  if (typeof maxDb !== 'number' || !Number.isFinite(maxDb) || maxDb <= 0 || maxDb > LIMITER_MAX_DB_LIMIT) throw new TypeError(`limiter.maxDb 必须是大于 0、不超过 ${LIMITER_MAX_DB_LIMIT} 的数（dB），收到 ${JSON.stringify(value.maxDb)}`);
  return { maxDb };
}

/**
 * 检查选项，补上默认值。
 * @param {{ targetLufs?: number, peakCeilingDbfs?: number, limiter?: boolean | null | { maxDb?: number } }} [options]
 * @returns {{ targetLufs: number, peakCeilingDbfs: number, limiter: { maxDb: number } | null }}
 * @throws {TypeError} 选项不是对象、不认识的选项、值不在范围里（点名）
 */
export function loudnessOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options 必须是对象，例如 { targetLufs: -16 }');
  for (const key of Object.keys(options)) {
    if (!OPTION_NAMES.includes(key)) throw new TypeError(`不认识的选项 ${key}（有：${OPTION_NAMES.join('、')}）`);
  }
  const targetLufs = options.targetLufs === undefined ? REFERENCE_LOUDNESS_LUFS : options.targetLufs;
  const peakCeilingDbfs = options.peakCeilingDbfs === undefined ? PEAK_CEILING_DBFS : options.peakCeilingDbfs;
  if (typeof targetLufs !== 'number' || !Number.isFinite(targetLufs) || targetLufs >= 0 || targetLufs < LOWEST_DB) throw new TypeError(`targetLufs 必须是 ${LOWEST_DB} 到 0 之间（不含 0）的数（LUFS），收到 ${JSON.stringify(options.targetLufs)}`);
  checkedCeiling('peakCeilingDbfs', peakCeilingDbfs);
  return { targetLufs, peakCeilingDbfs, limiter: checkedLimiter(options.limiter) };
}

/**
 * 写成 16 位 WAV 用的峰值上限：比给定的上限低一个刻度（1/32768）的幅度，换回 dBFS。
 * 调好的采样不超过它，四舍五入到 16 位整数以后也不超过原来的上限（舍入最多差半个刻度）。
 * @param {number} peakCeilingDbfs 写出去的文件的采样峰值不能超过的上限，−60 到 0
 * @returns {number}
 */
export function ceilingForPcm16(peakCeilingDbfs) {
  const { peakCeilingDbfs: ceiling } = loudnessOptions({ peakCeilingDbfs });
  return 20 * Math.log10(10 ** (ceiling / 20) - 1 / 32768);
}

function samplePeak(samples) {
  let peak = 0;
  for (const channel of samples) {
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// ---------------------------------------------------------------- 限幅器

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** 不超过 x（正数）的最大的 Float32：输出存成 Float32，上限要取一个存得下的数，否则刚好顶在上限上的采样存进去会舍入到上限之上。 */
function floorFloat32(x) {
  f32[0] = x;
  if (f32[0] > x) u32[0] -= 1; // 舍入到了 x 之上：退一个刻度
  return f32[0];
}

/**
 * 预读峰值限幅器：把采样峰值压到上限以下，别处一个采样都不动。规则、参数和依据见文件头「限幅器」。
 * 所有声道用同一个增益（按各声道里最大的算），所以声像不变；只压低，不放大，不改符号。
 * 没有一个采样超过上限的，原样返回输入那一份（同一个对象），限幅量是 0；有的，返回新的 Float32 数组，不改输入。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio 采样要是有限的数（NaN、无穷大不处理）
 * @param {{ ceilingDbfs?: number }} [options] ceilingDbfs：采样峰值的上限，默认 PEAK_CEILING_DBFS，−60 到 0
 * @returns {{ audio: { sampleRate: number, samples: ArrayLike<number>[] }, limitedDb: number }} limitedDb：限幅量，最深处压了多少 dB（增益压缩，正数），没压是 0
 * @throws {TypeError} audio 的形状不对，或者选项写错（点名）
 */
export function limitPeaks(audio, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options 必须是对象，例如 { ceilingDbfs: -1 }');
  for (const key of Object.keys(options)) {
    if (key !== 'ceilingDbfs') throw new TypeError(`不认识的选项 ${key}（有：ceilingDbfs）`);
  }
  const ceilingDbfs = checkedCeiling('ceilingDbfs', options.ceilingDbfs === undefined ? PEAK_CEILING_DBFS : options.ceilingDbfs);
  const { sampleRate, samples } = checkedAudio(audio);
  const frames = samples[0].length;
  const nominal = 10 ** (ceilingDbfs / 20);
  const ceiling = floorFloat32(nominal);
  const peak = samplePeak(samples);
  if (!(peak > ceiling)) return { audio, limitedDb: 0 };

  // 一遍走完。第 m 步看第 m 个采样（录音走完以后补 lookahead 步空的，让最后几个采样也有预读），给第 m − lookahead 个采样出增益。
  //   要压多少：这个采样超过上限，就压到正好是上限（占 1 的比例）。
  //   预读：增益要照顾它和它前面 lookahead 个采样里最严的要求（单调队列求窗口里的最大值）。
  //   释放：压的量一来就到位，之后按时间常数 RELEASE_MS 指数地回到 0；两次之间没回到 0，就接着往下压的那个走。
  //   平滑：采样 i 的压低量，是第 i 到 i + lookahead 步的上面那个压的量的平均。这些步的预读窗口都包含采样 i，所以平均不小于采样 i 自己要压的量，
  //   压完不会超过上限；压的量一点点起来（每步最多变 1/width），增益平滑，不是削平。
  const lookahead = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS * sampleRate) / 1000));
  const width = lookahead + 1;
  const decay = Math.exp(-1000 / (LIMITER_RELEASE_MS * sampleRate));
  const queueAt = new Int32Array(width);
  const queueNeed = new Float64Array(width);
  const ring = new Float64Array(width);
  let first = 0; // 队列头的位置
  let size = 0; // 队列里有几项
  let at = 0; // ring 里下一个要写的位置
  let sum = 0; // ring 里压的量的和
  let live = 0; // ring 里不是 0 的有几个：全是 0 的时候和是精确的 0，增益精确的 1，不留浮点误差
  let carried = 0; // 释放中的压的量
  let deepest = 0;
  const out = samples.map(() => new Float32Array(frames));
  for (let m = 0; m < frames + lookahead; m++) {
    let need = 0;
    if (m < frames) {
      let largest = 0;
      for (const channel of samples) {
        const a = Math.abs(channel[m]);
        if (a > largest) largest = a;
      }
      if (largest > ceiling) need = 1 - ceiling / largest;
    }
    if (size > 0 && queueAt[first] <= m - width) {
      first = (first + 1) % width;
      size--;
    }
    while (size > 0 && queueNeed[(first + size - 1) % width] <= need) size--;
    queueAt[(first + size) % width] = m;
    queueNeed[(first + size) % width] = need;
    size++;
    carried *= decay;
    if (carried < RELEASE_SNAP) carried = 0;
    if (queueNeed[first] > carried) carried = queueNeed[first];
    const leaving = ring[at];
    ring[at] = carried;
    at = (at + 1) % width;
    sum += carried - leaving;
    live += (carried > 0 ? 1 : 0) - (leaving > 0 ? 1 : 0);
    if (live === 0) sum = 0;
    if (m >= lookahead) {
      const i = m - lookahead;
      const reduction = sum / width;
      if (reduction > deepest) deepest = reduction;
      const g = 1 - reduction;
      for (let c = 0; c < samples.length; c++) out[c][i] = samples[c][i] * g;
    }
  }
  return { audio: { sampleRate, samples: out }, limitedDb: dbOf(1 / (1 - deepest)) };
}

// ---------------------------------------------------------------- 调响度

/**
 * 整段乘 gainDb 的增益（所有声道同一个倍数），存成新的 Float32 数组。
 * 写成普通循环，不用 Float32Array.from(channel, fn)：后者每个采样走一次回调和迭代器，比循环慢 25 倍以上（8 秒的录音 10 毫秒对 0.4 毫秒），
 * 发新版本查重时每一段新补的素材都要调一遍，一百来段加起来就是一秒多。结果一位不差：乘在双精度里做，存进 Float32Array 时舍入，两种写法一样。
 */
function scaled(sampleRate, samples, gainDb) {
  const k = 10 ** (gainDb / 20);
  return {
    sampleRate,
    samples: samples.map((channel) => {
      const out = new Float32Array(channel.length);
      for (let i = 0; i < out.length; i++) out[i] = channel[i] * k;
      return out;
    }),
  };
}

/**
 * 把整体响度统一到目标。选项、状态、返回见文件头。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio
 * @param {{ targetLufs?: number, peakCeilingDbfs?: number, limiter?: boolean | null | { maxDb?: number } }} [options]
 * @returns {{ audio: { sampleRate: number, samples: ArrayLike<number>[] }, status: 'adjusted'|'peak_limited'|'unchanged'|'unmeasurable', gainDb: number, limitedDb: number, before: { loudnessLufs: number|null, peakDbfs: number }, after: { loudnessLufs: number|null, peakDbfs: number } }}
 * @throws {TypeError} audio 的形状不对，或者选项写错（点名）
 */
export function normalizeLoudness(audio, options = {}) {
  const { targetLufs, peakCeilingDbfs, limiter } = loudnessOptions(options);
  const { sampleRate, samples } = checkedAudio(audio);
  const loudness = integratedLoudness(samples, sampleRate);
  const peak = samplePeak(samples);
  const peakDbfs = round(dbOf(peak), 1);
  const before = { loudnessLufs: loudness === null ? null : round(loudness, 1), peakDbfs };
  if (loudness === null || peak === 0) return { audio, status: 'unmeasurable', gainDb: 0, limitedDb: 0, before, after: before };

  const wanted = targetLufs - loudness;
  const allowed = peakCeilingDbfs - dbOf(peak); // 加这么多，峰正好顶到上限（负的：峰已经超了）
  // 响度在目标上（差不到 0.05 LU），峰值也没超过上限：不动。峰值超了哪怕一点点，也要处理（上限是硬的）
  if (Math.abs(wanted) < TOLERANCE_LU && allowed >= 0) return { audio, status: 'unchanged', gainDb: 0, limitedDb: 0, before, after: before };

  const finished = (status, gainDb, limitedDb, result, afterLoudness) => ({
    audio: result,
    status,
    gainDb: round(gainDb, 2),
    limitedDb: round(limitedDb, 2),
    before,
    after: { loudnessLufs: afterLoudness === null ? null : round(afterLoudness, 1), peakDbfs: round(dbOf(samplePeak(result.samples)), 1) },
  });

  if (limiter === null) {
    // 只加增益，加到峰顶到上限为止
    const gainDb = Math.min(wanted, allowed);
    const adjusted = scaled(sampleRate, samples, gainDb);
    return finished(wanted - gainDb < TOLERANCE_LU ? 'adjusted' : 'peak_limited', gainDb, 0, adjusted, integratedLoudness(adjusted.samples, sampleRate));
  }

  // 加增益，限幅，再量。最多两轮（文件头「流程」）
  const reach = allowed + limiter.maxDb; // 增益的尽头：加完以后峰超出上限的部分正好是最多能压的量
  const render = (gainDb) => {
    const limited = limitPeaks(scaled(sampleRate, samples, gainDb), { ceilingDbfs: peakCeilingDbfs });
    return { gainDb, audio: limited.audio, limitedDb: limited.limitedDb, loudness: integratedLoudness(limited.audio.samples, sampleRate) };
  };
  const shortBy = (attempt) => (attempt.loudness === null ? Infinity : targetLufs - attempt.loudness); // 比目标轻多少 LU，负的是比目标响
  let best = render(Math.min(Math.abs(wanted) < TOLERANCE_LU ? 0 : wanted, reach));
  if (best.limitedDb > 0 && Math.abs(shortBy(best)) >= TOLERANCE_LU && (shortBy(best) < 0 || best.gainDb < reach)) {
    const beyond = best.gainDb - allowed; // 比「峰正好顶到上限」多加了多少增益；加到 allowed 为止没有限幅，响度就是 loudness + allowed
    const slope = beyond > 0 ? Math.min(1, Math.max(0.25, (best.loudness - (loudness + allowed)) / beyond)) : 1;
    const second = render(Math.min(best.gainDb + shortBy(best) / slope, reach));
    if (Math.abs(shortBy(second)) < Math.abs(shortBy(best))) best = second;
  }
  return finished(Math.abs(shortBy(best)) <= REACHED_LU ? 'adjusted' : 'peak_limited', best.gainDb, best.limitedDb, best.audio, best.loudness);
}
