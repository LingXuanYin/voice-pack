// SPDX-License-Identifier: Apache-2.0
//
// 查重（流程层）：做包的最后一步，把新包和来源包比一遍，文字或录音复用得太多就报错。流程的正本是 protocol/new-pack/README.md。
// 它不比说话人像不像：同一个配音演员给几个角色配音是正常的，同一个人说的另一句话不算复用。比的只有两样：作者写的文字，和「同一段录音」。
//
//   const report = await checkDuplicates(env, { candidate, source });          超过阈值抛 duplicate_detected
//   const candidate = materialOfInput(input, { recordings });                   新包：做包的输入（lib/make-pack.mjs 的 input）加没切的长录音
//   const source = materialOfPack(files);                                       来源包：角色部分的文件（Map<路径, Uint8Array>）
//
// ---------------------------------------------------------------- 比什么
//
//   文字：新包的每一项和来源包的每一项两两比（不分种类：把来源的指引贴进描述、把描述贴进台词，一样抓得到），只有「一条台词」和「整份台词」之间不互比（是同一批字）：
//     direction.description、designSource.description    都是「这个声音听起来什么样」
//     guidance       配音指引的正文，比之前先去掉 Markdown 的标题行（标题来自模板，不是作者写的）
//     sampleLines[i] 示例台词的每一条（词数不到 minTokens 的那一条单独不比：太短，各写各的也容易撞）
//     sampleLines    整份示例台词（每条一行连起来）：一条一条都很短时，整份抄是抄的是整份
//     script:路径     包里登记的脚本（清单的 scripts，UTF-8 的文本文件）
//   不比的，和为什么：
//     标签和场景（direction.tags、scenes）  从词表里选的，同一类声音本来就选得一样
//     名字、变更说明                        短，而且「新版本」「Mira 的包」这样的话谁都会写
//     读音词表（lexicon.pls）                一张「词 → 读法」的表，是事实不是创作：两个人给同一个词注音写出来的条目一样，不是抄
//     转写（每段录音里说的话）               读同一句话（课文、校准句子）不是抄；录音被搬用由指纹管。要是把整套转写照抄再重录，那不是「直接复用」
//   录音：新包的每一段录音（参考、留出录音、没切的长录音）和来源包的每一段录音（参考、留出录音）用音频指纹比（tools/audio-fingerprint.mjs），
//        量的是「新的这段里有多少秒是来源里的录音」。来源包里指向外部资源的录音（包里没有字节）比不了，计在 sourceUnchecked 里。
//
// ---------------------------------------------------------------- 怎么比、阈值
//
//   文字用 lib/text-overlap.mjs 的三个量：ROUGE-L 的 F1（Self-Instruct 丢掉重合太高的新指令用的就是它，阈值 0.7）、
//   抄用比例 ratio（新文字里连续词组原样在来源里的比例）、来源被带走的比例 coverage。任何一个量超过阈值就是一项。
//   阈值是拿真实数据标定的，不是照搬 0.7：标定用的数据、脚本和逐项结果不随基础部分发布，下面写的是依据的数字。
//     F1 的阈值         0.75    各写各的：真实音色描述里属性一样、编号不同的 4000 对，F1 的 99.5 分位是 0.67，最高 0.80，超过 0.75 的 1 对；模型按净室输入写的描述、指引、台词，
//                               两份互相比（同一类声音、使用者的话不同）最高 0.54，对真实来源最高 0.38。抄的：只改 20% 的词，真实描述 99%、模型写的 6/6 在 0.75 以上（模型写的最低 0.763）；
//                               改 30% 的抓不到（真实 8%，模型写的 0/6）：短文字上改了三成词的抄本，和各写各的的上沿分不开，这一档查重不管。
//     ratio、coverage    0.60    各写各的：真实 4000 对最高 0.53（99.5 分位 0.38），模型写的最高 0.10。抄的：换了句子次序抄（F1 掉到 0.2–0.3，ratio 最低 0.656）、夹进更长的文字里
//                               （coverage 是 1）、只留一半（ratio 是 1）都在 0.6 以上
//     minTokens          8       不到 8 个词（中文 8 个字）的文字单独不比：比的是 4 个词一组的词组，不到 8 个词连 5 组都凑不出来，「各写各的也撞」和「抄」分不开。
//                               校准的数据里没有比 8 更短的样本，这个数是按词组个数定的，不是量出来的
//     示例台词逐条比：模型写的两份示例台词，每概念第一份的每一句去第二份里找最像的一句（43 句，不限词数），F1 最高 0.40，ratio、coverage 都是 0；整份只抄一半的台词，整份比分不出来（F1 0.45–0.64，ratio ≤ 0.58），逐条比能抓到（原样抄的那几条 F1 是 1）
//   录音：reusedSeconds 0.5 秒。指纹自己的下限（同一个位置差上至少 16 票、至少 8 个相邻的锚点）已经挡掉了碰巧凑出来的：1,144 次查询（同一个人的另一句话、别人的录音：48 段对 48 段，48 段对 128 段，640 段对 128 段，
//   最大的一次是 408 段对 408 段、40 分钟的索引）一次也没有过线，最宽松的设置下最集中的位置差最多 15 票（下限 16）、一段里最多 5 个锚点（下限 8）。
//   46 种变换（重新编码 mp3、opus、aac、μ-law，响度、压缩、限幅，重采样 8k 到 48k，截头去尾，一个半秒以上的摘录，混进更长的录音，叠上别人的声音，白噪声到信噪比 5 dB，电话频带，回声）
//   下整段复用都认得出来（只有半秒和一秒的摘录漏了：半秒的 5/48，一秒的 40/48），量出来最少 0.9 秒。怎么抄就抓不到：改写（换个说法再写一遍）、变速、变调、倒放、重新念一遍。
//   这些不是「直接复用」，查重不管，也管不了。
//
// ---------------------------------------------------------------- 谁调、什么时候调、不留什么
//
//   调用方在花钱的步骤（转写、听着打标签、试合成）之前调：要查的东西（文字、录音）这时都已定下，查出问题就不用白花钱。命令行的 make-pack --source-pack 和 app 的做包页都是这样用的。
//   来源包只在这里读：不验哈希（只读它的内容来比，不拿它当包用），不联网。查完不留来源包的记录：这个函数不收也不返回来源包的名字、包 ID、路径，
//   duplicate_detected 的 details 里只有新包的 item、量、阈值；调用方也不要把来源包的标识写进新包、日志、报告。
//   env 只在解码 WAV 以外的格式时用（env.runtimes.ffmpeg）；解不了的录音记在 unchecked 里，不假装查过了。
//   一段录音整段解码进内存，很长的录音（二十分钟、立体声、44.1 kHz）要几百兆：调用方要处理很长的，先按需要切。
//
// ---------------------------------------------------------------- 返回和错误
//
//   返回 { thresholds, text, audio }：
//     text   { compared, skipped: [{ item, reason: 'too_short' | 'no_counterpart', tokens }], lcsSkipped, highest: { item, rougeLF1, copiedRatio, copiedCoverage } | null }
//            compared 是比过的新文字的项数；skipped 是没比的：too_short 太短，no_counterpart 来源里没有够长的文字可比；
//            lcsSkipped 是太长、没算 ROUGE-L 的对数（抄用比例照算）；highest 是离阈值最近的那一项（没有可比的是 null）：通过时也给，让调用方看到余量
//     audio  { checked, unchecked: [{ item, reason: 'decode_unavailable' | 'decode_failed' }], sourceClips, sourceUnchecked: { external?, decode_unavailable?, decode_failed? }, highest: { item, reusedSeconds, totalSeconds } | null }
//   duplicate_detected（VoicePackError）：details: { findings, thresholds, text, audio }。findings 是 [{ kind: 'text' | 'audio', item, measure, value, threshold, totalSeconds? }]：
//     kind 'text'   item 是 direction.description、guidance、sampleLines[3]、sampleLines、script:scripts/x.mjs 这样新包里的项；measure 是 rouge_l_f1、copied_ratio、copied_coverage
//     kind 'audio'  item 是新包里那段录音的名字；measure 是 reused_seconds，value 是复用的秒数，totalSeconds 是这段录音一共多长
//   duplicate_check_source_invalid  来源包读不了：没有 manifest.json、不是合法的 JSON、不是角色部分。details.reason 是 manifest_missing、manifest_unreadable、not_role_part
//   TypeError                       candidate、source、thresholds 的形状不对
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { extractGuidance } from '../protocol/lib/skill-md.mjs';
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { fingerprintAudio, indexFingerprints, findReuse } from '../tools/audio-fingerprint.mjs';
import { compareTexts, tokenizeText } from './text-overlap.mjs';

export const DEFAULT_THRESHOLDS = Object.freeze({
  text: Object.freeze({ minTokens: 8, rougeLF1: 0.75, copiedShare: 0.6 }),
  audio: Object.freeze({ reusedSeconds: 0.5 }),
});

const decoder = new TextDecoder('utf-8', { fatal: true });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripHeadings = (text) => text.split(/\r?\n/).filter((line) => !/^\s*#{1,6}\s/.test(line)).join('\n').trim();
const round = (value) => Math.round(value * 1000) / 1000;

function mergeThresholds(overrides) {
  if (overrides === undefined) return DEFAULT_THRESHOLDS;
  if (!isPlainObject(overrides)) throw new TypeError('thresholds 必须是对象 { text?, audio? }');
  const out = {};
  for (const group of Object.keys(DEFAULT_THRESHOLDS)) {
    const given = overrides[group] ?? {};
    if (!isPlainObject(given)) throw new TypeError(`thresholds.${group} 必须是对象`);
    const unknown = Object.keys(given).filter((key) => !Object.hasOwn(DEFAULT_THRESHOLDS[group], key));
    if (unknown.length > 0) throw new TypeError(`thresholds.${group} 里不认识的项：${unknown.join('、')}`);
    out[group] = { ...DEFAULT_THRESHOLDS[group], ...given };
    for (const [key, value] of Object.entries(out[group])) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (key !== 'minTokens' && key !== 'reusedSeconds' && value > 1)) throw new TypeError(`thresholds.${group}.${key} 必须是正数${key === 'minTokens' || key === 'reusedSeconds' ? '' : '（不大于 1）'}`);
    }
  }
  const unknownGroups = Object.keys(overrides).filter((group) => !Object.hasOwn(DEFAULT_THRESHOLDS, group));
  if (unknownGroups.length > 0) throw new TypeError(`thresholds 里不认识的项：${unknownGroups.join('、')}`);
  return out;
}

// ---------------------------------------------------------------- 把两边整理成要比的东西

function textUnit(texts, item, kind, text) {
  if (typeof text === 'string' && text.trim() !== '') texts.push({ item, kind, text });
}

/** 文本文件的内容；不是 UTF-8 的（二进制）不比。 */
function textOfFile(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** 示例台词：每一条，加整份。 */
function sampleLineUnits(texts, lines) {
  if (!Array.isArray(lines)) return;
  lines.forEach((line, index) => textUnit(texts, `sampleLines[${index}]`, 'sampleLine', line));
  textUnit(texts, 'sampleLines', 'sampleLines', lines.filter((line) => typeof line === 'string').join('\n'));
}

/**
 * 新包要比的东西，取自做包的输入（lib/make-pack.mjs 的 input）。
 * @param {object} input 做包的输入：direction、designSource、guidance、sampleLines、scripts、files、segments 里用到的几项
 * @param {{ recordings?: { item: string, audio: { bytes: Uint8Array } }[] }} [options] recordings：还没切的长录音（命令行的 --recording、--audition）
 * @returns {{ texts: { item: string, kind: string, text: string }[], recordings: { item: string, bytes: Uint8Array }[] }}
 */
export function materialOfInput(input, { recordings = [] } = {}) {
  if (!isPlainObject(input)) throw new TypeError('input 必须是对象');
  const texts = [];
  textUnit(texts, 'direction.description', 'description', input.direction?.description);
  textUnit(texts, 'designSource.description', 'description', input.designSource?.description);
  if (typeof input.guidance === 'string') textUnit(texts, 'guidance', 'guidance', stripHeadings(input.guidance));
  sampleLineUnits(texts, input.sampleLines);
  for (const script of Array.isArray(input.scripts) ? input.scripts : []) {
    const text = textOfFile(input.files instanceof Map ? input.files.get(script?.entry) : undefined);
    if (text !== null) textUnit(texts, `script:${script.entry}`, 'script', text);
  }
  const clips = [];
  (Array.isArray(input.segments) ? input.segments : []).forEach((segment, index) => {
    if (segment?.audio?.bytes instanceof Uint8Array) clips.push({ item: typeof segment.id === 'string' ? segment.id : `segments[${index}]`, bytes: segment.audio.bytes });
  });
  for (const recording of recordings) clips.push({ item: recording.item, bytes: recording.audio.bytes });
  return { texts, recordings: clips };
}

/**
 * 来源包要比的东西，读自角色部分的文件。只读清单、SKILL.md、清单里登记的脚本和录音；不验哈希，不联网。
 * 返回里没有来源包的名字和包 ID：用不着，也不该往后传。
 * @param {Map<string, Uint8Array>} files 角色部分的文件（完整包里还有 protocol/、voice-pack/，不会读）
 * @returns {{ texts: { item: string, kind: string, text: string }[], recordings: { bytes: Uint8Array }[], external: number }}
 */
export function materialOfPack(files) {
  if (!(files instanceof Map)) throw new TypeError('files 必须是 Map<路径, Uint8Array>');
  const bytes = files.get('manifest.json');
  if (!(bytes instanceof Uint8Array)) throw new VoicePackError('duplicate_check_source_invalid', '来源包里没有 manifest.json：不是一个音色包', { details: { reason: 'manifest_missing' } });
  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new VoicePackError('duplicate_check_source_invalid', '来源包的 manifest.json 读不了（不是合法的 JSON）', { details: { reason: 'manifest_unreadable' }, cause });
  }
  if (!isPlainObject(manifest) || manifest.part !== 'role') throw new VoicePackError('duplicate_check_source_invalid', '来源包不是角色部分（或是只有基础部分、协议核心）：没有角色内容可比', { details: { reason: 'not_role_part' } });

  const texts = [];
  textUnit(texts, 'direction.description', 'description', manifest.direction?.description);
  textUnit(texts, 'designSource.description', 'description', manifest.designSource?.description);
  const skill = textOfFile(files.get('SKILL.md'));
  const guidance = skill === null ? null : extractGuidance(skill);
  if (guidance !== null) textUnit(texts, 'guidance', 'guidance', stripHeadings(guidance));
  sampleLineUnits(texts, manifest.sampleLines);
  for (const script of Array.isArray(manifest.scripts) ? manifest.scripts : []) {
    const text = textOfFile(files.get(script?.entry));
    if (text !== null) textUnit(texts, `script:${script.entry}`, 'script', text);
  }
  const recordings = [];
  let external = 0;
  const segments = [...(Array.isArray(manifest.reference?.segments) ? manifest.reference.segments : []), ...(Array.isArray(manifest.holdout) ? manifest.holdout : [])];
  for (const segment of segments) {
    const clip = files.get(segment?.audio);
    if (clip instanceof Uint8Array) recordings.push({ bytes: clip });
    else external++;
  }
  return { texts, recordings, external };
}

// ---------------------------------------------------------------- 文字

/** 一条台词和整份台词是同一批字，互相不比（一条台词在整份里，整份就会把它「抄了一遍」）；别的两两都比。 */
const LINES = new Set(['sampleLine', 'sampleLines']);
const comparable = (a, b) => a.kind === b.kind || !(LINES.has(a.kind) && LINES.has(b.kind));

function compareAllTexts(candidateTexts, sourceTexts, limits) {
  const sized = (units) => units.map((unit) => ({ ...unit, tokens: tokenizeText(unit.text).length }));
  const candidates = sized(candidateTexts);
  const sources = sized(sourceTexts).filter((unit) => unit.tokens >= limits.minTokens);
  const findings = [];
  const skipped = [];
  let compared = 0;
  let lcsSkipped = 0;
  let highest = null;
  let highestScore = -1;
  for (const candidate of candidates) {
    if (candidate.tokens < limits.minTokens) {
      skipped.push({ item: candidate.item, reason: 'too_short', tokens: candidate.tokens });
      continue;
    }
    const counterparts = sources.filter((source) => comparable(candidate, source));
    if (counterparts.length === 0) {
      skipped.push({ item: candidate.item, reason: 'no_counterpart', tokens: candidate.tokens });
      continue;
    }
    compared++;
    const peak = { f1: 0, ratio: 0, coverage: 0 };
    for (const source of counterparts) {
      const result = compareTexts(candidate.text, source.text);
      if (result.rougeL === null) lcsSkipped++;
      peak.f1 = Math.max(peak.f1, result.rougeL?.f1 ?? 0);
      peak.ratio = Math.max(peak.ratio, result.copied.ratio ?? 0);
      peak.coverage = Math.max(peak.coverage, result.copied.coverage ?? 0);
    }
    for (const [measure, value, threshold] of [['rouge_l_f1', peak.f1, limits.rougeLF1], ['copied_ratio', peak.ratio, limits.copiedShare], ['copied_coverage', peak.coverage, limits.copiedShare]]) {
      if (value >= threshold) findings.push({ kind: 'text', item: candidate.item, measure, value: round(value), threshold });
    }
    const score = Math.max(peak.f1 / limits.rougeLF1, peak.ratio / limits.copiedShare, peak.coverage / limits.copiedShare);
    if (score > highestScore) {
      highestScore = score;
      highest = { item: candidate.item, rougeLF1: round(peak.f1), copiedRatio: round(peak.ratio), copiedCoverage: round(peak.coverage) };
    }
  }
  return { findings, report: { compared, skipped, lcsSkipped, highest } };
}

// ---------------------------------------------------------------- 录音

/** 解码并取指纹。解不了返回 { reason }，不抛（只有不认得的错才往上传）。 */
async function print(env, bytes) {
  let audio;
  try {
    audio = await decodeAudio(env, bytes);
  } catch (error) {
    const kind = decodeFailureKind(error);
    if (kind === 'runtime_missing') return { reason: 'decode_unavailable' };
    if (kind === 'undecodable') return { reason: 'decode_failed' };
    throw error;
  }
  return { fingerprint: fingerprintAudio(audio) };
}

async function compareRecordings(env, candidateClips, sourceClips, limits, { yieldControl, onProgress }) {
  const total = candidateClips.length + sourceClips.length;
  let done = 0;
  const step = async (phase) => {
    done++;
    if (onProgress !== undefined) onProgress({ phase, done, total });
    if (yieldControl !== undefined) await yieldControl();
  };
  const entries = [];
  const sourceUnchecked = {};
  for (const clip of sourceClips) {
    const printed = await print(env, clip.bytes);
    if (printed.fingerprint === undefined) sourceUnchecked[printed.reason] = (sourceUnchecked[printed.reason] ?? 0) + 1;
    else entries.push({ id: String(entries.length), fingerprint: printed.fingerprint });
    await step('source');
  }
  const index = indexFingerprints(entries);
  const findings = [];
  const unchecked = [];
  let checked = 0;
  let highest = null;
  for (const clip of candidateClips) {
    const printed = await print(env, clip.bytes);
    if (printed.fingerprint === undefined) unchecked.push({ item: clip.item, reason: printed.reason });
    else {
      checked++;
      const { reusedSeconds } = findReuse(printed.fingerprint, index);
      if (reusedSeconds >= limits.reusedSeconds) findings.push({ kind: 'audio', item: clip.item, measure: 'reused_seconds', value: round(reusedSeconds), threshold: limits.reusedSeconds, totalSeconds: round(printed.fingerprint.durationSec) });
      if (highest === null || reusedSeconds > highest.reusedSeconds) highest = { item: clip.item, reusedSeconds: round(reusedSeconds), totalSeconds: round(printed.fingerprint.durationSec) };
    }
    await step('candidate');
  }
  return { findings, report: { checked, unchecked, sourceClips: entries.length, sourceUnchecked, highest } };
}

// ---------------------------------------------------------------- 入口

const describe = (finding) => (finding.kind === 'text'
  ? `${finding.item} 的${{ rouge_l_f1: ' ROUGE-L F1', copied_ratio: '抄用比例', copied_coverage: '来源被带走的比例' }[finding.measure]}是 ${finding.value}（阈值 ${finding.threshold}）`
  : `录音 ${finding.item} 里有 ${finding.value} 秒是来源包里的录音（这段一共 ${finding.totalSeconds} 秒，阈值 ${finding.threshold} 秒）`);

/**
 * 把新包和来源包比一遍。规则、返回和错误见文件头。
 * @param {object|undefined} env 注入的运行环境；只在解 WAV 以外的音频时用（env.runtimes.ffmpeg）
 * @param {{ candidate: object, source: object, thresholds?: object, yieldControl?: () => Promise<void>, onProgress?: (progress: { phase: string, done: number, total: number }) => void }} input
 *   yieldControl 每解码、取完一段录音的指纹以后等一下（给浏览器让出主线程：() => new Promise((resolve) => setTimeout(resolve, 0))）；onProgress 报进度
 */
export async function checkDuplicates(env, input) {
  if (!isPlainObject(input) || !isPlainObject(input.candidate) || !isPlainObject(input.source)) throw new TypeError('input 必须是 { candidate, source }，用 materialOfInput 和 materialOfPack 做出来');
  for (const side of [input.candidate, input.source]) {
    if (!Array.isArray(side.texts) || !Array.isArray(side.recordings)) throw new TypeError('candidate 和 source 都要有 texts 和 recordings 两个数组');
  }
  const thresholds = mergeThresholds(input.thresholds);
  const text = compareAllTexts(input.candidate.texts, input.source.texts, thresholds.text);
  const audio = await compareRecordings(env ?? { capabilities: {}, runtimes: {} }, input.candidate.recordings, input.source.recordings, thresholds.audio, { yieldControl: input.yieldControl, onProgress: input.onProgress });
  const report = { thresholds, text: text.report, audio: { ...audio.report, sourceUnchecked: { ...audio.report.sourceUnchecked, ...(input.source.external > 0 ? { external: input.source.external } : {}) } } };
  const findings = [...text.findings, ...audio.findings];
  if (findings.length > 0) {
    throw new VoicePackError('duplicate_detected', `查重不通过：新包里有 ${findings.length} 处和来源包重合太多：${findings.map(describe).join('；')}。把这些文字改成自己的话、换掉这些录音，再做。`, { details: { findings, ...report } });
  }
  return report;
}
