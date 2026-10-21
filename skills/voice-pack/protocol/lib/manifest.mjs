// SPDX-License-Identifier: Apache-2.0
//
// 清单（manifest.json）：读、写、检查。三个部分（角色部分、基础部分、协议核心）每个目录里各有一份，
// 列出这个部分的每一个文件和它的 SHA-256；格式见 protocol/FORMAT.md「清单」，结构的 schema 在 protocol/schema/manifest.schema.json。
//
// 检查分两层：
//   1 结构：协议核心里的 schema 文件，由 schema.mjs 校验（字段有没有、写法对不对）。
//   2 语义：schema 表达不了的规则——路径排序和安全、重名、不列清单自己、不列交给子部分管的目录、清单里的引用要对得上。
// 每个问题是 { code, message, details }，不抛错，一次把能查的都报出来；要「有问题就抛」用 parseManifest、serializeManifest（还没有 files 的草稿用 assertDraftManifest，只查结构）。
//
// 问题的 code：
//   manifest_not_json    不是 JSON。details.reason：utf8（不是合法的 UTF-8）、bom（带了字节序标记）、syntax（语法不对）、too_deep（嵌套深得不正常）
//   json_too_large       超过 JSON 的大小上限（见 limits.mjs）。details: { path, size, limit }
//   protocol_unsupported 清单按别的协议主版本写的，这一版库读不了（认得哪些主版本，见 names.mjs 的表）。details: { protocol, supported }。其余字段不去猜
//   manifest_invalid     其他一切问题。结构问题的 details: { pointer, keyword }；语义问题的 details.reason 是下面的一种：
//     files_unsorted / externals_unsorted   没按路径的 UTF-8 字节序排列
//     path_unsafe          路径不安全。details: { pointer, path, pathReason }，pathReason 见 paths.mjs
//     path_conflict        重复、只差大小写、既是文件又是目录（文件列表和外部资源合起来查）。details: { kind, path, other }
//     listed_self          列了清单自己或它的签名
//     listed_delegated     列了交给子部分的清单管的目录里的文件。details: { directory }
//     reference_unresolved 参考音频、留出录音、增强件、脚本入口指向的路径，不在文件列表（也不是外部资源，脚本只能在文件列表）里
//     default_segment_unknown 默认参考段不是参考集里的一段（留出录音不算）
//     duplicate_id         参考段、留出录音、增强件的 id 重复
//     duplicate_runtime    基础部分的 runtimes 里，同一个运行时登记了两次。details: { pointer, runtime }
//     holdout_is_reference 一个音频文件既当参考又当留出录音
//     feature_unknown      脚本指向的功能不在 features 里
//     text_blank           参考段的文本、示例台词的某一条、设计来源里试听台词的某一项只有空白或看不见的字符（空串由 schema 的 minLength 管）。
//                          details: { pointer, id }（参考段，id 是段的名字）或 { pointer }（示例台词，pointer 是 /sampleLines/<序号>；试听台词，pointer 是 /designSource/auditionLines/<序号>；序号从 0 起）
//     truncated            问题太多，只列了前面的
//     too_deep             写清单时嵌套深到调用栈放不下（serializeManifest、assertDraftManifest；描述是作者给的 JSON 文件，能嵌得很深）。只有这一个问题，没有 pointer
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import schema from '../schema/manifest.schema.json' with { type: 'json' };
import { VoicePackError } from './errors.mjs';
import { PROTOCOL_VERSION, isProtocolVersion } from './version.mjs';
import { baseDirectoryOf, isReadableProtocol, KNOWN_BASE_DIRECTORIES, READABLE_PROTOCOLS_TEXT } from './names.mjs';
import { validateSchema } from './schema.mjs';
import { pathProblem, findPathConflict, compareUtf8 } from './paths.mjs';
import { resolveLimits, jsonSizeProblem } from './limits.mjs';

/** 每个部分目录里清单的文件名。 */
export const MANIFEST_FILE = 'manifest.json';
/**
 * 清单的签名文件，放在清单旁边，做法同 minisign（<被签文件名>.minisig，见 protocol/SIGNATURES.md 和 lib/signature.mjs 的 SIGNATURE_SUFFIX）。
 * 清单不列它，检查时它也不算「多出来的文件」。
 */
export const SIGNATURE_FILE = `${MANIFEST_FILE}.minisig`;

export const PART_KINDS = Object.freeze(['role', 'base', 'protocol']);
/**
 * 每种部分写给人看的名字，用的就是 protocol/FORMAT.md「术语」里的叫法。要把部分的种类说成中文的地方，都从这张表取（partName），不各写一份：
 * 检查报告、签名问题的说明、补全的原因、seal 和 unpack 的输出。
 */
export const PART_NAMES = Object.freeze({ role: '角色部分', base: '基础部分', protocol: '协议核心' });
/** 部分的种类的名字。不认识的种类（报告里、别人传来的值）原样返回，不抛错；对象原型上的名字（constructor……）也不算种类。 */
export const partName = (kind) => (Object.hasOwn(PART_NAMES, kind) ? PART_NAMES[kind] : kind);
/** 每个部分里，协议核心放在这个子目录里。 */
export const PROTOCOL_DIRECTORY = 'protocol';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * 每种部分里的子部分：放在哪个子目录、是什么种类、是不是必须有（protocol/FORMAT.md 第 1 节）。
 * 子目录里另有清单，那里面的文件交给子部分自己的清单管，不列进这个部分的清单。
 * 完整包里基础部分的目录叫什么，跟角色部分自己的协议版本走（names.mjs 的表），所以要说协议版本；
 * 角色部分以外的部分没有可变的子目录名，protocol 省略也行。
 * @param {'role' | 'base' | 'protocol'} part
 * @param {string} [protocol] 这个部分的清单里的协议版本（「主.次」）；角色部分必须给
 * @returns {{ directory: string, kind: 'role' | 'base' | 'protocol', required: boolean }[]}
 * @throws {VoicePackError} protocol_unsupported（角色部分的协议主版本这一版库读不了）
 */
export function childPartsOf(part, protocol) {
  if (part === 'role') return [{ directory: PROTOCOL_DIRECTORY, kind: 'protocol', required: true }, { directory: baseDirectoryOf(protocol), kind: 'base', required: false }];
  if (part === 'base') return [{ directory: PROTOCOL_DIRECTORY, kind: 'protocol', required: true }];
  return [];
}

/**
 * 角色部分里，另一套协议的基础部分目录名：这一版库认得、但不是这个协议版本该用的那些（比如协议 2.0 的包里放了 1.x 的目录名）。
 * 哪一个里面有 manifest.json，就说明有人把一份基础部分放进了名字不对的目录；返回它的名字，没有就是 null。
 * 检查（check.mjs）用它点名「名字和协议版本对不上」，封印（seal.mjs）用它拒绝悄悄把这样一份基础部分当成角色部分自己的文件。
 * @param {Iterable<string>} paths 角色部分里的路径
 * @param {string} protocol 角色部分自己的协议版本
 * @returns {string | null}
 */
export function foreignBaseDirectory(paths, protocol) {
  const own = baseDirectoryOf(protocol);
  const present = new Set(paths);
  return KNOWN_BASE_DIRECTORIES.find((name) => name !== own && present.has(`${name}/${MANIFEST_FILE}`)) ?? null;
}

/** 每种部分里「交给子部分的清单管」的子目录名。角色部分的基础部分目录名跟协议走，不在这张静态表里：问 delegatedDirectories。 */
const STATIC_DELEGATED = { role: [PROTOCOL_DIRECTORY], base: [PROTOCOL_DIRECTORY], protocol: [] };

/**
 * 这个部分里交给子部分的清单管的子目录名。
 * 角色部分给了协议版本，就是 protocol/ 加那个协议版本的基础部分目录名；不给协议版本，就是 protocol/ 加所有认得的基础部分目录名
 * （拿旧版本的文件做新版本这类不知道包是哪一套名字的地方，两套都躲开）。
 */
export function delegatedDirectories(part, protocol) {
  if (!Object.hasOwn(STATIC_DELEGATED, part)) throw new TypeError(`part 要是 role、base、protocol 之一，收到 ${JSON.stringify(part)}`);
  if (part !== 'role') return STATIC_DELEGATED[part];
  return protocol === undefined ? [PROTOCOL_DIRECTORY, ...KNOWN_BASE_DIRECTORIES] : [PROTOCOL_DIRECTORY, baseDirectoryOf(protocol)];
}

/**
 * 这条路径（相对这个部分的目录）归这个部分的清单管吗？清单自己、它的签名、交给子部分的目录里的文件，都不归它管。
 * @param {string} path
 * @param {'role' | 'base' | 'protocol'} part
 * @param {string} [protocol] 这个部分自己的协议版本，角色部分用它定基础部分的目录名；省略的话两套名字都算（见 delegatedDirectories）
 */
export function isManagedPath(path, part, protocol) {
  if (path === MANIFEST_FILE || path === SIGNATURE_FILE) return false;
  return !delegatedDirectories(part, protocol).some((directory) => path.startsWith(`${directory}/`));
}
/** 协议核心里的清单 schema（protocol/schema/manifest.schema.json）。 */
export const MANIFEST_SCHEMA = deepFreeze(schema);

const MAX_SCHEMA_PROBLEMS = 100;
// 只有空白（\s：空格、制表、换行、不换行空格、Unicode 的各种空格）、控制字符（Cc）、格式字符（Cf：零宽空格、字节序标记……）的文本，等于没写
const BLANK_TEXT = /^[\s\p{Cc}\p{Cf}]*$/u;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // ignoreBOM: 保留 BOM，让我们自己看见它

const problem = (code, message, details) => ({ code, message, details });

/** 语义规则：schema 已经通过，这里只查 schema 表达不了的。 */
function semanticProblems(manifest) {
  const out = [];
  const add = (reason, message, details = {}) => out.push(problem('manifest_invalid', message, { reason, ...details }));
  const delegated = delegatedDirectories(manifest.part, manifest.protocol);
  const externals = manifest.externals ?? [];

  const checkPaths = (entries, field, unsortedReason) => {
    let unsorted = false;
    entries.forEach((entry, i) => {
      const at = `/${field}/${i}/path`;
      const found = pathProblem(entry.path);
      if (found) add('path_unsafe', `${field}[${i}] 的路径不能要（${found.message}）：${JSON.stringify(entry.path)}`, { pointer: at, path: entry.path, pathReason: found.reason });
      if (entry.path === MANIFEST_FILE || entry.path === SIGNATURE_FILE) {
        add('listed_self', `清单不列自己和自己的签名：${entry.path}`, { pointer: at, path: entry.path });
      }
      const directory = delegated.find((name) => entry.path.startsWith(`${name}/`));
      if (directory) add('listed_delegated', `${entry.path} 在 ${directory}/ 里，那个目录有自己的清单管，不列进这份清单`, { pointer: at, path: entry.path, directory });
      if (!unsorted && i > 0 && compareUtf8(entries[i - 1].path, entry.path) > 0) {
        unsorted = true;
        add(unsortedReason, `${field} 没按路径的 UTF-8 字节序排列：${JSON.stringify(entries[i - 1].path)} 排在 ${JSON.stringify(entry.path)} 前面`, { pointer: at, path: entry.path, other: entries[i - 1].path });
      }
    });
  };
  checkPaths(manifest.files, 'files', 'files_unsorted');
  checkPaths(externals, 'externals', 'externals_unsorted');

  const conflict = findPathConflict([...manifest.files.map((f) => f.path), ...externals.map((e) => e.path)]);
  if (conflict) add('path_conflict', `路径 ${JSON.stringify(conflict.path)} 和 ${JSON.stringify(conflict.other)} 冲突（${conflict.kind}）：解到磁盘上会互相覆盖`, { ...conflict });

  if (manifest.part === 'base' && Array.isArray(manifest.runtimes)) {
    const registered = new Map(); // 运行时名字 -> 第一次登记的位置
    manifest.runtimes.forEach((entry, i) => {
      if (registered.has(entry.runtime)) add('duplicate_runtime', `运行时 ${JSON.stringify(entry.runtime)} 登记了两次（已经在 ${registered.get(entry.runtime)} 登记过）`, { pointer: `/runtimes/${i}/runtime`, runtime: entry.runtime });
      else registered.set(entry.runtime, `/runtimes/${i}`);
    });
  }

  if (manifest.part !== 'role') return out;

  const inFiles = new Set(manifest.files.map((f) => f.path));
  const inExternals = new Set(externals.map((e) => e.path));
  const resolvable = (path) => inFiles.has(path) || inExternals.has(path);
  const unresolved = (pointer, path, what, where) => add('reference_unresolved', `${what}指向 ${JSON.stringify(path)}，它不在${where}里`, { pointer, path });
  const segments = manifest.reference.segments;
  const holdout = manifest.holdout ?? [];
  const enhancers = manifest.enhancers ?? [];
  const scripts = manifest.scripts ?? [];

  segments.forEach((s, i) => { if (!resolvable(s.audio)) unresolved(`/reference/segments/${i}/audio`, s.audio, '参考音频', '文件列表和外部资源'); });
  holdout.forEach((s, i) => { if (!resolvable(s.audio)) unresolved(`/holdout/${i}/audio`, s.audio, '留出录音', '文件列表和外部资源'); });
  enhancers.forEach((e, i) => { if (!resolvable(e.path)) unresolved(`/enhancers/${i}/path`, e.path, '增强件', '文件列表和外部资源'); });
  scripts.forEach((s, i) => { if (!inFiles.has(s.entry)) unresolved(`/scripts/${i}/entry`, s.entry, '脚本入口', '文件列表（脚本必须放进包里）'); });

  const seen = new Map();
  const duplicate = (pointer, id, what) => add('duplicate_id', `${what}的 id ${JSON.stringify(id)} 重复了（已经在 ${seen.get(id)} 用过）`, { pointer, id });
  segments.forEach((s, i) => { if (seen.has(s.id)) duplicate(`/reference/segments/${i}/id`, s.id, '参考段'); else seen.set(s.id, `/reference/segments/${i}`); });
  holdout.forEach((s, i) => { if (seen.has(s.id)) duplicate(`/holdout/${i}/id`, s.id, '留出录音'); else seen.set(s.id, `/holdout/${i}`); });
  const enhancerIds = new Map();
  enhancers.forEach((e, i) => {
    if (enhancerIds.has(e.id)) add('duplicate_id', `增强件的 id ${JSON.stringify(e.id)} 重复了（已经在 ${enhancerIds.get(e.id)} 用过）`, { pointer: `/enhancers/${i}/id`, id: e.id });
    else enhancerIds.set(e.id, `/enhancers/${i}`);
  });

  if (!segments.some((s) => s.id === manifest.reference.defaultSegment)) {
    add('default_segment_unknown', `默认参考段 ${JSON.stringify(manifest.reference.defaultSegment)} 不是参考集里的一段（留出录音不能当参考）`, { pointer: '/reference/defaultSegment', id: manifest.reference.defaultSegment });
  }
  const referenceAudio = new Set(segments.map((s) => s.audio));
  holdout.forEach((s, i) => {
    if (referenceAudio.has(s.audio)) add('holdout_is_reference', `留出录音 ${JSON.stringify(s.id)} 用的音频 ${JSON.stringify(s.audio)} 同时是参考段：留出录音从不当参考`, { pointer: `/holdout/${i}/audio`, path: s.audio });
  });
  scripts.forEach((s, i) => {
    if (s.feature !== undefined && !Object.prototype.hasOwnProperty.call(manifest.features, s.feature)) add('feature_unknown', `脚本 ${JSON.stringify(s.entry)} 指向的功能 ${JSON.stringify(s.feature)} 不在 features 里`, { pointer: `/scripts/${i}/feature`, feature: s.feature });
  });
  // 「至少有一段参考音频和对应的文本」（protocol/FORMAT.md「语义规则」第 10 条）：至少一段由 schema 的 minItems 管，文本不能是空串由 minLength 管，
  // 这里补上 schema 表达不了的一半：文本不能只有空白和看不见的字符（空格、换行、零宽空格、控制字符……）。
  // 互相校验（mutual.mjs）不再查这一条，同一条规则只在这里报一次。
  segments.forEach((s, i) => {
    if (BLANK_TEXT.test(s.text)) add('text_blank', `参考段 ${JSON.stringify(s.id)} 的文本是空的（只有空白或看不见的字符）：每段参考音频都要有对应的逐字文本`, { pointer: `/reference/segments/${i}/text`, id: s.id });
  });
  // 示例台词同一条规则：一条只有空白和看不见的字符的台词，念出来是一片安静，等于没写。（空串、太长、不是字符串，由 schema 管）
  (manifest.sampleLines ?? []).forEach((line, i) => {
    if (BLANK_TEXT.test(line)) add('text_blank', `示例台词第 ${i + 1} 条是空的（只有空白或看不见的字符）：每条示例台词都要有看得见的字`, { pointer: `/sampleLines/${i}` });
  });
  // 设计来源里的试听台词同一条规则：试听用的原文，一项只有空白和看不见的字符，等于没写。（空串、太长、不是字符串、项数超了，由 schema 管）
  (manifest.designSource?.auditionLines ?? []).forEach((line, i) => {
    if (BLANK_TEXT.test(line)) add('text_blank', `设计来源的试听台词第 ${i + 1} 项是空的（只有空白或看不见的字符）：每项试听台词都要有看得见的字`, { pointer: `/designSource/auditionLines/${i}` });
  });
  return out;
}

/**
 * 检查一份清单（已经解析成对象）。
 * @param {unknown} value
 * @param {{ schemaOnly?: boolean }} [options] schemaOnly：只查结构（字段的类型、长度、格式），不查语义规则。清单草稿还没有 files 时用（assertDraftManifest）
 * @returns {{ ok: boolean, problems: { code: string, message: string, details: object }[] }}
 */
export function validateManifest(value, options = {}) {
  const protocol = isObject(value) ? value.protocol : undefined;
  if (typeof protocol === 'string' && isProtocolVersion(protocol) && !isReadableProtocol(protocol)) {
    // 别的主版本的字段不一定还是这个样子，不去猜，也不报它的字段问题
    return { ok: false, problems: [problem('protocol_unsupported', `清单按协议 ${protocol} 写，这一版库只认主版本 ${READABLE_PROTOCOLS_TEXT}`, { protocol, supported: READABLE_PROTOCOLS_TEXT })] };
  }
  const result = validateSchema(MANIFEST_SCHEMA, value, { maxProblems: MAX_SCHEMA_PROBLEMS });
  const problems = result.problems.map((p) => problem('manifest_invalid', `清单 ${p.pointer || '/'}：${p.message}`, { pointer: p.pointer, keyword: p.keyword }));
  if (result.truncated) problems.push(problem('manifest_invalid', `清单的问题太多，只列出前 ${MAX_SCHEMA_PROBLEMS} 条`, { reason: 'truncated' }));
  if (problems.length === 0 && options.schemaOnly !== true) problems.push(...semanticProblems(value));
  return { ok: problems.length === 0, problems };
}

/**
 * 从字节读一份清单：大小上限、UTF-8、JSON、协议版本、schema、语义规则，依次过。
 * 不抛错（输入不是 Uint8Array 除外）：所有问题放进 problems。结构合格（能安全地用）时 manifest 是解析出来的对象，
 * 即使还有语义问题；结构不合格或根本不是 JSON 时是 null。
 * @param {Uint8Array} bytes
 * @param {{ limits?: Partial<import('./limits.mjs').DEFAULT_LIMITS> }} [options]
 * @returns {{ manifest: object | null, problems: { code: string, message: string, details: object }[] }}
 */
export function readManifest(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('清单必须是 Uint8Array');
  const limits = resolveLimits(options.limits);
  const notJson = (reason, message, cause) => ({ manifest: null, problems: [problem('manifest_not_json', `${MANIFEST_FILE} 不是合法的 JSON：${message}${cause ? `（${cause}）` : ''}`, { reason })] });
  if (bytes.length > limits.maxJsonBytes) {
    return { manifest: null, problems: [jsonSizeProblem(MANIFEST_FILE, bytes.length, limits)] };
  }
  let text;
  try { text = decoder.decode(bytes); } catch { return notJson('utf8', '不是合法的 UTF-8'); }
  if (text.charCodeAt(0) === 0xfeff) return notJson('bom', '开头有字节序标记（BOM），清单不带 BOM');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return error instanceof RangeError ? notJson('too_deep', '嵌套深得不正常') : notJson('syntax', '语法不对', error instanceof Error ? error.message : undefined);
  }
  const { problems } = validateManifest(value);
  const structural = problems.some((p) => p.code !== 'manifest_invalid' || p.details.reason === undefined);
  return { manifest: structural ? null : value, problems };
}

/** 抛成一个错误：code 取第一个问题的，details.problems 是全部问题。 */
function raise(problems) {
  const first = problems[0];
  throw new VoicePackError(first.code, problems.length === 1 ? first.message : `${first.message}（共 ${problems.length} 处问题）`, { details: { ...first.details, problems } });
}

/**
 * 读一份清单，有问题就抛。
 * @throws {VoicePackError} manifest_not_json / json_too_large / protocol_unsupported / manifest_invalid，details.problems 是完整的问题清单
 */
export function parseManifest(bytes, options = {}) {
  const { manifest, problems } = readManifest(bytes, options);
  if (problems.length > 0) raise(problems);
  return manifest;
}

/**
 * 清单写成 JSON 文字。嵌套深到调用栈放不下（JSON.stringify 抛 RangeError）的，是描述里的数据有问题（作者给的 JSON 文件能嵌得很深），
 * 报成 manifest_invalid，和 readManifest 读到嵌套深得不正常的 JSON 是同一个道理；写不出 JSON 的值（BigInt、循环引用）是调用方的代码出了错，TypeError。
 */
function stringify(value, indent) {
  let json;
  try {
    json = JSON.stringify(value, null, indent);
  } catch (error) {
    if (error instanceof RangeError) raise([problem('manifest_invalid', '清单嵌套得太深，写不出来', { reason: 'too_deep' })]);
    throw error;
  }
  if (json === undefined) throw new TypeError('这个值写不成 JSON');
  return json;
}

/**
 * 把清单写成字节：两个空格缩进，LF 换行，末尾一个换行，UTF-8 不带 BOM，键的顺序保持调用方给的顺序。
 * 同一个对象得到同样的字节（签名是对这些字节做的，所以要稳定）。写之前先检查，不把不合格的清单写进包里。
 * @throws {VoicePackError} 清单不合格（同 parseManifest），含嵌套太深（details.reason 是 too_deep）
 * @throws {TypeError} 含 JSON 写不出的值（BigInt、循环引用）
 */
export function serializeManifest(manifest) {
  const json = stringify(manifest, 2);
  // 检查的是真正要写出去的内容：值为 undefined 的字段 JSON 里本来就没有
  const { problems } = validateManifest(JSON.parse(json));
  if (problems.length > 0) raise(problems);
  return new TextEncoder().encode(`${json}\n`);
}

/**
 * 检查一份还没有 files 的清单草稿的结构：字段的类型、长度、格式，不对就抛 manifest_invalid，details.problems 是完整的问题清单。
 * 做包和 seal 要先生成 SKILL.md（它自己要列进清单的 files），所以生成骨架时清单还写不出来，读的是作者给的描述（--fields 的文件、做包的输入）。
 * 描述是外来的数据，类型不对（features 写成字符串、参考段里有 null……）是数据的错：在这里按清单的规矩报出来，不让它在生成文字时变成 TypeError。
 * 只查结构：路径对不对得上文件、id 重不重复这类语义规则要 files，留给封印时的 serializeManifest。protocol 省略就按这一版库的协议版本，files 不看；
 * 和 serializeManifest 一样，查的是真正会写出去的内容（值为 undefined 的字段当作没写）。
 * @throws {VoicePackError} manifest_invalid、protocol_unsupported（同 parseManifest）
 * @throws {TypeError} 含 JSON 写不出的值（BigInt、循环引用）
 */
export function assertDraftManifest(draft) {
  const { problems } = validateManifest(JSON.parse(stringify({ protocol: PROTOCOL_VERSION, ...draft, files: [] })), { schemaOnly: true });
  if (problems.length > 0) raise(problems);
}
