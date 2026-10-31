// SPDX-License-Identifier: Apache-2.0
//
// 配音指引里的三个小节：「### 音色」「### 演法」「### 台词」。写在「## 配音指引」下面，三节都可选，小节名不翻译（和标记行一样，所有语言原样写）。
//   guidanceSection(guidance, name)   指引里这一节的正文：标题行的下一行起，到下一个 ## 或 ### 标题为止（#### 及更深的标题是正文），去掉前后空白；
//                                     没有这一节（或它的标题名对不上）返回 undefined；有这一节、正文是空的返回空串。
//   hasGuidanceSections(guidance)     指引里有三个小节中的任何一个：新式（只交演法）；三个都没有：旧式（整段交）。
//   guidanceForModel(guidance)        交给配音模型的那段：新式只有演法的正文（没有演法，或演法是空的：''）；旧式是整段。不是字符串：undefined。
//   PERFORMANCE_SECTION               「演法」的标题名。
//
// 这一份服务基础部分的配音流程（lib/dub.mjs）和 app 的声音页。适配器（limits.mjs）有一份逐行一致的镜像：适配器不能 import 基础部分（那边的注释写了原因），
// 两份由对照测试钉在一起；改这一份，那一份也要改。
// 不 import 别的模块，所以它要小（同 lib/language-tag.mjs）。模块约定见 protocol/README.md：浏览器和 Node 都能跑。

export const PERFORMANCE_SECTION = '演法';

const SECTION_NAMES = ['音色', '演法', '台词'];

/**
 * 找指引里的一节。标题行是「### 名字」，名字前后的空白不算，名字必须和要的一样（音色、演法、台词）。
 * 正文从标题行的下一行起，到下一个 ## 或 ### 标题为止（任何名字的都算；#### 及更深的是正文）。每行带着自己的换行切开，正文的换行（LF 或 CRLF）原样保留，再去掉前后的空白。
 * @param {unknown} guidance 配音指引（Markdown）
 * @param {string} name 要的那一节：音色、演法、台词
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

/**
 * 指引是新式的：有三个小节（音色、演法、台词）中的任何一个。新式的指引只交演法；三个都没有的是旧式，整段交。
 * @param {unknown} guidance 配音指引（Markdown）
 * @returns {boolean}
 */
export function hasGuidanceSections(guidance) {
  return SECTION_NAMES.some((name) => guidanceSection(guidance, name) !== undefined);
}

/**
 * 交给配音模型的那段指引：新式的只有演法的正文（没有演法一节，或它是空的：''，什么都不交）；旧式（三个小节都没有）的整段，同以前。
 * 不是字符串：undefined（调用方按没有指引处理）。
 * @param {unknown} guidance 配音指引（Markdown）
 * @returns {string | undefined}
 */
export function guidanceForModel(guidance) {
  if (typeof guidance !== 'string') return undefined;
  if (!hasGuidanceSections(guidance)) return guidance;
  return guidanceSection(guidance, PERFORMANCE_SECTION) ?? '';
}
