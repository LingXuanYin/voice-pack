// SPDX-License-Identifier: Apache-2.0
//
// make-pack 命令：作者交来一批切好的录音（每段一个音频文件加它说的话），做成一个音色包的角色部分（或完整包）：筛片段、转写没有文本的、打标签、
// 挑出参考集和留出录音、试合成、量还原度、提示还缺什么素材；也能给已有的包发新版本。流程在 lib/make-pack.mjs（输入、选项、报告、错误的正本在它的文件头），
// 这个命令只管读文件、组装运行环境、把包和报告写出来。
//
//   node cli.mjs make-pack [<素材目录|素材.json>] [--recording <文件|目录>] [--audition <文件|目录>] [--no-separate] --output <新目录> --name <名字> [--base-version <x.y.z>]
//                          [--short-name <英文短名>] [--language <标签>] [--text-language <zh|en>] [--guidance <文件.md>] [--direction <文件.json>] [--design-source <文件.json>] [--lexicon <文件.pls>] [--sample-lines <文件.json>]
//                          [--previous <上一版的包目录> [--version <x.y.z> | --bump patch|minor|major] [--changelog <说明>] [--drop <段名,段名>]] [--default-segment <段名>]
//                          [--source-pack <来源包的目录或分享文件>]
//                          [--protocol <协议核心目录>] [--base <基础部分目录>]
//                          [--adapter <名字|模块文件>]... [--adapter-option <键=值>]... [--environment <名字>]
//                          [--dry-run] [--no-evaluate] [--no-loudness] [--no-limiter] [--no-holdout] [--seed <整数>] [--max-error-rate <数>] [--concurrency <1-8>] [--save-evaluation <新目录>] [--share-file <分享文件>] [--json]
//
// 素材（片段列表）：
//   目录：里面的每个音频文件是一段。同名的 <名字>.json 记这一段的 { id?, text?, labels?, source?, externalUrl? }（字段的意思见 lib/make-pack.mjs 文件头「输入」）；
//     没有 .json 但有同名的 <名字>.txt，里面的文字就是这段的逐字文本。两样都没有就是「没有文本」（环境有转写就转写，没有这一段用不上）。
//     段名：.json 里写了 id 就用它，没写就用文件名（小写字母、数字、连字符、下划线；别的字符换成连字符，换不出合格的名字就让库按次序起 seg-001……）。按文件名排序。
//   素材.json：{ "segments": [ { "id"?, "audio": "audio/a.wav", "text"?, "labels"?, "source"?, "externalUrl"? } ] }（也可以直接是这个数组）；audio 是路径，相对这个 JSON 所在的目录。
//     前面几步（分离、切段、转写）留下的说明可以写在 { "notes": [ { "code", "message", "details"? } ] } 里，原样进报告。
//   发新版本时可以不给素材（只改指引、只换参考也行）。
//   长录音和设计试听（--recording、--audition）：不用先自己切。命令把每段录音（分离）、切成 5–20 秒的段、转写，交给 makePack；切段的规矩在 lib/long-recording.mjs 的文件头。
//     --recording <文件|目录>  一个音频文件，或一个目录（里面每个音频文件是一段长录音，按文件名排）。环境有 audio-source-separation 就先分离出人声（--no-separate 不分离：输入已经是干净的人声）；
//                              环境有 voice-activity-detection 就用它给的说话区间切，没有按能量切。段名是「录音名-三位序号」（talk.wav → talk-001……），名字转成同一个前缀的第二个起加 -2、-3。
//     --audition <文件|目录>   设计、默认音色、融合出来的试听（锁定的那一段）：同样切开、转写，一部分当参考、一部分当留出录音（makePack 照规则挑），不分离（合成出来的本来就是干净的人声）。
//                              设计来源用 --design-source 写进清单；没给就在报告的说明里提醒（design_source_missing）。
//     可以和素材目录、素材.json 一起给，段合在一起（段名不能重复，重复了在花钱之前报）。转写由 makePack 做（只转写没有文本的段，费用在做包的规划里）；切段这一步不转写。
//     分离和 VAD 是花钱、耗时的调用，每段录音各一次，不重试：调之前在标准错误里说明（--json 时不说），--dry-run 不调，按能量切，只报段数。
//     命令自己在报告的 notes 里加的说明（[{ code, message, details }]，没有要说的数就是空对象；切段留下的说明见 lib/long-recording.mjs 的文件头，调响度留下的见 lib/make-pack-loudness.mjs 的文件头）：
//       dry_run_energy_cut      --dry-run 没调分离和 VAD，段数是按能量切的结果，真做时有 VAD 就用它。details: {}
//       design_source_missing   给了 --audition 却没给 --design-source，包里没有设计来源。details: {}
//
// 选项：
//   --output <新目录>   把做出来的包写到这里（角色部分，给了 --base 就是完整包）。目录必须还不存在：不往已有的目录里写，也不覆盖上一版。检查在花钱之前做。--dry-run 时不要。
//   --name, --short-name, --base-version
//                       包的显示名、包 ID 里的英文短名、做包用的基础部分版本。发新版本时 --name 可以不给（沿用上一版的）。--base-version 省略时取正在运行的这份基础部分
//                       自己的版本（它的 manifest.json）；开发树里没有封印过，就要明说。
//   --language          给所有片段的默认语言标签（片段自己的 labels 盖过它）。不给就由转写或文字本身认；认不出的用不上（language_unknown）：转写不报语言时，拉丁字母的文字认不出，
//                       所以没给 --language 又有要转写的片段，花钱之前在标准错误里提醒一行（接进来的适配器给了费用说明时就在费用说明里；--dry-run 的规划里也有；--json 时不说），不挡运行。
//   --text-language     包里 SKILL.md 骨架（各节的标题和说明）用的语言：zh（默认）或 en。给英文作者做英文包就给 en；别的值是用法错误（退出 2），在做任何事之前。
//                       只管骨架：「## 配音指引」这一行所有语言都一样，--name、--guidance、--direction 里写的字原样放进包，不翻译（规则的正本是 protocol/FORMAT.md「骨架的语言」）。
//                       发新版本时用这一次给的，不看上一版是什么语言；不给就是中文。
//   --guidance          配音指引的正文（Markdown 文件），放进 SKILL.md 的最后一节。--direction：{ description?, tags?, scenes? }，tags 只能从设计词表选。
//                       --design-source：{ description?, model?, modelVersion?, date? }，设计出来的声音、默认音色、融合出来的声音做包时写。--lexicon：读音词表（PLS），放进包里的 lexicon.pls。
//                       --sample-lines：示例台词，一份 JSON 数组，每项一句台词（最多 50 条，每条 1–500 个字符，不能只有空白；可以带舞台提示，例如（耳语）），原样写进清单；发新版本不给就沿用上一版的，给空数组就去掉。
//   --recording, --audition, --no-separate
//                       长录音、设计试听、不分离，见上面「素材」。--no-separate 只有给了 --recording 才有意义。
//   --previous          发新版本：上一版的包目录。包 ID 不变，版本号往上加（--version 明说，要比上一版大；或 --bump，默认 minor），上一版的参考和留出录音保持原来的角色，
//                       新补的素材接在后面。--changelog 不给就按变化生成一份。--drop 去掉上一版里不要的段（逗号隔开，可以多次给）。
//                       上一版有外部资源时要取回来核对，环境得有 fetch。验证记录不带过来：这一版重新量，没量出来就没有（lib/pack-version.mjs 文件头）。
//   --default-segment   明说默认参考段：新包和发新版本都能给（不带 --previous 也行）。段名要是这次素材里的一段（或上一版的参考）；规则和理由在 lib/pack-material.mjs 的文件头。
//   --no-holdout        不留出录音（makePack 的 holdoutRatio 为 0）：能用的段都进参考集（超过参考上限的照常裁掉），报告不给 no_holdout、holdouts_few，规划里没有试合成。只管这次新挑的：发新版本时上一版已有的留出录音照旧带过来（要去掉用 --drop）。设计出来的声音、库里借来的声音做包时加它（写法见 references/make-pack.md）。
//   --source-pack       做「你自己的」一个新包时给：它是照着哪个包做的（目录，或分享文件）。给了就在花钱之前查重（lib/duplicate-check.mjs，规则、阈值、依据都在它的文件头）：
//                       新包的文字（描述、配音指引、示例台词、设计来源）和录音（--recording、--audition、素材里的每一段）和来源包比，重合太多就报 duplicate_detected 停下（没花过钱），
//                       说明是哪一项、量了多少、阈值是多少。只有用得上才给：来源包只在这一步读，不验签、不联网，也不往新包、标准输出、报告里写它的任何标识（路径、包 ID、名字）；
//                       新包有自己的包 ID，清单的 madeWith 只记做包用的基础部分的版本，没有来源包的记录。--dry-run 也查（查重不花钱）。
//                       怎么做一个干净的新包：先用 clean-room 命令准备输入，交给不认识来源包的会话去写文字，再回来用这个选项查（流程见 protocol/new-pack/README.md）。
//                       录音要整段解进内存再取指纹（WAV 以外的格式要 ffmpeg）：很长的长录音（二十分钟以上）会占几百兆。
//   --protocol, --base  协议核心的目录、基础部分的目录。省略时协议核心用这份基础部分自己的 protocol/，角色部分只做角色部分；给了 --base 就做成完整包（基础部分放进 voice-pack/）。
//                       协议核心要是封印过的（有 manifest.json）：开发树里没有，用官方发布的基础部分里的 protocol/，或者先用 seal 命令。
//   --adapter, --adapter-option, 官方适配器声明的简写和参数
//                       同 dub、fidelity：模型从适配器接进来（统一的入口和合并规则只在 cli/adapters.mjs 写，适配器的约定见 adapters/README.md）。
//                       环境没有 automatic-speech-recognition 或 speaker-verification 时，转写、说话人相似度量不了，要用的话再接一个有它的适配器。
//                       适配器给了费用说明（billing）时，每次花钱的几步开始之前，在标准错误里说明各项能力最多调几次（--json 时不说）。转写、打标签、试合成暂时出错会自己再试
//                       （每段最多问 3 次，规则只在 lib/call-attempts.mjs 写一份），多出来的上限各另起一行写明：这一次最多再加几次，实际调用不超过各项合起来的数（盲听出错不重试，不在里面）。
//   --environment       验证记录里「在哪个环境测的」。不给：用了适配器就是适配器的名字（几个用 + 连起来，名字的取法见 cli/adapters.mjs 的 environmentName），没用适配器不记名字（unspecified）。
//   --dry-run           只做不花钱的几步（认格式、查重、音质检查），说明各项能力最多调几次，不做包，不调任何所需能力，不写文件。
//   --no-evaluate       不试合成、不量还原度。
//   --no-loudness       不统一响度。默认把写进包里的参考和留出录音统一到 REFERENCE_LOUDNESS_LUFS、采样峰值不超过 PEAK_CEILING_DBFS（tools/loudness-normalize.mjs 里的两个常量；规则在 tools/loudness-normalize.mjs，
//                       怎么用在 lib/make-pack-loudness.mjs 的文件头）：音质检查和能量照原始音频量，调的只是放进包里的那份字节，存成 16 位 WAV。
//                       加增益会让峰值超过上限的段（峰值比响度高 19 dB 以上的录音），默认用限幅器压住过高的峰再加（最多压 LIMITER_MAX_DB，参数和依据在 tools/loudness-normalize.mjs 文件头「限幅器」），
//                       压到最多还是到不了目标的，只加到能加的，报告里写明差多少、压了多少；上一版带来的段、外部资源、解不了的不动。关掉以后音频原样放进包里（不转码）。
//   --no-limiter        只关限幅器，响度照样统一：回到只加增益、加到峰值顶到上限为止，峰值太高的段到不了目标（报告里写明）。给了 --no-loudness 就没有意义（整个调响度都没做）。
//   --seed, --max-error-rate, --concurrency
//                       盲听先后的随机数种子；收音校验的阈值（默认见 lib/fidelity.mjs）；调能力的并发数，默认 2。
//   --save-evaluation <新目录>
//                       把还原度的评测集（真录音、合成出来的录音、评测集 JSON）和还原度报告写到这里（目录里有什么、评测集 JSON 的写法：cli/evaluation-set.mjs 的文件头）。盲听或说话人相似度有「没听成」时，补做就用它，不用重新合成：
//                         node cli.mjs fidelity <目录>/evaluation.json --redo <目录>/fidelity-report.json [<同样的适配器参数>]
//                       要调几次，做包的报告里已经写明（planRedo 算的）；适配器给了费用说明时，fidelity 开始之前还会在标准错误里再说一遍。补做的结果不改包里的验证记录：验证记录是做包那一刻量出来的，要更新就发新版本。
//   --share-file <分享文件>
//                       包做好、写到 --output 以后，再打一份分享文件（.voicepack.zip）到这里，里面带预览卡片（index.html）。文件必须还不存在，检查在花钱之前做；--dry-run 时不要。
//                       卡片上「在 X 里打开」的产品名和两个入口（打开、做一个你自己的）取自接进来的适配器给的 previewCard（形状和合并见 adapters/README.md 和 cli/adapters.mjs），
//                       不用自己给；没有适配器给，卡片上就没有产品名和入口（想自己给，用核心层的 pack 命令的 --product-name、--open-link、--make-link）。
//                       和 app 导出一样，这一步不验签、不做互相校验：只是把刚做好的包打成分享文件；要在分发之前核对，用 check 命令查这个分享文件。
//                       适配器给的链接不是 http、https 的地址时，包已经写到 --output 了，分享文件没有打出来（card_link_invalid）：别的都不用重做，修好链接用核心层的 pack 重打。
//   --json              标准输出是一份 JSON：{ packId?, version?, output?, evaluation?, shareFile?, recordings?, duplicateCheck?, report }（dry-run 是 { plan, recordings?, duplicateCheck?, report }）。
//                       shareFile 是 { file, bytes, sha256, card }（card 是预览卡片上的 { productName, open, make }，适配器没给就是 null），给了 --share-file 才有。
//                       duplicateCheck 是查重通过时的报告（lib/duplicate-check.mjs 文件头「返回和错误」），给了 --source-pack 才有。
//                       recordings 是每段长录音或试听的切段报告（lib/long-recording.mjs 的 report，加 kind、idPrefix），给了 --recording 或 --audition 才有。
//
// 输出：给人看的报告（素材去向、转写、打标签、试合成、还原度、验证记录、还缺什么素材、每一段的标签和来源）。还原度照 lib/fidelity.mjs 文件头「怎么读这份报告」显示：
//   量不了的一项报「量不了」并点名缺的能力，没听成的单独报并写明可以补做，都不是错误。
//
// 退出码：0 做完（有「量不了」「没听成」、试合成暂时出错或作废的几条，包照样做出来了，报告里写明）；1 出错停下来（错误码在标准错误）；2 用法错误。
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_unreadable   素材读不了：目录或 JSON 不存在、音频或 .json 或 .txt 读不了。details.file
//   make_pack_input_invalid      素材或文件不是约定的形状。details: { field, problem }（库抛的同一个 code，同一种写法）；--recording 或 --audition 的目录里没有音频文件、
//                                一段说话都没有切出来（没有素材可做）也是这个 code，field 是 --recording 或 --audition
//   make_pack_base_version_missing  没给 --base-version，这份基础部分又没有封印，不知道版本。
//   make_pack_previous_unreadable   --previous 的目录读不了或有问题（符号链接、特殊文件、超过上限）。details: { file, problems? }
//   file_exists                  --output、--save-evaluation 或 --share-file 的路径已经存在（在花钱之前就报）。
//   duplicate_detected           查重不通过（给了 --source-pack）：新包里有文字或录音和来源包重合太多。details.findings 是每一处的 { kind, item, measure, value, threshold }，没有来源包的任何标识（lib/duplicate-check.mjs）
//   duplicate_check_source_invalid  --source-pack 读不了（路径不存在、打不开，来自 cli/source-pack.mjs），或者读到了但不是角色部分（lib/duplicate-check.mjs）
//   另外 make_pack_*（正本在 lib/make-pack.mjs 的文件头，各自抛在各步的 lib/make-pack-*.mjs 和 lib/pack-version.mjs 里）、pack_invalid（protocol/lib/pack.mjs），adapter_invalid、adapter_not_found 来自 cli/adapters.mjs（适配器自己抛的错原样往上），file_unreadable 来自各自的模块，fidelity_* 来自 lib/fidelity.mjs，
//   card_link_invalid（--share-file 时适配器给的链接不对）和 file_unwritable 来自 protocol/lib/share.mjs、protocol/cli/disk.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoicePackError, isVoicePackError } from '../../protocol/lib/errors.mjs';
import { partName } from '../../protocol/lib/manifest.mjs';
import { TEXT_LANGUAGES } from '../../protocol/lib/skill-md.mjs';
import { readDirectory, writeDirectory, writeNewFile } from '../../protocol/cli/disk.mjs';
import { sha256Hex } from '../../protocol/lib/hash.mjs';
import { buildShareFile } from '../../protocol/lib/share.mjs';
import { makePack } from '../../lib/make-pack.mjs';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from '../../lib/call-attempts.mjs';
import { prepareLongRecording } from '../../lib/long-recording.mjs';
import { hasCapability } from '../../protocol/lib/env.mjs';
import { seededRandom, UNMEASURABLE_LABEL } from '../../lib/fidelity.mjs';
import { LEXICON_FILE } from '../../lib/pronunciation-lexicon.mjs';
import { checkDuplicates, materialOfInput, materialOfPack } from '../../lib/duplicate-check.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, readText, usageProblem } from '../input.mjs';
import { readAudioFile, isAudioFileName } from '../audio-files.mjs';
import { describeDuplicateCheck, readSourcePack } from '../source-pack.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, environmentName, minCharsOf, previewCardOf, takeAdapterArguments } from '../adapters.mjs';
import { EVALUATION_FILE, FIDELITY_REPORT_FILE, evaluationSetFiles } from '../evaluation-set.mjs';
import { fixed2, renderFidelityReport } from '../fidelity-report.mjs';

export const summary = '做包：读一批切好的录音，打标签、挑参考集和留出录音、试合成、量还原度、提示还缺什么素材；也能给已有的包发新版本';
export const usage = `make-pack [<素材目录|素材.json>] [--recording <文件|目录>] [--audition <文件|目录>] [--no-separate] --output <新目录> --name <名字> [--short-name <英文短名>] [--base-version <x.y.z>]
      [--language <标签>] [--text-language <zh|en>] [--guidance <文件.md>] [--direction <文件.json>] [--design-source <文件.json>] [--lexicon <文件.pls>] [--sample-lines <文件.json>]
      [--previous <包目录> [--version <x.y.z> | --bump patch|minor|major] [--changelog <说明>] [--drop <段名,段名>]] [--default-segment <段名>]
      [--source-pack <来源包的目录或分享文件>] [--protocol <协议核心目录>] [--base <基础部分目录>] [--environment <名字>]
      ${ADAPTER_USAGE}
      [--dry-run] [--no-evaluate] [--no-loudness] [--no-limiter] [--no-holdout] [--seed <整数>] [--max-error-rate <数>] [--concurrency <1-8>] [--save-evaluation <新目录>] [--share-file <分享文件>] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  output: 'string', name: 'string', 'short-name': 'string', 'base-version': 'string', language: 'string', 'text-language': 'string',
  guidance: 'string', direction: 'string', 'design-source': 'string', lexicon: 'string', 'sample-lines': 'string',
  previous: 'string', version: 'string', bump: 'string', changelog: 'string', drop: 'string', 'default-segment': 'string',
  recording: 'string', audition: 'string', 'no-separate': 'boolean', 'source-pack': 'string',
  protocol: 'string', base: 'string', environment: 'string',
  'dry-run': 'boolean', 'no-evaluate': 'boolean', 'no-loudness': 'boolean', 'no-limiter': 'boolean', 'no-holdout': 'boolean', seed: 'number', 'max-error-rate': 'number', concurrency: 'number', 'save-evaluation': 'string', 'share-file': 'string',
};
const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const invalid = (field, problem) => new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${field}）：${problem}`, { details: { field, problem } });
const unreadable = (file, cause) => new VoicePackError('make_pack_input_unreadable', `读不了素材：${file}`, { details: { file }, ...(cause === undefined ? {} : { cause }) });

// ---------------------------------------------------------------- 读素材

function readJson(ctx, file, field) {
  const text = readText(ctx, file);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('make_pack_input_invalid', `${file} 不是合法的 JSON（${cause.message}）`, { details: { field, problem: `不是合法的 JSON：${cause.message}` }, cause });
  }
}

/** 文件名换成合格的段名（小写字母、数字、连字符、下划线，最长 64 个字符）；换不出来给 undefined，让库按次序起名。 */
function slugOf(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) ? slug : undefined;
}

/** 目录：每个音频文件一段；同名的 .json 或 .txt 是它的描述。 */
function readDirectorySegments(ctx, directory) {
  const names = fs.readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 不同系统 readdir 的顺序不一样，按名字排：输入次序是挑素材时最后的决胜
  return names.filter(isAudioFileName).map((name) => {
    const stem = path.basename(name, path.extname(name));
    const audio = readAudioFile(ctx, path.join(directory, name));
    const sidecar = path.join(directory, `${stem}.json`);
    const transcript = path.join(directory, `${stem}.txt`);
    let meta = {};
    if (fs.existsSync(sidecar)) {
      meta = readJson(ctx, sidecar, name);
      if (!isPlainObject(meta)) throw invalid(name, `${sidecar} 必须是一个对象：{ id?, text?, labels?, source?, externalUrl? }`);
    }
    if (meta.text === undefined && fs.existsSync(transcript)) meta = { ...meta, text: readText(ctx, transcript) };
    return { ...(meta.id === undefined ? (slugOf(stem) === undefined ? {} : { id: slugOf(stem) }) : {}), ...meta, audio };
  });
}

/** 素材.json：segments 数组，每项的 audio 是路径（相对这个 JSON 所在的目录）。 */
function readListSegments(ctx, file) {
  const data = readJson(ctx, file, 'segments');
  const list = Array.isArray(data) ? data : data?.segments;
  if (!Array.isArray(list)) throw invalid('segments', `${file} 要是 { "segments": [ … ] } 或者一个数组`);
  const root = path.dirname(file);
  const segments = list.map((raw, index) => {
    const field = `segments[${index}]`;
    if (!isPlainObject(raw)) throw invalid(field, '必须是对象 { id?, audio, text?, labels?, source?, externalUrl? }');
    if (typeof raw.audio !== 'string' || raw.audio === '') throw invalid(`${field}.audio`, '必须是音频文件的路径（相对素材.json 所在的目录）');
    return { ...raw, audio: readAudioFile(ctx, path.resolve(root, raw.audio)) };
  });
  return { segments, notes: Array.isArray(data) ? undefined : data.notes };
}

function loadMaterial(ctx, argument) {
  const resolved = path.resolve(ctx.cwd, argument);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw unreadable(resolved, cause);
  }
  return stat.isDirectory() ? { segments: readDirectorySegments(ctx, resolved) } : readListSegments(ctx, resolved);
}

// ---------------------------------------------------------------- 长录音和设计试听

/** --recording、--audition 的参数：一个音频文件，或者一个目录（里面每个音频文件是一段，按文件名排）。读成字节。 */
function loadRecordings(ctx, argument, kind) {
  const resolved = path.resolve(ctx.cwd, argument);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw unreadable(resolved, cause);
  }
  const files = stat.isDirectory()
    ? fs.readdirSync(resolved).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).filter(isAudioFileName).map((name) => path.join(resolved, name))
    : [resolved];
  if (files.length === 0) throw invalid(`--${kind}`, `${resolved} 里没有音频文件`);
  return files.map((file) => ({ kind, name: path.basename(file), audio: readAudioFile(ctx, file) }));
}

/** 给每段录音起段名的前缀：文件名转成合格的写法，转不出来用 rec（长录音）或 audition（试听）；几段录音转成同一个前缀的，第二个起加 -2、-3。 */
function assignPrefixes(recordings) {
  const used = new Set();
  return recordings.map((recording) => {
    const base = (slugOf(path.basename(recording.name, path.extname(recording.name))) ?? (recording.kind === 'audition' ? 'audition' : 'rec')).slice(0, 50);
    let idPrefix = base;
    for (let n = 2; used.has(idPrefix); n++) idPrefix = `${base}-${n}`;
    used.add(idPrefix);
    return { ...recording, idPrefix };
  });
}

/** 切段之前的说明（只给人看，写到标准错误）：分离和 VAD 是花钱、耗时的调用，每段录音各一次，不重试。没有要调的就是 null。 */
function cutCostNote({ env, recordings, separate }) {
  const lines = [];
  const separating = separate ? recordings.filter((recording) => recording.kind === 'recording').length : 0;
  if (separating > 0 && hasCapability(env, 'audio-source-separation')) lines.push(`  分离：${separating} 次（audio-source-separation，每段长录音一次）`);
  if (hasCapability(env, 'voice-activity-detection')) lines.push(`  切段：${recordings.length} 次（voice-activity-detection，每段录音一次）`);
  return lines.length === 0 ? null : `切段之前要调这几项能力（花钱、耗时，出错不重试）：\n${lines.join('\n')}\n`;
}

/**
 * 每段录音（分离）切成片段。转写不在这里做（makePack 做，一段一次，费用在做包的规划里）。
 * dry-run 不调分离和 VAD：环境里的能力都不给，按能量切，只为报段数。一段录音出错就停（花钱的调用不重试）。
 * @returns {Promise<{ recording: object, segments: object[], notes: object[], report: object }[]>}
 */
async function cutRecordings(env, recordings, { separate, dryRun }) {
  const cutEnv = dryRun ? { ...env, capabilities: {} } : env;
  const cut = [];
  for (const recording of recordings) {
    const prepared = await prepareLongRecording(cutEnv, { audio: recording.audio, name: recording.name }, { transcribe: false, separate: separate && recording.kind === 'recording', idPrefix: recording.idPrefix });
    cut.push({ recording, ...prepared });
  }
  return cut;
}

/** 切段留下的说明，加上命令自己的：几段录音放在一起，说明前面带上录音名；转写不是这里的事，没转写的说明不要。 */
function cutNotes(cut, { dryRun, designSourceGiven }) {
  const several = cut.length > 1;
  const notes = [];
  for (const entry of cut) {
    for (const note of entry.notes) {
      if (note.code === 'transcription_skipped') continue; // 转写是做包那一步做的
      if (dryRun && note.code === 'separation_skipped') continue; // dry-run 没调分离，说「环境没有」不对
      notes.push(several ? { ...note, message: `${entry.recording.name}：${note.message}` } : note);
    }
  }
  if (dryRun && cut.length > 0) notes.push({ code: 'dry_run_energy_cut', message: 'dry-run 没调分离和 VAD，段数是按能量切的结果；真做时环境有 VAD 就用它切，段数可能不同', details: {} });
  if (!designSourceGiven && cut.some((entry) => entry.recording.kind === 'audition')) {
    notes.push({ code: 'design_source_missing', message: '这是设计（默认音色、融合）出来的试听，做包时要写设计来源（--design-source <文件.json>：描述、模型、日期）；这次没给，包里没有设计来源', details: {} });
  }
  return notes;
}

/** 给人看的一行：这段录音怎么切的。 */
function describeCut({ recording, report }) {
  const separation = report.separation.status === 'done' ? `分离做了${report.separation.model === undefined ? '' : `（${report.separation.model}）`}` : '没分离';
  const method = report.cutting.method === 'voice-activity-detection' ? `按 VAD${report.cutting.model === undefined ? '' : `（${report.cutting.model}）`}` : '按能量';
  const dropped = report.cutting.dropped.length > 0 ? `，丢掉 ${report.cutting.dropped.length} 块零头` : '';
  return `${recording.kind === 'audition' ? '设计试听' : '长录音'} ${recording.name}：${report.recording.durationSec} 秒，${separation}，${method}切成 ${report.cutting.segments} 段${dropped}`;
}

/** 读一个目录（上一版、协议核心、基础部分）成文件集。有问题（符号链接、特殊文件、超过上限）就不用。 */
function loadFiles(directory, what) {
  const { files, problems } = readDirectory(directory);
  if (problems.length > 0) {
    throw new VoicePackError('make_pack_previous_unreadable', `${what} ${directory} 里有问题，不能用：${problems[0].message}${problems.length > 1 ? `（共 ${problems.length} 处）` : ''}`, { details: { file: directory, problems } });
  }
  return files;
}

/** 这份基础部分自己的版本：它的 manifest.json（封印过的才有）。 */
function ownBaseVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'manifest.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 分享文件

/**
 * 把做好的包打成分享文件写到 file（已存在就拒绝，file_exists）。预览卡片的产品名和入口用 previewCard（适配器给的，没有就是 undefined：卡片上没有）。
 * 不验签、不做互相校验：和 app 导出一样，只是把刚做好、库自检过的包打成分享文件。
 * @throws {VoicePackError} card_link_invalid（适配器给的链接不是 http、https 的地址）、file_exists、file_unwritable，以及 buildShareFile 的别的错
 */
async function writeShare(file, packFiles, previewCard) {
  const bytes = buildShareFile(packFiles, previewCard === undefined ? {} : { card: previewCard });
  writeNewFile(file, bytes);
  const card = previewCard === undefined ? null : { productName: previewCard.productName ?? null, open: previewCard.links?.open ?? null, make: previewCard.links?.make ?? null };
  return { file, bytes: bytes.length, sha256: await sha256Hex(bytes), card };
}

// ---------------------------------------------------------------- 给人看的报告

const CALL_NOTE = { 'automatic-speech-recognition': '转写', 'audio-text-to-text': '打标签和盲听', 'voice-cloning': '试合成', 'speaker-verification': '说话人相似度' };

/**
 * 没给 --language，又有要转写的片段：转写不报语言时（automatic-speech-recognition 返回里的 language 可以没有），拉丁字母的文字（英文、法文……）认不出是哪种语言，
 * 这些段付完转写费才发现用不上（language_unknown）；中文、日文这类非拉丁字母的文字从文字本身就认得出，不受影响。只是提醒，不挡运行。
 * 规则的正本是 lib/make-pack-tags.mjs 的 languageOf 和 SKILL.md「做音色包」一节的「标签」；没有要提醒的返回 null。
 * 数的是「没有文本、也没有自己的语言标签」的片段，和规划里要转写的段数取小的那个（环境没有转写时，规划里要转写的段数是 0，所以不会提醒）。
 */
function languageNote({ plan, segments, language }) {
  if (language !== undefined) return null;
  const unlabelled = segments.filter((segment) => (segment.text === undefined || segment.text === '') && !segment.labels?.language).length;
  const count = Math.min(plan.calls['automatic-speech-recognition'], unlabelled);
  if (count === 0) return null;
  return `没给 --language，${count} 段要先转写再判断语言：转写不报语言时，拉丁字母的文字（英文、法文……）认不出是哪种语言，付完转写费这些段会全部因为 language_unknown 用不上（中文、日文这类非拉丁字母的文字不受影响）。建议加 --language <标签>，例如 en（SKILL.md「做音色包」一节的「标签」）`;
}

/**
 * 有重试规则的三项能力（转写、打标签、试合成；规则在 lib/call-attempts.mjs，数目在 plan.extraCalls），各自的说法：做的是什么（work）、再来叫什么（again）、
 * 上限怎么说（limit）。打标签那一项的总数是「打标签和盲听」（和各项最多调几次那一行同一个口径），盲听出错不重试，所以不在多出来的次数里，写明。
 */
const RETRY_NOTE = {
  'automatic-speech-recognition': { work: '转写', again: '转写', limit: (extra, total) => `这一次最多再加 ${extra} 次，实际调用不超过 ${total} 次` },
  'audio-text-to-text': { work: '打标签', again: '听', limit: (extra, total) => `这一次最多再加 ${extra} 次（盲听出错不重试），打标签和盲听实际调用不超过 ${total} 次` },
  'voice-cloning': { work: '试合成', again: '合成', each: '每条留出录音', limit: (extra, total) => `这一次最多再加 ${extra} 次，实际调用不超过 ${total} 次` },
};

/**
 * 暂时出错会再来的上限：转写、打标签、试合成各另起一行写明，写进费用说明和规划里。
 * 没有要转写、要打标签、要试合成的，或者环境没有那项能力，那一项就没有这一行。
 */
function retryNotes(plan) {
  const waits = RETRY_DELAYS_MS.map((ms) => `${ms / 1000} 秒`).join('、');
  return Object.entries(RETRY_NOTE).flatMap(([capability, note]) => {
    const extra = plan.extraCalls?.[capability] ?? 0;
    if (extra === 0) return [];
    return [`${note.work}碰到服务暂时出错，${note.each ?? '每段'}最多再${note.again} ${MAX_ATTEMPTS - 1} 次（两次之前各等 ${waits}），${note.limit(extra, plan.calls[capability] + extra)}`];
  });
}

/** 花钱的几步开始之前的说明（只给人看，写到标准错误）。language 是 languageNote 的结果，有就写成最后一行之前的一行。 */
function costNote({ billing, plan, saveEvaluation, language }) {
  const lines = [`${billing}；下面是各项最多调几次（实际可能更少）：`];
  for (const [capability, count] of Object.entries(plan.calls)) {
    lines.push(plan.capabilities[capability] ? `  ${CALL_NOTE[capability]}：${count} 次（${capability}）` : `  ${CALL_NOTE[capability]}：这个环境没有 ${capability}，这一步${capability === 'automatic-speech-recognition' ? '跳过，没有文本的片段用不上' : `报「${UNMEASURABLE_LABEL}」或跳过`}`);
  }
  for (const retry of retryNotes(plan)) lines.push(`  ${retry}`);
  if (language !== null) lines.push(`  语言：${language}`);
  lines.push(`  转写、打标签和试合成以外，碰到服务出错的那一项会记成「没听成」，不自动重试${saveEvaluation ? '' : '；之后想补做，这次要加 --save-evaluation <新目录> 存下评测集'}`);
  return `${lines.join('\n')}\n`;
}

const UNUSED_NOTE = {
  no_text: '没有逐字文本',
  quality_rejected: '音质不合格',
  duplicate_audio: '和别的一段是同一段音频',
  audio_unrecognized: '认不出是什么音频',
  audio_undecodable: '解不开',
  language_unknown: '认不出是哪种语言',
  transcription_failed: '转写暂时出错',
  over_limit: '参考太多，超过了上限',
};
function unusedNote(segment) {
  const tried = segment.reason === 'transcription_failed' && Number.isInteger(segment.details?.attempts) ? `，试了 ${segment.details.attempts} 次` : '';
  const base = `${UNUSED_NOTE[segment.reason] ?? segment.reason}${tried}`;
  const codes = segment.details?.codes?.length > 0 ? `：${segment.details.codes.join('、')}` : '';
  const same = segment.details?.sameAs === undefined ? '' : `：同 ${segment.details.sameAs}`;
  return `${base}（${segment.reason}${codes}${same}）`;
}

/** 试合成的一句被作废的原因，给人看（lib/make-pack-trial.mjs 的 checkSynthesized 给的 codes）。 */
const VOIDED_WHY = {
  synthesized_mostly_silent: '几乎全是静音',
  synthesized_too_long: '合成的时长比同一句的留出录音长得多',
  synthesized_too_short: '合成的时长比同一句的留出录音短得多',
};

/** 试合成的一句没查到的原因，给人看（checkSynthesized 给的 reason）：没查到照旧量，报告写明原因。 */
const UNCHECKED_WHY = {
  runtime_missing: (check) => `环境缺运行时 ${check.runtime}，解不开合成出来的录音`,
  undecodable: () => '合成出来的录音不是能认的音频格式，解不开',
};

/** 作废的一句：为什么（几条原因都写上），量到的静音占比和时长，同一句的留出录音时长（有的话）。 */
function describeVoided(check) {
  const why = check.codes.map((code) => VOIDED_WHY[code]).join('；');
  const silence = check.silenceRatio === null ? '不足一个窗口，量不出静音占比' : `静音占比 ${check.silenceRatio}`;
  const holdout = check.holdoutSec === undefined ? '' : `，同一句的留出录音 ${check.holdoutSec} 秒`;
  return `${why}（${silence}，时长 ${check.durationSec} 秒${holdout}）`;
}

function describeSteps(steps) {
  const lines = [];
  const transcription = steps.transcription;
  if (transcription?.status === 'skipped') lines.push(`转写：没做，环境没有 ${transcription.capability}，${transcription.segments} 段没有文本的片段用不上`);
  else if (transcription?.status === 'done') lines.push(`转写：${transcription.transcribed} 段补上了文本${transcription.retried > 0 ? `（暂时出错，自动多转写了 ${transcription.retried} 次）` : ''}${transcription.failed > 0 ? `；${transcription.failed} 段服务暂时出错，试满 ${MAX_ATTEMPTS} 次也没转成（用不上）` : ''}`);
  const tagging = steps.tagging;
  if (tagging?.status === 'skipped') lines.push(`打标签：没做，环境没有 ${tagging.capability}，${tagging.segments} 段没有情绪、风格标签（语言和能量照常）`);
  else if (tagging?.status === 'done') {
    // voided 是作废的总段数，blocked 是其中被模型的服务商拦下的（lib/make-pack-tags.mjs）：两种原因分开写，被拦下的不说成「读不懂」
    const blocked = tagging.blocked ?? 0;
    const unreadable = tagging.voided - blocked;
    // retried 是为暂时出错多听了几次，notHeard 是试满次数还没成的段（lib/make-pack-tags.mjs）；这几句和转写那一行同样的写法
    lines.push(
      `打标签：${tagging.tagged} 段打上了${tagging.retried > 0 ? `（暂时出错，自动多听了 ${tagging.retried} 次）` : ''}${unreadable > 0 ? `；${unreadable} 段听者的回答读不懂，作废，不打标签` : ''}${blocked > 0 ? `；${blocked} 段被模型的服务商拦下了回答（多半因为台词是现成的文章），作废，不打标签` : ''}`
        + `${tagging.notHeard > 0 ? `；${tagging.notHeard} 段没听成：服务暂时出错，试满 ${MAX_ATTEMPTS} 次也没成，不打标签` : ''}`,
    );
  }
  const loudness = steps.loudness;
  if (loudness?.status === 'skipped') lines.push('调响度：没做（--no-loudness），音频原样放进包里');
  else if (loudness?.status === 'done') {
    const changed = loudness.adjusted + loudness.peakLimited;
    const limiterOn = loudness.limiter !== null && loudness.limiter !== undefined;
    const rest = [
      loudness.limiterUsed > 0 ? `${loudness.limiterUsed} 段用限幅压住了过高的峰` : '',
      loudness.peakLimited > 0 ? (limiterOn ? `${loudness.peakLimited} 段限幅压到 ${loudness.limiter.maxDb} dB 还是没到目标` : `${loudness.peakLimited} 段为了峰值不超过 ${loudness.peakCeilingDbfs} dBFS 没到目标`) : '',
      loudness.unchanged > 0 ? `${loudness.unchanged} 段本来就在目标上` : '',
      loudness.skipped > 0 ? `${loudness.skipped} 段没法调，原样放进包里` : '',
      loudness.carried > 0 ? `上一版的 ${loudness.carried} 段不动` : '',
      limiterOn ? '' : '限幅器关了（--no-limiter）',
    ].filter((text) => text !== '');
    lines.push(`调响度：${changed} 段调到了 ${loudness.targetLufs} LUFS（采样峰值不超过 ${loudness.peakCeilingDbfs} dBFS）${rest.length > 0 ? `；${rest.join('；')}` : ''}`);
  }
  const trial = steps.trial;
  if (trial?.status === 'done') {
    // retried 是为暂时出错多合成了几次，failed 是试满次数还没合成出来的（lib/make-pack-trial.mjs）；这两句和转写那一行同样的写法
    const retried = trial.retried > 0 ? `（暂时出错，自动多合成了 ${trial.retried} 次）` : '';
    const failed = trial.failed.length > 0 ? `；${trial.failed.length} 条服务暂时出错，试满 ${MAX_ATTEMPTS} 次也没合成出来（${trial.failed.map((entry) => entry.id).join('、')}），不进评测` : '';
    // 合成出来的每一句量还原度之前先检查：作废的不进比值，逐条写明哪条、为什么、量到的数；没查到的照旧量，写明原因
    const voided = trial.items.filter((item) => item.check?.status === 'voided');
    const unchecked = trial.items.filter((item) => item.check?.status === 'unchecked');
    const voidedText = voided.length > 0 ? `（其中 ${voided.length} 条作废）` : '';
    // 文字不够合成能力的下限的（status 是 skipped）：没合成，不算试了一遍，逐条写明字数和下限（lib/make-pack-trial.mjs）
    const tooShort = trial.items.filter((item) => item.status === 'skipped');
    const tooShortText = tooShort.length > 0 ? `（另 ${tooShort.length} 条比合成能力的下限短，没有合成）` : '';
    lines.push(`试合成：用 ${trial.items.length - tooShort.length} 条留出录音试了一遍，合成出来 ${trial.synthesized} 条${voidedText}${tooShortText}${retried}${failed}`);
    for (const item of tooShort) lines.push(`  没合成：${item.id}，比合成能力的下限短（${item.chars} 个字，下限 ${item.min} 个字），不进比值，不算费用`);
    for (const item of voided) lines.push(`  作废：${item.id}，${describeVoided(item.check)}，不进比值`);
    const byWhy = new Map();
    for (const item of unchecked) {
      const why = UNCHECKED_WHY[item.check.reason](item.check);
      byWhy.set(why, [...(byWhy.get(why) ?? []), item.id]);
    }
    for (const [why, ids] of byWhy) lines.push(`  没查到：${ids.join('、')}，${why}，照旧量，进比值`);
  }
  else if (trial?.status === 'skipped') {
    const why = { evaluate_false: '这次没让试（--no-evaluate）', no_holdout: '没有留出录音', capability_missing: `缺 ${trial.capability}`, runtime_missing: `缺运行时 ${trial.runtime}` }[trial.reason] ?? trial.reason;
    lines.push(`试合成：没做，${why}`);
  }
  return lines;
}

function renderVerification(report) {
  const lines = [];
  const record = report.verification;
  if (record === null) lines.push('验证记录：没有（两种评测一项都没量出来，没有东西可记）');
  else lines.push(`验证记录：写进了清单：环境 ${record.environment}，模型 ${record.model}，日期 ${record.date}，${record.fidelity.ratio === undefined ? '没有比值（说话人相似度量不了，只有盲听）' : `比值 ${fixed2(record.fidelity.ratio)}`}`);
  if (report.version?.verification.droppedFromPrevious > 0) lines.push(`  上一版的 ${report.version.verification.droppedFromPrevious} 条验证记录没有带过来：它们量的是上一版的参考集和指引`);
  return lines;
}

function renderSegments(report) {
  const shown = report.segments.slice(0, 40);
  const lines = shown.map((segment) => {
    const role = { reference: '参考', holdout: '留出录音', unused: '没用上', dropped: '去掉了', candidate: '候选' }[segment.role] ?? segment.role;
    const tags = segment.tags === undefined ? '' : ` ${Object.entries(segment.tags).map(([key, value]) => `${key}=${value}`).join(' ')}（${Object.entries(segment.tagSources).map(([key, value]) => `${key}:${value}`).join(' ')}）`;
    const why = segment.role === 'unused' ? `：${unusedNote(segment)}` : '';
    return `  ${segment.id}  ${role}${segment.previous === undefined ? '' : '（上一版的）'}${tags}${why}`;
  });
  if (report.segments.length > shown.length) lines.push(`  （还有 ${report.segments.length - shown.length} 段，用 --json 看全部）`);
  return lines;
}

function renderPlan(plan, report, cut, duplicateCheck, language) {
  const lines = [...cut.map(describeCut), `素材：输入 ${plan.segments.input} 段${plan.segments.carried === undefined ? '' : `，上一版带来 ${plan.segments.carried} 段`}，能用 ${plan.segments.usable} 段（${plan.segments.withoutText} 段没有文本）`];
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  const unused = Object.entries(plan.segments.unused).map(([reason, count]) => `${UNUSED_NOTE[reason] ?? reason} ${count} 段`);
  if (unused.length > 0) lines.push(`没用上：${unused.join('；')}`);
  lines.push('各项能力最多调几次：');
  for (const [capability, count] of Object.entries(plan.calls)) lines.push(`  ${CALL_NOTE[capability]}：${plan.capabilities[capability] ? `${count} 次` : `这个环境没有 ${capability}`}`);
  for (const retry of retryNotes(plan)) lines.push(`  ${retry}`);
  lines.push(`留出录音预计 ${plan.holdouts} 条`);
  if (language !== null) lines.push(`注意：${language}`);
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push('', '每一段：', ...renderSegments(report));
  return lines;
}

/** 默认参考段是按哪条规则挑的，写给人看（规则见 lib/pack-material.mjs 的规则 5；报告的 defaultSegment.rule）。 */
const DEFAULT_RULE_NOTE = {
  author: '作者明说的',
  previous: '沿用上一版的',
  typical: '和其余参考平均最像的那一段',
  priority: '按优先级：这个环境没有说话人相似度，或者量不到',
  only: '只有一段候选',
};

/** 默认段的规则写给人看；量相似度出了错、退回按优先级的，连能力和错误的摘要一起写上（报告的 defaultSegment.unmeasured）。 */
function describeDefaultRule(defaultSegment) {
  const why = defaultSegment.unmeasured === undefined ? '' : `；说话人相似度没量成：${defaultSegment.unmeasured.error.message}`;
  return `（${DEFAULT_RULE_NOTE[defaultSegment.rule]}${why}）`;
}

function render(result, { output, evaluation, share, adapterArguments, cut, duplicateCheck }) {
  const { report, pack } = result;
  const lines = [];
  const { manifest } = pack;
  lines.push(`包：${manifest.name}（${pack.id} ${manifest.version}）${output === null ? '' : `，已写到 ${output}`}`);
  if (report.version !== undefined) {
    lines.push(`版本：上一版 ${report.version.previous} → ${report.version.next}（变更说明${report.version.changelogSource === 'author' ? '是作者写的' : '按变化生成'}）：${manifest.changelog}`);
  }
  lines.push(...cut.map(describeCut));
  const { counts } = report;
  lines.push(`素材：输入 ${counts.input} 段${counts.carried === undefined ? '' : `，上一版带来 ${counts.carried} 段，去掉 ${counts.dropped} 段`}；参考 ${counts.references} 段，留出录音 ${counts.holdouts} 条，没用上 ${counts.unused} 段；默认参考段 ${manifest.reference.defaultSegment}${report.defaultSegment === undefined ? '' : describeDefaultRule(report.defaultSegment)}`);
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push(...describeSteps(report.steps));

  const fidelity = report.fidelity;
  lines.push('');
  if (fidelity.status === 'skipped') {
    const why = { no_trial: '试合成没做', no_generated: '一条合成都没出来', generated_voided: '合成出来的录音都作废了（见「试合成」）',no_holdout: '没有留出录音', evaluate_false: '这次没让量（--no-evaluate）' }[fidelity.reason] ?? fidelity.reason;
    lines.push(`还原度：没量（${why}）`);
  } else {
    const redoHint = evaluation === null
      ? '  怎么补做：这次没有存评测集，补做不了；要补做，做包时加 --save-evaluation <新目录>（会重新花钱），之后用 fidelity 命令的 --redo。'
      : `  怎么补做：node cli.mjs fidelity ${path.join(evaluation, EVALUATION_FILE)} --redo ${path.join(evaluation, FIDELITY_REPORT_FILE)}${adapterArguments === '' ? '' : ` ${adapterArguments}`}（先说清要调几次再调；补做不改包里的验证记录，要更新就发新版本）。`;
    lines.push('还原度（说话人相似度跟真人基线比，加盲听；读法见 lib/fidelity.mjs 文件头）', renderFidelityReport(fidelity, { redoHint }).trimEnd());
  }
  lines.push('', ...renderVerification(report));
  if (report.hints.length > 0) lines.push('', '还缺什么素材：', ...report.hints.map((hint) => `  ${hint.message}`));
  lines.push('', '每一段：', ...renderSegments(report));
  if (evaluation !== null) lines.push('', `评测集和还原度报告已写到 ${evaluation}`);
  if (share !== null) lines.push('', ...describeShare(share));
  return `${lines.join('\n')}\n`;
}

/** 分享文件写到哪、预览卡片上有什么：有适配器给的产品名和入口就写出来，没有就说没有、想要怎么办。 */
function describeShare(share) {
  const { card } = share;
  const entries = card === null ? [] : [card.productName === null ? null : `产品 ${card.productName}`, card.open === null ? null : '打开入口', card.make === null ? null : '「做一个你自己的」入口'].filter((part) => part !== null);
  return [
    `分享文件已写到 ${share.file}（${share.bytes} 字节，sha256 ${share.sha256}）`,
    entries.length > 0
      ? `  预览卡片上：${entries.join('，')}（接进来的适配器给的）`
      : '  预览卡片上没有产品名和入口（接进来的适配器没给 previewCard）；要入口，用核心层的 pack 命令，自己给 --product-name、--open-link、--make-link',
    '  这一步没有验签：只是把刚做好的包打成分享文件；分发之前要核对，用 check 命令查这个分享文件',
  ];
}

// ---------------------------------------------------------------- 命令

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  const { options } = parsed;
  const dryRun = options['dry-run'] === true;
  if (parsed.positional.length > 1) return usageProblem(ctx, usage, `只要一个素材目录或素材.json，多给了：${parsed.positional.slice(1).join(' ')}`);
  const hasRecordings = options.recording !== undefined || options.audition !== undefined;
  if (parsed.positional.length === 0 && options.previous === undefined && !hasRecordings) return usageProblem(ctx, usage, '要给素材目录或素材.json，或者 --recording <长录音> / --audition <设计试听>（发新版本只改指引、换参考时可以都不给，但要 --previous）');
  if (options['no-separate'] === true && options.recording === undefined) return usageProblem(ctx, usage, '--no-separate 只有给了 --recording 才有意义（--audition 本来就不分离）');
  if (!dryRun && options.output === undefined) return usageProblem(ctx, usage, '要给 --output <新目录>（做出来的包放这里）；只想看规划用 --dry-run');
  if (options.name === undefined && options.previous === undefined) return usageProblem(ctx, usage, '要给 --name <名字>（发新版本时可以不给）');
  if (options.bump !== undefined && !['patch', 'minor', 'major'].includes(options.bump)) return usageProblem(ctx, usage, `--bump 要给 patch、minor、major 之一，收到 ${options.bump}`);
  if (options.version !== undefined && options.bump !== undefined) return usageProblem(ctx, usage, '--version 和 --bump 只能给一个');
  if (options['text-language'] !== undefined && !TEXT_LANGUAGES.includes(options['text-language'])) {
    return usageProblem(ctx, usage, `--text-language 要给 ${TEXT_LANGUAGES.join('、')} 之一（包里 SKILL.md 骨架用的语言），收到 ${JSON.stringify(options['text-language'])}`);
  }
  for (const flag of ['version', 'bump', 'changelog', 'drop']) {
    if (options[flag] !== undefined && options.previous === undefined) return usageProblem(ctx, usage, `--${flag} 只有发新版本（--previous）时才有意义`);
  }
  if (options.seed !== undefined && !Number.isInteger(options.seed)) return usageProblem(ctx, usage, `--seed 要给一个整数，收到 ${options.seed}`);
  if (options['max-error-rate'] !== undefined && options['max-error-rate'] < 0) return usageProblem(ctx, usage, `--max-error-rate 要给一个不小于 0 的数，收到 ${options['max-error-rate']}`);
  if (dryRun && options['save-evaluation'] !== undefined) return usageProblem(ctx, usage, '--dry-run 不做包也不试合成，没有评测集可存');
  if (dryRun && options['share-file'] !== undefined) return usageProblem(ctx, usage, '--dry-run 不做包，没有分享文件可打');

  // 花钱之前先把能查的都查了：输出目录还没有、素材读得了、上一版和协议核心读得了
  const output = options.output === undefined ? null : path.resolve(ctx.cwd, options.output);
  const evaluationDirectory = options['save-evaluation'] === undefined ? null : path.resolve(ctx.cwd, options['save-evaluation']);
  const shareFile = options['share-file'] === undefined ? null : path.resolve(ctx.cwd, options['share-file']);
  if (output !== null) assertFresh(output);
  if (evaluationDirectory !== null) assertFresh(evaluationDirectory);
  if (shareFile !== null) assertFresh(shareFile);

  const material = parsed.positional.length === 1 ? loadMaterial(ctx, parsed.positional[0]) : { segments: [] };
  const recordings = assignPrefixes([
    ...(options.recording === undefined ? [] : loadRecordings(ctx, options.recording, 'recording')),
    ...(options.audition === undefined ? [] : loadRecordings(ctx, options.audition, 'audition')),
  ]);
  const baseVersion = options['base-version'] ?? ownBaseVersion();
  if (baseVersion === null) {
    throw new VoicePackError('make_pack_base_version_missing', '不知道做包用的基础部分是哪个版本：这份基础部分没有封印过（开发树），请用 --base-version <x.y.z> 明说', { details: { field: 'baseVersion' } });
  }
  const input = {
    baseVersion,
    protocolCore: loadFiles(path.resolve(ctx.cwd, options.protocol ?? path.join(SKILL_ROOT, 'protocol')), partName('protocol')),
    ...(options.base === undefined ? {} : { base: loadFiles(path.resolve(ctx.cwd, options.base), partName('base')) }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options['short-name'] === undefined ? {} : { shortName: options['short-name'] }),
    ...(options.language === undefined ? {} : { labels: { language: options.language } }),
    ...(options.guidance === undefined ? {} : { guidance: readText(ctx, options.guidance) }),
    ...(options.direction === undefined ? {} : { direction: readJson(ctx, options.direction, 'direction') }),
    ...(options['design-source'] === undefined ? {} : { designSource: readJson(ctx, options['design-source'], 'designSource') }),
    ...(options['sample-lines'] === undefined ? {} : { sampleLines: readJson(ctx, options['sample-lines'], 'sampleLines') }),
    ...(options.lexicon === undefined ? {} : { files: new Map([[LEXICON_FILE, readBytes(ctx, options.lexicon)]]) }),
    ...(options.previous === undefined ? {} : { previous: loadFiles(path.resolve(ctx.cwd, options.previous), '上一版') }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.bump === undefined ? {} : { bump: options.bump }),
    ...(options.changelog === undefined ? {} : { changelog: options.changelog }),
    ...(options.drop === undefined ? {} : { drop: options.drop.split(',').map((id) => id.trim()).filter((id) => id !== '') }),
    ...(options['default-segment'] === undefined ? {} : { defaultSegment: options['default-segment'] }),
  };

  // 环境：命令已有的，加适配器的（后给的盖过先给的，和 dub 一样）
  const { env, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  const billing = billingSentence(adapters);
  const environment = options.environment ?? environmentName(adapters);
  const minChars = minCharsOf(adapters); // 合成能力一次至少多少个字（环境声明的）：影响配音和试合成，见 lib/make-pack.mjs 的 minChars

  // 查重（给了 --source-pack）：新包的文字和录音都定下了，花钱的几步还没开始，查出来就不用白花。来源包只在这里读，查完不留它的任何标识
  let duplicateCheck = null;
  if (options['source-pack'] !== undefined) {
    const source = materialOfPack(await readSourcePack(ctx, options['source-pack']));
    const candidate = materialOfInput(
      { ...input, segments: material.segments },
      { recordings: recordings.map((recording) => ({ item: recording.name, audio: recording.audio })) },
    );
    if (!ctx.json && candidate.recordings.length > 0) ctx.stderr('查重：正在比文字和录音（录音要整段解码、取指纹；不是 WAV 的要先用 ffmpeg 解）……\n');
    duplicateCheck = await checkDuplicates(env, { candidate, source });
  }

  // 长录音和试听：切段在转写和做包之前（要调分离或 VAD 的话先说明）。读文件、查输出目录、查上一版这些能查的，前面都已经做完了
  const separate = options['no-separate'] !== true;
  let cut = [];
  if (recordings.length > 0) {
    if (!dryRun && !ctx.json) {
      const note = cutCostNote({ env, recordings, separate });
      if (note !== null) ctx.stderr(note);
    }
    cut = await cutRecordings(env, recordings, { separate, dryRun });
  }
  const notes = [...(material.notes ?? []), ...cutNotes(cut, { dryRun, designSourceGiven: options['design-source'] !== undefined || options.previous !== undefined })];
  const segments = [...material.segments, ...cut.flatMap((entry) => entry.segments)];
  if (cut.length > 0 && segments.length === 0 && options.previous === undefined) {
    throw invalid(options.recording === undefined ? '--audition' : '--recording', `没有切出任何一段，没有素材可做：${notes.map((note) => note.message).join('；')}`);
  }
  const recordingReports = cut.map((entry) => ({ kind: entry.recording.kind, idPrefix: entry.recording.idPrefix, ...entry.report }));

  const result = await makePack(env, { ...input, segments, ...(notes.length === 0 ? {} : { notes }) }, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(options['no-evaluate'] === true ? { evaluate: false } : {}),
    ...(options['no-loudness'] === true ? { loudness: false } : options['no-limiter'] === true ? { loudness: { limiter: false } } : {}),
    ...(options['no-holdout'] === true ? { holdoutRatio: 0 } : {}),
    ...(options.seed === undefined ? {} : { random: seededRandom(options.seed) }),
    ...(options['max-error-rate'] === undefined ? {} : { maxErrorRate: options['max-error-rate'] }),
    ...(options['text-language'] === undefined ? {} : { textLanguage: options['text-language'] }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(environment === null ? {} : { environment }),
    ...(minChars === undefined ? {} : { minChars }),
    onPlan: (plan) => {
      if (ctx.json) return;
      const language = languageNote({ plan, segments, language: options.language });
      if (billing !== null) ctx.stderr(costNote({ billing, plan, saveEvaluation: evaluationDirectory !== null, language }));
      else if (language !== null) ctx.stderr(`注意：${language}\n`);
    },
  });

  if (dryRun) {
    const language = languageNote({ plan: result.plan, segments, language: options.language });
    ctx.stdout(ctx.json ? `${JSON.stringify({ plan: result.plan, ...(cut.length === 0 ? {} : { recordings: recordingReports }), ...(duplicateCheck === null ? {} : { duplicateCheck }), report: result.report }, null, 2)}\n` : `规划：不做包，没调任何所需能力\n${renderPlan(result.plan, result.report, cut, duplicateCheck, language).join('\n')}\n`);
    return 0;
  }

  writeDirectory(output, result.pack.files);
  let evaluation = null;
  if (evaluationDirectory !== null && result.evaluation !== null) {
    writeDirectory(evaluationDirectory, evaluationSetFiles(result));
    evaluation = evaluationDirectory;
  }
  // 分享文件在包写出去以后才打：卡片的链接要是不对（card_link_invalid），包和评测集都已经在了，不用为这个重做、重花钱。
  // 出错先把做包的结果照常写出来，再把错抛出去
  let share = null;
  let shareError = null;
  if (shareFile !== null) {
    try {
      share = await writeShare(shareFile, result.pack.files, previewCardOf(adapters));
    } catch (error) {
      if (!isVoicePackError(error)) throw error;
      shareError = error;
    }
  }
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ packId: result.pack.id, version: result.pack.manifest.version, output, evaluation, ...(share === null ? {} : { shareFile: share }), ...(cut.length === 0 ? {} : { recordings: recordingReports }), ...(duplicateCheck === null ? {} : { duplicateCheck }), report: result.report }, null, 2)}\n`);
  } else {
    ctx.stdout(render(result, { output, evaluation, share, adapterArguments: describeRequests(taken.requests), cut, duplicateCheck }));
    if (evaluationDirectory !== null && evaluation === null) ctx.stderr('注意：没有评测集可存（没有试合成出任何录音），--save-evaluation 的目录没有写。\n');
  }
  if (shareError !== null) {
    if (!ctx.json) ctx.stderr(`包已经写到 ${output}，分享文件没有打出来：\n`);
    throw shareError;
  }
  return 0;
}
