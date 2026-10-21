// SPDX-License-Identifier: Apache-2.0
//
// 音频按内容判断格式，不只看扩展名。
//
// 允许的格式（理由见 protocol/FORMAT.md「音频」）：
//   wav   RIFF/WAVE（PCM、浮点等，不限编码）
//   mp3   MPEG 音频（第一、二、三层；常见的是第三层）
//   flac  FLAC
//   ogg   Ogg 容器里的 Vorbis 或 Opus（扩展名 .ogg 或 .opus）
//   m4a   MP4 容器，轨全是音频（AAC、ALAC 都行）
// 这些是参考集和留出录音实际会用的格式，浏览器和常见的 agent 环境都能直接读；
// 其余的（AIFF、AAC 裸流、WMA、AMR、WebM……）不收：多收一种格式，就多一种要在检查里写对的解析。
//
// 「按内容判断」是这样做的：sniffAudio 只看文件开头的几百字节（M4A 看顶层 box 的头），认容器的结构，
// 不是只认前四个字节的魔数——WAV 要有 fmt 块和 data 块，MP3 要有合法的帧头并且下一帧接得上，FLAC 要有 STREAMINFO，
// Ogg 的第一页要过页校验并且里面是 Opus 或 Vorbis，M4A 要有 moov 并且轨全是音频。随机数据、改了扩展名的可执行文件、
// 文本碰巧凑出一个魔数，都过不了。它不解码，所以认出来的只是「长得是这种音频」，不保证能播放。
//
// audioProblem 回答检查时要问的问题：这个文件的扩展名和内容对得上吗？
//   audio_disguised           扩展名说是音频，内容不是（或是另一种音频）；或者内容是音频，扩展名却不是音频。
//                             details: { path, claimed（扩展名，没有就是空串）, actual（认出的格式，认不出是 null） }
//   audio_format_not_allowed  扩展名是认得的音频格式，但不在允许的格式里。details: { path, extension }
// 清单里标明是音频的文件（参考段、留出录音）传 designated: true：扩展名也必须是允许的音频扩展名。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export const AUDIO_FORMATS = Object.freeze(['wav', 'mp3', 'flac', 'ogg', 'm4a']);
/** 允许的扩展名（小写）对应的格式。 */
export const AUDIO_EXTENSIONS = Object.freeze({ wav: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', opus: 'ogg', m4a: 'm4a' });
/** 认得是音频、但不收的扩展名。 */
const OTHER_AUDIO_EXTENSIONS = new Set([
  'aif', 'aifc', 'aiff', 'aac', 'wma', 'amr', 'awb', 'mka', 'weba', 'webm', 'mp1', 'mp2', 'au', 'snd', 'caf', 'ac3', 'eac3', 'dts',
  'ape', 'wv', 'tta', 'mid', 'midi', 'ra', 'ram', 'm4b', 'm4r', 'oga', 'spx', 'm3u', 'm3u8',
]);

const ascii = (bytes, from, to) => { let text = ''; for (let i = from; i < to && i < bytes.length; i++) text += String.fromCharCode(bytes[i]); return text; };
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

// ---- WAV ----
const WAV_CODECS = { 1: 'pcm', 3: 'float', 0xfffe: 'extensible' };
const MAX_RIFF_CHUNKS = 64; // fmt 和 data 都在最前面；前面堆了几十个块还没见到，不去一直找

function sniffWav(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WAVE') return null;
  let at = 12;
  let fmt = null;
  for (let n = 0; n < MAX_RIFF_CHUNKS && at + 8 <= b.length; n++) {
    const id = ascii(b, at, at + 4);
    const size = u32le(b, at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > b.length) return null;
      fmt = { tag: u16le(b, body), channels: u16le(b, body + 2), sampleRate: u32le(b, body + 4) };
    } else if (id === 'data') {
      if (fmt === null || fmt.channels < 1 || fmt.sampleRate < 1) return null;
      return { format: 'wav', codec: WAV_CODECS[fmt.tag] ?? 'other', channels: fmt.channels, sampleRate: fmt.sampleRate };
    }
    at = body + size + (size & 1); // 块按偶数字节对齐；size 再大也只是让 at 超出文件，循环自然结束
  }
  return null;
}

// ---- MP3（MPEG 音频）----
// 比特率表（kbps），按 [版本][层] 取；索引 0 是自由格式、15 非法，都不收
const BITRATES = {
  v1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  v2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }; // 按版本位：3 = MPEG-1，2 = MPEG-2，0 = MPEG-2.5
const MP3_CODECS = { 1: 'mp1', 2: 'mp2', 3: 'mp3' };

/**
 * 解析 at 处的 MPEG 音频帧头；不合法给 null，合法给 { version, layer, sampleRate, length }
 * （version：3 是 MPEG-1，2 是 MPEG-2，0 是 MPEG-2.5；layer：1、2、3；length 是整帧的字节数）。
 * 预览卡片（preview-audio.mjs）截短 MP3 时也用它：帧头的规则只在这里写一份。
 */
export function mpegFrame(b, at) {
  if (at < 0 || at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 1 是保留值
  const layerBits = (b[at + 1] >> 1) & 3; // 0 是保留值：1 → 第三层，2 → 第二层，3 → 第一层
  if (version === 1 || layerBits === 0) return null;
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  const padding = (b[at + 2] >> 1) & 1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const bitrate = BITRATES[version === 3 ? 'v1' : 'v2'][layer][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  let length;
  if (layer === 1) length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  else if (layer === 2 || version === 3) length = Math.floor((144 * bitrate) / sampleRate) + padding;
  else length = Math.floor((72 * bitrate) / sampleRate) + padding; // MPEG-2/2.5 的第三层每帧样本数减半
  return { version, layer, sampleRate, length };
}

/**
 * 开头的 ID3v2 标签有多长：含 10 字节的头，v2.4 带 footer 的再加 10；没有标签给 0；头不合法给 -1。
 * ID3v2 头：'ID3' + 版本 + 修订 + 标志 + 4 字节 syncsafe 长度（每字节最高位必须是 0）。
 * 预览卡片（preview-audio.mjs）截短 MP3 时也用它：头的规则只在这里写一份。
 */
export function id3v2Length(b) {
  if (ascii(b, 0, 3) !== 'ID3') return 0;
  if (b.length < 10 || ![2, 3, 4].includes(b[3]) || (b[6] | b[7] | b[8] | b[9]) & 0x80) return -1;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  return 10 + size + (b[3] === 4 && (b[5] & 0x10) ? 10 : 0); // v2.4 的标志位 0x10 表示末尾还有 10 字节的 footer
}

function sniffMp3(b) {
  const at = id3v2Length(b);
  if (at < 0) return null;
  const first = mpegFrame(b, at);
  if (first === null) return null;
  const next = at + first.length;
  if (next > b.length) return null; // 连第一帧都不完整
  const isId3v1 = ascii(b, next, next + 3) === 'TAG' && b.length - next >= 128;
  if (next < b.length && !isId3v1) {
    const second = mpegFrame(b, next);
    if (second === null || second.version !== first.version || second.layer !== first.layer || second.sampleRate !== first.sampleRate) return null;
  }
  return { format: 'mp3', codec: MP3_CODECS[first.layer], sampleRate: first.sampleRate };
}

// ---- FLAC ----
function sniffFlac(b) {
  if (b.length < 42 || ascii(b, 0, 4) !== 'fLaC') return null;
  if ((b[4] & 0x7f) !== 0) return null; // 第一个元数据块必须是 STREAMINFO（类型 0）
  if (((b[5] << 16) | (b[6] << 8) | b[7]) !== 34) return null;
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4); // STREAMINFO 里的 20 位采样率
  if (sampleRate === 0) return null;
  return { format: 'flac', codec: 'flac', sampleRate, channels: ((b[20] >> 1) & 7) + 1 };
}

// ---- Ogg ----
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let k = 0; k < 8; k++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
    table[i] = crc >>> 0;
  }
  return table;
})();

function oggPageCrc(b, length) {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : b[i]; // 校验字段本身按 0 算
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc;
}

function sniffOgg(b) {
  if (b.length < 27 || ascii(b, 0, 4) !== 'OggS' || b[4] !== 0 || (b[5] & 0x02) === 0) return null; // 版本 0，第一页要带「流开始」标志
  const segments = b[26];
  const headerLength = 27 + segments;
  if (b.length < headerLength) return null;
  let payload = 0;
  for (let i = 0; i < segments; i++) payload += b[27 + i];
  const pageLength = headerLength + payload;
  if (pageLength > b.length || oggPageCrc(b, pageLength) !== u32le(b, 22)) return null;
  const packet = b.subarray(headerLength, pageLength);
  if (packet.length >= 19 && ascii(packet, 0, 8) === 'OpusHead' && (packet[8] & 0xf0) === 0) return { format: 'ogg', codec: 'opus' };
  if (packet.length >= 30 && packet[0] === 1 && ascii(packet, 1, 7) === 'vorbis' && u32le(packet, 7) === 0) return { format: 'ogg', codec: 'vorbis' };
  return null; // Ogg FLAC、Speex、Theora 等：容器是 Ogg，但不在允许的格式里
}

// ---- M4A（ISO BMFF）----
const MAX_BOXES = 4096; // 一层里最多看这么多个 box；恶意文件堆几万个空 box 也不会拖慢

/** 读 start..end 之间的 box 头。box 声明的长度越界时，最后一个允许越界（被截断的 mdat），由调用方决定要不要。 */
function readBoxes(b, start, end) {
  const boxes = [];
  let at = start;
  while (at + 8 <= end && boxes.length < MAX_BOXES) {
    let size = u32be(b, at);
    let header = 8;
    if (size === 1) { // 64 位长度
      if (at + 16 > end) return null;
      const high = u32be(b, at + 8);
      if (high > 0x1fffff) return null; // 超出 JS 能精确表示的整数
      size = high * 2 ** 32 + u32be(b, at + 12);
      header = 16;
    } else if (size === 0) {
      size = end - at; // 0：一直到容器结尾
    }
    if (size < header) return null;
    boxes.push({ type: ascii(b, at + 4, at + 8), body: at + header, end: at + size });
    if (at + size >= end) break;
    at += size;
  }
  return boxes;
}

function handlerTypes(b, moov) {
  const found = [];
  const children = readBoxes(b, moov.body, moov.end);
  if (children === null || children.some((c) => c.end > moov.end)) return null;
  for (const trak of children.filter((c) => c.type === 'trak')) {
    const mdia = readBoxes(b, trak.body, trak.end)?.find((c) => c.type === 'mdia');
    if (!mdia) return null;
    const hdlr = readBoxes(b, mdia.body, mdia.end)?.find((c) => c.type === 'hdlr');
    if (!hdlr || hdlr.end - hdlr.body < 12 || hdlr.end > b.length) return null;
    found.push(ascii(b, hdlr.body + 8, hdlr.body + 12)); // hdlr：版本和标志 4 字节 + pre_defined 4 字节，然后是 handler_type
  }
  return found;
}

function sniffM4a(b) {
  if (b.length < 16 || ascii(b, 4, 8) !== 'ftyp') return null;
  const top = readBoxes(b, 0, b.length);
  if (top === null || top[0]?.type !== 'ftyp' || top[0].end > b.length) return null;
  const moov = top.find((box) => box.type === 'moov');
  if (!moov || moov.end > b.length) return null;
  const handlers = handlerTypes(b, moov);
  if (handlers === null || !handlers.includes('soun') || handlers.includes('vide')) return null;
  return { format: 'm4a', codec: null };
}

/**
 * 看内容，认这是哪种允许的音频。认不出（不是音频，或是不在允许的格式里的音频）给 null。
 * @param {Uint8Array} bytes
 * @returns {{ format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a', codec: string | null } | null}
 *   另带 channels、sampleRate 之类认得出的信息（不保证每种格式都有）
 */
export function sniffAudio(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  if (bytes.length < 4) return null;
  const magic = ascii(bytes, 0, 4);
  if (magic === 'RIFF') return sniffWav(bytes);
  if (magic === 'fLaC') return sniffFlac(bytes);
  if (magic === 'OggS') return sniffOgg(bytes);
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === 'ftyp') return sniffM4a(bytes);
  if (magic.startsWith('ID3') || bytes[0] === 0xff) return sniffMp3(bytes);
  return null;
}

/** 路径最后一段的扩展名，小写，不含点；没有扩展名（包括 .gitignore 这种点开头的文件名）给空串。 */
function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * 这个文件的扩展名和内容对得上吗？对得上（或者它根本不是音频、也没被说成是音频）给 null，否则给一个问题。
 * @param {string} path 包里的路径（只用最后一段的扩展名）
 * @param {Uint8Array} bytes 文件内容
 * @param {{ designated?: boolean }} [options] designated：清单里标明这个文件是音频（参考段、留出录音）
 * @returns {null | { code: 'audio_disguised' | 'audio_format_not_allowed', message: string, details: object }}
 */
export function audioProblem(path, bytes, options = {}) {
  const extension = extensionOf(path);
  const expected = Object.hasOwn(AUDIO_EXTENSIONS, extension) ? AUDIO_EXTENSIONS[extension] : null;
  const sniffed = sniffAudio(bytes);
  const disguised = (actual) => ({
    code: 'audio_disguised',
    message: actual === null
      ? `${path} 的扩展名是 .${extension}，内容却不是允许的音频（${AUDIO_FORMATS.join('、')}）`
      : `${path} 的扩展名是${extension ? ` .${extension}` : '空的'}，内容是 ${actual}`,
    details: { path, claimed: extension, actual },
  });
  if (expected !== null) {
    if (sniffed === null) return disguised(null);
    return sniffed.format === expected ? null : disguised(sniffed.format);
  }
  if (OTHER_AUDIO_EXTENSIONS.has(extension)) {
    return { code: 'audio_format_not_allowed', message: `${path} 是 .${extension}，不在允许的音频格式里（${AUDIO_FORMATS.join('、')}）`, details: { path, extension } };
  }
  if (sniffed !== null) return disguised(sniffed.format);
  if (options.designated) return disguised(null);
  return null;
}
