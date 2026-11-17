// SPDX-License-Identifier: Apache-2.0
//
// 配音指引里的五个小节：「### 这个人是谁」「### 音色」「### 演法」「### 台词」「### 换语言时怎么说」。写在「## 配音指引」下面，对格式来说五节都可选，做包也不要求哪一节，小节名不翻译（和标记行一样，所有语言原样写）。
//   guidanceSection(guidance, name)   指引里这一节的正文：标题行的下一行起，到下一个 ## 或 ### 标题为止（#### 及更深的标题是正文），去掉前后空白；
//                                     没有这一节（或它的标题名对不上）返回 undefined；有这一节、正文是空的返回空串。
//
// 这一份只读小节。哪一段指引交给配音模型，由调用方自己定，协议核心不替它挑（配音 lib/dub.mjs 也不交指引）。
// 不 import 别的模块，所以它要小（同 lib/language-tag.mjs）。模块约定见 protocol/README.md：浏览器和 Node 都能跑。

const SECTION_NAMES = ['这个人是谁', '音色', '演法', '台词', '换语言时怎么说'];

/**
 * 找指引里的一节。标题行是「### 名字」，名字前后的空白不算，名字必须和要的一样（SECTION_NAMES 里的一个）。
 * 正文从标题行的下一行起，到下一个 ## 或 ### 标题为止（任何名字的都算；#### 及更深的是正文）。每行带着自己的换行切开，正文的换行（LF 或 CRLF）原样保留，再去掉前后的空白。
 * @param {unknown} guidance 配音指引（Markdown）
 * @param {string} name 要的那一节：SECTION_NAMES 里的一个
 * @returns {string | undefined} 没有这一节：undefined；有，正文是空的：''
 */
export function guidanceSection(guidance, name) {
  if (typeof guidance !== 'string' || !SECTION_NAMES.includes(name)) return undefined;
  const lines = guidance.split(/(?<=\n)/);
  const headingOf = (line) => {
    const match = /^(#{2,3})(?!#)(?:[ \t]+(.*?))?[ \t]*\r?\n?$/.exec(line);
    return match ? { level: match[1].length, name: match[2] ?? '' } : null;
  };
  const at = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading !== null && heading.level === 3 && heading.name === name;
  });
  if (at === -1) return undefined;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (headingOf(line) !== null) break;
    body.push(line);
  }
  return body.join('').trim();
}
