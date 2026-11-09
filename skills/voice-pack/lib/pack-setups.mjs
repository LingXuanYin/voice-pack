// SPDX-License-Identifier: Apache-2.0
//
// 原地保存、删除一个包当前版本的设定（setups）：不出新版本。make-pack --previous 改设定必出新版本（版本号往上加、变更说明、重新量验证记录）；
// 作者只是存了一套预设、删了一套预设，不该为此多出一个版本。这里的两个函数只改当前这一个目录里的两个文件，别的一概不动。
//
//   saveSetup(files, setup)     保存一套设定：同名就覆盖（整套换掉，旧设定里的字段不继承，包括 default），没有同名的就接在最后。
//   deleteSetup(files, name)    删一套设定；名字不存在报 setup_not_found。
//   files                       角色部分的文件集 Map<路径, Uint8Array>（protocol/lib/fileset.mjs），路径相对包目录；带着 protocol/、voice-pack/ 也行
//   setup                       { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }，字段同 make-pack 的 --setups 的每一项（写法见 protocol/FORMAT.md 4.4）
//   返回 { changed, report }    changed 是 Map<路径, Uint8Array>：要写盘的文件，最多两个，SKILL.md 在 manifest.json 前面（写盘的次序）；没有字节上的变化就是空的。
//                               report 是 { status: 'added' | 'replaced' | 'deleted', name, setups }：setups 是改完的整份（没有了是空数组），拷贝，改它不影响这里。
//   不改传进来的 files。库不碰文件系统，写盘是命令行层的事（cli/commands/setups.mjs）。
//
// 规则（只在这里写一遍）：
//   1 只改角色部分（part: role），协议主版本要和这一版库一样（3.x）：别的部分报 pack_not_role，旧协议的包报 pack_protocol_old（同 lib/voice-pack.mjs）。
//   2 动手前先查这个包本身是完好的（protocol/lib/check.mjs 的 selfCheckPart：文件对清单、清单合规、SKILL.md、音频）：不好就拒绝，原样抛它的第一个问题的 code，
//     details.problems 是全部问题，什么都不写。用 selfCheckPart、不是 checkPart：这里不放进、不安装任何部分，不动带签名的 protocol/、voice-pack/，只读它们来对清单，
//     验签是放进环境、配音那些入口的事。外部资源不联网核对（库不直接联网，这里也不动外部资源）：因为离线报的 external_unverifiable 不算包不完好，别的外部资源问题照报。
//   3 保存 default: true 的设定，别的设定的 default: true 去掉（键去掉，一个包最多一套）；保存时没写 default，同名的旧设定带 default: true 的，照新给的，不继承。
//     删到一套不剩：清单里没有 setups 这个字段（同 protocol/lib/pack.mjs：空数组不写）。删掉默认的那一套，包就没有默认设定，不自动指定别的。
//   4 改完把整份清单交给 validateManifest（重名、两套默认、referenceTag 不在参考集、speed、expressiveness 越界……多出来的键也由它管），不合格报 pack_setup_invalid，
//     details.problems 是它的问题清单；这一套设定合成的开头的提示太长（lib/make-pack-input.mjs 的 checkSetupOpeningCues，配音用到它会报 dub_input_invalid）也是同一个 code，
//     problems 里是 setup_opening_cue_too_long。只查给的这一套，包里原来就有的别的设定不重新查。
//   5 新值和旧值一模一样（键的次序不算）：照常成功，status 照旧（保存是 replaced），changed 是空的，不写盘，也不重新生成别的。
//   6 version、changelog、madeWith、requires、验证记录和其他文件都不动。清单按 protocol/lib/seal.mjs 的 sealPart 重新生成（规范次序，files 重新算），
//     清单旁边的签名文件（manifest.json.minisig，角色部分本来不验）原样留着，它对不上新清单；要签名就再签一次。
//   7 改完对新的文件集再跑一遍 selfCheckPart，不过报 pack_setup_invalid（details.problems 是检查的问题），不交出 changed。
//
// SKILL.md（清单 files 里列着它的 size 和 sha256，所以它变了清单要跟着变）：骨架里取决于设定的只有一句——这个包里有没有设定写了 referenceTag
//   （protocol/lib/skill-md.mjs 的 playSteps，不点名标签时用哪段）。保存、删除以后这一句可能变，所以要重新生成：
//   做法：用库现在的 buildRoleSkillMd，按旧清单、按新清单各生成一份骨架，配音指引用 extractGuidance 从现有的 SKILL.md 读回来，语言（zh、en）试出来：
//   哪一种语言按旧清单生成的骨架和现有的 SKILL.md 逐字节相等，就是原来的语言。
//   核实过（make-pack 做出来的包，中文、英文，有指引、没指引，指引里有 CRLF，设定写不写 referenceTag）：什么都不改、按旧清单重新生成，逐字节等于原来的 SKILL.md。
//   所以这是常态：逐字节相等，就换成按新清单生成的整份（和 make-pack 现做的一字不差），字节没变就不进 changed。
//   不相等的有两类：指引的开头有空行或缩进（extractGuidance 去掉开头的空行，读回来再生成就少了它们）；SKILL.md 是别的版本的库生成的，或者作者手改过。
//   这时不重写整份，免得一次保存把 SKILL.md 改得面目全非：只处理那一句。不照抄库里的句子（抄了以后库改了字，这里悄悄错）：按两种语言各生成旧、新两份骨架，
//   逐行比，不一样的行就是变了的那一句；这一行的旧写法在现有的 SKILL.md 里恰好出现一次，才换成新写法，出现零次（别的版本的写法）或多次（拿不准是哪一处），SKILL.md 原样留着。
//   旧清单和新清单生成的骨架一样（这一句没变），SKILL.md 一概不碰。
//
// 同一个目录两个进程同时改不处理：每个进程读到的是自己开始时的样子，后写的盖掉先写的（命令行层的写盘是原子的，不会写出半个文件，但不加锁）。
//
// 抛出的错误（VoicePackError；code 小写下划线）：
//   pack_setup_invalid   设定或改完的清单过不了：details: { problems, name? }。problems 是清单检查的问题清单（validateManifest 的），
//                        或 setup_opening_cue_too_long 的一项（details: { pointer, name, words, limit }），或改完再检查时 selfCheckPart 的问题；设定本身不是对象也是它
//   setup_not_found      deleteSetup 要删的名字不存在。details: { name, names }：names 是现有的设定的名字
//   pack_not_role        清单不是角色部分的。details.part 是它自己说的种类
//   pack_protocol_old    包按协议 1.x、2.x 写。details.protocol 是清单写的协议版本
//   包本身不完好：原样抛 selfCheckPart 的第一个问题的 code（manifest_missing、manifest_invalid、file_missing、file_modified、file_extra、skill_md_invalid……），details.problems 是全部问题
// 另外 TypeError：files 不是 Map<路径, Uint8Array>（调用方的代码用错了）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { assertFileSet } from '../protocol/lib/fileset.mjs';
import { MANIFEST_FILE, readManifest, validateManifest } from '../protocol/lib/manifest.mjs';
import { protocolMajorOf } from '../protocol/lib/names.mjs';
import { PROTOCOL_VERSION } from '../protocol/lib/version.mjs';
import { sealPart } from '../protocol/lib/seal.mjs';
import { selfCheckPart } from '../protocol/lib/check.mjs';
import { buildRoleSkillMd, extractGuidance, TEXT_LANGUAGES } from '../protocol/lib/skill-md.mjs';
import { checkSetupOpeningCues } from './make-pack-input.mjs';

const SKILL_FILE = 'SKILL.md';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 键排好序的 JSON：两份设定是不是一样（键的次序不算，数组的次序算）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const sentenceCount = (problems) => (problems.length === 1 ? '' : `（共 ${problems.length} 处问题）`);
const invalid = (message, problems, details = {}) => new VoicePackError('pack_setup_invalid', message, { details: { ...details, problems } });

// ---------------------------------------------------------------- 动手前、改完以后的检查

/** 文件集的检查问题（规则 2）：离线报的 external_unverifiable 不算。 */
async function checkProblems(files) {
  const report = await selfCheckPart(files, { env: { capabilities: {} } });
  return report.problems.filter((found) => !(found.code === 'external_unverifiable' && found.details?.reason === 'offline'));
}

/** 动手前：是角色部分、协议是这一版库的主版本、包本身完好；返回读出来的清单。 */
async function openRolePack(files) {
  assertFileSet(files);
  const bytes = files.get(MANIFEST_FILE);
  const read = bytes === undefined ? null : readManifest(bytes);
  if (read?.manifest && read.manifest.part !== 'role') {
    throw new VoicePackError('pack_not_role', `${MANIFEST_FILE} 说这是 ${read.manifest.part}：设定在角色部分（一个声音的参考集）的清单里，只能改角色部分`, { details: { part: read.manifest.part } });
  }
  const problems = await checkProblems(files);
  if (problems.length > 0) {
    const [first] = problems;
    throw new VoicePackError(first.code, `${first.message}${sentenceCount(problems)}`, { details: { ...first.details, problems } });
  }
  const { manifest } = readManifest(files.get(MANIFEST_FILE));
  if (protocolMajorOf(manifest.protocol) !== protocolMajorOf(PROTOCOL_VERSION)) {
    throw new VoicePackError('pack_protocol_old', `这个包按协议 ${manifest.protocol} 写：设定（和它指向的音色基底标签）是协议 ${PROTOCOL_VERSION.split('.')[0]}.x 的格式，旧包不原地改。用新的素材做一个新包`, { details: { protocol: manifest.protocol } });
  }
  return manifest;
}

// ---------------------------------------------------------------- SKILL.md

/** 一份骨架里按行比，旧写法的行在 text 里恰好出现一次才换成新写法；任何一行换不了就整个放弃（null）。 */
function patchChangedLines(text, before, after) {
  const was = before.split('\n');
  const now = after.split('\n');
  if (was.length !== now.length) return null;
  const lines = text.split('\n');
  for (let at = 0; at < was.length; at++) {
    if (was[at] === now[at]) continue;
    // 现有的 SKILL.md 可能是 CRLF（骨架是 LF）：比的时候不看行尾的 \r，换的时候留着这一行自己的
    const hits = lines.flatMap((line, index) => (line.replace(/\r$/u, '') === was[at] ? [index] : []));
    if (hits.length !== 1) return null;
    lines[hits[0]] = now[at] + (lines[hits[0]].endsWith('\r') ? '\r' : '');
  }
  return lines.join('\n');
}

/**
 * 按新清单更新 SKILL.md（文件头「SKILL.md」）。返回新的字节，不需要改（或者不能安全地改）返回 null。
 * @param {Uint8Array} current 现有的 SKILL.md
 */
function renewedSkillMd(current, oldManifest, newManifest) {
  let text;
  try {
    text = decoder.decode(current);
  } catch {
    return null; // 不是 UTF-8：检查已经报过，不往下碰
  }
  const guidance = extractGuidance(text) ?? undefined;
  const skeletons = TEXT_LANGUAGES.map((textLanguage) => ({
    before: buildRoleSkillMd(oldManifest, { guidance, textLanguage }),
    after: buildRoleSkillMd(newManifest, { guidance, textLanguage }),
  }));
  if (skeletons.every(({ before, after }) => before === after)) return null; // 骨架里取决于设定的那一句没变
  const whole = skeletons.find(({ before }) => before === text);
  if (whole !== undefined) return encoder.encode(whole.after); // 常态：整份是库按旧清单生成的，换成按新清单生成的整份
  for (const { before, after } of skeletons) {
    const patched = patchChangedLines(text, before, after);
    if (patched !== null && patched !== text) return encoder.encode(patched);
  }
  return null;
}

// ---------------------------------------------------------------- 落定

const tooDeep = () => invalid('设定嵌套得太深，写不出来', [{ code: 'manifest_invalid', message: '设定嵌套得太深，写不出来', details: { reason: 'too_deep' } }]);

/** 设定的 JSON 拷贝（交进来的对象不会被改，交出去的也和内部无关）。 */
function copyOf(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    if (error instanceof RangeError) throw tooDeep();
    throw error;
  }
}

/** 两份设定数组是不是一样（键的次序不算）。 */
function sameSetups(a, b) {
  try {
    return canonical(a) === canonical(b);
  } catch (error) {
    if (error instanceof RangeError) throw tooDeep();
    throw error;
  }
}

/** 新的设定数组算好以后：校验、更新 SKILL.md、重新生成清单、再检查，返回 { changed, report }。 */
async function settle(files, manifest, next, status, name) {
  const setups = copyOf(next);
  const report = { status, name, setups };
  if (sameSetups(manifest.setups ?? [], setups)) return { changed: new Map(), report }; // 规则 5

  const { files: _listed, setups: _old, ...fields } = manifest;
  void _listed;
  void _old;
  const nextFields = setups.length === 0 ? fields : { ...fields, setups };
  const { problems } = validateManifest({ ...nextFields, files: manifest.files });
  if (problems.length > 0) throw invalid(`设定过不了清单检查：${problems[0].message}${sentenceCount(problems)}`, problems, typeof name === 'string' ? { name } : {});
  if (status !== 'deleted') {
    const at = setups.findIndex((setup) => setup.name === name);
    try {
      checkSetupOpeningCues([setups[at]]);
    } catch (error) {
      if (!(error instanceof VoicePackError)) throw error;
      const { words, limit } = error.details;
      const message = `设定 ${JSON.stringify(name)} 合成的开头的提示数出来 ${words} 个词，超过上限 ${limit} 个词。配音时它写在每个请求的开头，要短：把这套设定的情绪、风格改短（references/make-pack.md「几套设定」）`;
      throw invalid(message, [{ code: 'setup_opening_cue_too_long', message, details: { pointer: `/setups/${at}`, name, words, limit } }], { name });
    }
  }

  const skill = renewedSkillMd(files.get(SKILL_FILE), manifest, { ...nextFields, files: manifest.files });
  const base = new Map(files);
  if (skill !== null) base.set(SKILL_FILE, skill);
  const sealed = await sealPart(base, nextFields);

  const changed = new Map();
  if (skill !== null && !sameBytes(skill, files.get(SKILL_FILE))) changed.set(SKILL_FILE, skill);
  if (!sameBytes(sealed.get(MANIFEST_FILE), files.get(MANIFEST_FILE))) changed.set(MANIFEST_FILE, sealed.get(MANIFEST_FILE));

  const after = await checkProblems(new Map([...files, ...changed]));
  if (after.length > 0) throw invalid(`改完的包过不了检查，什么都没写：${after[0].message}${sentenceCount(after)}`, after, typeof name === 'string' ? { name } : {});
  return { changed, report };
}

// ---------------------------------------------------------------- 入口

/**
 * 保存一套设定（规则见文件头）。
 * @param {Map<string, Uint8Array>} files 角色部分的文件集
 * @param {object} setup { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }
 * @returns {Promise<{ changed: Map<string, Uint8Array>, report: { status: 'added' | 'replaced', name: string, setups: object[] } }>}
 * @throws {VoicePackError} pack_setup_invalid、pack_not_role、pack_protocol_old，或包本身不完好的 code（文件头）
 */
export async function saveSetup(files, setup) {
  const manifest = await openRolePack(files);
  if (!isObject(setup)) throw invalid('一套设定要是一个对象 { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }', [{ code: 'manifest_invalid', message: `设定要是一个对象，收到 ${setup === null ? 'null' : Array.isArray(setup) ? '数组' : typeof setup}`, details: { pointer: '/setups/0', keyword: 'type' } }]);
  const given = copyOf(setup);
  const old = manifest.setups ?? [];
  const at = typeof given.name === 'string' ? old.findIndex((one) => one.name === given.name) : -1;
  const others = old.map((one) => {
    if (given.default !== true || one.default !== true) return one;
    const { default: _dropped, ...rest } = one;
    void _dropped;
    return rest;
  });
  const next = at === -1 ? [...others, given] : others.map((one, index) => (index === at ? given : one));
  return settle(files, manifest, next, at === -1 ? 'added' : 'replaced', given.name);
}

/**
 * 删一套设定（规则见文件头）。
 * @param {Map<string, Uint8Array>} files 角色部分的文件集
 * @param {string} name 要删的设定的名字（逐字比）
 * @returns {Promise<{ changed: Map<string, Uint8Array>, report: { status: 'deleted', name: string, setups: object[] } }>}
 * @throws {VoicePackError} setup_not_found、pack_setup_invalid、pack_not_role、pack_protocol_old，或包本身不完好的 code（文件头）
 */
export async function deleteSetup(files, name) {
  const manifest = await openRolePack(files);
  const old = manifest.setups ?? [];
  if (!old.some((one) => one.name === name)) {
    const names = old.map((one) => one.name);
    throw new VoicePackError('setup_not_found', `包里没有叫 ${JSON.stringify(name)} 的设定${names.length === 0 ? '（这个包一套设定都没有）' : `（现有：${names.map((one) => JSON.stringify(one)).join('、')}）`}`, { details: { name, names } });
  }
  return settle(files, manifest, old.filter((one) => one.name !== name), 'deleted', name);
}
