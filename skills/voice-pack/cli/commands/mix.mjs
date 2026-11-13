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
//   目录之间不另加停顿：两边台本都没写停顿的接缝，一毫秒都不插。其中同一个包接着说的（前一个目录最后说话的包和后一个目录第一句的包相同，认法同换人处），
//   文字输出点名是哪两个目录之间，说要停一口气在后一份台本开头（或者前一份末尾）写 [pause 0.5s]，已经配好的用同一个 --out、不带 --only 再跑那条 dub
//   （全部沿用；带着 --only 的，点到的几句一律重配、再计一次费），再 mix；换人处的接缝照换人处削（同一个目录里也是这样接），不点名。--json 里没有这一句。
//   文字输出的「插了几段静音」只数插进去的，各句音频自带的头尾安静不算。
// --out：成品写到这个 .wav 文件。已经存在就拒绝（file_exists），不覆盖。
// 不出成品（退出 1，错误码 mix_incomplete）：有句子没做成（details.failed 列出是哪几句，号数是那个目录里的。提示照每一句没做成的原因说怎么办，分法同 dub 的文字输出
//   （cli/dub-failures.mjs，dub 的文件头「文字被拒」）：原样重做就行的（服务暂时出错之类、这一次没做的）提示先用 dub --only 重做；文字被拒的说先改台本里这几句的字，再用 --only 重做
//   （不是一场戏的一句平台说一个请求装不下的，另说把它改短；要切成两个请求的，序号会变，不带 --only 再跑：加章节标记的只重新切那一章，别的章做好的沿用，
//   调小 --max-chars 的整份重新切，切法变了的做好了也要重配、再计一次费）；比合成能力的下限短的（text_too_short）不给 --only，说原样重做没有用、
//   先改台本让它够长；一场戏装不下的不给 --only，说在那一场中间加章节标记切开或者 --no-scene；这两种都说改好以后不带 --only 再跑那条 dub 命令（序号可能会变，做好的、请求没变的沿用）。
//   只给一条重做的命令（cli/dub-failures.mjs 的文件头「只给一条重做的命令」）：有字太少的、一场戏装不下的，别的没做成的（文字被拒的先改字）都在那一次不带 --only 的里一起重做，
//   不另给 --only；没有这两种的，文字被拒的和原样重做就行的并成一条 --only（先改字）。不给先跑一半的那条：照它先跑，没点到的被拒的、装不下的一场会记成这一次没做，原因就丢了。
//   叫人加章节标记切开的两处（一场戏装不下、一句装不下），同一句里跟着写提醒（lib/dub.mjs 的 CHAPTER_SPLIT_REMINDER，同 dub 的输出）：标题后面重写 [voice:名字]、要停一口气写 [pause 0.5s]。
//   要先改台本的，都指到 dub 的输出里那一段、dub.json 里这一句的 error。服务那头做完了、结果没取回的那几句
//   （error.details.unretrieved，dub 的文件头「没取回」）不叫人 --only 重做，写明再跑整份台本的那条 dub 命令会把它重配、再计一次费（只重做别的句子的那条 --only 命令不会：dub 照旧记着它没取回），照适配器给的 error.details.retrieve 说怎么手动取回，
//   手动取回的音频现在还不能交给 mix 用）；dub 中途停下来了（details.stoppedBy）：照停下的原因说怎么办，引着 dub 停下时的说明（stoppedBy 的 code、message）。
//   没跑完的（stoppedBy.code 是 dub_unfinished）提示再跑同一条 dub 命令；连着被拒停下的（dub_text_rejected，多半是参考或别的输入被拦了）
//   说原样重做还是会被拒，先换一段参考（--reference-tag）或者改掉开头的提示（--emotion、--style、--energy），换了还被拒才改那几句的字（点名是哪几句，序号同 --only）；别的错停下的，
//   先照停下的原因处理好（401 这类要先让使用者处理）。都不给新的 --only（停下以后没开始的句子不在 dub.json 里，点不全），说处理好以后再跑停下的那条 dub 命令，
//   带着 --only 的照样带着（去掉了，那条命令里只想给那几句用的 --reference-tag 就用到整份台本上，做好的句子请求变了也要重配、再计一次费；只有参考是这样：
//   情绪、风格、能量改的是每一句开头的提示，带着 --only 没点到的句子也沿用不了，cli/commands/dub.mjs 文件头「沿用」）。停在 dub_text_rejected 的，换参考、换开头的提示分开说：
//   换参考的只换 --reference-tag，带着 --only 的照样带着；换开头的提示的（--emotion、--style、--energy、设定写的）每一句开头的提示都变了，照旧带着 --only 再跑，没点到的会记成这一次没做（skipped），
//   所以给两条路：只给没做好的几句换，改成 .json 台本，新的写在这几项自己的 labels 上（盖过命令行和设定的；不能是空的），命令里的 --emotion 这几个、--setup、--only 照旧，
//   做好的沿用（怎么改指到 references/dub-details.md「Changing only the opening cue of a few lines」）；或者整份都换，不带 --only 再跑（去掉了 --only，那条命令里只想给那几句用的 --reference-tag 也用到整份台本上，
//   只想那几句用它的，把台本拆成几份、各跑一次 dub，再用 mix 接起来：一次 dub 里一个包只用一个参考标签）。不带 --only 的，换了参考或开头的提示，参考段或开头的提示变了的句子
//   做好的也要重配、再计一次费（点名现在做好的几句）。
//   停下的那条带没带 --only，dub.json 里看不出来，两种都说：不带 --only 的做好的沿用；带着 --only 的点到的一律重配，停下以前这一次做好的几句（ok、没有 carriedOver）
//   点名，说从 --only 里去掉它们再跑（去掉以后沿用这一次做好的）。停在 dub_text_rejected 的也点名（dub 停下时已经发出去、后来成了的），两条路各说：换参考的留着它们会照新的参考重配、
//   再计一次费，要留着原来的就从 --only 里去掉；换开头的提示的第一条路，它们不写新的，要从 --only 里去掉（留着会照原来的提示和参考重配、再计一次费）。
//   停下以前就没做成、原样再跑还是做不成的句子（dub.json 里文字被拒的、比下限短的、装不下的）
//   也点名，说再跑之前先改台本（改长、切开的序号可能会变，带着 --only 的照新的序号点），有就列在 details.failed（写法同没停下时的；停下以后没开始的不在里面）。
//   合成以后的几步出错、没做完的句子（afterSynthesisFailed）和没取回的句子会重配、再计一次费，有就写明。
//   几个目录时先把每个目录都查过，再读音频：按给的次序，第一个不完整的目录报错，details.directory 是它（绝对路径），两种都写。
// 其他错误：mix_input_invalid（没有 dub.json，或它不是 dub 的报告）；file_unreadable（某一句的文件读不了）；runtime_missing（句子是 mp3 等非 WAV，要 ffmpeg，点名 ffmpeg）；
//   mix_too_long（成品超过一份 WAV 能装的长度，或内存放不下它：details 点名是哪一句、哪一边的停顿、多长，见 lib/mix.mjs 规则 8）。
// 退出码：0 成品写好了；1 出错（错误码在标准错误）；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { writeNewFile } from '../../protocol/cli/disk.mjs';
import { planMix, mixParts } from '../../lib/mix.mjs';
import { CHAPTER_SPLIT_REMINDER } from '../../lib/dub.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, usageProblem } from '../input.mjs';
import { isTextRejectedUnit, isTooLong, isTooLongScene, isTooShortUnit, isUnretrievedUnit, rerunsWithoutOnly } from '../dub-failures.mjs';

export const summary = 'Join the lines dub has finished into one WAV result (pauses, order, speed; computed locally, free)';
export const usage = 'mix <dub-output-dir>... --out <file.wav> [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，不在表里）。 */
export const FLAGS = { out: 'string' };

const REPORT_FILE = 'dub.json';
/** dub 没跑完时 dub.json 的 stoppedBy.code（cli/commands/dub.mjs 的 UNFINISHED）。 */
const DUB_UNFINISHED = 'dub_unfinished';
/** dub 停在「连着被拒」的保护上时的 stoppedBy.code（lib/dub.mjs 的文件头「一段失败了怎么办」：还没有一句成功、服务商拒了 3 句）。 */
const DUB_TEXT_REJECTED = 'dub_text_rejected';

/** 一串句号写成 line 3 或 lines 3, 4, 5（文字输出和提示用）。 */
const linesOf = (numbers) => `${numbers.length === 1 ? 'line' : 'lines'} ${numbers.join(', ')}`;

/** 没取回的一句怎么取回（dub 报告里这一句的 error.details.retrieve，同 dub 的文字输出：网址一律不打印）；没给就让人看适配器的说明。 */
const retrieveOf = (item) => {
  const said = item.error?.details?.retrieve;
  return typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '(URL not printed)') : `the adapter did not say how to retrieve it (error code ${item.error?.code}); see the adapter's description`;
};

/**
 * 没做成的几句怎么办（mix_incomplete 的提示）：分法同 dub 的文字输出（cli/dub-failures.mjs，cli/commands/dub.mjs 的文件头「没取回」「文字被拒」）。
 * 原样重做就行的（服务暂时出错之类，这一次没做的）给 --only；文字被拒的先改字再 --only；字太少的、一场戏装不下的要先改台本，改好以后不带 --only 再跑（序号可能会变）；
 * 只给一条命令：有字太少的、装不下的，别的都在那一次不带 --only 的里一起重做；不然文字被拒的和原样重做就行的并成一条 --only（cli/dub-failures.mjs 的 rerunsWithoutOnly）。
 * 没取回的不叫人重做。要改台本的，指到 dub 的输出里那一段、dub.json 里这一句的 error。items 是 planMix 的 incomplete，report 是这个目录的 dub.json，keep 是几个目录时跟在命令后面的那句。
 */
function redoAdvice(items, report, keep) {
  // 报告里的这一句（一场戏有 scene，分法要看它）；planMix 的 number 是 index + 1
  const unitOf = (item) => report.units.find((unit) => unit.index === item.number - 1) ?? item;
  const pick = (test) => items.filter((item) => test(unitOf(item)));
  const unretrieved = pick(isUnretrievedUnit);
  const tooShort = pick(isTooShortUnit);
  const tooLongScenes = pick(isTooLongScene);
  const rejected = pick(isTextRejectedUnit);
  const special = new Set([...unretrieved, ...tooShort, ...tooLongScenes, ...rejected]);
  const redo = items.filter((item) => !special.has(item));
  const numbers = (list) => list.map((item) => item.number);
  if (special.size === 0) return `first redo ${redo.length === 1 ? 'this line' : 'these lines'} with dub --only ${numbers(redo).join(',')}${keep}; then mix`;
  const these = (list) => (list.length === 1 ? 'this line' : 'these lines');
  // 只给一条重做的命令（cli/dub-failures.mjs 的文件头）：有字太少的、一场戏装不下的，只说改好以后不带 --only 再跑；不然文字被拒的和原样重做就行的并成一条 --only
  const rerun = rerunsWithoutOnly(items.map(unitOf));
  const parts = [];
  if (rejected.length > 0) {
    const codes = [...new Set(rejected.map((item) => unitOf(item).error?.code))].join(', ');
    const fix = `the text of ${linesOf(numbers(rejected))} was rejected (error code ${codes}; the reason is in the "Text rejected" section of the dub output, or in the error of ${these(rejected)} in dub.json; it depends only on the text of ${these(rejected)}, and redoing it unchanged is rejected again): first change the text of ${these(rejected)} in the script`;
    // 原样重做就行的一起点上：先单独重做它们，没点到的被拒的句子会记成这一次没做，被拒的原因就从 dub.json 里丢了
    const together = redo.length > 0 ? ` (this also redoes ${linesOf(numbers(redo))}, which can simply be redone unchanged; do not redo ${redo.length === 1 ? 'it' : 'them'} alone first: a rejected line that --only does not name is recorded as not done this time, and the reason it was rejected is lost from dub.json)` : '';
    const all = numbers([...rejected, ...redo]).sort((a, b) => a - b);
    parts.push(rerun ? fix : `${fix}; then redo with one command: dub --only ${all.join(',')}${keep}${together}`);
    // 不是一场戏的一句，平台说一个请求装不下（dub 的文件头「文字被拒」的例外的最后一条）：改短；要切成两个请求的，序号会变。两种切法代价不同，同 dub 的那一行：
    // 加章节标记只重新切那一章，调小 --max-chars 整份重新切（做好的切法变了也要重配、再计一次费）
    const long = rejected.filter((item) => isTooLong(unitOf(item)));
    const who = long.length === rejected.length ? `the platform says one request cannot hold ${these(long)}` : `among them, ${linesOf(numbers(long))}: the platform says one request cannot hold ${long.length === 1 ? 'it' : 'them'}`;
    if (long.length > 0) parts.push(`${who}: shorten ${long.length === 1 ? 'it' : 'them'}${rerun ? '' : ', then redo with this command'}; to split into two requests, the line numbers change after the split, so after fixing run that dub command again without --only (to split in the middle, start a new line with a chapter marker # title (${CHAPTER_SPLIT_REMINDER}) and only that chapter is split again, while chapters already done are reused at no extra cost; if you lower --max-chars for dub, the whole script is split again by the new number and every request longer than it is split, and lines whose split changed must be dubbed again and are charged again)`);
  } else if (redo.length > 0 && !rerun) {
    parts.push(`first redo ${linesOf(numbers(redo))} with dub --only ${numbers(redo).join(',')}${keep}`);
  }
  if (tooShort.length > 0) {
    const min = unitOf(tooShort[0]).error?.details?.min;
    parts.push(`${linesOf(numbers(tooShort))}: shorter than the lower limit of the synthesis capability${typeof min === 'number' ? ` (${min} characters)` : ''}, and not long enough together with the neighbouring lines either, so dub did not synthesize ${tooShort.length === 1 ? 'it' : 'them'} (the character counts are in the "Not synthesized" section of the dub output, or in the error of ${these(tooShort)} in dub.json): redoing unchanged does not help; first change the script to make ${these(tooShort)} long enough`);
  }
  if (tooLongScenes.length > 0) {
    parts.push(`${linesOf(numbers(tooLongScenes))} (one request per scene): the platform says one request cannot hold ${tooLongScenes.length === 1 ? 'it' : 'them'}, and redoing unchanged does not fit either (see the "Does not fit" section of the dub output, or the error of ${these(tooLongScenes)} in dub.json): add a chapter marker (# title) in the middle of the scene to split it into two scenes (${CHAPTER_SPLIT_REMINDER}), or add --no-scene to dub for one request per line (the whole script then goes one request per line, and scenes already done must be dubbed again)`);
  }
  if (rerun) {
    // 字太少的、一场戏装不下的：改好以后不带 --only 再跑（序号可能会变），别的没做成的在这一次里一起重做，不另给 --only
    const others = numbers([...rejected, ...redo]).sort((a, b) => a - b);
    parts.push(`after fixing, run that dub command again without --only${keep} (the line numbers may change; lines already done whose request did not change are reused at no extra cost${others.length > 0 ? `; ${linesOf(others)}, which were not done, are also redone in that run, so no separate --only run is needed` : ''})`);
  }
  if (unretrieved.length > 0) parts.push(unretrievedAdvice(unretrieved));
  return parts.join('; ');
}

/**
 * 服务那头做完了、结果没取回的几句（error.details.unretrieved，dub 的文件头「没取回」）：dub 重配会再计一次费，不叫人重做；说清再跑 dub 会重配、计费，不想重配照适配器说的手动取回。
 * items 是报告里的这几句（有 number 或 index，有 error）。
 */
function unretrievedAdvice(items) {
  const numbers = items.map((item) => item.number ?? item.index + 1);
  return `${linesOf(numbers)}: the service has finished and billed ${numbers.length === 1 ? 'it' : 'them'}, but the result was not retrieved: running the dub command for the whole script again (the one that only redoes other lines does not) dubs ${numbers.length === 1 ? 'it' : 'them'} again and charges again; if you do not want that, retrieve ${numbers.length === 1 ? 'it' : 'them'} by hand as the adapter says (${items.map(retrieveOf).join('; ')}); audio retrieved by hand cannot yet be handed to mix`;
}

/**
 * dub 中途停下来了（dub.json 的 stoppedBy）怎么办：mix_incomplete 的提示里，跟在括号里引的 dub 停下时的说明（stoppedBy 的 code、message）后面。
 *   没跑完的（dub_unfinished：进程被杀、命令超时）：再跑同一条 dub 命令（cli/commands/dub.mjs 文件头「沿用」）。
 *   连着被拒停下的（dub_text_rejected：还没有一句成功、服务商已经拒了 3 句，多半是参考或别的输入被拦了）：原样重做还是会被拒。
 *     先换一段参考（--reference-tag）或者改掉开头的提示（--emotion、--style、--energy），换了还被拒的才是那几句的字的问题（改字）；再跑停下的那条命令，换参考、换开头的提示分开说（byReference、byOpeningCue）：
 *     换参考的只换 --reference-tag，--only 没点到的不比参考段，照旧沿用；换开头的提示的，每一句开头的提示都变了，--only 没点到的对不上（沿用比开头的提示），记成 skipped，
 *     所以只给没做好的几句换的，用 .json 台本项自己的 labels（盖过 --emotion 这几个和设定写的），命令照旧；整份都换的，不带 --only 再跑，
 *     那条命令里只想给那几句用的 --reference-tag 也用到整份台本上（wholeScript 那句写明，只想那几句用它的拆成几次 dub、再 mix）。
 *   别的错（401、参数不对……）：原样再跑多半还会这样停，先照停下的原因处理好，再跑停下的那条命令。
 * 都是再跑停下的那条命令，带着 --only 的照样带着：去掉了，那条命令里只想给那几句用的参考（--reference-tag）就用到整份台本上，
 *   做好的句子请求变了，也要重配、再计一次费（只有参考是这样：情绪、风格、能量带着 --only 也改没点到的句子开头的提示，keepOnly 那句照实写）。mix 也不另给 --only：停下以后没开始的句子不在 dub.json 里，点不全。停下的那条带没带 --only，dub.json 里看不出来，
 *   所以两种都说：做好的沿用不沿用（carriedAdvice；dub_text_rejected 那一支是 doneHere，换参考、换开头的提示各说各的）；换了参考、开头的提示的，不带 --only 的那条做好的也要重配（dub_text_rejected 那一支）。
 * 停下以前就没做成、原样再跑还是做不成的句子（文字被拒的、比下限短的、装不下的）也点名，说再跑之前先改（fixFirstAdvice）。
 * 合成以后的几步出错的句子（afterSynthesisFailed）和没取回的句子，再跑会重配、再计一次费，有就写明。report 是这个目录的 dub.json，keep 是几个目录时跟在命令后面的那句。
 */
function stoppedAdvice(stopped, report, keep) {
  const units = Array.isArray(report.units) ? report.units.filter(isPlainObject) : [];
  const unretrieved = units.filter(isUnretrievedUnit);
  const tail = unretrieved.length > 0 ? `; ${unretrievedAdvice(unretrieved)}` : '';
  const unfinishedAfterSynthesis = units.filter((unit) => unit.status === 'ok' && unit.afterSynthesisFailed !== undefined).map((unit) => unit.index + 1);
  const rebilled = unfinishedAfterSynthesis.length > 0 ? `; ${linesOf(unfinishedAfterSynthesis)}: synthesized, but the steps after synthesis failed, so ${unfinishedAfterSynthesis.length === 1 ? 'it is' : 'they are'} not counted as done and will be dubbed again and charged again` : '';
  // 再跑停下的那条命令：带着 --only 的照样带着（去掉了，只想给那几句用的参考就用到整份台本上）。带着 --only 只管点到的几句的只有参考：
  // 没点到的不比参考段；情绪、风格、能量改的是每一句开头的提示，沿用要它一样（cli/commands/dub.mjs 文件头「沿用」）
  const keepOnly = 'keep --only if the command had it: if you remove it, the --reference-tag that was meant for only some lines in that command applies to the whole script, so the lines already done get a different request and must be dubbed again and charged again (this holds only for the reference: emotion, style and energy change the cue at the start of every line, so with --only the lines it does not name cannot be reused either)';
  if (stopped.code === DUB_UNFINISHED) {
    const fixes = fixFirstAdvice(units, new Set());
    const first = fixes.length > 0 ? `${fixes.join('; ')}; after fixing, ` : '';
    return `${first}run the same dub command again${keep} with the same options (${keepOnly}); ${carriedAdvice(units)}${rebilled}, then mix${tail}`;
  }
  const said = ' (the explanation is the part in parentheses at the start of this message: dub printed it to standard error when it stopped, and it is also in stoppedBy in dub.json)';
  if (stopped.code === DUB_TEXT_REJECTED) {
    // 被拒的几句：stoppedBy.details.rejected 的 unit 从 0 起，换成和 --only、文件名一样从 1 起的序号；没有就看报告里文字被拒的几句
    const listed = Array.isArray(stopped.details?.rejected) ? stopped.details.rejected.map((item) => item?.unit).filter(Number.isInteger).map((unit) => unit + 1) : [];
    const rejected = listed.length > 0 ? listed : units.filter(isTextRejectedUnit).map((unit) => unit.index + 1);
    const which = rejected.length > 0 ? `the rejected ${linesOf(rejected)}` : 'the rejected lines';
    const fixes = fixFirstAdvice(units, new Set(rejected));
    // 沿用只认同一个请求（cli/commands/dub.mjs 文件头「沿用」）：不带 --only 的那条，参考段或开头的提示变了的句子做好的也要重配
    const done = units.filter((unit) => unit.status === 'ok' && unit.afterSynthesisFailed === undefined).map((unit) => unit.index + 1);
    const redone = done.length > 0 ? `, and ${linesOf(done)}, done now, must also be charged again` : ''; // 这个目录里还没有做好的句子：没有要多付的
    // 停下以前这一次做好的（ok、不是沿用来的；dub 停下时已经发出去、后来成了的）：停下的那条带着 --only 的话它们是点到的，照旧带着会重配（同 carriedAdvice），两条路各说
    const doneHere = units.filter((unit) => unit.status === 'ok' && unit.carriedOver !== true && unit.afterSynthesisFailed === undefined).map((unit) => unit.index + 1);
    const it = doneHere.length === 1 ? 'it' : 'them';
    const they = doneHere.length === 1 ? 'it' : 'they';
    const hereNamed = `${linesOf(doneHere)}, done in this run before dub stopped`;
    // 换参考：--only 没点到的不比参考段，照旧沿用，带着 --only 的照样带着；点到的、这一次做好的照新的参考重配，要留着就从 --only 里去掉
    const hereByReference = doneHere.length > 0 ? `; if --only names ${hereNamed}, ${they} will also be dubbed again with the new reference and charged again; to keep ${it}, remove ${it} from --only and ${doneHere.length === 1 ? 'it is' : 'they are'} reused` : '';
    const byReference = `To change the reference, change only --reference-tag and keep --only if the command had it: only the lines it names are dubbed again (lines it does not name are not compared with the reference segment and are reused as before${hereByReference}); without --only the whole script is run, and every line whose reference segment changed must be dubbed again${redone}`;
    // 换开头的提示：每一句开头的提示都变了，沿用比开头的提示，带着 --only 没点到的对不上、记成 skipped。只给没做好的几句换，用 .json 台本项自己的 labels（盖过命令行和设定的）；
    // 这一次做好的不写新的，留在 --only 里会照原来的提示和参考重配，所以要从 --only 里去掉（去掉以后开头的提示没变，沿用）
    const hereByOpeningCue = doneHere.length > 0 ? `, except ${hereNamed}: ${doneHere.length === 1 ? 'it does' : 'they do'} not get a new one, so remove ${it} from --only (if kept, ${they} will be dubbed again with the old cue and reference and charged again)` : '';
    const kept = done.length > 0 ? `lines already done (${done.join(', ')}) are reused at no cost` : 'lines already done are reused at no cost';
    // 整份都换：去掉了 --only，停下的那条命令里只想给那几句用的 --reference-tag 也用到整份台本上（同 keepOnly）；一次 dub 里一个包只用一个参考标签，只想那几句用它的拆开跑、再 mix
    const wholeScript = ' (with --only removed, the --reference-tag that was meant for only some lines in that command applies to the whole script, so the lines it did not name also switch reference segment; if only some lines should use it, split the script into several parts and run dub once for each (one dub run uses only one reference tag per pack, and each part gets its own --out), then join them with mix in order)';
    const byOpeningCue = `To change the opening cue (--emotion, --style, --energy, or what the setup writes), the cue at the start of every line changes, and reuse needs the same opening cue: running again with --only, the lines it does not name no longer match the last run and are recorded as not done this time (skipped), so mix still cannot produce a result. Two ways: to change only the lines that are not done, change the script into a .json script (how: references/dub-details.md「Changing only the opening cue of a few lines」), write the new cue in the labels of those items themselves (it overrides the same item from --emotion and the like and from the setup; it cannot be empty, and to remove a cue use the second way), keep --emotion and the like and --setup in the command as they are, and keep --only if the command had it${hereByOpeningCue}, ${kept}; or change the whole script: run again without --only${wholeScript}, and every line is dubbed again with the new opening cue${redone}`;
    return `running it again unchanged is rejected again, most likely because the reference or another input was blocked${said}: first switch to another reference (give dub another --reference-tag, that is, another reference tag, or add one if none was given; the pack's SKILL.md lists the tags per language), or change or remove the opening cue (--emotion, --style, --energy; for what a setup writes, switch to another --setup or use --no-setup); if it is still rejected after that, it is most likely a problem with the text of ${which}: first change the text of those lines in the script${fixes.length > 0 ? `; ${fixes.join('; ')}` : ''}. After fixing, run the dub command that stopped again${keep}, with the other options unchanged. ${byReference}. ${byOpeningCue}${rebilled}, then mix${tail}`;
  }
  const fixes = fixFirstAdvice(units, new Set());
  return `running it again unchanged will most likely stop the same way: first deal with the reason dub stopped${said}; an authorization problem such as 401 has to be dealt with by the user first; ${fixes.length > 0 ? `${fixes.join('; ')}; ` : ''}after all of that, run the dub command that stopped again${keep} with the same options (${keepOnly}); ${carriedAdvice(units)}${rebilled}, then mix${tail}`;
}

/**
 * 再跑停下的那条命令时，做好的句子沿用不沿用（cli/commands/dub.mjs 的文件头「沿用」）：不带 --only 的，做好的（请求没变的）沿用；带着 --only 的，没点到的沿用，点到的一律重配。
 * 停下以前这一次做好的几句（ok，不是沿用来的，合成以后的几步也做完了），停下的那条带着 --only 的话就是点到的：原样再跑会重配、再计一次费，所以点名它们，说从 --only 里去掉再跑
 * （去掉以后它们是没点到的，沿用这一次做好的）。停下的那条带没带 --only，dub.json 里看不出来，两种都说。units 是 dub.json 里的句子。
 */
function carriedAdvice(units) {
  const done = units.filter((unit) => unit.status === 'ok' && unit.carriedOver !== true && unit.afterSynthesisFailed === undefined).map((unit) => unit.index + 1);
  if (done.length === 0) return 'lines already done are reused at no extra cost';
  const them = done.length === 1 ? 'it' : 'them';
  return `without --only, lines already done are reused at no extra cost; with --only, the lines it names are all dubbed again: ${linesOf(done)}, done in this run before dub stopped, so remove ${them} from --only before running again, and ${done.length === 1 ? 'it is' : 'they are'} reused at no extra cost`;
}

/**
 * 停下以前就没做成、原样再跑还是做不成的几句（dub.json 里有的，都是停下的那一次里试过的）：照停下的原因处理好、原样再跑，这几句还会再发、再被拒，
 * mix 还是不出成品，所以停下的提示里也点名，说再跑之前先改台本。分法同 redoAdvice（cli/dub-failures.mjs）：文字被拒的改字（不是一场戏的一句装不下的，改短或者加章节标记切开）；
 * 比下限短的改长；一场戏装不下的切开或者 --no-scene。改长、切开以后序号可能会变：说带着 --only 的照新的序号点。
 * named 是另外已经点名的序号（dub_text_rejected 那一支说的被拒的几句），这里不重复。返回几段话，没有就是空数组。
 */
function fixFirstAdvice(units, named) {
  const numbersOf = (list) => list.map((unit) => unit.index + 1);
  const these = (list) => (list.length === 1 ? 'this line' : 'these lines');
  const rejected = units.filter((unit) => isTextRejectedUnit(unit) && !named.has(unit.index + 1));
  const long = rejected.filter(isTooLong);
  const refused = rejected.filter((unit) => !isTooLong(unit));
  const tooShort = units.filter(isTooShortUnit);
  const tooLongScenes = units.filter(isTooLongScene);
  const parts = [];
  if (refused.length > 0) {
    const codes = [...new Set(refused.map((unit) => unit.error?.code))].join(', ');
    parts.push(`${linesOf(numbersOf(refused))}: the text was rejected before dub stopped (error code ${codes}; the reason is in the error of ${these(refused)} in dub.json): it depends only on the text of ${these(refused)}, and sending it again unchanged is rejected again, so before running again first change the text of ${these(refused)} in the script`);
  }
  if (long.length > 0) parts.push(`${linesOf(numbersOf(long))}: the platform said before dub stopped that one request cannot hold ${long.length === 1 ? 'it' : 'them'} (see the error of ${these(long)} in dub.json): before running again, first shorten ${long.length === 1 ? 'it' : 'them'}, or start a new line in the middle with a chapter marker # title to split it into two requests (${CHAPTER_SPLIT_REMINDER})`);
  if (tooShort.length > 0) {
    const min = tooShort[0].error?.details?.min;
    parts.push(`${linesOf(numbersOf(tooShort))}: shorter than the lower limit of the synthesis capability${typeof min === 'number' ? ` (${min} characters)` : ''}, and not long enough together with the neighbouring lines either, so dub did not synthesize ${tooShort.length === 1 ? 'it' : 'them'} (the character counts are in the error of ${these(tooShort)} in dub.json): running again unchanged still does not synthesize ${tooShort.length === 1 ? 'it' : 'them'}, so before running again first change the script to make ${these(tooShort)} long enough`);
  }
  if (tooLongScenes.length > 0) parts.push(`${linesOf(numbersOf(tooLongScenes))} (one request per scene): the platform said before dub stopped that one request cannot hold ${tooLongScenes.length === 1 ? 'it' : 'them'} (see the error of ${these(tooLongScenes)} in dub.json): running again unchanged does not fit either, so before running again first add a chapter marker (# title) in the middle of the scene to split it into two scenes (${CHAPTER_SPLIT_REMINDER}), or add --no-scene to dub (the whole script then goes one request per line, and scenes already done must be dubbed again)`);
  if (long.length + tooShort.length + tooLongScenes.length > 0) parts.push('after lengthening or splitting, the line numbers may change: if the command that stopped had --only, change --only to the new numbers (same options and the same --out; remove --only and add --dry-run to run once, and the plan shows the new numbers)');
  return parts;
}

/** 读 dub 的报告。没有、读不了、或者不是报告的，都是 mix_input_invalid。 */
function readReport(dir) {
  const file = path.join(dir, REPORT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `no ${REPORT_FILE} in ${dir} (first dub the script into this directory with dub, then mix)`, { details: { dir, reason: cause?.code ?? 'unknown' } });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('mix_input_invalid', `${file} is not JSON: ${cause.message}`, { details: { file } });
  }
  if (!isPlainObject(value) || !Array.isArray(value.units)) throw new VoicePackError('mix_input_invalid', `${file} is not a dub report (it has no units)`, { details: { file } });
  return value;
}

/**
 * 一毫秒都没插、同一个包接着说的目录接缝：前一个目录最后一句后面、后一个目录第一句前面都没有停顿（目录之间只插这两处，lib/mix.mjs 规则 7a），
 * 前一个目录最后说话的包（一场戏是 lastSpeakerPack）和后一个目录第一句的包相同。包不同的是换人处（规则 7）：照换人处削，同一个目录里也是这样接，不算。
 * 返回 [前一个目录, 后一个目录] 的数列，按给的次序；只给一个目录时是空的。
 */
function bareSeams(plans) {
  const bare = [];
  for (let i = 1; i < plans.length; i++) {
    const last = plans[i - 1].plan.units.at(-1);
    const first = plans[i].plan.units[0];
    if (last === undefined || first === undefined || last.pauseAfterMs > 0 || first.pauseBeforeMs > 0) continue;
    if ((last.lastSpeakerPack ?? last.pack ?? null) === (first.pack ?? null)) bare.push([plans[i - 1].dir, plans[i].dir]);
  }
  return bare;
}

/** 文字输出。bare 是 bareSeams 给的接缝：只写在这里，--json 里没有。 */
function render(result, bare) {
  const lines = [`Result: ${result.file}`];
  const layout = result.channels === 1 ? 'mono' : `${result.channels} channels`;
  lines.push(`Total duration ${result.durationSeconds.toFixed(2)} seconds (${result.frames} frames, ${result.sampleRate} Hz, ${layout}), ${result.units} ${result.units === 1 ? 'line' : 'lines'} joined`);
  if (result.directories !== undefined) lines.push(`Joined ${result.directories.length} ${result.directories.length === 1 ? 'directory' : 'directories'} in order: ${result.directories.map((item) => `${item.directory} (lines ${item.first}–${item.last})`).join(', ')}`);
  lines.push(`Inserted ${result.silences.count} ${result.silences.count === 1 ? 'silence' : 'silences'}, ${result.silences.totalMs} ms in total (counts only what was inserted, not the quiet at the head and tail of each line's own audio)`);
  if (bare.length > 0) lines.push(`Nothing was inserted ${bare.map(([before, after]) => `between ${before} and ${after}`).join(', ')} (between directories only the pauses written in the scripts on either side are inserted): to leave a breath, write [pause 0.5s] at the start of the later script (or the end of the earlier one); for lines already dubbed, after adding it run the same dub command again with the same --out and without --only (with --only, the lines it names are all dubbed again and charged again), the lines already done are all reused at no cost, then mix`);
  if (result.turnTrims.count > 0) lines.push(`Trimmed ${result.turnTrims.count} ${result.turnTrims.count === 1 ? 'silence' : 'silences'} at speaker changes, ${result.turnTrims.totalMs} ms in total`);
  if (result.speedChanged.length > 0) lines.push(`Speed changed (pitch kept): ${result.speedChanged.map((item) => `line ${item.number} (${item.speed})`).join(', ')}`);
  if (result.converted.length > 0) lines.push(`Converted to the format of the first line: ${linesOf(result.converted)}`);
  for (const note of result.notes) lines.push(`Note: ${note.message}`);
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length === 0) return usageProblem(ctx, usage, parsed.problem ?? 'the output directory of dub (one or more positional arguments) and --out <file.wav> are required');
  const { options } = parsed;
  if (options.out === undefined) return usageProblem(ctx, usage, '--out <file.wav> is required (the result is written there)');
  if (!/\.wav$/i.test(options.out)) return usageProblem(ctx, usage, `--out must end in .wav, got ${options.out}`);
  const dirs = parsed.positional.map((argument) => path.resolve(ctx.cwd, argument));
  const several = dirs.length > 1;
  const file = path.resolve(ctx.cwd, options.out);
  assertFresh(file);

  // 先把每个目录都查过（按给的次序，第一个不完整的报错），再读音频
  const plans = dirs.map((dir) => {
    const report = readReport(dir);
    return { dir, report, plan: planMix(report) };
  });
  for (const { dir, report, plan } of plans) {
    const where = several ? { directory: dir } : {};
    const inDir = several ? `${dir}: ` : '';
    if (plan.stopped !== null) {
      // 照停下的原因说怎么办（stoppedAdvice）：没跑完的再跑同一条命令；连着被拒的、别的错停下的，先处理停下的原因，不叫人原样 --only 重做；都是再跑停下的那条命令，带着 --only 的照样带着
      const again = stoppedAdvice(plan.stopped, report, several ? ' in the same output directory' : '');
      // 停下以前就没做成的几句（dub.json 里有的；停下以后没开始的不在里面）：有就列在 details.failed，写法同没停下时的
      const failed = report.units.filter((unit) => isPlainObject(unit) && unit.status === 'failed').map((unit) => ({ number: unit.index + 1, status: unit.status, ...(unit.error === undefined ? {} : { error: unit.error }) }));
      throw new VoicePackError('mix_incomplete', `${inDir}dub stopped midway (${plan.stopped.code}: ${plan.stopped.message}); the lines not finished produce no result; ${again}`, { details: { stoppedBy: plan.stopped, ...(failed.length > 0 ? { failed } : {}), ...where } });
    }
    if (!plan.ok) {
      const numbers = plan.incomplete.map((item) => item.number);
      const again = redoAdvice(plan.incomplete, report, several ? ' in the same output directory' : '');
      throw new VoicePackError('mix_incomplete', `${inDir}${linesOf(numbers)} ${numbers.length === 1 ? 'was' : 'were'} not finished, so no result is produced: ${again}`, { details: { failed: plan.incomplete, ...where } });
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
  ctx.stdout(ctx.json ? `${JSON.stringify(result, null, 2)}\n` : render(result, bareSeams(plans)));
  return 0;
}
