// SPDX-License-Identifier: Apache-2.0
//
// 报告（流程层）：makePack 的报告怎么写。报告每一项是什么意思，正本是 lib/make-pack.mjs 文件头的「返回」；这里是写出它的程序：
// 每一段的去向（reportSegment）、dryRun 的返回、最后的返回，写法只在这里写一遍。纯数据，不碰音频、不调能力。
//
//   dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes })   dryRun 的返回 { plan, report }：不做包，只列每一段有没有用上、数量、plan（lib/make-pack-plan.mjs）
//   resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes, loudnessNotes })
//                                          makePack 的返回 { pack, report, evaluation }。inputNotes 是 input.notes（前几步留下的说明），后面接着 loudnessNotes（调响度留下的）；
//                                          还缺什么素材（hints）也在这里算：lib/material-hints.mjs 的 suggestMaterial，纯数据
//
// 报告里每一段（reportSegment）：{ id, role, previous?, reason?, details?, hasText, textSource?, tags?, tagSources?, tagging?, quality?, loudness?, source? }，
// 字段都取自条目（lib/make-pack-input.mjs 说条目是什么，各步的文件头说它们各写了哪些字段）；role 是 reference、holdout、unused、candidate（dryRun：还没挑）或
// dropped（发新版本去掉的），dryRun 里上一版带来的段，role 就是它在上一版里的角色。
//
// 读条目的：id、previous、unused、text、textSource、tags、tagSources、tagging、quality、loudness、source；不写条目。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { suggestMaterial } from './material-hints.mjs';
import { hasWords } from './make-pack-transcribe.mjs';

function reportSegment(item, role) {
  return {
    id: item.id,
    role,
    ...(item.previous === undefined ? {} : { previous: item.previous }),
    ...(item.unused === undefined ? {} : { reason: item.unused.reason, ...(item.unused.details === undefined ? {} : { details: item.unused.details }) }),
    hasText: hasWords(item.text),
    ...(item.textSource === undefined ? {} : { textSource: item.textSource }),
    ...(item.tags === undefined ? {} : { tags: item.tags, tagSources: item.tagSources }),
    ...(item.tagging === undefined ? {} : { tagging: item.tagging }),
    ...(item.quality === undefined ? {} : { quality: item.quality }),
    ...(item.loudness === undefined ? {} : { loudness: item.loudness }),
    ...(item.source === null ? {} : { source: item.source }),
  };
}

/** dryRun 的返回：只做了不花钱的几步，没有包。 */
export function dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes }) {
  const versionOf = previous === null ? {} : { version: { previous: previous.version, next: versionNumber } };
  const segments = items.map((item) => reportSegment(item, item.previous ?? (item.unused === undefined ? 'candidate' : 'unused')));
  return { plan, report: { segments, counts: { input: fresh.length, candidates: fresh.filter((item) => item.unused === undefined).length, unused: plan.segments.unused }, ...versionOf, steps, notes: notes ?? [] } };
}

/** makePack 的返回：做出来的包、报告、量还原度用的那批数据。 */
export function resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes, loudnessNotes }) {
  const dropped = previous === null ? [] : previous.segments.filter((segment) => version.drop.includes(segment.id)).map((segment) => ({ id: segment.id, role: 'dropped', previous: segment.role }));
  const segments = [...items.map((item) => reportSegment(item, roleOf.get(item.id) ?? 'unused')), ...dropped];
  const hints = suggestMaterial({
    references: made.manifest.reference.segments.map((entry) => ({ id: entry.id, tags: entry.tags, durationSec: byId.get(entry.id).quality?.metrics?.durationSec })).map((entry) => (entry.durationSec === undefined || entry.durationSec === null ? { id: entry.id, tags: entry.tags } : entry)),
    holdouts: (made.manifest.holdout ?? []).map((entry) => ({ id: entry.id, tags: entry.tags })),
    unused: items.filter((item) => item.unused !== undefined).map((item) => ({ id: item.id, reason: item.unused.reason, details: item.unused.details })),
    guidance: effective.guidance !== undefined && effective.guidance.trim() !== '',
    direction: (made.manifest.direction?.tags ?? []).length > 0,
  });
  return {
    pack: { id: made.id, manifest: made.manifest, files: made.files },
    report: {
      segments,
      counts: {
        input: fresh.length,
        ...(previous === null ? {} : { carried: items.length - fresh.length, dropped: dropped.length }),
        references: chosen.references.length,
        holdouts: chosen.holdouts.length,
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
      plan,
      steps,
      trial: evaluated.trial,
      fidelity: evaluated.fidelity,
      ...(evaluated.redo === null ? {} : { redo: evaluated.redo }),
      verification,
      hints,
      notes: [...(inputNotes ?? []), ...loudnessNotes],
    },
    evaluation: evaluated.evaluation,
  };
}
