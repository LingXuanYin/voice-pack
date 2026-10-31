// SPDX-License-Identifier: Apache-2.0
//
// 版本号：
//   - 协议版本用「主.次」两段（例如 "1.0"）。同一个主版本内兼容，次版本只加不删：读 1.3 的清单，1.0 的程序照常读，不认识的字段忽略。
//   - 基础部分、协议核心、角色部分各自用语义化版本号（semver.org 2.0.0）：主.次.修订，可带 -预发布 和 +构建信息。
//
// PROTOCOL_VERSION 是这一版库写的协议版本：新做的包、新打的分享文件、新发布的版本都按它写（名字也跟它走，names.mjs）。清单里的 protocol 字段写的是清单按哪一版协议写的。
// 读的范围比写的宽：1.x 和 2.x 的都读（names.mjs 的 READABLE_PROTOCOL_MAJORS）。
//
// 错误：
//   invalid_version   不是合法的版本号。details: { version }
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

export const PROTOCOL_VERSION = '2.0';

// semver.org 给的正则（第 2 版）：数字不能有前导零，预发布里的数字标识也不能有前导零，标识只用 [0-9A-Za-z-]
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PROTOCOL_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NUMERIC = /^\d+$/;

const invalid = (version, what) => new VoicePackError('invalid_version', `不是合法的${what}：${JSON.stringify(version)}`, { details: { version: typeof version === 'string' ? version : String(version) } });

/**
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], build: string[] }}
 * @throws {VoicePackError} invalid_version
 */
export function parseSemver(text) {
  const m = typeof text === 'string' ? SEMVER_RE.exec(text) : null;
  if (!m) throw invalid(text, '语义化版本号（主.次.修订，例如 1.2.3）');
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [], build: m[5] ? m[5].split('.') : [] };
}

export const isSemver = (text) => typeof text === 'string' && SEMVER_RE.test(text);

/**
 * 按 semver.org 第 11 条比较优先级，构建信息不参与。
 * @returns {-1 | 0 | 1}
 * @throws {VoicePackError} invalid_version
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    if (x.prerelease.length === y.prerelease.length) return 0;
    return x.prerelease.length === 0 ? 1 : -1; // 没有预发布的比有预发布的大
  }
  const n = Math.min(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === q) continue;
    const pNum = NUMERIC.test(p);
    const qNum = NUMERIC.test(q);
    if (pNum && qNum) return Number(p) < Number(q) ? -1 : 1;
    if (pNum !== qNum) return pNum ? -1 : 1; // 数字标识比字母标识小
    return p < q ? -1 : 1;
  }
  if (x.prerelease.length === y.prerelease.length) return 0;
  return x.prerelease.length < y.prerelease.length ? -1 : 1;
}

/**
 * @param {unknown} text 「主.次」
 * @returns {{ major: number, minor: number }}
 * @throws {VoicePackError} invalid_version
 */
export function parseProtocolVersion(text) {
  const m = typeof text === 'string' ? PROTOCOL_RE.exec(text) : null;
  if (!m) throw invalid(text, '协议版本（「主.次」两段，例如 1.0）');
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export const isProtocolVersion = (text) => typeof text === 'string' && PROTOCOL_RE.test(text);

/** 协议版本的主版本。 @throws {VoicePackError} invalid_version */
export const protocolMajor = (text) => parseProtocolVersion(text).major;
