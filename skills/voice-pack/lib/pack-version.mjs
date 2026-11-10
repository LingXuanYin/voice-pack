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
//   effectiveOf(input, direction, previous)    这一版生效的描述（名字、配音指引、音色描述和标签、示例台词、几套设定、设计来源、脚本、增强件、功能声明、对基础部分的要求、其他文件）：
//                                              这次给了就用这次的，没给就沿用上一版的（规则见下面「上一版的东西怎么跟到新版本里」，设计来源有一处例外）；第一个版本就是输入本身
//   carriesDesignSource(previousManifest, drop)   这次没给设计来源时，上一版的跟不跟过来（规则见下面「设计来源」）：命令行判 design_source_missing 也用它
//   versionNotes(previous, input)              发新版本留给报告的说明（report.notes）：现在只有 design_source_dropped（见下面「设计来源」）。第一个版本是空数组
//   assertSomethingNew(previous, { effective, items, fresh, defaultSegments, tags, cardLine })   花钱之前先看一眼：新补的素材一段都用不上、别的也没改，就不发新版本（抛 make_pack_nothing_changed）
//   withoutCardLine(previous, changes)、changelogFor(changes, { describeChanges, name })   这一版最后没有卡片试听那一句（要重配的没配成）：
//                                              照实改 changes，作者没写变更说明的重写一遍
//   releaseChanges(previous, { effective, chosen, fresh, changelog, describeChanges, tags, cardLine })   挑完素材以后：这一版比上一版变了什么（什么都没变同样不发），
//                                              和写进清单的变更说明（作者写的优先；没写就用 describeChanges，再不给就用 changelogOf）；返回 { changes, changelog }
//
// 上一版的东西怎么跟到新版本里（规则只在这里写一遍）：
//   卡片试听那一句   这次给了就重配；没给的，上一版有就原样沿用（规则在 lib/make-pack-card-line.mjs 的 carriedCardLine）。它的音频不跟着其他文件走；
//                    清单里记着的 seed（配它用的，protocol/FORMAT.md 4.4）跟着它走：沿用的照旧带着，用同样的请求重配时按它换一个（lib/make-pack-card-line.mjs 的 voiceCardLine）
//   参考、留出录音   保持原来的角色，不因为多了素材就从参考变成留出录音（那样前后两版的验证记录就没法比），也不反过来；次序不变，新补的接在后面
//   参考的音色基底标签   照旧，作者用 input.retag 改了名的换成新的（撞名的规矩在 lib/make-pack-tags.mjs）；改了名就算变了（changes.retagged），只改名也发得成新版本
//   配音指引、音色描述和标签、示例台词、几套设定（setups）、脚本、增强件、读音词表等其他文件   给了新的就换掉上一版的，没给就沿用（SKILL.md 按新清单重新生成，配音指引放进去）；示例台词、几套设定给空数组就是去掉
//   设计来源         给了新的就换掉上一版的；没给的，上一版的段（参考、留出录音）这一版还留着至少一段就沿用（补卡片那一句、改设定、改读音、补素材的版本）。
//                    一段都没留下（都 drop 了）就不沿用，这一版没有设计来源：那是换了来源（例如在设计的声音上改做音色库的声音），参考里已经没有设计来的段，
//                    再带着设计来源，产品会在别的来源的声音上写「设计自」。清单认不出哪几段是设计来的（设计出来的声音的段不标，protocol/FORMAT.md 4.4 的 synthetic），
//                    所以按「上一版的段一段都没留下」算。不沿用时报告的说明里有 design_source_dropped（details: { previous }：上一版的版本号），变了什么里 designSourceDropped 为真
//   对基础部分的最低要求（requires）、所需能力（features）   沿用，除非明说；不因为这次用了新版本的基础部分就抬高最低要求
//   验证记录         不带过来：上一版的记录量的是上一版的参考集和指引，对这一版不算数。这一版量了就是新的一条，没量就没有（makePack 的报告说明）
//   protocol/、voice-pack/   不跟着走，用这次给的协议核心和基础部分
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_invalid     输入不合约定，或 describeChanges 返回的不是一句话。details: { field, problem }（和 lib/make-pack-input.mjs 同一个 code，同一种写法）
//   make_pack_version_invalid   明说的版本号不比上一版大。details: { previous, version }
//   make_pack_nothing_changed   发新版本，却和上一版比什么都没变（新补的素材没一段用得上、别的也没改）。details: { previous, unused }：unused 是新补的素材没用上的原因 -> 段数
//   make_pack_previous_invalid  上一版读不了。details.reason：manifest_missing 没有清单、manifest_invalid 清单读不懂（cause 里是原因）、
//                               not_role_part 清单是别的部分的（details.part）、audio_unrecognized 上一版的一段音频认不出格式（details.id；卡片试听那一句的是 cardLine）、
//                               protocol_old 上一版按协议 1.x、2.x 写（details.protocol）：段的写法不一样（protocol/FORMAT.md 第 14 节），这一版不迁移旧包，只接着发协议 3.x 的包
//   另外 file_modified、file_missing、external_* 来自 lib/voice-pack.mjs（openVoicePack 的 verify: true）：上一版的文件和它自己的清单对不上，不在被改过的东西上发新版本。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { parseManifest, MANIFEST_FILE, SIGNATURE_FILE, isManagedPath } from '../protocol/lib/manifest.mjs';
import { protocolMajorOf } from '../protocol/lib/names.mjs';
import { PROTOCOL_VERSION } from '../protocol/lib/version.mjs';
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
 *   segments: { id: string, role: 'reference' | 'holdout', audio: { bytes: Uint8Array, mimeType: string }, format: string, path: string, text: string, annotatedText?: string, language: string, tag?: string, externalUrl: string | null, synthetic: boolean }[],
 *   cardLine: { text: string, bytes: Uint8Array, format: string, seed?: number } | null,
 *   carried: Map<string, Uint8Array> }>} segments 是先参考后留出录音，各按清单里的次序；cardLine 是卡片试听那一句（台词、音频的字节和格式，和清单核对过；清单里记着配它用的 seed 的另有 seed；没有是 null）；
 *   carried 是要跟着走的其他文件（不含段的音频和卡片试听那一句的音频）
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
  if (protocolMajorOf(manifest.protocol) !== protocolMajorOf(PROTOCOL_VERSION)) {
    throw previousInvalid('protocol_old', `上一版按协议 ${manifest.protocol} 写：参考段的写法不一样（语言、音色基底标签，见 protocol/FORMAT.md 第 14 节），这一版不迁移旧包，用新的素材做一个新包`, { protocol: manifest.protocol });
  }

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
    segments.push({ id: entry.id, role, audio: { bytes, mimeType: MIME_OF_FORMAT[sniffed.format] }, format: sniffed.format, path: entry.audio, text: entry.text, ...(typeof entry.annotatedText === 'string' ? { annotatedText: entry.annotatedText } : {}), language: entry.language, ...(role === 'reference' ? { tag: entry.tag } : {}), externalUrl: externals.get(entry.audio) ?? null, synthetic: entry.synthetic === true });
  }
  // 卡片试听那一句：它不跟着其他文件走，怎么沿用看 lib/make-pack-card-line.mjs 的 carriedCardLine
  let cardLine = null;
  if (manifest.cardLine !== undefined) {
    const bytes = await pack.read(manifest.cardLine.audio);
    const sniffed = sniffAudio(bytes);
    if (sniffed === null) throw previousInvalid('audio_unrecognized', `上一版的 ${manifest.cardLine.audio} 认不出是什么音频`, { id: 'cardLine', path: manifest.cardLine.audio });
    audioPaths.add(manifest.cardLine.audio);
    cardLine = { text: manifest.cardLine.text, bytes, format: sniffed.format, ...(Number.isSafeInteger(manifest.cardLine.seed) ? { seed: manifest.cardLine.seed } : {}), ...(Number.isInteger(manifest.cardLine.expressiveness) ? { expressiveness: manifest.cardLine.expressiveness } : {}) };
  }
  const carried = new Map();
  for (const [path, data] of files) {
    if (path === MANIFEST_FILE || path === SIGNATURE_FILE || path === SKILL_FILE || !isManagedPath(path, 'role') || audioPaths.has(path)) continue;
    carried.set(path, data);
  }
  return { manifest, id: manifest.id, version: manifest.version, name: manifest.name, guidance: await pack.guidance(), segments, cardLine, carried };
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
 *   { name, referenceIds, holdoutIds, tags?, defaultSegment, languageDefaults, guidance, direction, sampleLines, setups, designSource, scripts, enhancers, features, requires, files }
 *   defaultSegment 是主语言的默认段，languageDefaults 是别的语言各自的默认段（段名的数组，次序不算）：哪一段默认段换了，defaultChanged 就是 true
 *   files 是其他文件（Map，不含段的音频、卡片试听那一句的音频、SKILL.md、清单）；referenceIds、holdoutIds 是段的名字（按清单里的次序）；
 *   tags 是参考的音色基底标签（Map<段名, 标签>，可以只给一部分段，不给就不比）：两版都有、标签不一样的参考列进 retagged（按 next 的参考次序）
 *   cardLine 是卡片试听那一句的台词（没有就不写）；next 另有 cardLineRevoiced：这一版重配了这一句（给了新的一句），台词一样也算变了
 * @returns {Promise<{ added: string[], addedReferences: string[], addedHoldouts: string[], dropped: string[], retagged: string[], defaultChanged: boolean,
 *   guidanceChanged: boolean, directionChanged: boolean, sampleLinesChanged: boolean, setupsChanged: boolean, designSourceChanged: boolean, designSourceDropped: boolean, scriptsChanged: boolean, enhancersChanged: boolean,
 *   requirementsChanged: boolean, cardLineChanged: boolean, cardLineDropped: boolean, cardLineFailed: boolean, filesChanged: string[], nameChanged: boolean, empty: boolean }>} empty 为真就是什么都没变；
 *   designSourceDropped 是上一版有设计来源、这一版没有（designSourceChanged 也为真）；cardLineDropped 是上一版有卡片试听那一句、这一版没有：makePack 发新版本时这一句一律沿用
 *   （没给就带上上一版的，lib/make-pack-card-line.mjs 的 carriedCardLine），所以算出来总是 false，只有要重配的那一句没配成时由 withoutCardLine 置成 true（那时 cardLineFailed 也为真）；
 *   cardLineFailed 在这里总是 false：要重配的那一句没配成，是做完包才知道的（withoutCardLine）
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
    retagged: next.referenceIds.filter((id) => previous.tags?.has(id) && next.tags?.has(id) && previous.tags.get(id) !== next.tags.get(id)),
    defaultChanged: previous.defaultSegment !== next.defaultSegment || [...(previous.languageDefaults ?? [])].sort().join('\n') !== [...(next.languageDefaults ?? [])].sort().join('\n'),
    guidanceChanged: (previous.guidance ?? '').trim() !== (next.guidance ?? '').trim(),
    directionChanged: !same(previous.direction, next.direction),
    sampleLinesChanged: !same(previous.sampleLines, next.sampleLines),
    expressivenessChanged: (previous.expressiveness ?? null) !== (next.expressiveness ?? null),
    setupsChanged: !same(previous.setups, next.setups),
    designSourceChanged: !same(previous.designSource, next.designSource),
    designSourceDropped: previous.designSource !== undefined && next.designSource === undefined,
    scriptsChanged: !same(previous.scripts, next.scripts),
    enhancersChanged: !same(previous.enhancers, next.enhancers),
    requirementsChanged: !same(previous.requires, next.requires) || !same(previous.features, next.features),
    cardLineChanged: previous.cardLine !== next.cardLine || next.cardLineRevoiced === true,
    cardLineDropped: previous.cardLine !== undefined && next.cardLine === undefined,
    cardLineFailed: false,
    filesChanged: await changedFiles(previous.files, next.files),
    nameChanged: previous.name !== next.name,
  };
  const { added, addedReferences: _r, addedHoldouts: _h, dropped, retagged, filesChanged, ...flags } = changes;
  void _r;
  void _h;
  return { ...changes, empty: added.length === 0 && dropped.length === 0 && retagged.length === 0 && filesChanged.length === 0 && !Object.values(flags).some(Boolean) };
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
  if ((changes.retagged ?? []).length > 0) parts.push(`改了 ${changes.retagged.length} 段参考的音色基底标签（${listIds(changes.retagged)}）`); // 比这一项早的调用方给的 changes 没有它
  if (changes.defaultChanged) parts.push('换了默认参考段');
  if (changes.guidanceChanged) parts.push('更新了配音指引');
  if (changes.directionChanged) parts.push('更新了音色描述和标签');
  if (changes.sampleLinesChanged) parts.push('更新了示例台词');
  if (changes.expressivenessChanged) parts.push('更新了声音的起伏');
  if (changes.setupsChanged) parts.push('更新了设定');
  if (changes.designSourceChanged) parts.push(changes.designSourceDropped === true ? '去掉了设计来源' : '更新了设计来源'); // 比这一项早的调用方给的 changes 没有 designSourceDropped
  if (changes.scriptsChanged) parts.push('更新了脚本');
  if (changes.enhancersChanged) parts.push('更新了增强件');
  if (changes.requirementsChanged) parts.push('更新了功能声明和对基础部分的要求');
  if (changes.cardLineFailed) parts.push('卡片试听那一句没配成');
  else if (changes.cardLineChanged) parts.push(changes.cardLineDropped ? '去掉了卡片试听那一句' : '重配了卡片试听那一句');
  if (changes.filesChanged.length > 0) parts.push(`更新了文件 ${listIds(changes.filesChanged)}`);
  if (changes.nameChanged && name !== undefined) parts.push(`名字改成「${name}」`);
  return fitChangelog(`${parts.join('；')}。`);
}

// ---------------------------------------------------------------- 做包（lib/make-pack.mjs）发新版本时用的

/**
 * 这次没给设计来源时，上一版的设计来源跟不跟到这一版（规则见文件头「设计来源」）：上一版有设计来源，而且上一版的段（参考、留出录音）这次至少留下一段（不在 drop 里）。
 * previousManifest 是上一版的清单（读不出是 null：不跟）。
 */
export function carriesDesignSource(previousManifest, drop = []) {
  if (previousManifest?.designSource === undefined) return false;
  const ids = [...(previousManifest.reference?.segments ?? []), ...(previousManifest.holdout ?? [])].map((entry) => entry.id);
  return ids.some((id) => !drop.includes(id));
}

/** 上一版有设计来源，这次没给，又不沿用（规则见文件头「设计来源」）。 */
const dropsDesignSource = (previous, input) => previous !== null && previous.manifest.designSource !== undefined && input.designSource === undefined && !carriesDesignSource(previous.manifest, input.drop ?? []);

/** 发新版本留给报告的说明（见文件头）：上一版的设计来源不沿用时，design_source_dropped。 */
export function versionNotes(previous, input) {
  if (!dropsDesignSource(previous, input)) return [];
  return [{
    code: 'design_source_dropped',
    message: `上一版（${previous.version}）的段这一版一段都没留下，又没给设计来源：上一版的设计来源不沿用，这一版没有设计来源。这一版的声音是设计（默认音色、融合）出来的，就交它的设计来源（命令行 --design-source <文件.json>）`,
    details: { previous: previous.version },
  }];
}

/** 这次生效的描述：这次给了就用这次的，没给就沿用上一版的（规则见 lib/pack-version.mjs 的文件头；设计来源一段都没留下就不沿用，见那里「设计来源」）。第一个版本就是输入本身。 */
export function effectiveOf(input, direction, previous) {
  const old = previous === null ? {} : previous.manifest;
  const setups = input.setups ?? old.setups;
  return {
    name: input.name === undefined ? previous.name : input.name.trim(),
    guidance: input.guidance ?? previous?.guidance ?? undefined,
    direction: direction ?? old.direction,
    sampleLines: input.sampleLines ?? old.sampleLines,
    expressiveness: input.expressiveness === undefined ? old.expressiveness : input.expressiveness ?? undefined, // null 是去掉上一版的值
    setups,
    designSource: input.designSource ?? (dropsDesignSource(previous, input) ? undefined : old.designSource),
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
  tags: new Map(previous.segments.filter((segment) => segment.role === 'reference').map((segment) => [segment.id, segment.tag])),
  defaultSegment: previous.manifest.reference.defaultSegment,
  languageDefaults: previous.manifest.reference.languageDefaults ?? [],
  guidance: previous.guidance,
  direction: previous.manifest.direction,
  sampleLines: previous.manifest.sampleLines,
  expressiveness: previous.manifest.expressiveness,
  setups: previous.manifest.setups,
  designSource: previous.manifest.designSource,
  scripts: previous.manifest.scripts,
  enhancers: previous.manifest.enhancers,
  features: previous.manifest.features,
  requires: previous.manifest.requires,
  cardLine: previous.cardLine?.text,
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
 * @param {{ effective: object, items: object[], fresh: object[], defaultSegments: string[], tags?: Map<string, string>, cardLine?: string }} now effective 是这次生效的描述（effectiveOf），items 是筛过的全部条目，
 *   fresh 是其中新补的，defaultSegments 是作者这次点名的默认段（点名的不是上一版的默认段，就算变了），tags 是上一版带来的参考这一版的标签
 *   （lib/make-pack-tags.mjs 的 carriedTags：作者改了名的，花钱之前就定得下），cardLine 是这次给的卡片试听那一句（给了就是要重配，算变了）
 * @throws {VoicePackError} make_pack_nothing_changed
 */
export async function assertSomethingNew(previous, { effective, items, fresh, defaultSegments = [], tags, cardLine }) {
  const carried = items.filter((item) => item.previous !== undefined);
  const shape = previousShape(previous);
  // 点名的都是上一版的默认段，默认段就没变；点名了别的段，默认段变了（这里只要看出「变了」：记成多了几段别的语言的默认段）
  const renamed = defaultSegments.filter((id) => id !== shape.defaultSegment && !shape.languageDefaults.includes(id));
  const early = await diffVersions(shape, {
    ...effective,
    referenceIds: [...carried.filter((item) => item.previous === 'reference'), ...fresh.filter((item) => item.unused === undefined)].map((item) => item.id),
    holdoutIds: carried.filter((item) => item.previous === 'holdout').map((item) => item.id),
    tags,
    defaultSegment: shape.defaultSegment,
    languageDefaults: [...shape.languageDefaults, ...renamed],
    // 卡片试听那一句：这次给了就是重配；没给的是沿用（lib/make-pack-card-line.mjs 的 carriedCardLine），不算变了
    cardLine: cardLine ?? shape.cardLine,
    cardLineRevoiced: cardLine !== undefined,
  });
  if (early.empty) throw nothingChanged(previous, fresh);
}

/**
 * 挑完素材以后：这一版比上一版变了什么（什么都没变就不发），和写进清单的变更说明（作者写的；没写就按变化生成：调用方给了 describeChanges 用它，不给用 changelogOf）。
 * tags 同 assertSomethingNew：上一版带来的参考这一版的标签。
 * 第一个版本（previous 是 null）没有「变了什么」：changes 是 null，变更说明是作者写的，没写就是 undefined。
 * cardLine 是这一版打算放的卡片试听那一句 { text, revoiced }（revoiced：这次给了、要重配）；没给、上一版有的是沿用：{ text: 上一版的台词 }；都没有就不给。
 * 配没配成，做完包才知道：最后没有这一句的，用 withoutCardLine 改 changes，作者没写变更说明的用 changelogFor 重写。
 * @returns {Promise<{ changes: object | null, changelog: string | undefined }>} changes 是 diffVersions 的结果
 * @throws {VoicePackError} make_pack_nothing_changed、make_pack_input_invalid（describeChanges 返回的不是一句话）
 */
export async function releaseChanges(previous, { effective, chosen, fresh, changelog, describeChanges, tags, cardLine }) {
  const changes = previous === null ? null : await diffVersions(previousShape(previous), { ...effective, referenceIds: chosen.references, holdoutIds: chosen.holdouts, tags, defaultSegment: chosen.defaultSegment, languageDefaults: (chosen.languageDefaults ?? []).map((entry) => entry.id), cardLine: cardLine?.text, cardLineRevoiced: cardLine?.revoiced === true });
  if (changes?.empty) throw nothingChanged(previous, fresh);
  return { changes, changelog: changelog ?? (changes === null ? undefined : await changelogFor(changes, { describeChanges, name: effective.name })) };
}

/**
 * 作者没写变更说明时，按 changes 写一句（调用方给了 describeChanges 用它，不给用 changelogOf；规矩见 generatedChangelog）。releaseChanges 用它，
 * 这一版最后没有卡片试听那一句、changes 改了以后（withoutCardLine），lib/make-pack.mjs 用它重写一遍。
 */
export const changelogFor = (changes, { describeChanges, name }) => generatedChangelog(describeChanges ?? changelogOf, changes, name);

/**
 * 这一版最后没有卡片试听那一句：要重配的没配成（没给的，上一版有就沿用，不会走到这里）。改 releaseChanges 算出的 changes：
 * cardLineFailed 为真；上一版有这一句的，cardLineChanged、cardLineDropped 为真（这一版没有了），没有的这两项为假。其余不动。第一个版本（changes 是 null）照旧是 null。
 */
export function withoutCardLine(previous, changes) {
  if (changes === null) return null;
  const had = previous.cardLine !== null;
  return { ...changes, cardLineChanged: had, cardLineDropped: had, cardLineFailed: true, empty: false };
}
