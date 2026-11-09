// SPDX-License-Identifier: Apache-2.0
//
// 给一段录音标提示标注（流程层）：让能听音频的模型听这段录音，在逐字稿上说法变化的地方加方括号提示，拼成提示标注（annotatedText）。
//   @capability audio-text-to-text  听一段录音，按文字指令回答（签名在 vocab/capability-signatures.md）
// 提示标注是整句带着方括号提示的文字，提示以外的字和逐字稿（text）一样，例如 [normal]啊，瞧瞧这是谁？[laughs]呵呵，[happy]太可爱了吧。
// 格式见 protocol/FORMAT.md 4.4；配音时它和参考一起交给模型（lib/dub.mjs 的 ref_text），模型就知道这段参考是怎么说的。
// 做包在挑完参考集以后，每段参考标一次（lib/make-pack-annotation.mjs，这里对模型问 3 次）；别的程序给参考标提示标注，照这里的写法（一样的问法、回答格式和拼法）。
//
// 怎么问、怎么确认模型听到了：
//   问：把这段的逐字稿交给模型，但去掉开头 OPENING_WORDS 个词，用省略号占位（lib/fidelity.mjs 的 afterOpening）：去掉的就是收音校验原样比的那几个词，
//     （被盖住的那几个分句也要它标，before 从它自己写的 opening 里抄，见「拼」的 placeCues）
//     模型要写出开头，只能靠听。收音校验另有折过写法的那一次，一个数占的词数变了，比到的可能少几个词，也可能多比到交给模型的那一截（日文的「１，０００」），
//     所以它交回两次里小的那个（见 afterOpening 的说明）。
//   问法要逐分句标：每个分句开头一条，cue 里放这个分句的情绪，从固定词表选一到两个词（用逗号分开）；同一条里可以再加尾音拖长、尾音上扬。笑、叹气、吸气、哽咽真听到才写，单独一条，写在那个字前面（SOUND_CUES），没有的不写，不为了细而编。
//     词表（EMOTION_WORDS）约 30 个词，cueLanguage（不给就同 nameLanguage）是 en 时用英文那份，其余用中文；三次比词、认情绪都按这一份。
//   答：固定格式，不让模型把整句写出来（现成文章做的包，服务商会拦下「把原话写出来」的回答；挑默认段那一次也是这样，lib/default-pick.mjs 的文件头）：
//     一个 JSON 对象（可以包在一个代码块里）{ "opening": "…", "cues": [{ "cue": "[laughs]", "before": "呵呵" }], "name": "平常" }
//     opening 是它听到的开头几个词；cues 是一组提示，cue 是一个方括号提示（中文、英文的自由描述都行），before 是这条提示后面紧跟着的一小段原文（几个字到几个词）。
//     问法要 cue 写得短：每个不超过两三个词，只写这一处怎么说，不写成句子（标出来的提示会当 ref_text 随每个请求发出去）。收到长的照收，不丢、不截。
//     name 只在要名字时问（options.nameLanguage）：给这段录音起的短名字，用 nameLanguage 那种语言，说这段的情绪、年龄或状态里最突出的一种（「平常」「愤怒」「少年」），
//     不带角色名，一个名字不并两种说法（名字用来在同一个角色的几段参考之间切换：角色名每段都一样，说不出这几段的区别），
//     做包拿它当这段参考的音色基底标签（lib/make-pack-tags.mjs）。不为一个名字另调一次：它和提示标注是同一次问、同一个回答。
//     name 缺了、不是字符串、只有空白（判法同清单检查的 text_blank），就是没给名字，提示标注照常，不算回答读不懂；去掉两头空白，超过 REFERENCE_TAG_MAX（64）个码点的截到 64。
//     回答里多出来的键不管；没要名字时回答里的 name 也不管。
//   收音校验：opening 和逐字稿的开头比（lib/fidelity.mjs 的 openingErrorRate），错误率超过上限就作废，同挑默认段那一次和盲听。
//   定位（placeCues）：照 cues 的次序，在 text 里从上一条提示的位置往后找 before 第一次出现的地方；同一个 before 连着两条（都不是一下子的声音）说的是下一处，后面没有了才放在一处。
//     也到这次回答的 opening 里找，按词的序号（tokenSpans）换算回 text，听错了字（把「嗨」听成「哎」）也落在同一个词上；换算出来的不排在上一条前面，而且 text 里没找到、或者找到的在被盖住的开头以外，就用它（找到的在被盖住的开头里，用找到的：模型的开头可能词数不同）。
//   拼（insertCues）：照 cues 的次序定位（同上，不看 opening），把 cue 插在那里。
//     text 本身一个字都不改，所以提示以外的字一定和 text 一样。找不到 before 的那一条丢掉（报告写丢了几条）；一条都找不到，这一次听不算（见下）。
//     cues 是空的，就是这段说法没有变化：这一次听是能用的，不写提示。三次都没有留下的提示、量出来也没有要写的，就不写提示标注，不算没标上。
//
// 听三次（annotateSegment）：每段问 LISTEN_PASSES（3）次，同一个提示，一次接一次问（被服务商拦下就不再问，见下）。3 次里至少 LISTEN_AGREE（2）次相同才用：
//   每一次的 cue 按 before 定位（placeCues）到分句（分句见 lib/point-measure.mjs 的 clauseStartsOf，这里只看标点），cue 按逗号类（，,、）拆成词，同一分句同一个词至少 2 次出现才留
//   （一次回答里同一分句的同一个词只算一票）。情绪词（这份词表里的、不是尾音的）多一条：一个分句没有一个情绪词到 2 次的，留票最多的那一个，一样多取最先出现的（第一次听的第一个情绪词）；
//   尾音、一下子的声音、词表以外的词还是要 2 次。留下的词放回它第一次出现的那条提示，位置也是那条的（before 第一次定的位）；次序照第一次出现的；后面几次才第一次出现的词，并进这个分句已有的情绪那一条
//   （一下子的声音不并、也不被并）：所以几次回答一样时，留下的提示和拼法都和一次回答的原样一样。
//   一次调用失败怎么办：
//     暂时出错照 lib/call-attempts.mjs 的 callWithRetries，每一次听都有自己的重试（options.attempts 次，做包给 3）；问满了还是暂时出错，这一次不算，状态是 not_heard。
//     provider_blocked（被服务商拦下）一出现就停，作废（同一段录音再问还是被拦）。
//     回答读不懂、收音校验没过、提示一条都对不上原文、没正常结束或是空的：这一次不算，不重试。
//   能用的不足 2 次：作废，状态是第一个失败的那一次的状态（和现在只问一次、那一次失败时一模一样：reason、errorRate、problem……；3 次都暂时出错就是 not_heard）。
//   名字（name）取第一个能用的回答里的；droppedCues 是第一个能用的回答丢了几条（报告口径同只问一次）。
//
// 拼（assembleAnnotation，三次听够了以后）：听出来的提示和量出来的停顿、快慢（lib/point-measure.mjs，options.measure 给的；量失败、不给就只用听的结果）合在一起，字一个不动：
//   只说情绪、尾音的提示（词都在 cueLanguage 那份词表里）一律挪到它那个分句的开头，模型的 before 只用来定是哪个分句；一下子的声音、词表以外的提示留在 before 定的地方。
//   一处的次序：停顿、一下子的声音、情绪（和尾音合在一条，例如 [赌气，尾音拖长]）、快慢，都紧贴在这个分句前面；一处听出来的提示都认得（声音、情绪）才把声音调到前面，否则保持回答里的次序。
//   情绪和前一个分句（上一个 clauseStarts）一样、又没有尾音的那条不写：只比 cueLanguage 那份词表里的情绪词（词表以外的提示、声音不算情绪，不去）。
//   拼好去掉方括号必须和 text（同样去掉方括号）一字不差、不超过 ANNOTATED_TEXT_MAX，不合就作废，退回只存逐字稿（annotation_answer_invalid，problem 写明）。
//
// 暂时出错（details.transient）怎么办：每一次听默认只问一下（options.attempts 是 1），做包给 attempts: MAX_ATTEMPTS（3），
// 按 lib/call-attempts.mjs 的规则再问，这一次问满了还是暂时出错，这一次不算。不重试的：被服务商拦下（provider_blocked）、回答没正常结束或是空的（能力标 details.unusable）、
// 回答不是固定格式、收音校验没过、提示一条都对不上原文：能力是答了的，重来也是一样的答案，而且每问一次都花钱。别的错（401……）原样抛出，也不重试。
//
// 返回（annotateSegment）：
//   另外都带 listens（3 次里用上了几次）、measured（写了量的结果没有）、measureReason?（没量上的原因，lib/point-measure.mjs 的文件头）、asked（问了几次）、chunks（转写了几块）。
//   { status: 'annotated', annotatedText, cues, droppedCues?, name?, model? }   标上了：cues 是写进去的听出来的提示条数（不算量出来的标记），droppedCues 是找不到 before、丢掉的条数（没有丢的不写）
//   { status: 'no_cues', name?, model? }                                  听到了，三次取一致以后没有提示、量出来也没有要写的：没有提示标注，不算没标上
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
import { openingErrorRate, afterOpening, tokenSpans, OPENING_WORDS, DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { summarizeError, badResult, isUnusableAnswer, unusableDetails, answerBody, isPlainObject } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';
import { ANNOTATED_TEXT_MAX, REFERENCE_TAG_MAX } from './manifest-limits.mjs';
import { isBlankText } from '../protocol/lib/manifest.mjs';
import { clauseStartsOf, clauseFinder } from './point-measure.mjs';

/** 每段听几次（见文件头「听三次」）。规划按它算次数（lib/make-pack-plan.mjs）。 */
export const LISTEN_PASSES = 3;
/** 同一分句同一个词至少几次相同才用。 */
export const LISTEN_AGREE = 2;

/** 情绪词表（固定，相同才比得出来；nameLanguage 是 en 时用英文那份，其余用中文）。英文那份是这里定的中文词表的对译。 */
const EMOTION_WORDS = {
  zh: ['平静', '认真', '开心', '得意', '兴奋', '惊喜', '惊讶', '疑惑', '迟疑', '试探', '讨好', '谄媚', '诚恳', '温柔', '委屈', '失望', '难过', '无奈', '感慨', '叹息', '抱怨', '不满', '赌气', '决绝', '生气', '着急', '害怕', '紧张', '调侃', '嘲讽', '自夸'],
  en: ['calm', 'earnest', 'happy', 'smug', 'excited', 'delighted', 'surprised', 'puzzled', 'hesitant', 'tentative', 'coaxing', 'fawning', 'sincere', 'gentle', 'aggrieved', 'disappointed', 'sad', 'resigned', 'wistful', 'sighing', 'complaining', 'displeased', 'sulky', 'resolute', 'angry', 'anxious', 'afraid', 'nervous', 'teasing', 'mocking', 'boastful'],
};
/** 尾音：和情绪写在同一条里。 */
const TAIL_WORDS = { zh: ['尾音拖长', '尾音上扬'], en: ['drawn-out ending', 'rising ending'] };
/** 一下子的声音：真听到才写，单独一条，写在那个字前面。 */
const SOUND_CUES = ['[laughs]', '[sighs]', '[吸气]', '[哽咽]'];
const vocabularyOf = (cueLanguage) => (cueLanguage === 'en' ? 'en' : 'zh');
const isTailWord = (word, cueLanguage) => TAIL_WORDS[vocabularyOf(cueLanguage)].includes(word.toLowerCase());
/** 词是不是这份词表里的：情绪词或尾音（cueLanguage 那份）。 */
const isVocabularyWord = (word, cueLanguage) => EMOTION_WORDS[vocabularyOf(cueLanguage)].includes(word.toLowerCase()) || isTailWord(word, cueLanguage);

/** 要名字时，名字用哪种语言写、举什么例子（nameLanguage 是包的骨架语言，lib/make-pack-input.mjs 的 textLanguage）。 */
const NAME_WORDS = {
  zh: { language: '中文', examples: '「平常」「愤怒」「少年」', sample: '平常' },
  en: { language: '英文', examples: '"calm"、"angry"、"young"', sample: 'calm' },
};

/**
 * 给模型的提示：逐字稿去掉了开头，开头要它听着写；逐分句标（见文件头「听三次」），用 before 定位，不写整句；
 * 给了 nameLanguage 就再要一个短名字（见文件头）；cueLanguage 定情绪词表用哪种语言（不给就同 nameLanguage）。
 */
export function annotationPrompt(nameLanguage, cueLanguage = nameLanguage) {
  const naming = nameLanguage === undefined ? null : NAME_WORDS[nameLanguage];
  const vocabulary = vocabularyOf(cueLanguage);
  return [
    '你会听到一段录音，下面附着它的逐字稿，开头几个词换成了省略号。请只根据你听到的内容回答。',
    '',
    `1. opening：写出录音里开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词；什么都没听到就留空。`,
    '2. cues：逐分句标（分句是逗号、句号这样的标点隔开的一小句）。每个分句开头一条，按在录音里的先后排：',
    `   cue 是一个方括号提示，放这个分句的情绪，只从这个词表里选一到两个词，用逗号分开：${EMOTION_WORDS[vocabulary].join('、')}。例如 [${EMOTION_WORDS[vocabulary][22]}${vocabulary === 'en' ? ', ' : '，'}${EMOTION_WORDS[vocabulary][23]}]；`,
    `   同一条里可以再加 ${TAIL_WORDS[vocabulary].join('、')}，例如 [${EMOTION_WORDS[vocabulary][22]}${vocabulary === 'en' ? ', ' : '，'}${TAIL_WORDS[vocabulary][0]}]；每个不超过两三个词，只写这一处怎么说，不写成句子；`,
    `   笑、叹气、吸气、哽咽真听到才写，单独一条，写在那个字前面：${SOUND_CUES.join('、')}。没有的不写，不为了细而编；`,
    '   before 是这条提示后面紧跟着的一小段原文（几个字到几个词），照逐字稿抄，只用来定位，不要写整句。',
    '   开头被省略号盖住、你没有看到的那几个分句也要标，before 就从你自己写的 opening 里抄（几个字）；从头到尾什么特点都听不出来，cues 就是空数组。',
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
 * opening 里下标 where 那个地方，换算成逐字稿里同一个序号的词的开头（听错了字也落得到，「哎」对「嗨」）。where 是 -1、词数超过逐字稿的，是 -1。
 */
function positionFromOpening(where, opening, text) {
  if (where === -1) return -1;
  const index = tokenSpans(opening).findIndex((span) => span.end > where);
  return index === -1 ? -1 : tokenSpans(text)[index]?.start ?? -1;
}

/**
 * 把 cues 定位到逐字稿里：照次序从上一条的位置往后找 before（去掉两头空白）第一次出现的地方；找不到的（before 是空白的也算）算丢了。text 不动。
 * 这一条和上一条写的是同一个 before、又都不是一下子的声音：说的是下一处（「师父，师父，」两条各管一个），从上一处的后面找；后面没有了，才和上一条放在一处。
 * 一下子的声音和情绪写同一个 before 的，就是同一处。
 * 给了 opening（这次回答听到的开头）：同样的 before 也在 opening 里找（同一个 before 连着写的，同样找下一处），按词的序号换算回逐字稿（开头被省略号盖住，模型只能从自己写的 opening 里抄）。
 * 换算出来的位置不排在上一条前面，而且逐字稿里没找到、或者找到的在被盖住的那 OPENING_WORDS 个词以外，就用换算出来的：听错的字可能在后面的字里又出现（「哎」和后面的「哎呀」），先看逐字稿会落到后面去，把后面几条都挤掉。
 * 找到的就在被盖住的开头里，用找到的：before 和逐字稿一字不差，模型的开头反而可能词数不同（「九十四」听写成「94」，序号会错开）。
 * @returns {{ places: { at: number, cue: string }[], dropped: number }}
 */
export function placeCues(text, cues, opening) {
  const places = [];
  let from = 0;
  let previous = null; // 上一条放下的：{ at, anchor, sound, where }（where 是它在 opening 里的下标，没有是 -1）
  for (const { cue, before } of cues) {
    const anchor = before.trim();
    if (anchor === '') continue;
    const sound = SOUND_CUES.includes(cue);
    const repeated = previous !== null && !sound && !previous.sound && previous.anchor === anchor;
    let hit = repeated ? text.indexOf(anchor, previous.at + anchor.length) : -1;
    if (hit === -1) hit = text.indexOf(anchor, from);
    const where = opening === undefined ? -1 : opening.indexOf(anchor, repeated && previous.where !== -1 ? previous.where + anchor.length : 0);
    const heard = positionFromOpening(where, opening, text);
    const hitIsHidden = hit !== -1 && tokenSpans(text).findIndex((span) => span.end > hit) < OPENING_WORDS;
    const at = heard !== -1 && heard >= from && (hit === -1 || (hit > heard && !hitIsHidden)) ? heard : hit;
    if (at === -1) continue;
    places.push({ at, cue });
    from = at;
    previous = { at, anchor, sound, where };
  }
  return { places, dropped: cues.length - places.length };
}

/** 把一组定了位的文字按 at 从小到大插进 text（at 一样的照给的次序）。text 一个字都不改。 */
function spliced(text, places) {
  let result = '';
  let copied = 0;
  for (const { at, cue } of places) {
    result += text.slice(copied, at) + cue;
    copied = at;
  }
  return result + text.slice(copied);
}

/**
 * 照 cues 的次序把提示插进逐字稿：从上一条提示插进去的位置往后找 before（去掉两头空白）第一次出现的地方，把 cue 插在它前面；
 * 找不到的（before 是空白的也算）丢掉。text 一个字都不改。
 * @param {string} text 逐字稿
 * @param {{ cue: string, before: string }[]} cues
 * @returns {{ annotatedText: string | null, inserted: number, dropped: number }} 一条都没插进去时 annotatedText 是 null
 */
export function insertCues(text, cues) {
  const { places, dropped } = placeCues(text, cues);
  if (places.length === 0) return { annotatedText: null, inserted: 0, dropped };
  return { annotatedText: spliced(text, places), inserted: places.length, dropped };
}

/** 一个方括号提示里的词：去掉方括号，按逗号类（，,、）拆开，去掉两头空白和空的。 */
const cueWords = (cue) => cue.slice(1, -1).split(/[，,、]/u).map((word) => word.trim()).filter((word) => word !== '');
const isSoundWord = (word) => SOUND_CUES.includes(`[${word}]`);
const SEPARATOR = /\s*[，,、]\s*/u;

/**
 * 三次回答取一致（见文件头「听三次」）：一次的提示按位置归到分句，cue 拆成词；同一分句同一个词在至少 LISTEN_AGREE 次里出现才留。
 * 一个分句没有一个情绪词到 LISTEN_AGREE 次的，留票最多的那一个情绪词（一样多取最先出现的，也就是第一次听的第一个）；尾音、一下子的声音、词表以外的词还是要够票。
 * 留下的词还放回它第一次出现的那条提示（位置也是那条的）；后面几次才第一次出现的词，并进这个分句已有的情绪那一条（一下子的声音不并、不被并）。
 * 所以几次回答一样时，出来的就是其中一次回答的原样。
 * @param {string} text 逐字稿
 * @param {{ places: { at: number, cue: string }[] }[]} hearings 能用的几次（按问的先后）
 * @param {string} [cueLanguage]
 * @returns {{ at: number, cue: string }[]} 按位置排，位置一样的照第一次出现的次序
 */
function agreedCues(text, hearings, cueLanguage) {
  const clauseOf = clauseFinder(text, clauseStartsOf(text));
  const seen = new Map(); // 「分句 词」-> 第一次出现的那个词
  hearings.forEach((hearing, pass) => {
    hearing.places.forEach((place, index) => {
      const clause = clauseOf(place.at);
      for (const word of cueWords(place.cue)) {
        const key = `${clause}\u0000${word.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, { word, clause, at: place.at, pass, index, cue: place.cue, votes: new Set() });
        seen.get(key).votes.add(pass);
      }
    });
  });
  // 没有一个情绪词够票的分句：留票最多的那个情绪词（seen 是照第一次出现的次序，所以一样多的取最先出现的）
  const isEmotionWord = (word) => isVocabularyWord(word, cueLanguage) && !isTailWord(word, cueLanguage);
  const bestOfClause = new Map();
  for (const entry of seen.values()) {
    if (!isEmotionWord(entry.word)) continue;
    const best = bestOfClause.get(entry.clause);
    if (best === undefined || entry.votes.size > best.votes.size) bestOfClause.set(entry.clause, entry);
  }
  const rescued = new Set([...bestOfClause.values()].filter((entry) => entry.votes.size < LISTEN_AGREE));
  const groups = [];
  for (const entry of seen.values()) {
    if (entry.votes.size < LISTEN_AGREE && !rescued.has(entry)) continue;
    const sameCue = groups.find((group) => group.pass === entry.pass && group.index === entry.index);
    if (sameCue) {
      sameCue.words.push(entry.word);
      continue;
    }
    const sound = isSoundWord(entry.word);
    // 后面几次才第一次出现的词：并进这个分句已有的情绪那一条
    const sameClause = sound ? undefined : groups.find((group) => !group.sound && group.clause === entry.clause && group.pass !== entry.pass);
    if (sameClause) {
      sameClause.words.push(entry.word);
      continue;
    }
    groups.push({ clause: entry.clause, at: entry.at, pass: entry.pass, index: entry.index, cue: entry.cue, words: [entry.word], sound });
  }
  const separator = vocabularyOf(cueLanguage) === 'en' ? ', ' : '，';
  return groups
    .map((group, order) => {
      const original = cueWords(group.cue);
      const whole = original.length === group.words.length && original.every((word, i) => word === group.words[i]);
      // 拼过的一条：情绪词在前，尾音在后（尾音可能是先出现的那个）
      const words = [...group.words.filter((word) => !isTailWord(word, cueLanguage)), ...group.words.filter((word) => isTailWord(word, cueLanguage))];
      return { at: group.at, order, cue: whole ? group.cue : `[${words.join(group.cue.match(SEPARATOR)?.[0] ?? separator)}]` };
    })
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map(({ at, cue }) => ({ at, cue }));
}

/** 这条提示是不是只说情绪和尾音（词都在 cueLanguage 那份词表或尾音里）：这种要写在分句开头（见文件头「拼」）。 */
const isDeliveryCue = (cue, cueLanguage) => {
  const words = cueWords(cue);
  return words.length > 0 && words.every((word) => isVocabularyWord(word, cueLanguage));
};

/** 一条提示算情绪吗：词都在这份词表（cueLanguage 那份）或尾音里、至少有一个情绪词。是的话返回 { key, tail }（key 是情绪词排序后拼起来的，比「和前一个分句一样」用），不是 null。 */
function emotionOf(cue, cueLanguage) {
  const vocabulary = vocabularyOf(cueLanguage);
  const words = cueWords(cue).map((word) => word.toLowerCase());
  const emotions = words.filter((word) => !TAIL_WORDS[vocabulary].includes(word));
  if (emotions.length === 0 || !emotions.every((word) => EMOTION_WORDS[vocabulary].includes(word))) return null;
  return { key: [...emotions].sort().join('\u0000'), tail: words.length !== emotions.length };
}

/** 去掉「情绪和前一个分句一样、又没有尾音」的那条（见文件头「拼」）。一个分句只看它第一条情绪；词表以外的提示、一下子的声音不算情绪，不去。 */
function withoutRepeatedEmotions(cues, clauseOf, cueLanguage) {
  const emotionOfClause = new Map();
  for (const cue of cues) {
    const emotion = emotionOf(cue.cue, cueLanguage);
    if (emotion !== null && !emotionOfClause.has(clauseOf(cue.at))) emotionOfClause.set(clauseOf(cue.at), { ...emotion, cue });
  }
  const repeated = new Set();
  for (const [clause, emotion] of emotionOfClause) if (!emotion.tail && emotionOfClause.get(clause - 1)?.key === emotion.key) repeated.add(emotion.cue);
  return cues.filter((cue) => !repeated.has(cue));
}

/**
 * 把听出来的提示和量出来的标记拼进逐字稿（规则见文件头「拼」）。纯计算，字一个不动。
 * @param {string} text 逐字稿
 * @param {{ at: number, cue: string }[]} cues 三次取一致以后的提示
 * @param {{ pauses: { at: number, mark: string }[], paces: { at: number, mark: string }[], clauseStarts: number[] } | null} points 量出来的（lib/point-measure.mjs）；量失败是 null
 * @param {string} [cueLanguage] 用哪份词表认情绪（en 用英文，别的用中文）
 * @returns {{ annotatedText: string | null, cues: number }} 一条提示也没有、也没有量出来的标记时 annotatedText 是 null；cues 是写进去的提示条数（听出来的，不算量出来的标记）
 */
export function assembleAnnotation(text, cues, points, cueLanguage) {
  const clauseStarts = points === null ? clauseStartsOf(text) : points.clauseStarts;
  const clauseOf = clauseFinder(text, clauseStarts);
  // 情绪、尾音挪到分句开头（一下子的声音、词表以外的提示留在原处）。Array.prototype.sort 是稳定的，挪到同一处的照原来的次序
  const snapped = cues.map((cue) => (clauseStarts.length > 0 && isDeliveryCue(cue.cue, cueLanguage) ? { at: clauseStarts[clauseOf(cue.at)], cue: cue.cue } : cue)).sort((a, b) => a.at - b.at);
  const kept = withoutRepeatedEmotions(snapped, clauseOf, cueLanguage);
  // 一处的次序：停顿、一下子的声音、情绪和别的提示、快慢。这一处听出来的提示都认得（声音、情绪）才把声音调到前面，否则保持回答里的次序
  const ranked = kept.map((cue) => ({ at: cue.at, cue: cue.cue, rank: 2 }));
  for (const at of new Set(ranked.map((entry) => entry.at))) {
    const here = ranked.filter((entry) => entry.at === at);
    if (here.every((entry) => SOUND_CUES.includes(entry.cue) || emotionOf(entry.cue, cueLanguage) !== null)) for (const entry of here) if (SOUND_CUES.includes(entry.cue)) entry.rank = 1;
  }
  const marks = points === null ? [] : [...points.pauses.map((mark) => ({ at: mark.at, cue: mark.mark, rank: 0 })), ...points.paces.map((mark) => ({ at: mark.at, cue: mark.mark, rank: 3 }))];
  const all = [...marks, ...ranked];
  if (all.length === 0) return { annotatedText: null, cues: 0 };
  // Array.prototype.sort 是稳定的：同一处、同一档的照放进去的次序
  all.sort((a, b) => a.at - b.at || a.rank - b.rank);
  return { annotatedText: spliced(text, all), cues: kept.length };
}

/** 去掉方括号提示（校验用：拼好的提示标注去掉提示，必须和 text 同样去掉提示以后一字不差）。 */
const withoutBrackets = (text) => text.replace(/\[[^[\]\r\n]*\]/gu, '');

/**
 * 问一次，整理成下面三种之一（规则见文件头）：
 *   { stop }      被服务商拦下：这一段不再问，stop 是作废的状态
 *   { failure }   这一次不算（回答读不懂、收音校验没过、提示一条都对不上、没正常结束、问满了还是暂时出错），failure 是这一次如果只问一次时的状态
 *   { hearing }   能用的一次：{ places, dropped, name?, model? }
 */
async function listenOnce(listen, parts, text, { maxErrorRate, attempts, wait, onRetry, nameLanguage }) {
  let outcome;
  try {
    // 暂时出错就按 lib/call-attempts.mjs 的规则再问；问满了还是暂时出错返回 { error }。别的错不重试，下面接
    outcome = await callWithRetries(() => listen({ parts }), { attempts, wait, onRetry });
  } catch (error) {
    // 被服务商拦下：同一段录音再问还是被拦，作废，这一段停
    if (isVoicePackError(error, 'provider_blocked')) return { stop: { status: 'voided', reason: 'provider_blocked', ...(typeof error.details?.model === 'string' ? { model: error.details.model } : {}) } };
    // 回答没正常结束或是空的：这一次不算
    if (isUnusableAnswer(error)) return { failure: { status: 'voided', reason: 'annotation_answer_unusable', ...unusableDetails(error) } };
    throw error;
  }
  if ('error' in outcome) return { failure: { status: 'not_heard', error: summarizeError(outcome.error), attempts: outcome.attempts } };
  const reply = outcome.result;
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', 'text_missing', '必须返回 { text: 字符串, model?: 字符串 }');
  const model = typeof reply.model === 'string' ? { model: reply.model } : {};
  let answer;
  try {
    answer = parseAnnotationAnswer(reply.text);
  } catch (error) {
    if (isVoicePackError(error, 'annotation_answer_invalid')) return { failure: { status: 'voided', reason: 'annotation_answer_invalid', problem: error.details.reason, ...model } };
    throw error;
  }
  const errorRate = openingErrorRate(text, answer.opening);
  if (errorRate > maxErrorRate) return { failure: { status: 'voided', reason: 'listening_check_failed', errorRate, ...model } };
  // 要了名字、模型也给了才带（整理过的，见 nameOf）
  const name = nameLanguage === undefined ? undefined : nameOf(answer.name);
  const named = name === undefined ? {} : { name };
  const { places, dropped } = placeCues(text, answer.cues, answer.opening);
  if (answer.cues.length > 0 && places.length === 0) return { failure: { status: 'voided', reason: 'cues_unmatched', ...(dropped === 0 ? {} : { droppedCues: dropped }), ...model } };
  return { hearing: { places, dropped, ...named, ...model } };
}

/**
 * 给一段录音标提示标注。规矩和返回见文件头。
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ audio: {bytes: Uint8Array, mimeType: string}, text: string }} segment text 是这段录音的逐字稿：去掉开头几个词交给模型，收音校验、拼提示标注都用它
 * @param {{ maxErrorRate?: number, attempts?: number, wait?: (ms: number) => Promise<void>, onRetry?: (info: { attempt: number, waitMs: number, error: Error }) => void, nameLanguage?: 'zh' | 'en', cueLanguage?: string, measure?: () => Promise<object> }} [options]
 *   attempts 每一次听最多问几次（1 以上的整数，默认 1：不重试）；wait、onRetry 同 lib/call-attempts.mjs 的 callWithRetries；
 *   nameLanguage 给了就在同一次里要一个短名字，用这种语言写（见文件头），不给就不要；cueLanguage 情绪词表和快慢标记用哪种语言，不给就同 nameLanguage（素材给了标签时 nameLanguage 不给，cueLanguage 要单独给）；
 *   measure 量这段录音（通常是 lib/point-measure.mjs 的 measurePoints），三次听够了才调，不给就不量（这段只用听的结果）
 * @returns {Promise<object>} 见文件头
 */
export async function annotateSegment(env, segment, { maxErrorRate = DEFAULT_MAX_ERROR_RATE, attempts = 1, wait, onRetry, nameLanguage, cueLanguage = nameLanguage, measure } = {}) {
  if (nameLanguage !== undefined && !Object.hasOwn(NAME_WORDS, nameLanguage)) throw new TypeError(`nameLanguage 要是 ${Object.keys(NAME_WORDS).join('、')} 之一，或者不给，收到 ${JSON.stringify(nameLanguage)}`);
  const listen = requireCapability(env, 'audio-text-to-text');
  const parts = [{ text: annotationPrompt(nameLanguage, cueLanguage) }, { text: `逐字稿：${shownTranscript(segment.text)}` }, { text: '录音：' }, { audio: segment.audio }];
  const hearings = [];
  let firstFailure = null;
  let asked = 0;
  for (let pass = 0; pass < LISTEN_PASSES; pass++) {
    asked += 1;
    const outcome = await listenOnce(listen, parts, segment.text, { maxErrorRate, attempts, wait, onRetry, nameLanguage });
    if ('stop' in outcome) return { ...outcome.stop, listens: hearings.length, measured: false, asked, chunks: 0 };
    if ('failure' in outcome) {
      firstFailure ??= outcome.failure;
      continue;
    }
    hearings.push(outcome.hearing);
  }
  if (hearings.length < LISTEN_AGREE) return { ...firstFailure, listens: hearings.length, measured: false, asked, chunks: 0 };
  const cues = agreedCues(segment.text, hearings, cueLanguage);
  const measuring = measure === undefined ? { measured: false, reason: 'not_requested', chunks: 0 } : await measure();
  const measuredFields = { measured: measuring.measured === true, ...(measuring.measured === true ? {} : { measureReason: measuring.reason }) };
  const { name } = hearings.find((hearing) => hearing.name !== undefined) ?? {};
  const named = name === undefined ? {} : { name };
  const { model } = hearings.find((hearing) => hearing.model !== undefined) ?? {};
  const modelled = model === undefined ? {} : { model };
  const common = { listens: hearings.length, ...measuredFields, asked, chunks: measuring.chunks ?? 0 };
  const { annotatedText, cues: written } = assembleAnnotation(segment.text, cues, measuring.measured === true ? measuring : null, cueLanguage);
  const dropped = hearings[0].dropped;
  const droppedCues = dropped === 0 ? {} : { droppedCues: dropped };
  if (annotatedText === null) return { status: 'no_cues', ...common, ...named, ...modelled };
  // 拼好去掉方括号必须和 text 一字不差、不超过长度上限，不合就作废，退回只存逐字稿（见文件头「拼」）
  if (withoutBrackets(annotatedText) !== withoutBrackets(segment.text)) return { status: 'voided', reason: 'annotation_answer_invalid', problem: '拼出来的提示标注去掉方括号以后和逐字稿对不上', ...droppedCues, ...common, ...modelled };
  if ([...annotatedText].length > ANNOTATED_TEXT_MAX) return { status: 'voided', reason: 'annotation_answer_invalid', problem: `拼出来的提示标注超过 ${ANNOTATED_TEXT_MAX} 个字符`, ...common, ...modelled };
  return { status: 'annotated', annotatedText, cues: written, ...droppedCues, ...common, ...named, ...modelled };
}
