// SPDX-License-Identifier: Apache-2.0
//
// 声音的语言（流程层，纯数据）：显示名（中文、English）和 BCP 47 标签（zh、en）的互相转换，以及认不出名字时按文字认。
// 老声音（音色包出现以前的）存的语言是显示名，音色包的清单要求每段参考都有标签；老声音的转换规则（lib/legacy-voice.mjs）和 app 都调这里，对照只写这一份。
// 这一份不引别的模块：app 的每个页面都要读声音的语言，所以它要小；转换规则里配音指引和场景那部分（要读词表）只有社区和迁移才用，在 lib/legacy-voice.mjs。
//
//   languageTagOf(name, text)   显示名（或本来就是标签）-> BCP 47 标签；名字认不出按文字系统认，再认不出给 und
//   languageLabelOf(tag)        BCP 47 标签 -> 显示名；没有显示名的语言原样给标签，und 给空串
//   isLanguageTag(text)         是不是清单放得下的语言标签（写法对、不超过 MAX_LANGUAGE_TAG 个字符）；做包、长录音、净室输入检查语言标签都用它
//   LANGUAGE_TAG、MAX_LANGUAGE_TAG   上面那条的写法和长度上限：清单里语言标签的写法只在这里写一处（要和清单 schema 里的写法保持一致）
//
// 按文字认的那一步和 lib/line-hints.mjs 的 detectLanguages 是同一个判断（有假名是日语；否则哪种文字的信息量最大，汉字和谚文一个字算三个字母，一样多取先出现的），
// 那边给的是候选语言的一组，这边要的是敢写进清单的一个，所以只有汉字（zh）、假名（ja）、谚文（ko）认；line-hints.mjs 引的东西多（提示词表），不能拖进每个页面，所以这里写了一份，
// 两边的结论要保持一致。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 这几个语言的显示名（用这个库的 app 里，声音的语言就是这样显示的）。 */
const LABELS = { zh: '中文', ja: '日本語', ko: '한국어', en: 'English' };
/** 显示名和英文名（音色库按英文名列语言）-> 标签，键是小写的：写法的大小写不论。 */
const TAG_OF_NAME = new Map([...Object.entries(LABELS).map(([tag, name]) => [name.toLowerCase(), tag]), ['chinese', 'zh'], ['japanese', 'ja'], ['korean', 'ko']]);
/**
 * 清单里语言标签的写法（清单 schema 里参考段的 tags.language，见 protocol/FORMAT.md 4.4）：形如 en、zh-CN，最长 35 个字符。流程层里认语言标签的地方都用这一份。
 * 这个模块不引别的模块，没法去读 schema，所以写法在这里手写一遍；要和 schema 里的写法保持一致。
 */
export const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const MAX_LANGUAGE_TAG = 35;

/** 是不是清单放得下的语言标签：写法对，也不超长。不去掉两头的空白（调用方要容忍空白就先 trim）；不是字符串就不是。 */
export const isLanguageTag = (text) => typeof text === 'string' && text.length <= MAX_LANGUAGE_TAG && LANGUAGE_TAG.test(text);

/** 看多少个字就够认文字系统。 */
const SCRIPT_SAMPLE = 4000;
const LETTER = /[\p{L}\p{Nl}]/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** 认的文字系统（和 detectLanguages 数的一样，假名另外算）。一个汉字或谚文字的信息量按三个字母算。 */
const SCRIPTS = [
  ['Hangul', /\p{Script=Hangul}/u, 3], ['Han', /\p{Script=Han}/u, 3], ['Latin', /\p{Script=Latin}/u, 1], ['Cyrillic', /\p{Script=Cyrillic}/u, 1], ['Arabic', /\p{Script=Arabic}/u, 1],
  ['Devanagari', /\p{Script=Devanagari}/u, 1], ['Thai', /\p{Script=Thai}/u, 1], ['Greek', /\p{Script=Greek}/u, 1], ['Hebrew', /\p{Script=Hebrew}/u, 1],
];

/** 按文字系统认语种：zh、ja、ko，认不出（拉丁字母认不出是英语还是法语，西里尔字母认不出是俄语还是乌克兰语）是 und。 */
function tagOfScript(text) {
  const weights = new Map();
  for (const ch of text.slice(0, SCRIPT_SAMPLE)) {
    if (!LETTER.test(ch)) continue;
    if (KANA.test(ch)) return 'ja';
    const script = SCRIPTS.find(([, test]) => test.test(ch));
    if (script !== undefined) weights.set(script[0], (weights.get(script[0]) ?? 0) + script[2]);
  }
  let best = null;
  for (const [script, weight] of weights) if (best === null || weight > best.weight) best = { script, weight };
  return best?.script === 'Han' ? 'zh' : best?.script === 'Hangul' ? 'ko' : 'und';
}

/**
 * 声音的语言 -> BCP 47 标签。`name` 可以是显示名（中文、English）、英文名（Chinese），也可以本来就是标签（zh-CN）；认不出名字的，看 `text` 的文字系统。
 * 认不出给 `und`（未定）：猜错的语言会让这个包在别的语种的台词上被挑中，`und` 老实，什么台词都不特别匹配。
 * @param {unknown} [name]
 * @param {unknown} [text]
 * @returns {string}
 */
export function languageTagOf(name, text) {
  const written = typeof name === 'string' ? name.trim() : '';
  if (isLanguageTag(written)) return written;
  return TAG_OF_NAME.get(written.toLowerCase()) ?? tagOfScript(typeof text === 'string' ? text : '');
}

/**
 * 标签 -> 显示名。区域不管（zh-CN 也是中文）；没有显示名的语言原样给标签，屏幕上有字可显示；`und` 给空串，什么也没说。
 * @param {unknown} tag
 * @returns {string}
 */
export function languageLabelOf(tag) {
  const written = typeof tag === 'string' ? tag.trim() : '';
  const primary = written.split(/[-_]/)[0].toLowerCase();
  if (primary === 'und') return '';
  return Object.hasOwn(LABELS, primary) ? LABELS[primary] : written;
}
