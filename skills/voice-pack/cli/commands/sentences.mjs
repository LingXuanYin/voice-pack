// SPDX-License-Identifier: Apache-2.0
//
// sentences：把文字切成句子，一行一句。规则见 tools/sentences.mjs 的文件头。
// 输入是不带标记的文字；台本里的标记不会被处理（带标记的台本先用 markup 命令切成 span，再对每个 span 的文字分句）。
// 加 --json：输出句子的数组。
import { splitSentences } from '../../tools/sentences.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = '分句：把文字切成句子，一行一句（不处理台本标记）';
export const usage = 'sentences <文字文件|-> [--json]';

/** 命令认的选项：没有（--json 由 runner 取走）。约定见 cli/input.mjs 文件头。 */
export const FLAGS = {};

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem);
  const sentences = splitSentences(readText(ctx, parsed.positional[0]));
  ctx.stdout(ctx.json ? `${JSON.stringify(sentences, null, 2)}\n` : sentences.map((s) => `${s}\n`).join(''));
  return 0;
}
