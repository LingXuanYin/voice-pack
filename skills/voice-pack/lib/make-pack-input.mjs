// SPDX-License-Identifier: Apache-2.0
//
// 做包的输入（流程层，第一步）：读 makePack 收到的 input 和 options，整理成后面各步用的样子；写错了在花钱之前就报，点名是哪个字段。
// 输入和选项有哪些字段、每个字段什么意思，正本是 lib/make-pack.mjs 的文件头「输入」「options」；这里是它的程序，字段的规则（写法、长度、取值）只在这里写一遍。
//
//   assertInput(input)             input 必须是对象
//   readOptions(options)           检查选项。挑素材的几个选项的规则在 lib/pack-material.mjs（materialOptionProblems），调响度的选项补全成
//                                  { targetLufs, peakCeilingDbfs, limiter }（关掉是 null，规则见 lib/make-pack-loudness.mjs 的文件头），
//                                  textLanguage（SKILL.md 骨架的语言）补全成 'zh' 或 'en'（规则在 protocol/lib/skill-md.mjs 的 resolveTextLanguage，写错报 make_pack_input_invalid）
//   materialOptionsOf(settings)    选项里挑素材的那几个（调用方给了的才写；lib/pack-material.mjs 自己有默认值）
//   readInput(input, previous, { moreSegments?, moreSentences? })   input 的字段和片段列表，整理成 { items, version, direction, cardLine }：
//                                    items      条目：上一版里没被去掉的段（先参考后留出录音）接着新补的
//                                    version    版本相关的字段（version、bump、changelog、drop、defaultSegments），没给的是 undefined（drop、defaultSegments 是空数组）；
//                                               defaultSegments 是作者点名的默认段（input.defaultSegment 写的，一个也整理成数组），按给的次序
//                                    direction  音色描述和标签换成规范写法以后的样子（lib/design-vocab.mjs），没给是 undefined
//                                    cardLine   卡片试听那一句，去掉了两头空白；没给是 undefined
//                                  previous 是 lib/pack-version.mjs 的 readPreviousVersion 读出来的上一版（发新版本时），不是的话是 null。
//                                  moreSegments 为真：还有段没交来（命令行先查输入、再切长录音，lib/make-pack-precheck.mjs 的 precheckInput）：segments 可以是空数组，
//                                  点名的默认段不在这些段里也不报（可能是要切出来的段，makePack 拿到全部的段再查）。
//                                  moreSentences 为真：要切出来的段里有长录音的句子（不标 synthetic、没有 annotatedText，语言是 input.language），和交来的句子一起查（下面「句子」）
//   invalid(field, problem, more?)  造一个 make_pack_input_invalid（more 是 details 里另外的几项，例如 segment）。别的步骤模块报输入的问题也用它，不各造一个
//   readTrim(trim, where, { sentence?, externalUrl? })   一段的起止秒（trim）的写法（规则见下面「条目」的 trim），写错抛 make_pack_input_invalid（field 是 where 或 where.startSec、where.endSec）；
//                                    返回 { trim } 或空对象（没写）。查重（lib/duplicate-check.mjs）也用它认 trim
//   checkSetupOpeningCues(setups, { carried? })   设定合成的开头的提示限长（下面「设定合成的开头的提示」）：setups 是这一版要写进清单的设定（lib/pack-version.mjs 的 effectiveOf：给的，没给就是上一版的），
//                                    carried 为真是沿用上一版的：超了不报错，返回要记的 notes。makePack 和 lib/make-pack-precheck.mjs 的 precheckInput 都在读完输入、定了这一版的设定以后调它
//
// 条目（item）：做包的每一步读、写的是同一组对象，每个步骤模块的文件头写自己读哪些字段、写哪些字段。这里整理出来的字段：
//   index（在输入里的次序，上一版带来的排在前面）、id、audio、text、annotatedText（素材给的提示标注，没给就没有这个字段）、
//   givenLanguage（素材给的语言：段自己的 language，没有就是输入的 language；都没给是 undefined）、
//   givenTag（素材给的音色基底标签，去掉了两头空白；没给是 undefined。作者给的和库里给的不分，都是素材给的）、source、externalUrl、
//   synthetic（布尔值：true 是合成的，克隆出来的，不是这个人录的；没标是 false）；
//   sentence（长录音的句子模式给，素材 .json 也可以写（references/make-pack.md「素材」）：{ bodySec, pauseSec }，做包的句子合段用，见 lib/make-pack-sentences.mjs；没给就没有这个字段）；
//   trim（素材给的起止秒 { startSec?, endSec? }，只用这几秒，做包先切出来，见 lib/make-pack-take-audio.mjs；没给就没有这个字段。写法：至少一个，不小于 0 的数，
//     写了 endSec 的，它比起点（startSec，没写是 0）至少大 TRIM_MIN_SEC（0.1 秒）；句子不收，外部资源（externalUrl）不收：包里只记网址、大小和哈希，切了就对不上网址上的文件）；
//   上一版带过来的段还有 previous（'reference' 或 'holdout'）和 path（在上一版里的路径），annotatedText 是上一版清单里的（没有就没有这个字段），
//   givenLanguage 是上一版清单里这段的 language，givenTag 是上一版参考段的 tag（上一版的留出录音没有标签，是 undefined）；
//   作者这次用 input.retag 改了名的参考，givenTag 是改以后的标签（去掉了两头空白），另有 retagged: true（来源算素材给的，撞名的规矩在 lib/make-pack-tags.mjs）。
//
// 句子（带 sentence 的段）：做包把它们并成段（lib/make-pack-sentences.mjs），并成的段整段算合成的或整段算真录音，整段带着素材给的提示标注或整段没有，
//   所以可能并进同一段的句子，synthetic、annotatedText 要标得一样。哪几句并进同一段，要筛完片段才定；这里按花钱之前就知道的分组查：
//   素材给的语言（givenLanguage 的 languageKey，没给的算一组；并段的分组也是先看它）一样的句子是一组，组里 synthetic 要么都是 true、要么都不是，
//   annotatedText 要么都给、要么都没给。不一样在花钱之前报 make_pack_input_invalid，field 是组里头一句和第一句不一样的那一句的 segments[2].synthetic 或 segments[2].annotatedText。
//   并段还按采样率分开，采样率要解码才知道，这里不看：采样率不同的两句也按一组查。要分开标的，不写 sentence，自己切成段交。
//
// 改名（input.retag，发新版本时）：{ 段名: 新标签 }，改上一版参考的音色基底标签。段名要是上一版的参考、这次没去掉（留出录音没有标签，上一版没有的、--drop 去掉的不行）；
//   标签的规矩同素材给的 tag（去掉两头空白；只有空白或超过 REFERENCE_TAG_MAX 个码点不行）。不对都在花钱之前报 make_pack_input_invalid，field 是 retag，
//   details.segment 是哪一段。没给 previous 就给 retag，同样报（field 是 retag）。被设定引用的标签改了名，设定要一起改：花钱之前的检查认改以后的标签（lib/make-pack-tags.mjs）。
//
// 设定合成的开头的提示（setups[i].labels 的情绪、风格、能量）：配音时它们合成一条方括号的提示，写在每个请求的开头（lib/opening-cue.mjs），所以整条要短。
//   照 lib/opening-cue.mjs 合成的样子数（一下子的声音不算），超过 lib/cue-length.mjs 的 MAX_OPENING_CUE_WORDS 个词（数法也在那里：汉字、假名两个算一个词，拼音文字按空格数，数字、标点不算），
//   --setups（input.setups）给的，花钱之前报 make_pack_input_invalid，field 是 setups[<序号>]，details 另有 words（数出来几个词）、limit（上限）。
//   沿用上一版的（没给 setups，以前做的、别处做的包）超了，不报错，原样写进新版本，返回一条 setup_opening_cue_too_long（details: { setup, words, limit, from: 'previous' }），makePack 记进报告的 notes。
//   情绪、风格不单独设上限。说明（setups[i].instructions）不查长短：它不发给模型，是给写台本的人看的具体说明（lib/dub.mjs 的 setup_instructions），不限长。
//   清单的 schema 不改（protocol/FORMAT.md 4.4）：发布以后再收紧 schema 是不兼容的改动，程序里的上限以后可以调。写法不对（不是字符串、空串……）不在这里报，由清单检查报（试装，manifest_invalid）。
//
// 设定的起伏（setups[i].expressiveness，protocol/FORMAT.md 4.4）：给了就要是 0 到 100 的整数（刻度写在 vocab/capability-signatures.md）。--setups（input.setups）给的不是，花钱之前报
//   make_pack_input_invalid，field 是 setups[<序号>].expressiveness，dryRun 也报。沿用上一版的（没给 setups）不查：上一版的清单已经过了清单检查。清单检查（试装）本来也查它，这里先报，field 点名在输入里的位置。
//
// 抛出的错误：
//   make_pack_input_invalid  输入或选项不合约定。details: { field, problem, segment? }，field 是出问题的字段（segments[2].audio、segments[2].tag、sampleLines[0]、retag、loudness……），problem 说哪里不对；
//                            field 是 retag 时 segment 是改名的那一段的段名。field 是 setups[0] 时另有 words、limit（上面「设定合成的开头的提示」）。
//                            素材还按旧写法给了 labels（段的 labels，或者输入的 labels）：field 是那一处的 labels，说明改写成 language、tag，不悄悄忽略
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { isSemver } from '../protocol/lib/version.mjs';
import { resolveTextLanguage } from '../protocol/lib/skill-md.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { loudnessOptions } from '../tools/loudness-normalize.mjs';
import { materialOptionProblems } from './pack-material.mjs';
import { normalizeDirection } from './design-vocab.mjs';
import { BUMPS, CHANGELOG_MAX } from './pack-version.mjs';
import { isLanguageTag, MAX_LANGUAGE_TAG } from './language-tag.mjs';
import { isBlankText, languageKey } from '../protocol/lib/manifest.mjs';
import { ANNOTATED_TEXT_MAX, REFERENCE_TAG_MAX } from './manifest-limits.mjs';
import { CUE_PATTERN } from '../tools/markup.mjs';
import { MIN_MAX_CHARS } from './synthesis-limits.mjs';
import { spaceAfterCue } from '../protocol/lib/word-spacing.mjs';
import { cueWords, MAX_OPENING_CUE_WORDS } from './cue-length.mjs';
import { openingCueOf } from './opening-cue.mjs';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 起止秒（trim）至少切多长（秒）：短到起点、终点落在同一个采样上，就切不出东西（文件头「trim」）。 */
const TRIM_MIN_SEC = 0.1;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const invalid = (field, problem, more = {}) => new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${field}）：${problem}`, { details: { field, problem, ...more } });

// ---------------------------------------------------------------- 读输入

/** 旧写法的 labels（每段的，或者输入的）：这一版不收，花钱之前报错，说明怎么改写（不悄悄忽略：素材里写的语言、标签不能没了还当没事）。 */
function rejectLabels(labels, where) {
  if (labels === undefined) return;
  throw invalid(where, '这一版没有 labels 了：语言写成 language（每段自己的，或者输入的 language 给所有段当默认），音色基底标签写成每段的 tag（和清单同名）；情绪、风格、能量不再记，情绪写成台本里的提示');
}

/** 素材给的语言（段自己的 language，或者输入的 language）：不给是 undefined；给了要是语言标签（形如 en、zh-CN），去掉两头空白。 */
function readLanguage(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isLanguageTag(value.trim())) throw invalid(where, `语言标签 ${JSON.stringify(value)} 写法不对：要像 en、zh-CN（最长 ${MAX_LANGUAGE_TAG} 个字符）`);
  return value.trim();
}

/**
 * 一个音色基底标签（素材给的 tag、改名给的新标签）：去掉两头空白，别的不改写、不规范化（撞名加序号在挑完参考集以后，lib/make-pack-tags.mjs）。
 * 只有空白或看不见的字符（判法同清单检查的 text_blank），或者超过 REFERENCE_TAG_MAX 个码点（格式的上限），花钱之前报错。blank 是只有空白时说的话。
 */
function readTagText(value, where, blank, more) {
  if (typeof value !== 'string' || isBlankText(value)) throw invalid(where, blank, more);
  const tag = value.trim();
  if ([...tag].length > REFERENCE_TAG_MAX) throw invalid(where, `最长 ${REFERENCE_TAG_MAX} 个字符（按码点算），收到 ${[...tag].length} 个`, more);
  return tag;
}

/** 素材给的音色基底标签（段的 tag）：不给是 undefined，给了照 readTagText。 */
const readTag = (value, where) => (value === undefined ? undefined : readTagText(value, where, '必须是有字的字符串：这段参考的音色基底标签（例如「平常」「愤怒」「少年」），只用来在几段参考之间切换；不给就由做包给一个'));

/**
 * 改名（input.retag）：{ 段名: 新标签 }，规矩见文件头。kept 是上一版这次没去掉的段（readPreviousVersion 的 segments 去掉 drop 的）。
 * @returns {Map<string, string>} 段名 -> 去掉了两头空白的新标签（没给是空的）
 */
function readRetag(value, { previous, kept }) {
  const retag = new Map();
  if (value === undefined) return retag;
  if (previous === null) throw invalid('retag', '只有发新版本（给了 previous）才能改上一版参考的音色基底标签');
  if (!isPlainObject(value)) throw invalid('retag', '必须是 { 段名: 新标签 } 对象：上一版里要改音色基底标签的参考，一段一项');
  for (const [id, tag] of Object.entries(value)) {
    const before = previous.segments.find((segment) => segment.id === id);
    const why = before === undefined ? '上一版里没有这一段' : before.role !== 'reference' ? '是上一版的留出录音（留出录音没有音色基底标签）' : !kept.some((segment) => segment.id === id) ? '这次去掉了（drop）' : null;
    if (why !== null) throw invalid('retag', `${JSON.stringify(id)} ${why}：只能改上一版参考的标签`, { segment: id });
    retag.set(id, readTagText(tag, 'retag', `${JSON.stringify(id)} 的新标签必须是有字的字符串（例如「平常」「愤怒」「少年」）`, { segment: id }));
  }
  return retag;
}

function readSource(source, where) {
  if (source === undefined) return null;
  if (!isPlainObject(source)) throw invalid(where, '必须是 { recording?, startSec?, endSec? } 对象');
  const out = {};
  if (source.recording !== undefined) {
    if (typeof source.recording !== 'string' || source.recording === '') throw invalid(`${where}.recording`, '必须是非空字符串');
    out.recording = source.recording;
  }
  for (const key of ['startSec', 'endSec']) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key]) || source[key] < 0) throw invalid(`${where}.${key}`, '必须是不小于 0 的数（秒）');
    out[key] = source[key];
  }
  if (out.startSec !== undefined && out.endSec !== undefined && !(out.endSec > out.startSec)) throw invalid(where, `endSec（${out.endSec}）要大于 startSec（${out.startSec}）`);
  return out;
}

/**
 * 起止秒（trim）：只用这段录音的这几秒，做包先切出来（lib/make-pack-take-audio.mjs）。{ startSec?, endSec? }，至少写一个，都是不小于 0 的数（秒），
 * 写了 endSec 的，它比起点（startSec，没写是 0）至少大 TRIM_MIN_SEC。句子（带 sentence 的）不收：句子的秒数照 sentence 算，要切先自己切好。
 * 外部资源（写了 externalUrl 的）不收：包里只记网址、大小和哈希（lib/make-pack-assemble.mjs 的 placeMaterial），切了就对不上网址上的文件。
 * 查重（lib/duplicate-check.mjs）也用它认 trim：写错了的，那边照整段比。
 * @returns {{ trim?: { startSec?: number, endSec?: number } }} 没写是空对象
 */
export function readTrim(trim, where, { sentence, externalUrl } = {}) {
  if (trim === undefined) return {};
  if (!isPlainObject(trim)) throw invalid(where, '必须是 { startSec?, endSec? } 对象：只用这段录音的这几秒（秒，startSec 不写是从头，endSec 不写是到结尾）');
  if (sentence !== undefined) throw invalid(where, '句子（带 sentence 的段）不收 trim：句子的秒数照 sentence 算，要切先自己切好');
  if (externalUrl !== undefined) throw invalid(where, '外部资源（externalUrl）不收 trim：包里只记网址、大小和哈希，切了就对不上网址上的文件；要切就先切好，切好的文件放到网址上，或者不写 externalUrl');
  const out = {};
  for (const key of ['startSec', 'endSec']) {
    if (trim[key] === undefined) continue;
    if (typeof trim[key] !== 'number' || !Number.isFinite(trim[key]) || trim[key] < 0) throw invalid(`${where}.${key}`, '必须是不小于 0 的数（秒）');
    out[key] = trim[key];
  }
  if (out.startSec === undefined && out.endSec === undefined) throw invalid(where, '至少写 startSec、endSec 中的一个（秒）');
  if (out.startSec !== undefined && out.endSec !== undefined && !(out.endSec > out.startSec)) throw invalid(where, `endSec（${out.endSec}）要大于 startSec（${out.startSec}）`);
  if (out.endSec !== undefined && out.endSec - (out.startSec ?? 0) < TRIM_MIN_SEC) throw invalid(where, `至少切 ${TRIM_MIN_SEC} 秒：endSec（${out.endSec}）离起点（${out.startSec ?? 0}）不到 ${TRIM_MIN_SEC} 秒`);
  return { trim: out };
}

/** 句子模式的句子（lib/long-recording.mjs 的 sentences: true 给的）：句子的秒数（含留边），和它后面的原停顿（秒；没有就是 null）。 */
function readSentence(sentence, where) {
  if (!isPlainObject(sentence)) throw invalid(where, '必须是 { bodySec, pauseSec } 对象（句子的秒数，和它后面的原停顿）');
  const { bodySec, pauseSec } = sentence;
  if (typeof bodySec !== 'number' || !Number.isFinite(bodySec) || bodySec < 0) throw invalid(`${where}.bodySec`, '必须是不小于 0 的数（秒）');
  if (pauseSec !== null && (typeof pauseSec !== 'number' || !Number.isFinite(pauseSec) || pauseSec < 0)) throw invalid(`${where}.pauseSec`, '必须是不小于 0 的数（秒），或者 null（后面没有原停顿）');
  return { bodySec, pauseSec };
}

/**
 * 示例台词（input.sampleLines）：字符串数组，每条是一句台词。不是数组，或者哪一条不是字符串，花钱之前报（field 是 sampleLines 或 sampleLines[2]）；
 * 设计词表（vocab/design-sample-lines.json）里每一项是 { text, feel, kind } 对象，原样抄进来的，说明里教人取 text。条数、长度、能不能空白，清单检查在花钱之前查。
 */
function readSampleLines(lines) {
  if (!Array.isArray(lines)) throw invalid('sampleLines', '必须是字符串数组：每条是一句示例台词（条数、长度、能不能空白，清单检查在花钱之前就查）');
  lines.forEach((line, index) => {
    if (typeof line === 'string') return;
    const copied = isPlainObject(line) && typeof line.text === 'string';
    const got = line === null ? 'null' : Array.isArray(line) ? '数组' : typeof line === 'object' ? '对象' : JSON.stringify(line);
    throw invalid(`sampleLines[${index}]`, `第 ${index + 1} 条必须是字符串（一句示例台词），收到的是 ${got}${copied ? '：设计词表（vocab/design-sample-lines.json）里每一项是 { text, feel, kind } 对象，示例台词要的是它的 text 那一句' : ''}`);
  });
}

/** 设定的起伏（input.setups 每一项的 expressiveness）：给了就要是 0 到 100 的整数（文件头「设定的起伏」）；这一项不是对象、没写这个键的不管（别的由清单检查报）。 */
function readSetupExpressiveness(setups) {
  setups.forEach((setup, index) => {
    if (!isPlainObject(setup) || setup.expressiveness === undefined) return;
    const { expressiveness } = setup;
    if (Number.isInteger(expressiveness) && expressiveness >= 0 && expressiveness <= 100) return;
    const name = typeof setup.name === 'string' ? JSON.stringify(setup.name) : `第 ${index + 1} 套`;
    throw invalid(`setups[${index}].expressiveness`, `设定 ${name} 的 expressiveness 必须是 0 到 100 的整数（这个声音固定的起伏：越大越多变，越小越平稳；不收小数，也不收 0 到 1 的写法），收到 ${JSON.stringify(expressiveness)}`);
  });
}

/** 片段的 synthetic：不给或 false 是真录音，true 是合成的（克隆出来的），别的值报错。 */
function readSynthetic(synthetic, where) {
  if (synthetic === undefined) return false;
  if (typeof synthetic !== 'boolean') throw invalid(where, '必须是 true 或 false：true 表示这段是合成的（克隆出来的），不是这个人录的');
  return synthetic;
}

/**
 * 去掉方括号提示（tools/markup.mjs 的 CUE_PATTERN），连着的空白并成一个，去掉两头空白：素材只给了提示标注时，逐字文本就是它。
 * 去掉提示的地方留不留空格，见 protocol/lib/word-spacing.mjs 的 spaceAfterCue（规则只在那里；lib/make-pack.mjs 文件头「输入」的 annotatedText 照抄了例子）：「你好 [sigh] 我说过了」是「你好我说过了」，「你好，[sigh] hello」是「你好，hello」，
 * 「Hello there [laughs] 你好」是「Hello there 你好」，「I told you[sigh]already」是「I told you already」，「already[sigh]. Now」是「already. Now」。
 * 有一截只是空白（两个提示隔着空白连写）时先不动它，留给下一处提示一起看。原来的空白紧挨着哪一截、后一截是不是一句的结尾也交给它（edges：作者在引号、括号里面写的空格照留，单引号挨着提示的看另一边）。
 */
function withoutCues(text) {
  const joined = text.split(new RegExp(CUE_PATTERN)).reduce((acc, piece, index, pieces) => {
    const before = acc.trimEnd();
    const after = piece.trimStart();
    if (before === '' || after === '') return acc + piece;
    const edges = { before: before !== acc, after: after !== piece, end: index === pieces.length - 1 };
    return `${before}${spaceAfterCue(before, after, edges.before || edges.after, edges) ? ' ' : ''}${after}`;
  });
  return joined.replace(/\s+/gu, ' ').trim();
}

/**
 * 两句话不算空白，第一处不一样的地方：返回两边从那一处起的一小截（16 个字，没有了是空串）；一样是 null。
 * 比提示标注和逐字文本用：提示前后多一个、少一个空格不算不一样（中文的提示前后常有空格，逐字稿里没有）。
 */
function firstDifference(a, b) {
  const left = [...a];
  const right = [...b];
  const space = (ch) => /\s/u.test(ch);
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < left.length && space(left[i])) i += 1;
    while (j < right.length && space(right[j])) j += 1;
    if (i >= left.length && j >= right.length) return null;
    if (i >= left.length || j >= right.length || left[i] !== right[j]) return { annotatedText: left.slice(i, i + 16).join(''), text: right.slice(j, j + 16).join('') };
    i += 1;
    j += 1;
  }
}

/** 素材给的提示标注（annotatedText）：不给就是没有；给了要是有看得见的字的字符串，去掉两头空白以后不超过 ANNOTATED_TEXT_MAX 个字符（格式的上限，protocol/FORMAT.md 4.4）。 */
function readAnnotatedText(value, where) {
  if (value === undefined) return {};
  if (typeof value !== 'string' || isBlankText(value)) throw invalid(where, '必须是有字的字符串：这段逐字稿加上方括号提示的整句（提示以外的字和 text 一样）；没有提示标注就不写这个键');
  const text = value.trim();
  if ([...text].length > ANNOTATED_TEXT_MAX) throw invalid(where, `最长 ${ANNOTATED_TEXT_MAX} 个字符`);
  if (withoutCues(text) === '') throw invalid(where, '除了方括号提示没有别的字：提示标注是逐字稿加上提示的整句');
  return { annotatedText: text };
}

/**
 * 一段的逐字文本，和素材给的提示标注对一对（规则见 lib/make-pack.mjs 文件头「输入」的 annotatedText）：给了 text 的，去掉提示以后的字要和它一样（空白不算），
 * 不一样花钱之前报；没给 text（不给、null、空串）的，text 就是提示标注去掉提示的那句，这段不用转写。
 */
function readText(segment, annotated, where) {
  const text = typeof segment.text === 'string' ? segment.text.trim() : '';
  if (annotated.annotatedText === undefined) return text;
  if (text === '') return withoutCues(annotated.annotatedText);
  const differs = firstDifference(withoutCues(annotated.annotatedText), withoutCues(text));
  if (differs !== null) {
    const shown = (part) => (part === '' ? '（到头了）' : `「${part}」`);
    throw invalid(`${where}.annotatedText`, `提示以外的字要和 text 一样（空白不算）：从提示标注的${shown(differs.annotatedText)}、text 的${shown(differs.text)}起不一样`, { differsAt: differs });
  }
  return text;
}

function readSegments(segments, defaultLanguage, { taken = new Set(), offset = 0, allowEmpty = false } = {}) {
  if (!Array.isArray(segments)) throw invalid('segments', '必须是数组：每一项是一段切好的录音');
  if (segments.length === 0 && !allowEmpty) throw invalid('segments', '至少要有一段');
  const seen = new Set(taken);
  return segments.map((segment, index) => {
    const where = `segments[${index}]`;
    if (!isPlainObject(segment)) throw invalid(where, '必须是对象 { id?, audio, text?, annotatedText?, language?, tag?, source?, trim? }');
    rejectLabels(segment.labels, `${where}.labels`);
    let id = segment.id;
    if (id === undefined) {
      // 没写名字：按次序起 seg-001、seg-002……，跳过已经有的（上一版的、前面的）
      let n = index + 1;
      while (seen.has(`seg-${String(n).padStart(3, '0')}`)) n += 1;
      id = `seg-${String(n).padStart(3, '0')}`;
    }
    if (typeof id !== 'string' || !SLUG.test(id)) throw invalid(`${where}.id`, `名字 ${JSON.stringify(id)} 不合格：小写字母、数字、连字符、下划线，以字母或数字开头，最长 64 个字符`);
    if (seen.has(id)) throw invalid(`${where}.id`, taken.has(id) ? `名字 ${JSON.stringify(id)} 和上一版里的一段重名了` : `名字 ${JSON.stringify(id)} 重复了`);
    seen.add(id);
    try {
      assertAudioClip(segment.audio, `${where}.audio`);
    } catch (cause) {
      if (!isVoicePackError(cause, 'audio_clip_invalid')) throw cause;
      throw new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${where}.audio）：${cause.details.problem}`, { details: { field: `${where}.audio`, problem: cause.details.problem }, cause });
    }
    if (segment.text !== undefined && segment.text !== null && typeof segment.text !== 'string') throw invalid(`${where}.text`, '必须是字符串（这段录音里说的原话），或者不给、给 null 表示没有文本');
    if (segment.externalUrl !== undefined && (typeof segment.externalUrl !== 'string' || !/^https:\/\//.test(segment.externalUrl) || segment.externalUrl.length > 2048)) {
      throw invalid(`${where}.externalUrl`, '必须是 https:// 开头、不超过 2048 个字符的网址');
    }
    const annotated = readAnnotatedText(segment.annotatedText, `${where}.annotatedText`);
    return {
      index: offset + index,
      id,
      audio: segment.audio,
      text: readText(segment, annotated, where),
      ...annotated,
      givenLanguage: readLanguage(segment.language, `${where}.language`) ?? defaultLanguage, // 段自己的盖过输入的
      givenTag: readTag(segment.tag, `${where}.tag`),
      source: readSource(segment.source, `${where}.source`),
      externalUrl: segment.externalUrl ?? null,
      synthetic: readSynthetic(segment.synthetic, `${where}.synthetic`),
      ...(segment.sentence === undefined ? {} : { sentence: readSentence(segment.sentence, `${where}.sentence`) }),
      ...readTrim(segment.trim, `${where}.trim`, { sentence: segment.sentence, externalUrl: segment.externalUrl }),
    };
  });
}

/** 句子的一组里两句标得不一样时，各自的说法（文件头「句子」）。 */
const SENTENCE_MARKS = [
  { mark: (item) => item.synthetic === true, field: 'synthetic', yes: '标了 synthetic: true', no: '没标 synthetic', whole: '整段算合成的或整段算真录音' },
  { mark: (item) => item.annotatedText !== undefined, field: 'annotatedText', yes: '给了 annotatedText', no: '没给 annotatedText', whole: '整段带着提示标注或整段没有' },
];

/**
 * 句子按素材给的语言分组，组里 synthetic、annotatedText 要标得一样（规则见文件头「句子」）。fresh 是这次新补的条目，offset 是上一版带来的条目数
 * （条目的 index 减它是在 input.segments 里的序号）。moreSentences 为真：还有长录音要切成句子，它们不标 synthetic、没有 annotatedText，语言是 defaultLanguage。
 */
function assertSentenceGroups(fresh, offset, { moreSentences, defaultLanguage }) {
  const groupOf = (language) => (language ? languageKey(language) : null);
  const heads = new Map(); // 组 -> 组里第一句：{ item, where }（item 是 null：要从长录音切出来的句子）
  if (moreSentences) heads.set(groupOf(defaultLanguage), { item: null, where: null });
  for (const item of fresh) {
    if (item.sentence === undefined) continue;
    const group = groupOf(item.givenLanguage);
    const where = `segments[${item.index - offset}]`;
    const head = heads.get(group);
    if (head === undefined) {
      heads.set(group, { item, where });
      continue;
    }
    for (const { mark, field, yes, no, whole } of SENTENCE_MARKS) {
      const headMarked = head.item !== null && mark(head.item);
      if (mark(item) === headMarked) continue;
      const other = head.item === null ? `要从长录音切出来的句子${no}` : `${head.where} ${headMarked ? yes : no}`;
      throw invalid(`${where}.${field}`, `这一句${mark(item) ? yes : no}，${other}：素材给的语言一样的句子（带 sentence 的段）可能并进同一段，并成的段${whole}。同一组的句子要标得一样；要分开标，就不写 sentence，自己切成段交`);
    }
  }
}

/**
 * 读输入。previous 是 readPreviousVersion 读出来的上一版（发新版本时），不是的话是 null。
 * @returns {{ items: object[], version: object, direction: object | undefined }} items：上一版里没被去掉的段（先参考后留出录音）接着新补的；
 *   version：版本相关的字段（version、bump、changelog、drop、defaultSegments），没给的是 undefined（drop、defaultSegments 是空数组）；
 *   direction：音色描述和标签换成规范写法以后的样子（没给是 undefined）
 */
export function readInput(input, previous, { moreSegments = false, moreSentences = false } = {}) {
  if (!isPlainObject(input)) throw invalid('input', '必须是对象');
  const hasPrevious = previous !== null;
  if (input.name === undefined && hasPrevious) {
    // 发新版本不用再给名字：沿用上一版的
  } else if (typeof input.name !== 'string' || input.name.trim() === '' || [...input.name].length > 100) {
    throw invalid('name', '必须是 1–100 个字符的显示名');
  }
  if (!isSemver(input.baseVersion)) throw invalid('baseVersion', `必须是语义化版本号（例如 1.0.0），收到 ${JSON.stringify(input.baseVersion)}`);
  if (!(input.protocolCore instanceof Map)) throw invalid('protocolCore', '必须是协议核心的文件集 Map<路径, Uint8Array>');
  if (input.base !== undefined && !(input.base instanceof Map)) throw invalid('base', '必须是基础部分的文件集 Map<路径, Uint8Array>，或者不给');
  for (const key of ['features', 'requires', 'designSource']) if (input[key] !== undefined && !isPlainObject(input[key])) throw invalid(key, '必须是对象');
  let direction;
  if (input.direction !== undefined) {
    // 音色标签只能从设计词表里取：写法换成规范的，不在词表里的、不认识的字段在花钱之前就报
    const normalized = normalizeDirection(input.direction);
    if (normalized.problems.length > 0) {
      const [first] = normalized.problems;
      throw invalid(first.field === '' ? 'direction' : `direction.${first.field}`, `${first.message}${normalized.problems.length > 1 ? `（共 ${normalized.problems.length} 处：${normalized.problems.map((problem) => problem.field).join('、')}）` : ''}`);
    }
    direction = normalized.direction;
  }
  for (const key of ['scripts', 'enhancers']) if (input[key] !== undefined && !Array.isArray(input[key])) throw invalid(key, '必须是数组');
  if (input.setups !== undefined && !Array.isArray(input.setups)) throw invalid('setups', '必须是数组：每项是一套设定 { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }（写法、重名、default 的检查，清单检查在花钱之前就查；referenceTag 对不对得上，lib/make-pack-tags.mjs 在花钱之前查）');
  if (input.setups !== undefined) readSetupExpressiveness(input.setups);
  if (input.sampleLines !== undefined) readSampleLines(input.sampleLines);
  if (input.cardLine !== undefined && typeof input.cardLine !== 'string') throw invalid('cardLine', '必须是字符串：卡片试听那一句台词（长度、能不能空白，清单检查在花钱之前就查；配不配得成一个请求，lib/make-pack-card-line.mjs 在花钱之前查）');
  if (input.guidance !== undefined && typeof input.guidance !== 'string') throw invalid('guidance', '必须是字符串（配音指引的 Markdown 正文）');
  if (input.files !== undefined && !(input.files instanceof Map)) throw invalid('files', '必须是 Map<路径, Uint8Array>');

  // 版本相关的字段
  if (input.bump !== undefined && !hasPrevious) throw invalid('bump', '只有发新版本（给了 previous）才用 bump：第一个版本用 version 明说，或者不给（1.0.0）');
  if (input.bump !== undefined && !BUMPS.includes(input.bump)) throw invalid('bump', `必须是 ${BUMPS.join('、')} 之一，收到 ${JSON.stringify(input.bump)}`);
  if (input.version !== undefined && !isSemver(input.version)) throw invalid('version', `必须是语义化版本号（例如 1.2.0），收到 ${JSON.stringify(input.version)}`);
  let changelog;
  if (input.changelog !== undefined) {
    if (typeof input.changelog !== 'string' || input.changelog.trim() === '' || [...input.changelog.trim()].length > CHANGELOG_MAX) throw invalid('changelog', `必须是 1–${CHANGELOG_MAX} 个字符的变更说明`);
    changelog = input.changelog.trim();
  }
  const previousIds = new Set(hasPrevious ? previous.segments.map((segment) => segment.id) : []);
  let drop = [];
  if (input.drop !== undefined) {
    if (!hasPrevious) throw invalid('drop', '只有发新版本（给了 previous）才能去掉上一版里的段');
    if (!Array.isArray(input.drop) || input.drop.some((id) => typeof id !== 'string')) throw invalid('drop', '必须是名字的数组：上一版里要去掉的参考或留出录音');
    const unknown = input.drop.filter((id) => !previousIds.has(id));
    if (unknown.length > 0) throw invalid('drop', `上一版里没有这几段：${unknown.join('、')}`);
    drop = [...new Set(input.drop)];
  }
  // 点名的默认段：一段的名字，或者几种语言各一段的名字的数组（一种语言最多一段，语言的检查在 lib/make-pack-pick.mjs 的 assertDefaultsUsable 和 pickMaterial）
  const defaultSegments = input.defaultSegment === undefined ? [] : [input.defaultSegment].flat();
  if (input.defaultSegment !== undefined && (defaultSegments.length === 0 || defaultSegments.some((id) => typeof id !== 'string' || id === ''))) throw invalid('defaultSegment', '必须是参考集里一段的名字，或者几种语言各一段的名字的数组');
  const repeated = defaultSegments.find((id, index) => defaultSegments.indexOf(id) !== index);
  if (repeated !== undefined) throw invalid('defaultSegment', `${JSON.stringify(repeated)} 点名了两次`);

  rejectLabels(input.labels, 'labels');
  const defaultLanguage = readLanguage(input.language, 'language'); // 给所有段的默认只有语言；没有默认的音色基底标签
  const kept = hasPrevious ? previous.segments.filter((segment) => !drop.includes(segment.id)) : [];
  const retag = readRetag(input.retag, { previous, kept }); // 改名：上一版参考的新标签
  const previousItems = kept.map((segment, index) => ({
    index,
    id: segment.id,
    audio: segment.audio,
    text: segment.text,
    ...(segment.annotatedText === undefined ? {} : { annotatedText: segment.annotatedText }), // 上一版的提示标注原样沿用，不再标
    // 上一版的语言和音色基底标签原样沿用（留出录音没有标签），不再判断；作者改了名的参考用改以后的标签
    givenLanguage: segment.language,
    givenTag: retag.get(segment.id) ?? segment.tag,
    ...(retag.has(segment.id) ? { retagged: true } : {}),
    source: null,
    externalUrl: segment.externalUrl,
    synthetic: segment.synthetic, // 上一版清单里标的：克隆出来的，跟着段走
    previous: segment.role,
    path: segment.path,
  }));
  const segments = input.segments === undefined && hasPrevious ? [] : input.segments;
  const fresh = readSegments(segments, defaultLanguage, { taken: previousIds, offset: previousItems.length, allowEmpty: hasPrevious || moreSegments });
  assertSentenceGroups(fresh, previousItems.length, { moreSentences, defaultLanguage }); // 可能并进同一段的句子，synthetic、annotatedText 要标得一样
  for (const wanted of moreSegments ? [] : defaultSegments) {
    const isPreviousReference = kept.some((segment) => segment.id === wanted && segment.role === 'reference');
    if (!isPreviousReference && !fresh.some((item) => item.id === wanted)) throw invalid('defaultSegment', `${JSON.stringify(wanted)} 不是参考集里的一段（上一版的参考，或者这次新补的；留出录音和去掉的不行）`);
  }
  // 卡片试听那一句：去掉两头空白（素材的文字都这样），别的原样
  const cardLine = input.cardLine === undefined ? undefined : input.cardLine.trim();
  return { items: [...previousItems, ...fresh], version: { version: input.version, bump: input.bump, changelog, drop, defaultSegments }, direction, cardLine };
}

/**
 * loudness 选项：省略或 true 是默认的目标响度、峰值上限和限幅器（REFERENCE_LOUDNESS_LUFS、PEAK_CEILING_DBFS、LIMITER_MAX_DB），false 关掉，对象改目标、上限、限幅器（见 tools/loudness-normalize.mjs 的 loudnessOptions）。
 * @returns {{ targetLufs: number, peakCeilingDbfs: number, limiter: { maxDb: number } | null } | null} 补全的目标、上限和限幅器（limiter 是 null：限幅器关了）；整个调响度关掉是 null
 */
function readLoudness(value) {
  if (value === false) return null;
  if (value === undefined || value === true) return loudnessOptions();
  if (!isPlainObject(value)) throw invalid('loudness', `必须是 true、false 或 { targetLufs?, peakCeilingDbfs?, limiter? }，收到 ${JSON.stringify(value)}`);
  try {
    return loudnessOptions(value);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw invalid('loudness', cause.message);
  }
}

/**
 * textLanguage 选项：包里 SKILL.md 骨架的语言，省略是 'zh'，也可以是 'en'（规则只在 protocol/lib/skill-md.mjs 的 resolveTextLanguage 写一遍）。
 * 那边写错了抛 TypeError（程序员用错接口）；这里换成 make_pack_input_invalid，和别的选项一样在花钱之前点名是哪个选项。
 * @returns {'zh' | 'en'}
 */
function readTextLanguage(value) {
  try {
    return resolveTextLanguage(value);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw invalid('textLanguage', cause.message);
  }
}

export function readOptions(options) {
  if (!isPlainObject(options)) throw invalid('options', '必须是对象');
  // 挑素材的几个选项：规则只在 lib/pack-material.mjs 写一遍。写错了在花钱之前就报 make_pack_input_invalid，不等到挑素材那一步抛 TypeError（程序员用错接口才抛 TypeError，protocol/README.md「错误」）
  const [problem] = materialOptionProblems(options);
  if (problem !== undefined) throw invalid(problem.field, problem.message);
  if (options.concurrency !== undefined && !(Number.isInteger(options.concurrency) && options.concurrency >= 1 && options.concurrency <= 8)) throw invalid('concurrency', '必须是 1–8 的整数');
  if (options.describeChanges !== undefined && typeof options.describeChanges !== 'function') throw invalid('describeChanges', '必须是函数 (changes, { name }) => 一句变更说明');
  if (options.retryWait !== undefined && typeof options.retryWait !== 'function') throw invalid('retryWait', '必须是函数 (毫秒) => Promise，转写、挑默认段、标提示标注、试合成暂时出错、再试之前等多久');
  if (options.minChars !== undefined && options.minChars !== null && !(Number.isInteger(options.minChars) && options.minChars >= 1)) throw invalid('minChars', '必须是不小于 1 的整数（合成能力一次至少多少个字，环境声明的），或者不给');
  // 配卡片试听那一句时交给配音的两项上限（环境声明的，写法同 lib/dub.mjs 的同名选项；maxChars 的下限在 lib/synthesis-limits.mjs）
  if (options.maxChars !== undefined && options.maxChars !== null && !(Number.isInteger(options.maxChars) && options.maxChars >= MIN_MAX_CHARS)) throw invalid('maxChars', `必须是不小于 ${MIN_MAX_CHARS} 的整数（合成能力一次最多多少个字，环境声明的），或者不给`);
  if (options.maxPauseInRequestMs !== undefined && options.maxPauseInRequestMs !== null && !(Number.isInteger(options.maxPauseInRequestMs) && options.maxPauseInRequestMs >= 0)) throw invalid('maxPauseInRequestMs', '必须是不小于 0 的整数（一个请求里一处停顿最多多少毫秒，环境声明的），或者不给');
  if (options.allowCrossLanguage !== undefined && typeof options.allowCrossLanguage !== 'boolean') throw invalid('allowCrossLanguage', '必须是 true 或 false（true：卡片试听那一句和给它挑的参考段不是一种语言也照配，带口音），或者不给');
  // loudness 换成补全的目标、上限和限幅器，或者 null（关掉）；textLanguage 换成 'zh' 或 'en'（没给就是 'zh'）
  return { ...options, loudness: readLoudness(options.loudness), textLanguage: readTextLanguage(options.textLanguage) };
}

/** input 必须是对象。makePack 最先查它：连 options 都还没读。 */
export function assertInput(input) {
  if (!isPlainObject(input)) throw invalid('input', '必须是对象');
}

/**
 * 设定合成的开头的提示不超过 MAX_OPENING_CUE_WORDS 个词（规则见文件头「设定合成的开头的提示」）。setups 是这一版要写进清单的设定；carried 为真是沿用上一版的。
 * @returns {object[]} 沿用的设定里超了的，每套一条 note（setup_opening_cue_too_long）；给的超了抛错，不返回
 * @throws {VoicePackError} make_pack_input_invalid（field 是 setups[<序号>]，details 另有 words、limit）
 */
export function checkSetupOpeningCues(setups, { carried = false } = {}) {
  const notes = [];
  if (!Array.isArray(setups)) return notes;
  setups.forEach((setup, index) => {
    if (!isPlainObject(setup) || !isPlainObject(setup.labels)) return;
    const { cue } = openingCueOf({}, setup.labels);
    const words = cue === null ? 0 : cueWords(cue);
    if (words <= MAX_OPENING_CUE_WORDS) return;
    const name = typeof setup.name === 'string' ? setup.name : `第 ${index + 1} 套`;
    const counted = `合成的开头的提示 ${cue} 数出来 ${words} 个词，超过上限 ${MAX_OPENING_CUE_WORDS} 个词（汉字、假名两个算一个词，拼音文字按空格数，一下子的声音不算）`;
    if (carried) {
      notes.push({
        code: 'setup_opening_cue_too_long',
        message: `沿用上一版的设定 ${JSON.stringify(name)} ${counted}，原样写进了这一版。配音用到这套设定时会报 dub_input_invalid（命令行用更短的 --emotion、--style 盖过它，或者 --no-setup）；要改，给 setups（命令行 --setups）换一份情绪、风格短的`,
        details: { setup: name, words, limit: MAX_OPENING_CUE_WORDS, from: 'previous' },
      });
      return;
    }
    throw invalid(`setups[${index}]`, `设定 ${JSON.stringify(name)} ${counted}。配音时它写在每个请求的开头，要短：情绪、风格用标签词表（vocab/cues.json）里的短词，不写成一长串；把这套设定的情绪、风格改短（写法见 references/make-pack.md「几套设定」、models/scene3.md「写什么」）`, { words, limit: MAX_OPENING_CUE_WORDS });
  });
  return notes;
}

/** 挑素材的选项里调用方给了的那几个（没给的不写，lib/pack-material.mjs 用自己的默认值）。 */
export const materialOptionsOf = (settings) => Object.fromEntries(['holdoutRatio', 'maxHoldout', 'maxReferences', 'minHoldoutTokens', 'maxSynthesisChars'].filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
