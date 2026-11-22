// SPDX-License-Identifier: Apache-2.0
//
// 配音指引里写给写台本的人看的两节（「这个人是谁」「换语言时怎么说」）的项怎么读（纯计算）：协议核心只读到节为止（protocol/lib/guidance-sections.mjs），项在这里读。
// 材料提示（lib/material-hints.mjs 的 guidanceGaps：哪几项没填）和配音（lib/dub.mjs 第 7c 步：台词开头的名字认得不认得）用同一处解析。
//
//   itemValues(guidance, section) -> Map<项名, 值> | undefined
//     节里的项：每行「- 项名：值」，项名和值前后的空白不算；同一项写了两次的取第一次。没有这一节是 undefined；有这一节、项没写的，Map 里没有它。
//   GAP   值写着「缺」（前面可以有语言标签，后面可以有括号里的说明）：「缺」「en 缺」「缺（待问）」。
//   namesOf(value) -> { tag, name }[]
//     「名字」项的值：每种语言一个全名，用「；」隔开（`en Draco Malfoy；zh 德拉科·马尔福`）。每段是语言标签加名字，写着「缺」的段不要；没有语言标签的段 tag 是 undefined，整段是名字（语言标签是小写的，首字母大写的两段整段是名字）。
//     值是「缺」或者空的，是 []。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { guidanceSection } from '../protocol/lib/guidance-sections.mjs';

const ITEM_LINE = /^\s*-\s*([^：:]+?)\s*[：:]\s*(.*)$/u;
export const GAP = /^(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\s+)?缺\s*(?:[（(].*)?$/u;
// 语言标签写小写（en、zh-CN、ja，格式里的写法）：首字母大写的两段（Lin Wan）整段是名字，不拆成语言 Lin 加名字 Wan
const TAGGED_NAME = /^([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\s+(.+)$/u;

/** 节里的项（文件头 itemValues）。 */
export function itemValues(guidance, section) {
  const body = guidanceSection(guidance, section);
  if (body === undefined) return undefined;
  const values = new Map();
  for (const line of body.split(/\r?\n/u)) {
    const match = ITEM_LINE.exec(line);
    if (match !== null && !values.has(match[1])) values.set(match[1], match[2].trim());
  }
  return values;
}

/** 「名字」项的值拆成 { tag, name } 的数组（文件头 namesOf）。 */
export function namesOf(value) {
  if (value === undefined || value === '' || GAP.test(value)) return [];
  return value
    .split(/[；;]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '' && GAP.exec(part) === null)
    .map((part) => {
      const tagged = TAGGED_NAME.exec(part);
      return tagged === null ? { tag: undefined, name: part } : { tag: tagged[1], name: tagged[2].trim() };
    });
}
