// SPDX-License-Identifier: Apache-2.0
//
// mix 命令：把 dub 的输出目录里做好的各句接成一个 WAV 成品（规则在 lib/mix.mjs）。纯本地：不调能力，不花钱（运行环境里有没有 voice-cloning 都照常）。
//
//   node cli.mjs mix <dub 输出目录>... --out <文件.wav> [--json]
//
// 输出目录：dub 写的（里面有 dub.json 和每一句的音频文件）。可以给几个（一个台本拆成几次 dub 配的，比如中途换音色基底标签）：按给的次序接成一个文件，
//   目录之间的接法同一个目录里相邻两句（前一个目录最后一句后面的停顿、后一个目录第一句前面的停顿照插；包不同就是换人处，照削；语速照变，lib/mix.mjs）。
//   几个目录时，句子的号数从第一个目录接着往下数（报告里的 number、第几句都是这个号数），报告另有 directories：每个目录 { directory, units, first, last }
//   （它的句子是成品里的第 first 到第 last 句）。只给一个目录时，输出和以前一样（没有 directories）。
// --out：成品写到这个 .wav 文件。已经存在就拒绝（file_exists），不覆盖。
// 不出成品（退出 1，错误码 mix_incomplete）：有句子没做成（details.failed 列出是哪几句，号数是那个目录里的，提示先用 dub --only 重做；服务那头做完了、结果没取回的那几句
//   （error.details.unretrieved，dub 的文件头「没取回」）不叫人 --only 重做，写明再跑整份台本的那条 dub 命令会把它重配、再计一次费（只重做别的句子的那条 --only 命令不会：dub 照旧记着它没取回），照适配器给的 error.details.retrieve 说怎么手动取回，
//   手动取回的音频现在还不能交给 mix 用）；dub 中途停下来了（details.stoppedBy；
//   没跑完的，stoppedBy.code 是 dub_unfinished，提示再跑同一条 dub 命令，做好的沿用）。
//   几个目录时先把每个目录都查过，再读音频：按给的次序，第一个不完整的目录报错，details.directory 是它（绝对路径），两种都写。
// 其他错误：mix_input_invalid（没有 dub.json，或它不是 dub 的报告）；file_unreadable（某一句的文件读不了）；runtime_missing（句子是 mp3 等非 WAV，要 ffmpeg，点名 ffmpeg）；
//   mix_too_long（成品超过一份 WAV 能装的长度，或内存放不下它：details 点名是哪一句、哪一边的停顿、多长，见 lib/mix.mjs 规则 8）。
// 退出码：0 成品写好了；1 出错（错误码在标准错误）；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { writeNewFile } from '../../protocol/cli/disk.mjs';
import { planMix, mixParts } from '../../lib/mix.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, usageProblem } from '../input.mjs';

export const summary = '把 dub 做好的各句接成一个 WAV 成品（停顿、次序、语速；本地计算，不花钱）';
export const usage = 'mix <dub 输出目录>... --out <文件.wav> [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，不在表里）。 */
export const FLAGS = { out: 'string' };

const REPORT_FILE = 'dub.json';
/** dub 没跑完时 dub.json 的 stoppedBy.code（cli/commands/dub.mjs 的 UNFINISHED）。 */
const DUB_UNFINISHED = 'dub_unfinished';

/** 没取回的一句怎么取回（dub 报告里这一句的 error.details.retrieve，同 dub 的文字输出：网址一律不打印）；没给就让人看适配器的说明。 */
const retrieveOf = (item) => {
  const said = item.error?.details?.retrieve;
  return typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '（网址不打印）') : `适配器没说怎么取回（错误码 ${item.error?.code}），看适配器的说明`;
};

/** 读 dub 的报告。没有、读不了、或者不是报告的，都是 mix_input_invalid。 */
function readReport(dir) {
  const file = path.join(dir, REPORT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `${dir} 里没有 ${REPORT_FILE}（要先用 dub 把台本配成这个目录，再 mix）`, { details: { dir, reason: cause?.code ?? 'unknown' } });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `${file} 不是 JSON：${cause.message}`, { details: { file } });
  }
  if (!isPlainObject(value) || !Array.isArray(value.units)) throw new VoicePackError('mix_input_invalid', `${file} 不是 dub 的报告（没有 units）`, { details: { file } });
  return value;
}

function render(result) {
  const lines = [`成品：${result.file}`];
  const layout = result.channels === 1 ? '单声道' : `${result.channels} 声道`;
  lines.push(`总时长 ${result.durationSeconds.toFixed(2)} 秒（${result.frames} 帧，${result.sampleRate} Hz，${layout}），接了 ${result.units} 句`);
  if (result.directories !== undefined) lines.push(`按次序接了 ${result.directories.length} 个目录：${result.directories.map((item) => `${item.directory}（第 ${item.first}–${item.last} 句）`).join('、')}`);
  lines.push(`插了 ${result.silences.count} 段静音，共 ${result.silences.totalMs} 毫秒`);
  if (result.turnTrims.count > 0) lines.push(`换人处削了 ${result.turnTrims.count} 处静音，共 ${result.turnTrims.totalMs} 毫秒`);
  if (result.speedChanged.length > 0) lines.push(`变了速（保持音高）：${result.speedChanged.map((item) => `第 ${item.number} 句（${item.speed}）`).join('、')}`);
  if (result.converted.length > 0) lines.push(`统一成第一句的格式：第 ${result.converted.join('、')} 句`);
  for (const note of result.notes) lines.push(`注意：${note.message}`);
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length === 0) return usageProblem(ctx, usage, parsed.problem ?? '要给 dub 的输出目录（一个或几个位置参数）和 --out <文件.wav>');
  const { options } = parsed;
  if (options.out === undefined) return usageProblem(ctx, usage, '要给 --out <文件.wav>（成品写到这里）');
  if (!/\.wav$/i.test(options.out)) return usageProblem(ctx, usage, `--out 要以 .wav 结尾，收到 ${options.out}`);
  const dirs = parsed.positional.map((argument) => path.resolve(ctx.cwd, argument));
  const several = dirs.length > 1;
  const file = path.resolve(ctx.cwd, options.out);
  assertFresh(file);

  // 先把每个目录都查过（按给的次序，第一个不完整的报错），再读音频
  const plans = dirs.map((dir) => ({ dir, plan: planMix(readReport(dir)) }));
  for (const { dir, plan } of plans) {
    const where = several ? { directory: dir } : {};
    const inDir = several ? `${dir} 里 ` : '';
    if (plan.stopped !== null) {
      // dub 没跑完（被打断：进程被杀、命令超时）：再跑同一条命令，做好的沿用（cli/commands/dub.mjs 文件头「沿用」）
      const again = plan.stopped.code === DUB_UNFINISHED ? `再跑同一条 dub 命令${several ? '（输出目录还是它）' : ''}，做好的会沿用，不再花钱` : `先用 dub --only 重做没做的几句${several ? '（输出目录还是它）' : ''}`;
      throw new VoicePackError('mix_incomplete', `${inDir}dub 中途停下来了（${plan.stopped.code}：${plan.stopped.message}），没做完的句子不出成品；${again}，再 mix`, { details: { stoppedBy: plan.stopped, ...where } });
    }
    if (!plan.ok) {
      const numbers = plan.incomplete.map((item) => item.number);
      // 服务那头做完了、结果没取回的（error.details.unretrieved，dub 的文件头「没取回」）：dub 重配会再计一次费，不叫人重做；说清再跑 dub 会重配、计费，不想重配照适配器说的手动取回
      const unretrieved = plan.incomplete.filter((item) => item.error?.details?.unretrieved === true);
      const redo = numbers.filter((number) => !unretrieved.some((item) => item.number === number));
      const again = unretrieved.length === 0
        ? `先用 dub --only ${numbers.join(',')} 重做这几句${several ? '（输出目录还是它）' : ''}，再 mix`
        : [
          ...(redo.length > 0 ? [`先用 dub --only ${redo.join(',')} 重做第 ${redo.join('、')} 句${several ? '（输出目录还是它）' : ''}`] : []),
          `第 ${unretrieved.map((item) => item.number).join('、')} 句服务那头已经做完、计过费，只是结果没取回：再跑整份台本的那条 dub 命令（只重做别的句子的那条不会）会把它重配，再计一次费；不想重配，照适配器说的手动取回（${unretrieved.map(retrieveOf).join('；')}），可手动取回的音频现在还不能交给 mix 用`,
        ].join('；');
      throw new VoicePackError('mix_incomplete', `${inDir}有 ${numbers.length} 句没做成（第 ${numbers.join('、')} 句），不出成品：${again}`, { details: { failed: plan.incomplete, ...where } });
    }
  }

  // 几个目录按给的次序接成一串：号数从第一个目录接着往下数
  const parts = [];
  const directories = [];
  for (const { dir, plan } of plans) {
    const offset = parts.length;
    for (const unit of plan.units) {
      parts.push({ number: offset + unit.number, bytes: readBytes(ctx, path.join(dir, unit.file)), speed: unit.speed, pauseBeforeMs: unit.pauseBeforeMs, pauseAfterMs: unit.pauseAfterMs, pack: unit.pack, ...(unit.lastSpeakerPack === undefined ? {} : { lastSpeakerPack: unit.lastSpeakerPack }) });
    }
    directories.push({ directory: dir, units: plan.units.length, first: offset + 1, last: parts.length });
  }
  const { wav, report } = await mixParts(ctx.env, parts);
  writeNewFile(file, wav);
  const result = { file, ...report, ...(several ? { directories } : {}) };
  ctx.stdout(ctx.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return 0;
}
