// SPDX-License-Identifier: Apache-2.0
//
// 字的读音记号（纯函数）：两个字读音一样，记号就一样。别的程序要按读音比字，调这里，不另写一份。
// 做包不再拿转写和台本比写法：台本念出来的字就是段的文字（lib/make-pack-input.mjs），所以这里只剩读音记号。
//
//   readingOf(letter) -> string | undefined
//     一个字不计声调的读音的记号：两个字读音一样，记号就一样。记号只拿来互相比，不是拼音（现在是读音表里同一个读音的第一个字），
//     换了版本可能变，别存下来跨版本比。读音表里没有的字（不是汉字、不在表里、不止一个字）是 undefined。
//     库里别的程序要按读音比字，用它，不直接读 lib/mandarin-readings.json；那个文件的格式或位置改了，CHANGELOG 里写明。
//     库外的调用方（要经命令行）用 `reading` 命令（cli/commands/reading.mjs）：同一份读音，不碰这个文件。
//
// 读音表（lib/mandarin-readings.json）：每个字的第一个普通话读音（Unihan 的 kMandarin，不计声调）：多音字只认第一个（了只有 le）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import readings from './mandarin-readings.json' with { type: 'json' };

let table;
/** 字 -> 它那一行的第一个字（同一个读音的字指到同一个字）。第一次用时建。读音表里只有汉字。 */
function readingTable() {
  if (table !== undefined) return table;
  table = new Map();
  for (const line of readings.lines) {
    const [first] = line;
    for (const letter of line) table.set(letter, first);
  }
  return table;
}

/** 一个字不计声调的读音的记号（文件头）：读音表里没有的（不是汉字、不止一个字）是 undefined。 */
export function readingOf(letter) {
  return readingTable().get(letter);
}
