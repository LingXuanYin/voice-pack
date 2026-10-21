// SPDX-License-Identifier: Apache-2.0
//
// 解包上限：成员数量、单个大小、总大小、JSON 大小。读 zip、检查一个目录里的文件，都用这一份。
//
// 数值以上游 VoiceStudio 的安全解包为起点（64 个成员，单个 256 MiB，总共 512 MiB，JSON 1 MiB），
// 只把成员数放宽：上游的 64 是单个音色文件的量；完整包里有基础部分（含协议核心）的全部文件，再加上角色部分的参考集、
// 留出录音和脚本，一个重的完整包也只有几百个文件，所以定 1024（余量约 4 倍；每个成员的检查是 O(1)，上限不会拖慢拒绝）。
// 数值的含义见 protocol/FORMAT.md「解包上限」。
//
// 超限的说法（谁超了就点名谁，details 里有 limit 和实际值）只在这个文件里写一份：
//   too_many_members   成员数超过 maxMembers
//   member_too_large   某个成员超过 maxMemberBytes，details.path 是它
//   total_too_large    全部成员加起来超过 maxTotalBytes
//   json_too_large     某个要当 JSON 解析的成员超过 maxJsonBytes，details.path 是它
// 每一种有一个造问题的函数（memberCountProblem、memberSizeProblem、totalSizeProblem、jsonSizeProblem，返回 { code, message, details }），
// 用法有两种，同一件事不管走哪一种，说法一字不差：
//   抛错   读 zip（zip-structure.mjs）、写 zip（zip-write.mjs）：assertMemberCount、assertMemberSize、assertTotalSize，超了就抛
//   报告   检查一个文件集（check.mjs）、读清单（manifest.mjs 的 readManifest，只有 json_too_large）、命令行读目录（cli/disk.mjs）：放进 problems，不抛
// 命令行读目录读到超限就停，数的是读到哪里为止，所以成员数和总大小传 atLeast: true，文字写「至少」，不假装这就是全部。
// 说的不是这件事的不在这里：外部资源清单里写的大小超限（check.mjs，点名的是外部资源，写的是清单里的数）、zip 文件本身太大（zip-read.mjs，
// limit 是读它的上限，不是 maxTotalBytes），这两处另写，说法和 details 也不同。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  maxMembers: 1024,
  maxMemberBytes: 256 * MIB,
  maxTotalBytes: 512 * MIB,
  maxJsonBytes: 1 * MIB,
});

/**
 * 把调用方给的上限（可以只给其中几项）补成完整的一份。给的值必须是正整数。
 * @param {Partial<typeof DEFAULT_LIMITS>} [partial]
 */
export function resolveLimits(partial = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (!(key in DEFAULT_LIMITS)) throw new TypeError(`不认识的上限 ${key}（有：${Object.keys(DEFAULT_LIMITS).join('、')}）`);
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`上限 ${key} 必须是正整数，收到 ${JSON.stringify(value)}`);
    limits[key] = value;
  }
  return limits;
}

/** 成员数超过 maxMembers。 */
export const memberCountProblem = (count, limits, { atLeast = false } = {}) => ({
  code: 'too_many_members',
  message: `成员太多：${atLeast ? '至少 ' : ''}${count} 个，上限 ${limits.maxMembers} 个`,
  details: { count, limit: limits.maxMembers },
});

/** 某个成员超过 maxMemberBytes。 */
export const memberSizeProblem = (path, size, limits) => ({
  code: 'member_too_large',
  message: `成员 ${path} 太大：${size} 字节，单个上限 ${limits.maxMemberBytes} 字节`,
  details: { path, size, limit: limits.maxMemberBytes },
});

/** 全部成员加起来超过 maxTotalBytes。 */
export const totalSizeProblem = (total, limits, { atLeast = false } = {}) => ({
  code: 'total_too_large',
  message: `全部成员加起来太大：${atLeast ? '至少 ' : ''}${total} 字节，总上限 ${limits.maxTotalBytes} 字节`,
  details: { total, limit: limits.maxTotalBytes },
});

/** 某个要当 JSON 解析的成员超过 maxJsonBytes。 */
export const jsonSizeProblem = (path, size, limits) => ({
  code: 'json_too_large',
  message: `JSON 成员 ${path} 太大：${size} 字节，上限 ${limits.maxJsonBytes} 字节`,
  details: { path, size, limit: limits.maxJsonBytes },
});

const asError = ({ code, message, details }) => new VoicePackError(code, message, { details });

/** 成员数超限就抛 too_many_members。 */
export function assertMemberCount(count, limits) {
  if (count > limits.maxMembers) throw asError(memberCountProblem(count, limits));
}

/** 单个成员超限就抛 member_too_large。 */
export function assertMemberSize(path, size, limits) {
  if (size > limits.maxMemberBytes) throw asError(memberSizeProblem(path, size, limits));
}

/** 总大小超限就抛 total_too_large。 */
export function assertTotalSize(total, limits) {
  if (total > limits.maxTotalBytes) throw asError(totalSizeProblem(total, limits));
}
