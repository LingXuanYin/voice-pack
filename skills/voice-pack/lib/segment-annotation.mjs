// SPDX-License-Identifier: Apache-2.0
//
// 给一段录音标提示标注（流程层）：让能听音频的模型听这段录音，在逐字稿上说法变化的地方加方括号提示，拼成提示标注（annotatedText）。
//   @capability audio-text-to-text  听一段录音，按文字指令回答（签名在 vocab/capability-signatures.md）
// 提示标注是整句带着方括号提示的文字，提示以外的字和逐字稿（text）一样，例如 [normal]啊，瞧瞧这是谁？[laughs]呵呵，[happy]太可爱了吧。
// 格式见 protocol/FORMAT.md 4.4；配音时它和参考一起交给模型（lib/dub.mjs 的 ref_text），模型就知道这段参考是怎么说的。
// 做包在挑完参考集以后，每段参考调一次（lib/make-pack-annotation.mjs）；别的程序给参考标提示标注，照这里的写法（一样的问法、回答格式和拼法）。
//
// 怎么问、怎么确认模型听到了：
//   问：把这段的逐字稿交给模型，但去掉开头 OPENING_WORDS 个词，用省略号占位（lib/fidelity.mjs 的 afterOpening）：去掉的就是收音校验原样比的那几个词，
//     模型要写出开头，只能靠听。收音校验另有折过写法的那一次，一个数占的词数变了，比到的可能少几个词，也可能多比到交给模型的那一截（日文的「１，０００」），
//     所以它交回两次里小的那个（见 afterOpening 的说明）。
//   答：固定格式，不让模型把整句写出来（现成文章做的包，服务商会拦下「把原话写出来」的回答；挑默认段那一次也是这样，lib/default-pick.mjs 的文件头）：
//     一个 JSON 对象（可以包在一个代码块里）{ "opening": "…", "cues": [{ "cue": "[laughs]", "before": "呵呵" }], "name": "平常" }
//     opening 是它听到的开头几个词；cues 是一组提示，cue 是一个方括号提示（中文、英文的自由描述都行），before 是这条提示后面紧跟着的一小段原文（几个字到几个词）。
//     问法要 cue 写得短：每个两三个词，只写这一处怎么说，不写成句子（标出来的提示会当 ref_text 随每个请求发出去）。收到长的照收，不丢、不截。
//     name 只在要名字时问（options.nameLanguage）：给这段录音起的短名字，用 nameLanguage 那种语言，说这段的情绪、年龄或状态里最突出的一种（「平常」「愤怒」「少年」），
//     不带角色名，一个名字不并两种说法（名字用来在同一个角色的几段参考之间切换：角色名每段都一样，说不出这几段的区别），
//     做包拿它当这段参考的音色基底标签（lib/make-pack-tags.mjs）。不为一个名字另调一次：它和提示标注是同一次问、同一个回答。
//     name 缺了、不是字符串、只有空白（判法同清单检查的 text_blank），就是没给名字，提示标注照常，不算回答读不懂；去掉两头空白，超过 REFERENCE_TAG_MAX（64）个码点的截到 64。
//     回答里多出来的键不管；没要名字时回答里的 name 也不管。
//   收音校验：opening 和逐字稿的开头比（lib/fidelity.mjs 的 openingErrorRate），错误率超过上限就作废，同挑默认段那一次和盲听。
//   拼（insertCues）：照 cues 的次序，在 text 里从上一条提示插进去的位置往后找 before 第一次出现的地方，把 cue 插在它前面。
//     text 本身一个字都不改，所以提示以外的字一定和 text 一样。找不到 before 的那一条丢掉（报告写丢了几条）；一条都找不到，这一段作废。
//     cues 是空的，就是这段说法没有变化：不写提示标注，不算没标上。
//
// 暂时出错（details.transient）怎么办：annotateSegment 默认只问一次（options.attempts 是 1），做包给 attempts: MAX_ATTEMPTS（3），
// 按 lib/call-attempts.mjs 的规则再问，3 次都暂时出错才是没听成。不重试的：被服务商拦下（provider_blocked）、回答没正常结束或是空的（能力标 details.unusable）、
// 回答不是固定格式、收音校验没过、提示一条都对不上原文：能力是答了的，重来也是一样的答案，而且每问一次都花钱。别的错（401……）原样抛出，也不重试。
//
// 返回（annotateSegment）：
//   { status: 'annotated', annotatedText, cues, droppedCues?, name?, model? }   标上了：cues 是插进去的提示条数，droppedCues 是找不到 before、丢掉的条数（没有丢的不写）
//   { status: 'no_cues', name?, model? }                                  听到了，模型说这段说法没有变化（cues 是空数组）：没有提示标注，不算没标上
//   name 是整理过的名字（见上「答」），要了名字、模型也给了才有；作废、没听成的没有名字（这一段没标上，名字也不用）
//   { status: 'voided', reason, errorRate?, problem?, stopReason?, droppedCues?, model? }   作废，这一段只留逐字稿。reason：
//       listening_check_failed       收音校验没过（errorRate 是开头的错误率）
//       annotation_answer_invalid    回答不是固定格式，读不懂（problem 说哪里不对；拼出来的提示标注超过格式的长度上限也算，problem 写明）
//       annotation_answer_unusable   回答没正常结束或是空的（能力标 details.unusable；problem 是 stop_reason 或 text_missing，带 stopReason，写法是 lib/capability-calls.mjs 的 unusableDetails）
//       provider_blocked             回答被模型的服务商拦下了（能力抛 provider_blocked，写法见 vocab/capability-signatures.md）
//       cues_unmatched               cues 里的 before 一条都在逐字稿里找不到（droppedCues 是条数）
//   { status: 'not_heard', error: { code, message, details }, attempts }  服务暂时出错，问满了 attempts 次也没成：这一段没标上，别的段照常
//
// 抛出的错误：
//   capability_result_invalid  能力的返回不是 { text: 字符串, model?: 字符串 }。details: { capability, problem }
//   另外 capability_missing 来自核心层；options.wait 抛的错原样往上抛；options.attempts 不是 1 以上的整数，TypeError（lib/call-attempts.mjs）；
//   options.nameLanguage 不是 'zh'、'en'，TypeError。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { reportable } from '../protocol/lib/scrub.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { openingErrorRate, afterOpening, OPENING_WORDS, DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { summarizeError, badResult, isUnusableAnswer, unusableDetails, answerBody, isPlainObject } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';
import { ANNOTATED_TEXT_MAX, REFERENCE_TAG_MAX } from './manifest-limits.mjs';
import { isBlankText } from '../protocol/lib/manifest.mjs';

/** 要名字时，名字用哪种语言写、举什么例子（nameLanguage 是包的骨架语言，lib/make-pack-input.mjs 的 textLanguage）。 */
const NAME_WORDS = {
  zh: { language: '中文', examples: '「平常」「愤怒」「少年」', sample: '平常' },
  en: { language: '英文', examples: '"calm"、"angry"、"young"', sample: 'calm' },
};

/**
 * 给模型的提示：逐字稿去掉了开头，开头要它听着写；提示要它在说法变化的地方加，用 before 定位，不写整句；
 * 给了 nameLanguage 就再要一个短名字（见文件头）。
 */
export function annotationPrompt(nameLanguage) {
  const naming = nameLanguage === undefined ? null : NAME_WORDS[nameLanguage];
  return [
    '你会听到一段录音，下面附着它的逐字稿，开头几个词换成了省略号。请只根据你听到的内容回答。',
    '',
    `1. opening：写出录音里开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词；什么都没听到就留空。`,
    '2. cues：在说法变化的地方（换了语气或情绪、笑、叹气、哽咽、压低声音、放慢……）加提示，每处一项，按在录音里的先后排：',
    '   cue 是一个方括号提示，例如 [laughs]、[happy]、[压低声音]，中文、英文的自由描述都行；每个两三个词，只写这一处怎么说，不写成句子；',
    '   before 是这条提示后面紧跟着的一小段原文（几个字到几个词），照逐字稿抄，只用来定位，不要写整句。',
    '   录音开头的说法也可以标（before 写开头的几个字）；从头到尾说法都没变，cues 就是空数组。',
    ...(naming === null ? [] : [
      `3. name：给这段录音起一个短名字，用${naming.language}写，几个字或一两个词，只说一样：这段整体的情绪、年龄或状态里最突出的那一种，例如 ${naming.examples}；`,
      '   不写说话的是谁（不带角色名、人名），不把两种说法并进一个名字（不写「抱怨与讨好」这样的）；同样的说法给同样的名字，不加编号，不写理由。',
    ]),
    '',
    '只输出一个 JSON 对象，不要输出别的文字。格式如下：',
    `{"opening": "…", "cues": [{"cue": "[laughs]", "before": "呵呵"}]${naming === null ? '' : `, "name": "${naming.sample}"`}}`,
  ].join('\n');
}

/**
 * 模型给的名字整理成音色基底标签（见文件头）：不是字符串、只有空白是没有（undefined）；去掉两头空白，超过 REFERENCE_TAG_MAX 个码点的截到这么长。
 */
export function nameOf(raw) {
  if (typeof raw !== 'string' || isBlankText(raw)) return undefined;
  const points = [...raw.trim()];
  return points.length <= REFERENCE_TAG_MAX ? points.join('') : points.slice(0, REFERENCE_TAG_MAX).join('').trimEnd();
}

/** 交给模型的逐字稿：去掉开头 OPENING_WORDS 个词，用省略号占位。 */
export const shownTranscript = (text) => `…${afterOpening(text)}`;

/** 一个方括号提示：方括号里有看得见的字，里面没有别的方括号，也不换行。 */
const CUE = /^\[[^[\]\r\n]+\]$/u;
export const isCue = (text) => typeof text === 'string' && CUE.test(text) && text.slice(1, -1).trim() !== '';

const invalidAnswer = (reason, reply) => new VoicePackError('annotation_answer_invalid', `标提示标注的回答不符合固定格式（${reason}），不猜，这一段只留逐字稿`, { details: { reason, reply: reportable(reply) } });

/**
 * 把模型的回答解析出来。整段回答必须是一个 JSON 对象（可以包在一个代码块里）：opening 是字符串，cues 是 { cue, before } 的数组，
 * cue 是一个方括号提示（去掉两头空白），before 是字符串。name 可有可无：是字符串就原样带出来，别的值当没给（不算读不懂）。多出来的键不管。
 * @returns {{ opening: string, cues: { cue: string, before: string }[], name?: string }}
 * @throws {VoicePackError} annotation_answer_invalid。details.reason 说哪里不对，details.reply 是原话全文（打过码，规则见 protocol/lib/scrub.mjs）
 */
export function parseAnnotationAnswer(reply) {
  let data;
  try {
    data = JSON.parse(answerBody(reply));
  } catch {
    throw invalidAnswer('不是 JSON', reply);
  }
  if (!isPlainObject(data)) throw invalidAnswer('不是 JSON 对象', reply);
  if (typeof data.opening !== 'string') throw invalidAnswer('opening 必须是字符串', reply);
  if (!Array.isArray(data.cues)) throw invalidAnswer('cues 必须是数组', reply);
  const cues = data.cues.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.cue !== 'string' || typeof entry.before !== 'string') throw invalidAnswer(`cues[${index}] 必须是 { cue, before }，两个都是字符串`, reply);
    const cue = entry.cue.trim();
    if (!isCue(cue)) throw invalidAnswer(`cues[${index}].cue 不是一个方括号提示`, reply);
    return { cue, before: entry.before };
  });
  return { opening: data.opening, cues, ...(typeof data.name === 'string' ? { name: data.name } : {}) };
}

/**
 * 照 cues 的次序把提示插进逐字稿：从上一条提示插进去的位置往后找 before（去掉两头空白）第一次出现的地方，把 cue 插在它前面；
 * 找不到的（before 是空白的也算）丢掉。text 一个字都不改。
 * @param {string} text 逐字稿
 * @param {{ cue: string, before: string }[]} cues
 * @returns {{ annotatedText: string | null, inserted: number, dropped: number }} 一条都没插进去时 annotatedText 是 null
 */
export function insertCues(text, cues) {
  const places = [];
  let from = 0;
  for (const { cue, before } of cues) {
    const anchor = before.trim();
    const at = anchor === '' ? -1 : text.indexOf(anchor, from);
    if (at === -1) continue;
    places.push({ at, cue });
    from = at;
  }
  if (places.length === 0) return { annotatedText: null, inserted: 0, dropped: cues.length };
  let annotated = '';
  let copied = 0;
  for (const { at, cue } of places) {
    annotated += text.slice(copied, at) + cue;
    copied = at;
  }
  return { annotatedText: annotated + text.slice(copied), inserted: places.length, dropped: cues.length - places.length };
}

/**
 * 给一段录音标提示标注。
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ audio: {bytes: Uint8Array, mimeType: string}, text: string }} segment text 是这段录音的逐字稿：去掉开头几个词交给模型，收音校验、拼提示标注都用它
 * @param {{ maxErrorRate?: number, attempts?: number, wait?: (ms: number) => Promise<void>, onRetry?: (info: { attempt: number, waitMs: number, error: Error }) => void, nameLanguage?: 'zh' | 'en' }} [options]
 *   attempts 这一段最多问几次（1 以上的整数，默认 1：不重试）；wait、onRetry 同 lib/call-attempts.mjs 的 callWithRetries；
 *   nameLanguage 给了就在同一次里要一个短名字，用这种语言写（见文件头），不给就不要
 * @returns {Promise<object>} 见文件头
 */
export async function annotateSegment(env, segment, { maxErrorRate = DEFAULT_MAX_ERROR_RATE, attempts = 1, wait, onRetry, nameLanguage } = {}) {
  if (nameLanguage !== undefined && !Object.hasOwn(NAME_WORDS, nameLanguage)) throw new TypeError(`nameLanguage 要是 ${Object.keys(NAME_WORDS).join('、')} 之一，或者不给，收到 ${JSON.stringify(nameLanguage)}`);
  const listen = requireCapability(env, 'audio-text-to-text');
  const parts = [{ text: annotationPrompt(nameLanguage) }, { text: `逐字稿：${shownTranscript(segment.text)}` }, { text: '录音：' }, { audio: segment.audio }];
  let outcome;
  try {
    // 暂时出错就按 lib/call-attempts.mjs 的规则再问；问满了还是暂时出错返回 { error }。别的错不重试，下面接
    outcome = await callWithRetries(() => listen({ parts }), { attempts, wait, onRetry });
  } catch (error) {
    // 被服务商拦下：同一段录音再问还是被拦，作废，不重试
    if (isVoicePackError(error, 'provider_blocked')) return { status: 'voided', reason: 'provider_blocked', ...(typeof error.details?.model === 'string' ? { model: error.details.model } : {}) };
    // 回答没正常结束或是空的：读不懂，作废，不再问
    if (isUnusableAnswer(error)) return { status: 'voided', reason: 'annotation_answer_unusable', ...unusableDetails(error) };
    throw error;
  }
  if ('error' in outcome) return { status: 'not_heard', error: summarizeError(outcome.error), attempts: outcome.attempts };
  const reply = outcome.result;
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', 'text_missing', '必须返回 { text: 字符串, model?: 字符串 }');
  const model = typeof reply.model === 'string' ? { model: reply.model } : {};
  let answer;
  try {
    answer = parseAnnotationAnswer(reply.text);
  } catch (error) {
    if (isVoicePackError(error, 'annotation_answer_invalid')) return { status: 'voided', reason: 'annotation_answer_invalid', problem: error.details.reason, ...model };
    throw error;
  }
  const errorRate = openingErrorRate(segment.text, answer.opening);
  if (errorRate > maxErrorRate) return { status: 'voided', reason: 'listening_check_failed', errorRate, ...model };
  // 要了名字、模型也给了才带（整理过的，见 nameOf）；作废的段不带
  const name = nameLanguage === undefined ? undefined : nameOf(answer.name);
  const named = name === undefined ? {} : { name };
  if (answer.cues.length === 0) return { status: 'no_cues', ...named, ...model };
  const { annotatedText, inserted, dropped } = insertCues(segment.text, answer.cues);
  const droppedCues = dropped === 0 ? {} : { droppedCues: dropped };
  if (annotatedText === null) return { status: 'voided', reason: 'cues_unmatched', ...droppedCues, ...model };
  if ([...annotatedText].length > ANNOTATED_TEXT_MAX) return { status: 'voided', reason: 'annotation_answer_invalid', problem: `拼出来的提示标注超过 ${ANNOTATED_TEXT_MAX} 个字符`, ...model };
  return { status: 'annotated', annotatedText, cues: inserted, ...droppedCues, ...named, ...model };
}
