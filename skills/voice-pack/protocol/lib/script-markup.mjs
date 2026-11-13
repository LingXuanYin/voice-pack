// SPDX-License-Identifier: Apache-2.0
//
// 台本里几种写法的正则：只写在这里。核心层要认它们（spoken-words.mjs 去掉试听句的台本标记，word-spacing.mjs 看接缝两边的字时隔着标签看），
// 可核心层只能依赖核心层（protocol/README.md「Module conventions」第 6 条），所以正则放在这一层；基础部分的 tools/markup.mjs、lib/line-hints.mjs 从这里引，不另写一份。
// 写法是什么、怎么读，正本不在这里，在：
//   提示、尖括号标签（音素标记、竖线写的标签、成对的标签）   tools/markup.mjs 的文件头「提示」「尖括号标签」（标准用例 tools/cases/markup.json）
//   舞台说明（括号、星号）和强调（加粗）                      lib/line-hints.mjs 的文件头「舞台提示的写法」
// 改写法：先改那两处的文字，再改这里的正则。
//
// 导出的都是正则的源码（字符串），用的人自己 new RegExp(…, 'g' 或 'gu')。带不带捕获组、组是什么，写在每一个上面：几个拼进一个正则时，组的序号跟着变，
// 命名的组在一个正则里只能有一份。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

// ---------------------------------------------------------------- 提示（tools/markup.mjs「提示」）

/**
 * 方括号：里面一个以上不是方括号、不是换行的字。没有捕获组。声音、停顿的标记也长这个样子：解析器先认出它们，剩在文字里的方括号才是提示。
 * 给要找出提示的代码用：配音去掉提示认语种（lib/line-hints.mjs），读音词表绕开提示（tools/markup.mjs 的 MARKER_PATTERN），卡片去掉提示（spoken-words.mjs）。
 */
export const CUE_PATTERN = '\\[[^\\[\\]\\n]+\\]';

// ---------------------------------------------------------------- 尖括号标签（tools/markup.mjs「尖括号标签」）

const PHONEME_START = '<|phoneme_start|>';
const PHONEME_END = '<|phoneme_end|>';
/**
 * 一个音素标记整个：<|phoneme_start|>音素<|phoneme_end|>，中间不换行，没有尖括号。没有捕获组，里面的音素用 phonemeOf 取。
 * 认语种时把它当一个词（lib/line-hints.mjs 的 wordsOf）。
 */
export const PHONEME_MARKER_PATTERN = '<\\|phoneme_start\\|>[^<>\\n]*<\\|phoneme_end\\|>';
/** PHONEME_MARKER_PATTERN 认出的一整个音素标记里面的音素，原样（不去两头空白）。 */
export const phonemeOf = (marker) => marker.slice(PHONEME_START.length, marker.length - PHONEME_END.length);
/** 标签的名字：字母开头，后面是字母、数字、下划线、连字符。 */
export const TAG_NAME_PATTERN = '[A-Za-z][A-Za-z0-9_-]*';
/** 竖线写的标签：<|名字|>、<|名字:数字|>（<|speaker:0|>；音素标记的两头也长这样）。没有捕获组。 */
export const BAR_TAG_PATTERN = '<\\|[A-Za-z_]+(?::\\d+)?\\|>';
/** 成对标签的一头：<名字> 或 </名字>。没有捕获组。配音查一个请求里的成对标签配没配上对时用（lib/dub.mjs 的 tag_pair_split）。 */
export const PAIRED_TAG_PATTERN = `</?${TAG_NAME_PATTERN}>`;
/**
 * 一个标签，不算音素标记的两头：<名字>、</名字>、<|名字|>、<|名字:数字|>（<|phoneme_start|>、<|phoneme_end|> 不算）。没有捕获组。
 * 它不念，看接缝两边的字（word-spacing.mjs）、分句（tools/sentences.mjs）时隔着它看；音素标记代替一个词，不隔着它看。
 */
export const PLAIN_TAG_PATTERN = [`(?!<\\|phoneme_(?:start|end)\\|>)${BAR_TAG_PATTERN}`, PAIRED_TAG_PATTERN].join('|');

// ---------------------------------------------------------------- 舞台说明和强调（lib/line-hints.mjs「舞台提示的写法」）

/** 括号写的舞台说明：（…）或 (…)（全角半角可以混着写），括号里 1 到 30 个不是括号、不换行的字。一个捕获组：括号里的字。 */
export const PAREN_DIRECTION_PATTERN = '[（(]([^()（）\\r\\n]{1,30})[)）]';
/** 【…】写的舞台说明：里面 1 到 30 个不是【】、不换行的字。一个捕获组：括号里的字。 */
export const LENTICULAR_DIRECTION_PATTERN = '【([^【】\\r\\n]{1,30})】';
/** 加粗：两颗或三颗星号，前后一样多，星号和字之间没有空白，里面不含星号、不换行，不限长度。命名的组 stars 是星号，bold 是里面的字。 */
export const BOLD_PATTERN = '(?<stars>\\*{2,3})(?<bold>[^\\s*](?:[^*\\n]*[^\\s*])?)\\k<stars>';
/** 一颗星号：*…*，里面 1 到 30 个字，星号和字之间没有空白（3 * 4 * 5、* 笑 * 不是）。一个捕获组：里面的字。 */
export const SINGLE_STAR_PATTERN = '\\*([^\\s*](?:[^*\\n]{0,28}[^\\s*])?)\\*';
/**
 * 星号写的舞台说明：就是一颗星号的 SINGLE_STAR_PATTERN，和一颗星号的强调同一条规矩：星号里面紧挨着的字都不是空白。一个捕获组：星号里的字。
 * 星号和字之间有空白的一对（3 * 4 * 5 里的「* 4 *」、行首的项目符号 `* 第一项 *`、两边空着的 `* 笑 *`）不是舞台说明，是正文，原样念、原样显示
 * （lib/line-hints.mjs 文件头「括号」）。配音读舞台说明（lib/line-hints.mjs 的 DIRECTION_RE）和预览卡片去掉舞台说明（spoken-words.mjs）都用它：
 * 先按 EMPHASIS_PATTERN 去掉加粗、留下一颗星号的，再用它。
 */
export const STAR_DIRECTION_PATTERN = SINGLE_STAR_PATTERN;
/**
 * 强调，两种写法（BOLD_PATTERN、SINGLE_STAR_PATTERN），按出现的先后各认各的（规则和为什么这样写，见 lib/line-hints.mjs 的 EMPHASIS_RE 上面）。
 * 命名的组 stars、bold 是加粗的星号和字，第三个捕获组是一颗星号里的字。
 */
export const EMPHASIS_PATTERN = `${BOLD_PATTERN}|${SINGLE_STAR_PATTERN}`;
