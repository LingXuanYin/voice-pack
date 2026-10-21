// SPDX-License-Identifier: Apache-2.0
//
// 做包：把角色部分的素材（参考音频、脚本……）和描述（名字、参考集、功能……）打成一个合法的角色部分，
// 带上协议核心（和基础部分），生成 SKILL.md 骨架和清单，最后用 selfCheckPart 自检一遍——不合格的包不往外交。
//
// 包 ID：「英文短名-8 位随机的小写字母和数字」，遵守 Agent Skills 对 name 的限制；
// 英文短名由作者给，不给就用 vp；做包时生成，之后不再改（发新版本时把 id 传进来）。
//
// 错误：
//   pack_invalid        做出来的包过不了检查，或输入不对。details.problems 是 selfCheckPart 的问题清单（输入不对时是 details.reason：reserved_path、protocol_core_unsealed）
//   crypto_unavailable  同 hash.mjs 的同名 code（环境没有 WebCrypto）；这里缺的是 crypto.getRandomValues，生成不了包 ID（createPackId 没注入随机源时）。没有 details
//   random_invalid      注入的随机源一直给不出可用的字节（createPackId 的 random 参数坏了）：试了 64 轮就放弃，不死循环。没有 details
//   另外清单不合格时抛 manifest_invalid（manifest.mjs），描述里字段的类型不对也是它（生成 SKILL.md 骨架之前先查结构）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { assertFileSet, withPrefix } from './fileset.mjs';
import { sealPart } from './seal.mjs';
import { selfCheckPart } from './check.mjs';
import { sha256Hex } from './hash.mjs';
import { compareUtf8 } from './paths.mjs';
import { buildRoleSkillMd, resolveTextLanguage } from './skill-md.mjs';
import { PROTOCOL_VERSION, protocolMajor } from './version.mjs';
import { MANIFEST_FILE, PROTOCOL_DIRECTORY, isManagedPath, parseManifest } from './manifest.mjs';
import { CURRENT_NAMES, KNOWN_BASE_DIRECTORIES } from './names.mjs';

const DEFAULT_SHORT_NAME = 'vp';
const DEFAULT_FEATURES = Object.freeze({ dub: Object.freeze({ capabilities: Object.freeze(['text-to-speech', 'voice-cloning']) }) });
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 8;
const MAX_ID_LENGTH = 64;

function defaultRandom(length) {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new VoicePackError('crypto_unavailable', '这个环境没有 crypto.getRandomValues，生成不了包 ID');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** 把作者给的英文短名整理成合法的样子：小写，非字母数字的一段换成一个连字符，去掉首尾的连字符；什么都不剩就用 vp。 */
export function normalizeShortName(shortName) {
  const cleaned = String(shortName ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const room = MAX_ID_LENGTH - 1 - SUFFIX_LENGTH;
  const clipped = cleaned.slice(0, room).replace(/-+$/, '');
  return clipped === '' ? DEFAULT_SHORT_NAME : clipped;
}

/**
 * 生成一个新的包 ID：「英文短名-8 位随机的小写字母和数字」。
 * @param {string} [shortName] 英文短名，不给或整理完什么都不剩就用 vp
 * @param {(length: number) => Uint8Array} [random] 随机字节的来源，默认 crypto.getRandomValues；测试里注入固定的
 */
export function createPackId(shortName, random = defaultRandom) {
  let suffix = '';
  // 36 个字符，只取 252（36 的最大倍数，256 以内）以下的字节，免得取模让前几个字符出现得多一点。
  // 真的随机数一轮就够；轮数封顶，是防注入的随机源坏了（一直给不可用的字节）时死循环
  for (let round = 0; round < 64 && suffix.length < SUFFIX_LENGTH; round++) {
    for (const byte of random(SUFFIX_LENGTH * 2)) {
      if (byte < 252 && suffix.length < SUFFIX_LENGTH) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  if (suffix.length < SUFFIX_LENGTH) throw new VoicePackError('random_invalid', '随机数的来源一直给不出可用的字节，生成不了包 ID');
  return `${normalizeShortName(shortName)}-${suffix}`;
}

/** 做包时用的「假网络」：外部资源的字节是调用方给的，核对的是这些字节和清单里写的大小、哈希对不对，不联网。 */
function stubFetch(externals) {
  const byUrl = new Map(externals.map((e) => [e.url, e.data]));
  return async (url) => {
    const data = byUrl.get(url);
    if (data === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
}

/**
 * 做一个角色部分（完整包的内容，或只有角色部分的包的内容）。
 * @param {object} input
 * @param {string} input.name 显示名
 * @param {string} [input.shortName] 包 ID 的英文短名，新建时用
 * @param {string} [input.id] 已有的包 ID（发新版本时传；不传就新生成一个）
 * @param {string} [input.version='1.0.0']
 * @param {string} [input.changelog='首个版本']
 * @param {string} input.baseVersion 做包时用的基础部分版本（相当于「Made with」后面的版本号）
 * @param {{ protocolMajor?: number, baseMin?: string }} [input.requires] 默认：这一版库的协议主版本，基础部分的最低版本取 baseVersion
 * @param {Record<string, { capabilities: string[] }>} [input.features] 默认只有 dub（text-to-speech、voice-cloning）
 * @param {{ defaultSegment?: string, segments: object[] }} input.reference 参考集，段的 audio 是 files 里的路径（或外部资源的路径）
 * @param {object[]} [input.holdout] 留出录音
 * @param {Map<string, Uint8Array>} input.files 包内文件：参考音频、脚本……不含清单，不含 protocol/ 和基础部分的目录（names.mjs 里基础部分的目录名，两个协议版本的都算）。带了 SKILL.md 就用它，不带就生成骨架
 * @param {{ path: string, url: string, data: Uint8Array }[]} [input.externals] 外部资源：不放进包，清单里记 URL、大小、哈希（由 data 算出）
 * @param {object[]} [input.scripts] @param {object[]} [input.enhancers] @param {object} [input.direction] @param {object[]} [input.verification] @param {object} [input.designSource]
 * @param {string} [input.guidance] 配音指引（Markdown），放进生成的 SKILL.md 正文
 * @param {'zh' | 'en'} [input.textLanguage='zh'] 生成 SKILL.md 骨架用的语言（调用方按作者的语言给，例如 app 给作者做包时用的界面语言；规则见 skill-md.mjs 的 buildRoleSkillMd）。files 里带了 SKILL.md 就用不上，值错了照样抛 TypeError
 * @param {string[]} [input.sampleLines] 示例台词，原样写进清单的 sampleLines（规则见 protocol/FORMAT.md 4.4 节；不写或写空数组，清单里就没有这个字段；写得不合格，做不出包）
 * @param {Map<string, Uint8Array>} input.protocolCore 协议核心的文件（含它的 manifest.json 和签名），放进 protocol/
 * @param {Map<string, Uint8Array>} [input.base] 基础部分的文件（含它的 manifest.json、签名和嵌着的 protocol/），放进 voice-pack/（这一版库写的协议版本里基础部分的目录名，names.mjs）；不给就是只有角色部分
 * @param {object} [input.limits] 解包上限
 * @param {(length: number) => Uint8Array} [input.random] 随机字节的来源（测试用）
 * @returns {Promise<{ id: string, manifest: object, files: Map<string, Uint8Array> }>} files 是包目录里的全部文件（含 manifest.json）
 * @throws {VoicePackError} pack_invalid、manifest_invalid
 * @throws {TypeError} 缺 name、baseVersion、reference.segments，文件集不对，textLanguage 不是 'zh' 或 'en'：调用方用错了
 */
export async function packRolePart(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('input 必须是对象');
  const { name, baseVersion, reference, files, protocolCore } = input;
  if (typeof name !== 'string' || name === '') throw new TypeError('要给 name（显示名）');
  if (typeof baseVersion !== 'string') throw new TypeError('要给 baseVersion（做包时用的基础部分版本）');
  if (reference === null || typeof reference !== 'object' || !Array.isArray(reference.segments) || reference.segments.length === 0) throw new TypeError('要给 reference.segments（参考集，至少一段）');
  assertFileSet(files);
  assertFileSet(protocolCore);
  if (input.base !== undefined) assertFileSet(input.base);
  const textLanguage = resolveTextLanguage(input.textLanguage); // 带了现成的 SKILL.md 也先查：用错了不悄悄放过
  if (!protocolCore.has(MANIFEST_FILE)) throw new VoicePackError('pack_invalid', `协议核心没有 ${MANIFEST_FILE}：用官方发布的基础部分里的协议核心，或者先用 seal 命令生成`, { details: { reason: 'protocol_core_unsealed' } });

  const reserved = [...files.keys()].filter((path) => !isManagedPath(path, 'role'));
  if (reserved.length > 0) throw new VoicePackError('pack_invalid', `这些路径不能放在角色部分的文件里（清单、签名、protocol/、${KNOWN_BASE_DIRECTORIES.map((name) => `${name}/`).join('、')}（认得的基础部分目录名，各协议版本的）由打包程序放）：${reserved.join('、')}`, { details: { reason: 'reserved_path', paths: reserved } });

  const id = input.id ?? createPackId(input.shortName, input.random);
  const externals = input.externals ?? [];
  const externalEntries = [];
  for (const e of externals) {
    if (typeof e?.path !== 'string' || typeof e?.url !== 'string' || !(e?.data instanceof Uint8Array)) throw new TypeError('每个外部资源要有 path、url 和 data（Uint8Array）');
    externalEntries.push({ path: e.path, url: e.url, size: e.data.length, sha256: await sha256Hex(e.data) });
  }
  externalEntries.sort((a, b) => compareUtf8(a.path, b.path));

  const segments = reference.segments;
  const fields = {
    protocol: PROTOCOL_VERSION,
    part: 'role',
    id,
    name,
    version: input.version ?? '1.0.0',
    changelog: input.changelog ?? '首个版本',
    madeWith: { baseVersion },
    requires: { protocolMajor: input.requires?.protocolMajor ?? protocolMajor(PROTOCOL_VERSION), baseMin: input.requires?.baseMin ?? baseVersion },
    features: input.features ?? DEFAULT_FEATURES,
    reference: { defaultSegment: reference.defaultSegment ?? segments[0]?.id, segments },
    ...(input.holdout?.length ? { holdout: input.holdout } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    // 示例台词：不写、写空数组，清单里就没有这个字段；别的值（字符串、null、有 length 的对象……）原样交给清单检查去拒绝，不悄悄丢掉
    ...(input.sampleLines === undefined || (Array.isArray(input.sampleLines) && input.sampleLines.length === 0) ? {} : { sampleLines: input.sampleLines }),
    ...(input.enhancers?.length ? { enhancers: input.enhancers } : {}),
    ...(input.scripts?.length ? { scripts: input.scripts } : {}),
    ...(input.verification?.length ? { verification: input.verification } : {}),
    ...(input.designSource ? { designSource: input.designSource } : {}),
    ...(externalEntries.length ? { externals: externalEntries } : {}),
  };

  const own = new Map(files);
  if (!own.has('SKILL.md')) own.set('SKILL.md', new TextEncoder().encode(buildRoleSkillMd(fields, { guidance: input.guidance, textLanguage })));
  const tree = new Map([...own, ...withPrefix(PROTOCOL_DIRECTORY, protocolCore)]);
  if (input.base !== undefined) for (const [path, data] of withPrefix(CURRENT_NAMES.baseDirectory, input.base)) tree.set(path, data);

  const sealed = await sealPart(tree, fields);
  // 自检：检查自己正在做的角色部分。角色部分本来就不签名；带进来的协议核心和基础部分是调用方给的，这里不重复验签
  // （每个部分只在进入环境的时候校验一次）。所以用不验签、不做互相校验的 selfCheckPart；
  // 从外面来的东西才走 checkPart（要选验签的策略，见 check.mjs）
  const report = await selfCheckPart(sealed, { part: 'role', limits: input.limits, env: { capabilities: {}, ...(externals.length ? { fetch: stubFetch(externals) } : {}) } });
  if (!report.ok) {
    const first = report.problems[0];
    throw new VoicePackError('pack_invalid', `做出来的包过不了检查：${first.message}${report.problems.length > 1 ? `（共 ${report.problems.length} 处问题）` : ''}`, { details: { problems: report.problems } });
  }
  return { id, manifest: parseManifest(sealed.get(MANIFEST_FILE), { limits: input.limits }), files: sealed };
}
