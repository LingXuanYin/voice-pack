// SPDX-License-Identifier: Apache-2.0
//
// 提示还缺什么素材（流程层，纯数据）：做包做完以后，对着做出来的参考集和留出录音，列出「再补什么素材会更好」。
// 建议覆盖平常说话、主要情绪、会说的几种语言、高低不同的能量。
// 每一条提示都是一条规则，输入是普通数据，不碰音频、不用模型、没有随机，所以每条都能拿数据直接测（lib/make-pack-report.mjs 调它，app 也可以）。
//
//   suggestMaterial(material) -> hints
//
// material：
//   references  参考集 [{ id, tags: { language, emotion?, style?, energy? }, durationSec? }]（durationSec 不知道就不给）
//   holdouts    留出录音 [{ id, tags }]，没有就是 []
//   unused      没用上的片段 [{ id, reason, details? }]，没有就是 []；reason 是做包报告里的那些原因（每一种写在产生它的那一步的文件头：lib/make-pack-screen.mjs、
//               lib/make-pack-transcribe.mjs、lib/make-pack-tags.mjs、lib/pack-material.mjs）
//   guidance    有没有写配音指引（布尔值，默认 true：不知道就不提示）
//   direction   音色标签有没有写（布尔值，默认 true）
//   designSource 素材是不是设计出来的（布尔值，默认 false）：清单里有 designSource 就是 true（lib/fidelity.mjs 文件头第 10 点）。
//               是的话不给 no_holdout、holdouts_few：设计出来的声音没有真人录音，再合成几句只是多一轮试合成，拖慢做包；不是的话照旧。
//   noHoldout   布尔值，默认 false：调用方不要留出录音（做包时 holdoutRatio 为 0，命令行 --no-holdout）。是的话也不给 no_holdout、holdouts_few：
//               不留出是调用方定的，再提醒「没有留出录音」没有用（理由和 designSource 一样）。
// 提示 hints：[{ code, message, details }]，次序固定（下面表里的次序，同一条规则里按取值的次序）。code 是机器读的，message 是给人看的中文，
// details 里是这条提示依据的数。没有可提示的就是空数组。提示只是建议，不挡任何事（不设门槛）。
//
// 规则（数值是起步值，没有拿真实的包标定过；改数值改 THRESHOLDS，别处不写数）：
//   no_holdout                  没有留出录音：还原度量不了。details: { references }。设计来源的包和 noHoldout 的包不给（见 designSource、noHoldout）
//   holdouts_few                留出录音有，但不到 5 条：读还原度要有效的留出录音至少 5 条才下结论（lib/fidelity.mjs 文件头「怎么读这份报告」第 1 点）。details: { count, needed }。设计来源的包和 noHoldout 的包不给
//   few_references              参考不到 3 段。details: { count, needed }
//   short_reference_total       参考加起来不到 30 秒（只在每段都有时长时判断）。details: { seconds, needed }
//   language_single_reference   某种语言的参考只有一段（例如「英语只有一段」）。每种这样的语言一条。details: { language, count: 1 }
//   emotion_untagged            参考里没有一段标了情绪：没法判断缺哪种情绪，按台词的情绪挑参考也挑不了。details: {}
//   emotion_missing             有标了情绪的参考时，主要情绪（calm、happy、sad、angry）里没有的，一种一条（例如「没有生气的参考」）。
//                               calm 是「平常说话」：既没有标 calm 的、也没有不带情绪标签的参考，才算缺。details: { emotion }
//   energy_missing              至少 3 段参考标了能量时，high、low 里没有的，一种一条（没有高能量、低能量的参考）。details: { energy }
//   unused_<原因>                没用上的片段，一种原因一条：补文本、重录、给语言……。details: { count, ids, ...原因里带的 }
//   guidance_missing            没有配音指引：包不只音色要像，说话方式也要像。details: {}
//   direction_tags_missing      没有音色标签：社区里按音色标签搜不到这个包。details: {}
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { REFERENCE_THRESHOLDS } from '../tools/audio-quality.mjs';

/** 建议的参考段长度（秒）：音质检查的提醒线（tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration），提示里说的长度就是它，不另写一份。 */
const { warnBelow: REFERENCE_MIN_SECONDS, warnAbove: REFERENCE_MAX_SECONDS } = REFERENCE_THRESHOLDS.duration;

export const THRESHOLDS = Object.freeze({
  /** 读还原度的读法要求的有效留出录音条数（lib/fidelity.mjs 文件头）。 */
  holdoutsToRead: 5,
  minReferences: 3,
  minReferenceSeconds: 30,
  /** 判断「缺高、低能量」至少要有几段参考标了能量。 */
  minEnergyTagged: 3,
});

/** 主要情绪（舞台提示词表 vocab/cues.json 里的规范名）和给人看的叫法。 */
export const MAIN_EMOTIONS = Object.freeze({ calm: '平静', happy: '开心', sad: '难过', angry: '生气' });
const ENERGY_NAME = Object.freeze({ low: '低', high: '高' });

/** 没用上的原因的说明：怎么补。没列的原因给一句通用的。 */
const UNUSED_ADVICE = Object.freeze({
  no_text: '没有文本，没用上：补上逐字文本，或者在环境里接上转写（automatic-speech-recognition）',
  quality_rejected: `音质不合格，没用上：重录一段更干净的（${REFERENCE_MIN_SECONDS}–${REFERENCE_MAX_SECONDS} 秒，不带伴奏、没有削波），或者换一段`,
  transcription_failed: '转写没成（服务暂时出错），没用上：稍后重做一次',
  language_unknown: '认不出是哪种语言，没用上：在素材里给 labels.language',
  duplicate_audio: '和别的片段是同一段音频，没用上：重复的不用补',
  audio_unrecognized: '认不出是哪种音频，没用上：转成 wav、mp3、flac、ogg 或 m4a',
  audio_undecodable: '解不开，没用上：音频文件可能坏了，或者环境缺 ffmpeg（解 wav 以外的格式要它）',
  over_limit: '参考集已经满了，多出来的没用上：不用补',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readMaterial(material) {
  if (!isPlainObject(material)) throw new TypeError('material 必须是对象 { references, holdouts?, unused?, guidance?, direction? }');
  const { references, holdouts = [], unused = [] } = material;
  if (!Array.isArray(references)) throw new TypeError('references 必须是数组');
  if (!Array.isArray(holdouts)) throw new TypeError('holdouts 必须是数组');
  if (!Array.isArray(unused)) throw new TypeError('unused 必须是数组');
  for (const [index, entry] of references.entries()) {
    if (!isPlainObject(entry) || !isPlainObject(entry.tags)) throw new TypeError(`references[${index}] 必须是 { id, tags }`);
  }
  for (const [index, entry] of unused.entries()) {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string') throw new TypeError(`unused[${index}] 必须是 { id, reason }`);
  }
  return { references, holdouts, unused, guidance: material.guidance !== false, direction: material.direction !== false, designSource: material.designSource === true, noHoldout: material.noHoldout === true };
}

/**
 * 对着一组素材，列出还缺什么。规则见文件头。
 * @param {object} material
 * @returns {{ code: string, message: string, details: object }[]}
 */
export function suggestMaterial(material) {
  const { references, holdouts, unused, guidance, direction, designSource, noHoldout } = readMaterial(material);
  const hints = [];
  const add = (code, message, details = {}) => hints.push({ code, message, details });

  // 设计来源的包（没有真人录音）和调用方明说不留出录音的包不给这两条：留出录音数量少，或者本来就不留，不提醒（理由见文件头 designSource、noHoldout）
  if (!designSource && !noHoldout) {
    if (holdouts.length === 0) {
      add('no_holdout', '没有留出录音，还原度量不了：再补一些素材（至少 3 段可用的），做包时才会留出几条来量。', { references: references.length });
    } else if (holdouts.length < THRESHOLDS.holdoutsToRead) {
      add('holdouts_few', `留出录音只有 ${holdouts.length} 条：读还原度要有效的留出录音至少 ${THRESHOLDS.holdoutsToRead} 条才下结论，再补一些素材。`, { count: holdouts.length, needed: THRESHOLDS.holdoutsToRead });
    }
  }
  if (references.length < THRESHOLDS.minReferences) {
    add('few_references', `参考只有 ${references.length} 段，建议至少 ${THRESHOLDS.minReferences} 段：参考越多，越能按台词挑到合适的那一段。`, { count: references.length, needed: THRESHOLDS.minReferences });
  }
  if (references.length > 0 && references.every((entry) => typeof entry.durationSec === 'number')) {
    const seconds = Math.round(references.reduce((sum, entry) => sum + entry.durationSec, 0) * 10) / 10;
    if (seconds < THRESHOLDS.minReferenceSeconds) add('short_reference_total', `参考加起来只有 ${seconds} 秒，建议至少 ${THRESHOLDS.minReferenceSeconds} 秒。`, { seconds, needed: THRESHOLDS.minReferenceSeconds });
  }

  const perLanguage = new Map();
  for (const entry of references) perLanguage.set(entry.tags.language, (perLanguage.get(entry.tags.language) ?? 0) + 1);
  for (const [language, count] of perLanguage) {
    if (count === 1) add('language_single_reference', `${language} 只有一段参考：这种语言的台词只能照这一段学，再补几段。`, { language, count });
  }

  const emotions = new Set(references.map((entry) => entry.tags.emotion).filter((emotion) => emotion !== undefined));
  if (references.length > 0 && emotions.size === 0) {
    add('emotion_untagged', '参考里没有一段标了情绪：没法判断缺哪种情绪，按台词的情绪挑参考也挑不了。让环境的 audio-text-to-text 听着打标签，或者在素材里自己给 labels.emotion。');
  } else if (emotions.size > 0) {
    const hasPlain = references.some((entry) => entry.tags.emotion === undefined);
    for (const [emotion, name] of Object.entries(MAIN_EMOTIONS)) {
      if (emotions.has(emotion) || (emotion === 'calm' && hasPlain)) continue;
      add('emotion_missing', emotion === 'calm' ? `没有平常说话（${emotion}）的参考。` : `没有${name}（${emotion}）的参考：这种情绪的台词会退回别的参考，补一段。`, { emotion });
    }
  }

  const energies = new Set(references.map((entry) => entry.tags.energy).filter((energy) => energy !== undefined));
  if (references.filter((entry) => entry.tags.energy !== undefined).length >= THRESHOLDS.minEnergyTagged) {
    for (const energy of ['high', 'low']) {
      if (!energies.has(energy)) add('energy_missing', `没有${ENERGY_NAME[energy]}能量的参考：说得更${energy === 'high' ? '激动、更响' : '轻、更柔'}的台词没有对应的参考，补一段。`, { energy });
    }
  }

  const byReason = new Map();
  for (const entry of unused) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry]);
  for (const [reason, entries] of byReason) {
    const codes = reason === 'quality_rejected' ? [...new Set(entries.flatMap((entry) => entry.details?.codes ?? []))].sort() : undefined;
    add(`unused_${reason}`, `${entries.length} 段${UNUSED_ADVICE[reason] ?? `没用上（${reason}）`}。`, { count: entries.length, ids: entries.map((entry) => entry.id), ...(codes === undefined ? {} : { codes }) });
  }

  if (!guidance) add('guidance_missing', '没有配音指引：包不只音色要像，说话方式也要像。写几句语气、节奏、口头禅、适合的场景（只写想要的效果，不写某个模型的指令语法），agent 配音时会照着做。');
  if (!direction) add('direction_tags_missing', '没有音色标签：社区里按音色标签搜不到这个包。从设计词表里选几个（性别、年龄、音高、口音、音色、语速、情绪）。');
  return hints;
}
