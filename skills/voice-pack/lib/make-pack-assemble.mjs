// SPDX-License-Identifier: Apache-2.0
//
// 装包（流程层）：把挑好的素材和作者给的描述装成角色部分，用 protocol/lib/pack.mjs 的 packRolePart（它自带自检：清单合不合规、协议核心封没封印、基础部分对不对得上）。
// 包里的文件怎么摆（路径、外部资源只记网址）、packRolePart 的参数里和素材无关的那一半怎么拼，只在这里写一遍。
//
//   preflight(items, context)                          试装：用真实的输入和一段占位的参考走一遍 packRolePart，输入里不合清单规矩的地方（设计来源、脚本和增强件的登记、
//                                                      功能声明、没封印的协议核心、基础部分对不上……）在花钱之前就报，不等转写、打标签、试合成、盲听都做完了才在最后一步抛错
//   placeMaterial({ chosen, byId, effective })         给挑好的每一段定在包里的路径，返回 { reference, holdout, files, externals }：
//                                                      files 是要放进包里的文件（含 effective.files：读音词表、脚本……）；externals 是外部资源 [{ path, url, data }]，
//                                                      包里只记网址、大小和哈希，字节不放进 files
//   assembler({ context, changelog, material, idRandom })   返回 assemble(extra)：把素材做成包。第二次（带上验证记录）要沿用第一次的包 ID：assemble({ id, verification })
//   context 是 { effective, input, previous, versionNumber, changelog, textLanguage }：effective 是这次生效的描述（lib/pack-version.mjs 的 effectiveOf），
//   textLanguage 是 SKILL.md 骨架的语言（'zh' 或 'en'，makePack 的 options.textLanguage；试装和正式装都用它）。
//   发新版本沿用上一版的包 ID，上一版的段沿用原来的路径（item.path），新补的按 <角色>/<名字>.<扩展名>。
//
// 抛出的错误：
//   make_pack_input_invalid  两段音频、或一段音频和 files 里的文件落在同一个路径（field 是 segments 或 files）
//   pack_invalid、manifest_invalid 来自 protocol/lib/pack.mjs，原样往上抛
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { packRolePart } from '../protocol/lib/pack.mjs';
import { invalid } from './make-pack-input.mjs';

const FORMAT_EXTENSION = { wav: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', m4a: 'm4a' };

/** 一段做进清单的样子（标签的次序固定）。 */
const manifestTags = (tags) => Object.fromEntries(['language', 'emotion', 'style', 'energy'].filter((key) => tags[key] !== undefined).map((key) => [key, tags[key]]));

/** packRolePart 的参数里和素材无关的那一半（名字、版本、要求、描述、协议核心、SKILL.md 骨架的语言……）。试装和正式装用同一份，写法只此一处。 */
function roleInput({ effective, input, previous, versionNumber, changelog, textLanguage }) {
  return {
    name: effective.name,
    ...(previous !== null ? { id: previous.id } : input.shortName === undefined ? {} : { shortName: input.shortName }),
    ...(versionNumber === undefined ? {} : { version: versionNumber }),
    ...(changelog === undefined ? {} : { changelog }),
    ...(textLanguage === undefined ? {} : { textLanguage }), // SKILL.md 骨架的语言：作者的语言，调用方给的（options.textLanguage，readOptions 补全过）；不给是中文
    baseVersion: input.baseVersion,
    ...(effective.requires === undefined ? {} : { requires: effective.requires }),
    ...(effective.features === undefined ? {} : { features: effective.features }),
    ...(effective.direction === undefined ? {} : { direction: effective.direction }),
    ...(effective.sampleLines === undefined ? {} : { sampleLines: effective.sampleLines }),
    ...(effective.guidance === undefined ? {} : { guidance: effective.guidance }),
    ...(effective.designSource === undefined ? {} : { designSource: effective.designSource }),
    ...(effective.scripts === undefined ? {} : { scripts: effective.scripts }),
    ...(effective.enhancers === undefined ? {} : { enhancers: effective.enhancers }),
    protocolCore: input.protocolCore,
    ...(input.base === undefined ? {} : { base: input.base }),
  };
}

/**
 * 试装：用真实的输入和一段占位的参考走一遍 packRolePart（它自带自检），输入里不合清单规矩的地方（设计来源、脚本和增强件的登记、功能声明、
 * 没封印的协议核心、基础部分对不上……）在花钱之前就报，不等转写、打标签、试合成、盲听都做完了才在最后一步抛错。占位的包不用，也不写出去。
 * 占位的参考取第一段能用的片段；一段能用的都没有就不试（后面照样会报 make_pack_no_material）。
 * @returns {Promise<void>}
 */
export async function preflight(items, context) {
  const stub = items.find((item) => item.unused === undefined);
  if (stub === undefined) return;
  const path = `reference/${stub.id}.${FORMAT_EXTENSION[stub.format]}`;
  await packRolePart({
    ...roleInput(context),
    reference: { segments: [{ id: stub.id, audio: path, text: 'x', tags: { language: 'en' } }] },
    files: new Map([...context.effective.files, [path, stub.audio.bytes]]),
    random: (length) => new Uint8Array(length), // 占位的包 ID，不动调用方注入的 idRandom
  });
}

/** 给挑好的素材定路径：参考、留出录音放进 files（外部资源只记网址，字节留在 externals），再并上其他文件（effective.files）。 */
export function placeMaterial({ chosen, byId, effective }) {
  const files = new Map();
  const externals = [];
  const place = (item, role) => {
    const path = item.path ?? `${role}/${item.id}.${FORMAT_EXTENSION[item.format]}`; // 上一版的段沿用原来的路径
    if (files.has(path) || externals.some((entry) => entry.path === path)) throw invalid('segments', `${JSON.stringify(item.id)} 的音频文件 ${path} 和另一段的撞上了`);
    if (item.externalUrl === null) files.set(path, item.audio.bytes);
    else externals.push({ path, url: item.externalUrl, data: item.audio.bytes });
    return { id: item.id, audio: path, text: item.text, tags: manifestTags(item.tags) };
  };
  const reference = { defaultSegment: chosen.defaultSegment, segments: chosen.references.map((id) => place(byId.get(id), 'reference')) };
  const holdout = chosen.holdouts.map((id) => place(byId.get(id), 'holdout'));
  for (const [path, data] of effective.files) {
    if (files.has(path) || externals.some((entry) => entry.path === path)) throw invalid('files', `${path} 和一段的音频文件撞上了`);
    files.set(path, data);
  }
  return { reference, holdout, files, externals };
}

/** 把这些素材做成包。第二次（带上验证记录）要沿用第一次的包 ID。发新版本沿用上一版的包 ID。 */
export function assembler({ context, changelog, material, idRandom }) {
  const { reference, holdout, files, externals } = material;
  return (extra = {}) =>
    packRolePart({
      ...roleInput({ ...context, changelog }), // 变更说明：作者写的，或者按这次的变化生成的（试装时还没算出来，用作者写的）
      reference,
      ...(holdout.length > 0 ? { holdout } : {}),
      files,
      ...(externals.length > 0 ? { externals } : {}),
      ...(idRandom === undefined ? {} : { random: idRandom }),
      ...extra,
    });
}
