// SPDX-License-Identifier: Apache-2.0
//
// 净室输入（流程层，纯函数）：给「净室里的做包 agent」准备它能看到的全部东西。流程的正本是 protocol/new-pack/README.md。
//
//   const { files, attributes } = buildCleanRoomInput({ protocolCore, attributes });
//
// 净室的意思：写新包文字内容（音色描述、配音指引、示例台词、设计来源）的 agent，只拿到协议核心（每个部分都带着）里的抽象规格和空白模板，加上使用者说的属性，
// 看不到来源包的任何角色内容。这个函数是净室的入口：它的输入里没有来源包，所以输出里不可能有来源包的内容；来源包只在最后一步查重（lib/duplicate-check.mjs）时才读。
// 使用者把来源包的原文贴进了属性，这里拦不住，也不去拦（拦不住「换了几个字的原文」）：查重在最后拦。
//
// ---------------------------------------------------------------- 输入
//
//   protocolCore   协议核心的文件，Map<路径, Uint8Array>，路径相对 protocol/（和 make-pack 的 protocolCore 一样）。这个函数用到其中的：
//                    new-pack/README.md、brief.md      抽象规格、任务说明
//                    new-pack/template/*               空白模板（direction.json、guidance.md、sample-lines.json、design-source.json 必须有，别的有就一起带上）
//                    schema/manifest.schema.json       清单的 schema：从里面取和写文字有关的三个字段（direction、sampleLines、designSource）的格式，上限都在那里
//   attributes     使用者想要的声音的属性，至少给 tags、scenes、words 里的一个：
//                    tags?      设计词表里的标签（lib/design-vocab.mjs 认的写法，中文名和别名也认），换成规范写法交给做包 agent
//                    scenes?    场景词表里的场景，同上
//                    words?     使用者自己的话（至少一个字符，最长 MAX_WORDS 个），原样交给做包 agent：不改写，不补充，不删减（前后的空白也不动）
//                    language?  语言标签（zh、en、zh-CN……）
//                    designed?  true：这个声音是设计出来的，做包 agent 要写设计来源；默认 false
//                  别的键一律拒绝：不给任何夹带别的东西的口子。
//
// ---------------------------------------------------------------- 输出
//
//   files        一个目录的内容 Map<路径, Uint8Array>，只有这几样（命令行层把它写成目录，交给新开的会话或子 agent）：
//                  BRIEF.md              任务说明（new-pack/brief.md 原样）
//                  attributes.json       属性：{ tags?, scenes?, language?, designed, words? }
//                  spec/README.md        抽象规格（new-pack/README.md 原样）
//                  spec/fields.json      三个字段的格式：清单 schema 里 direction、sampleLines、designSource 的定义，引用的小定义（label、slug、longText……）展开写进去
//                  template/<文件>       空白模板（new-pack/template/ 里的每个文件原样）
//                  为什么不带整份 FORMAT.md：它五万多字节，绝大部分（zip、签名、补全……）和写文字无关，做包 agent 读它是白花力气；要的只是这三个字段的上限，schema 里有
//   attributes   attributes.json 里的内容（对象），给命令行层摆给使用者看
//
// ---------------------------------------------------------------- 抛出的错误（VoicePackError）
//
//   clean_room_input_invalid        属性不合约定。details: { field, problem }（field 是 attributes.tags[1]、attributes.words 这样的路径），problems 是全部问题的清单
//   clean_room_protocol_incomplete  协议核心里缺要用的文件，或者 schema 读不了、里面没有要的字段。details.missing 是缺的路径，details.invalid 是读不了或不对的路径
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { assertFileSet } from '../protocol/lib/fileset.mjs';
import { normalizeDirection } from './design-vocab.mjs';
import { LONG_TEXT_MAX } from './manifest-limits.mjs';
import { isLanguageTag, MAX_LANGUAGE_TAG } from './language-tag.mjs';

/** 使用者的话的字符数上限：和清单 schema 里 longText 的一样（lib/manifest-limits.mjs），不另定一个数。 */
export const MAX_WORDS = LONG_TEXT_MAX;

const KEYS = ['tags', 'scenes', 'words', 'language', 'designed'];
const TEMPLATE_DIRECTORY = 'new-pack/template/';
const REQUIRED_TEMPLATES = ['direction.json', 'guidance.md', 'sample-lines.json', 'design-source.json'];
/** 净室输入里的路径 <- 协议核心里的路径。 */
const FIXED = [['BRIEF.md', 'new-pack/brief.md'], ['spec/README.md', 'new-pack/README.md']];
const SCHEMA_FILE = 'schema/manifest.schema.json';
/** 清单 schema 里，和写文字有关的字段。 */
const WRITTEN_FIELDS = ['direction', 'sampleLines', 'designSource'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(problems) {
  const [first] = problems;
  const message = problems.length === 1 ? first.problem : `${first.problem}（共 ${problems.length} 处）`;
  return new VoicePackError('clean_room_input_invalid', `净室输入的属性不合约定（${first.field}）：${message}`, { details: { field: first.field, problem: first.problem, problems } });
}

/** 属性检查并整理成要写进 attributes.json 的样子。 */
function normalizeAttributes(attributes) {
  if (!isPlainObject(attributes)) throw invalid([{ field: 'attributes', problem: '必须是对象 { tags?, scenes?, words?, language?, designed? }' }]);
  const problems = [];
  for (const key of Object.keys(attributes)) if (!KEYS.includes(key)) problems.push({ field: `attributes.${key}`, problem: `不认识的键（只有 ${KEYS.join('、')}）` });

  const out = {};
  const direction = {};
  if (attributes.tags !== undefined) direction.tags = attributes.tags;
  if (attributes.scenes !== undefined) direction.scenes = attributes.scenes;
  if (Object.keys(direction).length > 0) {
    const result = normalizeDirection(direction);
    for (const problem of result.problems) problems.push({ field: `attributes.${problem.field}`, problem: problem.message });
    if (result.direction?.tags !== undefined && result.direction.tags.length > 0) out.tags = result.direction.tags;
    if (result.direction?.scenes !== undefined && result.direction.scenes.length > 0) out.scenes = result.direction.scenes;
  }
  if (attributes.language !== undefined) {
    if (!isLanguageTag(attributes.language)) problems.push({ field: 'attributes.language', problem: `必须是语言标签，例如 zh、en、zh-CN（最长 ${MAX_LANGUAGE_TAG} 个字符）` });
    else out.language = attributes.language;
  }
  if (attributes.designed !== undefined && typeof attributes.designed !== 'boolean') problems.push({ field: 'attributes.designed', problem: '必须是 true 或 false' });
  out.designed = attributes.designed === true;
  if (attributes.words !== undefined) {
    if (typeof attributes.words !== 'string' || attributes.words.trim() === '' || [...attributes.words].length > MAX_WORDS) problems.push({ field: 'attributes.words', problem: `必须是 1–${MAX_WORDS} 个字符的一段话（不能只有空白）` });
    else out.words = attributes.words;
  }
  if (problems.length === 0 && out.tags === undefined && out.scenes === undefined && out.words === undefined) {
    problems.push({ field: 'attributes', problem: '至少给 tags、scenes、words 里的一个：什么属性都没有，做包 agent 没有东西可写' });
  }
  if (problems.length > 0) throw invalid(problems);
  return out;
}

/** 把 schema 里的引用（#/$defs/名字）展开成定义本身。引用不到的返回 null。 */
function inlineRefs(node, defs) {
  if (Array.isArray(node)) {
    const out = node.map((item) => inlineRefs(item, defs));
    return out.includes(null) ? null : out;
  }
  if (!isPlainObject(node)) return node;
  if (typeof node['$ref'] === 'string') {
    const name = node['$ref'].startsWith('#/$defs/') ? node['$ref'].slice('#/$defs/'.length) : null;
    return name !== null && isPlainObject(defs[name]) ? inlineRefs(defs[name], defs) : null;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const inlined = inlineRefs(value, defs);
    if (inlined === null) return null;
    out[key] = inlined;
  }
  return out;
}

/** 从协议核心的清单 schema 里取三个字段的格式。读不了、没有这几个字段、引用展开不了，都返回 null。 */
function fieldFormats(protocolCore) {
  let schema;
  try {
    schema = JSON.parse(decoder.decode(protocolCore.get(SCHEMA_FILE)));
  } catch {
    return null;
  }
  const defs = schema?.['$defs'];
  const properties = defs?.roleManifest?.properties;
  if (!isPlainObject(defs) || !isPlainObject(properties) || !WRITTEN_FIELDS.every((field) => isPlainObject(properties[field]))) return null;
  const out = {};
  for (const field of WRITTEN_FIELDS) {
    out[field] = inlineRefs(properties[field], defs);
    if (out[field] === null) return null;
  }
  return out;
}

/**
 * 组装净室输入。规则见文件头。
 * @param {{ protocolCore: Map<string, Uint8Array>, attributes: { tags?: string[], scenes?: string[], words?: string, language?: string, designed?: boolean } }} input
 * @returns {{ files: Map<string, Uint8Array>, attributes: object }}
 * @throws {VoicePackError} clean_room_input_invalid、clean_room_protocol_incomplete
 */
export function buildCleanRoomInput(input) {
  if (!isPlainObject(input)) throw new TypeError('input 必须是对象 { protocolCore, attributes }');
  const { protocolCore } = input;
  assertFileSet(protocolCore);
  const attributes = normalizeAttributes(input.attributes);

  const templates = [...protocolCore.keys()].filter((path) => path.startsWith(TEMPLATE_DIRECTORY) && path.length > TEMPLATE_DIRECTORY.length).sort();
  const missing = [...FIXED.map(([, from]) => from), ...REQUIRED_TEMPLATES.map((name) => `${TEMPLATE_DIRECTORY}${name}`), SCHEMA_FILE].filter((path) => !protocolCore.has(path));
  if (missing.length > 0) {
    throw new VoicePackError('clean_room_protocol_incomplete', `协议核心里缺做新包要用的文件：${missing.join('、')}（用官方发布的基础部分里的 protocol/）`, { details: { missing, invalid: [] } });
  }
  const formats = fieldFormats(protocolCore);
  if (formats === null) {
    throw new VoicePackError('clean_room_protocol_incomplete', `协议核心里的 ${SCHEMA_FILE} 读不了，或者没有 direction、sampleLines、designSource 的定义`, { details: { missing: [], invalid: [SCHEMA_FILE] } });
  }

  const files = new Map();
  for (const [to, from] of FIXED) files.set(to, protocolCore.get(from));
  for (const path of templates) files.set(`template/${path.slice(TEMPLATE_DIRECTORY.length)}`, protocolCore.get(path));
  files.set('spec/fields.json', encoder.encode(`${JSON.stringify(formats, null, 2)}\n`));
  files.set('attributes.json', encoder.encode(`${JSON.stringify(attributes, null, 2)}\n`));
  return { files, attributes };
}
