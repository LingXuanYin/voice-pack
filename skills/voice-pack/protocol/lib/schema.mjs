// SPDX-License-Identifier: Apache-2.0
//
// 一个小号的 JSON Schema 校验器：只实现清单的 schema（protocol/schema/manifest.schema.json）用到的关键字。
//
// 为什么自己写：基础部分不依赖第三方库（ajv 之类），浏览器和 Node 都要能跑。schema 文件本身是标准的 JSON Schema
// （draft 2020-12），第三方拿 ajv 也能校验同一份文件，所以这里实现的关键字按标准来，不自己发明语义。
//
// 支持的关键字（写成清单 schema 时只能用这些）：
//   type（含 integer）、enum、const、required、properties、additionalProperties（布尔或 schema）、propertyNames、
//   minProperties、maxProperties、items、minItems、maxItems、uniqueItems、minLength、maxLength、pattern、
//   minimum、maximum、exclusiveMinimum、exclusiveMaximum、allOf、oneOf、$ref（只认本文档里的 #/$defs/…）
// 注解（不影响结果）：$schema、$id、$anchor、$defs、$comment、title、description、examples、default、deprecated、
//   readOnly、writeOnly，以及 x- 开头的自定字段。
// 没实现的关键字（format、patternProperties、if/then、not、anyOf、dependentRequired、contains、prefixItems……）一律
// 当场报 schema_invalid，不悄悄放过：schema 改了但校验器没跟上，比校验失败危险得多。
//
// 和其他实现一致的几个细节：
//   - 字符串长度按码点算（maxLength: 1 收得下一个 emoji），位置用 JSON Pointer（/ 写成 ~1，~ 写成 ~0）。
//   - 读取对象只认自己的键：清单里写成 {"constructor": …} 这类键不会绕过 required，也不会碰到原型。
//   - uniqueItems 按内容比较，对象的键顺序无所谓；用规范化的键放进 Set，所以长数组也是线性的，恶意的大数组拖不垮。
//
// 数据有问题报成「问题」（返回值里），schema 有问题抛错：
//   problems[].keyword 是触发它的关键字；嵌套超过 maxDepth 层的数据报 keyword 'depth'，不再往下走。
//   schema_invalid   schema 本身不合法：引用找不到、引用绕圈、用了没实现的关键字、type 写成了不认识的名字、pattern 不是合法的正则、
//                    该是 schema 的地方既不是对象也不是 true/false（写坏的 schema 不能当成「什么都能过」）。
//                    details: { ref }、{ keyword, pointer }、{ keyword } 或 { dataPointer }（校验那一处数据时遇到的坏 schema）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

const DEFAULT_MAX_PROBLEMS = 200;
const DEFAULT_MAX_DEPTH = 64; // 数据嵌套的上限。真实清单不到 10 层，递归的 schema 配上恶意深嵌套的输入要靠它挡住

const ANNOTATIONS = new Set(['$schema', '$id', '$anchor', '$defs', '$comment', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const BASE_KEYWORDS = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'allOf', 'oneOf', '$ref',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const schemaInvalid = (message, details) => new VoicePackError('schema_invalid', message, { details });
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointerJoin = (pointer, key) => `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'object') return '对象';
  return typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);
}

/** 深比较，按 JSON 的语义：数字按数值比（1 和 1.0 是同一个），对象的键顺序无所谓，1 和 true 不同。 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => own(b, k) && sameValue(a[k], b[k]));
}

/** 内容相同的值得到相同的字符串（对象的键排序），用来在线性时间内查重。嵌套超过 maxDepth 的给一个独一无二的串：它们必然已经不合格。 */
let uniqueCounter = 0;
function canonical(value, depth = 0) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (depth > DEFAULT_MAX_DEPTH) return `"~too-deep-${uniqueCounter++}"`;
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(',')}}`;
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/** schema 里值不是 schema 的位置：const、enum、examples、default 里面可以有任意的键。 */
const VALUE_KEYS = new Set(['const', 'enum', 'examples', 'default']);
/** 下面一层的键是名字、不是关键字的位置。 */
const NAME_KEYS = new Set(['properties', '$defs']);

/**
 * 一次查完整个 schema 的关键字，把不支持的挑出来（不用等数据走到那一条才报）。
 * @throws {VoicePackError} schema_invalid，details.keyword / details.pointer
 */
export function checkSchemaKeywords(schema, pointer = '') {
  if (!isObject(schema)) return;
  for (const [key, value] of Object.entries(schema)) {
    if (VALUE_KEYS.has(key) || key.startsWith('x-')) continue;
    if (!BASE_KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      throw schemaInvalid(`schema 里用了这个校验器不支持的关键字：${key}（要么按标准补上实现，要么改用支持的关键字）`, { keyword: key, pointer: pointer || '/' });
    }
    if (NAME_KEYS.has(key) && isObject(value)) {
      for (const [name, sub] of Object.entries(value)) checkSchemaKeywords(sub, pointerJoin(pointerJoin(pointer, key), name));
    } else if (Array.isArray(value)) {
      value.forEach((sub, i) => checkSchemaKeywords(sub, pointerJoin(pointerJoin(pointer, key), i)));
    } else if (isObject(value)) {
      checkSchemaKeywords(value, pointerJoin(pointer, key));
    }
  }
}

function resolveRef(root, ref, seen) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw schemaInvalid(`$ref 只认本文档里的 #/$defs/…：${JSON.stringify(ref)}`, { ref });
  if (seen.includes(ref)) throw schemaInvalid(`$ref 绕圈了：${[...seen, ref].join(' → ')}`, { ref });
  let node = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !own(node, part)) throw schemaInvalid(`$ref 指向的东西不存在：${ref}`, { ref });
    node = node[part];
  }
  if (!isObject(node) && typeof node !== 'boolean') throw schemaInvalid(`$ref 指向的不是 schema：${ref}`, { ref });
  return { node, seen: [...seen, ref] };
}

// 同一份 schema 只查一次关键字（清单的 schema 是模块级单例，每次校验都重查没有意义；用 WeakSet，不留引用）
const checkedSchemas = new WeakSet();

/**
 * 校验一个值。先查一遍 schema 用的关键字，有没实现的就抛错（见文件头）。
 * @param {object} schema 标准的 JSON Schema（draft 2020-12），只用了本模块支持的关键字
 * @param {unknown} value 要校验的值（一般是 JSON.parse 出来的清单）
 * @param {{ maxProblems?: number, maxDepth?: number }} [options] 问题攒到 maxProblems 条就停（truncated 为 true）
 * @returns {{ valid: boolean, problems: { pointer: string, keyword: string, message: string }[], truncated: boolean }}
 * @throws {VoicePackError} schema_invalid（schema 自己的问题）
 */
export function validateSchema(schema, value, options = {}) {
  if (isObject(schema) && !checkedSchemas.has(schema)) { checkSchemaKeywords(schema); checkedSchemas.add(schema); }
  const maxProblems = options.maxProblems ?? DEFAULT_MAX_PROBLEMS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const state = { truncated: false };

  // out：这一次校验把问题放进哪个数组。oneOf 用临时数组分别试每一支，再决定报哪一支的。
  // seen：同一个数据节点上已经走过的 $ref（用来发现绕圈）；往数据的下一层走时清空，所以递归的 schema（树）不会被误判。
  const walk = (node, data, pointer, seen, depth, out) => {
    const add = (at, keyword, message) => {
      if (out.length >= maxProblems) { state.truncated = true; return; }
      out.push({ pointer: at, keyword, message });
    };
    if (out.length >= maxProblems) { state.truncated = true; return; }
    if (node === true) return;
    if (node === false) { add(pointer, 'false', '这里不允许有值'); return; }
    // 到这里 node 必须是对象。undefined、数字、字符串、数组这类是 schema 写坏了：当成「什么都能过」会悄悄放过所有数据
    if (!isObject(node)) throw schemaInvalid(`校验 ${pointer || '/'} 用的 schema 既不是对象，也不是 true/false：${describe(node)}`, { dataPointer: pointer || '/' });
    if (depth > maxDepth) { add(pointer, 'depth', `数据嵌套太深（超过 ${maxDepth} 层）`); return; }

    if (own(node, '$ref')) {
      const target = resolveRef(schema, node.$ref, seen);
      walk(target.node, data, pointer, target.seen, depth, out);
      return;
    }

    if (own(node, 'type')) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      for (const type of types) if (!TYPES.has(type)) throw schemaInvalid(`type 只能是 ${[...TYPES].join('/')}：${JSON.stringify(type)}`, { keyword: 'type' });
      if (!types.some((type) => matchesType(data, type))) {
        add(pointer, 'type', `这里的值应该是 ${types.join(' 或 ')}，实际是 ${describe(data)}`);
        return; // 类型都不对，后面的关键字（长度、属性……）说的不是这个值，不再报第二遍
      }
    }
    if (own(node, 'const') && !sameValue(data, node.const)) add(pointer, 'const', `这里的值只能是 ${JSON.stringify(node.const)}，实际是 ${describe(data)}`);
    if (Array.isArray(node.enum) && !node.enum.some((item) => sameValue(data, item))) add(pointer, 'enum', `这里的值要在这几个里：${JSON.stringify(node.enum)}，实际是 ${describe(data)}`);

    if (typeof data === 'string') {
      const length = [...data].length;
      if (typeof node.minLength === 'number' && length < node.minLength) add(pointer, 'minLength', `太短：至少 ${node.minLength} 个字符`);
      if (typeof node.maxLength === 'number' && length > node.maxLength) add(pointer, 'maxLength', `太长：最多 ${node.maxLength} 个字符，这里有 ${length} 个`);
      if (typeof node.pattern === 'string' && !(typeof node.maxLength === 'number' && length > node.maxLength)) { // 已经超长的不再跑正则，省得在恶意的长串上白费工夫
        let re;
        try { re = new RegExp(node.pattern, 'u'); } catch (cause) { throw new VoicePackError('schema_invalid', `pattern 不是合法的正则：${JSON.stringify(node.pattern)}`, { details: { keyword: 'pattern' }, cause }); }
        if (!re.test(data)) add(pointer, 'pattern', `写法不对（要符合 ${node.pattern}）：${describe(data)}`);
      }
    }
    if (typeof data === 'number') {
      if (typeof node.minimum === 'number' && data < node.minimum) add(pointer, 'minimum', `不能小于 ${node.minimum}，实际是 ${data}`);
      if (typeof node.maximum === 'number' && data > node.maximum) add(pointer, 'maximum', `不能大于 ${node.maximum}，实际是 ${data}`);
      if (typeof node.exclusiveMinimum === 'number' && data <= node.exclusiveMinimum) add(pointer, 'exclusiveMinimum', `要大于 ${node.exclusiveMinimum}，实际是 ${data}`);
      if (typeof node.exclusiveMaximum === 'number' && data >= node.exclusiveMaximum) add(pointer, 'exclusiveMaximum', `要小于 ${node.exclusiveMaximum}，实际是 ${data}`);
    }

    if (Array.isArray(data)) {
      const tooLong = typeof node.maxItems === 'number' && data.length > node.maxItems;
      if (typeof node.minItems === 'number' && data.length < node.minItems) add(pointer, 'minItems', `至少要有 ${node.minItems} 项，这里有 ${data.length} 项`);
      if (tooLong) add(pointer, 'maxItems', `最多 ${node.maxItems} 项，这里有 ${data.length} 项`);
      if (!tooLong) { // 已经超长的数组不再逐项报：既无益，也防止一个恶意的大数组刷出海量的错
        if (node.uniqueItems === true) {
          const first = new Map();
          data.forEach((item, i) => {
            const key = canonical(item);
            if (first.has(key)) add(pointerJoin(pointer, i), 'uniqueItems', `和第 ${first.get(key)} 项重复`);
            else first.set(key, i);
          });
        }
        if (own(node, 'items')) data.forEach((item, i) => walk(node.items, item, pointerJoin(pointer, i), [], depth + 1, out));
      }
    }

    if (isObject(data)) {
      const keys = Object.keys(data);
      if (Array.isArray(node.required)) {
        const missing = node.required.filter((name) => !own(data, name));
        if (missing.length) add(pointer, 'required', `缺字段：${missing.join('、')}`);
      }
      if (typeof node.minProperties === 'number' && keys.length < node.minProperties) add(pointer, 'minProperties', `字段太少：至少 ${node.minProperties} 个`);
      if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) add(pointer, 'maxProperties', `字段太多：最多 ${node.maxProperties} 个，这里有 ${keys.length} 个`);
      if (own(node, 'propertyNames')) {
        for (const key of keys) {
          const sub = [];
          walk(node.propertyNames, key, pointerJoin(pointer, key), [], depth + 1, sub);
          if (sub.length) add(pointerJoin(pointer, key), 'propertyNames', `字段名不合格：${JSON.stringify(key)}`);
        }
      }
      const props = isObject(node.properties) ? node.properties : {};
      for (const key of keys) {
        const at = pointerJoin(pointer, key);
        if (own(props, key)) { walk(props[key], data[key], at, [], depth + 1, out); continue; }
        if (!own(node, 'additionalProperties')) continue;
        if (node.additionalProperties === false) { add(at, 'additionalProperties', `不该有这个字段：${key}`); continue; }
        walk(node.additionalProperties, data[key], at, [], depth + 1, out);
      }
    }

    if (Array.isArray(node.allOf)) for (const sub of node.allOf) walk(sub, data, pointer, seen, depth, out);
    if (Array.isArray(node.oneOf)) {
      const results = node.oneOf.map((branch) => { const sub = []; walk(branch, data, pointer, seen, depth, sub); return sub; });
      const passing = results.filter((sub) => sub.length === 0).length;
      if (passing === 1) return;
      if (passing > 1) { add(pointer, 'oneOf', `有 ${passing} 支都通过：schema 没有写清楚`); return; }
      // 一支都没通过：报哪一支的错？分支里有 const 字段的（相当于 discriminator，清单的 part），优先挑 const 和数据对得上的那一支，
      // 只报它里面的错，不把别的支的错也倒出来；对不上任何一支，就只说这个字段该写什么。没有这种字段的 oneOf，只报一条 oneOf。
      const resolved = node.oneOf.map((branch) => (isObject(branch) && own(branch, '$ref') ? resolveRef(schema, branch.$ref, seen).node : branch));
      const constsOf = (branch) => (isObject(branch) && isObject(branch.properties)
        ? Object.entries(branch.properties).filter(([, sub]) => isObject(sub) && own(sub, 'const')) : []);
      const aligned = (branch) => isObject(data) && constsOf(branch).some(([name, sub]) => own(data, name) && sameValue(data[name], sub.const));
      const candidates = results.map((sub, i) => ({ sub, i })).filter(({ i }) => aligned(resolved[i]));
      if (candidates.length > 0) {
        const best = candidates.reduce((a, b) => (b.sub.length < a.sub.length ? b : a));
        for (const problem of best.sub) add(problem.pointer, problem.keyword, problem.message);
        return;
      }
      const discriminator = constsOf(resolved[0]).map(([name]) => name).find((name) => resolved.every((branch) => constsOf(branch).some(([other]) => other === name)));
      if (discriminator === undefined) { add(pointer, 'oneOf', `和 ${node.oneOf.length} 种写法都对不上`); return; }
      const allowed = resolved.map((branch) => JSON.stringify(constsOf(branch).find(([name]) => name === discriminator)[1].const)).join('、');
      const at = pointerJoin(pointer, discriminator);
      add(at, 'oneOf', isObject(data) && own(data, discriminator) ? `${discriminator} 要写这几个之一：${allowed}，实际是 ${describe(data[discriminator])}` : `缺 ${discriminator}：要写这几个之一：${allowed}`);
    }
  };

  const problems = [];
  walk(schema, value, '', [], 0, problems);
  return { valid: problems.length === 0, problems, truncated: state.truncated };
}
