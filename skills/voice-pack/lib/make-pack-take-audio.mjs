// SPDX-License-Identifier: Apache-2.0
//
// 取音频（流程层，不花钱，在筛片段之前）：素材交来的音频，先变成包里能放的那一段，后面每一步（筛片段、转写、挑参考、写进包）用的都是这一段。
// 从视频、动画、游戏里截来的录音常是带视频轨的文件，还常带配乐、别人插话：做包只取音轨；使用者说出她单独说话的是哪几秒，就只用那几秒。
//
//   await takeAudio(env, items)                就地改条目，返回 Promise<void>
//   trimRange(trim, { sampleRate, frames })    写了起止秒的段切哪几个采样：{ from, to }（含 from，不含 to）；切不出东西（起点在录音的结尾以后）是 null。
//                                              查重（lib/duplicate-check.mjs）照它切，比的和包里放的是同几个采样
//
// 两件事，只对这一版新补的段做（上一版带来的段原样）：
//   取音轨   音频不是包能放的格式（protocol/lib/audio.mjs 的 sniffAudio 认不出：带视频轨的 mp4、mov、mkv，webm、aac 这类别的格式）：用 ffmpeg 解出第一路音轨
//            （tools/audio-decode.mjs，向环境要 ffmpeg），存成 WAV。包的格式不变：视频只是做包的输入，包里的参考照旧是音频。
//   裁剪     写了起止秒（trim）的段，只留那几秒。startSec 不写是从头，endSec 不写是到结尾；endSec 超过录音的长度，切到结尾。按采样切（起点、终点各取最近的采样，trimRange），不淡入淡出。
//            trim 的写法（{ startSec?, endSec? }，至少写一个，至少 0.1 秒）在 lib/make-pack-input.mjs 查，写错了在这之前就报。
// 两件都做的（带视频轨的文件写了起止秒），先取音轨再切。做了的段存成 16 位 WAV，声道数和采样率照原来的。都不用做的段（包能放的格式、没写起止秒）一个字节都不动。
// 外部资源（写了 externalUrl 的段）两件都不做：包里只记网址、大小和哈希（lib/make-pack-assemble.mjs 的 placeMaterial），取了音轨、切了就对不上网址上的文件
//   （调响度也跳过它，同一个理由）。所以它不收 trim（lib/make-pack-input.mjs），不是包能放的格式的，筛片段记 audio_unrecognized。
//
// 同一个文件的几段（一个文件里有几处能用，写成几段，audio 指同一个文件）：只解一次码，各段从解出来的那一份里切。认同一个文件看字节是不是同一个 Uint8Array
//   （命令行读同一个路径给的是同一个，cli/commands/make-pack.mjs）；解出来的那一份留到最后一段用它的条目做完为止。
// 重叠：同一个文件（字节的 SHA-256 一样）的几段，用的采样有重叠的，后一段不用，记 duplicate_audio：同一段声音不该在参考里出现两次，也不该一边当参考、一边当留出录音
//   （量出来的还原度会虚高）。没写起止秒的段算整个文件；挨着的（前一段的终点是后一段的起点）不算重叠；没用上的段（切不出、取不出的、记了重叠的）不占地方。
//   只在有段写了起止秒时才比：都没写的，字节一样就是重复，筛片段按哈希认（lib/make-pack-screen.mjs）。外部资源也算在里面（整个文件）。
//
// 不一口气占住线程：解码、切、编 WAV 都是同步的活，段多了浏览器里页面会卡住。每段开始之前、编 WAV 之前看一眼，连续做了 YIELD_AFTER_MS（50）毫秒就让事件循环转一圈
//   （lib/event-loop.mjs，同筛片段）。结果和次序不变。
//
// 读条目的：audio、trim、previous、externalUrl、id；写条目的：audio（取出来、切出来的这段）、convertedFrom（取了音轨的：原来的 MIME 类型）、trimmed（切了的：实际切的 { startSec, endSec }，秒，取到毫秒）；
// 做不成的写 unused: { reason, details }（筛片段就跳过它；原因的说法在 lib/material-hints.mjs）：
//   audio_unrecognized  不是包能放的格式，也取不出音轨。details: { mimeType, runtime } 是环境没有 ffmpeg（runtime 是 'ffmpeg'）；
//                       { mimeType, message } 是 ffmpeg 也解不开（message 是它说的话，打过码，见 tools/audio-decode.mjs）：文件里没有音轨、坏了，或者不是音频的字节
//   audio_undecodable   包能放的格式，写了起止秒，却解不开、没法切。details: { code, message }（同筛片段）
//   trim_out_of_range   起点在录音的结尾以后，切不出东西。details: { startSec, durationSec }
//   duplicate_audio     和前面一段是同一个文件，用的采样有重叠（见上面「重叠」）。details: { sameAs }（同筛片段的写法）
//
// 抛出的错误：没有自己的 code。解码抛的、不是「环境没有 ffmpeg」「解不了」的错，原样往上抛。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { sha256Hex } from '../protocol/lib/hash.mjs';
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { encodeWav } from '../tools/wav.mjs';
import { YIELD_AFTER_MS, nowMs, turnEventLoop } from './event-loop.mjs';

const toMs = (seconds) => Math.round(seconds * 1000) / 1000;

/**
 * 写了起止秒的段切哪几个采样（规则见文件头「裁剪」）。trim 是 lib/make-pack-input.mjs 查过的写法。
 * @param {{ startSec?: number, endSec?: number }} trim
 * @param {{ sampleRate: number, frames: number }} audio 解出来的音频（tools/audio-decode.mjs 的返回）
 * @returns {{ from: number, to: number } | null} 采样的范围（含 from，不含 to）；起点在录音的结尾以后是 null
 */
export function trimRange(trim, { sampleRate, frames }) {
  const from = Math.round((trim.startSec ?? 0) * sampleRate);
  const to = Math.min(frames, trim.endSec === undefined ? frames : Math.round(trim.endSec * sampleRate));
  return from >= frames || to <= from ? null : { from, to };
}

/** 解不开时这一段的去向：不是包能放的格式的，认不出（说清是缺 ffmpeg 还是 ffmpeg 也解不开）；能放的格式、要切的，解不开。 */
function failed(item, error, foreign) {
  const kind = decodeFailureKind(error);
  if (kind === null) throw error;
  if (!foreign) return { reason: 'audio_undecodable', details: { code: error.code, message: error.message } };
  return { reason: 'audio_unrecognized', details: { mimeType: item.audio.mimeType, ...(kind === 'runtime_missing' ? { runtime: error.details.runtime } : { message: error.message }) } };
}

/**
 * 取音轨、裁剪（规则见文件头）。
 * @param {object} env 注入的运行环境（WAV 以外的格式要它的 ffmpeg）
 * @param {object[]} items 条目（lib/make-pack-input.mjs）
 * @returns {Promise<void>}
 */
export async function takeAudio(env, items) {
  const fresh = items.filter((item) => item.previous === undefined);
  const compare = fresh.some((item) => item.trim !== undefined); // 有段写了起止秒才比重叠（文件头「重叠」）
  // 同一个文件只解一次：解出来的（或解不开的错）按字节记着，留到最后一段用它的条目做完
  const lastUse = new Map();
  fresh.forEach((item, index) => lastUse.set(item.audio.bytes, index));
  const decodedOf = new Map();
  const decode = async (bytes) => {
    if (!decodedOf.has(bytes)) {
      try {
        decodedOf.set(bytes, { audio: await decodeAudio(env, bytes) });
      } catch (error) {
        decodedOf.set(bytes, { error });
      }
    }
    return decodedOf.get(bytes);
  };
  const hashOf = new Map(); // 字节 -> SHA-256（同一个 Uint8Array 只算一次）
  const hash = async (bytes) => {
    if (!hashOf.has(bytes)) hashOf.set(bytes, await sha256Hex(bytes));
    return hashOf.get(bytes);
  };
  const taken = new Map(); // SHA-256 -> 用上的段 [{ id, from, to }]（采样；没写起止秒的是 0 到 Infinity）
  /** 和前面用上的、同一个文件的段重叠：记 duplicate_audio，返回 true；不重叠：占上这一段，返回 false。不比的时候（没有段写起止秒）总是 false。 */
  const overlaps = async (item, bytes, from, to) => {
    if (!compare) return false;
    const key = await hash(bytes);
    const before = (taken.get(key) ?? []).find((other) => other.from < to && from < other.to);
    if (before !== undefined) {
      item.unused = { reason: 'duplicate_audio', details: { sameAs: before.id } };
      return true;
    }
    taken.set(key, [...(taken.get(key) ?? []), { id: item.id, from, to }]);
    return false;
  };
  let busySince = nowMs();
  const breathe = async () => {
    if (nowMs() - busySince < YIELD_AFTER_MS) return;
    await turnEventLoop();
    busySince = nowMs();
  };

  const takeOne = async (item, bytes) => {
    if (item.externalUrl !== null) {
      await overlaps(item, bytes, 0, Infinity); // 外部资源不取、不切（文件头），只占地方
      return;
    }
    const foreign = sniffAudio(bytes) === null; // 不是包能放的格式
    if (!foreign && item.trim === undefined) {
      await overlaps(item, bytes, 0, Infinity);
      return;
    }
    const decoded = await decode(bytes);
    if (decoded.error !== undefined) {
      item.unused = failed(item, decoded.error, foreign);
      return;
    }
    const { sampleRate, frames, samples } = decoded.audio;
    let range = { from: 0, to: frames };
    if (item.trim !== undefined) {
      range = trimRange(item.trim, decoded.audio);
      if (range === null) {
        item.unused = { reason: 'trim_out_of_range', details: { startSec: item.trim.startSec ?? 0, durationSec: toMs(frames / sampleRate) } };
        return;
      }
    }
    if (await overlaps(item, bytes, range.from, item.trim === undefined ? Infinity : range.to)) return;
    if (item.trim !== undefined) item.trimmed = { startSec: toMs(range.from / sampleRate), endSec: toMs(range.to / sampleRate) };
    if (foreign) item.convertedFrom = item.audio.mimeType;
    await breathe();
    item.audio = { bytes: encodeWav({ sampleRate, samples: samples.map((channel) => channel.subarray(range.from, range.to)) }, { encoding: 'pcm16' }), mimeType: 'audio/wav' };
  };

  for (const [index, item] of fresh.entries()) {
    await breathe();
    const bytes = item.audio.bytes; // 交来的字节（takeOne 可能把 item.audio 换成取出来、切出来的那一段）
    await takeOne(item, bytes);
    if (lastUse.get(bytes) === index) decodedOf.delete(bytes); // 后面没有段用这个文件了，解出来的那一份放掉
  }
}
