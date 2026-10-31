// SPDX-License-Identifier: Apache-2.0
//
// 用哪一份基础部分：补全（complete.mjs）要做的两个判断，都是纯函数，不碰网络、不碰文件系统。
//   assessBasePart     一份已经在手里的基础部分（环境里原有的、包里自带的）能不能用
//   selectBaseVersion  官方地址的版本索引里，挑哪一个版本去下载
// 规则和理由的正本是 protocol/FORMAT.md 的「补全」一节；这里写程序怎么做、抛什么。
//
// 「可用」三条都成立：
//   官方版本   基础部分和它里面的协议核心，两份清单旁边的签名都是信任名单里的公钥签的
//   协议兼容   基础部分的协议主版本等于角色部分要求的 requires.protocolMajor
//   版本够     基础部分的版本不低于角色部分要求的最低版本 requires.baseMin（语义化版本的次序）
// 环境里原有的这一份只看两份清单和它们的签名，不逐个文件重算哈希（环境里原有的那一部分不重新算哈希；每个部分只在进入环境的时候校验一次）。
//
// 挑版本：同一个主版本里、不低于最低版本、协议主版本对得上的最高版本，也就是语义化版本的 ^最低版本；预发布版本不候选（最低版本自己是预发布版时，同一个 主.次.修订 的预发布版除外）。
// 只在读到了可信的索引时挑：索引是名单外的钥匙签的（官方换过钥匙）时不走这里，补全退到最低版本本身（complete.mjs 第 4 步，RELEASES.md「私钥丢了或泄露了」）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { readManifest, partName, MANIFEST_FILE, SIGNATURE_FILE, PROTOCOL_DIRECTORY } from './manifest.mjs';
import { baseDirectoryOf } from './names.mjs';
import { compareSemver, parseSemver, parseProtocolVersion, protocolMajor } from './version.mjs';

const isBytes = (value) => value instanceof Uint8Array;

// ---------------------------------------------------------------- 一份基础部分能不能用

const REASON_TEXT = {
  manifest_missing: () => '没有基础部分的清单（manifest.json）',
  manifest_invalid: (r) => `基础部分的清单读不懂（${r.code}）`,
  not_base_part: (r) => `清单不是基础部分的（它说自己是 ${r.actual}）`,
  not_official: (r) => `${r.part === 'protocol' ? `里面的${partName('protocol')}` : partName('base')}不是官方版本（${r.code}）`,
  protocol_core_missing: () => '没有协议核心的清单（protocol/manifest.json）',
  protocol_incompatible: (r) => `协议主版本是 ${r.actual}，角色部分要的是 ${r.required}`,
  too_old: (r) => `版本 ${r.actual} 比角色部分要求的最低版本 ${r.required} 低`,
};

/**
 * 一份被判成不能用的基础部分（assessBasePart 返回的 { usable: false }，或者补全结果里 rejected 的一项），为什么不能用，写成一句话，位置在前。
 * @param {{ location: string, reason: string }} rejection
 */
export function describeRejection(rejection) {
  const text = Object.hasOwn(REASON_TEXT, rejection.reason) ? REASON_TEXT[rejection.reason](rejection) : rejection.reason;
  return `${rejection.location}：${text}`;
}

/**
 * 一份基础部分能不能用：官方版本、协议主版本和角色部分要的一样、版本不低于最低版本。只看四个文件（基础部分的清单和签名、里面协议核心的清单和签名），
 * 不重算别的文件的哈希。清单里写的版本和协议版本，验过签才拿来比：没验过签的清单，写的什么都不信。
 * @param {{ location: string, manifest?: Uint8Array | null, signature?: Uint8Array | null, coreManifest?: Uint8Array | null, coreSignature?: Uint8Array | null }} candidate
 *   location 是给人看的位置；其余是字节，没有的是 null 或不写
 * @param {{ protocolMajor: number, baseMin: string }} requires 角色部分清单里的 requires
 * @param {Function} verifySignature official.mjs 的 createSignatureVerifier(信任名单) 造的验签钩子
 * @returns {Promise<{ usable: true, location: string, version: string, protocol: string, keyId: string } | { usable: false, location: string, reason: string }>}
 *   不能用时 reason 是下面这些，并带上细节：
 *     manifest_missing        没有基础部分的清单
 *     manifest_invalid        清单读不懂或不合格。code 是 manifest.mjs 的 code
 *     not_base_part           清单不是基础部分的。actual 是它自己说的种类
 *     not_official            不是官方版本：没有签名、对不上、不是名单里的公钥签的。code 是验签的 code，part 是 '' （基础部分）或 'protocol'（协议核心）
 *     protocol_core_missing   没有协议核心的清单
 *     protocol_incompatible   协议主版本不一样。required、actual 是两个主版本
 *     too_old                 版本比最低版本低。required、actual 是两个版本号
 * @throws {TypeError} candidate、verifySignature 的类型不对（调用方写错了，不是基础部分不好）
 */
export async function assessBasePart(candidate, requires, verifySignature) {
  if (candidate === null || typeof candidate !== 'object' || typeof candidate.location !== 'string') throw new TypeError('candidate 要是 { location, manifest, signature, coreManifest, coreSignature }，location 是字符串');
  if (typeof verifySignature !== 'function') throw new TypeError('verifySignature 要是函数（official.mjs 的 createSignatureVerifier 造的）');
  const { location } = candidate;
  const no = (reason, extra = {}) => ({ usable: false, location, reason, ...extra });

  if (!isBytes(candidate.manifest)) return no('manifest_missing');
  const read = readManifest(candidate.manifest);
  if (read.manifest === null || read.problems.length > 0) return no('manifest_invalid', { code: read.problems[0].code });
  const manifest = read.manifest;
  if (manifest.part !== 'base') return no('not_base_part', { actual: manifest.part });

  // 基础部分在包里的目录叫什么，跟它自己的协议版本走（names.mjs 的表）；这里只是验签报错里写的位置
  const baseDirectory = baseDirectoryOf(manifest.protocol);
  const baseVerdict = await verifySignature({ kind: 'base', part: baseDirectory, manifest: candidate.manifest, signature: candidate.signature ?? null });
  if (!baseVerdict.ok) return no('not_official', { code: baseVerdict.code, part: '' });
  if (!isBytes(candidate.coreManifest)) return no('protocol_core_missing');
  const coreVerdict = await verifySignature({ kind: 'protocol', part: `${baseDirectory}/${PROTOCOL_DIRECTORY}`, manifest: candidate.coreManifest, signature: candidate.coreSignature ?? null });
  if (!coreVerdict.ok) return no('not_official', { code: coreVerdict.code, part: 'protocol' });

  const major = protocolMajor(manifest.protocol);
  if (major !== requires.protocolMajor) return no('protocol_incompatible', { required: requires.protocolMajor, actual: major });
  if (compareSemver(manifest.version, requires.baseMin) < 0) return no('too_old', { required: requires.baseMin, actual: manifest.version });
  return { usable: true, location, version: manifest.version, protocol: manifest.protocol, keyId: baseVerdict.keyId };
}

/**
 * 包里自己的基础部分（目录叫什么跟角色部分的协议版本走，names.mjs 的表）当作一份要评估的基础部分：从角色部分的文件集里取那四个文件。
 * @param {Map<string, Uint8Array>} roleFiles
 * @param {string} protocol 角色部分自己的协议版本（「主.次」）
 */
export function inPackCandidate(roleFiles, protocol) {
  const directory = baseDirectoryOf(protocol);
  const get = (path) => roleFiles.get(`${directory}/${path}`) ?? null;
  return {
    location: `${directory}/`,
    manifest: get(MANIFEST_FILE),
    signature: get(SIGNATURE_FILE),
    coreManifest: get(`${PROTOCOL_DIRECTORY}/${MANIFEST_FILE}`),
    coreSignature: get(`${PROTOCOL_DIRECTORY}/${SIGNATURE_FILE}`),
  };
}

// ---------------------------------------------------------------- 挑版本

// 语义化版本的 ^最低版本（npm 文档「Caret Ranges」）：>=最低版本，并且小于下面这个上界（带 -0，连上界的预发布版也排除在外）。
//   ^1.2.3 → <2.0.0-0    ^0.2.3 → <0.3.0-0    ^0.0.3 → <0.0.4-0
function caretUpperBound(min) {
  const { major, minor, patch } = parseSemver(min);
  if (major > 0) return `${major + 1}.0.0-0`;
  if (minor > 0) return `0.${minor + 1}.0-0`;
  return `0.0.${patch + 1}-0`;
}

/** 一个版本为什么不能选：below_minimum、outside_range、prerelease、protocol_incompatible；能选是 null。 */
function exclusionOf(item, { baseMin, protocolMajor: wantedMajor }) {
  if (compareSemver(item.version, baseMin) < 0) return 'below_minimum';
  if (compareSemver(item.version, caretUpperBound(baseMin)) >= 0) return 'outside_range';
  const version = parseSemver(item.version);
  if (version.prerelease.length > 0) {
    // 预发布版只在最低版本自己就是同一个 主.次.修订 的预发布版时才候选（npm 对 ^ 的做法）：不会悄悄用上一个没发布完的版本
    const min = parseSemver(baseMin);
    const sameTriple = min.prerelease.length > 0 && version.major === min.major && version.minor === min.minor && version.patch === min.patch;
    if (!sameTriple) return 'prerelease';
  }
  if (parseProtocolVersion(item.protocol).major !== wantedMajor) return 'protocol_incompatible';
  return null;
}

/**
 * 在版本索引里挑一个版本：同一个主版本里、不低于最低版本、协议主版本对得上的最高版本（语义化版本的 ^最低版本）。理由见 protocol/FORMAT.md「补全」。
 * 协议主版本看索引里这一项的 protocol，不用下载就能挑；索引里的次序不重要（按版本号比，不按排的位置）。
 * @param {{ versions: { version: string, protocol: string }[] }} index parseVersionIndex 读出来的索引（releases.mjs；读索引要先验签，见 release-fetch.mjs 的 readVersionIndex）
 * @param {{ protocolMajor: number, baseMin: string }} requires 角色部分清单里的 requires
 * @returns {{ entry: object | null, considered: { version: string, protocol: string, excluded: string | null }[] }}
 *   entry 是索引里挑中的那一项（没有符合的是 null）；considered 是索引里每个版本和它没被选的原因：
 *   below_minimum（比最低版本低）、outside_range（不在 ^最低版本 的范围里，例如换了主版本）、prerelease、protocol_incompatible；能选的是 null
 * @throws {VoicePackError} invalid_version（最低版本、索引里的版本号不是语义化版本号）
 */
export function selectBaseVersion(index, requires) {
  const considered = index.versions.map((item) => ({ version: item.version, protocol: item.protocol, excluded: exclusionOf(item, requires) }));
  let entry = null;
  index.versions.forEach((item, i) => {
    if (considered[i].excluded === null && (entry === null || compareSemver(item.version, entry.version) > 0)) entry = item;
  });
  return { entry, considered };
}
