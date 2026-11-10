// SPDX-License-Identifier: Apache-2.0
//
// 报告（流程层）：makePack 的报告怎么写。报告每一项是什么意思，正本是 lib/make-pack.mjs 文件头的「返回」；这里是写出它的程序：
// 每一段的去向（reportSegment）、dryRun 的返回、最后的返回，写法只在这里写一遍。纯数据，不碰音频、不调能力。
//
//   dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes })   dryRun 的返回 { plan, report }：不做包，只列每一段有没有用上、数量、plan（lib/make-pack-plan.mjs）
//   resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes, loudnessNotes, noHoldout, cardLine })
//                                          makePack 的返回 { pack, report, evaluation }。inputNotes 是 input.notes（前几步留下的说明）接着发新版本留下的（lib/pack-version.mjs 的 versionNotes，例如 design_source_dropped），后面再接 loudnessNotes（调响度留下的）；
//                                          还缺什么素材（hints）也在这里算：lib/material-hints.mjs 的 suggestMaterial，纯数据。cardLine 是卡片试听那一句的结果（lib/make-pack-card-line.mjs 的文件头），
//                                          原样进 report.cardLine，写进包里的另带 audio（清单里的路径）
//
// 报告里每一段（reportSegment）：{ id, role, previous?, reason?, details?, hasText, textSource?, language?, languageSource?, tag?, tagSource?, renamedFrom?, annotation?, quality?, loudness?, source?, convertedFrom?, trim? }，
// （convertedFrom 是音频不是包能放的格式、做包取了音轨的段原来的 MIME 类型；trim 是素材写了起止秒、做包实际切的 { startSec, endSec }，条目上的 trimmed；两样都是 lib/make-pack-take-audio.mjs 写的）
// 字段都取自条目（lib/make-pack-input.mjs 说条目是什么，各步的文件头说它们各写了哪些字段）；role 是 reference、holdout、unused、candidate（dryRun：还没挑）或
// dropped（发新版本去掉的），dryRun 里上一版带来的段，role 就是它在上一版里的角色。annotation 是这一段标提示标注的结果（只有这一版新补的参考段有，写法见 lib/make-pack-annotation.mjs）。
// 语言和音色基底标签（规则和来源的取值在 lib/make-pack-tags.mjs 的文件头）：参考段写 { language, languageSource, tag, tagSource, renamedFrom? }（加了序号的 renamedFrom 是原名），
// 留出录音写 { language, languageSource }，没用上的段、dryRun 里还没挑的段都不写。字段名和清单同名，用这个库的 app 照这几个名字读，改名要当成不兼容的改动。
//
// 读条目的：id、previous、unused、text、textSource、language、tag、annotation、quality、loudness、source、convertedFrom、trimmed；不写条目。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { suggestMaterial } from './material-hints.mjs';
import { hasWords } from './make-pack-transcribe.mjs';

/** 一段的语言和音色基底标签（见文件头）：参考段四项（加了序号的再加 renamedFrom），留出录音只有语言，别的段没有。 */
function tagsOf(item, role) {
  if (role !== 'reference' && role !== 'holdout') return {};
  const language = { language: item.language.value, languageSource: item.language.source };
  if (role === 'holdout') return language;
  return { ...language, tag: item.tag.value, tagSource: item.tag.source, ...(item.tag.renamedFrom === undefined ? {} : { renamedFrom: item.tag.renamedFrom }) };
}

function reportSegment(item, role) {
  return {
    id: item.id,
    role,
    ...(item.previous === undefined ? {} : { previous: item.previous }),
    ...(item.synthetic === true ? { synthetic: true } : {}),
    ...(item.unused === undefined ? {} : { reason: item.unused.reason, ...(item.unused.details === undefined ? {} : { details: item.unused.details }) }),
    hasText: hasWords(item.text),
    ...(item.textSource === undefined ? {} : { textSource: item.textSource }),
    ...(item.scriptTextUnused === true ? { scriptTextUnused: true } : {}),
    ...tagsOf(item, role),
    ...(item.annotation === undefined ? {} : { annotation: item.annotation }),
    ...(item.quality === undefined ? {} : { quality: item.quality }),
    ...(item.loudness === undefined ? {} : { loudness: item.loudness }),
    ...(item.source === null ? {} : { source: item.source }),
    ...(item.convertedFrom === undefined ? {} : { convertedFrom: item.convertedFrom }),
    ...(item.trimmed === undefined ? {} : { trim: item.trimmed }),
  };
}

/** dryRun 的返回：只做了不花钱的几步，没有包。 */
export function dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes }) {
  const versionOf = previous === null ? {} : { version: { previous: previous.version, next: versionNumber } };
  // dryRun 还没挑参考集：每一段都不写语言和标签（上一版带来的段 role 是它在上一版里的角色，也不写：这一版的标签挑完才定）
  const segments = items.map((item) => ({ ...reportSegment(item, 'candidate'), role: item.previous ?? (item.unused === undefined ? 'candidate' : 'unused') }));
  return { plan, report: { segments, counts: { input: fresh.length, candidates: fresh.filter((item) => item.unused === undefined).length, unused: plan.segments.unused }, ...versionOf, steps, notes: notes ?? [] } };
}

/**
 * 报告里一段默认段：{ id, language, rule, ... }。能听音频的模型挑的，还有交给它的几段、它说的理由、问了几次和模型（listened 摊开）；问了模型没挑成的，还有 unpicked；
 * 挑最典型的那一段时，还有每段候选的平均相似度和差不多的几段；量相似度出了错、这一次退回按优先级的，还有 unmeasured：能力和错误的摘要（写法都在 lib/make-pack-pick.mjs 的文件头）。
 */
const defaultEntry = (entry) => ({
  id: entry.id,
  language: entry.language,
  rule: entry.rule,
  ...(entry.listened === undefined ? {} : entry.listened),
  ...(entry.unpicked === undefined ? {} : { unpicked: entry.unpicked }),
  ...(entry.typicality === undefined ? {} : { typicality: entry.typicality, tied: entry.tied }),
  ...(entry.unmeasured === undefined ? {} : { unmeasured: entry.unmeasured }),
});

/** makePack 的返回：做出来的包、报告、量还原度用的那批数据。 */
export function resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes, loudnessNotes, noHoldout = false, cardLine = { status: 'none' } }) {
  const dropped = previous === null ? [] : previous.segments.filter((segment) => version.drop.includes(segment.id)).map((segment) => ({ id: segment.id, role: 'dropped', previous: segment.role }));
  const segments = [...items.map((item) => reportSegment(item, roleOf.get(item.id) ?? 'unused')), ...dropped];
  const realCount = (ids) => ids.filter((id) => byId.get(id).synthetic !== true).length; // 真录音：不是合成的（克隆出来的不算）
  // 标了合成的（synthetic）段是克隆出来的，不算真录音（lib/material-hints.mjs 的 holdouts_few）
  const segmentEntry = (entry) => ({ id: entry.id, language: entry.language, ...(entry.tag === undefined ? {} : { tag: entry.tag }), ...(byId.get(entry.id).synthetic === true ? { synthetic: true } : {}) });
  const hints = suggestMaterial({
    references: made.manifest.reference.segments.map((entry) => {
      const durationSec = byId.get(entry.id).quality?.metrics?.durationSec;
      return durationSec === undefined || durationSec === null ? segmentEntry(entry) : { ...segmentEntry(entry), durationSec };
    }),
    holdouts: (made.manifest.holdout ?? []).map(segmentEntry),
    unused: items.filter((item) => item.unused !== undefined).map((item) => ({ id: item.id, reason: item.unused.reason, details: item.unused.details })),
    guidance: effective.guidance !== undefined && effective.guidance.trim() !== '',
    direction: (made.manifest.direction?.tags ?? []).length > 0,
    designSource: effective.designSource !== undefined,
    noHoldout,
    // 卡片试听那一句：没配成（凭据被拒、账户停了的另一条）、沿用了但和现在的配法有出入、卡片上会截短、没给、换了模型，各有一条（规则在 lib/material-hints.mjs）
    cardLine: {
      status: cardLine.status,
      ...Object.fromEntries(['error', 'halted', 'reasons', 'onCard', 'model', 'modelChange'].filter((key) => cardLine[key] !== undefined).map((key) => [key, cardLine[key]])),
    },
  });
  // 写进包里的（配成的、沿用的）带上它在包里的路径
  const cardLineReport = made.manifest.cardLine === undefined ? cardLine : { ...cardLine, audio: made.manifest.cardLine.audio };
  return {
    pack: { id: made.id, manifest: made.manifest, files: made.files },
    report: {
      segments,
      counts: {
        input: fresh.length,
        // input 数的是这一版新补的段：长录音的句子模式（--recording）是并好的段，不是句数（句子在转写之前就并成段了，lib/make-pack-sentences.mjs）。carried 数上一版带来的
        ...(previous === null ? {} : { carried: items.filter((item) => item.previous !== undefined).length, dropped: dropped.length }),
        references: chosen.references.length,
        holdouts: chosen.holdouts.length,
        realRecordings: realCount(chosen.references) + realCount(chosen.holdouts),
        unused: segments.filter((segment) => segment.role === 'unused').length,
      },
      ...(previous === null
        ? {}
        : {
            version: {
              previous: previous.version,
              next: made.manifest.version,
              bump: version.version === undefined ? (version.bump ?? 'minor') : null,
              changelogSource: version.changelog === undefined ? 'generated' : 'author',
              changes: (({ empty, ...shown }) => shown)(changes),
              // 验证记录不带过来：上一版的记录量的是上一版的参考集和指引。这一版量了就是新的一条
              verification: { status: verification === null ? 'not_remeasured' : 'remeasured', droppedFromPrevious: previous.manifest.verification?.length ?? 0 },
            },
          }),
      // 每种语言的默认段和挑它的规则（lib/pack-material.mjs 的规则 5）：主语言的是 defaultSegment，别的语言的是 languageDefaults（次序同清单）
      defaultSegment: defaultEntry({ id: chosen.defaultSegment, language: chosen.defaultLanguage, rule: chosen.defaultRule, listened: chosen.listened, unpicked: chosen.unpicked, typicality: chosen.typicality, tied: chosen.tied, unmeasured: chosen.unmeasured }),
      languageDefaults: (chosen.languageDefaults ?? []).map(defaultEntry),
      plan,
      steps,
      trial: evaluated.trial,
      fidelity: evaluated.fidelity,
      ...(evaluated.redo === null ? {} : { redo: evaluated.redo }),
      verification,
      cardLine: cardLineReport,
      hints,
      notes: [...(inputNotes ?? []), ...loudnessNotes],
    },
    evaluation: evaluated.evaluation,
  };
}
