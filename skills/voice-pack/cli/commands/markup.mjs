// SPDX-License-Identifier: Apache-2.0
//
// markup：解析台本标记（章节、声音切换、停顿，只有这三种）。语法见 tools/markup.mjs 的文件头；别的方括号是提示，原样留在文字里。
// 不加 --json：每个 span 一行，写出它的声音、后面的停顿，再接文字（提示在原位）。
// 加 --json：输出 parseScript 的结果（[{ title, spans }]）。
import { parseScript } from '../../tools/markup.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = '解析台本标记：章节、声音切换、停顿（别的方括号是提示，原样留着）';
export const usage = 'markup <台本文件|-> [--default-voice <声音名>] [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { 'default-voice': 'string' };

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem);
  const chapters = parseScript(readText(ctx, parsed.positional[0]), {
    defaultVoice: parsed.options['default-voice'] ?? null,
  });
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(chapters, null, 2)}\n`);
    return 0;
  }
  const spanCount = chapters.reduce((n, c) => n + c.spans.length, 0);
  ctx.stdout(`${chapters.length} 章，${spanCount} 段\n`);
  chapters.forEach((chapter, i) => {
    ctx.stdout(`\n第 ${i + 1} 章：${chapter.title}（${chapter.spans.length} 段）\n`);
    chapter.spans.forEach((span, j) => {
      const fields = [
        span.voice_id !== null && `声音=${span.voice_id}`,
        span.pause_ms_after > 0 && `停=${span.pause_ms_after}ms`,
      ].filter(Boolean);
      ctx.stdout(`  ${j + 1}. ${fields.length ? `[${fields.join(' ')}] ` : ''}${span.text === '' ? '（只有停顿）' : span.text}\n`);
    });
  });
  return 0;
}
