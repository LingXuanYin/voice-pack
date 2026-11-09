// SPDX-License-Identifier: Apache-2.0
//
// 花钱准备段之前查输入（流程层）：交给 makePack 的段有的要先花钱准备（命令行的 --recording、--audition：分离人声、VAD 切段，cli/commands/make-pack.mjs），
// 只看输入就查得出的错，不该等这些钱花完了才在 makePack 里报。调用方在准备之前调它；makePack 照旧自己再查一遍，不调它也一样。
//
//   await precheckInput(env, input, options)
//     input    和交给 makePack 的一样（字段见 lib/make-pack.mjs 的文件头「输入」），只是 segments 是准备之前已经有的那些（可以是空数组：段还要切出来）
//     options  用到的是 textLanguage 和三项上限（maxChars、minChars、maxPauseInRequestMs），写法同 makePack 的；另有 upcoming：要切出来的段（makePack 不收这一项）
//                upcoming?  { idPrefixes?, sentences? }。idPrefixes 是要切出来的段的段名前缀（段名是「前缀-001」……，lib/long-recording.mjs 的 idPrefix），
//                           sentences 为真是其中有长录音要切成句子（句子不标 synthetic、没有 annotatedText，语言是 input.language）
//
// 查的是 makePack 在花钱之前只看输入就查得出的那几项，次序和报的错都一样（各项的规则在各自的模块里，这里不抄）。makePack 里它们分在两处（lib/make-pack.mjs 的 makePack）：
// 读输入、读上一版、定版本号在最前面；点名的默认段、设定的 referenceTag、试装、卡片那一句在取音频、筛片段、并句子之后，规划之前。这里不取音频、不筛片段，照这个次序查：
//   输入和选项的写法（lib/make-pack-input.mjs；点名的默认段可能是要切出来的段，这里不查它在不在；句子标得一不一样，连要切出来的句子一起查）、
//   读上一版（lib/pack-version.mjs）、--retag、--drop、版本号；
//   设定合成的开头的提示不能太长（lib/make-pack-input.mjs 的 checkSetupOpeningCues：给的超了报错，沿用上一版的不报）；
//   要切出来的段名（upcoming.idPrefixes）：两个前缀一样，或者已经有「前缀-数字」这样的段名（上一版的段，去掉的也算；已经交来的段），切出来就会重名，在这里报。
//     makePack 拿到的是切好的段，段名重了在读输入时报（同一个错，field 是 segments[3].id）；这里提前一步，免得分离、VAD 的钱白花。
//     命令行起前缀时已经避开了这些段名（cli/commands/make-pack.mjs 的 assignPrefixes），这里是最后一道；
//   点名的默认段（lib/make-pack-pick.mjs 的 assertDefaultsUsable）：已经交来的段里点名的，两段写着同一种语言、新补的点名的放不进参考上限，在这里就报；
//     点名的是要切出来的段（句子、试听切出的段），它们还不在，等 makePack 再查；
//   设定的 referenceTag（lib/make-pack-tags.mjs 的 assertReferenceTagsKnown）：切出来的段不带标签（lib/long-recording.mjs），所以对着素材给的和上一版的标签查就是准的；
//     这里还没筛片段，筛掉的段（解不开、重复的音频）上的标签照算，要到 makePack 筛完才报；
//   试装（lib/make-pack-assemble.mjs 的 preflight：清单的规矩），占位的参考是一小段静音（PLACEHOLDER）；
//   卡片试听那一句配不配得成一个请求（lib/make-pack-card-line.mjs 的 assertCardLineSpeakable：和参考是哪段无关）。
// makePack 在规划之前加了只看输入就查得出的检查，这里跟着加。不改 input，不调能力（读上一版的外部资源要 fetch）。
//
// 抛出的错误：和 makePack 在这几步报的一样，原样往上抛：make_pack_input_invalid（field 是 retag、defaultSegment、setups[0]、setups[0].referenceTag、cardLine、sampleLines[0]、segments[0].synthetic……；
//   要切出来的段名重了是 idPrefixes[0]，details.segment 是撞上的那个段名，两个前缀一样时没有它）、
//   make_pack_version_invalid、make_pack_previous_invalid（lib/pack-version.mjs）、manifest_invalid、pack_invalid（试装，protocol/lib/pack.mjs）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { encodeWav } from '../tools/wav.mjs';
import { readPreviousVersion, nextVersion, effectiveOf } from './pack-version.mjs';
import { assertInput, readInput, readOptions, materialOptionsOf, invalid, checkSetupOpeningCues } from './make-pack-input.mjs';
import { assertDefaultsUsable } from './make-pack-pick.mjs';
import { assertReferenceTagsKnown } from './make-pack-tags.mjs';
import { preflight } from './make-pack-assemble.mjs';
import { assertCardLineSpeakable } from './make-pack-card-line.mjs';

/** 试装用的占位参考：0.1 秒的静音 WAV（只为让试装走得通，不量、不写进包）。 */
const PLACEHOLDER = Object.freeze({ id: 'precheck', format: 'wav', audio: { bytes: encodeWav({ sampleRate: 16000, samples: [new Float32Array(1600)] }), mimeType: 'audio/wav' } });

/**
 * 要切出来的段名会不会重（规则见文件头「要切出来的段名」）。taken 是已经有的段名：上一版的（去掉的也算）和已经交来的。
 * @throws {VoicePackError} make_pack_input_invalid（field 是 idPrefixes[1]）
 */
function assertPrefixesFree(idPrefixes, taken) {
  idPrefixes.forEach((prefix, index) => {
    if (idPrefixes.indexOf(prefix) !== index) throw invalid(`idPrefixes[${index}]`, `前缀 ${JSON.stringify(prefix)} 给了两次：两段录音切出来的段名会重，换一个前缀`);
    const clash = [...taken].find((id) => id.startsWith(`${prefix}-`) && /^[0-9]+$/.test(id.slice(prefix.length + 1)));
    if (clash !== undefined) throw invalid(`idPrefixes[${index}]`, `要切出来的段名是 ${prefix}-001 这样的，已经有一段叫 ${JSON.stringify(clash)}，会重名：换一个前缀`, { segment: clash });
  });
}

/**
 * 花钱准备段之前查输入（规则见文件头）。一次能力都不调；查出问题抛的错和 makePack 一样。
 * @param {object} env 注入的运行环境（读上一版的外部资源用它的 fetch）
 * @param {object} input 和交给 makePack 的一样，segments 是准备之前已经有的段
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export async function precheckInput(env, input, options = {}) {
  assertInput(input);
  const settings = readOptions(options);
  const previous = input.previous === undefined ? null : await readPreviousVersion(env, input.previous);
  const upcoming = options.upcoming ?? {};
  const { items, version, direction, cardLine } = readInput(input, previous, { moreSegments: true, moreSentences: upcoming.sentences === true });
  assertPrefixesFree(upcoming.idPrefixes ?? [], new Set([...(previous?.segments ?? []).map((segment) => segment.id), ...items.filter((item) => item.previous === undefined).map((item) => item.id)]));
  const versionNumber = previous === null ? version.version : nextVersion(previous.version, { version: version.version, bump: version.bump });
  const effective = effectiveOf(input, direction, previous);
  checkSetupOpeningCues(effective.setups, { carried: previous !== null && input.setups === undefined });
  assertDefaultsUsable(items, version.defaultSegments, materialOptionsOf(settings));
  assertReferenceTagsKnown(items, effective.setups);
  const context = { effective, input, previous, versionNumber, changelog: version.changelog, textLanguage: settings.textLanguage };
  const stub = await preflight([PLACEHOLDER], context, { cardLine });
  if (cardLine !== undefined) await assertCardLineSpeakable(env, stub, cardLine, { maxChars: settings.maxChars, minChars: settings.minChars, maxPauseInRequestMs: settings.maxPauseInRequestMs });
}
