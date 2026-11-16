// SPDX-License-Identifier: Apache-2.0
//
// 打开一个角色部分来用（流程层）：读清单，按需取参考音频、读音词表、配音指引、增强件和脚本。
// 配音（lib/dub.mjs）、变声（lib/convert.mjs）都从这里拿包里的东西。
//
//   const pack = await openVoicePack(source, { env });
//   pack.manifest                          角色部分的清单（已经按 schema 和语义规则读过）
//   await pack.referenceClip(segmentId)    { segment, clip: { bytes, mimeType } }：一段参考的清单项和音频
//   await pack.lexicon()                   读音词表（lib/pronunciation-lexicon.mjs 读出来的），包里没有给 null
//   await pack.guidance()                  配音指引的正文（SKILL.md 的「配音指引」一节），作者没写给 null
//   pack.enhancers(capability?)            增强件：[{ id, model, modelVersion, capability, referenceVersion, load }]，load() 才读文件
//   pack.scripts(feature?)                 登记的脚本：[{ entry, runtime, feature? }]，给 feature 就只要登记在这个功能名下的
//   await pack.read(path)                  包里（或外部资源）的任意一个清单列出的文件（外部资源核对过；包内文件给了 verify 才核对）
//   MIME_OF_FORMAT                         音频格式（wav、mp3、flac、ogg、m4a）→ MIME 类型的对应表；做包、读上一版也用这一张，只写在这里
//
// source 是角色部分的文件：Map<路径, Uint8Array>（路径相对角色部分的目录，用 /），或者 { read(path) } 一个按路径读的函数
// （返回 Uint8Array，没有这个文件就返回 null / undefined）。库不碰文件系统：目录由命令行层读（只读用到的文件，不整个包读进内存）。
//
// 只打开清单：别的文件用到才读。文件和清单对不对得上，检查在「进入环境」时做过一次（进来以后不再复查），
// 这里读文件不再算大小和 SHA-256；清单里列了、却拿不到文件，仍然报 file_missing（读不到不是校验的事）。
// 要核对时给 { verify: true }：读到每个文件都核对大小和 SHA-256，对不上报 file_modified。做新版本时读上一版（lib/pack-version.mjs）用它：
// 上一版是外面递进来的文件，没有「进入环境」那一步。
// 读过一次的文件在这个 pack 对象的生命周期里不再读第二次。
//
// 外部资源（清单的 externals）和包内文件一视同仁，用路径引用；读的时候用环境的 fetch 取。外部资源不在「进入环境」的检查范围里，
// 所以不论 verify 怎么给，取回来都核对大小和 SHA-256。
//
// 约定：读音词表放在角色部分根上的 lexicon.pls（LEXICON_FILE），要列进清单的 files（检查会核对它的哈希）；
// 配音指引是 SKILL.md 里「## 配音指引」这一节，它是 SKILL.md 的最后一节，这个标题以后的内容都算指引。
//
// 抛出的错误（VoicePackError；details 里放什么在抛出处写明）：
//   manifest_missing        读不到清单。details.path
//   manifest_*              清单不合格：照 protocol/lib/manifest.mjs 的 parseManifest
//   pack_not_role           清单不是角色部分的。details.part 是它自己说的种类
//   pack_protocol_old       包按协议 1.x、2.x 写（details: { protocol }，清单写的协议版本）：参考段的写法不一样（语言、音色基底标签，protocol/FORMAT.md 第 14 节），
//                           这一版不读旧格式、不迁移；配音、变声在打开包时就停下，一次能力都不调。旧包照旧能用，用它那个主版本的程序（FORMAT.md 第 14 节「2.x packs」）：
//                           完整包用它自带的基础部分；只有角色部分的，用那个主版本（2.x、1.x）的基础部分（补全只在包要的主版本里挑，第 11 节）。说明里照这样写，主版本取自包的清单。
//                           不借用 pack_invalid：那是协议核心打包失败的码（protocol/lib/pack.mjs）。make-pack --previous 碰上旧包另报 make_pack_previous_invalid / protocol_old（lib/pack-version.mjs）
//   reference_unknown       没有这一段参考（留出录音不是参考，也算没有）。details.segment
//   file_unlisted           要的路径清单里没列。details.path
//   file_missing            清单里列了、拿不到文件。details.path
//   file_modified           文件和清单对不上（只在 verify: true 时查）。details: { path, reason: 'size' | 'sha256', expected, actual }
//   audio_unrecognized      参考音频既认不出内容，扩展名也不是允许的音频。details.path
//   fetch_missing           要取外部资源，环境没有网络（来自核心层）
//   external_unverifiable   取外部资源时网络出错。details: { path, url, reason: 'network' }
//   external_fetch_failed   服务器答了，但不是成功。details: { path, url, status }
//   external_hash_mismatch  取回来的和清单对不上。details: { path, url, reason: 'size' | 'sha256', expected, actual }
//   lexicon_invalid         读音词表写坏了（来自 lib/pronunciation-lexicon.mjs）
//   另外 path_unsafe（路径不安全）来自核心层。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { parseManifest, MANIFEST_FILE } from '../protocol/lib/manifest.mjs';
import { protocolMajorOf } from '../protocol/lib/names.mjs';
import { PROTOCOL_VERSION } from '../protocol/lib/version.mjs';
import { assertPackPath } from '../protocol/lib/paths.mjs';
import { sha256Hex } from '../protocol/lib/hash.mjs';
import { readCapped } from '../protocol/lib/check.mjs';
import { requireFetch } from '../protocol/lib/env.mjs';
import { sniffAudio, AUDIO_EXTENSIONS } from '../protocol/lib/audio.mjs';
import { GUIDANCE_HINT } from '../protocol/lib/skill-md.mjs';
import { parseLexicon, LEXICON_FILE } from './pronunciation-lexicon.mjs';

const SKILL_FILE = 'SKILL.md';
const GUIDANCE_HEADING = /^##[ \t]+配音指引[ \t]*$/m;

/** 音频格式（tools 里认出来的 wav、mp3、flac、ogg、m4a）对应的 MIME 类型。做包、读上一版、读参考音频都用这一张。 */
export const MIME_OF_FORMAT = Object.freeze({ wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' });
const decoder = new TextDecoder('utf-8');
// 开头的字节序标记
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

function toReader(source) {
  if (source instanceof Map) return async (path) => source.get(path) ?? null;
  if (source !== null && typeof source === 'object' && typeof source.read === 'function') {
    return async (path) => {
      const bytes = await source.read(path);
      if (bytes === null || bytes === undefined) return null;
      if (!(bytes instanceof Uint8Array)) throw new TypeError(`the read function must return a Uint8Array (or null); got ${typeof bytes} when reading ${JSON.stringify(path)}`);
      return bytes;
    };
  }
  throw new TypeError('source must be a file set (Map<path, Uint8Array>) or { read(path) }');
}

/** SKILL.md 里「配音指引」一节的正文。没有这一节、是空的、还是打包时放的提示，都给 null。 */
function guidanceOf(skillMd) {
  const text = skillMd.replace(BOM, '').replace(/\r\n?/g, '\n');
  const match = GUIDANCE_HEADING.exec(text);
  if (match === null) return null;
  const body = text.slice(match.index + match[0].length).trim();
  return body === '' || body === GUIDANCE_HINT.trim() ? null : body;
}

/**
 * 打开一个角色部分。
 * @param {Map<string, Uint8Array> | { read: (path: string) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined> }} source
 * @param {{ env?: object, verify?: boolean }} [options] env：取外部资源时用它的 fetch；verify：读包内文件时核对大小和 SHA-256（默认 false，见文件头）
 */
export async function openVoicePack(source, { env, verify = false } = {}) {
  if (typeof verify !== 'boolean') throw new TypeError(`verify must be true or false, got ${JSON.stringify(verify)}`);
  const readSource = toReader(source);
  const manifestBytes = await readSource(MANIFEST_FILE);
  if (manifestBytes === null) throw new VoicePackError('manifest_missing', `no manifest ${MANIFEST_FILE}: this is not the role part of a voice pack`, { details: { path: MANIFEST_FILE } });
  const manifest = parseManifest(manifestBytes);
  if (manifest.part !== 'role') throw new VoicePackError('pack_not_role', `${MANIFEST_FILE} says this is ${manifest.part}; dubbing needs the role part (the reference set of one voice)`, { details: { part: manifest.part } });
  if (protocolMajorOf(manifest.protocol) !== protocolMajorOf(PROTOCOL_VERSION)) {
    const major = protocolMajorOf(manifest.protocol);
    throw new VoicePackError('pack_protocol_old', `this pack was written for protocol ${manifest.protocol}: reference segments are written differently (language, reference tags; see protocol/FORMAT.md section 14), and this version (protocol ${PROTOCOL_VERSION}) does not read the old format. Old packs still work as before: a full pack uses the base part it carries; a role part on its own uses a ${major}.x base part (complete only picks within the major version the pack asks for, FORMAT.md section 11). Or make a new pack from the new materials`, { details: { protocol: manifest.protocol } });
  }

  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const externals = new Map((manifest.externals ?? []).map((entry) => [entry.path, entry]));
  const fetchEnv = env ?? { capabilities: {} };

  // ---- 读文件：每个路径最多读一次，读到就核对
  const cache = new Map();
  const once = (key, make) => {
    if (!cache.has(key)) {
      const pending = make();
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); }); // 失败的不进缓存
    }
    return cache.get(key);
  };

  async function fetchExternal(path, entry) {
    const fetcher = requireFetch(fetchEnv);
    const base = { path, url: entry.url };
    let response;
    try {
      response = await fetcher(entry.url);
    } catch (cause) {
      throw new VoicePackError('external_unverifiable', `cannot fetch external resource ${path}: network error while fetching from ${entry.url} (${cause?.message ?? cause})`, { details: { ...base, reason: 'network' }, cause });
    }
    if (!response || response.ok !== true) throw new VoicePackError('external_fetch_failed', `external resource ${path} could not be fetched: ${entry.url} returned ${response?.status ?? 'no response'}`, { details: { ...base, status: response?.status ?? null } });
    let read;
    try {
      read = await readCapped(response, entry.size); // 和检查用同一个读法：超过清单里写的大小就停
    } catch (cause) {
      throw new VoicePackError('external_unverifiable', `cannot fetch external resource ${path}: error while reading the content of ${entry.url} (${cause?.message ?? cause})`, { details: { ...base, reason: 'network' }, cause });
    }
    if (read.tooLarge || read.bytes.length !== entry.size) {
      const got = read.tooLarge ? read.actual : read.bytes.length;
      throw new VoicePackError('external_hash_mismatch', `external resource ${path} does not match the manifest: the manifest says ${entry.size} bytes, the fetched content ${read.tooLarge ? 'exceeds' : 'is'} ${got} bytes`, { details: { ...base, reason: 'size', expected: entry.size, actual: got } });
    }
    const digest = await sha256Hex(read.bytes);
    if (digest !== entry.sha256) throw new VoicePackError('external_hash_mismatch', `external resource ${path} does not match the manifest: the SHA-256 differs`, { details: { ...base, reason: 'sha256', expected: entry.sha256, actual: digest } });
    return read.bytes;
  }

  async function loadFile(path) {
    const entry = listed.get(path);
    if (entry !== undefined) {
      const bytes = await readSource(path);
      if (bytes === null) throw new VoicePackError('file_missing', `the manifest lists ${path}, but the pack does not have it`, { details: { path } });
      if (verify) {
        if (bytes.length !== entry.size) throw new VoicePackError('file_modified', `${path} was modified: its size is ${bytes.length} bytes, the manifest records ${entry.size} bytes`, { details: { path, reason: 'size', expected: entry.size, actual: bytes.length } });
        const digest = await sha256Hex(bytes);
        if (digest !== entry.sha256) throw new VoicePackError('file_modified', `${path} was modified: its SHA-256 differs from the one in the manifest`, { details: { path, reason: 'sha256', expected: entry.sha256, actual: digest } });
      }
      return bytes;
    }
    const external = externals.get(path);
    if (external !== undefined) return fetchExternal(path, external);
    throw new VoicePackError('file_unlisted', `the manifest does not list ${path}: only files listed in the manifest are read`, { details: { path } });
  }

  const read = (path) => {
    assertPackPath(path);
    return once(`file:${path}`, () => loadFile(path));
  };

  // ---- 参考音频
  const referenceClip = (segmentId) => {
    const segment = manifest.reference.segments.find((candidate) => candidate.id === segmentId);
    if (segment === undefined) throw new VoicePackError('reference_unknown', `no such segment in the reference set: ${JSON.stringify(segmentId)} (a held-out recording is not a reference)`, { details: { segment: String(segmentId) } });
    return once(`clip:${segment.id}`, async () => {
      const bytes = await read(segment.audio);
      const sniffed = sniffAudio(bytes);
      const extension = segment.audio.slice(segment.audio.lastIndexOf('.') + 1).toLowerCase();
      const format = sniffed?.format ?? (Object.hasOwn(AUDIO_EXTENSIONS, extension) ? AUDIO_EXTENSIONS[extension] : null);
      if (format === null) throw new VoicePackError('audio_unrecognized', `cannot recognize the format of reference audio ${segment.audio}`, { details: { path: segment.audio } });
      return { segment, clip: { bytes, mimeType: MIME_OF_FORMAT[format] } };
    });
  };

  return {
    manifest,
    read,
    referenceClip,
    lexicon: () => once('lexicon', async () => (listed.has(LEXICON_FILE) ? parseLexicon(await read(LEXICON_FILE)) : null)),
    guidance: () => once('guidance', async () => (listed.has(SKILL_FILE) ? guidanceOf(decoder.decode(await read(SKILL_FILE))) : null)),
    enhancers: (capability) =>
      (manifest.enhancers ?? [])
        .filter((entry) => capability === undefined || entry.capability === capability)
        .map((entry) => ({ id: entry.id, model: entry.model, modelVersion: entry.modelVersion, capability: entry.capability, referenceVersion: entry.referenceVersion, load: () => read(entry.path) })),
    scripts: (feature) => (manifest.scripts ?? []).filter((entry) => feature === undefined || entry.feature === feature).map((entry) => ({ ...entry })),
  };
}
