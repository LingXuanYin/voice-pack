// SPDX-License-Identifier: Apache-2.0
//
// 检查一个部分（角色部分、基础部分、协议核心）：清单对得上文件，嵌套的部分各自对得上，SKILL.md 合规，音频按内容判断，外部资源逐个取回来核对，
// 基础部分和协议核心验官方签名，角色部分和它带着的基础部分互相校验。
// 一个部分的文件是 Map<路径, Uint8Array>（路径相对这个部分的目录）。读 zip、读目录得到这份 Map 的事在别处（share.mjs、命令行层），这里不碰。
//
// 两种入口：
//   信任边界上的入口   处理从外面来的东西：checkPart（这里）、checkShareFile、inspectShareFile（share.mjs，先打开 zip 再调 checkPart）。
//                      调用方必须明确选验签的策略，不选就抛 signature_policy_missing，而且是在读任何输入之前（连文件集的形状都没看）：
//                      免得嵌入这个库的 app 的导入、补全、接收分享文件的服务端哪一处忘了传，悄悄把非官方的基础部分或协议核心放进来。
//                      互相校验在这些入口上默认打开，调用方可以明确写 mutual: false。
//   库内部的自检       selfCheckPart（这里）：检查自己正在做、正在封的部分，不验签、不做互相校验，不要策略。只有两处用它：
//                      做包时对正在做的角色部分的自检（pack.mjs 的 packRolePart），seal 命令对正在封的部分的检查（cli/commands/seal.mjs）。
//                      这两处检查的是自己刚做出来的东西：角色部分本来就不签名，基础部分和协议核心被封的时候还没有签名。
//                      处理从外面来的东西，不许用它。
// openShareFile（share.mjs）只读 zip 的容器，不查清单、哈希、签名，它交出来的文件是没验过的：要用就走上面的入口。
//                      只有 share.mjs 自己引用它。
//
// 报告：{ ok, problems, parts, signatures, mutual }。能查的都查，一次报全，不是见到第一个问题就停；只有「超过解包上限」先停：超限的包不去算哈希。
//   problems[]   { code, message, part, details }。part 说出问题的是哪个部分：'' 是传进来的这一个，
//                'protocol'、'<基础部分的目录名>'、'<基础部分的目录名>/protocol' 是嵌套的（目录名跟协议版本走，见 names.mjs）。details.path 是整个包里的完整路径。
//   parts[]      找到并读懂了清单的每个部分：{ part, kind, version, protocol, files, id（角色部分才有） }
//   signatures[] 每个部分的签名文件：{ part, file, present, verified, skipped?, keyId? }。verified 是 true / false / null：
//                true 验过了（keyId 是签名的钥匙）；false 验了没过（或者要求有签名而没有，或者有签名文件却没法验）；
//                null 没验，skipped 说明原因：role（角色部分不验）、unsigned（调用方选了 allowUnsigned，这个部分没有签名文件，放过了）；
//                selfCheckPart 不验签，只记有没有签名文件（verified 是 null，没有 skipped）
//   mutual       { checked, reason? }。做了：{ checked: true }，问题放进 problems；没做：checked 是 false，
//                reason 说明为什么：not_requested（调用方写了 mutual: false，或者是 selfCheckPart）、no_role（传进来的不是角色部分）、
//                no_base（角色部分里没有基础部分）、not_reached（有清单读不了，或者超了解包上限，检查没走到这一步）
//
// 问题的 code（点名是哪一种）：
//   manifest_missing        没有清单（manifest.json）。details: { path }
//   manifest_not_json / json_too_large / protocol_unsupported / manifest_invalid   清单读不了或不合格，见 manifest.mjs；details.path 是清单的路径
//   part_mismatch           清单是别的种类（位置或调用方说这是角色部分，清单自己说是基础部分）。details: { path, expected, actual }
//   part_missing            缺必须有的子部分（每个部分都要带着 protocol/）。details: { path: 缺的目录 }
//   file_missing            清单里列了、包里没有。details: { path }
//   file_extra              包里有、清单没列。details: { path }
//   file_modified           清单里列了、内容和清单对不上。details: { path, reason: 'size' | 'sha256', expected, actual }
//   path_unsafe / path_conflict   文件名不安全、重名或只差大小写，见 paths.mjs
//   too_many_members / member_too_large / total_too_large   超过解包上限，见 limits.mjs
//   skill_md_missing / skill_md_invalid   SKILL.md 缺了或不合规，见 skill-md.mjs。details.path 是 SKILL.md 的路径
//   audio_disguised / audio_format_not_allowed   音频的扩展名和内容对不上、不在允许的格式里，见 audio.mjs
//   external_unverifiable   外部资源无法核对：环境没有网络（reason: offline），或取的时候网络出错（reason: network）。details: { path, url, reason }
//   external_fetch_failed   服务器答了，但不是成功。details: { path, url, status }
//   external_hash_mismatch  取回来的和清单对不上。details: { path, url, reason: 'size' | 'sha256', expected, actual }
//   signature_hook_invalid  verifySignature 返回的不是 { ok } 的形状
//   signature_missing / signature_invalid / signature_untrusted_key 等   验签没过，见 official.mjs 和 signature.mjs。details.path 是签名文件的完整路径
//   signature_unverifiable  只选了 allowUnsigned、没给 verifySignature，而这个部分带着签名文件：没法验，不当成通过。details: { path }
//   protocol_incompatible / base_too_old / capability_unknown / capability_vocabulary_invalid   互相校验没过，见 mutual.mjs
//   protocol_name_mismatch  名字和协议版本对不上（names.mjs 的表）。details: { item, protocol, expected, actual, path }，item 说是哪一项：
//                           base_directory   角色部分里基础部分的目录名不是它的协议版本该用的（比如 2.0 的包里放了 1.x 的目录名，或 1.x 的包里放了 2.x 的），
//                                            或者嵌着的基础部分自己的协议版本对应的目录名和它所在的目录不一样。path 是那个目录。part 是 ''（前一种）或那个目录（后一种）
//                           media_type       分享文件的类型标识和包的协议版本对不上（share.mjs 报，这里列出来是为了和上一项放在一起）
// 抛出来的（不放进报告）：
//   signature_policy_missing  信任边界上的入口，verifySignature 和 allowUnsigned: true 两样都没给。details: { entry: 入口的名字 }
//
// 选项（信任边界上的入口；selfCheckPart 只收 part、limits、env，给了下面三个验签和互相校验的选项会抛 TypeError）：
//   part            传进来的这一个部分应该是什么种类（role / base / protocol）；省略就按清单自己说的
//   limits          解包上限，见 limits.mjs
//   env             注入的运行环境，用它的 fetch 核对外部资源。没有 env.fetch 就是离线：带外部资源的包校验不通过
//   verifySignature 验签的钩子：async ({ kind, part, manifest, signature, files }) => { ok: true, skipped?, keyId? } | { ok: false, code?, message?, details? }
//                   kind 是 role / base / protocol，part 是这个部分的位置（'' 或 'protocol' 之类），manifest 是清单的字节，
//                   signature 是签名文件的字节（没有是 null），files 是整个包的文件集。
//                   { ok: true } 记成验过（verified: true，keyId 一并记下）；{ ok: true, skipped: '原因' } 记成没验（verified 保持 null，原因记在 skipped）。
//                   官方版本的钩子由 official.mjs 的 createSignatureVerifier(信任名单) 造；它永远是严格的：没有签名文件的基础部分、协议核心一律 signature_missing。
//                   钩子抛 VoicePackError 会被转成问题，不会中断检查；抛别的错误照常抛出去。
//   allowUnsigned   true：基础部分、协议核心没有签名文件的，放过，报告里记 skipped: 'unsigned'，不去问钩子；有签名文件的照验，签得不对照样拒绝。
//                   本地开发和测试用，不是产品里该有的选择：用它放行的包不是官方版本。命令行的 --allow-unsigned 就是这个。
//   mutual          false 就不做互相校验；不写或 true 就在每个部分各自查完以后做（角色部分和它带着的基础部分对一对，规则和 code 见 mutual.mjs）。
//                   「至少有一段参考音频和对应的文本」不在互相校验里，是清单自己的规则（manifest.mjs），同一条规则只报一次。
//
// 验签的策略（verifySignature 和 allowUnsigned 的组合）：
//   verifySignature        allowUnsigned    怎么办
//   给了                   不写或 false     严格：基础部分和协议核心每个都要有官方签名，钩子说了算
//   给了                   true             验签，但放过没有签名文件的部分（命令行的 --allow-unsigned）
//   没给                   true             没有验签的办法：没有签名文件的部分放过，有签名文件的报 signature_unverifiable
//   没给                   不写或 false     抛 signature_policy_missing，什么都不读
//
// 外部资源是逐个、按清单里的次序取的；读到超过清单里写的大小就停，响应头声明的大小超了就不读。
// URL 不指向内网这类网络策略是注入的 env.fetch 的事；这里只认 https（清单的 schema 里就挡了）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { sha256Hex } from './hash.mjs';
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { assertFileSet, subtree } from './fileset.mjs';
import { resolveLimits, memberCountProblem, memberSizeProblem, totalSizeProblem } from './limits.mjs';
import { pathProblem, findPathConflict, compareUtf8 } from './paths.mjs';
import { readManifest, MANIFEST_FILE, SIGNATURE_FILE, PART_KINDS, childPartsOf, foreignBaseDirectory, isManagedPath } from './manifest.mjs';
import { baseDirectoryOf, KNOWN_BASE_DIRECTORIES } from './names.mjs';
import { audioProblem } from './audio.mjs';
import { skillMdProblems } from './skill-md.mjs';
import { mutualProblems, CAPABILITY_VOCABULARY_FILE } from './mutual.mjs';

const SKILL_FILE = 'SKILL.md';
const MAX_CONFLICTS = 20; // 重名的情况只列前面几个，免得一个恶意的包刷出海量的报告
const utf8 = new TextDecoder('utf-8', { fatal: true });

const join = (prefix, path) => (prefix === '' ? path : `${prefix}/${path}`);

/** 读 Response，最多读 maxBytes 个字节；超了给 { tooLarge: true, actual }，没超给 { bytes }。（releases.mjs 读已发布的文件也用它） */
export async function readCapped(response, maxBytes) {
  const encoding = response.headers?.get?.('content-encoding');
  const declared = encoding && encoding !== 'identity' ? Number.NaN : Number(response.headers?.get?.('content-length')); // 压缩过的，声明的是压缩后的大小，不能拿来比
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true, actual: declared };
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel?.(); return { tooLarge: true, actual: total }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return { bytes };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > maxBytes ? { tooLarge: true, actual: bytes.length } : { bytes };
}

/**
 * 检查没能做完的报告：不通过，问题是给出的这些，别的都没查到（读不了的分享文件、读不了的目录……）。
 * 在 checkPart 之外就失败的地方用它造报告，字段和 checkPart 的一样多。
 * @param {object[]} problems
 * @param {{ mutual?: boolean }} [options] 同 checkPart：要了互相校验才说「没做到」，没要就说「没要求」
 */
export function failedReport(problems, options = {}) {
  return { ok: false, problems, parts: [], signatures: [], mutual: { checked: false, reason: options.mutual === true ? 'not_reached' : 'not_requested' } };
}

/**
 * 信任边界上的入口（checkPart、checkShareFile、inspectShareFile）一进来就调它：验签的策略要明确选，不选就抛错，
 * 而且是在碰任何输入之前（连文件集的形状都没看）。返回整理好的选项（再传给 checkPart 也是合格的）。
 * @param {object} options 调用方给的选项
 * @param {string} entry 入口的名字，写进错误里
 * @returns {object} { ...options, allowUnsigned: 布尔, mutual: 布尔 }（mutual 没给就是 true）
 * @throws {VoicePackError} signature_policy_missing
 * @throws {TypeError} 选项的类型不对
 */
export function requireSignaturePolicy(options, entry) {
  if (options === null || typeof options !== 'object') throw new TypeError(`${entry} 的选项必须是对象`);
  const { verifySignature, allowUnsigned, mutual } = options;
  if (verifySignature !== undefined && typeof verifySignature !== 'function') throw new TypeError('verifySignature 必须是函数');
  if (allowUnsigned !== undefined && typeof allowUnsigned !== 'boolean') throw new TypeError(`allowUnsigned 必须是 true 或 false，收到 ${JSON.stringify(allowUnsigned)}`);
  if (mutual !== undefined && typeof mutual !== 'boolean') throw new TypeError(`mutual 必须是 true 或 false，收到 ${JSON.stringify(mutual)}`);
  if (verifySignature === undefined && allowUnsigned !== true) {
    throw new VoicePackError('signature_policy_missing', `${entry} 要明确选验签的策略，这次两样都没给：给 verifySignature（一般是 createSignatureVerifier(信任名单)：基础部分和协议核心不是官方签名的就拒绝），或者明确写 allowUnsigned: true（没有签名文件的部分放过、不验，有签名文件的照验：只给本地开发和测试用，产品里的入口不要这么写）。不选就不检查，免得哪一处忘了传，悄悄把非官方的基础部分或协议核心放进来。用法见 protocol/SIGNATURES.md 的「接进检查」`, { details: { entry } });
  }
  return { ...options, allowUnsigned: allowUnsigned === true, mutual: mutual !== false };
}

/**
 * 检查一个从外面来的部分（信任边界上的入口）：验签和互相校验是这个入口的一部分，调用方要明确选验签的策略，
 * 不选就抛 signature_policy_missing（在读文件集之前）。库内部检查自己刚封好的部分，用 selfCheckPart。
 * @param {Map<string, Uint8Array>} files
 * @param {{ part?: 'role' | 'base' | 'protocol', limits?: object, env?: object, verifySignature?: Function, allowUnsigned?: boolean, mutual?: boolean }} options
 * @returns {Promise<{ ok: boolean, problems: object[], parts: object[], signatures: object[], mutual: { checked: boolean, reason?: string } }>}
 */
export async function checkPart(files, options = {}) {
  return runCheck(files, requireSignaturePolicy(options, 'checkPart'), false);
}

/**
 * 库内部自检：检查自己正在做、正在封的部分（做包时对角色部分的自检，seal 对被封的部分的检查）。
 * 清单对文件、SKILL.md、音频、外部资源照查；不验签、不做互相校验：这些部分此时还没有签名（角色部分本来就不签），
 * 对得上哪个基础部分也不是做到这一步时该管的事。报告里 signatures 只记有没有签名文件，mutual 是 not_requested。
 * **只给库内部用**：处理从外面来的东西必须用 checkPart、checkShareFile、inspectShareFile，它们不让调用方跳过验签的选择。
 * 不收 verifySignature、allowUnsigned、mutual（给了抛 TypeError）。
 */
export async function selfCheckPart(files, options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('selfCheckPart 的选项必须是对象');
  for (const name of ['verifySignature', 'allowUnsigned', 'mutual']) {
    if (options[name] !== undefined) throw new TypeError(`selfCheckPart 不验签、不做互相校验，不收选项 ${name}：检查从外面来的东西用 checkPart`);
  }
  return runCheck(files, { ...options, allowUnsigned: false, mutual: false }, true);
}

async function runCheck(files, options, sealed) {
  assertFileSet(files);
  if (options.part !== undefined && !PART_KINDS.includes(options.part)) throw new TypeError(`part 要是 role、base、protocol 之一，收到 ${JSON.stringify(options.part)}`);
  const limits = resolveLimits(options.limits);
  const report = { ok: false, problems: [], parts: [], signatures: [], mutual: { checked: false, reason: options.mutual === true ? 'not_reached' : 'not_requested' } };
  const root = (code, message, details) => report.problems.push({ code, message, part: '', details });
  const names = [...files.keys()].sort(compareUtf8);

  // 先看解包上限：成员数、单个大小、总大小。超了就停，不去算哈希。问题的文字在 limits.mjs 里写一份
  const overLimit = ({ code, message, details }) => root(code, message, details);
  if (files.size > limits.maxMembers) overLimit(memberCountProblem(files.size, limits));
  else {
    let total = 0;
    for (const name of names) {
      const size = files.get(name).length;
      total += size;
      if (size > limits.maxMemberBytes) overLimit(memberSizeProblem(name, size, limits));
    }
    if (total > limits.maxTotalBytes) overLimit(totalSizeProblem(total, limits));
  }
  if (report.problems.length > 0) return report;

  // 文件名：每个都要安全，不能重名、不能只差大小写
  for (const name of names) {
    const found = pathProblem(name);
    if (found) root('path_unsafe', `文件名不能要（${found.message}）：${JSON.stringify(name)}`, { path: name, reason: found.reason });
  }
  let remaining = names;
  for (let n = 0; n < MAX_CONFLICTS; n++) {
    const conflict = findPathConflict(remaining);
    if (!conflict) break;
    root('path_conflict', `路径 ${JSON.stringify(conflict.path)} 和 ${JSON.stringify(conflict.other)} 冲突（${conflict.kind}）：解到磁盘上会互相覆盖`, { ...conflict });
    remaining = remaining.filter((name) => name !== conflict.path);
  }

  const ctx = { ...options, limits, report, whole: files, found: new Map(), sealed };
  await checkOne(files, '', options.part ?? null, ctx);
  if (options.mutual === true) report.mutual = runMutual(ctx);
  report.ok = report.problems.length === 0;
  return report;
}

/**
 * 互相校验：每个部分各自查完以后，角色部分和它带着的基础部分对一对（规则在 mutual.mjs）。
 * 要两份清单都读懂了才对得上；任何一份读不懂，清单检查已经报了，这里只说没做到。
 * @returns {{ checked: boolean, reason?: 'no_role' | 'no_base' | 'not_reached' }}
 */
function runMutual(ctx) {
  const root = ctx.found.get('');
  if (root === undefined) return { checked: false, reason: 'not_reached' };
  if (root.kind !== 'role') return { checked: false, reason: 'no_role' };
  const directory = baseDirectoryOf(root.manifest.protocol); // 基础部分的目录名跟角色部分的协议版本走
  const base = ctx.found.get(directory);
  if (base === undefined) {
    const present = [...ctx.whole.keys()].some((name) => name.startsWith(`${directory}/`));
    return { checked: false, reason: present ? 'not_reached' : 'no_base' };
  }
  const vocabularyPath = join(directory, CAPABILITY_VOCABULARY_FILE);
  const vocabularyReported = ctx.report.problems.some((p) => (p.code === 'file_missing' || p.code === 'file_modified') && p.details.path === vocabularyPath);
  ctx.report.problems.push(...mutualProblems(root.manifest, base.manifest, base.files.get(CAPABILITY_VOCABULARY_FILE), { maxJsonBytes: ctx.limits.maxJsonBytes, vocabularyReported }));
  return { checked: true };
}

async function checkOne(files, prefix, expectedKind, ctx) {
  const { report, limits } = ctx;
  const add = (code, message, details = {}) => report.problems.push({ code, message, part: prefix, details });
  const manifestPath = join(prefix, MANIFEST_FILE);

  let manifest = null;
  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes === undefined) {
    add('manifest_missing', `没有清单 ${manifestPath}`, { path: manifestPath });
  } else {
    const read = readManifest(manifestBytes, { limits });
    for (const p of read.problems) add(p.code, `${manifestPath}：${p.message}`, { ...p.details, path: manifestPath });
    manifest = read.manifest;
  }
  if (manifest !== null && expectedKind !== null && manifest.part !== expectedKind) {
    add('part_mismatch', `${manifestPath} 说这是 ${manifest.part}，这里应该是 ${expectedKind}`, { path: manifestPath, expected: expectedKind, actual: manifest.part });
    return;
  }
  const kind = manifest === null ? expectedKind : manifest.part;

  if (manifest !== null) {
    ctx.found.set(prefix, { kind, manifest, files }); // 互相校验要用：读懂了清单的部分
    report.parts.push({ part: prefix, kind, version: manifest.version, protocol: manifest.protocol, ...(kind === 'role' ? { id: manifest.id } : {}), files: manifest.files.length });

    // 清单对文件：缺了、多了、改过
    const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
    for (const entry of manifest.files) {
      const full = join(prefix, entry.path);
      const data = files.get(entry.path);
      if (data === undefined) { add('file_missing', `清单里列了 ${full}，包里没有`, { path: full }); continue; }
      if (data.length !== entry.size) { add('file_modified', `${full} 被改过：大小是 ${data.length} 字节，清单里记的是 ${entry.size} 字节`, { path: full, reason: 'size', expected: entry.size, actual: data.length }); continue; }
      const digest = await sha256Hex(data);
      if (digest !== entry.sha256) add('file_modified', `${full} 被改过：SHA-256 和清单里记的不一样`, { path: full, reason: 'sha256', expected: entry.sha256, actual: digest });
    }
    const present = [...files.keys()].filter((path) => isManagedPath(path, kind, manifest.protocol)).sort(compareUtf8);
    // 角色部分里放着另一套协议的基础部分目录（比如 2.0 的包里放了 1.x 的目录名，或 1.x 的包里放了 2.x 的）：它不是「多出来的文件」，是名字和协议版本对不上，
    // 点名这一条，不把里面的每个文件都报成 file_extra。清单自己列了的（角色部分自己的文件碰巧放在这样的目录里）不算。
    const foreign = kind === 'role' ? foreignBaseDirectory(files.keys(), manifest.protocol) : null;
    if (foreign !== null && !listed.has(`${foreign}/${MANIFEST_FILE}`)) {
      add('protocol_name_mismatch', `${join(prefix, foreign)}/ 是基础部分的目录名，但不是协议 ${manifest.protocol} 用的名字：这个协议里基础部分叫 ${baseDirectoryOf(manifest.protocol)}`, { item: 'base_directory', protocol: manifest.protocol, path: join(prefix, foreign), expected: baseDirectoryOf(manifest.protocol), actual: foreign });
    }
    const inForeign = (path) => foreign !== null && !listed.has(`${foreign}/${MANIFEST_FILE}`) && path.startsWith(`${foreign}/`);
    for (const path of present) if (!listed.has(path) && !inForeign(path)) add('file_extra', `包里多了一个清单没列的文件 ${join(prefix, path)}`, { path: join(prefix, path) });

    // SKILL.md：角色部分的 name 等于包 ID，基础部分的 name 等于它的协议版本对应的目录名（names.mjs 的表）
    if (kind === 'role' || kind === 'base') {
      const skillPath = join(prefix, SKILL_FILE);
      const skill = files.get(SKILL_FILE);
      if (skill === undefined) {
        if (!listed.has(SKILL_FILE)) add('skill_md_missing', `没有 ${skillPath}：每个音色包的部分都是一个标准的 Agent Skill 目录`, { path: skillPath });
      } else {
        let text = null;
        try { text = utf8.decode(skill); } catch { add('skill_md_invalid', `${skillPath} 不是合法的 UTF-8`, { path: skillPath, reason: 'utf8' }); }
        if (text !== null) for (const p of skillMdProblems(text, { expectedName: kind === 'role' ? manifest.id : baseDirectoryOf(manifest.protocol) })) add(p.code, p.message, { ...p.details, path: skillPath });
      }
    }

    // 音频：这个部分自己管的每个文件，按扩展名和内容对一对；清单里标明是音频的（参考段、留出录音）扩展名也必须是音频
    const designated = new Set(kind === 'role' ? [...manifest.reference.segments, ...(manifest.holdout ?? [])].map((s) => s.audio) : []);
    for (const path of present) {
      const found = audioProblem(path, files.get(path), { designated: designated.has(path) });
      if (found) add(found.code, found.message, { ...found.details, path: join(prefix, path) });
    }

    if (kind === 'role') await checkExternals(manifest.externals ?? [], designated, ctx, prefix, add);

    // 签名：记下这个部分有没有签名文件，再按调用方选的策略验（库内部的自检 selfCheckPart，也就是 ctx.sealed，不验）
    const signature = files.get(SIGNATURE_FILE);
    const entry = { part: prefix, file: join(prefix, SIGNATURE_FILE), present: signature !== undefined, verified: null };
    report.signatures.push(entry);
    if (!ctx.sealed) await checkSignature(ctx, { kind, part: prefix, manifest: manifestBytes, signature: signature ?? null, files: ctx.whole }, entry, add);
  }

  // 嵌套的基础部分：它所在的目录名要等于它自己的协议版本对应的名字（2.0 的角色部分里放了 1.x 的基础部分，目录叫 voice-pack：对不上）
  if (manifest !== null && kind === 'base' && prefix !== '') {
    const expected = baseDirectoryOf(manifest.protocol);
    const actual = prefix.slice(prefix.lastIndexOf('/') + 1);
    if (actual !== expected) add('protocol_name_mismatch', `${prefix}/ 里是按协议 ${manifest.protocol} 写的基础部分，这个协议里基础部分叫 ${expected}，目录却叫 ${actual}`, { item: 'base_directory', protocol: manifest.protocol, path: prefix, expected, actual });
  }

  // 嵌套的部分（清单读不了时，也按位置查它们：它们有自己的清单）
  if (kind === null) return;
  for (const child of childrenToCheck(kind, manifest, files)) {
    const sub = subtree(files, child.directory);
    if (sub.size === 0) {
      if (child.required) add('part_missing', `缺 ${join(prefix, child.directory)}/：每个部分都要带着协议核心`, { path: join(prefix, child.directory) });
      continue;
    }
    await checkOne(sub, join(prefix, child.directory), child.kind, ctx);
  }
}

/**
 * 这个部分要往下查的子部分。角色部分的基础部分目录名跟它自己的协议版本走；清单读不了的角色部分不知道协议版本，
 * 哪个认得的目录名下面有文件就查哪个（它们有自己的清单）。
 */
function childrenToCheck(kind, manifest, files) {
  if (kind !== 'role') return childPartsOf(kind);
  if (manifest !== null) return childPartsOf('role', manifest.protocol);
  const present = KNOWN_BASE_DIRECTORIES.filter((name) => subtree(files, name).size > 0);
  return [{ directory: 'protocol', kind: 'protocol', required: true }, ...present.map((directory) => ({ directory, kind: 'base', required: false }))];
}

/**
 * 按调用方选的策略验一个部分的签名（信任边界上的入口才走到这里）：
 *   allowUnsigned 且这个部分（基础部分、协议核心）没有签名文件   放过，记 skipped: 'unsigned'，不去问钩子
 *   给了 verifySignature                                       问钩子：角色部分、有签名文件的部分、没选 allowUnsigned 时没有签名文件的部分
 *   没给 verifySignature（只选了 allowUnsigned）               角色部分记 skipped: 'role'（角色部分本来就不验）；有签名文件的部分没法验，
 *                                                               报 signature_unverifiable，不当成通过
 */
async function checkSignature(ctx, call, entry, add) {
  const { kind, signature } = call;
  if (ctx.allowUnsigned && signature === null && kind !== 'role') { entry.skipped = 'unsigned'; return; }
  if (ctx.verifySignature) { await runSignatureHook(ctx.verifySignature, call, entry, add); return; }
  if (kind === 'role') { entry.skipped = 'role'; return; }
  entry.verified = false;
  add('signature_unverifiable', `${entry.file} 是一份签名文件，但这次检查没有验签的办法（只写了 allowUnsigned: true，没给 verifySignature）：没法验，不当成通过。要验就给 verifySignature（一般是 createSignatureVerifier(信任名单)）`, { path: entry.file });
}

async function runSignatureHook(hook, call, entry, add) {
  let result;
  try {
    result = await hook(call);
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    entry.verified = false;
    add(error.code, error.message, { ...error.details });
    return;
  }
  if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    entry.verified = false;
    add('signature_hook_invalid', 'verifySignature 要返回 { ok: true } 或 { ok: false, code, message }', {});
    return;
  }
  if (!result.ok) {
    entry.verified = false;
    add(typeof result.code === 'string' ? result.code : 'signature_invalid', result.message ?? '签名没有通过', { ...(result.details ?? {}) });
    return;
  }
  if (typeof result.skipped === 'string') { entry.skipped = result.skipped; return; } // 钩子说这个部分它没验（原因写在 skipped 里）：verified 保持 null
  entry.verified = true;
  if (typeof result.keyId === 'string') entry.keyId = result.keyId;
}

async function checkExternals(externals, designated, ctx, prefix, add) {
  const { limits } = ctx;
  const fetcher = ctx.env && typeof ctx.env.fetch === 'function' ? ctx.env.fetch : null;
  for (const entry of externals) {
    const path = join(prefix, entry.path);
    const base = { path, url: entry.url };
    if (entry.size > limits.maxMemberBytes) { add('member_too_large', `外部资源 ${path} 太大：清单里写的是 ${entry.size} 字节，单个上限 ${limits.maxMemberBytes} 字节`, { path, size: entry.size, limit: limits.maxMemberBytes }); continue; }
    if (fetcher === null) { add('external_unverifiable', `外部资源无法核对：运行环境没有网络（离线），${path} 没法从 ${entry.url} 取回来核对`, { ...base, reason: 'offline' }); continue; }
    let response;
    try {
      response = await fetcher(entry.url);
    } catch (error) {
      add('external_unverifiable', `外部资源无法核对：从 ${entry.url} 取 ${path} 时网络出错（${error?.message ?? error}）`, { ...base, reason: 'network' });
      continue;
    }
    if (!response || response.ok !== true) { add('external_fetch_failed', `外部资源 ${path} 取不到：${entry.url} 返回 ${response?.status ?? '没有响应'}`, { ...base, status: response?.status ?? null }); continue; }
    let read;
    try {
      read = await readCapped(response, entry.size);
    } catch (error) {
      add('external_unverifiable', `外部资源无法核对：读 ${entry.url} 的内容时出错（${error?.message ?? error}）`, { ...base, reason: 'network' });
      continue;
    }
    if (read.tooLarge || read.bytes.length !== entry.size) {
      const got = read.tooLarge ? read.actual : read.bytes.length;
      add('external_hash_mismatch', `外部资源 ${path} 和清单对不上：清单里写的是 ${entry.size} 字节，取回来的${read.tooLarge ? '超过了' : '是'} ${got} 字节`, { ...base, reason: 'size', expected: entry.size, actual: got });
      continue;
    }
    const digest = await sha256Hex(read.bytes);
    if (digest !== entry.sha256) { add('external_hash_mismatch', `外部资源 ${path} 和清单对不上：SHA-256 不一样`, { ...base, reason: 'sha256', expected: entry.sha256, actual: digest }); continue; }
    const found = audioProblem(entry.path, read.bytes, { designated: designated.has(entry.path) });
    if (found) add(found.code, found.message, { ...found.details, path });
  }
}
