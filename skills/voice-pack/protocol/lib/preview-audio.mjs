// SPDX-License-Identifier: Apache-2.0
//
// 预览卡片里内嵌的试听：从参考集里挑一段，截短到放得下，不重新编码。
//
//   trimAudio(bytes, limits)                       一段音频字节 → { bytes, mimeType, seconds, trimmed }，放不下就是 null
//   choosePreviewAudio(manifest, files, limits)    用哪一段：默认参考段，放不下换下一段 → { segmentId, bytes, mimeType, seconds, trimmed } 或 null
//
// 试听用哪一段：参考集里的默认段。示例台词（sampleLines）只是文字，格式里没有它的音频，所以试听总是一段真录音。
// 默认段的字节不在包里（外部资源）、放不下又切不了的，换清单里的下一段；留出录音从不拿来当试听（它们只用来量还原度）。
//
// 上限（卡片会进每个分享文件，所以要小；下面的取舍是判断，不是实测的结论）：
//   时长 PREVIEW_MAX_SECONDS = 8 秒。一段参考是 5 到 20 秒，8 秒够听出一两句话的音色和语气；再长不帮着认声音，只多占字节。
//   字节 PREVIEW_MAX_BYTES = 384 KiB（393,216 字节），指内嵌的音频本身，不含 Base64。24 kHz、单声道、16 位的 WAV 每秒 48,000 字节，8 秒是 384,000 字节，
//        正好放得下，所以 24 kHz 以下的单声道都能放满 8 秒；Base64 多出三分之一，384 KiB 变成正好 512 KiB，整张卡片不到 0.6 MiB。
//        对照：完整包里固定的部分（基础部分 1,435,094 字节，里面带一份 503,761 字节的协议核心；角色部分再带一份，2026-10-15 量的）约 1.9 MB，
//        卡片的 0.5 MiB 是它的四分之一；真有几分钟参考录音的包，卡片只占百分之几。
//        采样率更高或有两个声道的 WAV 字节数先到上限，截得更短：48 kHz 单声道（每秒 96,000 字节）约 4 秒，44.1 kHz 立体声（每秒 176,400 字节）约 2.2 秒。
//   下限 PREVIEW_MIN_SECONDS = 1 秒，只管「截」出来的：字节上限把它截到不足 1 秒（96 kHz 的 24 位立体声一类），一两个字听不出什么，宁可不放，
//        也不放一声突然断掉的响。原件本来就短、整个放得下的（整段才 0.4 秒），照放。
//
// 怎么不重新编码：
//   WAV  是没压缩的采样：切在一个完整的采样帧（fmt 块里的 blockAlign 的整数倍）上，采样字节照搬前面那一截，fmt 块原样带过来，只重写 RIFF 和 data 两个长度；
//        别的块（LIST、bext……元数据，有的带封面图）丢掉。不改任何采样，不做淡出：切在字上会有一声轻微的断，换来的是「没动过」这句话能原样成立。
//   MP3  切在帧的边界上：每一帧只往前依赖（比特库里的数据在它前面的帧里），所以留下前面整数个帧是安全的；丢掉开头的 Xing/Info 帧（它记着原来的总帧数和总字节数，
//        留着，播放器会按它报原来的时长），ID3 标签也丢掉。帧一个字节都不动。
//        在 Edge 148 里用 ffmpeg 编的真文件验过（2026-10-16）：留着这一帧，截成 8 秒的卡片显示 30 秒；
//        丢掉以后，恒定码率的（MPEG-1、MPEG-2、MPEG-2.5）显示的时长和按帧数算的一样，差不到 5 毫秒；可变码率的没有头可读，浏览器只能按文件大小估，
//        会差不到一秒（一段 8 秒的显示 7.35 秒），播放本身不受影响。要让它也精确，得自己写一个 Xing 头（改帧数、字节数、目录和 LAME 标签的校验），这一版没做。
//   别的格式（FLAC、Ogg、M4A）不切：切它们要懂各自的容器（FLAC 要改 STREAMINFO 里的总样本数，Ogg 要在最后一页打上结束标志、改播放位置、重算页校验，
//        M4A 要重写 moov 里的采样表），写错了浏览器就放不出，tools/ 里也没有现成的（只有 WAV 的读写）。所以整个放得下（不超过字节上限）就整个放，放不下就换下一段。
//        这几种格式压缩得好，常见的几秒到十几秒的一段本来就小（Opus 24 kbps 每秒 3 KB）。它们的时长不解析，seconds 是 null。
//   能不动就不动：原件本来就放得下（时长和字节都在上限内、结构规矩），原样放，字节和原件一样，连标签也不动。
//
// 抛出的错误：音频的问题不抛。放不下、认不出是音频，都给 null，由调用方决定怎么说（卡片上写「没有内嵌试听」）。
// 调用方用错了才抛 TypeError（规矩见 protocol/README.md「错误」）：bytes 不是 Uint8Array，上限不是正数。上限只来自调用方的选项，包里的数据碰不到它。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { sniffAudio, mpegFrame, id3v2Length } from './audio.mjs';

export const PREVIEW_MAX_SECONDS = 8;
export const PREVIEW_MAX_BYTES = 384 * 1024;
export const PREVIEW_MIN_SECONDS = 1;

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' };

const ascii = (bytes, from, to) => { let text = ''; for (let i = from; i < to && i < bytes.length; i++) text += String.fromCharCode(bytes[i]); return text; };
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const putAscii = (out, at, text) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
const putU32le = (out, at, value) => { out[at] = value & 0xff; out[at + 1] = (value >>> 8) & 0xff; out[at + 2] = (value >>> 16) & 0xff; out[at + 3] = (value >>> 24) & 0xff; };

function resolveLimits(limits = {}) {
  const maxSeconds = limits.maxSeconds ?? PREVIEW_MAX_SECONDS;
  const maxBytes = limits.maxBytes ?? PREVIEW_MAX_BYTES;
  if (!(maxSeconds > 0) || !(maxBytes > 0)) throw new TypeError(`maxSeconds 和 maxBytes 必须是正数，收到 maxSeconds=${maxSeconds}、maxBytes=${maxBytes}`);
  return { maxSeconds, maxBytes };
}

// ---------------------------------------------------------------- WAV

/** 读 WAV 的块：fmt 块的内容、blockAlign、每秒字节数、data 的位置和（实际有的）长度。读不了给 null。 */
function readWav(bytes) {
  let fmt = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, at + 4);
    const size = u32le(bytes, at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > bytes.length) return null;
      fmt = { body: bytes.subarray(body, body + size), byteRate: u32le(bytes, body + 8), blockAlign: u16le(bytes, body + 12) };
    } else if (id === 'data') {
      if (fmt === null || fmt.blockAlign < 1 || fmt.byteRate < 1) return null;
      const available = bytes.length - body;
      return { ...fmt, dataAt: body, declared: size, length: Math.min(size, available) };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** 用 fmt 块和采样字节重新写一个只有 fmt、data 两个块的 WAV。 */
function writeWav(fmtBody, data) {
  const fmtPad = fmtBody.length & 1;
  const dataPad = data.length & 1;
  const total = 12 + 8 + fmtBody.length + fmtPad + 8 + data.length + dataPad;
  const out = new Uint8Array(total);
  putAscii(out, 0, 'RIFF');
  putU32le(out, 4, total - 8);
  putAscii(out, 8, 'WAVE');
  putAscii(out, 12, 'fmt ');
  putU32le(out, 16, fmtBody.length);
  out.set(fmtBody, 20);
  const dataAt = 20 + fmtBody.length + fmtPad;
  putAscii(out, dataAt, 'data');
  putU32le(out, dataAt + 4, data.length);
  out.set(data, dataAt + 8);
  return out;
}

function trimWav(bytes, { maxSeconds, maxBytes }) {
  const wav = readWav(bytes);
  if (wav === null) return null;
  const wholeBytes = wav.length - (wav.length % wav.blockAlign); // 末尾不够一个采样帧的零头不要
  const wholeSeconds = wholeBytes / wav.byteRate;
  const regular = wav.declared <= bytes.length - wav.dataAt && wholeBytes === wav.length; // data 块完整、没有零头
  if (regular && wholeSeconds <= maxSeconds && bytes.length <= maxBytes) return { bytes, mimeType: MIME.wav, seconds: wholeSeconds, trimmed: false };

  const headerLength = 12 + 8 + wav.body.length + (wav.body.length & 1) + 8;
  let allowed = Math.min(wholeBytes, Math.floor(maxSeconds * wav.byteRate), maxBytes - headerLength);
  allowed -= allowed % wav.blockAlign;
  if ((allowed & 1) === 1 && headerLength + allowed + 1 > maxBytes) allowed -= wav.blockAlign; // RIFF 里奇数长度的块后面补一个字节
  if (allowed <= 0) return null;
  const trimmed = allowed < wholeBytes;
  if (trimmed && allowed / wav.byteRate < PREVIEW_MIN_SECONDS) return null;
  const out = writeWav(wav.body, bytes.subarray(wav.dataAt, wav.dataAt + allowed));
  return { bytes: out, mimeType: MIME.wav, seconds: allowed / wav.byteRate, trimmed };
}

// ---------------------------------------------------------------- MP3

const samplesPerFrame = (frame) => (frame.layer === 1 ? 384 : frame.layer === 2 || frame.version === 3 ? 1152 : 576); // MPEG-2/2.5 的第三层每帧样本数减半

/** 第一帧是不是 Xing/Info/VBRI 帧：编码器写在开头的一帧静音，里面记着总帧数和总字节数，自己不是音频。 */
function isInfoFrame(bytes, at) {
  for (const offset of [36, 21, 13]) {
    const tag = ascii(bytes, at + offset, at + offset + 4);
    if (tag === 'Xing' || tag === 'Info') return true;
  }
  return ascii(bytes, at + 36, at + 40) === 'VBRI';
}

function trimMp3(bytes, { maxSeconds, maxBytes }) {
  const start = id3v2Length(bytes);
  if (start < 0) return null;
  // 沿着帧一帧一帧走，走到不是帧头、或者不完整的那一帧为止
  const frames = [];
  let at = start;
  let infoFrame = false;
  for (;;) {
    const frame = mpegFrame(bytes, at);
    if (frame === null || at + frame.length > bytes.length) break;
    if (frames.length > 0) {
      const first = frames[0];
      if (frame.version !== first.version || frame.layer !== first.layer || frame.sampleRate !== first.sampleRate) break;
    }
    if (frames.length === 0 && isInfoFrame(bytes, at)) infoFrame = true;
    frames.push({ at, length: frame.length, version: frame.version, layer: frame.layer, sampleRate: frame.sampleRate });
    at += frame.length;
  }
  if (frames.length === 0) return null;
  const end = at; // 最后一个完整帧的末尾
  const audio = infoFrame ? frames.slice(1) : frames;
  if (audio.length === 0) return null;
  const secondsOf = (list) => list.reduce((sum, frame) => sum + samplesPerFrame(frame) / frame.sampleRate, 0);

  // 规矩的 MP3：从头到尾都是帧（可以有开头的 ID3v2、末尾的 ID3v1），没有零头、没有断开的地方
  const hasId3v1 = bytes.length - end === 128 && ascii(bytes, end, end + 3) === 'TAG';
  const regular = end === bytes.length || hasId3v1;
  const wholeSeconds = secondsOf(audio);
  if (regular && wholeSeconds <= maxSeconds && bytes.length <= maxBytes) return { bytes, mimeType: MIME.mp3, seconds: wholeSeconds, trimmed: false };

  // 要重写：只留音频帧，按时长和字节数的上限取前面整数个
  let kept = 0;
  let seconds = 0;
  let size = 0;
  for (const frame of audio) {
    const next = seconds + samplesPerFrame(frame) / frame.sampleRate;
    if (next > maxSeconds || size + frame.length > maxBytes) break;
    seconds = next;
    size += frame.length;
    kept++;
  }
  if (kept === 0) return null;
  const droppedForLimits = kept < audio.length; // 因为上限去掉了帧（1 秒的下限只管这种截）
  const trimmed = droppedForLimits || !regular; // 或者断开的地方后面的东西没要
  if (droppedForLimits && seconds < PREVIEW_MIN_SECONDS) return null;
  const out = new Uint8Array(size);
  let to = 0;
  for (const frame of audio.slice(0, kept)) { out.set(bytes.subarray(frame.at, frame.at + frame.length), to); to += frame.length; }
  return { bytes: out, mimeType: MIME.mp3, seconds, trimmed };
}

// ---------------------------------------------------------------- 入口

/**
 * 把一段音频弄成放得进预览卡片的样子：认格式（看内容，不看扩展名），WAV 和 MP3 截短，别的格式放得下就整个放。
 * @param {Uint8Array} bytes
 * @param {{ maxSeconds?: number, maxBytes?: number }} [limits] 默认 PREVIEW_MAX_SECONDS、PREVIEW_MAX_BYTES
 * @returns {{ bytes: Uint8Array, mimeType: string, seconds: number | null, trimmed: boolean } | null}
 *   seconds 是放进去的这段的时长（FLAC、Ogg、M4A 不解析，是 null）；trimmed 是「比原件短」；
 *   null：不是允许的音频，或者怎么也放不进上限（截出来不到 1 秒，或者不能截的格式整个超过字节上限）
 */
export function trimAudio(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  const resolved = resolveLimits(limits);
  const sniffed = sniffAudio(bytes);
  if (sniffed === null) return null;
  if (sniffed.format === 'wav') return trimWav(bytes, resolved);
  if (sniffed.format === 'mp3') return trimMp3(bytes, resolved);
  if (bytes.length > resolved.maxBytes) return null;
  return { bytes, mimeType: MIME[sniffed.format], seconds: null, trimmed: false };
}

/**
 * 给角色部分的预览卡片挑一段试听：默认参考段，放不下换清单里的下一段。
 * @param {{ reference: { defaultSegment: string, segments: { id: string, audio: string }[] } }} manifest 角色部分的清单
 * @param {Map<string, Uint8Array>} files 角色部分的文件（路径相对角色部分的目录）；外部资源的字节不在里面，那一段自然跳过
 * @param {{ maxSeconds?: number, maxBytes?: number }} [limits]
 * @returns {{ segmentId: string, bytes: Uint8Array, mimeType: string, seconds: number | null, trimmed: boolean } | null}
 */
export function choosePreviewAudio(manifest, files, limits) {
  const segments = manifest?.reference?.segments ?? [];
  const preferred = segments.find((segment) => segment.id === manifest.reference.defaultSegment);
  const order = preferred === undefined ? segments : [preferred, ...segments.filter((segment) => segment !== preferred)];
  for (const segment of order) {
    const bytes = files.get(segment.audio);
    if (bytes === undefined) continue;
    const trimmed = trimAudio(bytes, limits);
    if (trimmed !== null) return { segmentId: segment.id, ...trimmed };
  }
  return null;
}
