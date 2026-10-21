// SPDX-License-Identifier: Apache-2.0
//
// 按台词挑参考（流程层）：每句话从参考集里挑情绪、风格、语言最匹配的那一段当参考。
// agent 环境里配音（lib/dub.mjs）和 app 调的是同一个函数。
//
// 输入输出都是普通数据：不碰 DOM、不碰文件系统，也不读音频（只看清单里参考段的标签）。要的能力只有一项，而且是可选的：
//   @capability text-generation  让它判断台词的情绪、风格（签名在 vocab/capability-signatures.md）。环境没有就不判断，不是错误
//
// 每句话要什么标签，分成两件事：
//   「怎么说」的标签（情绪 emotion、风格 style、能量 energy），按这个顺序看，前面有了就不再往后看：
//     1 调用方给的标签（line.labels）
//     2 台本标记里的提示（line.hints；没给就从 line.text 里读舞台提示，括号里的语气说明，例如（耳语）、*笑*，读法见 lib/line-hints.mjs）
//       读 line.text 时，括号里不是整个都认得的内容（词表里没有的，或者有词表里的词可是还有别的字）算不算要念的话，
//       由第四个参数 options.unrecognized 定，原样交给 readDirections：
//       不给是 'keep'（留在要念的话里，参与认语种和送去判断），配音给 'remove'（拿掉）。规则只在 lib/line-hints.mjs 的文件头写；line.hints 给了就不读 text，选项不起作用
//     3 环境有 text-generation：让它判断（一次调用判完所有还没有标签的台词，只能从参考集里有的标签里选）。这是一次收费的调用：
//       只规划、不花钱的调用方（lib/dub.mjs 的 planDub，命令行的 dub --dry-run）传选项 judge: false，不调，judge 里写明正式运行要判几句（见下）
//     4 都没有：默认参考
//   语言 language 不走这个顺序：调用方给了就用调用方的，没给就从文字本身认（lib/line-hints.mjs 的 detectLanguages）。
//     拉丁字母认不出是英语还是法语，给的是一组候选，所以只在参考集里恰好有一种拉丁字母语言时才起作用。
//   所以没有任何「怎么说」的标签时，语言仍然参与挑选：同一种语言里挑，其中有默认段就用默认段，没有就取这种语言里的第一段；
//   连语言也看不出来，才是纯粹的默认参考段。
//
// 怎么比：把每一段参考和要的标签逐项比，按这个次序比大小，前一项分出高低就不看后一项：
//   语言（完全一致 > 主语言一致 > 不一致） > 情绪 > 风格 > 能量 > 是不是默认段 > 在参考集里的次序
// 语言排在最前面：用另一种语言的参考克隆，音色和读音都会变差，比情绪对不上严重。没有要求的项不参与比较。
// 情绪、风格按规范化以后的写法比：大小写、全半角不论；舞台提示和标签里常见的近义词（angry、生气、愤怒……）认作同一个（vocab/cues.json）。
// 默认只用一段参考：每句话的结果里只有一个 segmentId，从不融合。留出录音从不当参考：只看 reference.segments；
// 清单里留出录音和参考共用 id 或音频文件，直接报错，不悄悄挑一个。
//
// 返回 { picks, judge }：
//   picks[i]  { index, segmentId, rule, wanted, sources, matched, missed, directions }
//     rule      「怎么说」的标签是谁给的：'caller-labels' | 'markup-hints' | 'text-generation' | 'default'（没有人给）
//     wanted    最终要的标签 { language, script, emotion, style, energy }，没有要求的项是 null；
//               language 是调用方给的写法；从文字里认的，是这种文字可能的语言里参考集有的那几个（可能是空数组），不列整串（拉丁字母有四十多种语言）；
//               script 是从文字里认出的文字系统（Latin、Han、Japanese……），语言是调用方给的就是 null；emotion、style 是规范化以后的名字
//     sources   每一项标签从哪来：'caller' | 'text'（从文字本身认的语言）| 'markup' | 'text-generation' | null
//     matched   要了、而且挑中的这一段也有的项（例如 ['language', 'emotion']）
//     missed    要了、但挑中的这一段没有的项：参考集里没有哪一段有它（例如生气的台词，参考集里没有生气的参考：['emotion']）
//     directions  台词里读到的舞台提示（选了 'remove' 时，认不出意思的也列着，recognized 为 false；默认的 'keep' 只列整个括号都认得的，和结构规则认出的「副词 + 地」，后者 recognized 为 false）
//   judge     text-generation 这一步的情况：{ status: 'not_needed' | 'unavailable' | 'used' | 'unusable' | 'planned', ... }。
//             planned 是选项 judge 给了 false、本来要判断的：{ status: 'planned', capability: 'text-generation', lines: 要判几句 }，一次都没有调；
//             这几句现在落到默认参考，正式运行（judge 不给，默认 true）时挑的参考可能不一样
//
// 选项 options（第四个参数，都可选）：unrecognized，原样交给 readDirections（见下）；judge，布尔值，默认 true：false 就不调 text-generation。写错（键拼错、值不对）抛 pick_input_invalid
//
// 抛出的错误（code 小写下划线，details 里放什么在抛出处写明）：
//   pick_input_invalid   输入不是约定的形状，或者清单自相矛盾。details.field 是出问题的字段（options 的写法不对时是 options）
// 环境本身不合格抛 environment_invalid；text-generation 自己抛的错原样往上传（不吞，401 之类要让调用方看见）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { canonicalLabel, detectLanguages, primaryLanguage, readDirectionOptions, readDirections } from './line-hints.mjs';
import { badResult } from './capability-calls.mjs';

const ENERGIES = ['low', 'medium', 'high'];
const LABEL_KEYS = ['language', 'emotion', 'style', 'energy'];
const MOOD_KEYS = ['emotion', 'style', 'energy'];
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalid = (field, message) => new VoicePackError('pick_input_invalid', message, { details: { field } });

/** 语言标签规范化：兼容分解、转小写、下划线当连字符。 */
const languageKey = (tag) => String(tag).normalize('NFKC').toLowerCase().trim().replace(/_/g, '-');

// ---------------------------------------------------------------- 输入检查

function readReferenceSet(manifest) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.reference)) throw invalid('reference', '要给参考集：清单里的 reference（defaultSegment 和 segments）');
  const { defaultSegment, segments } = manifest.reference;
  if (!Array.isArray(segments) || segments.length === 0) throw invalid('reference.segments', '参考集至少要有一段参考');
  segments.forEach((segment, index) => {
    if (!isPlainObject(segment) || typeof segment.id !== 'string' || !isPlainObject(segment.tags)) {
      throw invalid(`reference.segments[${index}]`, `参考段 ${index} 要有 id 和 tags`);
    }
  });
  if (!segments.some((segment) => segment.id === defaultSegment)) {
    throw invalid('reference.defaultSegment', `默认参考段 ${JSON.stringify(defaultSegment)} 不是参考集里的一段`);
  }
  const holdout = manifest.holdout ?? [];
  if (!Array.isArray(holdout)) throw invalid('holdout', 'holdout 必须是数组');
  const taken = new Set(segments.flatMap((segment) => [`id:${segment.id}`, ...(typeof segment.audio === 'string' ? [`audio:${segment.audio}`] : [])]));
  for (const [index, recording] of holdout.entries()) {
    if (taken.has(`id:${recording?.id}`) || (typeof recording?.audio === 'string' && taken.has(`audio:${recording.audio}`))) {
      throw invalid('holdout', `留出录音 holdout[${index}]（${recording?.id}）和参考集共用 id 或音频文件：留出录音从不当参考，清单自相矛盾`);
    }
  }
  // 每一段参考的标签，先规范化好：比较时不用再算
  const candidates = segments.map((segment, order) => ({
    id: segment.id,
    order,
    isDefault: segment.id === defaultSegment,
    language: typeof segment.tags.language === 'string' ? { key: languageKey(segment.tags.language), primary: primaryLanguage(segment.tags.language) } : null,
    emotion: typeof segment.tags.emotion === 'string' ? canonicalLabel('emotion', segment.tags.emotion) : null,
    style: typeof segment.tags.style === 'string' ? canonicalLabel('style', segment.tags.style) : null,
    energy: typeof segment.tags.energy === 'string' ? segment.tags.energy : null,
  }));
  return { defaultSegment, candidates, segments };
}

function readLabels(raw, at) {
  const labels = {};
  if (raw === undefined) return labels;
  if (!isPlainObject(raw)) throw invalid(at, `${at} 必须是对象：{ language?, emotion?, style?, energy? }`);
  for (const key of LABEL_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw invalid(`${at}.${key}`, `${at}.${key} 必须是字符串`);
    if (key === 'energy' && !ENERGIES.includes(value)) throw invalid(`${at}.energy`, `${at}.energy 必须是 ${ENERGIES.join('、')} 之一`);
    labels[key] = value;
  }
  return labels;
}

function readLines(lines) {
  if (!Array.isArray(lines)) throw invalid('lines', 'lines 必须是数组：每一句台词一个 { text, labels? }');
  return lines.map((line, index) => {
    const at = `lines[${index}]`;
    if (!isPlainObject(line)) throw invalid(at, `${at} 必须是一个对象`);
    if (line.text !== undefined && typeof line.text !== 'string') throw invalid(`${at}.text`, `${at}.text 必须是字符串`);
    if (line.directions !== undefined && !Array.isArray(line.directions)) throw invalid(`${at}.directions`, `${at}.directions 必须是数组`);
    return {
      text: line.text ?? '',
      labels: readLabels(line.labels, `${at}.labels`),
      hints: line.hints === undefined ? undefined : readLabels(line.hints, `${at}.hints`),
      directions: line.directions,
    };
  });
}

const OPTION_KEYS = ['unrecognized', 'judge'];

/**
 * 选项：judge（是否调 text-generation，默认是），其余原样交给读舞台提示的选项（lib/line-hints.mjs 的 readDirections 的第二个参数）。
 * 现在就检查，不等到某句台词用上它；写错了不悄悄当成默认值。
 * @returns {{ judge: boolean, directions: { unrecognized: 'keep'|'remove' } }}
 */
function readOptions(options) {
  let judge = true;
  let rest = options;
  if (isPlainObject(options)) {
    const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
    if (unknown !== undefined) throw invalid('options', `options 不合约定：不认识的选项 ${JSON.stringify(unknown)}：只有 ${OPTION_KEYS.join('、')}`);
    if (Object.hasOwn(options, 'judge')) {
      ({ judge, ...rest } = options);
      if (typeof judge !== 'boolean') throw invalid('options', `options 不合约定：judge 必须是 true 或 false，收到 ${JSON.stringify(judge)}`);
    }
  }
  try {
    return { judge, directions: readDirectionOptions(rest) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw invalid('options', `options 不合约定：${error.message}`);
  }
}

// ---------------------------------------------------------------- 比较

/** 语言的比较：2 完全一致，1 主语言一致，0 不一致（或者这一段没写语言）。wanted 是 { key, primaries }。 */
function languageScore(wanted, candidate) {
  if (candidate.language === null) return 0;
  if (wanted.key !== null && wanted.key === candidate.language.key) return 2;
  return wanted.primaries.includes(candidate.language.primary) ? 1 : 0;
}

/** 这一段在某个「怎么说」的项上对不对得上要求。 */
const moodHit = (candidate, wanted, key) => candidate[key] !== null && candidate[key] === wanted[key];

/** 比较用的键，逐项比大小。 */
function compareKey(candidate, wanted) {
  const key = [];
  if (wanted.language !== null) key.push(languageScore(wanted.language, candidate));
  for (const mood of MOOD_KEYS) if (wanted[mood] !== null) key.push(moodHit(candidate, wanted, mood) ? 1 : 0);
  key.push(candidate.isDefault ? 1 : 0, -candidate.order);
  return key;
}

function isBetter(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function choose(candidates, wanted) {
  let best = null;
  for (const candidate of candidates) {
    const key = compareKey(candidate, wanted);
    if (best === null || isBetter(key, best.key)) best = { candidate, key };
  }
  return best.candidate;
}

/** 挑中的这一段在每个要了的项上有没有对上。没对上，是因为参考集里没有哪一段对得上（挑的时候已经尽力了）。 */
function explain(candidate, wanted) {
  const matched = [];
  const missed = [];
  if (wanted.language !== null) (languageScore(wanted.language, candidate) > 0 ? matched : missed).push('language');
  for (const mood of MOOD_KEYS) if (wanted[mood] !== null) (moodHit(candidate, wanted, mood) ? matched : missed).push(mood);
  return { matched, missed };
}

// ---------------------------------------------------------------- 一句台词要什么标签

/** 这句台词真正要念的话：拿掉舞台提示以后的文字（配音流程切开以后交过来的 text 已经是拿掉的）。认不出的括号内容算不算要念的话，看选项 unrecognized。 */
const spokenOf = (line, directionOptions) => (line.hints !== undefined ? line.text : readDirections(line.text, directionOptions).pieces.map((piece) => piece.text).join(' '));

/** 台词里读到的第一个有情绪或风格的舞台提示。 */
function firstMood(directions) {
  const found = directions.find((direction) => direction.emotion !== null || direction.style !== null);
  return found === undefined ? {} : { ...(found.emotion === null ? {} : { emotion: found.emotion }), ...(found.style === null ? {} : { style: found.style }) };
}

/**
 * 一句台词要的标签：「怎么说」的三项按 调用方 -> 台本标记 的顺序看（text-generation 的判断由调用的地方补），语言单独认。
 * @returns {{ wanted: object, sources: object, rule: string, directions: object[], needsJudge: boolean }}
 */
function wantedFor(line, directionOptions) {
  const read = line.hints === undefined && line.directions === undefined ? readDirections(line.text, directionOptions) : null;
  const directions = line.directions ?? read?.directions ?? [];
  const wanted = { language: null, emotion: null, style: null, energy: null };
  const sources = { language: null, emotion: null, style: null, energy: null };

  let rule = 'default';
  const callerMood = MOOD_KEYS.filter((key) => line.labels[key] !== undefined);
  const markupMood = line.hints !== undefined ? line.hints : firstMood(directions);
  if (callerMood.length > 0) {
    rule = 'caller-labels';
    for (const key of callerMood) {
      wanted[key] = key === 'energy' ? line.labels.energy : canonicalLabel(key, line.labels[key]);
      sources[key] = 'caller';
    }
  } else if (Object.keys(markupMood).some((key) => markupMood[key] !== undefined)) {
    rule = 'markup-hints';
    for (const key of MOOD_KEYS) {
      if (markupMood[key] === undefined) continue;
      wanted[key] = key === 'energy' ? markupMood.energy : canonicalLabel(key, markupMood[key]);
      sources[key] = 'markup';
    }
  }

  if (line.labels.language !== undefined) {
    wanted.language = { key: languageKey(line.labels.language), primaries: [primaryLanguage(line.labels.language)], shown: line.labels.language };
    sources.language = 'caller';
  } else {
    // 认语种时括号里的提示不算：不然中文台词里一个英文提示，整句会被认成英文（认不出的括号内容选了「保留」，它是要念的话，就算）
    const detected = detectLanguages(read === null ? spokenOf(line, directionOptions) : read.pieces.map((piece) => piece.text).join(' '));
    if (detected !== null) {
      wanted.language = { key: null, primaries: detected.languages.map(primaryLanguage), shown: detected.languages, script: detected.script };
      sources.language = 'text';
    }
  }
  return { wanted, sources, rule, directions, needsJudge: rule === 'default' };
}

// ---------------------------------------------------------------- 让 text-generation 判断

const JUDGE_LINE_MAX = 500; // 送去判断的每句台词最多这么多个字，免得一整章塞进一次请求

/** 参考集里「怎么说」的每一项有哪些取值（按标签原来的写法，去重）；有没有可选的：至少有一项在不同的参考段之间取值不同。 */
function labelChoices(candidates, segments) {
  const choices = { emotion: [], style: [], energy: [] };
  let varies = false;
  for (const mood of MOOD_KEYS) {
    const seen = new Set();
    for (const [index, candidate] of candidates.entries()) {
      seen.add(candidate[mood]);
      const raw = segments[index].tags[mood];
      if (typeof raw === 'string' && !choices[mood].some((item) => item.canonical === candidate[mood])) choices[mood].push({ raw, canonical: candidate[mood] });
    }
    if (seen.size >= 2) varies = true;
  }
  return { choices, varies };
}

function buildJudgePrompt(choices, items) {
  const shown = (mood) => (choices[mood].length > 0 ? choices[mood].map((item) => item.raw).join(', ') : '（没有）');
  return [
    '你是配音导演。下面是一个声音的参考录音上有的标签，和要配音的台词。请为每句台词判断该用哪种参考：emotion（情绪）、style（风格）、energy（能量）各选一个。只能从给出的取值里选；判断不了、或者没有特别的要求，就填 null。',
    'You are a dubbing director. Below are the labels the reference recordings of one voice carry, and the lines to be dubbed. For each line choose emotion, style and energy, using only the values listed; use null when you cannot tell or there is nothing special.',
    '',
    '参考集里有的标签 / Labels in the reference set:',
    `- emotion: ${shown('emotion')}`,
    `- style: ${shown('style')}`,
    `- energy: ${shown('energy')}`,
    '',
    '台词 / Lines:',
    ...items.map((item) => `[${item.index}] ${JSON.stringify(item.text.length > JUDGE_LINE_MAX ? `${item.text.slice(0, JUDGE_LINE_MAX)}…` : item.text)}`),
    '',
    '只输出一个 JSON 数组，不要别的文字。每句台词一个对象，index 是台词前面方括号里的数字。Output only a JSON array, one object per line; index is the number in square brackets:',
    '[{"index": 0, "emotion": null, "style": null, "energy": null}]',
  ].join('\n');
}

/** 读判断的回答：整段是 JSON 数组，或者包在一个代码块里，或者夹在别的话中间。读不出来给 null。 */
function parseJudgeReply(text) {
  const candidates = [text.trim()];
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  if (fenced !== null) candidates.push(fenced[1].trim());
  const from = text.indexOf('[');
  const to = text.lastIndexOf(']');
  if (from !== -1 && to > from) candidates.push(text.slice(from, to + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {
      // 换下一种读法
    }
  }
  return null;
}

/**
 * 还没有「怎么说」的标签的台词，一次调用让 text-generation 判断。就地改 plans（判出来的标签、来源、理由），返回 judge 的情况。
 * allowCall 是 false 就一次都不调（那是一次收费的调用）：要判断、环境也有这项能力的，返回 planned 和要判几句。
 * 不采纳的回答（编号对不上、取值不在参考集里……）不猜，如实记在 ignored 里。
 */
async function runJudge(env, set, input, plans, directionOptions, allowCall) {
  const pending = plans.flatMap((plan, index) => {
    if (!plan.needsJudge) return [];
    const text = spokenOf(input[index], directionOptions).trim();
    return text === '' ? [] : [{ index, text }];
  });
  if (pending.length === 0) return { status: 'not_needed' };
  const { choices, varies } = labelChoices(set.candidates, set.segments);
  if (!varies) return { status: 'not_needed' };
  if (!hasCapability(env, 'text-generation')) return { status: 'unavailable', capability: 'text-generation' };
  if (!allowCall) return { status: 'planned', capability: 'text-generation', lines: pending.length };

  const reply = await requireCapability(env, 'text-generation')({ prompt: buildJudgePrompt(choices, pending) });
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('text-generation', 'text_missing', '要 { text: 字符串 }');
  const model = typeof reply.model === 'string' ? reply.model : undefined;
  const entries = parseJudgeReply(reply.text);
  if (entries === null) return { status: 'unusable', reason: '回答不是一个 JSON 数组，不猜', capability: 'text-generation', ...(model === undefined ? {} : { model }), lines: pending.length };

  const asked = new Set(pending.map((item) => item.index));
  const answered = new Set();
  const ignored = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || !Number.isInteger(entry.index)) {
      ignored.push({ reason: '不是 { index, … } 对象' });
      continue;
    }
    if (!asked.has(entry.index) || answered.has(entry.index)) {
      ignored.push({ index: entry.index, reason: asked.has(entry.index) ? '同一句台词答了不止一次，只采纳第一次' : '台词的编号对不上' });
      continue;
    }
    answered.add(entry.index);
    const plan = plans[entry.index];
    for (const mood of MOOD_KEYS) {
      const value = entry[mood];
      if (value === undefined || value === null || value === '') continue;
      const canonical = typeof value === 'string' ? (mood === 'energy' ? value : canonicalLabel(mood, value)) : null;
      if (canonical === null || !choices[mood].some((item) => item.canonical === canonical)) {
        ignored.push({ index: entry.index, field: mood, value, reason: '取值不在参考集里' });
        continue;
      }
      plan.wanted[mood] = canonical;
      plan.sources[mood] = 'text-generation';
      plan.rule = 'text-generation';
    }
  }
  return { status: 'used', capability: 'text-generation', ...(model === undefined ? {} : { model }), lines: pending.length, ignored };
}

// ---------------------------------------------------------------- 公开接口

/**
 * 报告里的 wanted.language。调用方给的原样给；从文字里认出的，只列「这种文字可能是哪些语言」里参考集有的那几个：
 * 拉丁字母可能是四十多种语言，整串放进每一句的报告里没有用，只会让报告胀大。一个都没有就是空数组（语言没匹配上，也会写在 missed 里）；
 * 认出的文字系统另外写在 wanted.script。
 */
function shownLanguage(language, candidates) {
  if (language === null || language.script === undefined) return language === null ? null : language.shown;
  const inReferenceSet = new Set(candidates.filter((candidate) => candidate.language !== null).map((candidate) => candidate.language.primary));
  return language.shown.filter((name) => inReferenceSet.has(primaryLanguage(name)));
}

/**
 * 给每一句台词挑一段参考。规则和比较的办法见文件头。
 * @param {object} env 注入的运行环境（只在要让 text-generation 判断时用到）
 * @param {object} manifest 角色部分的清单，或者至少带着 reference（和 holdout）的对象
 * @param {{ text?: string, labels?: { language?: string, emotion?: string, style?: string, energy?: 'low'|'medium'|'high' }, hints?: { emotion?: string, style?: string }, directions?: object[] }[]} lines
 *   台词。labels 是调用方给的标签；hints 是切开台词以后每一段生效的提示（配音流程给；不给就从 text 里读舞台提示）；directions 只是原样放进结果
 * @param {{ unrecognized?: 'keep'|'remove', judge?: boolean }} [options] unrecognized：括号里不是整个都认得的内容（词表里没有的，或者有词表里的词可是还有别的字）怎么处理，原样交给 lib/line-hints.mjs 的 readDirections（只有从 text 里读舞台提示时用到；
 *   台词自带 hints 的，text 已经切开，不起作用）。不给就是默认的 'keep'；配音明确给 'remove'。规则只在 lib/line-hints.mjs 的文件头写。
 *   judge：false 就不调 text-generation（它收费），要判断的台词落到默认参考，judge.status 是 'planned'。不给就是 true
 * @returns {Promise<{ picks: object[], judge: object }>}
 * @throws {VoicePackError} pick_input_invalid（options 不对时 details.field 是 options）、capability_result_invalid（text-generation 的返回不是 { text }）
 */
export async function pickReferences(env, manifest, lines, options) {
  const set = readReferenceSet(manifest);
  const input = readLines(lines);
  const settings = readOptions(options);
  const directionOptions = settings.directions;
  const plans = input.map((line) => wantedFor(line, directionOptions));
  const judge = await runJudge(env, set, input, plans, directionOptions, settings.judge);
  const picks = plans.map((plan, index) => {
    const candidate = choose(set.candidates, plan.wanted);
    const { matched, missed } = explain(candidate, plan.wanted);
    return {
      index,
      segmentId: candidate.id,
      rule: plan.rule,
      wanted: { language: shownLanguage(plan.wanted.language, set.candidates), script: plan.wanted.language?.script ?? null, emotion: plan.wanted.emotion, style: plan.wanted.style, energy: plan.wanted.energy },
      sources: plan.sources,
      matched,
      missed,
      directions: plan.directions,
    };
  });
  return { picks, judge };
}
