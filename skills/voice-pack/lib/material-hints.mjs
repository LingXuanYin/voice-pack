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
//   direction   音色标签有没有写（布尔值，默认 true）
//   designSource 素材是不是设计出来的（布尔值，默认 false）：清单里有 designSource 就是 true（lib/fidelity.mjs 文件头第 10 点）。设计出来的声音、默认音色、
//               融合出来的声音做包都写设计来源（lib/make-pack.mjs 的 designSource），清单分不出是哪一种，这里三种一样对待。
//               是的话不给 no_holdout、holdouts_few：这几种声音都没有真人录音，再合成几句只是多一轮试合成，拖慢做包；
//               也不给参考段的三条（few_references、short_reference_total、language_single_reference）。这是照设计出来的声音定的：正式的包里参考只有照试听配的那一段
//               （references/make-pack.md「设计出来的声音怎么做包」第 3 步），没有录音可补，照提示去补只能拿这个包自己再克隆几段。
//               默认音色、融合出来的包（命令行 --audition）参考是试听切出来的，再生成几段试听就补得上，不用克隆这个包；可是看清单分不出它，也就不给这三条。
//               它的参考少、短，由做包的人看报告自己补（references/make-pack.md「还缺什么素材」）。要分开给，得在清单里记下是哪一种声音，那是格式的事。不是的话照旧。
//   noHoldout   布尔值，默认 false：调用方不要留出录音（做包时 holdoutRatio 为 0，命令行 --no-holdout）。是的话也不给 no_holdout、holdouts_few：
//               不留出是调用方定的，再提醒「没有留出录音」没有用（理由和 designSource 一样）。
//   cardLine    卡片试听那一句的情况 { status, error?, halted?, reasons?, onCard?, model?, modelChange? }，不给就不提示卡片那一句的几条（不知道）：status 是做包报告的 cardLine.status
//               （lib/make-pack-card-line.mjs 的文件头：voiced、carried、failed、none），error、halted、reasons、onCard、model、modelChange 照报告的
// 提示 hints：[{ code, message, details }]，次序固定（下面表里的次序，同一条规则里按取值的次序）。code 是机器读的，message 是给人看的中文，
// details 里是这条提示依据的数。没有可提示的就是空数组。提示只是建议，不挡任何事（不设门槛）。
//
// 规则（数值是起步值，没有拿真实的包标定过；改数值改 THRESHOLDS，别处不写数）。只能靠拿这个包自己再克隆才补得上的，不提示去补（设计出来的包的参考段，
// 某种语言的参考全是合成的）：克隆只会照搬这个包已有的声音和演法，补进来不比现在多什么。设计来源的包一律不给参考段的三条，默认音色、融合出来的也在内（见 designSource）。
//   no_holdout                  没有留出录音：还原度量不了。details: { references }。设计来源的包和 noHoldout 的包不给（见 designSource、noHoldout）
//   holdouts_few                留出录音有，但不到 5 条：读还原度要有效的留出录音至少 5 条才下结论（lib/fidelity.mjs 文件头「怎么读这份报告」第 1 点）。details: { count, needed, missing }：
//                               missing 是按规则 2（lib/pack-material.mjs 的 plannedHoldouts）还差几段真录音才留得出 needed 条（标了 synthetic 的不算，见下面的输入）。设计来源的包和 noHoldout 的包不给
//   few_references              参考不到 3 段：默认段从参考里挑，段太少就挑不出最自然的那一段。details: { count, needed }。设计来源的包不给
//   short_reference_total       参考加起来不到 30 秒（只在每段都有时长时判断）。details: { seconds, needed }。设计来源的包不给
//   language_single_reference   某种语言的参考只有一段（例如「英语只有一段」）。每种这样的语言一条。语言按规范化以后的写法分组（protocol/lib/manifest.mjs 的 languageKey：
//                               zh-CN 和 zh-cn 是一种），显示的是这种语言第一次出现的写法。details: { language, count: 1 }。
//                               设计来源的包不给；那一段标了 synthetic 的不给（补另一种语言那条路：用这个包跨语言配一段当参考，references/character-voice.md「补一段这种语言的参考」）
//   unused_<原因>                没用上的片段，一种原因一条：补文本、重录、给语言……。details: { count, ids, ...原因里带的 }。
//                               audio_unrecognized 的说法看段的 details（lib/make-pack-take-audio.mjs）：有段带 runtime（环境没有 ffmpeg）说装 ffmpeg；
//                               不然有段带 message（ffmpeg 也取不出音轨）说文件里可能没有声音、坏了；都没有（外部资源、别的格式）说先转成包能放的格式
//   guidance_missing            没有配音指引：包不只音色要像，说话方式也要像。details: {}
//   direction_tags_missing      没有音色标签：社区里按音色标签搜不到这个包。details: {}
//   card_line_failed            卡片试听那一句没配成：清单里没有它，卡片放默认段。说为什么，怎么补（发新版本，带上这一句）。details: { code }（没配成的错误码）。
//                               没取回的（错误标了 details.unretrieved：合成那头做完了、计过费，只是结果没取回来，vocab/capability-signatures.md「通用约定」）另外说：
//                               这一次没有再调、没有再计费；照适配器给的 details.retrieve 手动取回（网址不打印），取回来的音频现在还不能交给做包放进包里；照提示重配会再计一次费。
//                               这时 details 是 { code, unretrieved: true, retrieve }（retrieve 是适配器给的那句话，没给是 null）
//   card_line_cross_language    卡片试听那一句没配：给它挑的参考段不是这一句的语言，做包没给 allowCrossLanguage（cardLine 是 failed，error.code 是 dub_cross_language，lib/make-pack-card-line.mjs 的 voiceCardLine「跨语言」）。
//                               配了会带上参考那种语言的口音，所以一次都没调。说参考段和两边的语言（ja→en；认不出是哪种语言的写文字，ja→拉丁字母），给两条路，由使用者定：
//                               要口音，加 --allow-cross-language 发新版本重配；不要口音，给包补一段这种语言的参考发新版本，再交这一句。补的参考从哪来（lib/cross-language.mjs 的 referenceSources）：
//                               有这个角色说这种语言的录音就用录音；没有的，默认用这个包跨语言配一段这种语言的话当参考；或者使用者在库里挑的一个说这种语言的声音；
//                               平台能指定模型的，另列一项先用别的模型念一遍再克隆。
//                               包里其实有这种语言的（hasLanguage），另说是带 default 的设定引过去的，改设定。
//                               有它就没有 card_line_failed。details: { segmentId, from, to, script?, hasLanguage }（同配音的 dub_cross_language 里的一项，lib/dub.mjs 第 3a 步）
//   card_line_halted            卡片试听那一句没配成，是因为能力报凭据被拒（401）或账户停了（cardLine.halted，见 lib/make-pack-card-line.mjs）：不是这一句的问题，
//                               要使用者先处理（重新登录、处理账户），不要重试；处理好以后再发新版本补上。有它就没有 card_line_failed。details: { code }
//   card_line_stale             上一版的卡片试听那一句沿用了，但和现在的配法有出入（cardLine 是 carried，带 reasons，lib/make-pack-card-line.mjs 的 carriedCardLine）：
//                               卡片上放的还是上一版配的。说哪里对不上（CARD_LINE_REASON_WORDS）；默认段换了（default_segment_changed）多半是换了声音，写明换了声音就交 --card-line 重配；
//                               别的要按现在的配法重配，也是交 --card-line。details: { reasons }
//   card_line_trimmed           写进包里的卡片试听那一句（配成的、沿用的）比预览卡片能放的长：卡片上只放前面一截，或者放不下、改放默认段（onCard 是 null）。
//                               建议写短一点，发新版本重配。details: { seconds }（卡片上放的秒数；放不下，或者格式不解析时长，是 null）
//   card_line_missing           没给卡片试听那一句（cardLine.status 是 none）：设计出来的声音和用录音做的声音都提醒（卡片上该放用包自己的声音配的那一句）。
//                               卡片上兜底放的都是主语言默认段那段录音：设计出来的声音，交出去的包里默认段是照试听配的那一段，试听不在包里
//                               （references/make-pack.md「设计出来的声音怎么做包」），所以两种声音说的是同一句话。details: {}
//   card_line_model_changed     配卡片试听那一句时适配器换了模型（cardLine.modelChange，adapters/README.md「换了模型」）：写进包里的这一句是换上的模型配的，
//                               声音和演法可能和包的声音不一样；原来的模型能用了，发新版本重配。details: { model, from, reason }（model 是换上的，能力没报是 null）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { DEFAULTS, plannedHoldouts } from './pack-material.mjs';
import { languagePair, referenceSources } from './cross-language.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';

export const THRESHOLDS = Object.freeze({
  /** 读还原度的读法要求的有效留出录音条数（lib/fidelity.mjs 文件头）。 */
  holdoutsToRead: 5,
  minReferences: 3,
  minReferenceSeconds: 30,
});

/** 没用上的原因的说明：怎么补。没列的原因给一句通用的。 */
const UNUSED_ADVICE = Object.freeze({
  no_text: '没有文本，没用上：补上逐字文本，或者在环境里接上转写（automatic-speech-recognition）',
  transcription_failed: '转写没成（服务暂时出错），没用上：稍后重做一次',
  transcription_blocked: '转写被服务商拦下了（内容过滤），没用上：补上逐字文本，或者换一个转写',
  language_unknown: '认不出是哪种语言，没用上：在素材里给 language',
  duplicate_audio: '和别的片段是同一段音频，没用上：重复的不用补',
  audio_unrecognized: '认不出是哪种音频，没用上：转成 wav、mp3、flac、ogg 或 m4a',
  audio_undecodable: '解不开，没用上：音频文件可能坏了，或者环境缺 ffmpeg（解 wav 以外的格式要它）',
  over_limit: '参考集已经满了，多出来的没用上：不用补',
  trim_out_of_range: '素材写的起点超出了录音，切不出东西，没用上：照录音的长度改起止秒',
});

/** audio_unrecognized 另两种说法（规则见文件头 unused_<原因>）：环境没有 ffmpeg；有 ffmpeg 也取不出音轨。 */
const AUDIO_TRACK_ADVICE = Object.freeze({
  runtime: '认不出是哪种音频，也取不出音轨，没用上：带视频轨的文件和别的格式要环境有 ffmpeg 取音轨，装上它，或者先转成 wav、mp3、flac、ogg 或 m4a',
  message: '取不出音轨，没用上：这个文件里可能没有声音，或者坏了；换一个带声音的文件，或者先转成 wav、mp3、flac、ogg 或 m4a',
});

/** 一种原因的说法：audio_unrecognized 看段的 details，别的查 UNUSED_ADVICE，没列的给一句通用的。 */
function unusedAdvice(reason, entries) {
  if (reason === 'audio_unrecognized') {
    if (entries.some((entry) => entry.details?.runtime !== undefined)) return AUDIO_TRACK_ADVICE.runtime;
    if (entries.some((entry) => typeof entry.details?.message === 'string')) return AUDIO_TRACK_ADVICE.message;
  }
  return UNUSED_ADVICE[reason] ?? `没用上（${reason}）`;
}

/** 卡片试听那一句沿用时和现在的配法对不上的原因（lib/make-pack-card-line.mjs 的 carriedCardLine 的 reasons），给人看的说法。命令行的报告也用它。 */
export const CARD_LINE_REASON_WORDS = Object.freeze({
  reference_changed: '配它的参考换了',
  request_text_changed: '交给模型的文字变了（读音词表、开头补的提示）',
  speed_changed: '语速变了',
  not_one_request: '现在配不成一个请求，没法比',
  default_segment_changed: '默认段换了',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 真录音：没有标 synthetic 的段（克隆出来的不算，规则 2 只数真录音，见 lib/pack-material.mjs）。 */
const isReal = (entry) => entry.synthetic !== true;

/**
 * 按规则 2（lib/pack-material.mjs 的 plannedHoldouts，用它的默认比例和上限）：留出 wanted 条要几段真录音；现在有 realNow 段，还差几段。
 * 从现在的段数往上数，数到 plannedHoldouts 够 wanted 为止。比例是 0，或者 wanted 超过上限，就永远够不着：直接报错，不往下数。
 */
function realMissingFor(wanted, realNow) {
  if (DEFAULTS.holdoutRatio === 0 || wanted > DEFAULTS.maxHoldout) throw new RangeError(`留出 ${wanted} 条够不着（holdoutRatio ${DEFAULTS.holdoutRatio}，maxHoldout ${DEFAULTS.maxHoldout}）`);
  let total = realNow;
  while (plannedHoldouts(total) < wanted) total += 1;
  return total - realNow;
}

/** holdouts_few 的文字：按现在的比例还差几段真录音。已经够了（差 0 段），留出的少就不是真录音数量的问题。 */
function fewHoldoutsMessage(count, missing) {
  const head = `留出录音只有 ${count} 条：读还原度要有效的留出录音至少 ${THRESHOLDS.holdoutsToRead} 条才下结论。`;
  return missing > 0
    ? `${head}按现在的比例，还差 ${missing} 段真录音才留得出 ${THRESHOLDS.holdoutsToRead} 条（标了合成的不算）。`
    : `${head}真录音的数量已经够按现在的比例留出 ${THRESHOLDS.holdoutsToRead} 条，留出的少不是真录音数量的问题。`;
}

function readMaterial(material) {
  if (!isPlainObject(material)) throw new TypeError('material 必须是对象 { references, holdouts?, unused?, guidance?, direction? }');
  const { references, holdouts = [], unused = [] } = material;
  if (!Array.isArray(references)) throw new TypeError('references 必须是数组');
  if (!Array.isArray(holdouts)) throw new TypeError('holdouts 必须是数组');
  if (!Array.isArray(unused)) throw new TypeError('unused 必须是数组');
  for (const [index, entry] of references.entries()) {
    if (!isPlainObject(entry) || typeof entry.language !== 'string') throw new TypeError(`references[${index}] 必须是 { id, language, … }`);
  }
  for (const [index, entry] of unused.entries()) {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string') throw new TypeError(`unused[${index}] 必须是 { id, reason }`);
  }
  const cardLine = isPlainObject(material.cardLine) ? material.cardLine : null;
  return { references, holdouts, unused, guidance: material.guidance !== false, direction: material.direction !== false, designSource: material.designSource === true, noHoldout: material.noHoldout === true, cardLine };
}

/**
 * 对着一组素材，列出还缺什么。规则见文件头。
 * @param {object} material
 * @returns {{ code: string, message: string, details: object }[]}
 */
export function suggestMaterial(material) {
  const { references, holdouts, unused, guidance, direction, designSource, noHoldout, cardLine } = readMaterial(material);
  const hints = [];
  const add = (code, message, details = {}) => hints.push({ code, message, details });

  // 设计来源的包（没有真人录音）和调用方明说不留出录音的包不给这两条：留出录音数量少，或者本来就不留，不提醒（理由见文件头 designSource、noHoldout）
  if (!designSource && !noHoldout) {
    if (holdouts.length === 0) {
      add('no_holdout', '没有留出录音，还原度量不了：再补一些素材（至少 3 段可用的），做包时才会留出几条来量。', { references: references.length });
    } else if (holdouts.length < THRESHOLDS.holdoutsToRead) {
      const realNow = references.filter(isReal).length + holdouts.filter(isReal).length;
      const missing = realMissingFor(THRESHOLDS.holdoutsToRead, realNow);
      add('holdouts_few', fewHoldoutsMessage(holdouts.length, missing), { count: holdouts.length, needed: THRESHOLDS.holdoutsToRead, missing });
    }
  }
  // 设计来源的包参考段的三条都不给：设计出来的参考只有照试听配的那一段，没有录音可补；默认音色、融合出来的分不出来，一样不给（文件头 designSource）
  if (!designSource && references.length < THRESHOLDS.minReferences) {
    add('few_references', `参考只有 ${references.length} 段，建议至少 ${THRESHOLDS.minReferences} 段：默认段从参考里挑，段越多，越挑得出最自然的那一段。`, { count: references.length, needed: THRESHOLDS.minReferences });
  }
  if (!designSource && references.length > 0 && references.every((entry) => typeof entry.durationSec === 'number')) {
    const seconds = Math.round(references.reduce((sum, entry) => sum + entry.durationSec, 0) * 10) / 10;
    if (seconds < THRESHOLDS.minReferenceSeconds) add('short_reference_total', `参考加起来只有 ${seconds} 秒，建议至少 ${THRESHOLDS.minReferenceSeconds} 秒。`, { seconds, needed: THRESHOLDS.minReferenceSeconds });
  }

  // 按规范化以后的语言分组，显示第一次出现的写法；这种语言的参考全是合成的，不提示去补（文件头 language_single_reference）
  const perLanguage = new Map(); // languageKey -> { language: 第一次出现的写法, entries }
  for (const entry of references) {
    const key = languageKey(entry.language);
    if (!perLanguage.has(key)) perLanguage.set(key, { language: entry.language, entries: [] });
    perLanguage.get(key).entries.push(entry);
  }
  for (const { language, entries } of designSource ? [] : perLanguage.values()) {
    if (entries.length === 1 && isReal(entries[0])) add('language_single_reference', `${language} 只有一段参考：这种语言的台词只能照这一段学，再补几段。`, { language, count: 1 });
  }

  const byReason = new Map();
  for (const entry of unused) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry]);
  for (const [reason, entries] of byReason) {
    add(`unused_${reason}`, `${entries.length} 段${unusedAdvice(reason, entries)}。`, { count: entries.length, ids: entries.map((entry) => entry.id) });
  }

  if (!guidance) add('guidance_missing', '没有配音指引：包不只音色要像，说话方式也要像。写几句语气、节奏、口头禅、到了不同的场景怎么说（只写想要的效果，不写某个模型的指令语法），agent 配音时会照着做。');
  if (!direction) add('direction_tags_missing', '没有音色标签：社区里按音色标签搜不到这个包。从设计词表里选几个（性别、年龄、音高、口音、音色、语速、情绪）。');
  if (cardLine !== null) hints.push(...cardLineHints(cardLine));
  return hints;
}

/** 卡片试听那一句的几条（规则见文件头 card_line_*）。怎么写：references/character-voice.md「卡片试听」。补上、重配都是发新版本：命令行 --previous <这一版> --card-line <台词文件>，库里是 previous 加 cardLine */
function cardLineHints(cardLine) {
  const hints = [];
  const add = (code, message, details = {}) => hints.push({ code, message, details });
  const REVOICE_WITH = '--previous <这一版的包目录> --card-line <台词文件>（库里调 makePack 是 previous 加 cardLine）';
  const FILL_IN = `发新版本补上：${REVOICE_WITH}`;
  if (cardLine.status === 'failed' && cardLine.halted === true) {
    add('card_line_halted', `卡片试听那一句没配成（${cardLine.error?.code ?? '原因不明'}：${cardLine.error?.message ?? ''}）：凭证被拒，或者账户停了，不是这一句的问题。先处理（照上面的说明重新登录，或者处理账户），不要重试；处理好以后再${FILL_IN}。清单里没有它，卡片上放的是默认段。`, { code: cardLine.error?.code ?? null });
  } else if (cardLine.status === 'failed' && cardLine.error?.code === 'dub_cross_language' && Array.isArray(cardLine.error.details?.units) && cardLine.error.details.units.length > 0) {
    // 参考段不是这一句的语言（文件头 card_line_cross_language）：不是没配成，是默认不带口音、没配
    const [entry] = cardLine.error.details.units;
    const pair = languagePair(entry);
    // 包里有这种语言，还挑到了别的段：卡片那一句不点名设定、不点名参考，是带 default 的设定引过去的（它的 referenceTag，或者它写的 labels.language）
    const other = entry.hasLanguage === true ? '包里其实有这种语言的参考段，只是带 default 的设定把这一句引到了这一段（设定的默认参考 referenceTag 在这种语言里没有，或者设定写的语言 labels.language 不是这一句的语言）：改设定（--setups）发新版本，再交这一句；或者' : '';
    add('card_line_cross_language', `卡片试听那一句没配：给它挑的参考段 ${entry.segmentId} 是 ${entry.from}，这一句不是（${pair}），照这样配会带上 ${entry.from} 的口音，所以一次都没调。清单里没有它，卡片上放的是默认段。两条路，由使用者定（问他要不要口音，没说要就当不要）。要口音：加 --allow-cross-language（库里调 makePack 是 options.allowCrossLanguage: true）发新版本重配，${REVOICE_WITH} --allow-cross-language。不要口音：${other}给包补一段这种语言的参考，当素材交，--previous <这一版的包目录> 发新版本，同时交 --card-line <台词文件>。补的${referenceSources(entry.from)}。`, { segmentId: entry.segmentId, from: entry.from, to: entry.to, ...(entry.script === undefined ? {} : { script: entry.script }), hasLanguage: entry.hasLanguage === true });
  } else if (cardLine.status === 'failed' && cardLine.error?.details?.unretrieved === true) {
    // 没取回（文件头 card_line_failed）：不是普通的没配成，再配一次会再计一次费
    const said = cardLine.error.details.retrieve;
    const retrieve = typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '（网址不打印）') : null;
    const how = retrieve ?? `适配器没说怎么取回（错误码 ${cardLine.error.code}），看适配器的说明`;
    add('card_line_failed', `卡片试听那一句没取回（${cardLine.error.code}：${cardLine.error.message ?? ''}）：合成那头已经做完、计过费，只是结果没取回来，这一次没有再调、没有再计费。清单里没有它，卡片上放的是默认段。不想重配，照适配器说的手动取回：${how}（取回来的音频现在还不能交给做包放进包里）；要放进包里就重配，会再计一次费：${FILL_IN}。`, { code: cardLine.error.code ?? null, unretrieved: true, retrieve });
  } else if (cardLine.status === 'failed') add('card_line_failed', `卡片试听那一句没配成（${cardLine.error?.code ?? '原因不明'}：${cardLine.error?.message ?? ''}），清单里没有它，卡片上放的是默认段。${FILL_IN}。`, { code: cardLine.error?.code ?? null });
  const reasons = Array.isArray(cardLine.reasons) ? cardLine.reasons : [];
  if (cardLine.status === 'carried' && reasons.length > 0) {
    // 沿用了，但和现在的配法有出入（lib/make-pack-card-line.mjs 的 carriedCardLine）：默认段换了多半是换了声音，要说清楚
    const what = reasons.map((reason) => CARD_LINE_REASON_WORDS[reason] ?? reason).join('、');
    const voice = reasons.includes('default_segment_changed') ? `默认段换了，多半是换了声音：换了声音就用 --card-line 重配这一句，${REVOICE_WITH}。` : '';
    add('card_line_stale', `沿用了上一版的卡片试听那一句，但和现在的配法有出入（${what}）：卡片上放的还是上一版配的那一句。${voice}要按现在的配法重配，就交这一句：${REVOICE_WITH}。`, { reasons });
  }
  if ((cardLine.status === 'voiced' || cardLine.status === 'carried') && cardLine.onCard !== undefined && (cardLine.onCard === null || cardLine.onCard.trimmed === true)) {
    const REVOICE = `写短一点（写法见 references/character-voice.md「卡片试听」），发新版本重配：${REVOICE_WITH}`;
    const seconds = cardLine.onCard?.seconds ?? null;
    const where = cardLine.onCard === null ? '分享文件的预览卡片放不下它（太大，或者这种格式截不了），卡片上放的是默认段' : `比分享文件的预览卡片能放的长，卡片上只放前 ${seconds === null ? '一截' : `${Number(seconds.toFixed(1))} 秒`}`;
    add('card_line_trimmed', `卡片试听那一句的录音${where}。${REVOICE}。`, { seconds });
  } else if (cardLine.status === 'none') {
    add('card_line_missing', `没给卡片试听那一句，卡片上放的是主语言默认段那段录音（只是兜底）。照这个角色的设定和角色卡写一句卡片试听（references/character-voice.md「卡片试听」），${FILL_IN}。`);
  }
  const change = cardLine.modelChange;
  if (cardLine.status === 'voiced' && isPlainObject(change)) {
    const model = typeof cardLine.model === 'string' ? cardLine.model : null;
    add('card_line_model_changed', `配卡片试听那一句时适配器换了模型：这一句是 ${model ?? '换上的模型'} 配的，原来要用 ${change.from}（${change.reason}），声音和演法可能和包的声音不一样。原来的模型能用了，发新版本重配：${REVOICE_WITH}。`, { model, from: change.from, reason: change.reason });
  }
  return hints;
}
