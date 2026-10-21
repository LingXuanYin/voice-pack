// SPDX-License-Identifier: Apache-2.0
//
// SKILL.md：读 frontmatter、按 Agent Skills 规范检查，以及生成角色部分的 SKILL.md 骨架。
//
// 规范（https://agentskills.io/specification，2026-10-14 核对）：frontmatter 只能有 6 个字段——
//   name           必填，1-64 个字符，只用小写字母、数字和连字符，不以连字符开头或结尾，不连用连字符，要和目录名一致
//   description    必填，1-1024 个字符
//   license        可选
//   compatibility  可选，1-500 个字符
//   metadata       可选，字符串到字符串的映射
//   allowed-tools  可选，空格分隔的字符串
// 角色部分的 SKILL.md：name 等于目录名，也等于包 ID；版本号、所需能力、对基础部分的要求都写进清单，不写进 frontmatter。
//
// frontmatter 是 YAML，这里只读它的一个子集（够读规范里的写法和我们自己生成的写法，不引入 YAML 库）：
//   顶层是「字段名: 值」；值可以是朴素标量、单引号或双引号标量（可跨行）、块标量（| 和 > 加 - 或 +）；
//   metadata 这样的映射只认一层缩进；整行和行尾（前面有空格）的 # 是注释。
//   所有标量都读成字符串，不做类型推断；空值读成 null。
//   不认的写法（流式的 {…} 和 […]、块序列、锚点、别名、标签、折叠块里更深缩进的行、嵌套的映射）明确拒绝，原因是 unsupported_syntax，
//   不去猜。
// 朴素标量如果 YAML 会把它读成数字、布尔、空值或日期（例如 metadata 里的 version: 1.0），检查时报 scalar_not_string，要求加引号：
// 规范要的是字符串，不同的 YAML 实现对这些写法的读法不一样。
//
// 错误和问题（都是 skill_md_invalid，details.reason 是下面的一种）：
//   读的时候：bom（开头有字节序标记）、no_frontmatter（不以 --- 开头）、unterminated（往下 64 KiB 内没有结束的 ---）、
//             syntax（语法不对，details.line 是 SKILL.md 里的行号）、unsupported_syntax、duplicate_key
//   检查的时候：unknown_field、missing_field、type（值的类型不对）、scalar_not_string、name_invalid、name_mismatch、
//             description_length、compatibility_length
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { assertDraftManifest } from './manifest.mjs';

/** frontmatter 里允许的字段。 */
export const SKILL_FIELDS = Object.freeze(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

const MAX_FRONTMATTER = 64 * 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/;
const CHILD_RE = /^( +)([A-Za-z0-9][A-Za-z0-9._-]*):(?:[ ]+(.*))?$/;
const UNSUPPORTED_START = /^(?:[{[&*!%`@]|-(?:\s|$)|\?(?:\s|$))/;
const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

/** 抛 skill_md_invalid，不返回：调用的地方不用再 throw（别的模块里的 fail 是造出一个错误、由调用的地方 throw，所以这个不叫 fail）。 */
const throwInvalid = (reason, message, line) => {
  throw new VoicePackError('skill_md_invalid', `SKILL.md ${message}${line === undefined ? '' : `（第 ${line} 行）`}`, { details: line === undefined ? { reason } : { reason, line } });
};

/** 折叠行：相邻的文字行用一个空格连起来，k 个空行变成 k 个换行。 */
function fold(parts) {
  let out = '';
  let blanks = 0;
  let started = false;
  for (const part of parts) {
    if (part === '') { blanks++; continue; }
    if (started) out += blanks === 0 ? ' ' : '\n'.repeat(blanks);
    out += part;
    started = true;
    blanks = 0;
  }
  return out;
}

const isBlank = (line) => /^[ ]*$/.test(line);
const isComment = (line) => /^[ ]*#/.test(line);

/** 读一个引号标量，起点是 lines[at] 的第 col 个字符（引号本身）。 */
function readQuoted(lines, at, col, quote, base) {
  let line = at;
  let i = col + 1;
  let out = '';
  let pending = ''; // 还没确认的行内空白：碰到换行就丢掉，碰到文字才算数
  let blanks = 0; // 折叠时碰到的空行数
  let folding = false; // 刚经过一个换行，还没见到这一行的文字
  for (;;) {
    const text = lines[line];
    if (i >= text.length) {
      // 行尾：丢掉行尾空白，进入折叠
      pending = '';
      if (line + 1 >= lines.length) throwInvalid('syntax', '里有一个引号没有闭合', base + at + 1);
      line++;
      i = 0;
      if (folding) blanks++;
      folding = true;
      continue;
    }
    const ch = text[i];
    if (folding && (ch === ' ' || ch === '\t')) { i++; continue; } // 续行开头的空白不要
    if (folding) {
      out += blanks === 0 ? ' ' : '\n'.repeat(blanks);
      blanks = 0;
      folding = false;
    }
    if (ch === ' ' || ch === '\t') { pending += ch; i++; continue; }
    out += pending;
    pending = '';
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") { out += "'"; i += 2; continue; }
      const tail = text.slice(i + 1);
      if (!/^[ ]*$/.test(tail) && !/^[ ]+#/.test(tail)) throwInvalid('syntax', '的引号后面还有别的字', base + line + 1);
      return { value: out, endLine: line };
    }
    if (quote === '"' && ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) { // 行尾的反斜杠：折行，不留空格
        out += pending;
        if (line + 1 >= lines.length) throwInvalid('syntax', '里有一个引号没有闭合', base + at + 1);
        line++;
        i = 0;
        while (lines[line][i] === ' ' || lines[line][i] === '\t') i++;
        continue;
      }
      if (Object.hasOwn(HEX_ESCAPES, next)) {
        const digits = HEX_ESCAPES[next];
        const hex = text.slice(i + 2, i + 2 + digits);
        const code = Number.parseInt(hex, 16);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throwInvalid('syntax', `的转义 \\${next}${hex} 不合法`, base + line + 1);
        out += String.fromCodePoint(code);
        i += 2 + digits;
        continue;
      }
      if (!Object.hasOwn(ESCAPES, next)) throwInvalid('syntax', `的双引号里有不认识的转义 \\${next}`, base + line + 1);
      out += ESCAPES[next];
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
}

/** 读块标量（| 或 >）：第 at 行是 key: | 那一行，内容从下一行起。 */
function readBlock(lines, at, style, chomp, base) {
  const content = [];
  let blockIndent = 0;
  let next = at + 1;
  for (; next < lines.length; next++) {
    const line = lines[next];
    if (isBlank(line)) { content.push(''); continue; }
    const indent = line.length - line.trimStart().length;
    if (blockIndent === 0) {
      if (indent === 0) break;
      blockIndent = indent;
    }
    if (indent === 0) break;
    if (indent < blockIndent) throwInvalid('syntax', '的块标量缩进不一致', base + next + 1);
    if (/^\t/.test(line.slice(blockIndent - 0)) && style === '>') throwInvalid('unsupported_syntax', '的折叠块（>）里有 Tab 缩进', base + next + 1);
    if (style === '>' && /^[ \t]/.test(line.slice(blockIndent))) throwInvalid('unsupported_syntax', '的折叠块（>）里有比正文缩进更深的行（YAML 里要保留换行，这里不认）', base + next + 1);
    content.push(line.slice(blockIndent));
  }
  let trailing = 0;
  while (content.length > 0 && content[content.length - 1] === '') { content.pop(); trailing++; }
  let value = style === '|' ? content.join('\n') : fold(content);
  if (content.length > 0) {
    if (chomp === '') value += '\n';
    else if (chomp === '+') value += '\n'.repeat(1 + trailing);
  } else if (chomp === '+') {
    value = '\n'.repeat(trailing);
  }
  return { value, endLine: next - 1 };
}

/** 去掉朴素标量行尾的注释（# 前面有空格才算注释），再去掉两端空白。 */
function stripPlain(text) {
  const m = /(?:^|[ ])#/.exec(text);
  return { text: (m ? text.slice(0, m.index) : text).trim(), commented: m !== null };
}

/** 读从 at 行起的「值」。rest 是冒号后面的文字（可能是 undefined）。 */
function readValue(lines, at, rest, base) {
  const first = rest === undefined ? '' : rest.trimStart();
  if (first === '' || first.startsWith('#')) return readIndented(lines, at, base);
  const col = lines[at].length - rest.length + (rest.length - first.length);
  const head = first[0];
  if (head === '|' || head === '>') {
    const m = /^([|>])([+-]?)[ ]*(?:#.*)?$/.exec(first);
    if (!m) throwInvalid('unsupported_syntax', '的块标量带了缩进指示符或别的写法，只认 | 和 > 加 - 或 +', base + at + 1);
    const { value, endLine } = readBlock(lines, at, m[1], m[2], base);
    return { value, endLine, style: 'block' };
  }
  if (head === '"' || head === "'") {
    const { value, endLine } = readQuoted(lines, at, col, head, base);
    return { value, endLine, style: head === '"' ? 'double' : 'single' };
  }
  if (UNSUPPORTED_START.test(first)) throwInvalid('unsupported_syntax', `的这种写法（${first.slice(0, 12)}…）不认：流式的 {…} 和 […]、块序列、锚点、别名、标签都不支持`, base + at + 1);
  return readPlain(lines, at, first, base);
}

function readPlain(lines, at, first, base) {
  const parts = [];
  let end = at;
  let current = stripPlain(first);
  for (;;) {
    if (/(?::[ ]|:$)/.test(current.text)) throwInvalid('syntax', '里有「冒号加空格」：含冒号的值要加引号', base + end + 1);
    parts.push(current.text);
    if (current.commented) break;
    // 续行：缩进的行，空行可以夹在中间
    let probe = end + 1;
    while (probe < lines.length && isBlank(lines[probe])) probe++;
    if (probe >= lines.length || !/^[ ]+\S/.test(lines[probe]) || isComment(lines[probe])) break;
    for (let k = end + 1; k < probe; k++) parts.push('');
    end = probe;
    current = stripPlain(lines[probe]);
  }
  return { value: fold(parts), endLine: end, style: 'plain' };
}

/** 冒号后面没有值：要么是 null，要么下面缩进的行是一层映射，要么是下一行开始的朴素标量。 */
function readIndented(lines, at, base) {
  let probe = at + 1;
  while (probe < lines.length && (isBlank(lines[probe]) || isComment(lines[probe]))) probe++;
  if (probe >= lines.length || !/^[ ]/.test(lines[probe])) return { value: null, endLine: at, style: 'plain' };
  if (/^\t/.test(lines[probe])) throwInvalid('syntax', '里用了 Tab 缩进（YAML 不允许）', base + probe + 1);
  const firstChild = CHILD_RE.exec(lines[probe]);
  if (!firstChild) {
    if (/^[ ]+(?:-[ ]|[{[])/.test(lines[probe])) throwInvalid('unsupported_syntax', '的缩进内容是列表或流式写法，不认', base + probe + 1);
    const plain = readPlain(lines, probe, lines[probe].trim(), base);
    return plain;
  }
  const indent = firstChild[1].length;
  const children = {};
  const childStyles = {};
  let end = at;
  for (let k = probe; k < lines.length; k++) {
    const line = lines[k];
    if (isBlank(line) || isComment(line)) continue;
    if (!/^[ ]/.test(line)) break;
    if (/^\t/.test(line)) throwInvalid('syntax', '里用了 Tab 缩进（YAML 不允许）', base + k + 1);
    const m = CHILD_RE.exec(line);
    if (!m) throwInvalid('syntax', '的缩进行不是「键: 值」', base + k + 1);
    if (m[1].length > indent) throwInvalid('unsupported_syntax', '里嵌套了第二层映射，只认一层', base + k + 1);
    if (m[1].length < indent) throwInvalid('syntax', '的缩进不一致', base + k + 1);
    if (Object.hasOwn(children, m[2])) throwInvalid('duplicate_key', `里 ${JSON.stringify(m[2])} 写了两次`, base + k + 1);
    const restValue = m[3];
    if (restValue === undefined || restValue.trim() === '' || restValue.trimStart().startsWith('#')) {
      const nested = lines[k + 1];
      if (nested !== undefined && /^[ ]+\S/.test(nested) && !isComment(nested) && nested.length - nested.trimStart().length > indent) throwInvalid('unsupported_syntax', '里嵌套了第二层映射，只认一层', base + k + 2);
      children[m[2]] = null;
      childStyles[m[2]] = 'plain';
    } else {
      const col = line.length - restValue.length;
      const head = restValue.trimStart()[0];
      let result;
      if (head === '"' || head === "'") {
        result = readQuoted([line], 0, col + (restValue.length - restValue.trimStart().length), head, base + k);
        result = { value: result.value, style: head === '"' ? 'double' : 'single' };
      } else if (head === '|' || head === '>') {
        throwInvalid('unsupported_syntax', '的映射值里不认块标量', base + k + 1);
      } else if (UNSUPPORTED_START.test(restValue.trimStart())) {
        throwInvalid('unsupported_syntax', `的映射值（${restValue.trim().slice(0, 12)}…）是流式、列表、锚点或标签的写法，不认`, base + k + 1);
      } else {
        const plain = stripPlain(restValue);
        if (/(?::[ ]|:$)/.test(plain.text)) throwInvalid('syntax', '里有「冒号加空格」：含冒号的值要加引号', base + k + 1);
        result = { value: plain.text, style: 'plain' };
      }
      children[m[2]] = result.value;
      childStyles[m[2]] = result.style;
    }
    end = k;
  }
  return { value: children, endLine: end, style: 'map', childStyles };
}

/**
 * 读 SKILL.md：拆出 frontmatter 和正文。
 * @param {string} text 整个文件（已经按 UTF-8 解码）
 * @returns {{ fields: Record<string, string | null | Record<string, string | null>>, body: string, styles: Record<string, string> }}
 *   styles：每个字段的写法（plain、single、double、block、map），metadata 的值是 metadata.<键>。检查时要用，一般调用方不用管。
 * @throws {VoicePackError} skill_md_invalid
 */
export function parseSkillMd(text) {
  if (typeof text !== 'string') throw new TypeError('SKILL.md 的内容必须是字符串');
  if (text.charCodeAt(0) === 0xfeff) throwInvalid('bom', '开头有字节序标记（BOM），frontmatter 前面不能有任何字符');
  // 按行扫：第一行必须是 ---，然后一直读到下一个单独的 ---（最多看 MAX_FRONTMATTER 个字符）
  const lineBreak = /\r\n|\r|\n/g;
  const nextLine = (from) => {
    lineBreak.lastIndex = from;
    const m = lineBreak.exec(text);
    return { line: text.slice(from, m ? m.index : text.length), next: m ? m.index + m[0].length : text.length + 1 };
  };
  const opening = nextLine(0);
  if (!/^---[ ]*$/.test(opening.line)) throwInvalid('no_frontmatter', '要以 --- 开头的 frontmatter 开始');
  const frontLines = [];
  let bodyAt = -1;
  for (let at = opening.next; at <= text.length && at - opening.next <= MAX_FRONTMATTER; ) {
    const { line, next } = nextLine(at);
    if (/^---[ ]*$/.test(line)) { bodyAt = Math.min(next, text.length); break; }
    frontLines.push(line);
    at = next;
  }
  if (bodyAt < 0) throwInvalid('unterminated', `的 frontmatter 没有结束的 ---（只往下找 ${MAX_FRONTMATTER} 个字符）`);
  const base = 1; // frontmatter 的第一行是 SKILL.md 的第 2 行
  const fields = {};
  const styles = {};
  for (let at = 0; at < frontLines.length; at++) {
    const line = frontLines[at];
    if (isBlank(line) || isComment(line)) continue;
    if (/^[ \t]/.test(line)) throwInvalid('syntax', '里有缩进的行，它不属于任何字段', base + at + 1);
    const m = KEY_RE.exec(line);
    if (!m) throwInvalid('syntax', '里这一行不是「字段名: 值」', base + at + 1);
    const key = m[1];
    if (Object.hasOwn(fields, key)) throwInvalid('duplicate_key', `里字段 ${key} 写了两次`, base + at + 1);
    const read = readValue(frontLines, at, m[2], base);
    fields[key] = read.value;
    styles[key] = read.style;
    if (read.style === 'map') for (const [childKey, childStyle] of Object.entries(read.childStyles)) styles[`${key}.${childKey}`] = childStyle;
    at = read.endLine;
  }
  return { fields, body: text.slice(bodyAt), styles };
}

// YAML 会把这些朴素标量读成数字、布尔、空值、日期。宁可多报：多报的只是要求加个引号。
const NON_STRING_PLAIN = [
  /^(?:~|null|Null|NULL)$/,
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][-+]?[0-9]+)?$/, // 整数和浮点（含前导 0、下划线）
  /^[-+]?0[xX][0-9a-fA-F_]+$/, /^[-+]?0[oO][0-7_]+$/, /^[-+]?0[bB][01_]+$/,
  /^[-+]?\.(?:inf|Inf|INF)$/, /^\.(?:nan|NaN|NAN)$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/, // 六十进制：1:30
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::?[0-9]{2})?))?)?$/, // 日期、时间戳
];
export const yamlReadsAsString = (plain) => !NON_STRING_PLAIN.some((re) => re.test(plain));

const length = (text) => [...text].length;
const problem = (reason, message, details = {}) => ({ code: 'skill_md_invalid', message: `SKILL.md ${message}`, details: { reason, ...details } });

/**
 * 按 Agent Skills 规范检查 SKILL.md，一次把问题都列出来。读不了就只有读的那一条问题。
 * @param {string} text
 * @param {{ expectedName?: string }} [options] expectedName：目录名（或包 ID），name 要和它一致
 * @returns {{ code: 'skill_md_invalid', message: string, details: { reason: string } }[]}
 */
export function skillMdProblems(text, options = {}) {
  let parsed;
  try {
    parsed = parseSkillMd(text);
  } catch (error) {
    if (isVoicePackError(error)) return [{ code: error.code, message: error.message, details: error.details }];
    throw error;
  }
  const { fields, styles } = parsed;
  const out = [];
  const stringField = (key, { min = 1, max, lengthReason } = {}) => {
    const value = fields[key];
    if (value === undefined) return null;
    if (typeof value !== 'string') { out.push(problem('type', `的 ${key} 要是一段文字`, { field: key })); return null; }
    if (styles[key] === 'plain' && !yamlReadsAsString(value)) out.push(problem('scalar_not_string', `的 ${key}: ${value} 会被 YAML 读成数字、布尔、空值或日期，要加引号`, { field: key }));
    if (lengthReason && (length(value) < min || length(value) > max)) out.push(problem(lengthReason, `的 ${key} 要 ${min}-${max} 个字符，这里有 ${length(value)} 个`, { field: key, length: length(value), min, max }));
    return value;
  };
  for (const key of Object.keys(fields)) if (!SKILL_FIELDS.includes(key)) out.push(problem('unknown_field', `的 frontmatter 只能用这几个字段：${SKILL_FIELDS.join('、')}；${key} 不在其中（版本号、所需能力写进清单）`, { field: key }));
  for (const key of ['name', 'description']) if (fields[key] === undefined) out.push(problem('missing_field', `的 frontmatter 缺必填的 ${key}`, { field: key }));

  const name = stringField('name');
  if (name !== null) {
    if (length(name) < 1 || length(name) > 64 || !NAME_RE.test(name)) out.push(problem('name_invalid', `的 name ${JSON.stringify(name)} 不合规：1-64 个字符，只用小写字母、数字和连字符，不以连字符开头或结尾，不连用连字符`, { field: 'name', name }));
    else if (options.expectedName !== undefined && name !== options.expectedName) out.push(problem('name_mismatch', `的 name ${JSON.stringify(name)} 和目录名 ${JSON.stringify(options.expectedName)} 不一致`, { field: 'name', name, expected: options.expectedName }));
  }
  stringField('description', { max: 1024, lengthReason: 'description_length' });
  stringField('license');
  stringField('compatibility', { max: 500, lengthReason: 'compatibility_length' });
  stringField('allowed-tools');
  const metadata = fields.metadata;
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== 'object') out.push(problem('type', '的 metadata 要是「键: 值」的映射，值都是字符串', { field: 'metadata' }));
    else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') out.push(problem('type', `的 metadata.${key} 要是字符串`, { field: `metadata.${key}` }));
        else if (styles[`metadata.${key}`] === 'plain' && !yamlReadsAsString(value)) out.push(problem('scalar_not_string', `的 metadata.${key}: ${value} 会被 YAML 读成数字、布尔、空值或日期，要加引号`, { field: `metadata.${key}` }));
      }
    }
  }
  return out;
}

// ---- 角色部分的骨架 ----

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const wellFormed = (text) => text.replace(LONE_SURROGATE, '�');
/** 写成 YAML 的双引号标量。JSON 的字符串写法是它的子集：\" \\ \n \t \uXXXX 两边含义相同。 */
const quote = (text) => JSON.stringify(wellFormed(text));
const clip = (text, max) => { const chars = [...text]; return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`; };
const code = (text) => `\`${text}\``;

/** 骨架能用的语言：zh 是默认，en 给英文界面的作者。不再加语言的话，从这里加，再给下面每一处 t(中文, 英文) 补上它的写法。 */
export const TEXT_LANGUAGES = Object.freeze(['zh', 'en']);

/**
 * 骨架的语言：不给就是 zh；不是 TEXT_LANGUAGES 里的值，抛 TypeError（调用方用错了，说明里点名选项和可用的值）。
 * buildRoleSkillMd 和 packRolePart 都先过它：调用方带了现成的 SKILL.md、用不上骨架时，写错的值照样被拒绝，不悄悄放过。
 * @param {unknown} value
 * @returns {'zh' | 'en'}
 * @throws {TypeError}
 */
export function resolveTextLanguage(value) {
  if (value === undefined) return 'zh';
  if (!TEXT_LANGUAGES.includes(value)) throw new TypeError(`textLanguage 必须是 ${TEXT_LANGUAGES.map((name) => `'${name}'`).join(' 或 ')}（骨架的语言），收到 ${JSON.stringify(value)}`);
  return value;
}

/** 一句话两种写法里选一种，和 app 的 t('中文', 'English') 是一个意思：中文、英文写在一起，改一边，另一边就在旁边。 */
const picker = (language) => (zh, en) => (language === 'en' ? en : zh);
/** 英文的个数：1 用单数。 */
const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

/** 放进 Markdown 正文的作者文字：折成一行，转义会被当成 Markdown 记号的字符（名字里写 [x](u) 不能变成链接）。 */
const md = (text) => wellFormed(text).replace(/\s+/g, ' ').trim().replace(/[\\`*_{}[\]<>#|~!]/g, '\\$&');

/** 参考集里某个标签（language、emotion、style……）出现过的取值，去重、排好序；没有标注就是空数组。 */
const tagValues = (manifest, key) => [...new Set(manifest.reference.segments.map((segment) => segment.tags[key]).filter((value) => typeof value === 'string' && value !== ''))].sort();

/**
 * 「能拿来做什么」里的步骤：放进环境、配音、（这个包有的话）增强件、脚本、变声。
 * 命令、选项和报告怎么读，只在基础部分的 SKILL.md「用音色包配音和变声」一节写一份（正本在那里），这里不写命令和选项，只指到那一节：
 * 命令行是基础部分的，它一改选项，写在协议核心里的用法就错了，协议核心还得跟着发版本。
 * 这里只写和这个包有关的几条；没有增强件、没有脚本、没有变声功能的包，就不提它们。
 */
function playSteps(manifest, t) {
  const labels = [['语言', 'language'], ['情绪', 'emotion'], ['风格', 'style']]
    .map(([title, key]) => [t(title, key), tagValues(manifest, key)])
    .filter(([, values]) => values.length > 0)
    .map(([title, values]) => t(`${title} ${values.map(md).join('、')}`, `${title}: ${values.map(md).join(', ')}`));
  const steps = [
    t(
      `**放进环境**：整个包目录（目录名是包 ID ${code(manifest.id)}）放进项目的 ${code('.agents/skills/')}（Codex、Gemini CLI、Cursor、OpenCode 等读这里），再复制一份到 ${code('.claude/skills/')}（Claude Code 读这里）。基础部分有一个命令把这两步一起做，而且先检查（包括官方签名）再放。`,
      `**Put it into the environment**: put the whole pack directory (its name is the pack ID ${code(manifest.id)}) into the project's ${code('.agents/skills/')} (read by Codex, Gemini CLI, Cursor, OpenCode and others) and copy it into ${code('.claude/skills/')} (read by Claude Code). The base part has a command that does both steps in one go, and it checks first (the official signature included).`,
    ),
    t(
      '**配音**：用基础部分的配音命令给台本配音，包就是这个目录。要用模型，先接上适配器：官方的给名字，自己的给模块文件，见基础部分 SKILL.md 的「接自己的模型」一节。真配音之前先预演一遍：看每一句会挑哪段参考、读音词表换了什么，不合成，不花钱。',
      `**Dub**: use the base part's dub command on a dubbing script; the pack is this directory. To use a model, connect an adapter first (an official one by name, your own by module file): see the section "接自己的模型" (connecting your own model) of the base part's SKILL.md. Before a real dub, rehearse it: it shows which reference segment each line will pick and what the pronunciation lexicon changes, and it synthesizes nothing and costs nothing.`,
    ),
    t(
      `**写台本**：照最后一节「配音指引」写，指引里的语气、节奏、口头禅落在台本上；情绪和风格用括号提示，例如 ${code('（耳语）')}、${code('（生气）')}，会挑到参考集里对得上的那一段，没有对得上的用默认参考。`,
      `**Write the dubbing script**: follow the last section, the voice guidance, so that its tone, pace and verbal habits show in the script. Mark emotion and style with a bracketed stage direction, for example ${code('(whisper)')} or ${code('(angry)')}: the line then uses the matching segment of the reference set, or the default reference when none matches.`,
    ),
    t(
      `**参考集里有的标签**：${labels.length > 0 ? labels.join('；') : '没有标注语言、情绪、风格'}。括号提示和这些标签对得上才会换参考（近义词也认）。`,
      `**Labels in the reference set**: ${labels.length > 0 ? labels.join('; ') : 'no language, emotion or style is labeled'}. A stage direction switches the reference only when it matches one of these labels (synonyms count too).`,
    ),
  ];
  const enhancers = manifest.enhancers ?? [];
  if (enhancers.length > 0) {
    const ids = enhancers.map((item) => code(item.id));
    steps.push(t(
      `**增强件**：包里有 ${ids.join('、')}，只对特定的模型有效。运行环境有对应的模型就自动用上，没有就照常生成，输出里会明说这次没用增强件。`,
      `**Enhancers**: the pack has ${ids.join(', ')}; each works only with a specific model. When the environment has the matching model, it is used automatically; when it does not, generation goes on as usual and the output says plainly that no enhancer was used this time.`,
    ));
  }
  const scripts = manifest.scripts ?? [];
  if (scripts.length > 0) {
    const runtimes = [...new Set(scripts.map((item) => item.runtime))].map(code);
    steps.push(t(
      `**脚本**：包里登记了 ${scripts.length} 个脚本（运行时：${runtimes.join('、')}），登记在配音功能名下的会在配音时直接运行，不会问你，也不隔离。运行环境缺脚本要的运行时，配音在开始之前就报错，点名缺的是哪个。`,
      `**Scripts**: the pack registers ${plural(scripts.length, 'script')}, programs the author put in it (runtimes: ${runtimes.join(', ')}). The ones registered under the dub feature run directly when dubbing, without asking you and without isolation. When the environment lacks a runtime a script needs, dubbing fails before it starts and names the missing one.`,
    ));
  }
  if (Object.hasOwn(manifest.features ?? {}, 'convert')) {
    steps.push(t(
      `**变声和唱歌**：用基础部分的变声命令，把一段音频换成这个声音；唱歌也走它（输入要是人声分轨）。运行环境要有 ${code('voice-conversion')} 或 ${code('singing-voice-conversion')}，缺哪一项只有对应的那个报错。`,
      `**Voice conversion and singing**: use the base part's voice conversion command to turn a piece of audio into this voice; singing goes through it too (the input must be a separated vocal track). The environment needs ${code('voice-conversion')} or ${code('singing-voice-conversion')}; whichever is missing, only the use that needs it reports an error.`,
    ));
  }
  const intro = t(
    `命令怎么写、有哪些选项、报告怎么读，见基础部分 ${code('voice-pack/SKILL.md')} 的「用音色包配音和变声」一节。这个包的要点：`,
    `How to write the commands, which options there are and how to read the reports: see the section "用音色包配音和变声" (dubbing and voice conversion with a voice pack) of the base part's ${code('voice-pack/SKILL.md')}; that file is written in Chinese. What matters for this pack:`,
  );
  return [intro, '', ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
}

/**
 * 「没有基础部分时怎么补全」一节：做实了的步骤，命令是 protocol/cli.mjs 的 complete（protocol/cli/commands/complete.mjs）。
 * 规则和理由的正本是 protocol/FORMAT.md 的「补全」一节，这里只写 agent 要照着做的，不重抄。
 * 不提 --trust：它是测试和第三方换信任名单用的，官方的补全不传；agent 看见它，遇到验签不过可能顺手去换名单（理由同不提 allow-unsigned）。
 */
function completeSteps(manifest, t) {
  const { baseMin, protocolMajor } = manifest.requires;
  const lines = [
    t(
      `只有角色部分、环境里又没有可用的基础部分时，先补全。「可用」要三条都成立：官方版本（基础部分和它里面的协议核心，两份清单都是官方公钥签的）、协议主版本是 ${protocolMajor}、版本不低于 ${baseMin}。`,
      `When you have only the role part and the environment has no usable base part, complete the pack first. "Usable" means all three hold: it is an official version (the base part and the protocol core inside it, both manifests signed with the official public key), its protocol major version is ${protocolMajor}, and its version is not lower than ${baseMin}.`,
    ),
    '',
    t(
      `1. 在本目录里运行 ${code('node protocol/cli.mjs complete .')}。有本目录里的协议核心（${code('protocol/')}）就能跑，不用先有基础部分。`,
      `1. Run ${code('node protocol/cli.mjs complete .')} in this directory. The protocol core in this directory (${code('protocol/')}) is enough to run it; no base part is needed first.`,
    ),
    t(
      `2. 它先找环境里已有的基础部分：和本包放在同一个 skill 目录里的 ${code('voice-pack/')}，项目的 ${code('.agents/skills/')}，项目的 ${code('.claude/skills/')}。有可用的就直接用：不下载，不写任何东西，输出里写明用的是哪一份。`,
      `2. It first looks for a base part already in the environment: ${code('voice-pack/')} in the same skill directory as this pack, then the project's ${code('.agents/skills/')}, then the project's ${code('.claude/skills/')}. A usable one is used as it is: nothing is downloaded, nothing is written, and the output says which one was used.`,
    ),
    t(
      `3. 都没有可用的，才去官方地址（${code('protocol/trust.json')} 里的 ${code('official_url')}）读版本索引，取同一个主版本里、不低于 ${baseMin} 的最高版本，下载它，用协议核心里的官方公钥验签，通过后放进本目录的 ${code('voice-pack/')}。这一份只属于这个包，不改环境里共用的那一份。`,
      `3. Only when none is usable does it read the version index at the official address (${code('official_url')} in ${code('protocol/trust.json')}), take the highest version of the same major version that is not lower than ${baseMin}, download it, verify its signature with the official public key in the protocol core, and put it into ${code('voice-pack/')} in this directory. That copy belongs to this pack alone; the copy the environment shares is not changed.`,
    ),
    t(
      `4. 放好以后，对整个包再检查一遍：每个文件对清单、验签、和基础部分的互相校验、外部资源。全部通过才算补全成功，输出里写「已补全」。之后配音等，用基础部分，命令见它的 ${code('voice-pack/SKILL.md')}。`,
      `4. Once it is in place, the whole pack is checked again: every file against the manifest, the signatures, the mutual check with the base part, and the external resources. Only when everything passes is the completion a success, and the output says the pack is completed. After that, dub and so on with the base part; its commands are in ${code('voice-pack/SKILL.md')}.`,
    ),
    '',
    t(
      `补不成就报错，输出里写明是哪一步（读官方的版本索引、挑版本、取官方的基础部分、检查补全后的整个包），而且不兜底：不换别的版本，不跳过验签，不留下半个 ${code('voice-pack/')}。几种常见的错误：`,
      `When the completion cannot be done it fails, and the output names the step (reading the official version index, picking a version, fetching the official base part, checking the whole pack after the completion). It does not fall back: it does not take another version, does not skip the signature check and does not leave half a ${code('voice-pack/')} behind. The command prints its messages in Chinese; the error codes are in English. The common ones:`,
    ),
    '',
    t(
      `- ${code('official_unpublished')}：官方地址上还没有发布任何版本。`,
      `- ${code('official_unpublished')}: no version has been published at the official address yet.`,
    ),
    t(
      `- ${code('base_version_unavailable')}：官方地址上有版本，但没有符合这个包要求的（输出里写着要的是什么、现有哪些）。`,
      `- ${code('base_version_unavailable')}: there are versions at the official address, but none fits what this pack requires (the output says what is required and what exists).`,
    ),
    t(
      `- ${code('release_invalid')}、${code('signature_*')}：下载来的版本和版本索引里写的对不上，或者不是官方签的。`,
      `- ${code('release_invalid')}, ${code('signature_*')}: the downloaded version does not match what the version index says, or it is not officially signed.`,
    ),
    t(
      `- ${code('published_unreadable')}：官方地址读不了（网络出错、服务器出错）。等一会儿再运行一次。`,
      `- ${code('published_unreadable')}: the official address cannot be read (a network or server error). Wait a while and run it again.`,
    ),
    t(
      `- ${code('in_pack_base_unusable')}：本目录里已经有 ${code('voice-pack/')}，但不能用（版本太低、不是官方版本……）。补全不覆盖它：告诉用户，要不要把它移走由用户定。`,
      `- ${code('in_pack_base_unusable')}: ${code('voice-pack/')} is already in this directory but cannot be used (version too low, not an official version, ...). The completion does not overwrite it: tell the user; whether to move it away is the user's decision.`,
    ),
    '',
    t(
      `遇到报错，把输出原样告诉用户。不要自己去别处找一份基础部分放进 ${code('voice-pack/')}：只认官方版本，别处来的过不了验签。`,
      `When an error comes up, pass the output on to the user as it is. Do not look for a base part somewhere else and put it into ${code('voice-pack/')}: only official versions are accepted, and one from anywhere else fails the signature check.`,
    ),
  ];
  return lines.join('\n');
}

/**
 * 「怎么做新包」一节的步骤：做实了的流程，四步的次序和每一步为什么这样（净室、查重）。
 * 每一步的命令和选项只在基础部分的 SKILL.md「做音色包」一节写一份，这里不写，只指到那一节（理由同 playSteps）。
 * 流程、每个字段怎么写、查重比什么的正本是 protocol/new-pack/README.md，查重的规则和阈值的正本是基础部分的 lib/duplicate-check.mjs，这里只写 agent 要照着做的，不重抄。
 * 这一节要堵的是「读过来源包的 agent 自己去写新包」：它读到的会漏进新写的文字里，所以第 2 步明说当前这个 agent 不写，要交给一个看不到来源包的新会话或子 agent；
 * 这个环境里装着的 skill，说明文字（里面有音色描述）会自动载入会话，所以还要说新会话得开在读不到这个包的地方。查重是最后一道关，不是净室的替代。
 */
function makeSteps(t) {
  return [
    t('做新包分四步，次序不能换：', 'Making a new pack takes four steps, and the order must not change:'),
    '',
    t(
      '1. **先生成净室输入**（这一步不读这个包的角色内容）：用基础部分的净室命令，把设计词表里的标签、场景词表里的场景和使用者自己的话放进一个新目录。使用者的话原样放进去：不改写，也不把这个包里的描述、指引、台词贴进去。净室输入目录建在本目录外面。',
      '1. **First generate the clean-room input** (this step does not read the role content of this pack): use the base part\'s clean-room command to put the labels from the design vocabulary, the scenes from the scene vocabulary and the user\'s own words into a new directory. Put the user\'s words in as they are: do not rewrite them, and do not paste the description, guidance or lines of this pack into it. Create the clean-room input directory outside this directory.',
    ),
    t(
      `2. **把这个目录交给一个新会话或子 agent，由它写新包的文字内容**：只给它净室输入目录，它照里面的 ${code('BRIEF.md')} 把描述、配音指引、示例台词写进 ${code('output/')}。**当前这个 agent 不写**：你读过这个包（它的清单、指引、台词），读到的会漏进新写的文字里。新会话要开在读不到这个包的地方：这个包装在 ${code('.agents/skills/')} 或 ${code('.claude/skills/')} 里（项目的，或用户级的）时，它的说明文字（里面有音色描述）会自动载入读到它的会话，那就不是净室，先告诉使用者，不要说成是净室做的。`,
      `2. **Hand that directory to a new session or a sub-agent, which writes the text of the new pack**: give it only the clean-room input directory; following the ${code('BRIEF.md')} in it, it writes the description, the voice guidance and the sample lines into ${code('output/')}. **The current agent does not write them**: you have read this pack (its manifest, guidance and lines), and what you read would leak into the new text. Open the new session where this pack cannot be read: when this pack is installed in ${code('.agents/skills/')} or ${code('.claude/skills/')} (the project's or the user's), its description text (which holds the voice description) is loaded automatically into any session that reads it, so that is not a clean room; tell the user first, and do not describe it as made in a clean room.`,
    ),
    t(
      '3. **备素材**：使用者自己的录音，或者设计一个声音。不用这个包里的录音。',
      '3. **Prepare the material**: the user\'s own recordings, or design a voice. Do not use the recordings in this pack.',
    ),
    t(
      `4. **做包，同时查重**：用基础部分的做包命令，交给它素材和第 2 步写进 ${code('output/')} 的文件，并把这个包（本目录）交给它当来源包。来源包只在这一步读：在花钱的几步（转写、打标签、试合成）之前，把新包的文字和录音同它比一遍，重合太多报 ${code('duplicate_detected')}，说明是哪一项，改成自己的话或换掉录音再做。要转写、试合成，先接上适配器（见基础部分 SKILL.md 的「接自己的模型」一节）；设计出来的声音再交设计来源。`,
      `4. **Make the pack, with the duplicate check**: use the base part's make-pack command; give it the material and the files written into ${code('output/')} in step 2, and give it this pack (this directory) as the source pack. The source pack is read in this step only: before the steps that cost money (transcription, labeling, trial synthesis), the text and recordings of the new pack are compared with it, and when they overlap too much it reports ${code('duplicate_detected')} and says which item; put that in your own words or replace the recordings, then make it again. For transcription and trial synthesis, connect an adapter first (see the section "接自己的模型" (connecting your own model) of the base part's SKILL.md); for a designed voice, also give the design source.`,
    ),
    '',
    t(
      `新包用新的包 ID；清单只记做包用的基础部分的版本，没有这个包的记录，查重也不把这个包的名字、包 ID、路径写进新包、日志和报告。每一步的命令和选项见基础部分 ${code('voice-pack/SKILL.md')} 的「做音色包」一节；流程、每个字段怎么写、查重比什么，见 ${code('protocol/new-pack/README.md')}。`,
      `The new pack gets a new pack ID; its manifest records only the version of the base part used to make it and has no record of this pack, and the duplicate check does not write the name, pack ID or path of this pack into the new pack, the logs or the reports. The command and options of every step are in the section "做音色包" (making a voice pack) of the base part's ${code('voice-pack/SKILL.md')}; the flow, how to write each field and what the duplicate check compares are in ${code('protocol/new-pack/README.md')}.`,
    ),
  ].join('\n');
}

/**
 * 中文骨架里，作者没写指引时放在标记行下面的提示。读指引的程序把它读成没写（null），所以这一段的字不能随便改：已发布的基础部分（1.0.0 起）按这段字认「没写」，
 * 改了字，老版本读新包就会把它当成作者写的指引。英文骨架不放它，见 buildRoleSkillMd。
 */
export const GUIDANCE_HINT = [
  '作者在这里写配音指引：agent 给台本配音时照着这一节做。只写意图，也就是想要达到的效果，不用某个模型的指令语法。可以写：',
  '',
  '- 语气：整体是什么感觉',
  '- 节奏：快慢、停顿、句尾怎么收',
  '- 情绪：不同情绪下怎么变化',
  '- 口头禅和常用的语气词',
  '- 适合哪些场景，不适合哪些场景',
].join('\n');

/**
 * 骨架里放配音指引的那一节的标题，也是读指引的标记行：协议的一部分，和 JSON 的键名一样，所有语言的骨架都原样写它，不翻译（理由和写法见 protocol/FORMAT.md「骨架的语言」）。
 * 生成（buildRoleSkillMd）和读回来（extractGuidance）用同一个，两边不会各写各的。
 */
export const GUIDANCE_HEADING = '## 配音指引';

/**
 * 把作者写的配音指引从角色部分的 SKILL.md 里读回来（buildRoleSkillMd 的 guidance 选项的反向）。
 * 取骨架里第一个「## 配音指引」标题后面的全部内容，去掉开头的空行和末尾的空白；作者在指引里自己又写了同样的标题，也算指引的一部分。
 * 没有这一节、这一节是空的、或者还是骨架里的写法提示（作者没写），给 null。换行 \n 和 \r\n 都认，内容里的换行原样保留。
 * @param {string} text SKILL.md 的整个文件（已经按 UTF-8 解码）
 * @returns {string | null}
 */
export function extractGuidance(text) {
  if (typeof text !== 'string') throw new TypeError('SKILL.md 的内容必须是字符串');
  const lines = text.split(/(?<=\n)/); // 每行带着自己的换行，取出来的内容就能原样拼回去
  const at = lines.findIndex((line) => line.replace(/\r?\n$/, '').replace(/[ \t]+$/, '') === GUIDANCE_HEADING);
  if (at === -1) return null;
  const guidance = lines.slice(at + 1).join('').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  return guidance === '' || guidance === GUIDANCE_HINT ? null : guidance;
}

/**
 * 生成角色部分的 SKILL.md 骨架：frontmatter 合规，name 等于包 ID；
 * 各节写清楚：这是谁的声音，能拿来做什么，需要哪个版本的基础部分，没有时怎么补全，怎么做新包；正文是配音指引。
 * 「能拿来做什么」「没有时怎么补全」「怎么做新包」写的都是做实了的步骤（放进环境、配音，按这个包有什么再写增强件、脚本、变声；补全用 protocol/cli.mjs 的 complete 命令；
 * 做新包先生成净室输入、交给新会话去写、再做包并查重）。基础部分命令行的命令和选项不写在这里：只指到基础部分的 SKILL.md，用法只在那里写一份。
 * 同样的输入生成同样的文字（LF 换行，末尾一个换行）。
 * 语言：options.textLanguage 是 'zh'（不给就是它）或 'en'，由调用方按作者的语言给（例如 app 给作者做包时用的界面语言），不给就是中文。
 * 两种语言的版面一样：同样的节、同样的步骤、同样的命令和文件名；只有标题和说明的语言不同，英文的 frontmatter 也只有英文。
 * 例外只有一处，也是协议的一部分：「## 配音指引」这一行（GUIDANCE_HEADING）所有语言都原样写，不翻译，读指引的程序（extractGuidance、基础部分 1.0.0 起的读法）认的就是这一整行，
 * 所以任何语言的包，任何版本的基础部分读回来的指引都一样，不用给英文的包定更高的基础部分最低版本。随之两条：
 *   英文骨架解释最后一节是什么的那一段写在标记行的上面（写在下面会被当成指引读回去）；
 *   作者没写指引时，中文骨架在标记行下面放 GUIDANCE_HINT（读回来是 null），英文骨架什么都不放（一段英文的提示 1.0.0 认不出，会被当成指引）。
 * 规则的正本是 protocol/FORMAT.md「骨架的语言」。
 * 读的是清单草稿（做包和 seal 要先有 SKILL.md，它自己要列进 files，所以那时清单还写不出来）：草稿来自作者给的描述，先查结构，
 * 字段的类型不对（features 写成字符串、参考段里有 null、没写名字……）抛 manifest_invalid，不让它在下面生成文字时变成 TypeError。
 * @param {object} manifest 角色部分的清单（至少要有 part、id、name、version、madeWith、requires、features、reference）
 * @param {{ guidance?: string, textLanguage?: 'zh' | 'en' }} [options] guidance：作者写的配音指引（Markdown），没有就按语言放提示或什么都不放（见上）；textLanguage：骨架的语言，默认 'zh'
 * @returns {string}
 * @throws {VoicePackError} manifest_invalid（草稿的结构不合格，details.problems 是完整的问题清单，见 manifest.mjs 的 assertDraftManifest）
 * @throws {TypeError} manifest 不是角色部分的清单（part 不是 role），guidance 不是字符串，textLanguage 不是 'zh' 或 'en'：调用方用错了
 */
export function buildRoleSkillMd(manifest, options = {}) {
  if (manifest === null || typeof manifest !== 'object' || manifest.part !== 'role') throw new TypeError('要角色部分的清单（part 是 role）');
  const { guidance } = options;
  if (guidance !== undefined && typeof guidance !== 'string') throw new TypeError('guidance 必须是字符串');
  const language = resolveTextLanguage(options.textLanguage);
  const t = picker(language);
  assertDraftManifest(manifest);
  const name = wellFormed(manifest.name);
  const features = Object.entries(manifest.features ?? {});
  const capabilities = [...new Set(features.flatMap(([, feature]) => feature.capabilities))];
  const direction = manifest.direction ?? {};
  const languages = [...new Set(manifest.reference.segments.map((s) => s.tags.language))].sort();

  // frontmatter 的 description：中文骨架是中文一段加英文一段（agent 按它匹配任务，两种语言的请求都要匹得上）；英文骨架只有英文，一段。
  // 作者的音色描述放不下时先截它（room 是别的部分用完以后剩下的字数）。
  const sentence = (text) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`); // 英文：描述自己带了句号就不再加
  const wording = t(
    {
      head: `这是「${name}」的音色包（voice pack）。`,
      middle: direction.description ? `${direction.description}。` : '',
      use: '用它的声音给台本配音，或照它做一个新的音色包。',
      tail: ` Voice pack of "${name}": use it to dub or read scripts in this voice, and to make a new voice pack. Use when asked to speak, dub or read aloud in the voice of ${name}, or to make a voice pack from it.`,
    },
    {
      head: `Voice pack of "${name}". `,
      middle: direction.description ? `${sentence(direction.description)} ` : '',
      use: `Use it to dub or read scripts in this voice, and to make a new voice pack. Use when asked to speak, dub or read aloud in the voice of ${name}, or to make a voice pack from it.`,
      tail: '',
    },
  );
  const room = 1024 - length(wording.head) - length(wording.use) - length(wording.tail) - 1;
  const description = `${wording.head}${clip(wording.middle, Math.max(room, 0))}${wording.use}${wording.tail}`;

  const required = capabilities.length > 0 ? capabilities.join(', ') : '(none)';
  const compatibility = t(
    `需要基础部分 voice-pack ${manifest.requires.baseMin} 或更高（协议主版本 ${manifest.requires.protocolMajor}）；所需能力：${clip(required, 300)}。Requires the voice-pack base part >= ${manifest.requires.baseMin} (protocol ${manifest.requires.protocolMajor}.x).`,
    `Requires the voice-pack base part ${manifest.requires.baseMin} or later (protocol ${manifest.requires.protocolMajor}.x); required capabilities: ${clip(required, 300)}.`,
  );

  const segmentCount = manifest.reference.segments.length;
  const sampleLineCount = manifest.sampleLines?.length ?? 0;
  const who = [
    t(`- 名字：${md(name)}`, `- Name: ${md(name)}`),
    t(
      `- 包 ID：${code(manifest.id)}（目录名、SKILL.md 的 name、清单的 id 三处一致，以后不改）`,
      `- Pack ID: ${code(manifest.id)} (the same in the directory name, the name in SKILL.md and the id in the manifest; it never changes)`,
    ),
    t(`- 版本：${manifest.version}`, `- Version: ${manifest.version}`),
    ...(direction.description ? [t(`- 音色：${md(direction.description)}`, `- Voice: ${md(direction.description)}`)] : []),
    ...(direction.tags?.length ? [t(`- 音色标签：${direction.tags.map(md).join('、')}`, `- Voice tags: ${direction.tags.map(md).join(', ')}`)] : []),
    ...(direction.scenes?.length ? [t(`- 适合的场景：${direction.scenes.map(md).join('、')}`, `- Suitable scenes: ${direction.scenes.map(md).join(', ')}`)] : []),
    t(
      `- 参考集：${segmentCount} 段，语言 ${languages.join('、')}；默认参考段 ${code(manifest.reference.defaultSegment)}`,
      `- Reference set: ${plural(segmentCount, 'segment')}, ${languages.length === 1 ? 'language' : 'languages'} ${languages.join(', ')}; default reference segment ${code(manifest.reference.defaultSegment)}`,
    ),
    // 示例台词只写有几句、在哪里：台词在清单里写全一处，这里不抄（改了清单，SKILL.md 不用跟着改）
    ...(sampleLineCount > 0 ? [t(`- 示例台词：${sampleLineCount} 句，在清单的 ${code('sampleLines')} 里`, `- Sample lines: ${plural(sampleLineCount, 'line')}, in ${code('sampleLines')} of the manifest`)] : []),
  ];
  const table = features.length > 0
    ? [
      t('| 功能 | 所需能力 |', '| Feature | Required capabilities |'),
      '|---|---|',
      ...features.map(([feature, { capabilities: list }]) => `| ${code(feature)} | ${list.length > 0 ? list.map(code).join(t('、', ', ')) : t('（不需要所需能力）', '(none needed)')} |`),
    ]
    : [t('（这个包没有列出功能。）', '(This pack lists no features.)')];

  // 英文骨架里讲「配音指引」一节是什么的一段。中文骨架用不着它：那一节的标题就是中文，下面还有一段提示。
  // 它必须写在标记行的上面：标记行下面的全部内容都会被当成指引读回去。里面提到标记行，是写成行内代码，不独占一行（独占一行就成了第二个标记行）。
  const guidanceNote = `After this comes the last section, the voice guidance. Its heading line ${code(GUIDANCE_HEADING)} is the marker the base part finds the guidance by: it is the same in every language and is never translated, so keep it exactly as it is. Everything below that line, to the end of the file, is the author's voice guidance, which an agent follows when it dubs; it holds only the intent, the effect wanted (tone, pace, emotion, verbal habits, suitable scenes), not the instruction syntax of a particular model. If nothing follows the marker line, the author has not written any voice guidance yet.`;

  const body = [
    `# ${md(name)}`,
    '',
    t(
      `这是「${md(name)}」的音色包的角色部分：一个声音的参考集和配音指引。它要和基础部分（${code('voice-pack/')}，通用的流程、协议核心、词表）一起用。`,
      `This is the role part of the voice pack "${md(name)}": one voice's reference set and voice guidance. It is used together with the base part (${code('voice-pack/')}: the shared flows, the protocol core and the vocabularies).`,
    ),
    '',
    t('## 这是谁的声音', '## Whose voice this is'),
    '',
    ...who,
    '',
    t('## 能拿来做什么', '## What it can be used for'),
    '',
    t(
      '每个功能需要的所需能力如下。运行环境缺哪一项，只有用到它的功能报错并说明缺的是什么，其他功能照常。',
      'The required capabilities of each feature are listed below. When the environment lacks one, only the features that use it fail, and the error says what is missing; the other features work as usual.',
    ),
    '',
    ...table,
    '',
    playSteps(manifest, t),
    '',
    t('## 需要哪个版本的基础部分', '## Which version of the base part it needs'),
    '',
    t(
      `- 基础部分的协议主版本：${manifest.requires.protocolMajor}（协议版本在 ${manifest.requires.protocolMajor}.x 内兼容）`,
      `- Protocol major version of the base part: ${manifest.requires.protocolMajor} (protocol versions are compatible within ${manifest.requires.protocolMajor}.x)`,
    ),
    t(`- 基础部分的最低版本：${manifest.requires.baseMin}`, `- Minimum version of the base part: ${manifest.requires.baseMin}`),
    t(`- 做这个包时用的基础部分版本：${manifest.madeWith.baseVersion}`, `- Version of the base part this pack was made with: ${manifest.madeWith.baseVersion}`),
    t('- 基础部分只认官方版本（Ed25519 签名）。', '- The base part accepts official versions only (Ed25519 signature).'),
    '',
    t('## 没有基础部分时怎么补全', '## Completing the pack when the base part is missing'),
    '',
    completeSteps(manifest, t),
    '',
    t('## 怎么做新包', '## How to make a new pack'),
    '',
    t(
      `每个部分都带着协议核心（${code('protocol/')}），所以拿到这个包就能做新的音色包。新包用新的包 ID，和这个包没有关联。做包的 agent 只拿到协议核心里的抽象规格和空白模板，不读这个包的角色内容（净室）；想参考这个包，就自己说出想要的属性。`,
      `Every part carries the protocol core (${code('protocol/')}), so with this pack you can make a new voice pack. The new pack gets a new pack ID and has no link to this one. The agent that makes it gets only the abstract specification and the blank templates in the protocol core and does not read the role content of this pack (a clean room); to take this pack as a reference, say the attributes you want in your own words.`,
    ),
    '',
    makeSteps(t),
    '',
    ...(language === 'en' ? [guidanceNote, ''] : []),
    GUIDANCE_HEADING,
    // 标记行下面：作者写了就是指引；没写，中文放提示（读回来是 null），英文什么都不放
    ...(guidance !== undefined ? ['', guidance.replace(/\s+$/, '')] : language === 'zh' ? ['', GUIDANCE_HINT] : []),
  ].join('\n');

  return `---\nname: ${quote(manifest.id)}\ndescription: ${quote(description)}\ncompatibility: ${quote(compatibility)}\n---\n\n${body}\n`;
}
