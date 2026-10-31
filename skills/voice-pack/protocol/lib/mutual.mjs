// SPDX-License-Identifier: Apache-2.0
//
// 互相校验：一个角色部分和一个基础部分放进同一个环境，两边对得上吗。
// 纯函数，不碰文件系统和网络。什么时候做、结果怎么放进检查报告，是 check.mjs 的事（选项 mutual）。
//
// 查三件事：
//   1 协议主版本兼容    角色部分的 requires.protocolMajor 等于基础部分的协议主版本。次版本不管：同一个主版本内兼容（FORMAT.md「版本」）。
//   2 基础部分够新      基础部分的版本不低于角色部分的 requires.baseMin。按 semver 的次序比：预发布版低于对应的正式版，构建信息不参与。
//   3 所需能力都认得    角色部分每个功能要的所需能力，都在基础部分的能力词表（vocab/capabilities.json）里。
//                       词表读不懂的时候，说词表的问题，不把每项能力都报成缺。
// 校验里还有「内容：至少有一段参考音频和对应的文本」，它不在这里：这是角色部分的清单自己的规则
// （schema 的 minItems / minLength，加语义规则 text_blank，见 manifest.mjs），清单检查已经报了；这里再查一遍，同一条规则就报了两次。
// 「完整性」（文件和清单里的哈希一致）也不在这里，是 check.mjs 对每个部分各自做的。
//
// 问题和 check.mjs 的其余问题同一个形状 { code, message, part, details }，次序固定：协议、版本、词表或能力。
//   protocol_incompatible          协议主版本对不上。part 是 ''（角色部分的要求）。
//                                  details: { path, pointer: '/requires/protocolMajor', required, actual, basePath, baseProtocol }
//   base_too_old                   基础部分比角色部分要求的最低版本低。part 是 ''。
//                                  details: { path, pointer: '/requires/baseMin', required, actual, basePath }
//   capability_unknown             某项所需能力不在基础部分的词表里；每项缺的能力报一次，要它的功能都列上。part 是 ''。
//                                  details: { path, capability, features, vocabulary }
//   capability_vocabulary_invalid  基础部分的能力词表读不懂。part 是基础部分的目录名（跟角色部分的协议版本走，names.mjs）。details: { path, reason }，reason：
//                                  missing（清单里没列，包里也没有）、too_large（超过 JSON 的大小上限）、not_json（不是 UTF-8 的 JSON，或带了字节序标记）、
//                                  invalid_shape（顶层不是对象，或者 capabilities 不是「能力名 -> 说明」的对象）
//                                  词表文件在清单里列了、却缺了或被改过（file_missing、file_modified，check.mjs 已经报）：那份内容没有清单担保，
//                                  不拿它核对所需能力，也不再报第二遍（check.mjs 把 vocabularyReported 告诉这里）。
// path 是整个包里的完整路径（角色部分在根上，基础部分在它的目录名下，names.mjs 的表）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { compareSemver, protocolMajor } from './version.mjs';
import { MANIFEST_FILE } from './manifest.mjs';
import { baseDirectoryOf } from './names.mjs';

/** 基础部分里的能力词表：相对基础部分的目录。 */
export const CAPABILITY_VOCABULARY_FILE = 'vocab/capabilities.json';

const ROLE_MANIFEST_PATH = MANIFEST_FILE;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // ignoreBOM: 保留 BOM，让它按语法错误报出来
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 读基础部分的能力词表，取出能力名。
 * @param {Uint8Array | undefined} bytes vocab/capabilities.json 的字节；包里没有这个文件就是 undefined
 * @param {number} maxJsonBytes JSON 的大小上限
 * @returns {{ names: Set<string> } | { reason: 'missing' | 'too_large' | 'not_json' | 'invalid_shape' }}
 */
function readNames(bytes, maxJsonBytes) {
  if (bytes === undefined) return { reason: 'missing' };
  if (bytes.length > maxJsonBytes) return { reason: 'too_large' };
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { reason: 'not_json' };
  }
  if (!isObject(value) || !isObject(value.capabilities)) return { reason: 'invalid_shape' };
  return { names: new Set(Object.keys(value.capabilities)) };
}

/**
 * 角色部分和基础部分互相校验。两份清单都要是读懂了的（结构合格）；读不懂的部分由清单检查报，这里不会被调用。
 * @param {object} role 角色部分的清单
 * @param {object} base 基础部分的清单
 * @param {Uint8Array | undefined} vocabulary 基础部分里 vocab/capabilities.json 的字节，没有就是 undefined
 * @param {{ maxJsonBytes: number, vocabularyReported?: boolean }} options
 *   vocabularyReported：词表文件已经因为缺了或被改过（file_missing、file_modified）报过问题。
 *   那份内容没有清单担保，不拿它核对所需能力，也不再报第二遍
 * @returns {{ code: string, message: string, part: string, details: object }[]}
 */
export function mutualProblems(role, base, vocabulary, options) {
  // 基础部分放在角色部分里的哪个目录，跟角色部分自己的协议版本走（names.mjs 的表）
  const BASE_DIRECTORY = baseDirectoryOf(role.protocol);
  const BASE_MANIFEST_PATH = `${BASE_DIRECTORY}/${MANIFEST_FILE}`;
  const VOCABULARY_PATH = `${BASE_DIRECTORY}/${CAPABILITY_VOCABULARY_FILE}`;
  const out = [];
  const add = (code, message, part, details) => out.push({ code, message, part, details });

  const requiredMajor = role.requires.protocolMajor;
  const baseMajor = protocolMajor(base.protocol);
  if (requiredMajor !== baseMajor) {
    add('protocol_incompatible', `角色部分要求基础部分的协议主版本是 ${requiredMajor}，${BASE_MANIFEST_PATH} 按协议 ${base.protocol} 写（主版本 ${baseMajor}）：不兼容`, '', {
      path: ROLE_MANIFEST_PATH, pointer: '/requires/protocolMajor', required: requiredMajor, actual: baseMajor, basePath: BASE_MANIFEST_PATH, baseProtocol: base.protocol,
    });
  }

  if (compareSemver(base.version, role.requires.baseMin) < 0) {
    add('base_too_old', `角色部分要求基础部分不低于 ${role.requires.baseMin}，${BASE_MANIFEST_PATH} 是 ${base.version}：太旧了`, '', {
      path: ROLE_MANIFEST_PATH, pointer: '/requires/baseMin', required: role.requires.baseMin, actual: base.version, basePath: BASE_MANIFEST_PATH,
    });
  }

  if (options.vocabularyReported === true) return out;
  const read = readNames(vocabulary, options.maxJsonBytes);
  if (read.names === undefined) {
    add('capability_vocabulary_invalid', `基础部分的能力词表 ${VOCABULARY_PATH} 读不懂（${read.reason}）：没法核对角色部分要的所需能力`, BASE_DIRECTORY, { path: VOCABULARY_PATH, reason: read.reason });
    return out;
  }

  const wantedBy = new Map(); // 缺的能力 -> 要它的功能（按清单里第一次出现的次序）
  for (const [feature, entry] of Object.entries(role.features)) {
    for (const capability of entry.capabilities) {
      if (read.names.has(capability)) continue;
      const features = wantedBy.get(capability);
      if (features === undefined) wantedBy.set(capability, [feature]);
      else if (!features.includes(feature)) features.push(feature);
    }
  }
  for (const [capability, features] of wantedBy) {
    add('capability_unknown', `功能 ${features.join('、')} 要所需能力 ${capability}，基础部分的能力词表（${VOCABULARY_PATH}）里没有它`, '', {
      path: ROLE_MANIFEST_PATH, capability, features, vocabulary: VOCABULARY_PATH,
    });
  }
  return out;
}
