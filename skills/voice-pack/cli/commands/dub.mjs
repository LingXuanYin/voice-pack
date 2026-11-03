// SPDX-License-Identifier: Apache-2.0
//
// dub 命令：用一个音色包给一段台本配音。流程在 lib/dub.mjs（每句挑参考、读音词表、配音指引、增强件、包里的脚本），这个命令只管读包目录和台本、
// 组装运行环境、把每一句的音频写成文件、把报告写出来。
//
//   node cli.mjs dub <包目录> <台本文件|-> --out <目录> [--adapter <名字|模块文件>]... [--adapter-option <键=值>]...
//                    [--language <标签>] [--emotion <标签>] [--style <标签>] [--energy low|medium|high] [--setup <名字>|<包>=<名字>]...
//                    [--instructions <文字>] [--only <序号,序号>] [--max-chars <数>] [--concurrency <1-8>] [--dry-run] [--json]
//
// 包目录：角色部分的根（里面有 manifest.json、SKILL.md、reference/……）。放进环境以后就是 .agents/skills/<包 ID>/，见 install 命令。
// 台本：带台本标记的文本（章节、[pause]、[slow]……，舞台提示（耳语）、*笑*，语法见基础部分 SKILL.md 和 tools/markup.mjs）；
//   文件名以 .json 结尾的是数组，每项 { text, labels?, instructions? }：这一项自己的标签（language、emotion、style、energy）和说明。
//   `-` 是标准输入。
// 选项：
//   --out        输出目录：每一句一个音频文件（<序号>-<参考段>.<扩展名>，序号从 1 起、补零到 3 位），加一份 dub.json（报告，不含音频）。
//                目录可以已经存在（重做时往里补）；同名文件会被盖掉。--dry-run 时不要。
//   --dry-run    只规划，不合成：每一句要说什么、挑哪段参考、为什么、读音词表换了什么、缺什么运行时。不花钱，不写文件。
//   --language --emotion --style --energy
//                调用方给的标签，用在每一句上。「怎么说」的每一项（情绪、风格、能量）怎么和台本里的提示、设定、text-generation 的判断配合，次序和规则只在 lib/reference-pick.mjs 的文件头写。
//   --setup      用音色包里的哪一套设定（清单的 setups，protocol/FORMAT.md 4.4）：设定里固定的标签、语速、说明补在台本没写的那一项上。不给，用带 default 的那一套，没有就不用设定；
//                名字对不上，报 setup_unknown 并列出包里有哪几套（每个包在自己的设定里找）。--dry-run 和 dub.json 都写明用的是哪一套。
//                两种写法：--setup <名字>，每个包都按这个名字找（只给一个，不和下一种混着给）；--setup <包>=<名字>，点某一个包的（包名或包 ID，不分大小写，和 [voice:] 认包的写法一样），
//                可以重复，几个包时每个包点各自的，没点的包用它自己的默认。名字取第一个 = 后面的全部：设定的名字里有 =，就写成 <包>=<名字>。
//   --instructions
//                用这段文字代替包里的配音指引，作为通过 instructions 传给模型的说明（环境有 style-instruction 才传）。
//   --only       只合成这几句（序号从 1 起，和输出里、文件名里的一致）。重做失败的几句用它：已经做好的文件原样留着，dub.json 把上一次的结果合进来。
//   --max-chars  一次合成最多多少个字，超过的按句子切开。不给就不切；接进来的适配器给了 limits.maxChars 就默认取它的（规则见 adapters/README.md）。
//   --concurrency 并发数，默认 2。
//   判情绪的请求   哪些句子要判、判什么，规则只在 lib/reference-pick.mjs 的文件头写。接进来的适配器给了 limits.maxPromptTokens（模型一次能收的输入）就按它分几次发，没给就一次发完（规则和 judge 的形状见 lib/reference-pick.mjs 的文件头，limits 见 adapters/README.md）。
//   --adapter, --adapter-option, 官方适配器声明的简写和参数
//                模型从适配器接进来：官方的给名字，自己的给模块文件，可以给多个，后给的盖过先给的（统一的入口和合并规则只在 cli/adapters.mjs 写）。
//                适配器给了费用说明（billing）时，合成开始之前会在标准错误里说明要生成几次（--json 时不说，免得弄脏机器读的输出）。
//   --pack       几个角色：给好几次，每次一个包目录（代替位置上的包目录，给了它位置上就只放台本）。第一个包是台本开头用的声音；
//                一句用哪个包的声音，看它前面最近的 [voice:名字]（认包名或包 ID，不分大小写）。每句的参考段都从它那个包里挑，短句只在同一个包里并。
//                dub.json 的每个 unit 记着它的包 ID，顶层 packs 列出全部的包（只给一个包时没有 packs，和原来一样）。
//   --json       标准输出是一份 JSON（和 dub.json 一样的内容）。
//   文字输出      不给 --json 时，每一句下面，有停顿或语速要求就写一行括号：前面停顿、后面停顿（毫秒）、语速，和 JSON 里这一句的 pauseBeforeMs、pauseAfterMs、speed 一一对上。
//
// 包里的脚本：登记在 dub 功能名下的，用本机的解释器直接运行（node 一定有，python 等按 PATH 找），不让用户确认，不隔离。
//   环境没有脚本要的运行时：在合成之前就报 runtime_missing（--dry-run 不报，只在输出里说缺什么）。
//
// 退出码：0 全部做完；1 有失败的句子（暂时出错，输出里说了怎么重做）或者出错停下来了（错误码在标准错误）；2 用法错误。
// 出错停下来时，已经做完的音频文件和一份记着是怎么停的 dub.json（stoppedBy）都留着。
//
// 抛出的错误：dub_input_invalid（.json 台本写坏了、形状不对）；adapter_invalid、adapter_not_found（cli/adapters.mjs）、适配器自己抛的错、file_unreadable、symlink_not_allowed 等
//   来自各自的模块，lib/dub.mjs、lib/voice-pack.mjs 的 code 见它们的文件头。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { planDub, dubScript, TEXT_TOO_SHORT } from '../../lib/dub.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, maxCharsOf, maxPauseInTextMsOf, maxPromptTokensOf, minCharsOf, quoteArgument, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';
import { openPackDirectory } from '../pack-directory.mjs';
import { createScriptRuntimes } from '../script-runtimes.mjs';
import { extensionOfMime } from '../audio-files.mjs';

export const summary = '用音色包给台本配音：每句挑参考，读音词表，配音指引，增强件，包里的脚本';
export const usage = `dub <包目录>|--pack <包目录>... <台本文件|-> --out <目录> ${ADAPTER_USAGE} [--language|--emotion|--style|--energy <标签>] [--setup <名字>|<包>=<名字>]... [--instructions <文字>] [--only <序号,序号>] [--max-chars <数>] [--concurrency <1-8>] [--dry-run] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  out: 'string', 'dry-run': 'boolean', only: 'string', 'max-chars': 'number', concurrency: 'number',
  language: 'string', emotion: 'string', style: 'string', energy: 'string', setup: 'strings', instructions: 'string', pack: 'strings',
};
const LABEL_FLAGS = ['language', 'emotion', 'style', 'energy'];

/**
 * --setup 的值（给了几次，就有几个）：不带 = 的是设定的名字，每个包都按这个名字找，只能给一个；带 = 的是 <包>=<名字>，点某一个包的，可以重复。两种不混着给。
 * 返回 { setup }（库的 options.setup：字符串，或者 { 包: 名字 } 的表；没给就没有这个键），写法不对返回 { problem }（用法错误）。
 */
function readSetupFlag(values) {
  if (values === undefined) return {};
  const entries = values.map((value) => {
    const at = value.indexOf('=');
    return at === -1 ? { name: value } : { pack: value.slice(0, at).trim(), name: value.slice(at + 1) };
  });
  const empty = entries.find((entry) => entry.name === '' || entry.pack === '');
  if (empty !== undefined) return { problem: '--setup 要跟设定的名字（--setup <名字>），或者 <包>=<名字>（包和名字都不能是空的）' };
  const bare = entries.filter((entry) => entry.pack === undefined);
  const tabled = entries.filter((entry) => entry.pack !== undefined);
  if (bare.length > 0 && tabled.length > 0) return { problem: '--setup 不带包的名字（每个包都按这个名字找）和 <包>=<名字>（点某一个包的）不要混着给' };
  if (bare.length > 1) return { problem: '--setup 不带包的名字只能给一个；要几个包各点各的，写成 --setup <包>=<名字>，给几次都行' };
  if (bare.length === 1) return { setup: bare[0].name };
  const table = {};
  for (const { pack, name } of tabled) {
    if (Object.hasOwn(table, pack)) return { problem: `--setup 给包 ${pack} 点了两次：每个包只点一个名字` };
    table[pack] = name;
  }
  return { setup: table };
}

/** 读音词表里做不到的一条，写成一句话说明原因（reason 的写法见 lib/pronunciation-lexicon.mjs 的 lexiconRules）。 */
function unappliedReason(item) {
  if (item.reason === 'phoneme') return '读法是音素，要合成的模型自己会读';
  if (item.reason === 'phoneme_format') return item.problem === 'term' ? '拼音只标汉字，这个词里有别的字' : item.problem === 'count' ? '拼音的音节数和汉字数对不上' : '拼音写法不对：每个音节是字母加声调 1 到 5';
  return '按词性挑读法，这里没有语法信息';
}
const REPORT_FILE = 'dub.json';

const pad = (number) => String(number).padStart(3, '0');
const fileNameOf = (unit) => `${pad(unit.number)}-${unit.pick.segmentId}.${extensionOfMime(unit.audio.mimeType)}`;

/** 台本文件：.json 是数组，别的是带标记的文本。 */
function readScript(ctx, argument) {
  const text = readText(ctx, argument);
  if (!argument.toLowerCase().endsWith('.json')) return text;
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('不是数组');
    return value;
  } catch (cause) {
    throw new VoicePackError('dub_input_invalid', `${argument} 不是台本数组（要 [{ "text": "…", "labels": {…}? }, …]）：${cause.message}`, { details: { field: 'script' }, cause });
  }
}

/** --only 2,5 -> [1, 4]（库里的下标从 0 起，命令行上的序号从 1 起）。 */
function parseOnly(text) {
  const numbers = text.split(',').map((part) => part.trim());
  if (numbers.some((part) => !/^[1-9][0-9]*$/.test(part))) return null;
  return [...new Set(numbers.map((part) => Number(part) - 1))];
}

/** 给每一段加上命令行层的序号（从 1 起）和文件名。 */
function decorate(units) {
  for (const unit of units) unit.number = unit.index + 1;
  return units;
}

/** 报告里的一段：去掉音频字节。 */
function reportUnit(unit) {
  const { audio, ...rest } = unit;
  void audio;
  return rest;
}

/** 一串段的序号（命令行上的，从 1 起，和下面的列表、文件名、--only 一样），用顿号连起来。台词的编号（judge 里的，从 0 起）不在这里用，见 lib/reference-pick.mjs 文件头。 */
const numbersOf = (units) => units.map((unit) => unit.number).join('、');

/** judge.tooLong 的一句话：几句单独就超过一次请求的输入上限，不判（落到默认参考）。 */
const tooLongSentence = (tooLong) => `有 ${tooLong.lines.length} 句单独就超过一次请求的输入上限（${tooLong.limit}），不判，也不截`;

/** 一句用的参考段。几个包时前面写着包 ID：一句用哪个包的声音，要看得出来。 */
function pickLabel(unit, many) {
  const { pick } = unit;
  const parts = [...(many ? [unit.pack] : []), pick.segmentId, pick.rule];
  if (pick.matched.length > 0) parts.push(`匹配 ${pick.matched.join('、')}`);
  if (pick.missed.length > 0) parts.push(`没有对得上的 ${pick.missed.join('、')}`);
  return `[${parts.join(' · ')}]`;
}

/** 用了哪一套设定：包里有设定的才说（几个包时每个包一行）。 */
function setupLines(report) {
  const many = report.packs !== undefined;
  return (report.packs ?? [report.pack]).filter((item) => item.setups !== undefined).map((item) => {
    const who = many ? `${item.name}：` : '';
    const available = item.setups.join('、');
    return item.setup === undefined
      ? `设定：${who}这次没用设定（包里有 ${available}，没有默认的；用 --setup <名字> 点名）`
      : `设定：${who}${item.setup.name}（${item.setup.by === 'option' ? '--setup 点的名' : '包里的默认设定'}）；包里有 ${available}`;
  });
}

function render(report, { packArguments, scriptArgument, out, planOnly, redo }) {
  const lines = [];
  const many = report.packs !== undefined;
  lines.push(many
    ? `包：${report.packs.map((item) => `${item.name}（${item.id} ${item.version}）`).join('、')}（开头的声音是 ${report.pack.name}）`
    : `包：${report.pack.name}（${report.pack.id} ${report.pack.version}）`);
  lines.push(...setupLines(report));
  const { lexicon } = report;
  const phonemes = lexicon.phonemes ?? [];
  if (lexicon.applied.length > 0 || lexicon.unapplied.length > 0 || phonemes.length > 0) {
    const applied = lexicon.applied.map((item) => `${item.term} → ${item.say}（${item.count} 处）`).join('；');
    const marked = phonemes.map((item) => `${item.term}（${item.ph}，${item.count} 处）`).join('；');
    const unapplied = lexicon.unapplied.map((item) => `${item.term}（${unappliedReason(item)}）`).join('；');
    lines.push(`读音词表：${applied === '' ? '这份台本里没有用到' : `换了 ${applied}`}${marked === '' ? '' : `；标了音素 ${marked}`}${unapplied === '' ? '' : `；做不到的：${unapplied}`}`);
  }
  if (report.guidance.present) {
    // 说的是指引的演法（或旧式整段）有没有交给模型。每句自己的说明（舞台提示等）也可能随句传了，那是另一回事，不说成指引交了
    const perLine = report.units.some((unit) => unit.instructions.sent);
    const fate = report.guidance.sent
      ? '随每句通过 instructions 传给了模型'
      : `演法没有交给模型（指引里没有演法，或演法是空的）${perLine ? '，只有每句自己的说明（舞台提示等）随句传了' : '，这次没有可传的内容'}`;
    lines.push(report.capabilities['style-instruction']
      ? `配音指引：环境有 style-instruction，${fate}`
      : '配音指引：环境没有 style-instruction，没传 instructions（照指引写的话、选的参考，仍然生效）');
  }
  if (report.capabilities['style-cues']) {
    const cued = report.units.filter((unit) => unit.cues.sent).length;
    lines.push(`舞台提示：环境有 style-cues，${cued > 0 ? `${cued} 段随段传了这一句自己的情绪、风格（cues）` : '这次没有要传的'}；语速、停顿和配音指引不在里面`);
  }
  if (report.enhancers.offered.length > 0) {
    const describe = (list) => list.map((item) => `${item.id}（${item.model} ${item.modelVersion}）`).join('、');
    if (planOnly) lines.push(`增强件：包里有 ${describe(report.enhancers.offered)}；合成时递给环境，环境认识对应的模型才会用上`);
    else if (report.enhancers.used.length > 0) lines.push(`增强件：用上了 ${report.enhancers.used.join('、')}${report.enhancers.notUsed.length > 0 ? `；没用上 ${describe(report.enhancers.notUsed)}` : ''}`);
    else if (report.enhancers.statement === 'enhancers_not_used') lines.push(`增强件：这次没用增强件（环境没有对应的模型），照常生成。包里有 ${describe(report.enhancers.notUsed)}${report.verification.length > 0 ? `；验证记录见 ${REPORT_FILE}` : ''}`);
  }
  if (report.scripts.length > 0) lines.push(`脚本：${report.scripts.map((item) => `${item.pack === undefined ? '' : `${item.pack} `}${item.entry}（${item.runtime}）`).join('、')}`);
  if (report.missingRuntimes.length > 0) lines.push(`缺运行时：${report.missingRuntimes.map((item) => `${item.runtime}（脚本 ${item.pack === undefined ? '' : `${item.pack} `}${item.entry}）`).join('、')}；真合成会在开始前报 runtime_missing`);
  if (!report.capabilities['voice-cloning']) lines.push('缺所需能力：voice-cloning；真合成会在开始前报 capability_missing');
  if (report.judge.status === 'used') lines.push(`情绪判断：情绪、风格或能量没取全的句子，缺的项让 text-generation 判断了${report.judge.model ? `（${report.judge.model}）` : ''}${report.judge.calls > 1 ? `，分 ${report.judge.calls} 次发` : ''}`);
  else if (report.judge.status === 'unavailable') lines.push('情绪判断：台本里有句子的情绪、风格或能量没取全，环境没有 text-generation，缺的项用了默认参考');
  else if (report.judge.status === 'planned') {
    const { calls, tooLong } = report.judge;
    if (calls > 0) lines.push(`情绪判断：正式运行会用 text-generation 判 ${report.judge.lines} 句（情绪、风格或能量没取全的句子）${calls > 1 ? `，分 ${calls} 次发` : ''}（${CUT_SHORT_NOTE}）；试运行不调它（要计费），这几句缺的项现在用默认参考`);
    if (tooLong !== undefined) lines.push(`情绪判断：${tooLongSentence(tooLong)}，用默认参考：${numbersOf(report.units.filter((unit) => unit.pick.judgeFailed === true))}`);
  } else if (report.judge.status === 'unusable') {
    const { tooLong } = report.judge;
    const fell = report.units.filter((unit) => unit.pick.judgeFailed === true);
    // 单独超限的那几句根本没发出去：说「回答不能用」，只因为别的句子也落到了默认参考（回答不能用或被截断）
    const answerFailed = fell.some((unit) => !(tooLong?.lines ?? []).includes(unit.line));
    const causes = [
      ...(answerFailed ? [`text-generation 的回答不能用（${report.judge.error?.message ?? report.judge.reason}）`] : []),
      ...(tooLong === undefined ? [] : [tooLongSentence(tooLong)]),
    ];
    const othersJudged = report.units.some((unit) => unit.pick.rule === 'text-generation'); // 分几次发的，别的几次判成了
    lines.push(`情绪判断：${causes.join('；')}，这几句用了默认参考：${numbersOf(fell)}${othersJudged ? '；别的句子判成了' : ''}`);
  }
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push('', `共 ${report.units.length} 句：`);
  for (const unit of report.units) {
    const where = unit.file !== undefined ? ` → ${path.join(out, unit.file)}` : unit.status === 'failed' ? (unit.error.code === TEXT_TOO_SHORT ? '（没合成：比合成能力的下限短）' : `（失败：${unit.error.code}）`) : unit.status === 'skipped' ? '（这次没做）' : '';
    lines.push(`  ${unit.number}. ${pickLabel(unit, many)}${where}`);
    lines.push(`     ${unit.spoken}`);
    // 停顿和语速：和 --json 里这一句的 pauseBeforeMs、pauseAfterMs、speed 说的是一回事（前面的停顿挂在后一句上，以前文字输出里看不到）
    const timing = [
      ...(unit.pauseBeforeMs > 0 ? [`前面停顿 ${unit.pauseBeforeMs} 毫秒`] : []),
      ...(unit.pauseAfterMs > 0 ? [`后面停顿 ${unit.pauseAfterMs} 毫秒`] : []),
      ...(unit.speed === null ? [] : [`语速 ${unit.speed}`]),
    ];
    if (timing.length > 0) lines.push(`     （${timing.join('，')}）`);
  }
  // 服务暂时出错的，稍后用 --only 重做；比合成能力的下限短的重做没有用（台本要改），单独说
  const failed = report.units.filter((unit) => unit.status === 'failed' && unit.error?.code !== TEXT_TOO_SHORT);
  if (failed.length > 0) {
    // 重做要照着这次的命令行再跑一遍：适配器、标签、说明、切句和并发都要带上（缺了，重做用的就不是同一个环境）
    const packPart = many ? packArguments.map((argument) => `--pack ${argument}`).join(' ') : packArguments[0];
    const again = [`node cli.mjs dub ${packPart} ${scriptArgument} --out ${out}`, ...(redo?.adapters ? [redo.adapters] : []), ...(redo?.rest ?? []), `--only ${failed.map((unit) => unit.number).join(',')}`];
    lines.push('', `失败 ${failed.length} 句（服务暂时出错，稍后重做）：${again.join(' ')}`);
  }
  const tooShort = report.units.filter((unit) => unit.status === 'failed' && unit.error?.code === TEXT_TOO_SHORT);
  if (tooShort.length > 0) {
    const min = tooShort[0].error.details.min;
    lines.push('', `没合成 ${tooShort.length} 句：比合成能力的下限（${min} 个字）短，和相邻的句子也并不成够长的一段：${tooShort.map((unit) => `第 ${unit.number} 句（${unit.error.details.chars} 个字）`).join('、')}。要改台本，让它们够长；重做没有用。`);
  }
  return `${lines.join('\n')}\n`;
}

/** 重做命令里跟在适配器后面的选项：这次命令行上给了的（标签、设定、说明、切句、并发），按它原来的样子写回去；--only、--out、--json、--dry-run 另有位置，不在这里。 */
function redoFlags(options) {
  const parts = [];
  for (const name of ['language', 'emotion', 'style', 'energy', 'instructions']) if (options[name] !== undefined) parts.push(`--${name} ${quoteArgument(String(options[name]))}`);
  for (const value of options.setup ?? []) parts.push(`--setup ${quoteArgument(value)}`); // --setup 可以给几次，次序照命令行上的
  if (options['max-chars'] !== undefined) parts.push(`--max-chars ${options['max-chars']}`);
  if (options.concurrency !== undefined) parts.push(`--concurrency ${options.concurrency}`);
  return parts;
}

/** 判情绪的次数是分批以后的；回答被截断（模型一次回答的长度到了头）时，那一批对半分开再问，所以实际的次数可能比说的多。 */
const CUT_SHORT_NOTE = '回答被截断时会对半分开再问，次数会多';

/** 费用说明（花钱之前写到标准错误）。calls 来自 dubScript 的 onPlan：exact 为真就是正好这么多次；为假（要判情绪，并段要等判的结果）就是最多这么多次。 */
function costNote({ billing, plan, calls }) {
  const times = calls.exact ? `合成 ${calls.count} 次` : `最多合成 ${calls.count} 次`;
  const lines = [`${billing}：`, `  ${times}（voice-cloning）`];
  if (plan.judge.status === 'planned' && plan.judge.calls > 0) {
    const asked = plan.judge.calls === 1 ? `判一次情绪（这一次不算在上面的次数里；${CUT_SHORT_NOTE}）` : `判情绪，分 ${plan.judge.calls} 次发（一次请求装不下，按模型一次能收的输入分批；这几次不算在上面的次数里；${CUT_SHORT_NOTE}）`;
    lines.push(`  台本里有 ${plan.judge.lines} 句的情绪、风格或能量没取全，要判，先让 text-generation ${asked}`);
  }
  if (plan.judge.tooLong !== undefined) lines.push(`  ${tooLongSentence(plan.judge.tooLong)}，用默认参考`);
  return `${lines.join('\n')}\n`;
}

/** 打开每个包目录，并算出它的脚本运行时（和环境的合在一起，环境的盖过脚本的，和原来一样）。返回 { packs, runtimes }，runtimes 按包 ID 取。 */
async function openPacks(ctx, env, packArguments) {
  const packs = [];
  const runtimes = new Map();
  for (const argument of packArguments) {
    const { pack, dir } = await openPackDirectory(ctx, argument, { env });
    const names = pack.scripts('dub').map((entry) => entry.runtime);
    packs.push(pack);
    runtimes.set(pack.manifest.id, { ...createScriptRuntimes({ packDir: dir, names, existing: env.runtimes }), ...env.runtimes });
  }
  return { packs, runtimes };
}

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  const { options } = parsed;
  // 包目录：位置上的一个，或者 --pack 给的几个（给了 --pack，位置上就只剩台本）
  let packArguments;
  let scriptArgument;
  if (options.pack !== undefined) {
    if (parsed.positional.length !== 1) return usageProblem(ctx, usage, '用了 --pack 就不要再把包目录放在位置上：包目录都用 --pack 给（给几个都行），位置上只放台本');
    [scriptArgument] = parsed.positional;
    packArguments = options.pack;
  } else {
    if (parsed.positional.length !== 2) return usageProblem(ctx, usage, '要给包目录和台本（两个位置参数）');
    const [packArgument, script] = parsed.positional;
    packArguments = [packArgument];
    scriptArgument = script;
  }
  const setupFlag = readSetupFlag(options.setup);
  if (setupFlag.problem !== undefined) return usageProblem(ctx, usage, setupFlag.problem);
  const dryRun = options['dry-run'] === true;
  if (!dryRun && options.out === undefined) return usageProblem(ctx, usage, '要给 --out <目录>（音频和 dub.json 放这里）；只想看规划用 --dry-run');
  let only;
  if (options.only !== undefined) {
    only = parseOnly(options.only);
    if (only === null) return usageProblem(ctx, usage, `--only 要的是句子的序号（从 1 起，用逗号隔开，例如 2,5），收到 ${options.only}`);
  }

  // 环境：命令已有的，加适配器的（后给的盖过先给的，命令行上明说的盖过默认的），再加这个包的脚本要的运行时
  const { env: adapted, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  let env = adapted;
  const billing = billingSentence(adapters);
  const { packs, runtimes } = await openPacks(ctx, env, packArguments);
  // 一个包：脚本的运行时直接放进环境（和原来一样）；几个包：每个包的脚本在它自己的目录里运行，由 runtimesOf 按包取（见 lib/dub.mjs 的 envFor）
  if (packs.length === 1) env = { ...env, runtimes: runtimes.get(packs[0].manifest.id) };

  const script = readScript(ctx, scriptArgument);
  const labels = Object.fromEntries(LABEL_FLAGS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  const adapterMaxChars = maxCharsOf(adapters);
  const adapterMaxPromptTokens = maxPromptTokensOf(adapters); // text-generation 一次请求最多收多少输入（环境声明的）：判情绪按它分批发（lib/reference-pick.mjs）
  const adapterMaxPauseInTextMs = maxPauseInTextMsOf(adapters); // 一个请求里写进文字的停顿加起来最多多少毫秒（环境声明的，声明了 pause-in-text 才用）：不给就不限（lib/dub.mjs 第 5c 步）
  const adapterMinChars = minCharsOf(adapters); // 合成能力一次至少多少个字（环境声明的）：短句并段，并不了的记成没做（lib/dub.mjs 第 5b 步）
  const dubOptions = {
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(setupFlag.setup === undefined ? {} : { setup: setupFlag.setup }),
    ...(options.instructions === undefined ? {} : { guidance: options.instructions }),
    ...(only === undefined ? {} : { only }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options['max-chars'] !== undefined ? { maxChars: options['max-chars'] } : adapterMaxChars !== undefined ? { maxChars: adapterMaxChars } : {}),
    ...(adapterMinChars !== undefined ? { minChars: adapterMinChars } : {}),
    ...(adapterMaxPauseInTextMs !== undefined ? { maxPauseInTextMs: adapterMaxPauseInTextMs } : {}),
    ...(adapterMaxPromptTokens !== undefined ? { maxPromptTokens: adapterMaxPromptTokens } : {}),
    ...(packs.length > 1 ? { runtimesOf: (pack) => runtimes.get(pack.manifest.id) } : {}),
  };
  // 重做提示用的：这次命令行上给的适配器、标签、说明、切句、并发（和 --out、--only 之外的选项一样，照着原样写回去）
  const redo = { adapters: describeRequests(taken.requests), rest: redoFlags(options) };
  const render_ = (report, planOnly) => render(report, { packArguments, scriptArgument, out: options.out === undefined ? '' : path.resolve(ctx.cwd, options.out), planOnly, redo });

  if (dryRun) {
    const plan = await planDub(env, packs, script, dubOptions);
    decorate(plan.units);
    ctx.stdout(ctx.json ? `${JSON.stringify(plan, null, 2)}\n` : render_(plan, true));
    return 0;
  }

  const out = path.resolve(ctx.cwd, options.out);
  const reportFile = path.join(out, REPORT_FILE);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // 没有上一次的报告，或者读不了：当作第一次
  }
  const finished = [];
  const writeAudio = (unit) => {
    fs.mkdirSync(out, { recursive: true });
    unit.file = fileNameOf(unit);
    fs.writeFileSync(path.join(out, unit.file), unit.audio.bytes);
  };
  const dubbed = dubScript(env, packs, script, {
    ...dubOptions,
    onPlan: (plan, { calls }) => {
      decorate(plan.units);
      if (billing !== null && !ctx.json) ctx.stderr(costNote({ billing, plan, calls }));
    },
    onUnit: (unit) => {
      unit.number ??= unit.index + 1;
      if (unit.status === 'ok') writeAudio(unit);
      finished.push(unit);
    },
  });
  let result;
  try {
    result = await dubbed;
    decorate(result.units); // 判情绪之后的规划是另一批对象，没交给 onUnit 的（跳过的）段也要有编号
  } catch (error) {
    // 出错停下来：已经做完的文件留着，写一份记着怎么停的报告（让人知道留下来的是什么），再把错误交给 runner 报告。
    // 一句都没做完就出错（缺能力、缺运行时、台本不对……）什么都不写：没有东西要交代。
    if (finished.length > 0) {
      const stoppedBy = { code: error.code ?? 'internal_error', message: String(error.message), details: error.details ?? {} };
      fs.writeFileSync(reportFile, `${JSON.stringify({ ok: false, stoppedBy, units: finished.map(reportUnit) }, null, 2)}\n`);
    }
    throw error;
  }

  // 重做时把上一次做好的合进来：这次没做的句子，如果上一次已经做好了同一句（话、参考段都没变）、文件还在，就沿用
  for (const unit of result.units) {
    if (unit.status !== 'skipped') continue;
    const before = previous?.units?.find((candidate) => candidate.index === unit.index); // 出错停下来的那份报告里只有做完的几句，所以按 index 找，不按位置
    if (before?.status === 'ok' && before.spoken === unit.spoken && before.pack === unit.pack && before.pick?.segmentId === unit.pick.segmentId && typeof before.file === 'string' && fs.existsSync(path.join(out, before.file))) {
      unit.status = 'ok';
      unit.file = before.file;
      unit.carriedOver = true;
    }
  }
  const report = { ...result, units: result.units.map(reportUnit) };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  ctx.stdout(ctx.json ? `${JSON.stringify(report, null, 2)}\n` : render_(report, false));
  return result.ok ? 0 : 1;
}
