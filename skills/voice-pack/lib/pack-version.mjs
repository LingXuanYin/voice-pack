// SPDX-License-Identifier: Apache-2.0
//
// 发新版本（流程层）：同一个包补素材、换参考、改指引以后，发一个新版本：
//   - 包 ID 不变，版本号往上加；
//   - 带变更说明；
//   - 验证记录跟着更新；
//   - 包里记下做包时用的基础部分版本，不记来源包。
// lib/make-pack.mjs 的 makePack 在 input.previous（上一版的角色部分文件）给了的时候调这里的函数；这里的函数自己都不调所需能力。
//
//   readPreviousVersion(env, files)            读上一版：清单、每一段参考和留出录音的音频（和清单核对过）、配音指引、要跟着走的其他文件
//   nextVersion(previousVersion, { version, bump })    新版本号：明说的必须比上一版大，不然按 bump（major、minor、patch，默认 minor）往上加
//   diffVersions(previous, next)               比较两版，列出变了什么（也用来判断「什么都没变」）
//   changelogOf(changes, { name })             作者没写变更说明时，按变化生成一份（中文，不超过清单允许的长度 CHANGELOG_MAX）。调用方想换写法（比如按界面语言写），
//                                              给 makePack 的 options.describeChanges（lib/make-pack.mjs 的文件头）：它收到的 changes 就是 diffVersions 的结果，不给就用这个
//   fitChangelog(text)                         把一句变更说明裁到 CHANGELOG_MAX 个字符：超了截断，末尾加「…」。changelogOf 和 options.describeChanges 的返回值都过它
//   CHANGELOG_MAX                              变更说明的长度上限（字符数）：读自清单 schema（lib/manifest-limits.mjs）；做包检查作者给的变更说明用同一个数
//   effectiveOf(input, direction, previous)    这一版生效的描述（名字、配音指引、音色描述和标签、示例台词、设计来源、脚本、增强件、功能声明、对基础部分的要求、其他文件）：
//                                              这次给了就用这次的，没给就沿用上一版的（规则见下面「上一版的东西怎么跟到新版本里」）；第一个版本就是输入本身
//   assertSomethingNew(previous, { effective, items, fresh, defaultSegment })   花钱之前先看一眼：新补的素材一段都用不上、别的也没改，就不发新版本（抛 make_pack_nothing_changed）
//   releaseChanges(previous, { effective, chosen, fresh, changelog, describeChanges })   挑完素材以后：这一版比上一版变了什么（什么都没变同样不发），
//                                              和写进清单的变更说明（作者写的优先；没写就用 describeChanges，再不给就用 changelogOf）；返回 { changes, changelog }
//
// 上一版的东西怎么跟到新版本里（规则只在这里写一遍）：
//   参考、留出录音   保持原来的角色，不因为多了素材就从参考变成留出录音（那样前后两版的验证记录就没法比），也不反过来；次序不变，新补的接在后面
//   配音指引、音色描述和标签、示例台词、设计来源、脚本、增强件、读音词表等其他文件   给了新的就换掉上一版的，没给就沿用（SKILL.md 按新清单重新生成，配音指引放进去）；示例台词给空数组就是去掉
//   对基础部分的最低要求（requires）、所需能力（features）   沿用，除非明说；不因为这次用了新版本的基础部分就抬高最低要求
//   验证记录         不带过来：上一版的记录量的是上一版的参考集和指引，对这一版不算数。这一版量了就是新的一条，没量就没有（makePack 的报告说明）
//   protocol/、voice-pack/   不跟着走，用这次给的协议核心和基础部分
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_invalid     输入不合约定，或 describeChanges 返回的不是一句话。details: { field, problem }（和 lib/make-pack-input.mjs 同一个 code，同一种写法）
//   make_pack_version_invalid   明说的版本号不比上一版大。details: { previous, version }
//   make_pack_nothing_changed   发新版本，却和上一版比什么都没变（新补的素材没一段用得上、别的也没改）。details: { previous, unused }：unused 是新补的素材没用上的原因 -> 段数
//   make_pack_previous_invalid  上一版读不了。details.reason：manifest_missing 没有清单、manifest_invalid 清单读不懂（cause 里是原因）、
//                               not_role_part 清单是别的部分的（details.part）、audio_unrecognized 上一版的一段音频认不出格式（details.id）
//   另外 file_modified、file_missing、external_* 来自 lib/voice-pack.mjs（openVoicePack 的 verify: true）：上一版的文件和它自己的清单对不上，不在被改过的东西上发新版本。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { parseManifest, MANIFEST_FILE, SIGNATURE_FILE, isManagedPath } from '../protocol/lib/manifest.mjs';
import { isSemver, parseSemver, compareSemver } from '../protocol/lib/version.mjs';
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { sha256Hex } from '../protocol/lib/hash.mjs';
import { openVoicePack, MIME_OF_FORMAT } from './voice-pack.mjs';
import { LONG_TEXT_MAX } from './manifest-limits.mjs';

const SKILL_FILE = 'SKILL.md';
export const BUMPS = Object.freeze(['major', 'minor', 'patch']);
/** 清单里变更说明的长度上限：就是清单 schema 里 changelog（longText）的上限（lib/manifest-limits.mjs）。 */
export const CHANGELOG_MAX = LONG_TEXT_MAX;
/** 变更说明里最多点几个名字，多的写「等 N 段」。 */
const LISTED_IDS = 5;

const invalid = (field, problem) => new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${field}）：${problem}`, { details: { field, problem } });
const previousInvalid = (reason, message, details = {}, cause) => new VoicePackError('make_pack_previous_invalid', message, { details: { reason, ...details }, ...(cause === undefined ? {} : { cause }) });

// ---------------------------------------------------------------- 读上一版

/**
 * 读上一版的角色部分。
 * @param {object} env 注入的运行环境：上一版有外部资源时，用它的 fetch 取回来核对
 * @param {Map<string, Uint8Array>} files 上一版角色部分的文件集（路径相对角色部分的目录；带着 protocol/、voice-pack/ 也行，不用）
 * @returns {Promise<{ manifest: object, id: string, version: string, name: string, guidance: string | null,
 *   segments: { id: string, role: 'reference' | 'holdout', audio: { bytes: Uint8Array, mimeType: string }, format: string, path: string, text: string, tags: object, externalUrl: string | null }[],
 *   carried: Map<string, Uint8Array> }>} segments 是先参考后留出录音，各按清单里的次序；carried 是要跟着走的其他文件
 */
export async function readPreviousVersion(env, files) {
  if (!(files instanceof Map)) throw invalid('previous', '必须是上一版角色部分的文件集 Map<路径, Uint8Array>');
  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw previousInvalid('manifest_missing', `上一版没有 ${MANIFEST_FILE}：给的不是一个音色包的角色部分`);
  let manifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (cause) {
    throw previousInvalid('manifest_invalid', `上一版的清单读不懂：${cause?.message ?? cause}`, { code: cause?.code }, cause);
  }
  if (manifest.part !== 'role') throw previousInvalid('not_role_part', `上一版的清单说这是 ${manifest.part}，发新版本要的是角色部分`, { part: manifest.part });

  const pack = await openVoicePack(files, { env, verify: true }); // 上一版是外面递进来的，没有「进入环境」那一步：读到的文件都和它自己的清单核对
  const externals = new Map((manifest.externals ?? []).map((entry) => [entry.path, entry.url]));
  const entries = [...manifest.reference.segments.map((entry) => ({ entry, role: 'reference' })), ...(manifest.holdout ?? []).map((entry) => ({ entry, role: 'holdout' }))];
  const segments = [];
  const audioPaths = new Set();
  for (const { entry, role } of entries) {
    const bytes = await pack.read(entry.audio); // 和清单核对过：被改过、缺了、外部资源对不上都在这里报
    const sniffed = sniffAudio(bytes);
    if (sniffed === null) throw previousInvalid('audio_unrecognized', `上一版的 ${entry.audio} 认不出是什么音频`, { id: entry.id, path: entry.audio });
    audioPaths.add(entry.audio);
    segments.push({ id: entry.id, role, audio: { bytes, mimeType: MIME_OF_FORMAT[sniffed.format] }, format: sniffed.format, path: entry.audio, text: entry.text, tags: entry.tags, externalUrl: externals.get(entry.audio) ?? null });
  }
  const carried = new Map();
  for (const [path, data] of files) {
    if (path === MANIFEST_FILE || path === SIGNATURE_FILE || path === SKILL_FILE || !isManagedPath(path, 'role') || audioPaths.has(path)) continue;
    carried.set(path, data);
  }
  return { manifest, id: manifest.id, version: manifest.version, name: manifest.name, guidance: await pack.guidance(), segments, carried };
}

// ---------------------------------------------------------------- 版本号

/**
 * 新版本号。明说的（version）必须是语义化版本号、并且比上一版大；没明说就按 bump 往上加：
 * patch 加修订号；minor（默认）加次版本号、修订号归零；major 加主版本号、次版本号和修订号归零。上一版的预发布和构建信息不带过来。
 * @throws {VoicePackError} make_pack_input_invalid（version 不是语义化版本号，bump 不是 major、minor、patch）、make_pack_version_invalid
 */
export function nextVersion(previousVersion, { version, bump } = {}) {
  if (version !== undefined) {
    if (!isSemver(version)) throw invalid('version', `必须是语义化版本号（例如 1.2.0），收到 ${JSON.stringify(version)}`);
    if (compareSemver(version, previousVersion) <= 0) {
      throw new VoicePackError('make_pack_version_invalid', `新版本号 ${version} 要比上一版 ${previousVersion} 大`, { details: { previous: previousVersion, version } });
    }
    return version;
  }
  const kind = bump ?? 'minor';
  if (!BUMPS.includes(kind)) throw invalid('bump', `必须是 ${BUMPS.join('、')} 之一，收到 ${JSON.stringify(bump)}`);
  const { major, minor, patch } = parseSemver(previousVersion);
  return kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

// ---------------------------------------------------------------- 变了什么

/** 键排好序的 JSON：比较两个对象是不是一样。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** 没有、空数组都算「没写」：脚本给了空数组和没给脚本是一回事。 */
const blank = (value) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
const same = (a, b) => (blank(a) && blank(b)) || canonical(a ?? null) === canonical(b ?? null);

/** 其他文件（不含段的音频）哪些变了：新增、删掉、内容不一样。 */
async function changedFiles(before, after) {
  const changed = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path);
    const b = after.get(path);
    if (a === undefined || b === undefined || (await sha256Hex(a)) !== (await sha256Hex(b))) changed.push(path);
  }
  return changed.sort();
}

/**
 * 比较两版，列出变了什么。previous、next 都是这个形状：
 *   { name, referenceIds, holdoutIds, defaultSegment, guidance, direction, sampleLines, designSource, scripts, enhancers, features, requires, files }
 *   files 是其他文件（Map，不含段的音频、SKILL.md、清单）；referenceIds、holdoutIds 是段的名字（按清单里的次序）
 * @returns {Promise<{ added: string[], addedReferences: string[], addedHoldouts: string[], dropped: string[], defaultChanged: boolean,
 *   guidanceChanged: boolean, directionChanged: boolean, sampleLinesChanged: boolean, designSourceChanged: boolean, scriptsChanged: boolean, enhancersChanged: boolean,
 *   requirementsChanged: boolean, filesChanged: string[], nameChanged: boolean, empty: boolean }>} empty 为真就是什么都没变
 */
export async function diffVersions(previous, next) {
  const before = new Set([...previous.referenceIds, ...previous.holdoutIds]);
  const after = new Set([...next.referenceIds, ...next.holdoutIds]);
  const addedReferences = next.referenceIds.filter((id) => !before.has(id));
  const addedHoldouts = next.holdoutIds.filter((id) => !before.has(id));
  const changes = {
    added: [...addedReferences, ...addedHoldouts],
    addedReferences,
    addedHoldouts,
    dropped: [...before].filter((id) => !after.has(id)),
    defaultChanged: previous.defaultSegment !== next.defaultSegment,
    guidanceChanged: (previous.guidance ?? '').trim() !== (next.guidance ?? '').trim(),
    directionChanged: !same(previous.direction, next.direction),
    sampleLinesChanged: !same(previous.sampleLines, next.sampleLines),
    designSourceChanged: !same(previous.designSource, next.designSource),
    scriptsChanged: !same(previous.scripts, next.scripts),
    enhancersChanged: !same(previous.enhancers, next.enhancers),
    requirementsChanged: !same(previous.requires, next.requires) || !same(previous.features, next.features),
    filesChanged: await changedFiles(previous.files, next.files),
    nameChanged: previous.name !== next.name,
  };
  const { added, addedReferences: _r, addedHoldouts: _h, dropped, filesChanged, ...flags } = changes;
  void _r;
  void _h;
  return { ...changes, empty: added.length === 0 && dropped.length === 0 && filesChanged.length === 0 && !Object.values(flags).some(Boolean) };
}

const listIds = (ids) => (ids.length <= LISTED_IDS ? ids.join('、') : `${ids.slice(0, LISTED_IDS).join('、')} 等`);

/** 把一句变更说明裁到清单允许的长度：超过 CHANGELOG_MAX 个字符的截断，末尾加「…」。changelogOf 的结果和调用方的 describeChanges 的返回值都过这里。 */
export function fitChangelog(text) {
  const chars = [...text];
  return chars.length <= CHANGELOG_MAX ? text : `${chars.slice(0, CHANGELOG_MAX - 1).join('')}…`;
}

/** 按变化生成一份变更说明（中文）。作者自己写的说明永远优先，这份只在作者没写的时候用；调用方想换写法（比如按界面语言写）就给 makePack 的 options.describeChanges。 */
export function changelogOf(changes, { name } = {}) {
  const parts = [];
  if (changes.addedReferences.length > 0) parts.push(`新增参考 ${changes.addedReferences.length} 段（${listIds(changes.addedReferences)}）`);
  if (changes.addedHoldouts.length > 0) parts.push(`新增留出录音 ${changes.addedHoldouts.length} 条（${listIds(changes.addedHoldouts)}）`);
  if (changes.dropped.length > 0) parts.push(`去掉 ${changes.dropped.length} 段（${listIds(changes.dropped)}）`);
  if (changes.defaultChanged) parts.push('换了默认参考段');
  if (changes.guidanceChanged) parts.push('更新了配音指引');
  if (changes.directionChanged) parts.push('更新了音色描述和标签');
  if (changes.sampleLinesChanged) parts.push('更新了示例台词');
  if (changes.designSourceChanged) parts.push('更新了设计来源');
  if (changes.scriptsChanged) parts.push('更新了脚本');
  if (changes.enhancersChanged) parts.push('更新了增强件');
  if (changes.requirementsChanged) parts.push('更新了功能声明和对基础部分的要求');
  if (changes.filesChanged.length > 0) parts.push(`更新了文件 ${listIds(changes.filesChanged)}`);
  if (changes.nameChanged && name !== undefined) parts.push(`名字改成「${name}」`);
  return fitChangelog(`${parts.join('；')}。`);
}

// ---------------------------------------------------------------- 做包（lib/make-pack.mjs）发新版本时用的

/** 这次生效的描述：这次给了就用这次的，没给就沿用上一版的（规则见 lib/pack-version.mjs 的文件头）。第一个版本就是输入本身。 */
export function effectiveOf(input, direction, previous) {
  const old = previous === null ? {} : previous.manifest;
  return {
    name: input.name === undefined ? previous.name : input.name.trim(),
    guidance: input.guidance ?? previous?.guidance ?? undefined,
    direction: direction ?? old.direction,
    sampleLines: input.sampleLines ?? old.sampleLines,
    designSource: input.designSource ?? old.designSource,
    scripts: input.scripts ?? old.scripts,
    enhancers: input.enhancers ?? old.enhancers,
    features: input.features ?? old.features,
    requires: input.requires === undefined ? old.requires : { ...old.requires, ...input.requires },
    files: new Map([...(previous === null ? [] : previous.carried), ...(input.files ?? [])]),
  };
}

/** diffVersions 要的形状：上一版。 */
const previousShape = (previous) => ({
  name: previous.name,
  referenceIds: previous.segments.filter((segment) => segment.role === 'reference').map((segment) => segment.id),
  holdoutIds: previous.segments.filter((segment) => segment.role === 'holdout').map((segment) => segment.id),
  defaultSegment: previous.manifest.reference.defaultSegment,
  guidance: previous.guidance,
  direction: previous.manifest.direction,
  sampleLines: previous.manifest.sampleLines,
  designSource: previous.manifest.designSource,
  scripts: previous.manifest.scripts,
  enhancers: previous.manifest.enhancers,
  features: previous.manifest.features,
  requires: previous.manifest.requires,
  files: previous.carried,
});

/** 发新版本却什么都没变：不发空的新版本。新补的素材都没用上的话，原因跟着写出来。 */
function nothingChanged(previous, fresh) {
  const unused = {};
  for (const item of fresh) if (item.unused !== undefined) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
  const why = Object.keys(unused).length === 0 ? '' : `；新补的素材一段都没用上：${Object.entries(unused).map(([reason, count]) => `${reason} ${count} 段`).join('、')}`;
  return new VoicePackError('make_pack_nothing_changed', `和上一版（${previous.version}）比什么都没变，不发新版本${why}`, { details: { previous: previous.version, unused } });
}

/**
 * 作者没写变更说明时，按这次的变化生成一份：默认用 lib/pack-version.mjs 的 changelogOf（中文），调用方给了 options.describeChanges 就用它（规矩见文件头）。
 * 写进清单的必须是 1–CHANGELOG_MAX 个字符：空的、不是字符串的是调用方的函数写错了，抛 make_pack_input_invalid；太长的截断（长短看数据，不算写错，库自己写的也是这样）。
 */
async function generatedChangelog(describe, changes, name) {
  const text = await describe(changes, { name });
  if (typeof text !== 'string' || text.trim() === '') {
    throw invalid('describeChanges', `必须返回一句变更说明（不是空白的字符串），收到 ${typeof text === 'string' ? '空白' : text === null ? 'null' : typeof text}`);
  }
  return fitChangelog(text.trim());
}

/**
 * 发新版本，花钱之前先看一眼：新补的素材（fresh）一段都用不上、别的也没改，就不用往下做了。
 * @param {object} previous readPreviousVersion 读出来的上一版
 * @param {{ effective: object, items: object[], fresh: object[], defaultSegment: string | undefined }} now effective 是这次生效的描述（effectiveOf），items 是筛过的全部条目，
 *   fresh 是其中新补的，defaultSegment 是作者明说换的默认参考段
 * @throws {VoicePackError} make_pack_nothing_changed
 */
export async function assertSomethingNew(previous, { effective, items, fresh, defaultSegment }) {
  const carried = items.filter((item) => item.previous !== undefined);
  const early = await diffVersions(previousShape(previous), {
    ...effective,
    referenceIds: [...carried.filter((item) => item.previous === 'reference'), ...fresh.filter((item) => item.unused === undefined)].map((item) => item.id),
    holdoutIds: carried.filter((item) => item.previous === 'holdout').map((item) => item.id),
    defaultSegment: defaultSegment ?? previous.manifest.reference.defaultSegment,
  });
  if (early.empty) throw nothingChanged(previous, fresh);
}

/**
 * 挑完素材以后：这一版比上一版变了什么（什么都没变就不发），和写进清单的变更说明（作者写的；没写就按变化生成：调用方给了 describeChanges 用它，不给用 changelogOf）。
 * 第一个版本（previous 是 null）没有「变了什么」：changes 是 null，变更说明是作者写的，没写就是 undefined。
 * @returns {Promise<{ changes: object | null, changelog: string | undefined }>} changes 是 diffVersions 的结果
 * @throws {VoicePackError} make_pack_nothing_changed、make_pack_input_invalid（describeChanges 返回的不是一句话）
 */
export async function releaseChanges(previous, { effective, chosen, fresh, changelog, describeChanges }) {
  const changes = previous === null ? null : await diffVersions(previousShape(previous), { ...effective, referenceIds: chosen.references, holdoutIds: chosen.holdouts, defaultSegment: chosen.defaultSegment });
  if (changes?.empty) throw nothingChanged(previous, fresh);
  return { changes, changelog: changelog ?? (changes === null ? undefined : await generatedChangelog(describeChanges ?? changelogOf, changes, effective.name)) };
}
