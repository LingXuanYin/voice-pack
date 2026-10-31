// SPDX-License-Identifier: Apache-2.0
//
// 老声音转成音色包的规则（流程层，纯数据）：迁移这件事唯一的一份实现。嵌入这个库的 app 和服务端的迁移脚本都调这里，两边不各写一份。
// 音色包出现以前存在的声音，转的时候带走两样东西：
//   参考音频和逐字文本                 -> 参考集（一段，叫 default，是默认段）
//   简介、性别、年龄段、标签、用途词   -> 配音指引（一句音色描述、音色标签、适合的场景）；标签只保留设计词表里对得上的，对不上的原样列出来，不带进包
// 头像不进包（音色包不是角色卡）；授权是账号的事，参考音频的网址在音频搬进包以后就没用了，它们都不在转出来的东西里。
//
// 这条规则和「发布时把老声音的话带进指引」（app 在发布那一步做的）取舍不同，各自成立：
//   发布   人还在屏幕前，他写的什么就带什么，词表认不出的标签也原样留着（他刚打的字，写回去他认得）
//   迁移   没人能回头看每一条，词表承认的才进指引，其余进报告让人看一眼（别家的词、早年的分类），宁可少带，不带噪声
// 所以迁移带走多少，要看设计词表认得多少：音色库里的老声音标的是库自己的一套词（沉稳、活力、冷静……），词表不认，迁移以后按它搜就搜不到。补法是补词表（vocab/design.json），
// 不是放宽这条规则；出现在 ≥1% 的声音里、又是在描述声音的词，词表都认（是规范写法，或者是意思相同的别名：库里的两个同义词换成同一个规范写法，只留一个）。
// 用途词（娱乐、叙事……）和角色、场合词（老师、都市……）不是标签，
// 对得上场景的用途词归场景（对照表 sceneUseCases 由调用方给），对不上的列进迁移报告。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑，不读文件、不联网、不用模型。
//
//   scenesOfUseCases(words, table)  用途词 -> 场景 id，外加对不上的词
//   legacyDirection(facts, options) 简介、性别、年龄段、标签、用途词 -> { direction, dropped }
//   convertLegacyVoice(voice, options)  整个声音 -> { ok: true, name, reference, direction?, dropped } 或 { ok: false, reason, message }
// languageTagOf、languageLabelOf 在 lib/language-tag.mjs：读声音的语言的页面比用得上这份规则的页面多得多，那一份不引别的东西，好带。
import scenesVocabulary from '../vocab/scenes.json' with { type: 'json' };
import { lookupDesignTag, lookupScene, MAX_DESCRIPTION, MAX_SCENES, MAX_TAGS } from './design-vocab.mjs';
import { languageTagOf } from './language-tag.mjs';

export { languageLabelOf, languageTagOf } from './language-tag.mjs';

/** 老声音的参考集里那一段的名字：只有一段录音，所以它就是默认段。 */
export const LEGACY_SEGMENT_ID = 'default';

/** 迁移出来的第一个版本的变更说明（包库对第一个版本的默认说明是「首个版本」，那不说它从哪儿来；社区页上要看得出来）。 */
export const LEGACY_CHANGELOG = '从旧版声音迁移而来';

/**
 * 清单的长度限制（按码点数）：一段参考的逐字文本、名字、一个标签（protocol/schema/manifest.schema.json）。
 * 这几个数本来该从协议核心的 MANIFEST_SCHEMA 上读，可这一份要在 app 的每个页面上跑，读 schema 得把它整份（三十多 KB）带进首屏；
 * 所以这里写死，要和 schema 里的数保持一致。
 */
const MAX_TEXT = 2000;
const MAX_NAME = 100;
const MAX_LABEL = 64;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const clip = (text, max) => [...text].slice(0, max).join('');
/** 字符串列表里每个非空白的字符串，去两头的空白（别的东西忽略）。 */
const wordsOf = (value) => listOf(value).filter((word) => typeof word === 'string').map((word) => word.trim()).filter((word) => word !== '');

// ---------------------------------------------------------------- 用途词 -> 场景

const SCENES = scenesVocabulary.scenes;

/** 这个用途词指向这个场景吗？三种指法：产品的对照表里写着；是词表里这个场景自己的写法（id、中文名、英文名）；是场景中文名的一部分（两个字符起，一个字碰上的太多）。 */
const pointsAt = (word, [id, zh], useCases) => useCases.includes(word) || lookupScene(word) === id || ([...word].length >= 2 && zh.includes(word));

/**
 * 用途词（app 一直问的「旁白、播报」这些）-> 场景 id，次序跟着场景词表，每个场景一个；对不上任何场景的词原样列在 `unmatched`（去了重复、两头空白，次序照传进来的），
 * 迁移报告要能说清哪些词没带走。不是字符串的、空白的忽略。
 * `table` 是产品自己的对照表（`sceneUseCases`：场景 id -> 用途词）。「旁白」对「有声书」这类产品自己的约定不写进这里，
 * 由调用方给；不给就只认词表自己的写法和场景名字里的词。
 */
export function scenesOfUseCases(words, table) {
  const useCases = isObject(table) ? table : {};
  const found = new Set();
  const unmatched = [];
  for (const word of new Set(wordsOf(words))) {
    const hits = SCENES.filter((scene) => pointsAt(word, scene, wordsOf(useCases[scene[0]])));
    if (hits.length === 0) unmatched.push(word);
    for (const [id] of hits) found.add(id);
  }
  return { scenes: SCENES.map(([id]) => id).filter((id) => found.has(id)), unmatched };
}

// ---------------------------------------------------------------- 配音指引

/**
 * 简介、性别、年龄段、标签、用途词 -> 配音指引，和没带走的东西（`dropped: { tags, useCases }`，写的是原文，好让人知道是哪个词）。
 *   音色描述   简介，去两头空白，最长 500 个字符（按码点切）
 *   音色标签   性别、年龄段、标签，按这个次序，设计词表认得的换成规范写法（男声 -> male、温暖 -> warm），同一个标签只留一个，最多 32 个；超过 32 个的列进 dropped.tags
 *             （带走多少是上限说了算，丢了什么要看得见）。设计词表认不得的，`options.unknownTags` 说怎么办：
 *               'drop'（默认，迁移用）  不带，列进 dropped.tags；先当用途词再看一遍（老声音的自由填标签里混着「旁白」这类词），指向场景的成为场景，不算丢
 *               'keep'（发布表单用）    原样留着（一个标签最长 64 个字符，更长的列进 dropped.tags），也不当用途词看：人刚打的字，写回去他认得
 *   场景       用途词指向的场景（scenesOfUseCases；`options.sceneUseCases` 是它的对照表）
 * 没有一样可说的，`direction` 是 undefined：不做一份空指引。形状不对的输入（标签不是数组、元素不是字符串）忽略，不抛错，不改传进来的东西。
 */
export function legacyDirection(facts, options = {}) {
  const voice = isObject(facts) ? facts : {};
  const keep = options?.unknownTags === 'keep';
  const written = []; // 带走的标签，按次序，每个是 [写进包的样子, 原文]
  const dropped = { tags: [], useCases: [] };
  const drop = (list, word) => { if (!list.includes(word)) list.push(word); };
  const strangers = []; // 词表认不得、也不留的标签：再当用途词看一遍

  const take = (word, mayBeScene) => {
    const form = lookupDesignTag(word) ?? (keep ? word : null);
    if (form === null) (mayBeScene ? strangers : dropped.tags).push(word);
    else if ([...form].length > MAX_LABEL) drop(dropped.tags, word);
    else if (written.every(([known]) => known !== form)) written.push([form, word]);
  };
  for (const word of wordsOf([voice.gender, voice.ageGroup])) take(word, false);
  for (const word of wordsOf(voice.tags)) take(word, true);

  const fromTags = scenesOfUseCases(strangers, options?.sceneUseCases);
  const fromUseCases = scenesOfUseCases(voice.useCases, options?.sceneUseCases);
  for (const word of fromTags.unmatched) drop(dropped.tags, word);
  for (const word of fromUseCases.unmatched) drop(dropped.useCases, word);
  for (const [, word] of written.slice(MAX_TAGS)) drop(dropped.tags, word);
  const tags = written.slice(0, MAX_TAGS).map(([form]) => form);
  const scenes = SCENES.map(([id]) => id).filter((id) => fromUseCases.scenes.includes(id) || fromTags.scenes.includes(id)).slice(0, MAX_SCENES);

  const description = typeof voice.description === 'string' ? clip(voice.description.trim(), MAX_DESCRIPTION) : '';
  const direction = {
    ...(description === '' ? {} : { description }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(scenes.length === 0 ? {} : { scenes }),
  };
  return { direction: Object.keys(direction).length === 0 ? undefined : direction, dropped };
}

// ---------------------------------------------------------------- 整个声音

/** 和清单里同一条规则（protocol/lib/manifest.mjs 的 BLANK_TEXT）：只有空白、控制字符、看不见的格式字符，等于没写。 */
const BLANK_TEXT = /^[\s\p{Cc}\p{Cf}]*$/u;

/**
 * 一个老声音 -> 音色包里属于这个声音的那部分。`voice` 用 app 里「我的声音」的字段名：name、transcript、language、description、gender、ageGroup、tags、useCases
 * （头像、授权、网址不看）。服务端社区文档把逐字文本放在 reference.transcript 里，调用方先把它放到 transcript 上再传进来：规则认一种形状，形状的差别不进规则。`options` 同 legacyDirection。
 *
 * 成功：`{ ok: true, name, reference, direction?, dropped }`。`reference` 是一段叫 default 的默认参考集，段里是逐字文本和语言标签，没有音频：音频怎么拿、
 * 放在包的哪个路径，是调用方的事（app 有它的上传地址，服务端要去取）。`name` 去了两头空白，最长 100 个字符。`direction` 没有可说的就没有这个字段。
 * 失败：`{ ok: false, reason, message }`，不抛错，迁移脚本一条失败不挡别的条。reason 是 no_name、no_transcript（没有文本，或文本只有空白和看不见的字符）、
 * transcript_too_long（超过清单的上限；逐字文本截了就不是逐字，所以整条不转）。
 */
export function convertLegacyVoice(voice, options = {}) {
  const old = isObject(voice) ? voice : {};
  const name = typeof old.name === 'string' ? clip(old.name.trim(), MAX_NAME) : '';
  if (name === '') return { ok: false, reason: 'no_name', message: `这个声音没有名字（name）：音色包的名字要 1–${MAX_NAME} 个字符` };
  const transcript = typeof old.transcript === 'string' ? old.transcript : '';
  if (BLANK_TEXT.test(transcript)) return { ok: false, reason: 'no_transcript', message: '这个声音没有逐字文本（transcript）：音色包的每一段参考音频都要有对应的文本' };
  const length = [...transcript].length;
  if (length > MAX_TEXT) return { ok: false, reason: 'transcript_too_long', message: `逐字文本（transcript）有 ${length} 个字符，超过清单的 ${MAX_TEXT} 个；截了就不是逐字，所以整条不转` };
  const { direction, dropped } = legacyDirection(old, options);
  return {
    ok: true,
    name,
    reference: { defaultSegment: LEGACY_SEGMENT_ID, segments: [{ id: LEGACY_SEGMENT_ID, text: transcript, tags: { language: languageTagOf(old.language, transcript) } }] },
    ...(direction === undefined ? {} : { direction }),
    dropped,
  };
}
