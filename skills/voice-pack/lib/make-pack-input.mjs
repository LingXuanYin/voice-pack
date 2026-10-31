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
//   readInput(input, previous)     input 的字段和片段列表，整理成 { items, version, direction }：
//                                    items      条目：上一版里没被去掉的段（先参考后留出录音）接着新补的
//                                    version    版本相关的字段（version、bump、changelog、drop、defaultSegment），没给的是 undefined（drop 是空数组）
//                                    direction  音色描述和标签换成规范写法以后的样子（lib/design-vocab.mjs），没给是 undefined
//                                  previous 是 lib/pack-version.mjs 的 readPreviousVersion 读出来的上一版（发新版本时），不是的话是 null
//   invalid(field, problem)        造一个 make_pack_input_invalid。别的步骤模块报输入的问题也用它，不各造一个
//
// 条目（item）：做包的每一步读、写的是同一组对象，每个步骤模块的文件头写自己读哪些字段、写哪些字段。这里整理出来的字段：
//   index（在输入里的次序，上一版带来的排在前面）、id、audio、text、labels（调用方给的标签：值是 undefined 没给，null 明确没有）、source、externalUrl；
//   上一版带过来的段还有 previous（'reference' 或 'holdout'）和 path（在上一版里的路径）。
//
// 抛出的错误：
//   make_pack_input_invalid  输入或选项不合约定。details: { field, problem }，field 是出问题的字段（segments[2].audio、labels.energy、loudness……），problem 说哪里不对
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { isSemver } from '../protocol/lib/version.mjs';
import { resolveTextLanguage } from '../protocol/lib/skill-md.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { loudnessOptions } from '../tools/loudness-normalize.mjs';
import { canonicalLabel } from './line-hints.mjs';
import { materialOptionProblems } from './pack-material.mjs';
import { normalizeDirection } from './design-vocab.mjs';
import { BUMPS, CHANGELOG_MAX } from './pack-version.mjs';
import { isLanguageTag, MAX_LANGUAGE_TAG } from './language-tag.mjs';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENERGIES = ['low', 'medium', 'high'];
const LABEL_KEYS = ['language', 'emotion', 'style', 'energy'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const invalid = (field, problem) => new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${field}）：${problem}`, { details: { field, problem } });

// ---------------------------------------------------------------- 读输入

/** 读一组标签（调用方给的）。值：undefined 没给，null 明确没有，字符串（能量只能是 low、medium、high）。 */
function readLabels(labels, where, { allowNullLanguage = false } = {}) {
  if (labels === undefined) return {};
  if (!isPlainObject(labels)) throw invalid(where, '必须是 { language?, emotion?, style?, energy? } 对象');
  const out = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_KEYS.includes(key)) throw invalid(`${where}.${key}`, `不认识的标签 ${JSON.stringify(key)}（只有 ${LABEL_KEYS.join('、')}）`);
    if (value === undefined) continue;
    if (value === null) {
      if (key === 'language' && !allowNullLanguage) throw invalid(`${where}.language`, 'language 不能是 null（每段参考都要有语言标签）');
      out[key] = null;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where}.${key}`, '必须是非空字符串（或 null，表示明确没有）');
    const text = value.trim();
    if (key === 'language' && !isLanguageTag(text)) throw invalid(`${where}.language`, `语言标签 ${JSON.stringify(text)} 写法不对：要像 en、zh-CN（最长 ${MAX_LANGUAGE_TAG} 个字符）`);
    if (key === 'energy' && !ENERGIES.includes(text)) throw invalid(`${where}.energy`, `energy 只能是 ${ENERGIES.join('、')}，收到 ${JSON.stringify(text)}`);
    if ((key === 'emotion' || key === 'style') && [...text].length > 64) throw invalid(`${where}.${key}`, '最长 64 个字符');
    out[key] = key === 'emotion' || key === 'style' ? canonicalLabel(key, text) : text;
  }
  return out;
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

/** 读片段列表，整理成内部的条目。 */
function readSegments(segments, defaults, { taken = new Set(), offset = 0, allowEmpty = false } = {}) {
  if (!Array.isArray(segments)) throw invalid('segments', '必须是数组：每一项是一段切好的录音');
  if (segments.length === 0 && !allowEmpty) throw invalid('segments', '至少要有一段');
  const seen = new Set(taken);
  return segments.map((segment, index) => {
    const where = `segments[${index}]`;
    if (!isPlainObject(segment)) throw invalid(where, '必须是对象 { id?, audio, text?, labels?, source? }');
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
    return {
      index: offset + index,
      id,
      audio: segment.audio,
      text: typeof segment.text === 'string' ? segment.text.trim() : '',
      labels: { ...defaults, ...readLabels(segment.labels, `${where}.labels`) },
      source: readSource(segment.source, `${where}.source`),
      externalUrl: segment.externalUrl ?? null,
    };
  });
}

/**
 * 读输入。previous 是 readPreviousVersion 读出来的上一版（发新版本时），不是的话是 null。
 * @returns {{ items: object[], version: object, direction: object | undefined }} items：上一版里没被去掉的段（先参考后留出录音）接着新补的；
 *   version：版本相关的字段（version、bump、changelog、drop、defaultSegment），没给的是 undefined（drop 是空数组）；
 *   direction：音色描述和标签换成规范写法以后的样子（没给是 undefined）
 */
export function readInput(input, previous) {
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
    // 音色标签只能从设计词表里取，场景只能从场景词表里取：写法换成规范的，不在词表里的在花钱之前就报
    const normalized = normalizeDirection(input.direction);
    if (normalized.problems.length > 0) {
      const [first] = normalized.problems;
      throw invalid(first.field === '' ? 'direction' : `direction.${first.field}`, `${first.message}${normalized.problems.length > 1 ? `（共 ${normalized.problems.length} 处：${normalized.problems.map((problem) => problem.field).join('、')}）` : ''}`);
    }
    direction = normalized.direction;
  }
  for (const key of ['scripts', 'enhancers']) if (input[key] !== undefined && !Array.isArray(input[key])) throw invalid(key, '必须是数组');
  if (input.sampleLines !== undefined && !Array.isArray(input.sampleLines)) throw invalid('sampleLines', '必须是字符串数组：每条是一句示例台词（条数、长度、能不能空白，清单检查在花钱之前就查）');
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
  if (input.defaultSegment !== undefined && (typeof input.defaultSegment !== 'string' || input.defaultSegment === '')) throw invalid('defaultSegment', '必须是参考集里一段的名字');

  const defaults = readLabels(input.labels, 'labels');
  const kept = hasPrevious ? previous.segments.filter((segment) => !drop.includes(segment.id)) : [];
  const previousItems = kept.map((segment, index) => ({
    index,
    id: segment.id,
    audio: segment.audio,
    text: segment.text,
    // 上一版的标签原样沿用：没有的项明说没有（null），不再判断
    labels: { language: segment.tags.language, emotion: segment.tags.emotion ?? null, style: segment.tags.style ?? null, energy: segment.tags.energy ?? null },
    source: null,
    externalUrl: segment.externalUrl,
    previous: segment.role,
    path: segment.path,
  }));
  const segments = input.segments === undefined && hasPrevious ? [] : input.segments;
  const fresh = readSegments(segments, defaults, { taken: previousIds, offset: previousItems.length, allowEmpty: hasPrevious });
  if (input.defaultSegment !== undefined) {
    const wanted = input.defaultSegment;
    const isPreviousReference = kept.some((segment) => segment.id === wanted && segment.role === 'reference');
    if (!isPreviousReference && !fresh.some((item) => item.id === wanted)) throw invalid('defaultSegment', `${JSON.stringify(wanted)} 不是参考集里的一段（上一版的参考，或者这次新补的；留出录音和去掉的不行）`);
  }
  return { items: [...previousItems, ...fresh], version: { version: input.version, bump: input.bump, changelog, drop, defaultSegment: input.defaultSegment }, direction };
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
  if (options.retryWait !== undefined && typeof options.retryWait !== 'function') throw invalid('retryWait', '必须是函数 (毫秒) => Promise，转写、打标签、试合成暂时出错、再试之前等多久');
  if (options.minChars !== undefined && options.minChars !== null && !(Number.isInteger(options.minChars) && options.minChars >= 1)) throw invalid('minChars', '必须是不小于 1 的整数（合成能力一次至少多少个字，环境声明的），或者不给');
  // loudness 换成补全的目标、上限和限幅器，或者 null（关掉）；textLanguage 换成 'zh' 或 'en'（没给就是 'zh'）
  return { ...options, loudness: readLoudness(options.loudness), textLanguage: readTextLanguage(options.textLanguage) };
}

/** input 必须是对象。makePack 最先查它：连 options 都还没读。 */
export function assertInput(input) {
  if (!isPlainObject(input)) throw invalid('input', '必须是对象');
}

/** 挑素材的选项里调用方给了的那几个（没给的不写，lib/pack-material.mjs 用自己的默认值）。 */
export const materialOptionsOf = (settings) => Object.fromEntries(['holdoutRatio', 'maxHoldout', 'maxReferences', 'minHoldoutTokens', 'maxSynthesisChars'].filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
