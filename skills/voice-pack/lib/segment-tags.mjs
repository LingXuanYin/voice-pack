// SPDX-License-Identifier: Apache-2.0
//
// 给一段录音打情绪、风格标签（流程层）：让能听音频的模型听着打，能选的词取自舞台提示词表（vocab/cues.json），所以打出来的标签，
// 按台词挑参考（lib/reference-pick.mjs）认得出，和台词里的舞台提示（（生气）、*笑*）能对上。
//   @capability audio-text-to-text  听一段录音，按文字指令回答（签名在 vocab/capability-signatures.md）
// 语言来自转写（或文字本身）、能量靠计算，不在这里（lib/make-pack-tags.mjs）。
//
// 一次调用问一段录音，不告诉模型这段话的原文：先让它写出录音开头的 OPENING_WORDS 个词，再给情绪和风格。
// 收音校验和盲听是同一个办法（lib/fidelity.mjs 的 openingErrorRate）：开头的这几个词和已知文本的开头对不上（错误率超过上限），就是模型没有真的听到，它打的标签是编的，这一段不采用。
// 只要开头、不要整段原话：现成的文章（新闻朗读、书）做的包，模型的服务商会拦下「把整段原话写出来」的回答，
//   只要开头几个词，同样的录音基本不再被拦；模型写了更多也只比开头。
// 没听到的原因可能是适配器给模型传音频的办法失效了，所以这一步也是那条路是否还通的哨兵。
//
// 回答要求是一个 JSON 对象（可以包在一个代码块里）：{ "transcript": "…", "emotion": "calm", "style": "none" }，transcript 是录音开头的话。
//   emotion、style 要取提示里列出的词，或者 "none"（没有）；词表里的近义词认作同一个（愤怒 = angry）；词表外的不采用，原话记在 dropped 里。
//
// 暂时出错（details.transient）怎么办：tagSegment 默认只问一次（options.attempts 是 1），出错就是没听成；做包（lib/make-pack-tags.mjs 的 tagAll）给 attempts: MAX_ATTEMPTS，
// 这一段在同一次做包里按 lib/call-attempts.mjs 的规则再问（每段最多 3 次，第 2、3 次之前等 5 秒、15 秒），3 次都暂时出错才是没听成。规则只在那个模块写一份。
// 不重试的：回答被服务商拦下（provider_blocked，同一段录音再问还是被拦）、回答不是固定格式、收音校验没过：能力是答了的，重来也是一样的答案。别的错（401……）原样抛出，也不重试。
//
// 返回（tagSegment）：
//   { status: 'tagged', emotion?, style?, dropped?, model? }   听到了。没有情绪、没有风格的不写那一项
//   { status: 'voided', reason: 'listening_check_failed' | 'tag_answer_invalid' | 'provider_blocked', errorRate?, model? }   不采用：没听到，或者回答不是固定格式，
//                                                              或者回答被模型的服务商拦下了（能力抛 provider_blocked，写法见 vocab/capability-signatures.md；同一段录音再问还是被拦，所以不是没听成）
//   { status: 'not_heard', error: { code, message, details }, attempts }  服务暂时出错（能力在 details.transient 里标了 true），问满了 attempts 次也没成：这一段没打上，别的段照常；
//                                                              attempts 是这一段问了几次（不重试的时候是 1）
// 别的错误（缺能力、401、返回的形状不对……）原样抛出。
//
// 抛出的错误：
//   capability_result_invalid  能力的返回不是 { text: 字符串, model?: 字符串 }。details: { capability, problem }
//   另外 capability_missing 来自核心层；options.wait 抛的错（做包的取消）原样往上抛；options.attempts 不是 1 以上的整数，TypeError（程序员用错接口，见 lib/call-attempts.mjs）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import cues from '../vocab/cues.json' with { type: 'json' };
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { openingErrorRate, OPENING_WORDS, DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { canonicalLabel } from './line-hints.mjs';
import { summarizeError, badResult } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';

export const EMOTIONS = Object.freeze(Object.keys(cues.emotion));
export const STYLES = Object.freeze(Object.keys(cues.style));

/** 给模型的提示：不写这一段的原文；只要录音开头的 OPENING_WORDS 个词（要整段原话会被模型的服务商拦下，见文件头）。能选的词是舞台提示词表里的规范名。 */
export const TAG_PROMPT = [
  '你会听到一段录音。请只根据你听到的内容回答。',
  '',
  `先写出录音里开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词；什么都没听到就留空。`,
  '然后判断说话人的情绪，和说话的方式：',
  `1. emotion：从这几个里选一个：${EMOTIONS.join('、')}；都不像就写 "none"。`,
  `2. style：从这几个里选一个：${STYLES.join('、')}；都不是就写 "none"。`,
  '',
  '只输出一个 JSON 对象，不要输出别的文字。格式如下：',
  '{"transcript": "…", "emotion": "calm", "style": "none"}',
].join('\n');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 整段回答就是一个 ``` 代码块
const FENCED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

const invalidAnswer = (reason, reply) => new VoicePackError('tag_answer_invalid', `打标签的回答不符合固定格式（${reason}），不猜，这一段不采用模型打的标签`, { details: { reason, reply: String(reply).slice(0, 300) } });

/**
 * 把模型的回答解析出来。整段回答必须是一个 JSON 对象（可以包在一个代码块里），transcript、emotion、style 都是字符串。
 * @throws {VoicePackError} tag_answer_invalid。details.reason 说哪里不对，details.reply 是原话的前 300 个字符
 */
export function parseTagAnswer(reply) {
  let body = String(reply).trim();
  const fenced = FENCED.exec(body);
  if (fenced) body = fenced[1].trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw invalidAnswer('不是 JSON', reply);
  }
  if (!isPlainObject(data)) throw invalidAnswer('不是 JSON 对象', reply);
  for (const key of ['transcript', 'emotion', 'style']) if (typeof data[key] !== 'string') throw invalidAnswer(`${key} 必须是字符串`, reply);
  return { transcript: data.transcript, emotion: data.emotion, style: data.style };
}

/** 一个标签词：none 或空是没有；词表里的（含近义词）给规范名；词表外的给 null，调用方记下原话。 */
function readLabel(kind, value, allowed) {
  const text = value.trim();
  if (text === '' || text.toLowerCase() === 'none') return { label: undefined };
  const canonical = canonicalLabel(kind, text);
  return allowed.includes(canonical) ? { label: canonical } : { label: undefined, dropped: text };
}

/**
 * 给一段录音打标签。
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ audio: {bytes: Uint8Array, mimeType: string}, text: string }} segment text 是这段录音里说的话（已知文本，收音校验用），不会交给模型
 * @param {{ maxErrorRate?: number, attempts?: number, wait?: (ms: number) => Promise<void>, onRetry?: (info: { attempt: number, waitMs: number, error: Error }) => void }} [options]
 *   attempts 这一段最多问几次（1 以上的整数，默认 1：不重试）；wait、onRetry 同 lib/call-attempts.mjs 的 callWithRetries（等多久再来、知道要重试了告诉调用方）
 * @returns {Promise<object>} 见文件头
 */
export async function tagSegment(env, segment, { maxErrorRate = DEFAULT_MAX_ERROR_RATE, attempts = 1, wait, onRetry } = {}) {
  const listen = requireCapability(env, 'audio-text-to-text');
  let outcome;
  try {
    // 暂时出错就按 lib/call-attempts.mjs 的规则再问；问满了还是暂时出错返回 { error }。别的错（被服务商拦下、401……）不重试，原样抛出来，下面接
    outcome = await callWithRetries(() => listen({ parts: [{ text: TAG_PROMPT }, { text: '录音：' }, { audio: segment.audio }] }), { attempts, wait, onRetry });
  } catch (error) {
    // 回答被模型的服务商拦下：能力按约定抛 provider_blocked（适配器认服务商的原话，库只认这个码）。同一段录音再问还是被拦，所以是作废，不是没听成，也不重试
    if (isVoicePackError(error, 'provider_blocked')) return { status: 'voided', reason: 'provider_blocked', ...(typeof error.details?.model === 'string' ? { model: error.details.model } : {}) };
    throw error;
  }
  if ('error' in outcome) return { status: 'not_heard', error: summarizeError(outcome.error), attempts: outcome.attempts };
  const reply = outcome.result;
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', 'text_missing', '必须返回 { text: 字符串, model?: 字符串 }');
  const model = typeof reply.model === 'string' ? { model: reply.model } : {};
  let answer;
  try {
    answer = parseTagAnswer(reply.text);
  } catch (error) {
    if (isVoicePackError(error, 'tag_answer_invalid')) return { status: 'voided', reason: 'tag_answer_invalid', ...model };
    throw error;
  }
  const errorRate = openingErrorRate(segment.text, answer.transcript);
  if (errorRate > maxErrorRate) return { status: 'voided', reason: 'listening_check_failed', errorRate, ...model };
  const emotion = readLabel('emotion', answer.emotion, EMOTIONS);
  const style = readLabel('style', answer.style, STYLES);
  const dropped = { ...(emotion.dropped === undefined ? {} : { emotion: emotion.dropped }), ...(style.dropped === undefined ? {} : { style: style.dropped }) };
  return {
    status: 'tagged',
    ...(emotion.label === undefined ? {} : { emotion: emotion.label }),
    ...(style.label === undefined ? {} : { style: style.label }),
    ...(Object.keys(dropped).length === 0 ? {} : { dropped }),
    ...model,
  };
}
