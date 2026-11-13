// SPDX-License-Identifier: Apache-2.0
//
// reading：中文汉字不计声调的读音，给要按读音比字的调用方（例如拿转写和台本比，转写常把同音字听错）。调用方不读 lib/mandarin-readings.json，用这个命令。
// 输入是文字（文件，或 - 读标准输入），UTF-8。每个出现过、又在读音表里的汉字一项：字 -> 读音的记号。读音一样的字，记号一样；读音表里没有的字
// （字母、数字、标点、空白、读音表没收的字）不在结果里，调用方把它们当成自己（比的时候用字本身）。
// 记号只拿来互相比，不是拼音，换了版本可能变，不要存下来跨版本比（lib/script-writing.mjs 的 readingOf）。多音字只认第一个读音。
// 加 --json：{ "readings": { "<字>": "<记号>" } }。不加：一行一个字，字和记号用制表符隔开，按字第一次出现的先后。
import { readingOf } from '../../lib/script-writing.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = 'Reading of Chinese characters, tones not counted: character -> mark, the same reading gives the same mark (for comparing characters by reading; do not read lib/mandarin-readings.json)';
export const usage = 'reading <text-file|-> [--json]';

/** 命令认的选项：没有（--json 由 runner 取走）。约定见 cli/input.mjs 文件头。 */
export const FLAGS = {};

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem);
  const readings = new Map();
  for (const letter of readText(ctx, parsed.positional[0])) {
    const mark = readingOf(letter);
    if (mark !== undefined) readings.set(letter, mark);
  }
  ctx.stdout(ctx.json ? `${JSON.stringify({ readings: Object.fromEntries(readings) }, null, 2)}\n` : [...readings].map(([letter, mark]) => `${letter}\t${mark}\n`).join(''));
  return 0;
}
