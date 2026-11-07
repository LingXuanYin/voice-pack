// SPDX-License-Identifier: Apache-2.0
//
// 读音词表（流程层）：读 W3C 的发音词典（Pronunciation Lexicon Specification 1.0，PLS，https://www.w3.org/TR/pronunciation-lexicon/），
// 在合成之前把台词里的词换成期望的读法。只做计算，不用模型，不读文件。
//
// 几个函数，数据进、数据出：
//   parseLexicon(input)          把 PLS 文件（字符串，或 UTF-8 字节）读成 { version, alphabet, language, lexemes }
//   lexiconRules(lexicon, opts)  按 PLS 4.9.2 给每个词选定读法 -> { rules, phonemes, unapplied }
//                                （opts.phonemeMarkers：环境声明了 phoneme-markers，音素写成音素标签；opts.phonemeInText：只声明了 phoneme-in-text，拼音写成 SSML）
//   applyLexicon(text, rules)    把规则用到台词上 -> { text, replacements }
//   applyPhonemes(spoken, phonemes, { ssml })  拼音写成 SSML 的 <phoneme>（只声明了 phoneme-in-text 的环境，发送前）
//   singleCharacterTerms(lexicon)、isSingleCharacterTerm(term)、singleCharacterNote(terms)、lexiconNotes(input)   只写一个字的词条和它的提醒（下面「只写一个字的词条」；lexiconNotes 是做包用的）
//
// 包里的读音词表放在角色部分的根上，文件名是 LEXICON_FILE（lexicon.pls）。清单没有专门的字段：它和别的包内文件一样列在 files 里，
// 由检查核对哈希；这个名字是约定，包的读取、做包、app 导入导出都认它。
//
// ---------------------------------------------------------------- 为什么自己写解析器
// 浏览器有 DOMParser，Node 没有，库又不许引第三方依赖，所以这里只认 PLS 需要的那一小部分 XML。读不懂的就报错（lexicon_invalid），
// 不悄悄忽略：悄悄忽略的话，作者写的读音就默默不起作用了。details.reason 说明哪种情况，details.line 是出问题的行（有的话）。
//
// 认的 XML：
//   XML 声明（只能在最开头，版本 1.0，编码只能是 UTF-8）、注释、元素和属性、CDATA、命名空间（默认命名空间和前缀都行）、
//   五个预定义实体（&amp; &lt; &gt; &quot; &apos;）和数字字符引用。字符串开头的 BOM 去掉；换行统一成 LF。
// 不认的（一律报错）：
//   DOCTYPE（doctype；也就没有自定义实体）、XML 声明以外的处理指令（processing_instruction）、预定义以外的实体和不合法的字符引用（entity）、
//   控制字符（invalid_character）、嵌套超过 100 层（too_deep）、超过 1 MiB（too_large）、不是 UTF-8 的字节（not_utf8）、
//   声明了别的编码（encoding_unsupported）、没有内容（empty）。格式本身的错：syntax、unclosed、mismatched_tag、undefined_prefix、content_after_root。
//
// ---------------------------------------------------------------- PLS 的结构（规范第 4 节）
//   <lexicon version="1.0" xml:lang="…" alphabet="…" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon">
//     <meta name|http-equiv content/>*  <metadata>任意内容，读音不看它</metadata>?  <lexeme>*
//   <lexeme xml:id? role?>：至少一个 <grapheme>（词的写法），至少一个 <phoneme prefer? alphabet?>（音素）或 <alias prefer?>（用别的写法替换），
//     零个或多个 <example>（例句）；子元素顺序不限，但顺序影响选哪个读法。
//   version、xml:lang、alphabet 三个必填（规范第 4.1 节）；根上还可以有 xml:base 和 xsi:schemaLocation，读但不用。
//   grapheme、phoneme、alias、example 里只能是文字，不能再有标签（element_in_text）。内容两头的空白去掉，里面的连续空白折成一个空格；
//   grapheme、alias、phoneme、example 的内容不能是空的（empty_text）。
//   其余不认识的元素（unknown_element）、属性（unknown_attribute）、顺序（element_order）、缺必填项（attribute_missing）、值不合法（attribute_invalid）
//   都报错；根不是 lexicon（root_not_lexicon）、命名空间不对（wrong_namespace）、version 不是 1.0（version_unsupported）也是。
//
// ---------------------------------------------------------------- 怎么选读法（lexiconRules）
// 规范 4.9.2：同一个词（grapheme 的文字）的所有读法，按文档里的先后收在一起（跨 lexeme）；用第一个 prefer="true" 的，一个都没有就用第一个。
//   - 选中的是 <alias>：词表的规则是「把这个词换成 alias 的文字」。规范要求 alias 不递归（换出来的文字不再查词表），applyLexicon 一次扫描完成，保证这点。
//   - 选中的是 <phoneme>：音素要合成的模型自己会读才行，用不用由环境的声明定：
//     声明了 phoneme-markers（模型认文字里的音素标签），拼音（x-pinyin）、Arpabet（x-arpabet）、日文罗马字（x-romaji）写对的成了一条规则：把这个词换成音素标签（下面「音素标签」），
//     和 alias 一样由 applyLexicon 一次扫描换掉；只声明了 phoneme-in-text，拼音写对的进 phonemes，发送前 applyPhonemes 写成 SSML（下面「拼音音素」）。
//     别的情况（环境没有声明、字母表这个环境不收）如实列在 unapplied（reason: 'phoneme'），不假装做了，也不悄悄换成别的 alias（作者要的是音素）；
//     环境收这种字母表、写法不对的，reason 是 'phoneme_format'。
//   - lexeme 带 role（词性之类，按上下文挑读法用）：这里没有语法信息，没法判断这句话里是不是那个词性；列在 unapplied（reason: 'role'），不当成没有这条，
//     也不一律照用（read 的现在时和过去时读法不同，照用会把另一半读错）。
// 环境的 pronunciation-lexicon 能力（vocab/capabilities.json）是合成器自己支持词表的意思，这里不用它：词表对 alias 在文字层面生效，不依赖环境。
//
// ---------------------------------------------------------------- 怎么用到台词上（applyLexicon）
//   - 只替换台本标记和提示以外的文字，不改标记，也不碰方括号里的提示。标记和提示的写法取自解析器自己的正则（tools/markup.mjs 的 MARKER_PATTERN）。
//     不这样的话，词表里有 pause → break，[pause 1s] 就变成 [break 1s]，停顿没了；[voice:Alice] 加 Alice → Ali，声音名对不上；
//     提示 [Mira 笑着] 里的 Mira 也会被换掉，提示就不是作者写的了。音素（音素标签、SSML 的 applyPhonemes）同样不进提示。
//   - 尖括号标签（tools/markup.mjs 文件头「尖括号标签」）也不碰：标签本身（<whisper>、</french>、<|speaker:0|>）和整个音素标记（<|phoneme_start|>…<|phoneme_end|>）。
//     不这样的话，词表里有 whisper → whispa，<whisper> 就成了 <whispa>，模型不认；音素标记里的字母是音素，不是词。成对标签包住的字是要念的话，照样换
//     （<emphasis>Mira</emphasis> 换成 <emphasis>Meera</emphasis>）。写法取自 tools/markup.mjs 的 TAG_PATTERN。
//     音素标签（phoneme-markers）就是一条替换，换出来的标签不转义，句子里别的尖括号标签照样到模型。
//     例外在 applyPhonemes（SSML 的拼音音素，只声明了 phoneme-in-text 的环境才用）：一句用上了音素，整句转义、包一层 <speak>，句子里的尖括号标签也转义了，到不了模型。
//   - 区分大小写：PLS 的 grapheme 是照写法对的，要两种写法就写两个 grapheme。
//   - 词条是拉丁字母这类分词的文字时按整词匹配（Mira 换，Miranda 不动）；词条的两头是汉字、假名、谚文、泰文这类不分词的文字，按子串匹配。
//     拉丁词挨着汉字不算在词内（「我喜欢Mira这个人」里的 Mira 能换）。
//   - 同一位置几个词条都能匹配时，长的优先（New York City 先于 New York）。整段台词一次扫描，换出来的文字不会再被别的词条处理。
//   - 替换文是普通文字：$& 之类不会被当成替换语法。
//
// ---------------------------------------------------------------- 只写一个字的词条
// 词条两头是汉字这类不分词的字时按子串找，所以只写一个字（「曾」）会把含这个字的每个词都换掉（「曾经」「不曾」也念成 zēng）。
// 不拦，只提醒：做包时词表里有就提一条（lib/make-pack.mjs），配音时这次用上了就提一条（lib/dub.mjs），code 是 lexicon_single_character，
// details 是 { terms }（那几个词条）。拉丁字母这类按整词找，一个字母的词条（A）只换单独的 A，不提。带 role 的用不上，不提。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { CUE_PATTERN, MARKER_PATTERN, TAG_PATTERN } from '../tools/markup.mjs';

/** 写进 <speak> 的文字里的 & < > 转义（拼音音素的标签包在 <speak> 里，见 applyPhonemes）。 */
const escapeSsml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 读音词表在角色部分根上的文件名（约定，清单里没有专门的字段）。 */
export const LEXICON_FILE = 'lexicon.pls';

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 100;

const PLS_NS = 'http://www.w3.org/2005/01/pronunciation-lexicon';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/** 读音词表读不了。details.reason 是哪种情况，details.line 是行号（第一行是 1）。 */
function invalid(reason, message, line, extra = {}) {
  const where = line === undefined ? '' : `第 ${line} 行`;
  return new VoicePackError('lexicon_invalid', `读音词表${where}：${message}`, { details: { reason, ...(line === undefined ? {} : { line }), ...extra } });
}

// ---------------------------------------------------------------- 读 XML

const XML_NAME = /^[\p{L}_:][\p{L}\p{M}\p{N}_:.\xB7-]*$/u;
const NCNAME = /^[\p{L}_][\p{L}\p{M}\p{N}_.\xB7-]*$/u;
const NAME_TOKEN = /[^ \t\n/>=<"'&]+/y;
const NOT_XML_WHITESPACE = /[^ \t\n]/;
const FORBIDDEN_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const isXmlWhitespace = (code) => code === 32 || code === 9 || code === 10;
const lineAt = (text, index) => {
  let line = 1;
  for (let k = text.indexOf('\n'); k !== -1 && k < index; k = text.indexOf('\n', k + 1)) line += 1;
  return line;
};

function decodeInput(input) {
  let text;
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES || new TextEncoder().encode(input).length > MAX_BYTES) throw invalid('too_large', `超过 ${MAX_BYTES} 字节，读音词表不会这么大`);
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.length > MAX_BYTES) throw invalid('too_large', `超过 ${MAX_BYTES} 字节，读音词表不会这么大`);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch (cause) {
      throw new VoicePackError('lexicon_invalid', '读音词表：字节不是合法的 UTF-8', { details: { reason: 'not_utf8' }, cause });
    }
  } else {
    throw new TypeError('读音词表必须是字符串或 UTF-8 字节（Uint8Array）');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  const control = FORBIDDEN_CONTROL.exec(text);
  const noncharacter = Math.max(text.indexOf(String.fromCharCode(0xfffe)), text.indexOf(String.fromCharCode(0xffff)));
  if (control !== null) throw invalid('invalid_character', `有 XML 不允许的控制字符（U+${control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}）`, lineAt(text, control.index));
  if (noncharacter !== -1) throw invalid('invalid_character', '有 XML 不允许的字符（U+FFFE 或 U+FFFF）', lineAt(text, noncharacter));
  return text;
}

/** 把文字里的 &…; 换成它代表的字符；预定义的五个和数字字符引用，别的都报错。 */
function decodeReferences(raw, line) {
  if (!raw.includes('&')) return raw;
  let out = '';
  let last = 0;
  for (let amp = raw.indexOf('&'); amp !== -1; amp = raw.indexOf('&', last)) {
    const semicolon = raw.indexOf(';', amp);
    const reference = semicolon === -1 || semicolon - amp > 12 ? null : raw.slice(amp + 1, semicolon);
    if (reference === null) throw invalid('entity', '有单独的 &：要写成 &amp;', line);
    let char;
    if (Object.prototype.hasOwnProperty.call(PREDEFINED, reference)) {
      char = PREDEFINED[reference];
    } else if (/^#x[0-9a-fA-F]+$/.test(reference) || /^#[0-9]+$/.test(reference)) {
      const code = reference[1] === 'x' ? Number.parseInt(reference.slice(2), 16) : Number.parseInt(reference.slice(1), 10);
      const legal = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
      if (!legal) throw invalid('entity', `字符引用 &${reference}; 指向 XML 不允许的字符`, line, { entity: reference });
      char = String.fromCodePoint(code);
    } else {
      throw invalid('entity', `不认识的实体 &${reference};（只认 amp、lt、gt、quot、apos 和数字字符引用）`, line, { entity: reference });
    }
    out += raw.slice(last, amp) + char;
    last = semicolon + 1;
  }
  return out + raw.slice(last);
}

function splitQName(qname, line) {
  const parts = qname.split(':');
  if (parts.length > 2 || parts.some((part) => part === '' || !NCNAME.test(part))) throw invalid('syntax', `名字 ${qname} 写得不对`, line);
  return parts.length === 2 ? { prefix: parts[0], local: parts[1] } : { prefix: '', local: parts[0] };
}

const ROOT_SCOPE = new Map([['xml', XML_NS]]);

/**
 * 读 XML，返回根元素：{ ns, local, qname, attrs: [{ ns, local, qname, value }], children: [元素 | { text, line }], line }。
 * 只管格式是否正确（良构）和命名空间；认不认得这些元素，由 buildLexicon 管。
 */
function parseXml(source) {
  const length = source.length;
  let at = 0;
  let line = 1;
  const moveTo = (target) => {
    for (let k = at; k < target; k += 1) if (source.charCodeAt(k) === 10) line += 1;
    at = target;
  };
  const stack = [];
  let root = null;
  let rootClosed = false;

  if (source.startsWith('<?xml') && (length === 5 || /[ \t\n?]/.test(source[5]))) {
    const end = source.indexOf('?>');
    if (end === -1) throw invalid('unclosed', 'XML 声明没有以 ?> 结束', 1);
    const declaration = source.slice(5, end);
    const pairs = new Map();
    const rest = declaration.replace(/[ \t\n]+([a-z]+)[ \t\n]*=[ \t\n]*(?:"([^"]*)"|'([^']*)')/g, (_all, name, doubleQuoted, singleQuoted) => {
      pairs.set(name, doubleQuoted ?? singleQuoted);
      return '';
    });
    if (NOT_XML_WHITESPACE.test(rest) || pairs.get('version') !== '1.0' || ![...pairs.keys()].every((name) => ['version', 'encoding', 'standalone'].includes(name))) {
      throw invalid('xml_declaration', 'XML 声明写得不对（只认 version="1.0"，可以再带 encoding 和 standalone）', 1);
    }
    if (pairs.has('encoding') && !/^utf-8$/i.test(pairs.get('encoding'))) throw invalid('encoding_unsupported', `XML 声明说编码是 ${pairs.get('encoding')}，只认 UTF-8`, 1, { encoding: pairs.get('encoding') });
    moveTo(end + 2);
  }

  const top = () => stack[stack.length - 1];
  while (at < length) {
    if (source.charCodeAt(at) !== 60) {
      const next = source.indexOf('<', at);
      const end = next === -1 ? length : next;
      const chunk = source.slice(at, end);
      if (stack.length === 0) {
        if (NOT_XML_WHITESPACE.test(chunk)) throw invalid(root === null ? 'syntax' : 'content_after_root', root === null ? '根元素之前有不是标签的文字' : '根元素结束以后还有文字', line);
      } else {
        top().children.push({ text: decodeReferences(chunk, line), line });
      }
      moveTo(end);
      continue;
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      if (end === -1) throw invalid('unclosed', '注释没有以 --> 结束', line);
      moveTo(end + 3);
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      if (stack.length === 0) throw invalid(root === null ? 'syntax' : 'content_after_root', 'CDATA 只能在元素里面', line);
      const end = source.indexOf(']]>', at + 9);
      if (end === -1) throw invalid('unclosed', 'CDATA 没有以 ]]> 结束', line);
      top().children.push({ text: source.slice(at + 9, end), line });
      moveTo(end + 3);
      continue;
    }
    if (source.startsWith('<!', at)) {
      if (source.startsWith('<!DOCTYPE', at)) throw invalid('doctype', '不收 DOCTYPE（可以借实体做手脚，PLS 也用不着）', line);
      throw invalid('syntax', '不认识的 <! 结构', line);
    }
    if (source.startsWith('<?', at)) throw invalid('processing_instruction', '不收 XML 声明以外的处理指令（XML 声明只能在最开头）', line);

    if (source.startsWith('</', at)) {
      const close = source.indexOf('>', at);
      if (close === -1) throw invalid('unclosed', '结束标签没有以 > 结束', line);
      const qname = source.slice(at + 2, close).replace(/[ \t\n]+$/, '');
      if (!XML_NAME.test(qname)) throw invalid('syntax', `结束标签 </${qname}> 写得不对`, line);
      if (stack.length === 0) throw invalid(root === null ? 'syntax' : 'content_after_root', `多出来的结束标签 </${qname}>`, line);
      if (top().qname !== qname) throw invalid('mismatched_tag', `结束标签 </${qname}> 对不上开始标签 <${top().qname}>（第 ${top().line} 行）`, line, { expected: top().qname, found: qname });
      stack.pop();
      if (stack.length === 0) rootClosed = true;
      moveTo(close + 1);
      continue;
    }

    // 开始标签
    const startLine = line;
    NAME_TOKEN.lastIndex = at + 1;
    const nameMatch = NAME_TOKEN.exec(source);
    if (nameMatch === null || !XML_NAME.test(nameMatch[0])) throw invalid('syntax', '标签名缺失或写得不对', startLine);
    const qname = nameMatch[0];
    let p = NAME_TOKEN.lastIndex;
    const rawAttrs = [];
    let selfClosing = false;
    for (;;) {
      const before = p;
      while (p < length && isXmlWhitespace(source.charCodeAt(p))) p += 1;
      const spaced = p > before;
      if (p >= length) throw invalid('unclosed', `标签 <${qname}> 没有以 > 结束`, startLine);
      if (source[p] === '>') {
        p += 1;
        break;
      }
      if (source[p] === '/') {
        if (source[p + 1] !== '>') throw invalid('syntax', `标签 <${qname}> 里有单独的 /`, startLine);
        selfClosing = true;
        p += 2;
        break;
      }
      if (!spaced) throw invalid('syntax', `标签 <${qname}> 的属性之间要有空白`, startLine);
      NAME_TOKEN.lastIndex = p;
      const attrMatch = NAME_TOKEN.exec(source);
      if (attrMatch === null || !XML_NAME.test(attrMatch[0])) throw invalid('syntax', `标签 <${qname}> 的属性名写得不对`, startLine);
      p = NAME_TOKEN.lastIndex;
      while (p < length && isXmlWhitespace(source.charCodeAt(p))) p += 1;
      if (source[p] !== '=') throw invalid('syntax', `属性 ${attrMatch[0]} 后面要有 =`, startLine);
      p += 1;
      while (p < length && isXmlWhitespace(source.charCodeAt(p))) p += 1;
      const quote = source[p];
      if (quote !== '"' && quote !== "'") throw invalid('syntax', `属性 ${attrMatch[0]} 的值要用引号括起来`, startLine);
      const closeQuote = source.indexOf(quote, p + 1);
      if (closeQuote === -1) throw invalid('unclosed', `属性 ${attrMatch[0]} 的值没有结束的引号`, startLine);
      const rawValue = source.slice(p + 1, closeQuote);
      if (rawValue.includes('<')) throw invalid('syntax', `属性 ${attrMatch[0]} 的值里不能有 <`, startLine);
      rawAttrs.push({ qname: attrMatch[0], value: decodeReferences(rawValue.replace(/[\t\n]/g, ' '), startLine) });
      p = closeQuote + 1;
    }

    // 命名空间：先收这个元素自己的声明，再解析元素名和属性名
    const parentScope = stack.length === 0 ? ROOT_SCOPE : top().scope;
    const declares = rawAttrs.some((a) => a.qname === 'xmlns' || a.qname.startsWith('xmlns:'));
    const scope = declares ? new Map(parentScope) : parentScope;
    const attrs = [];
    const seen = new Set();
    for (const a of rawAttrs) {
      if (a.qname === 'xmlns') {
        scope.set('', a.value);
      } else if (a.qname.startsWith('xmlns:')) {
        const prefix = a.qname.slice(6);
        if (!NCNAME.test(prefix) || prefix === 'xmlns' || (prefix === 'xml' && a.value !== XML_NS) || a.value === '') throw invalid('syntax', `命名空间声明 ${a.qname} 写得不对`, startLine);
        scope.set(prefix, a.value);
      } else {
        attrs.push(a);
      }
    }
    const resolve = (name, isAttribute) => {
      const { prefix, local } = splitQName(name, startLine);
      if (prefix === '') return { ns: isAttribute ? null : scope.get('') || null, local };
      const ns = scope.get(prefix);
      if (ns === undefined) throw invalid('undefined_prefix', `前缀 ${prefix} 没有声明过命名空间`, startLine, { prefix });
      return { ns, local };
    };
    const element = { ...resolve(qname, false), qname, attrs: [], children: [], line: startLine, scope };
    for (const a of attrs) {
      const resolved = resolve(a.qname, true);
      const key = `${resolved.ns ?? ''}\n${resolved.local}`;
      if (seen.has(key)) throw invalid('syntax', `属性 ${a.qname} 在标签 <${qname}> 里写了两次`, startLine);
      seen.add(key);
      element.attrs.push({ ...resolved, qname: a.qname, value: a.value });
    }

    if (stack.length === 0) {
      if (rootClosed) throw invalid('content_after_root', '根元素结束以后还有元素', startLine);
      if (element.local !== 'lexicon') throw invalid('root_not_lexicon', `根元素是 <${qname}>，读音词表的根元素是 <lexicon>`, startLine);
      if (element.ns !== PLS_NS) throw invalid('wrong_namespace', `<lexicon> 的命名空间要是 ${PLS_NS}`, startLine, { namespace: element.ns });
      root = element;
    } else {
      top().children.push(element);
    }
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(element);
      if (stack.length > MAX_DEPTH) throw invalid('too_deep', `标签嵌套超过 ${MAX_DEPTH} 层`, startLine);
    }
    moveTo(p);
  }
  if (stack.length > 0) throw invalid('unclosed', `标签 <${top().qname}> 没有结束`, top().line, { element: top().qname });
  if (root === null) throw invalid('empty', '没有内容，找不到根元素 <lexicon>');
  return root;
}

// ---------------------------------------------------------------- 认 PLS

const ALLOWED_ATTRIBUTES = {
  lexicon: [[null, 'version'], [null, 'alphabet'], [XML_NS, 'lang'], [XML_NS, 'base'], [XSI_NS, 'schemaLocation'], [XSI_NS, 'noNamespaceSchemaLocation']],
  meta: [[null, 'name'], [null, 'http-equiv'], [null, 'content']],
  metadata: [],
  lexeme: [[XML_NS, 'id'], [null, 'role']],
  grapheme: [],
  phoneme: [[null, 'prefer'], [null, 'alphabet']],
  alias: [[null, 'prefer']],
  example: [],
};
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function checkAttributes(element) {
  const allowed = ALLOWED_ATTRIBUTES[element.local];
  for (const a of element.attrs) {
    if (!allowed.some(([ns, local]) => ns === a.ns && local === a.local)) {
      throw invalid('unknown_attribute', `<${element.local}> 不认识属性 ${a.qname}`, element.line, { element: element.local, attribute: a.qname });
    }
  }
}
const attributeOf = (element, ns, local) => element.attrs.find((a) => a.ns === ns && a.local === local)?.value;
function requiredAttribute(element, ns, local, label) {
  const value = attributeOf(element, ns, local);
  if (value === undefined) throw invalid('attribute_missing', `<${element.local}> 缺必填的属性 ${label}`, element.line, { element: element.local, attribute: label });
  return value;
}
function preferOf(element) {
  const value = attributeOf(element, null, 'prefer');
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') throw invalid('attribute_invalid', `prefer 只能是 true 或 false，收到 ${JSON.stringify(value)}`, element.line, { element: element.local, attribute: 'prefer' });
  return value === 'true';
}
/** 只含文字的元素的内容：两头的空白去掉，里面连续的空白折成一个空格；不能有子元素，不能是空的。 */
function textOf(element) {
  let value = '';
  for (const child of element.children) {
    if (child.text === undefined) throw invalid('element_in_text', `<${element.local}> 里面只能是文字，不能再有标签（<${child.qname}>）`, child.line, { element: element.local, child: child.qname });
    value += child.text;
  }
  const collapsed = value.replace(/[ \t\n]+/g, ' ').replace(/^ | $/g, '');
  if (collapsed === '') throw invalid('empty_text', `<${element.local}> 的内容不能是空的`, element.line, { element: element.local });
  return collapsed;
}

/**
 * 读一份 PLS。规则见文件头。
 * @param {string | Uint8Array} input PLS 文件的内容：字符串，或 UTF-8 字节
 * @returns {{
 *   version: '1.0', alphabet: string, language: string,
 *   lexemes: { id: string|null, role: string|null, graphemes: string[], pronunciations: { kind: 'alias'|'phoneme', value: string, prefer: boolean, alphabet: string|null }[], examples: string[] }[]
 * }}
 */
export function parseLexicon(input) {
  const root = parseXml(decodeInput(input));
  checkAttributes(root);
  const version = requiredAttribute(root, null, 'version', 'version');
  if (version !== '1.0') throw invalid('version_unsupported', `<lexicon> 的 version 是 ${JSON.stringify(version)}，只认 "1.0"`, root.line, { version });
  const alphabet = requiredAttribute(root, null, 'alphabet', 'alphabet');
  if (alphabet === '') throw invalid('attribute_invalid', 'alphabet 不能是空的', root.line, { element: 'lexicon', attribute: 'alphabet' });
  const language = requiredAttribute(root, XML_NS, 'lang', 'xml:lang');
  if (!LANGUAGE_TAG.test(language)) throw invalid('attribute_invalid', `xml:lang 要是语言标签（形如 en-US），收到 ${JSON.stringify(language)}`, root.line, { element: 'lexicon', attribute: 'xml:lang' });

  const lexemes = [];
  const ids = new Set();
  let stage = 0; // 0：meta 可以出现；1：metadata 已出现；2：lexeme 已开始。规范：meta*、metadata?、lexeme*
  for (const child of root.children) {
    if (child.text !== undefined) {
      if (NOT_XML_WHITESPACE.test(child.text)) throw invalid('text_in_lexicon', '<lexicon> 里面不能直接放文字', child.line);
      continue;
    }
    if (child.ns !== PLS_NS) throw invalid('unknown_element', `<lexicon> 里不认识 <${child.qname}>`, child.line, { element: child.qname });
    if (child.local === 'meta') {
      if (stage !== 0) throw invalid('element_order', '<meta> 要放在 <metadata> 和 <lexeme> 的前面', child.line);
      checkAttributes(child);
      const name = attributeOf(child, null, 'name');
      const httpEquiv = attributeOf(child, null, 'http-equiv');
      if (name === undefined && httpEquiv === undefined) throw invalid('attribute_missing', '<meta> 要有 name 或 http-equiv', child.line, { element: 'meta', attribute: 'name' });
      if (name !== undefined && httpEquiv !== undefined) throw invalid('attribute_invalid', '<meta> 的 name 和 http-equiv 不能同时写', child.line, { element: 'meta', attribute: 'http-equiv' });
      requiredAttribute(child, null, 'content', 'content');
      if (child.children.some((c) => c.text === undefined || NOT_XML_WHITESPACE.test(c.text))) throw invalid('meta_not_empty', '<meta> 是空元素，里面不能有内容', child.line);
    } else if (child.local === 'metadata') {
      if (stage !== 0) throw invalid('element_order', '<metadata> 只能有一个，并且要放在 <lexeme> 的前面', child.line);
      checkAttributes(child);
      stage = 1; // 里面是任意的元数据，读音不看它；格式已经在 parseXml 里核对过
    } else if (child.local === 'lexeme') {
      stage = 2;
      lexemes.push(readLexeme(child, ids));
    } else {
      throw invalid('unknown_element', `<lexicon> 里不认识 <${child.local}>`, child.line, { element: child.local });
    }
  }
  return { version: '1.0', alphabet, language, lexemes };
}

function readLexeme(element, ids) {
  checkAttributes(element);
  const id = attributeOf(element, XML_NS, 'id') ?? null;
  if (id !== null) {
    if (!NCNAME.test(id)) throw invalid('attribute_invalid', `xml:id 要是合法的 XML 名字，收到 ${JSON.stringify(id)}`, element.line, { element: 'lexeme', attribute: 'xml:id' });
    if (ids.has(id)) throw invalid('duplicate_id', `xml:id ${id} 重复了`, element.line, { id });
    ids.add(id);
  }
  const lexeme = { id, role: attributeOf(element, null, 'role') ?? null, graphemes: [], pronunciations: [], examples: [] };
  for (const child of element.children) {
    if (child.text !== undefined) {
      if (NOT_XML_WHITESPACE.test(child.text)) throw invalid('text_in_lexeme', '<lexeme> 里面不能直接放文字', child.line);
      continue;
    }
    if (child.ns !== PLS_NS) throw invalid('unknown_element', `<lexeme> 里不认识 <${child.qname}>`, child.line, { element: child.qname });
    switch (child.local) {
      case 'grapheme':
        checkAttributes(child);
        lexeme.graphemes.push(textOf(child));
        break;
      case 'alias':
        checkAttributes(child);
        lexeme.pronunciations.push({ kind: 'alias', value: textOf(child), prefer: preferOf(child), alphabet: null });
        break;
      case 'phoneme':
        checkAttributes(child);
        lexeme.pronunciations.push({ kind: 'phoneme', value: textOf(child), prefer: preferOf(child), alphabet: attributeOf(child, null, 'alphabet') ?? null });
        break;
      case 'example':
        checkAttributes(child);
        lexeme.examples.push(textOf(child));
        break;
      default:
        throw invalid('unknown_element', `<lexeme> 里不认识 <${child.local}>`, child.line, { element: child.local });
    }
  }
  if (lexeme.graphemes.length === 0) throw invalid('lexeme_without_grapheme', '<lexeme> 至少要有一个 <grapheme>', element.line);
  if (lexeme.pronunciations.length === 0) throw invalid('lexeme_without_pronunciation', '<lexeme> 至少要有一个 <phoneme> 或 <alias>', element.line);
  return lexeme;
}

// ---------------------------------------------------------------- 选读法

/**
 * 给每个词选定读法，规则见文件头「怎么选读法」。
 * phonemeMarkers：环境声明了 phoneme-markers（见 dub.mjs）。拼音（x-pinyin）、Arpabet（x-arpabet）、日文罗马字（x-romaji）写对的成了 rules 里的一条：把词换成音素标签（say 是标签，
 *   另有 phoneme: { alphabet, ph }），和别名在同一次扫描里换（applyLexicon）。
 * phonemeInText：环境声明了 phoneme-in-text、没有声明 phoneme-markers。拼音写对的进 phonemes（发送前 applyPhonemes 写成 SSML）；Arpabet、罗马字不收（reason 'phoneme'）。
 * 两个都没有声明，所有音素都是 reason 'phoneme'，和没有拼音这一项时一字不差。
 * 收的字母表里写不对的（音节数、写法、词条不是那种字）reason 是 phoneme_format，problem 写明是哪一种。
 * unapplied 列着所有音素（能用的也列着，调用方在用上的时候去掉）。
 * @param {ReturnType<typeof parseLexicon>} lexicon
 * @param {{ phonemeInText?: boolean, phonemeMarkers?: boolean }} [options]
 * @returns {{
 *   rules: { term: string, say: string, language: string, phoneme?: { alphabet: string, ph: string } }[],
 *   phonemes: { term: string, alphabet: string, ph: string }[],
 *   unapplied: ({ term: string, reason: 'phoneme', phoneme: string, alphabet: string } | { term: string, reason: 'phoneme_format', phoneme: string, alphabet: string, problem: 'term'|'count'|'form' } | { term: string, reason: 'role', role: string, lexemeId: string|null })[]
 * }}
 */
export function lexiconRules(lexicon, { phonemeInText = false, phonemeMarkers = false } = {}) {
  const byTerm = new Map(); // 词 -> 按文档次序收齐的读法
  const unapplied = [];
  for (const lexeme of lexicon.lexemes) {
    for (const term of lexeme.graphemes) {
      if (lexeme.role !== null) {
        unapplied.push({ term, reason: 'role', role: lexeme.role, lexemeId: lexeme.id });
        continue;
      }
      byTerm.set(term, [...(byTerm.get(term) ?? []), ...lexeme.pronunciations]);
    }
  }
  const rules = [];
  const phonemes = [];
  const notApplied = [];
  for (const [term, pronunciations] of byTerm) {
    const chosen = pronunciations.find((p) => p.prefer) ?? pronunciations[0];
    if (chosen.kind === 'alias') {
      rules.push({ term, say: chosen.value, language: lexicon.language });
      continue;
    }
    const alphabet = chosen.alphabet ?? lexicon.alphabet;
    // 这个环境收不收这种字母表：音素标签收拼音、Arpabet 和罗马字，SSML 只收拼音
    const checkOf = phonemeMarkers ? MARKER_ALPHABETS.get(alphabet) : phonemeInText && alphabet === PINYIN_ALPHABET ? pinyinProblem : undefined;
    const problem = checkOf === undefined ? null : checkOf(term, chosen.value);
    if (checkOf !== undefined && problem === null) {
      if (phonemeMarkers) rules.push({ term, say: phonemeMarkersOf(alphabet, chosen.value), language: lexicon.language, phoneme: { alphabet, ph: chosen.value } });
      else phonemes.push({ term, alphabet, ph: chosen.value });
    }
    if (problem === null) notApplied.push({ term, reason: 'phoneme', phoneme: chosen.value, alphabet });
    else notApplied.push({ term, reason: 'phoneme_format', phoneme: chosen.value, alphabet, problem });
  }
  return { rules, phonemes, unapplied: [...notApplied, ...unapplied] };
}

// ---------------------------------------------------------------- 拼音音素
//
// 包里的拼音音素：字母表 x-pinyin（PLS 第 2 节：非 ipa 的字母表是 x- 开头的自定义名）；ph 是拼音加数字声调，每个汉字一个音节，
// 音节用空格分开，个数和词里的汉字数相等，声调 1 到 5（5 是轻声）。拼音里的 ü 写成 v（lü3 写成 lv3）。
// 认不认得这个字母表、怎么写进文字，由环境定：声明了 phoneme-markers，写成音素标签（下面「音素标签」）；只声明了 phoneme-in-text，写成 SSML 的 <phoneme>
// （适配器的字母表名见它的 env.mjs）。SSML 这一种在这里只管读、判、写成标签；发送时在 dub.mjs 的 runUnit 里做（停顿、切段、字数都仍按纯文字算，标签不计字数）。

/** 包里写汉语拼音用的字母表名。 */
export const PINYIN_ALPHABET = 'x-pinyin';
const PINYIN_SYLLABLE = /^[a-z]+[1-5]$/;

/** 拼音音素写得对不对：null 是对的；'term' 是词条里有不是汉字的字（拼音只标汉字）；'count' 是音节数和汉字数对不上；'form' 是某个音节的写法不对。 */
export function pinyinProblem(term, ph) {
  const characters = [...term];
  if (!characters.every((character) => /^\p{Script=Han}$/u.test(character))) return 'term';
  const syllables = ph.split(' ');
  if (syllables.length !== characters.length) return 'count';
  return syllables.every((syllable) => PINYIN_SYLLABLE.test(syllable)) ? null : 'form';
}

// ---------------------------------------------------------------- Arpabet 音素
//
// 包里的英文音素：字母表 x-arpabet，ph 是 CMU Arpabet：音素用大写字母写，之间空一格；元音后面带重音数字（0 不重读、1 主重音、2 次重音），辅音不带。
// 一个词条一个词（拉丁字母，中间可以有撇号、连字符）：音素标签一个标签代替一个词（厂商文档）。只在声明了 phoneme-markers 的环境里用，SSML 那一种不收。

/** 包里写英文音素（CMU Arpabet）用的字母表名。 */
export const ARPABET_ALPHABET = 'x-arpabet';
const ARPABET_VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
const ARPABET_CONSONANTS = new Set(['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH']);
const ARPABET_PHONE = /^([A-Z]+)([0-2])?$/;
const LATIN_WORD = /^\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*$/u;

/** Arpabet 音素写得对不对：null 是对的；'term' 是词条不是一个拉丁字母的词；'form' 是某个音素不在 Arpabet 里，或者元音没带重音数字、辅音带了。 */
export function arpabetProblem(term, ph) {
  if (!LATIN_WORD.test(term)) return 'term';
  return ph.split(' ').every((phone) => {
    const match = ARPABET_PHONE.exec(phone);
    if (match === null) return false;
    return match[2] === undefined ? ARPABET_CONSONANTS.has(match[1]) : ARPABET_VOWELS.has(match[1]);
  }) ? null : 'form';
}

// ---------------------------------------------------------------- 日文罗马字音素
//
// 包里的日文音素：字母表 x-romaji，ph 是 OpenJTalk 风格的罗马字，带音调的数字：字母后面跟一个数字，一个接一个，不空格（厂商唯一的例子：橋が 写 ha0shi1ga0）。
// 一个词条是一个日文的词或短的词组（假名、汉字，长音符 ー）：音素标签一个标签代替整个词条（厂商文档）。只在声明了 phoneme-markers 的环境里用，SSML 那一种不收。
// 这里只核字母和数字的样子，不核是不是真有这个音拍、音调对不对：厂商只给了一个例子。

/** 包里写日文音素（OpenJTalk 风格的罗马字，带音调数字）用的字母表名。 */
export const ROMAJI_ALPHABET = 'x-romaji';
const JAPANESE_TERM = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u;
const ROMAJI_WITH_PITCH = /^(?:[A-Za-z]+[0-9])+$/;

/** 罗马字音素写得对不对：null 是对的；'term' 是词条里有不是假名、汉字的字；'form' 是 ph 不是「字母后面跟一个数字」一个接一个（有空格、假名，或者没有音调数字）。 */
export function romajiProblem(term, ph) {
  if (!JAPANESE_TERM.test(term)) return 'term';
  return ROMAJI_WITH_PITCH.test(ph) ? null : 'form';
}

// ---------------------------------------------------------------- 音素标签（phoneme-markers）
//
// 环境声明了 phoneme-markers：合成认文字里的 <|phoneme_start|>音素<|phoneme_end|>，标签代替原来的词，原来的字不写（写法是配音模型的厂商文档定的，models/scene3.md「音素标签」）。
// 拼音一个音节一个标签，几个标签挨着写（yin2 hang2 写成 <|phoneme_start|>yin2<|phoneme_end|><|phoneme_start|>hang2<|phoneme_end|>）；Arpabet 一个词一个标签，音素照写；
// 罗马字一个词条一个标签。包里的写法就是厂商的写法（拼音小写、ü 写 v、轻声写 5；Arpabet 大写、带重音数字；罗马字带音调数字），不转换。
// 换成标签是一次替换，和别名一样在 applyLexicon 的同一次扫描里做：长的词条优先，换出来的字不再查词表（别名换出来的字不会再被标上音素）。
// 不转义、不包 <speak>：句子里的尖括号标签照样到模型。

/** 声明了 phoneme-markers 的环境收的字母表，和各自的检查。 */
const MARKER_ALPHABETS = new Map([[PINYIN_ALPHABET, pinyinProblem], [ARPABET_ALPHABET, arpabetProblem], [ROMAJI_ALPHABET, romajiProblem]]);
const PHONEME_START = '<|phoneme_start|>';
const PHONEME_END = '<|phoneme_end|>';

/** 一个词条的音素写成音素标签：拼音一个音节一个标签，别的字母表（Arpabet、罗马字）整个音素一个标签。 */
function phonemeMarkersOf(alphabet, ph) {
  const marker = (inside) => `${PHONEME_START}${inside}${PHONEME_END}`;
  return alphabet === PINYIN_ALPHABET ? ph.split(' ').map(marker).join('') : marker(ph);
}

/**
 * 把读音标在台词的词上（SSML 的拼音音素，只声明了 phoneme-in-text 的环境；音素标签不走这里，见上面「音素标签」）。spoken 是要念的文字；ssml 为 true 时它已经是 <speak>…</speak>（转义过，标记和 <break> 不动，只换文字段）；方括号里的提示不动（文件头「怎么用到台词上」）；
 * 为 false 时是纯文字，有替换的就转义、包一层 <speak>。没有替换的原样交回，所以没有音素的句子和以前一字不差。
 * phonemes 是 lexiconRules 的 phonemes（{ term, alphabet, ph }）；同一个词条只用第一个。匹配和长词优先的规则和 applyLexicon 一样。
 * @returns {{ text: string, replacements: { term: string, ph: string, count: number }[] }} replacements 按第一次换到的先后排
 */
export function applyPhonemes(spoken, phonemes, { ssml }) {
  if (typeof spoken !== 'string') throw new TypeError('台词必须是字符串');
  if (!Array.isArray(phonemes)) throw new TypeError('音素必须是数组');
  const pick = new Map();
  for (const item of phonemes) if (!pick.has(item.term)) pick.set(item.term, item);
  if (pick.size === 0) return { text: spoken, replacements: [] };
  // 匹配的是转义以后的文字（<speak> 里写的是 &amp; 这类），词条也按转义以后的样子认；词条是汉字时转义不改它
  const byEscaped = new Map([...pick.values()].map((item) => [escapeSsml(item.term), item]));
  const terms = [...byEscaped.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(terms.map(termPattern).join('|'), 'gu');
  const counts = new Map();
  const rewriteWords = (run) => run.replace(pattern, (matched) => {
    const item = byEscaped.get(matched);
    counts.set(item.term, (counts.get(item.term) ?? 0) + 1);
    return `<phoneme alphabet="${PINYIN_ALPHABET}" ph="${escapeSsml(item.ph).replace(/"/g, '&quot;')}">${matched}</phoneme>`;
  });
  // 提示（方括号）原样，只换提示之间的字
  const rewrite = (run) => run.split(CUES_SPLIT).map((piece, index) => (index % 2 === 1 ? piece : rewriteWords(piece))).join('');
  let text;
  if (ssml) {
    // 标签（<speak>、<break …/>）原样，只换标签之间的文字
    text = spoken.split(/(<[^>]*>)/).map((piece, index) => (index % 2 === 1 ? piece : rewrite(piece))).join('');
  } else {
    const marked = rewrite(escapeSsml(spoken));
    if (counts.size === 0) return { text: spoken, replacements: [] };
    text = `<speak>${marked}</speak>`;
  }
  if (counts.size === 0) return { text: spoken, replacements: [] };
  const replacements = [...counts].map(([term, count]) => ({ term, ph: pick.get(term).ph, count }));
  return { text, replacements };
}

// ---------------------------------------------------------------- 用到台词上

/** 按提示切开（提示在奇数位），给 applyPhonemes 绕开提示用。 */
const CUES_SPLIT = new RegExp(`(${CUE_PATTERN})`);
/** applyLexicon 不碰的：台本标记、提示、尖括号标签（文件头「怎么用到台词上」）。 */
const UNTOUCHED = new RegExp(`${MARKER_PATTERN}|${TAG_PATTERN}`, 'gi');

const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;
// 不分词的文字：汉字、假名、谚文、泰文这类，词条的边上是它们就按子串匹配，旁边是它们也不算在词内
const UNSPACED = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]`;
const INSIDE_WORD = `(?!${UNSPACED})${WORD_CHAR}`;
const INSIDE_WORD_START = new RegExp(`^${INSIDE_WORD}`, 'u');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const SINGLE_UNSPACED = new RegExp(`^${UNSPACED}$`, 'u');

/** 词条只写了一个字、又是按子串找的（汉字、假名、谚文这类，见 termPattern）：含这个字的每个词都会被换掉。拉丁字母这类整词找，一个字母的词条不算。 */
export function isSingleCharacterTerm(term) {
  return typeof term === 'string' && SINGLE_UNSPACED.test(term);
}

/** 词表里只写一个字的词条（isSingleCharacterTerm），按词表的次序，不重复；带 role 的不算（它用不上，见文件头「怎么选读法」）。 */
export function singleCharacterTerms(lexicon) {
  const terms = new Set();
  for (const lexeme of lexicon.lexemes) {
    if (lexeme.role !== null) continue;
    for (const term of lexeme.graphemes) if (isSingleCharacterTerm(term)) terms.add(term);
  }
  return [...terms];
}

/**
 * 只写一个字的词条的提醒（只提醒，不拦）：做包时看词表里有没有（lib/make-pack.mjs），配音时看这次用上了没有（lib/dub.mjs）。
 * terms 是那几个词条（不空，按调用方给的次序）。
 * @returns {{ code: 'lexicon_single_character', message: string, details: { terms: string[] } }}
 */
export function singleCharacterNote(terms) {
  const listed = terms.map((term) => `「${term}」`).join('');
  return {
    code: 'lexicon_single_character',
    message: `读音词表里有 ${terms.length} 个词条只写了一个字：${listed}。词条按字面在台词里找，含这个字的每个词都会照它念，不只是要改的那个名字或词。只想改一个名字或一个词，把词条写成整个词（例如写「曾小雨」，不写「曾」）`,
    details: { terms: [...terms] },
  };
}

/**
 * 做包时的说明：一份读音词表（PLS 的字符串或 UTF-8 字节）有只写一个字的词条，给一条 lexicon_single_character（singleCharacterNote），没有就是 []。
 * 词表读不了的也是 []：读不读得了不归做包这一步，配音读它时报 lexicon_invalid。别的错照常抛。
 */
export function lexiconNotes(input) {
  let lexicon;
  try {
    lexicon = parseLexicon(input);
  } catch (error) {
    if (error instanceof VoicePackError && error.code === 'lexicon_invalid') return [];
    throw error;
  }
  const terms = singleCharacterTerms(lexicon);
  return terms.length === 0 ? [] : [singleCharacterNote(terms)];
}

function termPattern(term) {
  const chars = [...term];
  const left = INSIDE_WORD_START.test(chars[0]) ? `(?<!${INSIDE_WORD})` : '';
  const right = INSIDE_WORD_START.test(chars[chars.length - 1]) ? `(?!${INSIDE_WORD})` : '';
  return `${left}${escapeRegExp(term)}${right}`;
}

/**
 * 把规则用到台词上。规则见文件头「怎么用到台词上」。
 * @param {string} text 台词（可以带台本标记）
 * @param {{ term: string, say: string }[]} rules
 * @returns {{ text: string, replacements: { term: string, say: string, count: number }[] }} replacements 按第一次换到的先后排，每个词条一项
 */
export function applyLexicon(text, rules) {
  if (typeof text !== 'string') throw new TypeError('台词必须是字符串');
  if (!Array.isArray(rules)) throw new TypeError('规则必须是数组');
  const sayOf = new Map();
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object' || typeof rule.term !== 'string' || rule.term === '') throw new TypeError('规则的 term 必须是非空字符串');
    if (typeof rule.say !== 'string') throw new TypeError(`规则 ${JSON.stringify(rule.term)} 的 say 必须是字符串`);
    if (!sayOf.has(rule.term)) sayOf.set(rule.term, rule.say);
  }
  if (sayOf.size === 0) return { text, replacements: [] };
  // 长的词条排前面：同一位置几个都能匹配时，正则的候选按先后试，所以长的先赢
  const terms = [...sayOf.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(terms.map(termPattern).join('|'), 'gu');
  const counts = new Map();
  const rewrite = (segment) => segment.replace(pattern, (term) => {
    counts.set(term, (counts.get(term) ?? 0) + 1);
    return sayOf.get(term);
  });
  let out = '';
  let last = 0;
  for (const marker of text.matchAll(UNTOUCHED)) {
    out += rewrite(text.slice(last, marker.index)) + marker[0];
    last = marker.index + marker[0].length;
  }
  out += rewrite(text.slice(last));
  return { text: out, replacements: [...counts].map(([term, count]) => ({ term, say: sayOf.get(term), count })) };
}
