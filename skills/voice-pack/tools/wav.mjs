// SPDX-License-Identifier: Apache-2.0
//
// WAV 的解析和写出。只做计算，不用模型，不依赖任何命令行工具。
//
// 解析（parseWav）认这些，别的交给 audio-decode.mjs 去向运行环境要 ffmpeg：
//   容器        RIFF/WAVE，小端。块（chunk）按顺序往下走：fmt 必须在 data 之前；fmt、data 之外的块（LIST、fact、bext……）跳过；
//               块大小是奇数时，后面有一个填充字节。
//   编码        PCM 整数 16、24、32 位；IEEE 浮点 32 位；单声道和多声道。fmt 里的格式标记是 1（PCM）、3（浮点），
//               或者 0xFFFE（WAVE_FORMAT_EXTENSIBLE：真正的格式取子格式 GUID 的前两个字节，GUID 的其余部分必须是标准的那一串）。
//   data 的长度 声明的长度超过文件实际剩下的字节，按实际剩下的算（流式输出写 0xFFFFFFFF；截断的文件）；末尾不够一帧的零头丢掉。
//   采样值      换算成浮点：整数除以 2^(位数-1)，所以落在 [-1, 1]；浮点编码里的 NaN 和无穷当 0，其余原样（可能超过 ±1）。
//               每个声道一个 Float32Array（和 Web Audio 的 AudioBuffer 一样，整段音频放在内存里，占的内存是 16 位 WAV 的两倍）。
//               16 位和 24 位整数放进 Float32 没有损失；32 位整数只留 24 位有效位（最低的几位丢掉，对音频分析没有影响）。
// 不在上面的编码（8 位 PCM、64 位浮点、ADPCM、μ-law、A-law……）不是不合法，只是不在自己解的范围里：抛 wav_unsupported。
// 文件头本身坏了（没有 fmt 或 data、data 之前没有 fmt、fmt 太短、声道数或采样率是 0、blockAlign 和声道数位数对不上）抛 wav_invalid。
//
// 只看文件头（wavInfo）：采样率、声道数、编码、帧数，不解采样值。只想知道一段 WAV 多长、什么格式时用它：解一条十几分钟的录音要几十到一百多毫秒（浏览器里一口气做完，页面卡住），
// 读文件头不到一毫秒。认的格式、帧数的数法、抛的错和 parseWav 完全一样（parseWav 就是 wavInfo 加上读采样值），所以「wavInfo 能读」和「parseWav 能解」是同一回事。
//
// 写出（encodeWav）只用来生成测试用的音频和以后切参考音频：PCM 16、24、32 位和浮点 32 位，可以带 EXTENSIBLE 头。
//
// 错误码（谁抛谁定义；details 里放什么写在抛出的地方）：wav_invalid、wav_unsupported。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';

const FORMAT_EXTENSIBLE = 0xfffe;
// 子格式 GUID 的后 14 个字节（前两个字节是格式标记，GUID 其余部分对所有标准格式都一样：00000000-0010-8000-00AA00389B71）
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
// 「格式标记/位数」→ 编码名
const ENCODINGS = { '1/16': 'pcm16', '1/24': 'pcm24', '1/32': 'pcm32', '3/32': 'float32' };

const ascii = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

// 文件头坏了。details.problem 是机器可读的原因：no_riff_header（开头不是 RIFF/WAVE）、no_fmt_chunk（既没有 fmt 也没有 data）、
// no_data_chunk（有 fmt 没有 data）、data_before_fmt（走到 data 时还没有 fmt：fmt 排在后面，或者根本没有）、
// fmt_too_short、bad_channels_or_rate、block_align_mismatch
function invalid(problem, message) {
  return new VoicePackError('wav_invalid', `WAV 文件头有问题：${message}`, { details: { problem } });
}

/** 开头是不是 RIFF/WAVE（只看文件头，不保证后面的块都合法）。 */
export function isWav(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 12 && ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WAVE';
}

function readFormat(view, bytes, at, size) {
  if (size < 16) throw invalid('fmt_too_short', `fmt 块只有 ${size} 字节，至少要 16`);
  const tag = view.getUint16(at, true);
  const fmt = {
    format: tag,
    channels: view.getUint16(at + 2, true),
    sampleRate: view.getUint32(at + 4, true),
    blockAlign: view.getUint16(at + 12, true),
    bitsPerSample: view.getUint16(at + 14, true),
  };
  if (tag === FORMAT_EXTENSIBLE) {
    if (size < 40) throw invalid('fmt_too_short', `EXTENSIBLE 的 fmt 块只有 ${size} 字节，至少要 40`);
    fmt.format = GUID_TAIL.every((b, i) => bytes[at + 26 + i] === b) ? view.getUint16(at + 24, true) : -1; // -1：不是标准子格式
  }
  return fmt;
}

/** 文件头里的格式过一遍检查，返回编码名和每帧的字节数；不合格抛错。wavInfo 和 parseWav 共用，所以两个对同一份字节给同一个结论。 */
function checkFormat(fmt) {
  const { channels, sampleRate, bitsPerSample, format } = fmt;
  if (channels < 1 || sampleRate < 1) throw invalid('bad_channels_or_rate', `声道数 ${channels}、采样率 ${sampleRate} 不合理`);
  const encoding = ENCODINGS[`${format}/${bitsPerSample}`];
  if (!encoding) {
    // 合法但不在自己解的范围里，交给 ffmpeg。details：format 是格式标记（EXTENSIBLE 是子格式的标记，非标准子格式是 -1），其余同 fmt 块
    throw new VoicePackError('wav_unsupported', `WAV 的编码自己不会解：格式标记 ${format}，${bitsPerSample} 位`, { details: { format, bitsPerSample, channels, sampleRate } });
  }
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = channels * bytesPerSample;
  if (fmt.blockAlign !== frameSize) throw invalid('block_align_mismatch', `blockAlign 是 ${fmt.blockAlign}，按声道数和位数应为 ${frameSize}`);
  return { encoding, bytesPerSample, frameSize };
}

// 本机是小端：16 位的快路径（下面的 readPcm16）靠它。大端的机器（几乎没有）走一个一个读的老路，结果一样。
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * 16 位整数的快路径：data 的起点在整个缓冲区里是偶数个字节、本机又是小端时，直接给这一段盖一个 Int16Array，一口气读（比 DataView 一个一个读快三倍多，一条十四分钟的
 * 16 kHz 单声道录音 58 毫秒变 16 毫秒：浏览器里解码是一整块同步的活，页面在这期间卡住）。结果和老路逐位相同：整数除以 32768 在浮点里是精确的（只是改了指数）。
 * 用不了（起点是奇数、大端）返回 false，调用方走老路。
 */
function readPcm16(view, start, frames, channels, samples) {
  const offset = view.byteOffset + start;
  if (!LITTLE_ENDIAN || offset % 2 !== 0 || frames === 0) return false;
  const ints = new Int16Array(view.buffer, offset, frames * channels);
  if (channels === 1) {
    const out = samples[0];
    for (let i = 0; i < frames; i++) out[i] = ints[i] / 32768;
  } else {
    for (let i = 0, at = 0; i < frames; i++) for (let c = 0; c < channels; c++) samples[c][i] = ints[at++] / 32768;
  }
  return true;
}

function readSamples(fmt, view, start, size) {
  const { channels, sampleRate } = fmt;
  const { encoding, bytesPerSample, frameSize } = checkFormat(fmt);
  const frames = Math.floor(size / frameSize);
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  if (encoding === 'pcm16' && readPcm16(view, start, frames, channels, samples)) return { sampleRate, channels, encoding, frames, samples };
  let at = start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let value;
      if (encoding === 'pcm16') value = view.getInt16(at, true) / 32768;
      else if (encoding === 'pcm24') {
        const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        value = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else if (encoding === 'pcm32') value = view.getInt32(at, true) / 2147483648;
      else {
        value = view.getFloat32(at, true);
        if (!Number.isFinite(value)) value = 0;
      }
      samples[c][i] = value;
      at += bytesPerSample;
    }
  }
  return { sampleRate, channels, encoding, frames, samples };
}

/** 往下走块，找到 fmt 和 data：返回 { view, fmt, start, size }（data 的起点和长度，长度已按文件实际剩下的截过）。文件头坏了抛 wav_invalid。 */
function locate(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseWav 和 wavInfo 需要 Uint8Array（Buffer 也行）');
  if (!isWav(bytes)) throw invalid('no_riff_header', '开头没有 RIFF/WAVE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at);
    const declared = view.getUint32(at + 4, true);
    const body = at + 8;
    const size = Math.min(declared, bytes.length - body);
    if (id === 'fmt ') fmt = readFormat(view, bytes, body, size);
    else if (id === 'data') {
      if (!fmt) throw invalid('data_before_fmt', 'data 块之前没有 fmt 块（fmt 排在 data 后面，或者根本没有）');
      return { view, fmt, start: body, size };
    }
    at = body + declared + (declared & 1);
  }
  throw fmt ? invalid('no_data_chunk', '没有 data 块') : invalid('no_fmt_chunk', '没有 fmt 块');
}

/**
 * 只读文件头：采样率、声道数、编码、帧数，和 parseWav 返回的同名字段完全一样，但不解采样值，所以不分配采样的数组、不随录音的长度花时间。
 * @param {Uint8Array} bytes
 * @returns {{ sampleRate: number, channels: number, encoding: 'pcm16'|'pcm24'|'pcm32'|'float32', frames: number }}
 * @throws {VoicePackError} wav_invalid、wav_unsupported（同 parseWav）
 */
export function wavInfo(bytes) {
  const { fmt, size } = locate(bytes);
  const { encoding, frameSize } = checkFormat(fmt);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, encoding, frames: Math.floor(size / frameSize) };
}

/**
 * 解析 WAV。
 * @param {Uint8Array} bytes
 * @returns {{ sampleRate: number, channels: number, encoding: 'pcm16'|'pcm24'|'pcm32'|'float32', frames: number, samples: Float32Array[] }}
 * @throws {VoicePackError} wav_invalid、wav_unsupported
 */
export function parseWav(bytes) {
  const { view, fmt, start, size } = locate(bytes);
  return readSamples(fmt, view, start, size);
}

const BYTES = { pcm16: 2, pcm24: 3, pcm32: 4, float32: 4 };

/**
 * 写出 WAV。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio 每个声道一个数组，长度相同；值按 [-1, 1] 理解，整数编码超出的部分削掉
 * @param {{ encoding?: 'pcm16'|'pcm24'|'pcm32'|'float32', extensible?: boolean }} [options] 默认 pcm16；extensible 写 40 字节的 fmt（WAVE_FORMAT_EXTENSIBLE）
 * @returns {Uint8Array}
 */
export function encodeWav({ sampleRate, samples }, { encoding = 'pcm16', extensible = false } = {}) {
  const bytesPerSample = BYTES[encoding];
  if (!bytesPerSample) throw new TypeError(`encoding 必须是 ${Object.keys(BYTES).join('、')} 之一，收到 ${JSON.stringify(encoding)}`);
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new TypeError(`sampleRate 必须是正整数，收到 ${sampleRate}`);
  if (!Array.isArray(samples) || samples.length < 1 || samples.some((s) => s.length !== samples[0].length)) {
    throw new TypeError('samples 必须是至少一个声道的数组，每个声道长度相同');
  }
  const channels = samples.length;
  const frames = samples[0].length;
  const dataSize = frames * channels * bytesPerSample;
  const pad = dataSize & 1; // RIFF：奇数长度的块后面补一个字节（只有 24 位、采样总数是奇数时才会）；RIFF 的长度算上它，data 块自己的长度不算
  const fmtSize = extensible ? 40 : 16;
  const total = 12 + 8 + fmtSize + 8 + dataSize + pad;
  if (total - 8 > 0xffffffff) throw new RangeError('音频太长，装不进一个 WAV（4 GiB）');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const put = (at, text) => [...text].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  put(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  const floating = encoding === 'float32';
  view.setUint16(20, extensible ? FORMAT_EXTENSIBLE : floating ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bytesPerSample * 8, true); // 有效位数
    view.setUint32(40, 0, true); // 声道掩码：不指定
    view.setUint16(44, floating ? 3 : 1, true); // 子格式 GUID 的前两个字节
    GUID_TAIL.forEach((b, i) => (out[46 + i] = b));
  }
  const dataAt = 20 + fmtSize;
  put(dataAt, 'data');
  view.setUint32(dataAt + 4, dataSize, true);
  let at = dataAt + 8;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = samples[c][i];
      if (encoding === 'pcm16') view.setInt16(at, clamp(Math.round(x * 32768), -32768, 32767), true);
      else if (encoding === 'pcm24') {
        const v = clamp(Math.round(x * 8388608), -8388608, 8388607) & 0xffffff;
        view.setUint8(at, v & 0xff);
        view.setUint8(at + 1, (v >> 8) & 0xff);
        view.setUint8(at + 2, v >> 16);
      } else if (encoding === 'pcm32') view.setInt32(at, clamp(Math.round(x * 2147483648), -2147483648, 2147483647), true);
      else view.setFloat32(at, x, true);
      at += bytesPerSample;
    }
  }
  return out;
}
