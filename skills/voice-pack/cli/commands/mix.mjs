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
//   说原样重做还是会被拒，先换一段参考（--reference-tag）或者改掉交给模型的说明，换了还被拒才改那几句的字（点名是哪几句，序号同 --only）；别的错停下的，
//   先照停下的原因处理好（401 这类要先让使用者处理）。都不给新的 --only（停下以后没开始的句子不在 dub.json 里，点不全），说处理好以后再跑停下的那条 dub 命令，
//   带着 --only 的照样带着（去掉了，那条命令里只想给那几句用的 --reference-tag 这类选项就用到整份台本上，做好的句子请求变了也要重配、再计一次费）；
//   停在 dub_text_rejected 的只换参考或说明，并说不带 --only 的那条换了参考、说明，参考段或开头的提示变了的句子做好的也要重配、再计一次费（点名现在做好的几句）。
//   停下的那条带没带 --only，dub.json 里看不出来，两种都说：不带 --only 的做好的沿用；带着 --only 的点到的一律重配，停下以前这一次做好的几句（ok、没有 carriedOver）
//   点名，说从 --only 里去掉它们再跑（去掉以后沿用这一次做好的）。停下以前就没做成、原样再跑还是做不成的句子（dub.json 里文字被拒的、比下限短的、装不下的）
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

export const summary = '把 dub 做好的各句接成一个 WAV 成品（停顿、次序、语速；本地计算，不花钱）';
export const usage = 'mix <dub 输出目录>... --out <文件.wav> [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，不在表里）。 */
export const FLAGS = { out: 'string' };

const REPORT_FILE = 'dub.json';
/** dub 没跑完时 dub.json 的 stoppedBy.code（cli/commands/dub.mjs 的 UNFINISHED）。 */
const DUB_UNFINISHED = 'dub_unfinished';
/** dub 停在「连着被拒」的保护上时的 stoppedBy.code（lib/dub.mjs 的文件头「一段失败了怎么办」：还没有一句成功、服务商拒了 3 句）。 */
const DUB_TEXT_REJECTED = 'dub_text_rejected';

/** 没取回的一句怎么取回（dub 报告里这一句的 error.details.retrieve，同 dub 的文字输出：网址一律不打印）；没给就让人看适配器的说明。 */
const retrieveOf = (item) => {
  const said = item.error?.details?.retrieve;
  return typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '（网址不打印）') : `适配器没说怎么取回（错误码 ${item.error?.code}），看适配器的说明`;
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
  if (special.size === 0) return `先用 dub --only ${numbers(redo).join(',')} 重做这几句${keep}，再 mix`;
  const these = (list) => (list.length === 1 ? '这一句' : '这几句');
  // 只给一条重做的命令（cli/dub-failures.mjs 的文件头）：有字太少的、一场戏装不下的，只说改好以后不带 --only 再跑；不然文字被拒的和原样重做就行的并成一条 --only
  const rerun = rerunsWithoutOnly(items.map(unitOf));
  const parts = [];
  if (rejected.length > 0) {
    const codes = [...new Set(rejected.map((item) => unitOf(item).error?.code))].join('、');
    const fix = `第 ${numbers(rejected).join('、')} 句文字被拒（错误码 ${codes}，原因见 dub 的输出里「文字被拒」一段，或者 dub.json 里${these(rejected)}的 error；只和${these(rejected)}的字有关，原样重做还是会被拒）：先改台本里${these(rejected)}的字`;
    // 原样重做就行的一起点上：先单独重做它们，没点到的被拒的句子会记成这一次没做，被拒的原因就从 dub.json 里丢了
    const together = redo.length > 0 ? `，和原样重做就行的第 ${numbers(redo).join('、')} 句一起（不先单独重做${redo.length === 1 ? '它' : '它们'}：没点到的被拒的句子会记成这一次没做，被拒的原因就从 dub.json 里丢了）` : '';
    const all = numbers([...rejected, ...redo]).sort((a, b) => a - b);
    parts.push(rerun ? fix : `${fix}，再用一条 dub --only ${all.join(',')} 重做${keep}${together}`);
    // 不是一场戏的一句，平台说一个请求装不下（dub 的文件头「文字被拒」的例外的最后一条）：改短；要切成两个请求的，序号会变。两种切法代价不同，同 dub 的那一行：
    // 加章节标记只重新切那一章，调小 --max-chars 整份重新切（做好的切法变了也要重配、再计一次费）
    const long = rejected.filter((item) => isTooLong(unitOf(item)));
    const who = long.length === rejected.length ? `平台说一个请求说不完${these(long)}` : `其中第 ${numbers(long).join('、')} 句是平台说一个请求说不完`;
    if (long.length > 0) parts.push(`${who}：把${long.length === 1 ? '它' : '它们'}改短${rerun ? '' : '，再照这条命令重做'}；要切成两个请求的，切开以后序号会变，改好以后不带 --only 再跑那条 dub 命令（在中间另起一行写章节标记 # 标题的（${CHAPTER_SPLIT_REMINDER}），只有那一章重新切，别的章做好的沿用，不重复花钱；给 dub 调小 --max-chars 的，整份台本都照新的数重新切，比新的数长的请求都会切开，切法变了的做好了也要重配、再计一次费）`);
  } else if (redo.length > 0 && !rerun) {
    parts.push(`先用 dub --only ${numbers(redo).join(',')} 重做第 ${numbers(redo).join('、')} 句${keep}`);
  }
  if (tooShort.length > 0) {
    const min = unitOf(tooShort[0]).error?.details?.min;
    parts.push(`第 ${numbers(tooShort).join('、')} 句比合成能力的下限${typeof min === 'number' ? `（${min} 个字）` : ''}短，和相邻的句子也并不成够长的一段，dub 没合成（字数见 dub 的输出里「没合成」一段，或者 dub.json 里${these(tooShort)}的 error）：原样重做没有用，先改台本，让${these(tooShort)}够长`);
  }
  if (tooLongScenes.length > 0) {
    parts.push(`第 ${numbers(tooLongScenes).join('、')} 句（一场戏一个请求）平台说一个请求说不完，原样重做还是装不下（见 dub 的输出里「装不下」一段，或者 dub.json 里${these(tooLongScenes)}的 error）：在那一场中间加一个章节标记（# 标题）把它切成两场（${CHAPTER_SPLIT_REMINDER}），或者给 dub 加 --no-scene 一行一个请求（整份都一行一个请求，做好的几场也要重配）`);
  }
  if (rerun) {
    // 字太少的、一场戏装不下的：改好以后不带 --only 再跑（序号可能会变），别的没做成的在这一次里一起重做，不另给 --only
    const others = numbers([...rejected, ...redo]).sort((a, b) => a - b);
    parts.push(`改好以后不带 --only 再跑那条 dub 命令${keep}（序号可能会变；做好的、请求没变的沿用，不重复花钱${others.length > 0 ? `；别的没做成的第 ${others.join('、')} 句也在这一次里一起重做，不用另跑 --only` : ''}）`);
  }
  if (unretrieved.length > 0) parts.push(unretrievedAdvice(unretrieved));
  return parts.join('；');
}

/**
 * 服务那头做完了、结果没取回的几句（error.details.unretrieved，dub 的文件头「没取回」）：dub 重配会再计一次费，不叫人重做；说清再跑 dub 会重配、计费，不想重配照适配器说的手动取回。
 * items 是报告里的这几句（有 number 或 index，有 error）。
 */
function unretrievedAdvice(items) {
  const numbers = items.map((item) => item.number ?? item.index + 1);
  return `第 ${numbers.join('、')} 句服务那头已经做完、计过费，只是结果没取回：再跑整份台本的那条 dub 命令（只重做别的句子的那条不会）会把它重配，再计一次费；不想重配，照适配器说的手动取回（${items.map(retrieveOf).join('；')}），可手动取回的音频现在还不能交给 mix 用`;
}

/**
 * dub 中途停下来了（dub.json 的 stoppedBy）怎么办：mix_incomplete 的提示里，跟在括号里引的 dub 停下时的说明（stoppedBy 的 code、message）后面。
 *   没跑完的（dub_unfinished：进程被杀、命令超时）：再跑同一条 dub 命令（cli/commands/dub.mjs 文件头「沿用」）。
 *   连着被拒停下的（dub_text_rejected：还没有一句成功、服务商已经拒了 3 句，多半是参考或别的输入被拦了）：原样重做还是会被拒。
 *     先换一段参考（--reference-tag）或者改掉交给模型的说明，换了还被拒的才是那几句的字的问题（改字）；再跑停下的那条命令，只换参考或说明。
 *   别的错（401、参数不对……）：原样再跑多半还会这样停，先照停下的原因处理好，再跑停下的那条命令。
 * 都是再跑停下的那条命令，带着 --only 的照样带着：去掉了，那条命令里只想给那几句用的选项（--reference-tag 这类）就用到整份台本上，
 *   做好的句子请求变了，也要重配、再计一次费。mix 也不另给 --only：停下以后没开始的句子不在 dub.json 里，点不全。停下的那条带没带 --only，dub.json 里看不出来，
 *   所以两种都说：做好的沿用不沿用（carriedAdvice）；换了参考、说明的，不带 --only 的那条做好的也要重配（dub_text_rejected 那一支）。
 * 停下以前就没做成、原样再跑还是做不成的句子（文字被拒的、比下限短的、装不下的）也点名，说再跑之前先改（fixFirstAdvice）。
 * 合成以后的几步出错的句子（afterSynthesisFailed）和没取回的句子，再跑会重配、再计一次费，有就写明。report 是这个目录的 dub.json，keep 是几个目录时跟在命令后面的那句。
 */
function stoppedAdvice(stopped, report, keep) {
  const units = Array.isArray(report.units) ? report.units.filter(isPlainObject) : [];
  const unretrieved = units.filter(isUnretrievedUnit);
  const tail = unretrieved.length > 0 ? `；${unretrievedAdvice(unretrieved)}` : '';
  const unfinishedAfterSynthesis = units.filter((unit) => unit.status === 'ok' && unit.afterSynthesisFailed !== undefined).map((unit) => unit.index + 1);
  const rebilled = unfinishedAfterSynthesis.length > 0 ? `；第 ${unfinishedAfterSynthesis.join('、')} 句合成成了、合成以后的几步出错，不算做完，会重配、再计一次费` : '';
  // 再跑停下的那条命令：带着 --only 的照样带着（去掉了，只想给那几句用的选项就用到整份台本上）
  const keepOnly = '带着 --only 的照样带着：去掉了，那条命令里只想给那几句用的 --reference-tag 这类选项就用到整份台本上，做好的句子请求变了，也要重配、再计一次费';
  if (stopped.code === DUB_UNFINISHED) {
    const fixes = fixFirstAdvice(units, new Set());
    const first = fixes.length > 0 ? `${fixes.join('；')}；改好以后` : '';
    return `${first}再跑同一条 dub 命令${keep}（选项照旧，${keepOnly}）；${carriedAdvice(units)}${rebilled}，再 mix${tail}`;
  }
  const said = '（dub 停下时的说明就是括号里这一段：dub 停下时打在标准错误里，dub.json 的 stoppedBy 里也有）';
  if (stopped.code === DUB_TEXT_REJECTED) {
    // 被拒的几句：stoppedBy.details.rejected 的 unit 从 0 起，换成和 --only、文件名一样从 1 起的序号；没有就看报告里文字被拒的几句
    const listed = Array.isArray(stopped.details?.rejected) ? stopped.details.rejected.map((item) => item?.unit).filter(Number.isInteger).map((unit) => unit + 1) : [];
    const rejected = listed.length > 0 ? listed : units.filter(isTextRejectedUnit).map((unit) => unit.index + 1);
    const which = rejected.length > 0 ? `被拒的第 ${rejected.join('、')} 句` : '被拒的那几句';
    const fixes = fixFirstAdvice(units, new Set(rejected));
    // 换了参考、说明，请求就变了（沿用只认同一个请求）：不带 --only 的那条，参考段或开头的提示变了的句子做好的也要重配
    const done = units.filter((unit) => unit.status === 'ok' && unit.afterSynthesisFailed === undefined).map((unit) => unit.index + 1);
    const redone = done.length > 0 ? `，现在做好的第 ${done.join('、')} 句也要再计一次费` : ''; // 这个目录里还没有做好的句子：没有要多付的
    const cost = `换了参考、说明，请求就变了：这条命令要合成的句子都照新的重配、计费，带着 --only 的只是点到的几句；不带 --only 的是整份台本，参考段或开头的提示变了的句子都要重配${redone}（沿用只认同一个请求）`;
    return `原样重做还是会被拒，多半是参考或别的输入被拦了${said}：先换一段参考（给 dub 换一个 --reference-tag，换一个音色基底标签，没给的加上，包的 SKILL.md 按语言列着有哪些），或者改掉、去掉交给模型的说明（--instructions；设定写的说明，换一套 --setup 或者 --no-setup）；换了还被拒的，多半是${which}的字的问题，先改台本里这几句的字${fixes.length > 0 ? `；${fixes.join('；')}` : ''}。处理好以后再跑停下的那条 dub 命令${keep}，只换参考或说明，别的选项照旧（带着 --only 的照样带着，只重配点到的几句）；${cost}${rebilled}，再 mix${tail}`;
  }
  const fixes = fixFirstAdvice(units, new Set());
  return `原样再跑多半还会这样停：先照 dub 停下时的说明处理好停下的原因${said}，401 这类授权的问题要先让使用者处理好；${fixes.length > 0 ? `${fixes.join('；')}；` : ''}都处理好以后再跑停下的那条 dub 命令${keep}（选项照旧，${keepOnly}）；${carriedAdvice(units)}${rebilled}，再 mix${tail}`;
}

/**
 * 再跑停下的那条命令时，做好的句子沿用不沿用（cli/commands/dub.mjs 的文件头「沿用」）：不带 --only 的，做好的（请求没变的）沿用；带着 --only 的，没点到的沿用，点到的一律重配。
 * 停下以前这一次做好的几句（ok，不是沿用来的，合成以后的几步也做完了），停下的那条带着 --only 的话就是点到的：原样再跑会重配、再计一次费，所以点名它们，说从 --only 里去掉再跑
 * （去掉以后它们是没点到的，沿用这一次做好的）。停下的那条带没带 --only，dub.json 里看不出来，两种都说。units 是 dub.json 里的句子。
 */
function carriedAdvice(units) {
  const done = units.filter((unit) => unit.status === 'ok' && unit.carriedOver !== true && unit.afterSynthesisFailed === undefined).map((unit) => unit.index + 1);
  if (done.length === 0) return '做好的沿用，不再花钱';
  const them = done.length === 1 ? '它' : '它们';
  return `不带 --only 的，做好的沿用，不再花钱；带着 --only 的，点到的一律重配：第 ${done.join('、')} 句是停下以前这一次做好的，从 --only 里去掉${them}再跑，${them}就沿用、不再花钱`;
}

/**
 * 停下以前就没做成、原样再跑还是做不成的几句（dub.json 里有的，都是停下的那一次里试过的）：照停下的原因处理好、原样再跑，这几句还会再发、再被拒，
 * mix 还是不出成品，所以停下的提示里也点名，说再跑之前先改台本。分法同 redoAdvice（cli/dub-failures.mjs）：文字被拒的改字（不是一场戏的一句装不下的，改短或者加章节标记切开）；
 * 比下限短的改长；一场戏装不下的切开或者 --no-scene。改长、切开以后序号可能会变：说带着 --only 的照新的序号点。
 * named 是另外已经点名的序号（dub_text_rejected 那一支说的被拒的几句），这里不重复。返回几段话，没有就是空数组。
 */
function fixFirstAdvice(units, named) {
  const numbersOf = (list) => list.map((unit) => unit.index + 1).join('、');
  const these = (list) => (list.length === 1 ? '这一句' : '这几句');
  const rejected = units.filter((unit) => isTextRejectedUnit(unit) && !named.has(unit.index + 1));
  const long = rejected.filter(isTooLong);
  const refused = rejected.filter((unit) => !isTooLong(unit));
  const tooShort = units.filter(isTooShortUnit);
  const tooLongScenes = units.filter(isTooLongScene);
  const parts = [];
  if (refused.length > 0) {
    const codes = [...new Set(refused.map((unit) => unit.error?.code))].join('、');
    parts.push(`第 ${numbersOf(refused)} 句在停下以前就文字被拒了（错误码 ${codes}，原因见 dub.json 里${these(refused)}的 error）：只和${these(refused)}的字有关，原样再发还是会被拒，再跑之前先改台本里${these(refused)}的字`);
  }
  if (long.length > 0) parts.push(`第 ${numbersOf(long)} 句在停下以前平台就说一个请求说不完（dub.json 里${these(long)}的 error）：再跑之前先把${long.length === 1 ? '它' : '它们'}改短，或者在中间另起一行写章节标记 # 标题切成两个请求（${CHAPTER_SPLIT_REMINDER}）`);
  if (tooShort.length > 0) {
    const min = tooShort[0].error?.details?.min;
    parts.push(`第 ${numbersOf(tooShort)} 句比合成能力的下限${typeof min === 'number' ? `（${min} 个字）` : ''}短，和相邻的句子也并不成够长的一段，dub 没合成（字数见 dub.json 里${these(tooShort)}的 error）：原样再跑还是不合成，再跑之前先改台本，让${these(tooShort)}够长`);
  }
  if (tooLongScenes.length > 0) parts.push(`第 ${numbersOf(tooLongScenes)} 句（一场戏一个请求）在停下以前平台就说一个请求说不完（dub.json 里${these(tooLongScenes)}的 error）：原样再跑还是装不下，再跑之前先在那一场中间加一个章节标记（# 标题）把它切成两场（${CHAPTER_SPLIT_REMINDER}），或者给 dub 加 --no-scene（整份都一行一个请求，做好的几场也要重配）`);
  if (long.length + tooShort.length + tooLongScenes.length > 0) parts.push('改长、切开以后序号可能会变：停下的那条带着 --only 的，照新的序号改 --only（同样的选项、同一个 --out，去掉 --only 加 --dry-run 跑一次，规划里看得到新的序号）');
  return parts;
}

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
  const plans = dirs.map((dir) => {
    const report = readReport(dir);
    return { dir, report, plan: planMix(report) };
  });
  for (const { dir, report, plan } of plans) {
    const where = several ? { directory: dir } : {};
    const inDir = several ? `${dir} 里 ` : '';
    if (plan.stopped !== null) {
      // 照停下的原因说怎么办（stoppedAdvice）：没跑完的再跑同一条命令；连着被拒的、别的错停下的，先处理停下的原因，不叫人原样 --only 重做；都是再跑停下的那条命令，带着 --only 的照样带着
      const again = stoppedAdvice(plan.stopped, report, several ? '（输出目录还是它）' : '');
      // 停下以前就没做成的几句（dub.json 里有的；停下以后没开始的不在里面）：有就列在 details.failed，写法同没停下时的
      const failed = report.units.filter((unit) => isPlainObject(unit) && unit.status === 'failed').map((unit) => ({ number: unit.index + 1, status: unit.status, ...(unit.error === undefined ? {} : { error: unit.error }) }));
      throw new VoicePackError('mix_incomplete', `${inDir}dub 中途停下来了（${plan.stopped.code}：${plan.stopped.message}），没做完的句子不出成品；${again}`, { details: { stoppedBy: plan.stopped, ...(failed.length > 0 ? { failed } : {}), ...where } });
    }
    if (!plan.ok) {
      const numbers = plan.incomplete.map((item) => item.number);
      const again = redoAdvice(plan.incomplete, report, several ? '（输出目录还是它）' : '');
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
