// SPDX-License-Identifier: Apache-2.0
//
// 提示还缺什么素材（流程层，纯数据）：做包做完以后，对着做出来的参考集和留出录音，列出「再补什么素材会更好」。
// 建议参考够多、够长，覆盖会说的几种语言。
// 每一条提示都是一条规则，输入是普通数据，不碰音频、不用模型、没有随机，所以每条都能拿数据直接测（lib/make-pack-report.mjs 调它，app 也可以）。
//
//   suggestMaterial(material) -> hints
//
// material：
//   references  参考集 [{ id, language, tag?, durationSec?, synthetic? }]（写法同清单的参考段；durationSec 不知道就不给；synthetic 为 true 的是克隆出来的，不算真录音）
//   holdouts    留出录音 [{ id, language, synthetic? }]，没有就是 []
//   unused      没用上的片段 [{ id, reason, details? }]，没有就是 []；reason 是做包报告里的那些原因（每一种写在产生它的那一步的文件头：lib/make-pack-screen.mjs、
//               lib/make-pack-transcribe.mjs、lib/make-pack-tags.mjs、lib/pack-material.mjs、lib/make-pack-take-audio.mjs）
//   guidance    有没有写配音指引（布尔值，默认 true：不知道就不提示）
//   guidanceGaps 配音指引里没填的项（字符串数组，默认 []），由 guidanceGaps(配音指引) 算（见下面）
//   direction   音色标签有没有写（布尔值，默认 true）
//   designSource 素材是不是设计出来的（布尔值，默认 false）：清单里有 designSource 就是 true（lib/fidelity.mjs 文件头第 10 点）。设计出来的声音、默认音色、
//               融合出来的声音做包都写设计来源（lib/make-pack.mjs 的 designSource），清单分不出是哪一种，这里三种一样对待。
//               是的话不给 no_holdout、holdouts_few：这几种声音都没有真人录音，再合成几句只是多一轮试合成，拖慢做包；
//               也不给参考段的三条（few_references、short_reference_total、language_single_reference）。这是照设计出来的声音定的：正式的包里参考只有照试听配的那一段
//               （references/make-pack.md「Making a pack from a designed voice」第 3 步），没有录音可补，照提示去补只能拿这个包自己再克隆几段。
//               默认音色、融合出来的包（命令行 --audition）参考是试听切出来的，再生成几段试听就补得上，不用克隆这个包；可是看清单分不出它，也就不给这三条。
//               它的参考少、短，由做包的人看报告自己补（references/make-pack.md「What material is still missing」）。要分开给，得在清单里记下是哪一种声音，那是格式的事。不是的话照旧。
//   noHoldout   布尔值，默认 false：调用方不要留出录音（做包时 holdoutRatio 为 0，命令行 --no-holdout）。是的话也不给 no_holdout、holdouts_few：
//               不留出是调用方定的，再提醒「没有留出录音」没有用（理由和 designSource 一样）。
//   cardLine    试听句的情况 { status, error?, halted?, reasons?, onCard?, model?, modelChange? }，不给就不提示试听句的几条（不知道）：status 是做包报告的 cardLine.status
//               （lib/make-pack-card-line.mjs 的文件头：voiced、carried、failed、none），error、halted、reasons、onCard、model、modelChange 照报告的
// 提示 hints：[{ code, message, details }]，次序固定（下面表里的次序，同一条规则里按取值的次序）。code 是机器读的，message 是给人看的中文，
// details 里是这条提示依据的数。没有可提示的就是空数组。提示只是建议，不挡任何事（不设门槛）。
//
// 规则（数值是起步值，没有拿真实的包标定过；改数值改 THRESHOLDS，别处不写数）。只能靠拿这个包自己再克隆才补得上的，不提示去补（设计出来的包的参考段，
// 某种语言的参考全是合成的）：克隆只会照搬这个包已有的声音和演法，补进来不比现在多什么。设计来源的包一律不给参考段的三条，默认音色、融合出来的也在内（见 designSource）。
//   no_holdout                  没有留出录音：还原度量不了。details: { references }。设计来源的包和 noHoldout 的包不给（见 designSource、noHoldout）
//   holdouts_few                留出录音有，但不到 5 条：读还原度要有效的留出录音至少 5 条才下结论（lib/fidelity.mjs 文件头「How to read this report」第 1 点）。details: { count, needed, missing }：
//                               missing 是按规则 2（lib/pack-material.mjs 的 plannedHoldouts）还差几段真录音才留得出 needed 条（标了 synthetic 的不算，见下面的输入）。设计来源的包和 noHoldout 的包不给
//   few_references              参考不到 3 段：默认段从参考里挑，段太少就挑不出最自然的那一段。details: { count, needed }。设计来源的包不给
//   short_reference_total       参考加起来不到 30 秒（只在每段都有时长时判断）。details: { seconds, needed }。设计来源的包不给
//   language_single_reference   某种语言的参考只有一段（例如「英语只有一段」）。每种这样的语言一条。语言按规范化以后的写法分组（protocol/lib/manifest.mjs 的 languageKey：
//                               zh-CN 和 zh-cn 是一种），显示的是这种语言第一次出现的写法。details: { language, count: 1 }。
//                               设计来源的包不给；那一段标了 synthetic 的不给（补另一种语言那条路：用这个包跨语言配一段当参考，references/character-voice.md「Add a reference segment in this language」）
//   unused_<原因>                没用上的片段，一种原因一条：补文本、重录、给语言……。details: { count, ids, ...原因里带的 }。
//                               audio_unrecognized 的说法看段的 details（lib/make-pack-take-audio.mjs）：有段带 runtime（环境没有 ffmpeg）说装 ffmpeg；
//                               不然有段带 message（ffmpeg 也取不出音轨）说文件里可能没有声音、坏了；都没有（外部资源、别的格式）说先转成包能放的格式
//   guidance_missing            没有配音指引：包不只音色要像，说话方式也要像。details: {}
//   guidance_gaps               配音指引里「这个人是谁」「换语言时怎么说」两节有没填的项（写着「缺」，或者这一项那一行没写）：列出是哪几项，
//                               说使用者在场就问、问到的补上发新版本，问不到的留着「缺」不编（references/make-pack.md「The five sections of the dubbing guidance」）。details: { items }
//
// guidanceGaps(guidance) -> string[]
//   配音指引（Markdown）里没填的项，次序同模板：「这个人是谁」的身份、性格、在意什么、对不同的人、情绪上来时，「换语言时怎么说」的名字、自称、口头禅。
//   一项算没填：这一节里没有这一项那一行（「- <项名>：」），或者冒号后面是空的，或者它的内容是「缺」（后面可以跟括号里的说明），或者按「；」分开的某一种语言写的是「<语言标签> 缺」，
//   这时写成「名字（en）」。这两节都没有的（旧式的指引）、不是字符串的：[]（缺节由做包的输入检查报，lib/make-pack-input.mjs）。
//   direction_tags_missing      没有音色标签：社区里按音色标签搜不到这个包。details: {}
//   card_line_failed            试听句没配成：清单里没有它，卡片放默认段。说为什么，怎么补（发新版本，带上这一句）。details: { code }（没配成的错误码）。
//                               没取回的（错误标了 details.unretrieved：合成那头做完了、计过费，只是结果没取回来，vocab/capability-signatures.md「General conventions」）另外说：
//                               这一次没有再调、没有再计费；照适配器给的 details.retrieve 手动取回（网址不打印），取回来的音频现在还不能交给做包放进包里；照提示重配会再计一次费。
//                               这时 details 是 { code, unretrieved: true, retrieve }（retrieve 是适配器给的那句话，没给是 null）
//   card_line_cross_language    试听句没配：给它挑的参考段不是这一句的语言，做包没给 allowCrossLanguage（cardLine 是 failed，error.code 是 dub_cross_language，lib/make-pack-card-line.mjs 的 voiceCardLine「跨语言」）。
//                               配了会带上参考那种语言的口音，所以一次都没调。说参考段和两边的语言（ja→en；认不出是哪种语言的写文字，ja→拉丁字母），再说怎么办：
//                               不问使用者，开头写名字对、加 --allow-cross-language 发新版本重配；使用者自己要补参考的，给包补一段这种语言的参考发新版本，再交这一句。补的参考从哪来（lib/cross-language.mjs 的 referenceSources）：
//                               有这个角色说这种语言的录音就用录音；没有的，默认用这个包跨语言配一段这种语言的话当参考；或者使用者在库里挑的一个说这种语言的声音；
//                               平台能指定模型的，另列一项先用别的模型念一遍再克隆。
//                               包里其实有这种语言的（hasLanguage），另说是带 default 的设定引过去的，改设定。
//                               有它就没有 card_line_failed。details: { segmentId, from, to, script?, hasLanguage }（同配音的 dub_cross_language 里的一项，lib/dub.mjs 第 3a 步）
//   card_line_halted            试听句没配成，是因为能力报凭据被拒（401）或账户停了（cardLine.halted，见 lib/make-pack-card-line.mjs）：不是这一句的问题，
//                               要使用者先处理（重新登录、处理账户），不要重试；处理好以后再发新版本补上。有它就没有 card_line_failed。details: { code }
//   card_line_stale             上一版的试听句沿用了，但和现在的配法有出入（cardLine 是 carried，带 reasons，lib/make-pack-card-line.mjs 的 carriedCardLine）：
//                               卡片上放的还是上一版配的。说哪里对不上（CARD_LINE_REASON_WORDS）；默认段换了（default_segment_changed）多半是换了声音，写明换了声音就交 --card-line 重配；
//                               别的要按现在的配法重配，也是交 --card-line。details: { reasons }
//   card_line_trimmed           写进包里的试听句（配成的、沿用的）比预览卡片能放的长：卡片上只放前面一截，或者放不下、改放默认段（onCard 是 null）。
//                               建议写短一点，发新版本重配。details: { seconds }（卡片上放的秒数；放不下，或者格式不解析时长，是 null）
//   card_line_missing           没给试听句（cardLine.status 是 none）：设计出来的声音和用录音做的声音都提醒（卡片上该放用包自己的声音配的那一句）。
//                               卡片上兜底放的都是主语言默认段那段录音：设计出来的声音，交出去的包里默认段是照试听配的那一段，试听不在包里
//                               （references/make-pack.md「Making a pack from a designed voice」），所以两种声音说的是同一句话。details: {}
//   card_line_model_changed     配试听句时适配器换了模型（cardLine.modelChange，adapters/README.md「When the model changes」）：写进包里的这一句是换上的模型配的，
//                               声音和演法可能和包的声音不一样；原来的模型能用了，发新版本重配。details: { model, from, reason }（model 是换上的，能力没报是 null）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { DEFAULTS, plannedHoldouts } from './pack-material.mjs';
import { languagePair, referenceSources } from './cross-language.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';
import { guidanceSection } from '../protocol/lib/guidance-sections.mjs';

export const THRESHOLDS = Object.freeze({
  /** 读还原度的读法要求的有效留出录音条数（lib/fidelity.mjs 文件头）。 */
  holdoutsToRead: 5,
  minReferences: 3,
  minReferenceSeconds: 30,
});

/** 没用上的原因的说明：怎么补。没列的原因给一句通用的。 */
const UNUSED_ADVICE = Object.freeze({
  no_text: 'no text, so not used: add a verbatim transcript, or connect transcription (automatic-speech-recognition) in the environment',
  transcription_failed: 'transcription failed (temporary service error), so not used: redo it later',
  transcription_blocked: 'transcription was blocked by the provider (content filter), so not used: add a verbatim transcript, or use a different transcription',
  language_unknown: 'the language could not be identified, so not used: give language in the material',
  duplicate_audio: 'the same audio as another segment, so not used: duplicates need no fix',
  audio_unrecognized: 'the audio format was not recognized, so not used: convert to wav, mp3, flac, ogg or m4a',
  audio_undecodable: 'could not be decoded, so not used: the audio file may be broken, or the environment lacks ffmpeg (needed to decode anything other than wav)',
  over_limit: 'the reference set is already full, so the extra ones were not used: no fix needed',
  trim_out_of_range: 'the start time in the material is beyond the end of the recording, so nothing can be cut and the segment was not used: change the start and end seconds to fit the length of the recording',
});

/** audio_unrecognized 另两种说法（规则见文件头 unused_<原因>）：环境没有 ffmpeg；有 ffmpeg 也取不出音轨。 */
const AUDIO_TRACK_ADVICE = Object.freeze({
  runtime: 'the audio format was not recognized and no audio track could be extracted, so not used: a file with a video track, or any other format, needs ffmpeg in the environment to extract the audio track; install it, or convert to wav, mp3, flac, ogg or m4a first',
  message: 'no audio track could be extracted, so not used: the file may have no sound or may be broken; use a file with sound, or convert to wav, mp3, flac, ogg or m4a first',
});

/** 一种原因的说法：audio_unrecognized 看段的 details，别的查 UNUSED_ADVICE，没列的给一句通用的。 */
function unusedAdvice(reason, entries) {
  if (reason === 'audio_unrecognized') {
    if (entries.some((entry) => entry.details?.runtime !== undefined)) return AUDIO_TRACK_ADVICE.runtime;
    if (entries.some((entry) => typeof entry.details?.message === 'string')) return AUDIO_TRACK_ADVICE.message;
  }
  return UNUSED_ADVICE[reason] ?? `not used (${reason})`;
}

/** 试听句沿用时和现在的配法对不上的原因（lib/make-pack-card-line.mjs 的 carriedCardLine 的 reasons），给人看的说法。命令行的报告也用它。 */
export const CARD_LINE_REASON_WORDS = Object.freeze({
  reference_changed: 'the reference used for it changed',
  request_text_changed: 'the text sent to the model changed (pronunciation lexicon, opening cue added)',
  speed_changed: 'the speed changed',
  expressiveness_changed: 'the expressiveness changed',
  not_one_request: 'it can no longer be dubbed as one request, so it cannot be compared',
  default_segment_changed: 'the default segment changed',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 真录音：没有标 synthetic 的段（克隆出来的不算，规则 2 只数真录音，见 lib/pack-material.mjs）。 */
const isReal = (entry) => entry.synthetic !== true;

/**
 * 按规则 2（lib/pack-material.mjs 的 plannedHoldouts，用它的默认比例和上限）：留出 wanted 条要几段真录音；现在有 realNow 段，还差几段。
 * 从现在的段数往上数，数到 plannedHoldouts 够 wanted 为止。比例是 0，或者 wanted 超过上限，就永远够不着：直接报错，不往下数。
 */
function realMissingFor(wanted, realNow) {
  if (DEFAULTS.holdoutRatio === 0 || wanted > DEFAULTS.maxHoldout) throw new RangeError(`cannot hold out ${wanted} (holdoutRatio ${DEFAULTS.holdoutRatio}, maxHoldout ${DEFAULTS.maxHoldout})`);
  let total = realNow;
  while (plannedHoldouts(total) < wanted) total += 1;
  return total - realNow;
}

/** holdouts_few 的文字：按现在的比例还差几段真录音。已经够了（差 0 段），留出的少就不是真录音数量的问题。 */
function fewHoldoutsMessage(count, missing) {
  const head = `Only ${count} held-out ${count === 1 ? 'recording' : 'recordings'}: reading the fidelity needs at least ${THRESHOLDS.holdoutsToRead} valid held-out recordings before a conclusion is drawn.`;
  return missing > 0
    ? `${head} At the current ratio, ${missing} more real ${missing === 1 ? 'recording' : 'recordings'} are needed to hold out ${THRESHOLDS.holdoutsToRead} (segments marked synthetic do not count).`
    : `${head} The number of real recordings is already enough to hold out ${THRESHOLDS.holdoutsToRead} at the current ratio, so the small number of held-out recordings is not a question of how many real recordings there are.`;
}

function readMaterial(material) {
  if (!isPlainObject(material)) throw new TypeError('material must be an object { references, holdouts?, unused?, guidance?, direction? }');
  const { references, holdouts = [], unused = [] } = material;
  if (!Array.isArray(references)) throw new TypeError('references must be an array');
  if (!Array.isArray(holdouts)) throw new TypeError('holdouts must be an array');
  if (!Array.isArray(unused)) throw new TypeError('unused must be an array');
  for (const [index, entry] of references.entries()) {
    if (!isPlainObject(entry) || typeof entry.language !== 'string') throw new TypeError(`references[${index}] must be { id, language, … }`);
  }
  for (const [index, entry] of unused.entries()) {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string') throw new TypeError(`unused[${index}] must be { id, reason }`);
  }
  const cardLine = isPlainObject(material.cardLine) ? material.cardLine : null;
  const guidanceGaps = Array.isArray(material.guidanceGaps) ? material.guidanceGaps : [];
  return { references, holdouts, unused, guidance: material.guidance !== false, guidanceGaps, direction: material.direction !== false, designSource: material.designSource === true, noHoldout: material.noHoldout === true, cardLine };
}

const WRITER_ITEMS = Object.freeze({ 这个人是谁: ['身份', '性格', '在意什么', '对不同的人', '情绪上来时'], 换语言时怎么说: ['名字', '自称', '口头禅'] });
const ITEM_LINE = /^\s*-\s*([^：:]+?)\s*[：:]\s*(.*)$/u;
const GAP = /^(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\s+)?缺\s*(?:[（(].*)?$/u;

/** 配音指引里没填的项（文件头 guidanceGaps）。 */
export function guidanceGaps(guidance) {
  const gaps = [];
  for (const [section, items] of Object.entries(WRITER_ITEMS)) {
    const body = guidanceSection(guidance, section);
    if (body === undefined) continue;
    const values = new Map();
    for (const line of body.split(/\r?\n/u)) {
      const match = ITEM_LINE.exec(line);
      if (match !== null && items.includes(match[1]) && !values.has(match[1])) values.set(match[1], match[2].trim());
    }
    for (const item of items) {
      const value = values.get(item);
      if (value === undefined || value === '' || GAP.test(value)) { gaps.push(item); continue; }
      const languages = value.split(/[；;]/u).map((part) => GAP.exec(part.trim())?.[1]).filter((tag) => tag !== undefined);
      if (languages.length > 0) gaps.push(`${item}（${languages.join('、')}）`);
    }
  }
  return gaps;
}

/**
 * 对着一组素材，列出还缺什么。规则见文件头。
 * @param {object} material
 * @returns {{ code: string, message: string, details: object }[]}
 */
export function suggestMaterial(material) {
  const { references, holdouts, unused, guidance, guidanceGaps: gaps, direction, designSource, noHoldout, cardLine } = readMaterial(material);
  const hints = [];
  const add = (code, message, details = {}) => hints.push({ code, message, details });

  // 设计来源的包（没有真人录音）和调用方明说不留出录音的包不给这两条：留出录音数量少，或者本来就不留，不提醒（理由见文件头 designSource、noHoldout）
  if (!designSource && !noHoldout) {
    if (holdouts.length === 0) {
      add('no_holdout', 'No held-out recordings, so the fidelity cannot be measured: add more material (at least 3 usable segments) so that a few can be held out for measuring when the pack is made.', { references: references.length });
    } else if (holdouts.length < THRESHOLDS.holdoutsToRead) {
      const realNow = references.filter(isReal).length + holdouts.filter(isReal).length;
      const missing = realMissingFor(THRESHOLDS.holdoutsToRead, realNow);
      add('holdouts_few', fewHoldoutsMessage(holdouts.length, missing), { count: holdouts.length, needed: THRESHOLDS.holdoutsToRead, missing });
    }
  }
  // 设计来源的包参考段的三条都不给：设计出来的参考只有照试听配的那一段，没有录音可补；默认音色、融合出来的分不出来，一样不给（文件头 designSource）
  if (!designSource && references.length < THRESHOLDS.minReferences) {
    add('few_references', `Only ${references.length} reference ${references.length === 1 ? 'segment' : 'segments'}; at least ${THRESHOLDS.minReferences} recommended: the default segment is picked from the references, and the more segments there are, the better the most natural one can be found.`, { count: references.length, needed: THRESHOLDS.minReferences });
  }
  if (!designSource && references.length > 0 && references.every((entry) => typeof entry.durationSec === 'number')) {
    const seconds = Math.round(references.reduce((sum, entry) => sum + entry.durationSec, 0) * 10) / 10;
    if (seconds < THRESHOLDS.minReferenceSeconds) add('short_reference_total', `The references add up to only ${seconds} s; at least ${THRESHOLDS.minReferenceSeconds} s recommended.`, { seconds, needed: THRESHOLDS.minReferenceSeconds });
  }

  // 按规范化以后的语言分组，显示第一次出现的写法；这种语言的参考全是合成的，不提示去补（文件头 language_single_reference）
  const perLanguage = new Map(); // languageKey -> { language: 第一次出现的写法, entries }
  for (const entry of references) {
    const key = languageKey(entry.language);
    if (!perLanguage.has(key)) perLanguage.set(key, { language: entry.language, entries: [] });
    perLanguage.get(key).entries.push(entry);
  }
  for (const { language, entries } of designSource ? [] : perLanguage.values()) {
    if (entries.length === 1 && isReal(entries[0])) add('language_single_reference', `${language} has only one reference segment: lines in this language can only be dubbed after this one segment; add a few more.`, { language, count: 1 });
  }

  const byReason = new Map();
  for (const entry of unused) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry]);
  for (const [reason, entries] of byReason) {
    add(`unused_${reason}`, `${entries.length} ${entries.length === 1 ? 'segment' : 'segments'}: ${unusedAdvice(reason, entries)}.`, { count: entries.length, ids: entries.map((entry) => entry.id) });
  }

  if (!guidance) add('guidance_missing', 'No dubbing guidance: a pack must sound like the person not only in timbre but also in how they speak. Write a few lines on tone, rhythm, catchphrases and how the person speaks in different scenes (write only the effect you want, not the instruction syntax of any model); the agent follows them when dubbing. The sections 这个人是谁 (who this person is) and 换语言时怎么说 (what to say when the language changes) are required; for an item you have no basis for, write "缺" (references/make-pack.md「The five sections of the dubbing guidance」).');
  if (guidance && gaps.length > 0) add('guidance_gaps', `${gaps.length} dubbing guidance ${gaps.length === 1 ? 'item is' : 'items are'} not filled in (written "缺" or not written): ${gaps.join(', ')}. If the user is present, ask about these items and add the answers to the guidance (for a new pack made from an existing pack, hand the answers to the session that wrote the guidance, references/clean-room.md step 2), then issue a new version (--previous <pack directory of this version> --guidance <the completed guidance>); leave "缺" for what cannot be asked and do not invent it, and when handing over the pack tell the user which items are still missing (references/make-pack.md「The five sections of the dubbing guidance」).`, { items: gaps });
  if (!direction) add('direction_tags_missing', 'No voice tags: the pack cannot be found in the community by voice tag. Pick a few from the design vocabulary (gender, age, pitch, accent, timbre, speed, emotion).');
  if (cardLine !== null) hints.push(...cardLineHints(cardLine));
  return hints;
}

/** 试听句的几条（规则见文件头 card_line_*）。怎么写：references/character-voice.md「Audition line」。补上、重配都是发新版本：命令行 --previous <这一版> --card-line <台词文件>，库里是 previous 加 cardLine */
function cardLineHints(cardLine) {
  const hints = [];
  const add = (code, message, details = {}) => hints.push({ code, message, details });
  const REVOICE_WITH = '--previous <pack directory of this version> --card-line <line file> (in the library, call makePack with previous and cardLine)';
  const FILL_IN = `issue a new version to add it: ${REVOICE_WITH}`;
  if (cardLine.status === 'failed' && cardLine.halted === true) {
    add('card_line_halted', `The audition line was not synthesized (${cardLine.error?.code ?? 'reason unknown'}: ${cardLine.error?.message ?? ''}): the credential was rejected or the account is suspended; this is not a problem with this line. Deal with that first (log in again as explained above, or sort out the account) and do not retry; once that is done, ${FILL_IN}. The manifest does not have it, and the preview card carries the default segment.`, { code: cardLine.error?.code ?? null });
  } else if (cardLine.status === 'failed' && cardLine.error?.code === 'dub_cross_language' && Array.isArray(cardLine.error.details?.units) && cardLine.error.details.units.length > 0) {
    // 参考段不是这一句的语言（文件头 card_line_cross_language）：不是没配成，是默认不带口音、没配
    const [entry] = cardLine.error.details.units;
    const pair = languagePair(entry);
    // 包里有这种语言，还挑到了别的段：试听句不点名设定、不点名参考，是带 default 的设定引过去的（它的 referenceTag，或者它写的 labels.language）
    const other = entry.hasLanguage === true ? 'the pack does have a reference segment in this language, but the setup marked default led this line to this segment (the setup\'s default reference referenceTag has none in this language, or the language written in the setup, labels.language, is not this line\'s language): change the setup (--setups) and issue a new version, then hand in this line; or ' : '';
    add('card_line_cross_language', `The audition line was not synthesized: the reference segment picked for it, ${entry.segmentId}, is ${entry.from}, and this line is not (${pair}); dubbing it this way would carry the accent of ${entry.from}, so no call was made. The manifest does not have it, and the preview card carries the default segment. Do not ask the user: start this line with a name pair ([name in the reference language|name in the line's language], for example [Harry Potter|哈利·波特]; if the user wants the accent, write that accent in the square brackets and add --no-language-marks), add --allow-cross-language (in the library, makePack with options.allowCrossLanguage: true) and issue a new version to dub it again: ${REVOICE_WITH} --allow-cross-language. If the user wants to add a reference in this language themselves: ${other}add a reference in this language to the pack, hand it in as material, issue a new version with --previous <pack directory of this version>, and hand in --card-line <line file> at the same time. For the reference to be added: ${referenceSources(entry.from)}.`, { segmentId: entry.segmentId, from: entry.from, to: entry.to, ...(entry.script === undefined ? {} : { script: entry.script }), hasLanguage: entry.hasLanguage === true });
  } else if (cardLine.status === 'failed' && cardLine.error?.details?.unretrieved === true) {
    // 没取回（文件头 card_line_failed）：不是普通的没配成，再配一次会再计一次费
    const said = cardLine.error.details.retrieve;
    const retrieve = typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '(URL not printed)') : null;
    const how = retrieve ?? `the adapter does not say how to retrieve it (error code ${cardLine.error.code}); see the adapter's documentation`;
    add('card_line_failed', `The audition line was not retrieved (${cardLine.error.code}: ${cardLine.error.message ?? ''}): the synthesis side has finished and billed it, but the result was not retrieved, and this time nothing was called again or billed again. The manifest does not have it, and the preview card carries the default segment. If you do not want to dub it again, retrieve it by hand as the adapter says: ${how} (audio retrieved this way cannot yet be handed to make-pack to put into the pack); to put it into the pack, dub it again, which is charged again: ${FILL_IN}.`, { code: cardLine.error.code ?? null, unretrieved: true, retrieve });
  } else if (cardLine.status === 'failed') add('card_line_failed', `The audition line was not synthesized (${cardLine.error?.code ?? 'reason unknown'}: ${cardLine.error?.message ?? ''}); the manifest does not have it, and the preview card carries the default segment. ${FILL_IN}.`, { code: cardLine.error?.code ?? null });
  const reasons = Array.isArray(cardLine.reasons) ? cardLine.reasons : [];
  if (cardLine.status === 'carried' && reasons.length > 0) {
    // 沿用了，但和现在的配法有出入（lib/make-pack-card-line.mjs 的 carriedCardLine）：默认段换了多半是换了声音，要说清楚
    const what = reasons.map((reason) => CARD_LINE_REASON_WORDS[reason] ?? reason).join('; ');
    const voice = reasons.includes('default_segment_changed') ? ` The default segment changed, most likely because the voice changed: if it did, dub this line again with --card-line, ${REVOICE_WITH}.` : '';
    add('card_line_stale', `The audition line of the previous version was reused, but it no longer matches how it would be dubbed now (${what}): the preview card still carries the line dubbed in the previous version.${voice} To dub it the current way, hand in this line: ${REVOICE_WITH}.`, { reasons });
  }
  if ((cardLine.status === 'voiced' || cardLine.status === 'carried') && cardLine.onCard !== undefined && (cardLine.onCard === null || cardLine.onCard.trimmed === true)) {
    const REVOICE = `Write it shorter (how to write it: references/character-voice.md「Audition line」), then issue a new version and dub it again: ${REVOICE_WITH}`;
    const seconds = cardLine.onCard?.seconds ?? null;
    const where = cardLine.onCard === null ? 'does not fit on the preview card of the share file (too large, or this format cannot be cut), and the card carries the default segment' : `is longer than the preview card of the share file can hold, and the card carries only the first ${seconds === null ? 'part' : `${Number(seconds.toFixed(1))} s`}`;
    add('card_line_trimmed', `The recording of the audition line ${where}. ${REVOICE}.`, { seconds });
  } else if (cardLine.status === 'none') {
    add('card_line_missing', `No audition line was given, and the preview card carries the recording of the default segment of the main language (only as a fallback). Write an audition line from the character's profile and materials (references/character-voice.md「Audition line」), then ${FILL_IN}.`);
  }
  const change = cardLine.modelChange;
  if (cardLine.status === 'voiced' && isPlainObject(change)) {
    const model = typeof cardLine.model === 'string' ? cardLine.model : null;
    add('card_line_model_changed', `The adapter changed the model while dubbing the audition line: this line was dubbed with ${model ?? 'the substituted model'}, where ${change.from} was meant to be used (${change.reason}), so the voice and the acting may differ from the pack's voice. Once the original model is usable again, issue a new version and dub it again: ${REVOICE_WITH}.`, { model, from: change.from, reason: change.reason });
  }
  return hints;
}
