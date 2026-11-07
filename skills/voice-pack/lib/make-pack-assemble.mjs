// SPDX-License-Identifier: Apache-2.0
//
// 装包（流程层）：把挑好的素材和作者给的描述装成角色部分，用 protocol/lib/pack.mjs 的 packRolePart（它自带自检：清单合不合规、协议核心封没封印、基础部分对不对得上）。
// 包里的文件怎么摆（路径、外部资源只记网址）、packRolePart 的参数里和素材无关的那一半怎么拼，只在这里写一遍。
//
//   assertFitsFormat(env, items, plan, context, { maxReferences, reencoded, cardLine })   格式写明的两条上限（参考集的段数、包解开以后的总大小），在转写之前按估算核一遍，撞上就报，不等花完钱（规则在函数上面）
//   preflight(items, context, { cardLine })            试装（返回占位的包，lib/make-pack-card-line.mjs 拿它在花钱之前规划配卡片试听那一句）：用真实的输入和一段占位的参考走一遍 packRolePart，输入里不合清单规矩的地方（设计来源、脚本和增强件的登记、
//                                                      功能声明、没封印的协议核心、基础部分对不上……）在花钱之前就报，不等转写、试合成、盲听都做完了才在最后一步抛错。
//                                                      占位的参考只有一段，设定的 referenceTag 试装时拿掉（对不对得上由 lib/make-pack-tags.mjs 在试装之前查过）
//   placeMaterial({ chosen, byId, effective })         给挑好的每一段定在包里的路径，返回 { reference, holdout, files, externals }
//                                                      （参考段是 { id, audio, text, annotatedText?, language, tag, synthetic? }，tag 是 lib/make-pack-tags.mjs 的 assignTags 定的；
//                                                      留出录音是 { id, audio, text, language, synthetic? }，不带标签和提示标注）：
//                                                      files 是要放进包里的文件（含 effective.files：读音词表、脚本……）；externals 是外部资源 [{ path, url, data }]，
//                                                      包里只记网址、大小和哈希，字节不放进 files
//   assembler({ context, changelog, material, idRandom })   返回 assemble(extra)：把素材做成包。第二次（带上验证记录、卡片试听那一句、重写的变更说明）要沿用第一次的包 ID：
//                                                      assemble({ id, verification?, cardLine?, changelog? })
//   context 是 { effective, input, previous, versionNumber, changelog, textLanguage }：effective 是这次生效的描述（lib/pack-version.mjs 的 effectiveOf），
//   textLanguage 是 SKILL.md 骨架的语言（'zh' 或 'en'，makePack 的 options.textLanguage；试装和正式装都用它）。
//   发新版本沿用上一版的包 ID，上一版的段沿用原来的路径（item.path），新补的按 <角色>/<名字>.<扩展名>。卡片试听那一句的音频放在 card-line.<扩展名>（扩展名按音频的格式）。
//
// 抛出的错误：
//   make_pack_input_invalid  两段音频、或一段音频和 files 里的文件落在同一个路径（field 是 segments 或 files）
//   pack_invalid、manifest_invalid 来自 protocol/lib/pack.mjs，原样往上抛
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { packRolePart } from '../protocol/lib/pack.mjs';
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { validateManifest, MANIFEST_SCHEMA } from '../protocol/lib/manifest.mjs';
import { DEFAULT_LIMITS, totalSizeProblem } from '../protocol/lib/limits.mjs';
import { invalid } from './make-pack-input.mjs';
import { usableItems } from './make-pack-plan.mjs';

const FORMAT_EXTENSION = { wav: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', m4a: 'm4a' };
/** 卡片试听那一句的音频在包里的路径：按音频的格式（protocol/lib/audio.mjs 的 sniffAudio 认出来的）定扩展名。 */
const cardLinePath = (format) => `card-line.${FORMAT_EXTENSION[format]}`;

/** packRolePart 的参数里和素材无关的那一半（名字、版本、要求、描述、协议核心、SKILL.md 骨架的语言……）。试装和正式装用同一份，写法只此一处。 */
function roleInput({ effective, input, previous, versionNumber, changelog, textLanguage }) {
  return {
    name: effective.name,
    ...(previous !== null ? { id: previous.id } : input.shortName === undefined ? {} : { shortName: input.shortName }),
    ...(versionNumber === undefined ? {} : { version: versionNumber }),
    ...(changelog === undefined ? {} : { changelog }),
    ...(textLanguage === undefined ? {} : { textLanguage }), // SKILL.md 骨架的语言：作者的语言，调用方给的（options.textLanguage，readOptions 补全过）；不给是中文
    baseVersion: input.baseVersion,
    ...(effective.requires === undefined ? {} : { requires: effective.requires }),
    ...(effective.features === undefined ? {} : { features: effective.features }),
    ...(effective.direction === undefined ? {} : { direction: effective.direction }),
    ...(effective.sampleLines === undefined ? {} : { sampleLines: effective.sampleLines }),
    ...(effective.setups === undefined ? {} : { setups: effective.setups }),
    ...(effective.guidance === undefined ? {} : { guidance: effective.guidance }),
    ...(effective.designSource === undefined ? {} : { designSource: effective.designSource }),
    ...(effective.scripts === undefined ? {} : { scripts: effective.scripts }),
    ...(effective.enhancers === undefined ? {} : { enhancers: effective.enhancers }),
    protocolCore: input.protocolCore,
    ...(input.base === undefined ? {} : { base: input.base }),
  };
}

/**
 * 试装：用真实的输入和一段占位的参考走一遍 packRolePart（它自带自检），输入里不合清单规矩的地方（设计来源、脚本和增强件的登记、功能声明、
 * 没封印的协议核心、基础部分对不上……）在花钱之前就报，不等转写、试合成、盲听都做完了才在最后一步抛错。占位的包不用，也不写出去。
 * 占位的参考取第一段能用的片段；一段能用的都没有就不试（后面照样会报 make_pack_no_material）。
 * 占位的参考集只有一段，设定的 referenceTag 指的标签它没有：试装时拿掉 referenceTag（不然清单检查报 reference_tag_unknown），
 * 它对不对得上，在试装之前由 lib/make-pack-tags.mjs 的 assertReferenceTagsKnown 对着素材和上一版查过了。
 * 给了卡片试听那一句（cardLine，台词）：台词照真的写进占位的包（不合清单规矩的在这里报），音频先用占位的参考的字节。
 * @returns {Promise<{ id: string, manifest: object, files: Map<string, Uint8Array> } | null>} 占位的包（lib/make-pack-card-line.mjs 拿它在花钱之前规划配那一句）；没有能用的片段就是 null
 */
export async function preflight(items, context, { cardLine } = {}) {
  const stub = items.find((item) => item.unused === undefined);
  if (stub === undefined) return null;
  const path = `reference/${stub.id}.${FORMAT_EXTENSION[stub.format]}`;
  const setups = context.effective.setups?.map((setup) => (setup !== null && typeof setup === 'object' && !Array.isArray(setup) ? (({ referenceTag, ...rest }) => rest)(setup) : setup));
  const card = cardLine === undefined ? null : { audio: cardLinePath(stub.format), text: cardLine };
  return packRolePart({
    ...roleInput(context),
    ...(setups === undefined ? {} : { setups }),
    reference: { segments: [{ id: stub.id, audio: path, text: 'x', language: 'en', tag: 'x' }] },
    ...(card === null ? {} : { cardLine: card }),
    files: new Map([...context.effective.files, [path, stub.audio.bytes], ...(card === null ? [] : [[card.audio, stub.audio.bytes]])]),
    random: (length) => new Uint8Array(length), // 占位的包 ID，不动调用方注入的 idRandom
  });
}

/** 一段调响度存成 16 位 PCM 的 WAV 的头（RIFF、fmt、data）的字节数。 */
const WAV_HEADER_BYTES = 44;
/** 清单和 SKILL.md 的余量（字节）：清单是 JSON，格式给它的上限在 DEFAULT_LIMITS.maxJsonBytes；SKILL.md 的骨架和指引，另给 64 KiB。 */
const DOCUMENT_ROOM = DEFAULT_LIMITS.maxJsonBytes + 64 * 1024;
/**
 * 要配的卡片试听那一句，音频每个字最多占多少字节（往大的一边估）：台词每个字（按码点，提示也算）念 1 秒，存成 48 kHz、双声道、16 位 PCM 的 WAV。
 * 合成能力回的音频没有这么慢、这么大：一句 30 个字的台词约 5.8 MB，台词的上限 500 个字约 96 MB。
 */
const CARD_LINE_BYTES_PER_CHAR = 48000 * 2 * 2;
const sizeOf = (files) => [...(files ?? new Map()).values()].reduce((sum, bytes) => sum + bytes.length, 0);

/**
 * 做得下做不下（不花钱，在转写之前）：格式写明的两条上限，一条是参考集的段数，一条是包解开以后的总大小（protocol/FORMAT.md「解包上限」）。
 * 以前要到装包才报，那时转写、试合成都已经花完了；这里按切出的段数和估算的大小先核一遍，撞上就报格式那一条的原话（码和装包时一样：
 * 段数是 manifest_invalid，大小是 total_too_large），一个付费步骤都不走。两条数都出自格式本身（清单 schema、DEFAULT_LIMITS），这里不另写一份。
 * 估法：
 *   段数  能用的段（lib/make-pack-plan.mjs 的 usableItems）去掉最多能留出的留出录音（plan.holdouts），再和 maxReferences（没给就是不限）比小的一个。
 *         转写以后发现没有话的段、挑素材时不用的段会让实际更少：这里数的是多的一边。
 *   大小  每一段能用的、不是外部资源的（外部资源包里只记网址）：原字节数，和调响度存成 16 位 PCM 的 WAV 以后的大小（lib/make-pack-loudness.mjs：
 *         音质检查量出的时长 × 采样率 × 声道 × 2 字节，再加头）取大的；调响度关了（reencoded 为假）、或者量不出时长的（没有 ffmpeg 又不是 WAV 的）调响度不动它，就是原字节数。
 *         再加已知的固定部分（协议核心、基础部分、其他文件）、卡片试听那一句和清单、SKILL.md 的余量。估不准的地方都往大的一边估，所以报错的话里写明这是转写之前的估算。
 *         卡片试听那一句：这次要配的（cardLine 是它的台词），按 CARD_LINE_BYTES_PER_CHAR 估；没给、上一版有的（发新版本原样沿用，context.previous.cardLine），是它的字节数。
 * @returns {void} 撞上上限抛 VoicePackError
 */
export function assertFitsFormat(env, items, plan, context, { maxReferences, reencoded, cardLine }) {
  const usable = usableItems(env, items);
  const references = Math.min(usable.length - plan.holdouts, maxReferences ?? Number.POSITIVE_INFINITY);
  const limit = MANIFEST_SCHEMA.$defs.referenceSet.properties.segments.maxItems;
  if (references > limit) {
    // 清单检查自己的话：拿一份只有这么多段的草稿去过它，取说参考集段数的那一条
    const draft = { part: 'role', reference: { defaultSegment: 'x', segments: Array.from({ length: references }, () => ({})) } };
    const problem = validateManifest(draft, { schemaOnly: true }).problems.find((entry) => entry.details?.pointer === '/reference/segments' && entry.details?.keyword === 'maxItems');
    if (problem !== undefined) throw new VoicePackError(problem.code, `${problem.message}（转写之前按切出的段数估的：${usable.length} 段能用，最多留出 ${plan.holdouts} 条留出录音）`, { details: { ...problem.details, problems: [problem], estimated: true } });
  }
  const packed = usable.filter((item) => item.externalUrl === null);
  const audio = packed.reduce((sum, item) => {
    const metrics = item.quality?.metrics;
    const known = reencoded && typeof metrics?.durationSec === 'number' && typeof metrics?.sampleRate === 'number';
    const pcm16 = known ? Math.ceil(metrics.durationSec * metrics.sampleRate) * (metrics.channels ?? 1) * 2 + WAV_HEADER_BYTES : 0;
    return sum + Math.max(item.audio.bytes.length, pcm16);
  }, 0);
  const card = cardLine !== undefined ? [...cardLine].length * CARD_LINE_BYTES_PER_CHAR + WAV_HEADER_BYTES : context.previous?.cardLine?.bytes.length ?? 0;
  const total = audio + card + sizeOf(context.input.protocolCore) + sizeOf(context.input.base) + sizeOf(context.effective.files) + DOCUMENT_ROOM;
  if (total > DEFAULT_LIMITS.maxTotalBytes) {
    const problem = totalSizeProblem(total, DEFAULT_LIMITS);
    throw new VoicePackError(problem.code, `${problem.message}（转写之前估的：${packed.length} 段音频按存成 16 位 WAV 算约 ${audio} 字节，加上固定的部分${card > 0 ? `和卡片试听那一句（约 ${card} 字节）` : ''}；估不准的地方往大的一边估）`, { details: { ...problem.details, problems: [problem], estimated: true } });
  }
}

/** 给挑好的素材定路径：参考、留出录音放进 files（外部资源只记网址，字节留在 externals），再并上其他文件（effective.files）。 */
export function placeMaterial({ chosen, byId, effective }) {
  const files = new Map();
  const externals = [];
  const place = (item, role) => {
    const path = item.path ?? `${role}/${item.id}.${FORMAT_EXTENSION[item.format]}`; // 上一版的段沿用原来的路径
    if (files.has(path) || externals.some((entry) => entry.path === path)) throw invalid('segments', `${JSON.stringify(item.id)} 的音频文件 ${path} 和另一段的撞上了`);
    if (item.externalUrl === null) files.set(path, item.audio.bytes);
    else externals.push({ path, url: item.externalUrl, data: item.audio.bytes });
    // 提示标注、音色基底标签只写在参考段上（提示标注：素材给的、标出来的、上一版带来的；标签：lib/make-pack-tags.mjs 的 assignTags 定的）；留出录音只记语言
    const synthetic = item.synthetic === true ? { synthetic: true } : {};
    if (role === 'holdout') return { id: item.id, audio: path, text: item.text, language: item.language.value, ...synthetic };
    return { id: item.id, audio: path, text: item.text, ...(item.annotatedText === undefined ? {} : { annotatedText: item.annotatedText }), language: item.language.value, tag: item.tag.value, ...synthetic };
  };
  // 每种语言一段默认段：主语言的是 defaultSegment，别的语言的写进 languageDefaults（protocol/FORMAT.md 4.4；只有一种语言就不写这个键）
  const languageDefaults = (chosen.languageDefaults ?? []).map((entry) => entry.id);
  const reference = { defaultSegment: chosen.defaultSegment, ...(languageDefaults.length === 0 ? {} : { languageDefaults }), segments: chosen.references.map((id) => place(byId.get(id), 'reference')) };
  const holdout = chosen.holdouts.map((id) => place(byId.get(id), 'holdout'));
  for (const [path, data] of effective.files) {
    if (files.has(path) || externals.some((entry) => entry.path === path)) throw invalid('files', `${path} 和一段的音频文件撞上了`);
    files.set(path, data);
  }
  return { reference, holdout, files, externals };
}

/**
 * 把这些素材做成包。第二次（带上验证记录、卡片试听那一句）要沿用第一次的包 ID。发新版本沿用上一版的包 ID。
 * extra 是 { id?, verification?, changelog?, cardLine? }：cardLine 是 { text, bytes, format, seed? }（lib/make-pack-card-line.mjs 配出来的，或上一版沿用的；seed 是配它用的，环境收 seed 才有），
 * 音频放进包里的 card-line.<扩展名>，清单写 { audio, text, seed? }；别的原样交给 packRolePart。
 */
export function assembler({ context, changelog, material, idRandom }) {
  const { reference, holdout, files, externals } = material;
  return ({ cardLine, ...extra } = {}) =>
    packRolePart({
      ...roleInput({ ...context, changelog }), // 变更说明：作者写的，或者按这次的变化生成的（试装时还没算出来，用作者写的）
      reference,
      ...(holdout.length > 0 ? { holdout } : {}),
      ...(cardLine === undefined ? { files } : { files: new Map([...files, [cardLinePath(cardLine.format), cardLine.bytes]]), cardLine: { audio: cardLinePath(cardLine.format), text: cardLine.text, ...(cardLine.seed === undefined ? {} : { seed: cardLine.seed }) } }),
      ...(externals.length > 0 ? { externals } : {}),
      ...(idRandom === undefined ? {} : { random: idRandom }),
      ...extra,
    });
}
