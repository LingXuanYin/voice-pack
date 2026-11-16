// SPDX-License-Identifier: Apache-2.0
//
// 还原度（流程层）：用两种方法量「用音色包生成的声音像不像角色本人」，按参考集的标签分组出报告。
//
//   说话人相似度  生成的录音和对应的留出录音之间的相似度，除以真人基线。
//                真人基线 = 同一个评测模型下，同一个人的真录音（参考和留出录音，标了 synthetic 的克隆不算）两两之间相似度的平均。
//   盲听         把真人录音和生成的录音打乱成 X、Y 交给能听音频的模型，不告诉它哪段是真人；
//                先让它把两段话开头的 OPENING_WORDS 个词写出来，和已知文本的开头对不上就作废（只比开头：要整段原话，现成文章会被模型的服务商拦下，见 OPENING_WORDS；
//                两边折过写法再比一次，片假名和平假名、有汉字时阿拉伯数字和汉字数字算一样，和不折的取小的，见 openingErrorRate）；
//                再问两件事（是不是同一个人；哪里像、哪里不像）；
//                换序再问一遍：同一对录音 X、Y 对调再问，模型偏向某个位置，也不会把「判成同一人的比例」推向一边。
//                这个比例能不能当分数，见下面「How to read this report」。
//
// 需要的所需能力（调用签名都写在 vocab/capability-signatures.md，这里只标注用到哪几项）：
//   @capability speaker-verification  说话人相似度、真人基线
//   @capability audio-text-to-text    盲听
// 环境缺哪一项，只有用到它的那一项报「量不了」，并点名缺的能力；别的照常。
//
// 随机数由外部注入（options.random），测试才能固定顺序；省略时用 Math.random。
//
// 报告 measureFidelity 的形状：
//   { counts, models, baseline, overall: { holdouts, speakerSimilarity, blindListening }, groups: [...], items: [...], voided: [...], notHeard: [...], noSpeech: [...] }
//   speakerSimilarity 是 { status: 'measured', n, notHeard, noSpeech, meanSimilarity, ratio }、{ status: 'not_heard', label: 'not heard', n: 0, notHeard, noSpeech }
//   （这一组的说话人相似度一条也没量出来，有没听成的）、{ status: 'no_speech', label: 'no speech', n: 0, notHeard: 0, noSpeech }
//   （这一组的每一条都量不到）或「量不了」；baseline 是 { status: 'measured', value, pairs, excluded?, model? }，excluded 是没用上的真录音
//   （嵌不出声纹的，见读法第 9 点）：[{ id, role: 'reference' | 'holdout', error }]，没有这样的就没有这一项；
//   blindListening 是 { status: 'measured', trials, voided, blocked, notHeard, asks, sameSpeakerRate, consistentRate, differences, ... }、
//   { status: 'voided', ... }（这一组的盲听全作废了）、{ status: 'not_heard', ... }（这一组的盲听一条有效的都没有，又有没听成的）或「量不了」。
//   voided 是作废的总条数；blocked 是其中被模型的服务商拦下的条数（voided 的一部分，不是另外的；读法第 5 点）。有效、作废、没听成加起来是这一组的留出录音条数。
//   「量不了」是 { status: 'unmeasurable', label: 'unmeasurable', reason, capability?, message }：缺能力时 reason 是 capability_missing，
//   capability 是缺的那一项；数据不够时 reason 写明原因（no_holdout_recordings、not_enough_real_recordings、baseline_not_positive）。
//   items 里每一条留出录音的 speakerSimilarity、blindListening，各是 { status: 'measured', ... }、{ status: 'voided', label: 'voided', error }（只有盲听；
//   error.code 说明为什么作废：listening_check_failed、blind_answer_invalid、blind_answer_unusable、provider_blocked）
//   或「没听成」{ status: 'not_heard', label: 'not heard', item, error: { code, message, details }, attempts }；盲听的没听成还带 firstX
//   （第一次问的时候放在 X 的是 'a' 真人还是 'b' 生成的，补做沿用它，顺序就不会因为补做而变）；
//   说话人相似度还可能是「量不到」{ status: 'no_speech', label: 'no speech', item: 'speaker-similarity', which: 'generated' | 'holdout', error }
//   （哪一段嵌不出声纹，error 是能力报错的原样；没有 attempts，不能补做）。
//   voided、notHeard、noSpeech 是把各条里作废的、没听成的、量不到的摘出来的清单（notHeard 的每个元素是 { id, item, error, attempts }，
//   noSpeech 的是 { id, item, which, error }）。
//   补做：planRedo 算要补做哪几项、各要调用多少次；redoNotHeard 只对没听成的那几项重新调用，合并成一份新报告，形状同上。
//   每一项的含义见各函数的说明；怎么读这些数，见下面「How to read this report」。库只给数，不设门槛，也不替人下「像不像」的结论。
//
// 显示报告（命令行、app）：lib/fidelity-reading.mjs 的 readReport(report) 把报告变成「要显示什么」的结构（每一组和总体的比值，判成同一人的次数、条数和档，
//   能不能下结论，作废、没听成、量不到各几条，模型说出来的区别原话，补做要调几次），READING_NOTES 是读法每一点的显示用语。
//   读法的规则只在那里程序化一次：命令行（cli/fidelity-report.mjs 的 renderFidelityReport）和 app 都从它显示，不各写一份阈值。
//
// How to read this report (the reading is written only here; the places that display the report, the command line and the app, follow it, and the program for its rules is lib/fidelity-reading.mjs. The reading was calibrated on public corpora; the calibration record is not released with the base part, and what is written below are the numbers in that record;
//   the numbers of points 1, 5, 7 and 8 are from the run of 2026-11-01: blind listening with the current question (BLIND_PROMPT), group K twice, group M once, clones once;
//   older numbers (2026-10-14, 2026-10-19, the old question and the old prompt) are carried only where it says "old record"):
//   The reading sets no threshold: a pack with a low score can still be published, and no score is hidden. The three tiers below are only a way of reading and block nothing.
//   Blind listening gives three things: the "proportion judged the same person" (this version of the question does not separate the cases, so only the counts of asks and trials are listed; it is not read as a score or as a tier, point 1); the "proportion of the two asks that agree" is not a score (point 3); the "where it is alike, where it is not" words are not counted or scored (point 4).
//   1. The proportion judged the same person (sameSpeakerRate). A group of held-out recordings is read together (each group by label in the report, and the whole, is one group):
//        Fewer than 5 valid held-out recordings: list only the proportion and the count of trials, and write "too few trials, no conclusion".
//        The lines of the three tiers: a proportion >= 0.7 is "judged the same person"; a proportion <= 0.3 is "judged not the same person"; in between is "uncertain".
//        "Uncertain" is counted neither as good nor as bad; read it together with the ratio of speaker similarity and the differences the model said (its own words).
//        When displaying, give the counts of asks and trials (for example "9/10 asks, 5 trials"), not only the proportion or one word.
//      But with this version of the question the cases are not separated, so the three tiers are not used now (QUESTION_CALIBRATION in lib/fidelity-reading.mjs records the result, separable is false):
//        Group K of 2026-11-01 is real recordings with known answers: 12 pairs of the same person, 12 pairs of different people of the same language and gender (hard negatives), each pair asked twice, run twice.
//        Q1 (asks about the same person, proportion judged the same person >= 0.7) passed in both runs: 22/22 and 24/24 of the answered asks were judged the same person;
//        Q2 (asks about different people, proportion judged the same person <= 0.3) failed in both runs: 10/23 asks (0.43), 11/24 asks (0.46);
//        Q3 (AUC of each trial's score >= 0.80) passed in the first run (0.83) and failed in the second (0.79); Q4 (asks that agree across the two runs >= 0.8) passed (0.98);
//        Q5 (the answer is the same after the two asks swap order; reported, does not block) 0.90 and 0.96. The hard negatives differ a lot: different people who are all Chinese female voices (12 asks over the two runs) were all judged the same person (6/6 in each run),
//        Chinese male voices 5/12, English female voices 4/12, English male voices 0/11.
//        So this item lists only the counts of asks and trials, writes "the question does not separate the cases; only counts of asks and trials are listed, no conclusion", and is not read as any of the three tiers.
//        The lines of the three tiers (0.7, 0.3, fewer than 5 valid trials) were not checked this time: they are checked only when the question separates the cases; the lines keep their values and are used after a calibration in which the question separates the cases.
//      Numbers (this run, by asks): two real recordings of the same person (group M) 23/24 asks judged the same person; different people of the same language and gender (group M, hard negatives) 8/22;
//        a clone made from the person's own reference recording, asked against the person's real recording (group M) 19/23; a clone made from someone else's reference recording, asked against the person's real recording (group M) 7/24.
//        Each group has 11 or 12 valid trials (two asks each), and each group has only 22 to 24 answered asks; one ask more or less is 4 to 5 percentage points, so do not read these as exact scores.
//      For held-out recordings of the same person, almost all answered asks were judged the same person (46 of 46 in group K, 23 of 24 in group M); different people of the same language and gender were often judged the same person too (21 of 47 in group K, 8 of 22 in group M), so the two groups cannot be told apart by this version of the question. "Judged the same person" means "did not find that it is not the same person", not "proved to be the same person": the model judges two people whose voices are very close as the same person, and speaker similarity cannot tell them apart either.
//      "Telling apart voices that differ a lot" (different people, the default voice with no reference) is a record of the old question (2026-10-14, 2026-10-19); this version was not re-measured.
//   2. There is no longer a "proportion that recognized the synthetic one": the question does not ask which is synthetic (it asks only whether it is the same person, and where it is alike and not alike). That number of the old question is not a score; do not read it as "the closer to 0.5 the better":
//      in the calibration record of the old question (2026-10-14), the number of times the model pointed at the synthetic clip was not higher than chance (32/56, Wilson 95% interval 0.44 to 0.69, which contains 0.5); around 0.5 it cannot tell a well-made clone from a model that cannot tell the two apart. This version of the question does not ask this, and the report does not list it.
//   3. The proportion of the two asks that give the same "judged the same person" (consistentRate) only says whether the judgment follows the voice or the position (the two asks both saying yes, or both saying no, count as the same). It is not read as a score, and a low value deducts nothing.
//   4. The differences the model says are its own words, for people to read; they are not counted or scored. Words like "synthetic feel" and "mechanical" are also written by the model for two real recordings (this run: of 139 valid asks with two real recordings, 4 contained such words; of 47 valid asks with one clone and one real recording, 1), so they cannot be taken as evidence that it was heard.
//   5. Voided: the upper limit of the listening check, DEFAULT_MAX_ERROR_RATE (0.3), is unchanged; the basis is in the record mentioned above.
//      The check compares only the first OPENING_WORDS words of each audio. This run (2026-11-01, collected with this prompt): 380 transcriptions (2 more asks have none: one answer was in the wrong format, one was blocked by the model's provider); the opening words of 335 matched word for word,
//      the mean error rate was 0.026 and the maximum 0.57; the 4 above 0.3 are exactly the 4 asks whose listening check failed (2 asks in the first run of group K, 2 in group M); the other 186 asks were below 0.3 on both clips.
//      The error rate with no audio was not re-measured this time (old record, 2026-10-19: 1.00, voided). The error rates with a swapped audio and with silence were measured separately; how and the numbers are not released with the base part.
//      The error rate of the opening is compared twice and the smaller one is returned: once as written, once after both sides have their writings folded (foldWritings of openingErrorRate): katakana is treated as hiragana; where this pair of texts has Han characters, Arabic numerals are treated as Han numerals (94 is 九十四;
//      where there is kana as well, Japanese writing is followed: 100 is 百, 105 is 百五; thousands-separator commas are removed first, 1,000 is 1000).
//      The numbers above were measured before this was added and were not re-measured with folded writings. The basis for adding it (2026-11-06): another listening evaluation judged with this same listening check,
//      compared as written, voided 75 of 352 asks; another 48 asks all used the same Japanese passage (the transcript written in katakana, the model writing hiragana), and 44 of them were voided.
//      After that side was relaxed (writings folded first, and a few more transcriptions of the same passage recognized; here a passage has only one known text, so only the first was done) it fell to 57 asks and 0 asks; most of the drop was clips that had been heard but written differently.
//      The numbers on that side are all read as Chinese and compared only after folding; reading Japanese as Japanese, removing thousands-separator commas, and taking the smaller against the as-written comparison are additions made here (reading Japanese 「百」「千」「百五」 as Chinese gives one or two more words, which do not match even when folded); they were not re-measured.
//      The limit, the number of opening words and the word splitting are all unchanged; a text made up from the prompt still does not pass. Between Han and kana (「何なのよ」 and 「なんなのよ」) cannot be folded and is still counted as wrong.
//      Taking the smaller means folding the writings is never worse than comparing as written, and what passed before is not voided because of it. Where folding would count more as wrong, the as-written comparison is returned, the same as before this was added:
//      the other side's writing is shorter than what is read, and every extra word read counts as wrong. A number of 5 or more digits is read digit by digit, and the other side writes 「一万」 or 「两万」 (known text 「3万円もするの？」, the model writing 「30000円もするの」,
//      folded 0.857, as written 0.286, returned 0.286); a Chinese 「千元」 that does not write 「一」 (1000 is read as 一千, one more word: 「花了千元买了一个蛋糕」, folded 0.286, as written 0.143);
//      after folding, a number takes a different number of words, so the characters that the first OPENING_WORDS words reach change, and when cue annotations are marked the comparison may reach the part that was handed to the model (a Japanese 「１，０００」 as written is two words 「1」「000」, folded it is one 「千」; see afterOpening);
//      the model wrote, as it truly heard, only the words that were removed, and the as-written comparison misses none.
//      The count of voided asks is reported on its own and enters none of the proportions above. There are four causes of voiding, told apart in error.code: the listening check did not pass (listening_check_failed),
//      the answer is not the fixed format (blind_answer_invalid), the answer did not end normally or is empty (blind_answer_unusable: truncated, interrupted by an error, no text; the capability marks details.unusable), the answer was blocked by the model's provider (provider_blocked). The blocked ones are also counted separately (blocked, a part of voided),
//      saying that they were blocked, not written as "not JSON": the provider blocked this ask for this recording, and asking again is most likely blocked again (old record, the old whole-transcription prompt, 2026-10-14: asking the same recordings once more,
//      46 of the 49 asks blocked last time were blocked again; 9 of the 261 asks that had succeeded last time were blocked this time), so it is recorded as voided, not as not heard, and redoing it most likely does not help.
//   6. Not heard: when the blind listening or the speaker similarity of an item meets a service error (upstream 5xx, gateway timeout, network error, timeout), that item is recorded as "not heard" and reported on its own:
//      it is not the same as voided (voided is when the model listened and did not hear; not heard is when the ask was never made), and neither enters any proportion or counts as a low score.
//      When displaying, write the count, for example "2 of 5 not heard, can be redone", then list which ones, what error, and how many tries; with fewer than 5 valid, follow point 1: list only the proportion and the count of trials,
//      write "too few trials, no conclusion", and read again after the redo. A not heard can be redone: the library does not retry by itself (creating a task and completing it may already have been billed),
//      the caller asks explicitly (redoNotHeard, `--redo` on the command line), only the not-heard items are called again, and the number of calls is written beforehand (planRedo).
//   7. The ratio of speaker similarity is itself the score, displayed as it is (1 means as alike as the person's own real recordings are to each other). This run (2026-11-01) the ratios of the 12 items in each group of group M, median (minimum to maximum):
//      two real recordings of the same person (group M) 1.09 (0.87 to 1.22); different people of the same language and gender (group M) 0.32 (0.01 to 0.59);
//      a clone from the person's own reference recording (group M) 0.95 (0.70 to 1.16); a clone from someone else's reference recording (group M) 0.21 (0.05 to 0.74).
//      The ratios for character voices (point 8) this run (2026-11-01 UTC), also median (minimum to maximum): two real recordings of the same character (6 items) 1.05 (0.87 to 1.23);
//      two real recordings of different characters (6 items, gender not labelled, not restricted) 0.37 (0.20 to 0.56); a clone from this character's reference recording (12 items) 0.94 (0.37 to 1.08);
//      a clone from another character's reference recording (12 items) 0.28 (0.10 to 0.82). The labels are the dataset's and were not checked.
//      Ranked by ratio, the 6 items of the same character are all above the 6 of different characters (AUC 1.00); clones from this character's reference are above clones from another character's reference (12 against 12, AUC 0.97).
//      These two AUCs are only descriptions: the samples are small, there is no calibrated line, and they are not taken as a boundary of "alike or not".
//      The two methods are not merged into one total score; when the two do not agree, both are listed as they are and one is not chosen for the reader.
//   8. Scope: the calibration used read-aloud corpora (the Chinese AISHELL-1 test set and the English LibriSpeech clean validation set, 6 people each, 8 clips each), one clone model (one reference clip), and one listener model; which two are written in the record;
//      this run each group of group M had 11 or 12 valid items (blind listening, by items). If the synthesis model, the listener or the type of corpus changes, it has to be calibrated again, and these points of the reading cannot be copied.
//      Character voices are another kind of corpus: the AnimeVox dataset on Hugging Face (English anime dubbing; the labels are the dataset's and were not checked). From the first 3 shards (of 7), the 6 characters with the most qualified clips,
//      qualified clips being real recordings of 4.5 seconds or more, with non-empty transcripts and no sensitive words: Frieren, Rin Tohsaka, Marin Kitagawa, Makima, Homura Akemi, Fern; 8 clips for each character (1 reference, 2 held out, 5 the rest).
//      Blind listening lists only the counts of asks (each item is asked twice; the question does not separate the cases, point 1): the same character 12/12 asks judged the same person, different characters 6/12, clones from this character's reference 21/24, clones from another character's reference 13/24.
//      This group can only be read by its numbers; there is no calibrated line, and it cannot be used to judge whether a pack is like the person; to use it that way, first calibrate with more characters and items, then use it with the reading above.
//   9. No speech: for the speaker similarity of one item, the generated recording or the held-out recording has no speech from which a voiceprint can be embedded (too short to embed, nearly silent; speaker verification reports
//      capability_input_invalid, details.problem is no_speech, written as in vocab/capability-signatures.md). This is that recording's own matter, not a broken environment and not a service error: the speaker similarity of that item is recorded as "no speech",
//      saying whether it is the generated or the held-out recording and giving the capability's own words, and reported on its own, entering no proportion and not counting as a low score. Unlike "not heard", measuring the same recording again gives the same result, so it cannot be redone (neither planRedo nor redoNotHeard counts it);
//      unlike "unmeasurable", it is only one recording of one item, the other items are measured as usual, and the whole report is produced as usual. When displaying, write the count and which items, for example "1 of 6 items no speech".
//      When a held-out real recording cannot be embedded itself, the real-person baseline does not use it either (baseline.excluded in the report records it); when the remaining real recordings cannot form one pair, the speaker similarity as a whole is "unmeasurable".
//   10. Packs of design origin (options.designSource of measureFidelity is true; the manifest has designSource when the pack was made). Their material is not real-person recordings, so the reading is different:
//      the baseline is how consistent the designed voice is with itself across several syntheses (the mean similarity between each pair of syntheses of the same designed voice), and the ratio says "how consistent what is synthesized with this pack is with the designed voice itself",
//      not how much it sounds like some real person. So the three tiers of point 1 do not apply to it: the "proportion judged the same person" of blind listening is listed as counts (asks, trials), not read as a tier, no conclusion is drawn, and "the three-tier reading does not apply" is written.
//      With fewer than 5 valid held-out recordings the counts are listed as well, and no hint to add material is given (a pack of design origin gets no hint about held-out recordings, see designSource at the head of material-hints).
//      Where the manifest has no designSource, it is read as real-person recordings (points 1 to 9 as before): whether it is of design origin cannot be told, and no guess is made.
//
// 抛出的错误（code 小写下划线，details 里放什么在抛出处写明）：
//   fidelity_input_invalid         输入不是约定的形状（补做时，上一次的报告不是 measureFidelity 出的形状、或要补做的留出录音不在输入里，也是它）。
//                                  details.field 是出问题的字段，上一次的报告里的字段从 previous 起写
//   fidelity_text_empty            已知文本里一个词也没有，没法拿它核对转写。details.field
//   listening_check_failed         收音校验没过：模型写出来的开头和已知文本的开头对不上，说明它没听到。这次盲听作废
//   blind_answer_invalid           模型的回答不是固定格式，解析不了，不猜。这次盲听作废
//   blind_answer_unusable         模型的回答没有正常结束（截断、出错中断）或是空的：适配器标了 details.unusable，这里转成这个码。这次盲听作废，不补做（同一段录音再问也可能还是这样，而且每问一次都花钱）。details 有 order、problem（stop_reason 或 text_missing）、stopReason、model
//   provider_blocked               回答被模型的服务商拦下了。这个码是能力抛的（适配器认服务商的原话，写法见 vocab/capability-signatures.md 的 audio-text-to-text 一节），
//                                  库只认这个码；blindListen 原样往上抛，measureFidelity 和 redoNotHeard 接住它，那一条盲听记成作废（读法第 5 点），不往外抛
//   capability_result_invalid      所需能力的返回不是约定的形状。details.capability
//   evaluation_model_mismatch      同一次评测里同一项能力给出了不止一个模型（补做时和上一次的不一样也算）。details.capability、details.models
//   baseline_needs_two_recordings  真人基线要同一个人至少两段真录音。details.recordings 是能用的段数（嵌不出声纹的不算），
//                                  去掉过真录音的话 details.excluded 是被去掉的（measureFidelity 接住它，说话人相似度整体报「量不了」，不往外抛）
//   另外 capability_missing、audio_clip_invalid 来自 protocol/lib/env.mjs、protocol/lib/audio-clip.mjs。
//   能力在 details.transient 里标了「服务暂时出错」的错（见 vocab/capability-signatures.md「General conventions」），measureFidelity 和 redoNotHeard 不抛，
//   记成「没听成」；能力报「这段录音里没有能嵌的语音」的标准错误（读法第 9 点），同样不抛，记成「量不到」；
//   别的错（401、返回的形状不对、别的写法的 capability_input_invalid、普通的 Error……）原样往上抛，一条也不吞。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { reportable } from '../protocol/lib/scrub.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { isServiceError, isUnusableAnswer, summarizeError, badResult } from './capability-calls.mjs';

const isWordChar = /[\p{L}\p{N}\p{M}]/u;
const isSeparator = /[\p{P}\p{S}\p{Z}\p{C}]/u;
const isCjkChar = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
// 撇号：直的、弯的（U+2019）、修饰字母撇号（U+02BC）。特殊字符用码位拼，不在源码里直接写。
const APOSTROPHES = [0x27, 0x2019, 0x2bc].map((code) => String.fromCharCode(code));
const LONE_MARKS = /^\p{M}+$/u;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (numbers) => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;

// ---------------------------------------------------------------- 共用的小函数

const invalid = (field, message) => new VoicePackError('fidelity_input_invalid', message, { details: { field } });

/**
 * 同一次评测只能用同一个评测模型：不同模型给的分数和判断不能互相比，拿它们做除法、算比例没有意义。
 * @param {string} capability
 * @param {Set<string>} models 这次评测里这项能力报出过的模型名
 * @throws {VoicePackError} evaluation_model_mismatch：出现了不止一个模型名。details.capability、details.models
 */
function assertSingleModel(capability, models) {
  if (models.size > 1) {
    throw new VoicePackError('evaluation_model_mismatch', `${capability} returned more than one model in the same evaluation (${[...models].join(', ')}); their results cannot be compared with each other`, {
      details: { capability, models: [...models] },
    });
  }
}

// ---------------------------------------------------------------- 文本比较（收音校验用）

/**
 * 文本规范化并分词：全角转半角、转小写；标点、符号、空白都只当分隔；撇号直接去掉（don't 就是 dont）。
 * 中文（汉字）和日文假名每个字一个词，其余文字（字母、数字）连在一起算一个词。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeTranscript(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const tokens = [];
  let word = '';
  for (const ch of normalized) {
    if (APOSTROPHES.includes(ch)) continue;
    if (isSeparator.test(ch)) {
      if (word) tokens.push(word);
      word = '';
    } else if (isCjkChar.test(ch)) {
      if (word) tokens.push(word);
      word = '';
      tokens.push(ch);
    } else if (isWordChar.test(ch)) {
      word += ch;
    } else if (word) {
      tokens.push(word);
      word = '';
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 转写和已知文本的错误率：规范化分词后，编辑距离（替换、漏掉、多出各算一个）除以已知文本的词数。可以超过 1。
 * @param {string} reference 已知文本
 * @param {string} hypothesis 模型转写出来的文本
 * @returns {number}
 * @throws {VoicePackError} fidelity_input_invalid（不是字符串）、fidelity_text_empty（已知文本里一个词也没有，没法比）
 */
export function transcriptErrorRate(reference, hypothesis) {
  const { expected, heard } = tokenizePair(reference, hypothesis);
  return editDistance(expected, heard) / expected.length;
}

/**
 * 核对两个输入都是字符串、已知文本里至少有一个词，分好词交回。transcriptErrorRate 和 openingErrorRate 共用；
 * fold 为真时分词之前两边先折写法（foldWritings，只有 openingErrorRate 这样做）。
 */
function tokenizePair(reference, hypothesis, { fold = false } = {}) {
  for (const [name, value] of [['reference', reference], ['hypothesis', hypothesis]]) {
    if (typeof value !== 'string') throw invalid(name, `${name} must be a string`);
  }
  const [known, written] = fold ? foldWritings(reference, hypothesis) : [reference, hypothesis];
  const expected = tokenizeTranscript(known);
  if (expected.length === 0) throw new VoicePackError('fidelity_text_empty', 'The known text has no words (it is empty or only punctuation), so there is nothing to check the transcription against');
  return { expected, heard: tokenizeTranscript(written) };
}

const HAN = /\p{Script=Han}/u;
// 假名（平假名、片假名）。用 Script 不用 Script_Extensions：长音符号「ー」、中点「・」这类两边共用的符号不算
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
// 片假名 U+30A1（ァ）到 U+30F6（ヶ），减 0x60 就是对应的平假名；用码位拼出来，写明是哪一段码位
const KATAKANA = new RegExp(`[${String.fromCharCode(0x30a1)}-${String.fromCharCode(0x30f6)}]`, 'gu');
const DIGIT_NAMES = '零一二三四五六七八九';
const PLACE_NAMES = ['千', '百', '十', ''];
// 带千分位逗号的数（NFKC 以后，全角的「，」也是「,」）：1 到 3 位，后面每个逗号跟着正好 3 位（1,000、12,345,678）
const GROUPED_DIGITS = /(?<![0-9])[0-9]{1,3}(?:,[0-9]{3})+(?![0-9])/g;

/**
 * 一串阿拉伯数字的汉字读法：0 到 9999 照读法，更长的、或者以 0 开头的（0094）逐位读（一二三四五、零零九四）。
 * 0 到 9999 分中文、日文两种写法：
 *   中文（japanese 为假）：94 是九十四，105 是一百零五，10 是十，110 是一百一十；
 *   日文（japanese 为真）：十、百、千前面不写「一」，中间隔着 0 也不写「零」：100 是百，1000 是千，105 是百五，110 是百十，1010 是千十。
 * @param {string} digits 只有 0-9
 * @param {{ japanese?: boolean }} [options]
 * @returns {string}
 */
function numberReading(digits, { japanese = false } = {}) {
  if (digits.length > 4 || (digits.length > 1 && digits[0] === '0')) return [...digits].map((digit) => DIGIT_NAMES[digit]).join('');
  if (Number(digits) === 0) return DIGIT_NAMES[0];
  let out = '';
  let gap = false; // 读过的数后面隔着 0：中文在下一个不是 0 的位前面读一个「零」，日文不读
  [...digits.padStart(4, '0')].forEach((digit, place) => {
    if (digit === '0') {
      gap = out !== '';
      return;
    }
    if (gap && !japanese) out += DIGIT_NAMES[0];
    gap = false;
    // 「一」后面跟着十、百、千的：中文只省掉开头「一十」的「一」（10、15 是十、十五；110 是一百一十），日文都省掉（百、千、百十）
    const silentOne = digit === '1' && place < 3 && (japanese || (place === 2 && out === ''));
    out += (silentOne ? '' : DIGIT_NAMES[digit]) + PLACE_NAMES[place];
  });
  return out;
}

/**
 * 收音校验比开头的时候，两边折一下写法再比一次：同一句话写法不同，不算没听到。只在比的时候折，原文（包里的逐字稿、报告）不动。
 *   - 先 NFKC（半角片假名变全角，全角数字变半角）；
 *   - 片假名折成平假名（U+30A1–U+30F6 减 0x60：「コンニチニャ」就是「こんにちにゃ」）；长音符号「ー」不动；
 *   - 这一对文字里有汉字（已知文本和模型写的，有一边有就算），两边的阿拉伯数字都读成汉字数字（numberReading），千分位逗号先去掉（1,000 就是 1000，不然读成「一」「零零零」）。
 *     按这一对算、不按每一边各算：已知文本「3じにあいましょう」、模型写「三時に会いましょう」，两边的 3 都读成「三」，错 2 个字（0.286）；
 *     只折有汉字的那一边，3 和三对不上，错 3 个（0.429）。
 *     这一对里还有假名的（同样有一边有就算）照日文的写法读（「100円」就是「百円」，105 是百五），没有的照中文读（「94岁」就是「九十四岁」，105 是一百零五）。
 *     日文照中文读的话，「百」「千」「百五」读出来多一两个词，折了也对不上（已知文本「100円か1000円で買えるよ」、模型写「百円か千円で買えるよ」：照中文读 0.571，不折 0.286，照日文读 0）。
 * 折不了的照旧算错：汉字和假名之间（「何なのよ」和「なんなのよ」）；两边都没有汉字的文字（英文等）不折数字（「94」和「ninety-four」）；
 * 年份这类逐位念的数（「1994年」读成「一千九百九十四」，模型写「一九九四年」）。
 * 折过反倒多算错的：另一边的写法比读出来的短，读出来多的词都算错。5 位以上的数逐位读，另一边写「一万」「两万」的
 * （已知文本「3万円もするの？」、模型写「30000円もするの」，折过 0.857，不折 0.286）；中文不写「一」的「千元」（1000 读成一千，多一个词）。
 * 所以 openingErrorRate 折过的和不折的各比一次，交回小的：这几种交回的是不折的那个，不比不折差。
 * 依据见文件头「How to read this report」第 5 点：日文的段（片假名、平假名）和带数字的中文，模型听到了也被作废。
 * @param {string} reference
 * @param {string} hypothesis
 * @returns {[string, string]}
 */
function foldWritings(reference, hypothesis) {
  const pair = [reference, hypothesis].map((text) => text.normalize('NFKC').replace(KATAKANA, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)));
  if (!pair.some((text) => HAN.test(text))) return pair;
  const japanese = pair.some((text) => KANA.test(text));
  return pair.map((text) => text.replace(GROUPED_DIGITS, (number) => number.replaceAll(',', '')).replace(/[0-9]+/g, (digits) => numberReading(digits, { japanese })));
}

/**
 * 收音校验只看开头多少个词：模型写出录音开头的这么多个词就够，不要整段原话。
 * 为什么：现成的文章（新闻朗读、书）做的包，模型的服务商会拦下「把整段原话写出来」的回答；
 * 只要开头几个词，同样的录音基本不再被拦。错一两个词仍然认得出「听到了」，换了音频、静音、没有音频的回答仍然过不了。
 * 7 是那次量出来的：5、6 个词只容得下错 1 个词（0.3 的线上），听到了的也常被作废；8 个词开始有回答被拦下；7 个词容得下错 2 个词，被拦下的也最少。
 */
export const OPENING_WORDS = 7;

/**
 * 开头的错误率：已知文本的头 OPENING_WORDS 个词，和模型写出来的头 OPENING_WORDS 个词，编辑距离除以已知文本这段开头的词数（已知文本不到这么多词，就是它全部的词数）。
 * 分词、算法同 transcriptErrorRate；模型多写了开头以外的话不看（写了全文也只比开头），少写了的每个词算错一个。
 * 和 transcriptErrorRate 不同的一处：比两次，交回小的那个。一次原样比；一次分词之前两边先折写法（foldWritings：片假名当平假名；这一对里有汉字的，阿拉伯数字当汉字数字，还有假名的照日文的写法），
 * 写法不同不算错。折过反倒多算错的（5 位以上的数对「一万」这类，见 foldWritings）交回的是原样比的那个，所以折写法不会比不折差。
 * 折过的那一次，数读成汉字数字以后可能占几个词（94 是「九」「十」「四」三个词），开头的 OPENING_WORDS 个词按折过的数；原样比的那一次按原文的数。
 * @param {string} reference 已知文本（整段，函数自己取开头）
 * @param {string} hypothesis 模型写出来的话（只写开头，或者写了全文，都行）
 * @returns {number} 已知文本有 OPENING_WORDS 个词以上时在 0 到 1 之间；不到这么多词时，模型多写的词也算错，可以超过 1。和 DEFAULT_MAX_ERROR_RATE 比
 * @throws {VoicePackError} fidelity_input_invalid（不是字符串）、fidelity_text_empty（已知文本里一个词也没有，没法比）
 */
export function openingErrorRate(reference, hypothesis) {
  const rate = (fold) => {
    const { expected, heard } = tokenizePair(reference, hypothesis, { fold });
    const opening = expected.slice(0, OPENING_WORDS);
    return editDistance(opening, heard.slice(0, OPENING_WORDS)) / opening.length;
  };
  return Math.min(rate(true), rate(false));
}

/**
 * 一段文字去掉开头 words 个词以后剩下的原文（标提示标注那一次，交给模型的逐字稿去掉的就是收音校验原样比的这几个词，lib/segment-annotation.mjs）。
 * 分词同 tokenizeTranscript（一个字一个字地规范化再认），切的是原文，剩下的部分一个字都不改，开头的空白和标点也留着。
 * 不折写法（openingErrorRate 比的时候才折）。openingErrorRate 原样比的那一次，比的正好是去掉的这几个词；折过的那一次，一个数占的词数变了，
 * 比的可能只是去掉的这几个词的前一部分（94 读成三个词），也可能比到没去掉的字：日文的「１，０００」原样是「1」「000」两个词，折过是一个「千」，
 * 「１，０００円と１，０００円と１，０００円、…」去掉的是「１，０００円と１，０００円」，折过的开头「千円と千円と千」后两个词出自交给模型的那一截。
 * 所以 openingErrorRate 交回两次里小的那个：模型照实只写了去掉的那几个词，原样比一个不差。
 * 不到 words 个词（或者正好 words 个），剩下的是空串。
 * @param {string} text
 * @param {number} [words] 默认 OPENING_WORDS
 * @returns {string}
 */
export function afterOpening(text, words = OPENING_WORDS) {
  const source = String(text);
  let count = 0;
  let inWord = false;
  for (let i = 0; i < source.length; ) {
    const raw = String.fromCodePoint(source.codePointAt(i));
    const next = i + raw.length;
    for (const ch of raw.normalize('NFKC').toLowerCase()) {
      if (APOSTROPHES.includes(ch)) continue;
      const cjk = !isSeparator.test(ch) && isCjkChar.test(ch);
      const word = !isSeparator.test(ch) && !cjk && isWordChar.test(ch);
      if (word) {
        inWord = true;
        continue;
      }
      if (inWord) {
        // 一个词在这个字前面结束了
        inWord = false;
        count += 1;
        if (count >= words) return source.slice(i);
      }
      if (cjk) {
        // 中文、日文一个字一个词，到这个字后面结束
        count += 1;
        if (count >= words) return source.slice(next);
      }
    }
    i = next;
  }
  return '';
}

/**
 * 一段文字里每个词在原文里的位置：分出来的词和 tokenizeTranscript 一样（一个字一个字地规范化再认，同 afterOpening；词结束时再整个规范化，分开写的附加符号并回前一个字，所以「ﾊﾟ」「か゛」「é」分得和整段规范化一样），
 * 量停顿要把块对到字上，再把标记写回原文（lib/point-measure.mjs）。
 * @param {string} text
 * @returns {{ token: string, start: number, end: number }[]} token 是规范化以后的词（和 tokenizeTranscript 给的一样）；start、end 是原文里的 UTF-16 下标（end 不含），词之间的标点、空白不在里面
 */
export function tokenSpans(text) {
  const source = String(text);
  const spans = [];
  let open = null; // 还没结束的词：{ token, start, end }
  const close = () => {
    if (open !== null) spans.push({ ...open, token: open.token.normalize('NFKC').toLowerCase() });
    open = null;
  };
  for (let i = 0; i < source.length; ) {
    const raw = String.fromCodePoint(source.codePointAt(i));
    const next = i + raw.length;
    for (const ch of raw.normalize('NFKC')) {
      if (APOSTROPHES.includes(ch)) continue;
      if (isSeparator.test(ch)) close();
      else if (isCjkChar.test(ch)) {
        close();
        spans.push({ token: ch.toLowerCase(), start: i, end: next });
      } else if (isWordChar.test(ch)) {
        if (open === null) open = { token: ch, start: i, end: next };
        else {
          open.token += ch;
          open.end = next;
        }
      } else close();
    }
    i = next;
  }
  close();
  // 单独成词的附加符号，能和紧挨着的前一个字合成一个字的，并回去（整段规范化时它们合成一个字）；合不成的留着，tokenizeTranscript 也把它当一个词
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.end === span.start && LONE_MARKS.test(span.token)) {
      const joined = (last.token + span.token).normalize('NFKC');
      if ([...joined].length < [...last.token].length + [...span.token].length) {
        last.token = joined;
        last.end = span.end;
        continue;
      }
    }
    merged.push(span);
  }
  return merged;
}

// ---------------------------------------------------------------- 盲听

/**
 * 收音校验的默认阈值：模型写出来的开头（openingErrorRate）和已知文本的开头的错误率不超过它，才算模型听到了这段音频。
 *
 * 为什么先定 0.3：听到了的模型，对干净的几秒到几十秒语音，转写错误率通常在个位数百分点到一成多（人名、数字、同音字最容易错）；
 * 没听到的模型凭提示编出来的话，和已知文本几乎全不一样，错误率接近 1 甚至更高。0.3 离前者有余量，离后者很远。
 * 短句要小心：文本比 OPENING_WORDS 个词还短时，开头就是它的全部，错两个词（6 个词里错 2 个，0.33）就超过 0.3，所以留出录音的文本不宜太短。
 * 用公开语料标定过，2026-10-19 用现在的提示（只比开头）重收了一遍，2026-11-01 又收了一遍，取值不变（依据见文件头「How to read this report」第 5 点）。
 */
export const DEFAULT_MAX_ERROR_RATE = 0.3;

/**
 * 问盲听用的提示：先让模型写出每段音频开头的 OPENING_WORDS 个词（收音校验用；要整段原话会被模型的服务商拦下，见 OPENING_WORDS 的说明），再问两件事：
 * 两段是不是同一个人，哪里像、哪里不像（后两个是原话，只存、不计数、不打分）。问法直接，不给选项、不列要比的维度、不提合成，也不写任何关于哪段是真人的信息，也不写已知文本。
 * 问法在 2026-11-01 定下，只定这一版；怎么读它的结果见文件头「How to read this report」第 1、3、4 点。
 */
export const BLIND_PROMPT = [
  '你会听到两段音频，依次标为 X 和 Y。请只根据你听到的内容回答。',
  '',
  `先写出每段音频开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词；没有听到某段音频，就把它的转写留空。`,
  '然后回答：两段是不是同一个人？哪里像，哪里不像？',
  '',
  '只输出一个 JSON 对象，不要输出别的文字。格式如下（same_speaker 是 true 或 false）：',
  '{"transcript_x": "…", "transcript_y": "…", "same_speaker": true, "where_alike": "…", "where_unlike": "…"}',
].join('\n');

// 整段回答就是一个 ``` 代码块
const FENCED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * 把模型按固定格式给的回答解析出来。整段回答必须是一个 JSON 对象（可以包在一个代码块里），字段、类型、取值都对得上；
 * 对不上就报错，不猜。
 * @param {string} reply 模型回答的文字
 * @param {number} [order] 这是第几次问，写进报错里
 * @returns {{ transcriptX: string, transcriptY: string, sameSpeaker: boolean, whereAlike: string, whereUnlike: string }}
 * @throws {VoicePackError} blind_answer_invalid：回答不符合固定格式，这次盲听作废。details.reason 说哪里不对，details.reply 是原话全文（打过码，规则见 protocol/lib/scrub.mjs），details.order 是第几次问
 */
export function parseBlindAnswer(reply, order) {
  const fail = (reason) =>
    new VoicePackError(
      'blind_answer_invalid',
      `Blind listening voided: ${order ? `on ask ${order}, ` : ''}the model's answer does not follow the fixed format (${reason}); not guessing, this one does not count`,
      { details: { ...(order ? { order } : {}), reason, reply: reportable(reply) } },
    );
  let body = String(reply).trim();
  const fenced = FENCED.exec(body);
  if (fenced) body = fenced[1].trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw fail('not JSON');
  }
  if (!isPlainObject(data)) throw fail('not a JSON object');
  for (const key of ['transcript_x', 'transcript_y', 'where_alike', 'where_unlike']) {
    if (typeof data[key] !== 'string') throw fail(`${key} must be a string`);
  }
  if (typeof data.same_speaker !== 'boolean') throw fail('same_speaker must be true or false');
  return { transcriptX: data.transcript_x, transcriptY: data.transcript_y, sameSpeaker: data.same_speaker, whereAlike: data.where_alike, whereUnlike: data.where_unlike };
}

function assertBlindClip(clip, name) {
  if (!isPlainObject(clip)) throw invalid(name, `${name} must be { audio, text, kind }`);
  assertAudioClip(clip.audio, `${name}.audio`);
  if (typeof clip.text !== 'string') throw invalid(`${name}.text`, `${name}.text must be a string (what is said in this audio)`);
  if (tokenizeTranscript(clip.text).length === 0) {
    throw new VoicePackError('fidelity_text_empty', `${name}.text has no words (it is empty or only punctuation), so there is nothing to check the transcription against`, { details: { field: `${name}.text` } });
  }
  if (clip.kind !== 'real' && clip.kind !== 'synthetic') throw invalid(`${name}.kind`, `${name}.kind must be "real" or "synthetic"`);
}

/** 核对盲听的选项，省略的用默认值。measureFidelity 也在开始前调它，免得量了一半才发现选项不对。 */
function normalizeBlindOptions(options) {
  const { random = Math.random, maxErrorRate = DEFAULT_MAX_ERROR_RATE, firstX, designSource = false } = options ?? {};
  if (typeof random !== 'function') throw invalid('random', 'random must be a function that returns a number in [0, 1)');
  if (typeof maxErrorRate !== 'number' || !Number.isFinite(maxErrorRate) || maxErrorRate < 0) throw invalid('maxErrorRate', 'maxErrorRate must be a number that is not less than 0');
  if (firstX !== undefined && firstX !== 'a' && firstX !== 'b') throw invalid('firstX', 'firstX must be "a" or "b" (which recording is placed at X on the first ask)');
  if (typeof designSource !== 'boolean') throw invalid('designSource', 'designSource must be true or false (whether the material was designed: true if the manifest has designSource, false if not; see item 10 of the header of lib/fidelity.mjs)');
  return { random, maxErrorRate, firstX, designSource };
}

/** 抽一次随机数，决定第一次问的时候哪一段放在 X：小于 0.5 是 a，否则是 b。 */
function drawFirstX(random) {
  const value = random();
  if (typeof value !== 'number' || !(value >= 0 && value < 1)) throw invalid('random', 'the injected random function must return a number in [0, 1)');
  return value < 0.5 ? 'a' : 'b';
}

/**
 * 一次盲听：把两段录音（kind 只是调用方记的，问的时候不告诉模型）打乱成 X、Y 交给 audio-text-to-text，不说哪段是真人、哪段是生成的；
 * 先让它写出两段开头的话做收音校验（只比开头 OPENING_WORDS 个词，见 openingErrorRate），再问两件事（同一个人吗；哪里像、哪里不像）；换序再问一遍。
 *
 * 结果：
 *   asks[]            每次问的记录：order（第几次）、x 和 y（是 a 还是 b）、transcripts、errorRates、sameSpeaker、
 *                     whereAlike、whereUnlike（模型说的哪里像、哪里不像，原话，不计数、不打分）、model
 *   sameSpeaker       两次问里判成同一个人的次数（0–2）
 *   consistent        两问的「同一人」判断相同（都说是，或都说不是）：换了位置，判断还跟着声音走（读法第 3 点）
 *   models            用到的模型名（能力返回里带的），给验证记录用
 *
 * @capability audio-text-to-text 签名见 vocab/capability-signatures.md：({ parts: [{ text } | { audio }], ... }) -> { text, model? }
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ a: Clip, b: Clip }} trial 两段录音。Clip = { audio: {bytes, mimeType}, text: 这段音频里说的话, kind: 'real' | 'synthetic' }
 * @param {{ random?: () => number, maxErrorRate?: number, firstX?: 'a' | 'b' }} [options] random：返回 [0, 1) 的随机数，注入它测试才能固定顺序，省略用 Math.random；
 *   maxErrorRate：收音校验的阈值，省略用 DEFAULT_MAX_ERROR_RATE；
 *   firstX：第一次问的时候放在 X 的是 a 还是 b。给了就不抽随机数（补做沿用第一次的顺序用），省略就抽一次
 * @throws {VoicePackError} capability_missing（点名缺 audio-text-to-text）、listening_check_failed、blind_answer_invalid、blind_answer_unusable（能力标了 details.unusable 的，这里转成它）、provider_blocked（能力报的，原样往上抛）、
 *   capability_result_invalid，输入不对时的 fidelity_input_invalid、audio_clip_invalid、fidelity_text_empty
 */
export async function blindListen(env, trial, options = {}) {
  if (!isPlainObject(trial)) throw invalid('trial', 'trial must be { a, b }');
  assertBlindClip(trial.a, 'a');
  assertBlindClip(trial.b, 'b');
  const { random, maxErrorRate, firstX } = normalizeBlindOptions(options);
  const first = firstX ?? drawFirstX(random);
  const listen = requireCapability(env, 'audio-text-to-text');

  const clips = { a: trial.a, b: trial.b };
  const orders = first === 'a' ? [['a', 'b'], ['b', 'a']] : [['b', 'a'], ['a', 'b']];
  const asks = [];
  for (const [index, [x, y]] of orders.entries()) {
    const order = index + 1;
    let reply;
    try {
      reply = await listen({
        parts: [{ text: BLIND_PROMPT }, { text: '音频 X：' }, { audio: clips[x].audio }, { text: '音频 Y：' }, { audio: clips[y].audio }],
      });
    } catch (error) {
      // 回答没正常结束或是空的（能力标 details.unusable）：这一次的回答不能用，这一条盲听作废（码见 unusableBlindAnswer）。别的错（服务出错、401……）原样往上抛
      if (isUnusableAnswer(error)) throw unusableBlindAnswer(order, error);
      throw error;
    }
    if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', 'must return { text: string, model?: string }');
    if (reply.model !== undefined && typeof reply.model !== 'string') throw badResult('audio-text-to-text', 'model must be a string');
    const answer = parseBlindAnswer(reply.text, order);
    // 收音校验：每一段音频开头的转写都要和它自己的已知文本的开头对得上，对不上就是模型没听到，这次作废
    const errorRates = { x: openingErrorRate(clips[x].text, answer.transcriptX), y: openingErrorRate(clips[y].text, answer.transcriptY) };
    for (const [slot, clip] of [['X', x], ['Y', y]]) {
      const errorRate = errorRates[slot.toLowerCase()];
      if (errorRate > maxErrorRate) {
        throw new VoicePackError(
          'listening_check_failed',
          `Blind listening voided: on ask ${order}, the model's transcription of the opening of audio ${slot} does not match the opening of the known text (error rate ${errorRate.toFixed(2)}, limit ${maxErrorRate}), which means it did not hear this audio`,
          { details: { order, slot, clip, errorRate, maxErrorRate } },
        );
      }
    }
    asks.push({
      order,
      x,
      y,
      transcripts: { x: answer.transcriptX, y: answer.transcriptY },
      errorRates,
      sameSpeaker: answer.sameSpeaker,
      whereAlike: answer.whereAlike,
      whereUnlike: answer.whereUnlike,
      ...(reply.model === undefined ? {} : { model: reply.model }),
    });
  }
  const models = new Set(asks.map((ask) => ask.model).filter((model) => model !== undefined));
  assertSingleModel('audio-text-to-text', models);
  return {
    asks,
    sameSpeaker: asks.filter((ask) => ask.sameSpeaker).length,
    consistent: asks[0].sameSpeaker === asks[1].sameSpeaker,
    models: [...models],
  };
}

/**
 * 回答没正常结束（截断、出错中断）或是空的（能力标 details.unusable，适配器怎么标见 adapters/README.md 第 8 点）：这一次的回答不能用，这一条盲听作废。
 * 码是 blind_answer_unusable，不是服务出错：不标 transient，不补做（同一段录音再问也可能还是这样，而且每问一次都花钱）。details 写第几次问和原因（problem、stopReason、model）。
 */
function unusableBlindAnswer(order, error) {
  const { problem, stopReason, model } = error.details ?? {};
  const why = problem === 'stop_reason' ? `did not end normally (stopReason: ${stopReason})` : 'is empty';
  return new VoicePackError('blind_answer_unusable', `Blind listening voided: on ask ${order}, the model's answer ${why}; this one does not count`, {
    cause: error,
    details: { order, ...(problem === undefined ? {} : { problem }), ...(stopReason === undefined ? {} : { stopReason }), ...(model === undefined ? {} : { model }) },
  });
}

// ---------------------------------------------------------------- 量不了

/** 报告里「这一项没量出来」的写法：不给假分数，写明原因，缺能力时点名缺的能力。 */
export const UNMEASURABLE_LABEL = 'unmeasurable';

function unmeasurable(reason, message, capability) {
  return { status: 'unmeasurable', label: UNMEASURABLE_LABEL, reason, ...(capability === undefined ? {} : { capability }), message: `${UNMEASURABLE_LABEL}: ${message}` };
}

/** 环境有没有这项能力。只认 capability_missing；环境本身不合格等其他错误照常抛出。 */
function probeCapability(env, name) {
  try {
    requireCapability(env, name);
    return { available: true };
  } catch (error) {
    if (isVoicePackError(error, 'capability_missing')) return { available: false, error };
    throw error;
  }
}

const unmeasurableForMissing = (name, error) => unmeasurable('capability_missing', error.message, name);

// ---------------------------------------------------------------- 说话人相似度

/**
 * 两段音频的说话人相似度。
 * @capability speaker-verification 签名见 vocab/capability-signatures.md：({ audio_a, audio_b }) -> { similarity, model? }
 * @param {object} env 注入的运行环境，要有 speaker-verification
 * @param {{bytes: Uint8Array, mimeType: string}} audioA
 * @param {{bytes: Uint8Array, mimeType: string}} audioB
 * @returns {Promise<{ similarity: number, model?: string }>}
 * @throws {VoicePackError} capability_missing（点名缺 speaker-verification）、audio_clip_invalid、capability_result_invalid
 */
export async function speakerSimilarity(env, audioA, audioB) {
  assertAudioClip(audioA, 'audio_a');
  assertAudioClip(audioB, 'audio_b');
  const verify = requireCapability(env, 'speaker-verification');
  const result = await verify({ audio_a: audioA, audio_b: audioB });
  if (!isPlainObject(result) || typeof result.similarity !== 'number' || !Number.isFinite(result.similarity)) {
    throw badResult('speaker-verification', 'must return { similarity: finite number, model?: string }');
  }
  if (result.model !== undefined && typeof result.model !== 'string') throw badResult('speaker-verification', 'model must be a string');
  return { similarity: result.similarity, ...(result.model === undefined ? {} : { model: result.model }) };
}

/**
 * 真人基线：同一个评测模型下，同一个人的真录音两两之间的相似度，取平均。
 * 包里有几段真录音（参考和留出录音）就都用上，两两各算一次。
 * 有一段真录音里没有能嵌声纹的语音（说话人验证报 no_speech，写法见 vocab/capability-signatures.md）：基线不用它，
 * 别的真录音两两照算，这一段记在返回值的 excluded 里（带着能力报错的原样，和 recordings 里给的 role）；发现以后不再为它调用能力。
 * @param {object} env 注入的运行环境，要有 speaker-verification
 * @param {{ id: string, audio: {bytes: Uint8Array, mimeType: string}, role?: string }[]} recordings 同一个人的真录音，至少两段。
 *   role 只是原样带进 excluded（measureFidelity 给 'reference' 或 'holdout'），库不看它
 * @returns {Promise<{ status: 'measured', value: number, pairs: { a: string, b: string, similarity: number }[], excluded?: { id: string, role?: string, error: object }[], model?: string }>}
 *   excluded 只在有没用上的真录音时才有
 * @throws {VoicePackError} baseline_needs_two_recordings（不到两段，或者去掉嵌不出声纹的以后凑不出一对。details.recordings 是能用的段数，
 *   去掉过录音的话 details.excluded 是被去掉的）、evaluation_model_mismatch、capability_missing、audio_clip_invalid、capability_result_invalid
 */
export async function humanBaseline(env, recordings) {
  if (!Array.isArray(recordings)) throw invalid('recordings', 'recordings must be an array: [{ id, audio }]');
  recordings.forEach((recording, index) => {
    if (!isPlainObject(recording) || typeof recording.id !== 'string' || recording.id === '') {
      throw invalid(`recordings[${index}].id`, `recordings[${index}] must be { id: non-empty string, audio }`);
    }
    assertAudioClip(recording.audio, `recordings[${index}].audio`);
  });
  if (recordings.length < 2) {
    throw new VoicePackError('baseline_needs_two_recordings', `The human baseline needs at least two real recordings of the same person to make a pair; only ${recordings.length} given`, { details: { recordings: recordings.length } });
  }
  const pairs = [];
  const models = new Set();
  const excludedAt = new Map(); // 第几段 -> { id, role?, error }
  for (let i = 0; i < recordings.length; i++) {
    for (let j = i + 1; j < recordings.length; j++) {
      if (excludedAt.has(i) || excludedAt.has(j)) continue;
      try {
        const { similarity, model } = await speakerSimilarity(env, recordings[i].audio, recordings[j].audio);
        pairs.push({ a: recordings[i].id, b: recordings[j].id, similarity });
        if (model !== undefined) models.add(model);
      } catch (error) {
        if (!isNoSpeechError(error)) throw error;
        // 能力一次只报一路（两路都嵌不出时先报 audio_a）：另一路还没验过，后面碰到它自己时会发现
        const at = error.details.field === 'audio_a' ? i : j;
        excludedAt.set(at, { id: recordings[at].id, ...(recordings[at].role === undefined ? {} : { role: recordings[at].role }), error: summarizeError(error) });
      }
    }
  }
  const excluded = [...excludedAt].sort(([a], [b]) => a - b).map(([, entry]) => entry);
  if (pairs.length === 0) {
    const usable = recordings.length - excluded.length;
    throw new VoicePackError(
      'baseline_needs_two_recordings',
      `The human baseline needs at least two real recordings of the same person to make a pair; ${excluded.length > 0 ? `${excluded.length} of ${recordings.length} recordings have no speech a voiceprint can be taken from, so only` : 'only'} ${usable} usable`,
      { details: { recordings: usable, ...(excluded.length > 0 ? { excluded } : {}) } },
    );
  }
  assertSingleModel('speaker-verification', models);
  return { status: 'measured', value: mean(pairs.map((pair) => pair.similarity)), pairs, ...(excluded.length > 0 ? { excluded } : {}), ...(models.size === 1 ? { model: [...models][0] } : {}) };
}

// ---------------------------------------------------------------- 报告

function normalizeLabels(labels, where) {
  if (labels === undefined) return {};
  if (!isPlainObject(labels)) throw invalid(`${where}.labels`, `${where}.labels must be an object { label name: value }`);
  const out = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw invalid(`${where}.labels.${key}`, `${where}.labels.${key} must be a string, number or boolean`);
    out[key] = String(value);
  }
  return out;
}

/**
 * 核对并整理报告的输入。音频必须是 { bytes, mimeType }；id 在参考和留出录音之间不能重复。
 * only：补做用。给一组留出录音的 id，就只核对这几条留出录音（原来是第几个，报错里就写第几个），参考和别的留出录音都不看。
 */
function normalizeFidelityInput(input, { only } = {}) {
  if (!isPlainObject(input)) throw invalid('input', 'input must be an object { references, holdouts }');
  const { references = [], holdouts = [] } = input;
  if (!Array.isArray(references)) throw invalid('references', 'references must be an array');
  if (!Array.isArray(holdouts)) throw invalid('holdouts', 'holdouts must be an array');
  const seen = new Set();
  const take = (item, where, { needsText }) => {
    if (!isPlainObject(item)) throw invalid(where, `${where} must be an object`);
    if (typeof item.id !== 'string' || item.id === '') throw invalid(`${where}.id`, `${where}.id must be a non-empty string`);
    if (seen.has(item.id)) throw invalid(`${where}.id`, `${where}.id "${item.id}" is duplicated: references and held-out recordings must not share an id`);
    seen.add(item.id);
    assertAudioClip(item.audio, `${where}.audio`);
    if (needsText) {
      if (typeof item.text !== 'string') throw invalid(`${where}.text`, `${where}.text must be a string (what is said in this audio)`);
      if (tokenizeTranscript(item.text).length === 0) {
        throw new VoicePackError('fidelity_text_empty', `${where}.text has no words (it is empty or only punctuation), so there is nothing to check the transcription against`, { details: { field: `${where}.text` } });
      }
    }
    return { id: item.id, audio: item.audio, text: item.text, labels: normalizeLabels(item.labels, where), ...(item.synthetic === true ? { synthetic: true } : {}) };
  };
  const wanted = (item) => only === undefined || (isPlainObject(item) && only.has(item.id));
  return {
    references: only === undefined ? references.map((item, index) => take(item, `references[${index}]`, { needsText: false })) : [],
    holdouts: holdouts.flatMap((item, index) => {
      if (!wanted(item)) return [];
      const taken = take(item, `holdouts[${index}]`, { needsText: true });
      assertAudioClip(item.generated, `holdouts[${index}].generated`);
      return [{ ...taken, generated: item.generated }];
    }),
  };
}

// 作废：开头的转写和已知文本的开头对不上，回答不是固定格式，回答没正常结束或是空的（blind_answer_unusable，blindListen 把能力标的 details.unusable 转成它），
// 或回答被模型的服务商拦下（能力抛 provider_blocked）。别的错误（输入不对、401……）不算作废，照常抛出。
const VOIDING_CODES = ['listening_check_failed', 'blind_answer_invalid', 'blind_answer_unusable', 'provider_blocked'];
/** 作废里被模型的服务商拦下的那一种：另外数条数（blocked）。 */
const BLOCKED_CODE = 'provider_blocked';

// ---------------------------------------------------------------- 没听成

/** 报告里「这一项因为服务出错没做成」的写法。和「作废」「量不了」「量不到」是四回事，见文件头「How to read this report」第 6、9 点。 */
export const NOT_HEARD_LABEL = 'not heard';

/** 报告里「这一条的说话人相似度没有数：有一段录音里没有能嵌声纹的语音」的写法。第 9 点。 */
export const NO_SPEECH_LABEL = 'no speech';

/**
 * 说话人验证报的是不是「这段录音里没有能嵌的语音」：标准写法（vocab/capability-signatures.md 的 speaker-verification 一节）是
 * capability_input_invalid，details 是 { capability: 'speaker-verification', field: 'audio_a' 或 'audio_b', problem: 'no_speech' }。
 * 库只认这一个写法：别的码（能力自己起的）、没写明是哪一路的，都不是，照常往上抛。
 * 导出给挑默认参考段用（lib/make-pack-pick.mjs）：同一个写法，同一处判断。
 */
export function isNoSpeechError(error) {
  return (
    isVoicePackError(error, 'capability_input_invalid') &&
    error.details?.capability === 'speaker-verification' &&
    error.details?.problem === 'no_speech' &&
    (error.details?.field === 'audio_a' || error.details?.field === 'audio_b')
  );
}

/**
 * 一项没听成的记录。item 是 'blind-listening' 或 'speaker-similarity'；attempts 是这一项一共试了几次（第一次量就是 1，每补做一次加 1）。
 * 库自己不重试：建任务和补全可能已经计费，要不要补做由调用方定（redoNotHeard）。
 */
const notHeardRecord = (item, error, attempts, extra = {}) => ({ status: 'not_heard', label: NOT_HEARD_LABEL, item, error: summarizeError(error), attempts, ...extra });

/** 把各条里没听成的项摘出来，按留出录音的先后，同一条里先说话人相似度、后盲听。 */
function listNotHeard(items) {
  return items.flatMap((item) =>
    ['speakerSimilarity', 'blindListening']
      .map((key) => item[key])
      .filter((part) => part?.status === 'not_heard')
      .map((part) => ({ id: item.id, item: part.item, error: part.error, attempts: part.attempts })),
  );
}

/** 把各条里盲听作废的摘出来，按留出录音的先后。 */
const listVoided = (items) => items.flatMap((item) => (item.blindListening?.status === 'voided' ? [{ id: item.id, error: item.blindListening.error }] : []));

/**
 * 一条留出录音的说话人相似度「量不到」的记录：which 是嵌不出声纹的那一段（'generated' 生成的、'holdout' 留出的），error 是能力报错的原样
 * （{ code, message, details }，summarizeError 的形状）。
 * 同一段录音再量还是一样，所以没有 attempts，补做也不算它（planRedo、redoNotHeard 都不碰）。
 */
const noSpeechRecord = (errorRecord, which) => ({ status: 'no_speech', label: NO_SPEECH_LABEL, item: 'speaker-similarity', which, error: errorRecord });

/** 把各条里说话人相似度量不到的摘出来，按留出录音的先后。 */
const listNoSpeech = (items) =>
  items.flatMap((item) => (item.speakerSimilarity?.status === 'no_speech' ? [{ id: item.id, item: item.speakerSimilarity.item, which: item.speakerSimilarity.which, error: item.speakerSimilarity.error }] : []));

// ---------------------------------------------------------------- 一条留出录音的一项怎么量（measureFidelity 和 redoNotHeard 共用）

/**
 * 一条留出录音的说话人相似度这一项：量出来了是 measured；有一段录音里没有能嵌声纹的语音是 no_speech（量不到）；
 * 碰到服务暂时出错是 not_heard（attempts：这是第几次试）；别的错误照常抛出。
 * @returns {Promise<{ speakerSimilarity: object, model?: string }>}
 */
async function measureSpeakerItem(env, holdout, baselineValue, attempts) {
  try {
    const { similarity, model } = await speakerSimilarity(env, holdout.generated, holdout.audio);
    return { speakerSimilarity: { status: 'measured', similarity, ratio: baselineValue > 0 ? similarity / baselineValue : null }, model };
  } catch (error) {
    if (isNoSpeechError(error)) return { speakerSimilarity: noSpeechRecord(summarizeError(error), error.details.field === 'audio_a' ? 'generated' : 'holdout') };
    if (!isServiceError(error)) throw error;
    return { speakerSimilarity: notHeardRecord('speaker-similarity', error, attempts) };
  }
}

/**
 * 一条留出录音的盲听这一项：量出来了是 measured；收音校验没过、回答格式不对、回答没正常结束或是空的、或被模型的服务商拦下（provider_blocked）是 voided；碰到服务暂时出错是 not_heard（记着 firstX，补做时沿用）；
 * 别的错误照常抛出。被拦下的不是服务暂时出错（适配器不标 transient）：同一段录音再问还是被拦，补做也没用。
 * @returns {Promise<{ blindListening: object, models: string[] }>}
 */
async function measureBlindItem(env, holdout, { firstX, maxErrorRate }, attempts) {
  const trial = { a: { audio: holdout.audio, text: holdout.text, kind: 'real' }, b: { audio: holdout.generated, text: holdout.text, kind: 'synthetic' } };
  try {
    const result = await blindListen(env, trial, { maxErrorRate, firstX });
    return {
      blindListening: { status: 'measured', sameSpeaker: result.sameSpeaker, consistent: result.consistent, models: result.models, asks: result.asks },
      models: result.models,
    };
  } catch (error) {
    if (isServiceError(error)) return { blindListening: notHeardRecord('blind-listening', error, attempts, { firstX }), models: [] };
    if (VOIDING_CODES.some((code) => isVoicePackError(error, code))) return { blindListening: { status: 'voided', label: 'voided', error: summarizeError(error) }, models: [] };
    throw error;
  }
}

// ---------------------------------------------------------------- 汇总

/**
 * 把若干条留出录音的说话人相似度合成一个总的或一组的结果。比值只按量出来的算；没听成的条数（notHeard）、量不到的条数（noSpeech）各自单独报。
 * 一条量出来的都没有：不给假的平均，也不当成 0；有没听成的，就说没听成（补做也许能量出来），否则全是量不到。
 */
function aggregateSpeaker(members, baseline) {
  const heard = members.filter((item) => item.speakerSimilarity.status === 'measured');
  const noSpeech = members.filter((item) => item.speakerSimilarity.status === 'no_speech').length;
  const notHeard = members.length - heard.length - noSpeech;
  if (heard.length === 0) {
    return noSpeech > 0 && notHeard === 0 ? { status: 'no_speech', label: NO_SPEECH_LABEL, n: 0, notHeard, noSpeech } : { status: 'not_heard', label: NOT_HEARD_LABEL, n: 0, notHeard, noSpeech };
  }
  const meanSimilarity = mean(heard.map((item) => item.speakerSimilarity.similarity));
  return { status: 'measured', n: heard.length, notHeard, noSpeech, meanSimilarity, ratio: meanSimilarity / baseline.value };
}

/**
 * 把若干条留出录音的盲听结果合成一个总的或一组的结果。
 * 判成同一人的比例 = 判成同一人的次数 / 问过的次数；前后一致的比例 = 两问判断相同的条数 / 有效条数（读法第 3 点）。
 * differences 是模型说的哪里像、哪里不像的原话（每问一条），只给人看，不计数、不打分（读法第 4 点）。
 * 作废的条数（voided）、没听成的条数（notHeard）各自单独报，都不计入这些比例。作废里被模型的服务商拦下的条数（blocked）另外数，是 voided 的一部分。
 * @param {{ id: string, blind: object }[]} entries blind 是每一条的盲听结果（measured、voided 或 not_heard）
 */
function aggregateBlind(entries) {
  const valid = entries.filter((entry) => entry.blind.status === 'measured');
  const voided = entries.filter((entry) => entry.blind.status === 'voided').length;
  const blocked = entries.filter((entry) => entry.blind.status === 'voided' && entry.blind.error?.code === BLOCKED_CODE).length;
  const notHeard = entries.filter((entry) => entry.blind.status === 'not_heard').length;
  // 一条有效的都没有：有没听成的，就说没听成（补做也许能量出来）；否则全是作废
  if (valid.length === 0) return { status: notHeard > 0 ? 'not_heard' : 'voided', label: notHeard > 0 ? NOT_HEARD_LABEL : 'voided', trials: 0, voided, blocked, notHeard, asks: 0 };
  const total = (pick) => valid.reduce((sum, entry) => sum + pick(entry.blind), 0);
  const asks = total((blind) => blind.asks.length);
  return {
    status: 'measured',
    trials: valid.length,
    voided,
    blocked,
    notHeard,
    asks,
    sameSpeaker: total((blind) => blind.sameSpeaker),
    sameSpeakerRate: total((blind) => blind.sameSpeaker) / asks,
    consistent: total((blind) => (blind.consistent ? 1 : 0)),
    consistentRate: total((blind) => (blind.consistent ? 1 : 0)) / valid.length,
    differences: valid.flatMap((entry) => entry.blind.asks.map((ask) => ({ id: entry.id, order: ask.order, whereAlike: ask.whereAlike, whereUnlike: ask.whereUnlike }))),
  };
}

/** 报告里的 models：这次评测里每项能力报出的那一个模型名（没取到的不写）。 */
const modelsOf = (speakerModel, blindModel) => ({
  ...(speakerModel === undefined ? {} : { 'speaker-verification': speakerModel }),
  ...(blindModel === undefined ? {} : { 'audio-text-to-text': blindModel }),
});

/**
 * 由各条的结果拼出整份报告。measureFidelity 和 redoNotHeard 都走这里，所以补做以后的报告和一次做完的报告形状一样、顺序一样。
 * speakerUnmeasurable、blindUnmeasurable：这一类整个量不了（缺能力、没有留出录音、真人基线不够……）时的那条「量不了」，
 * 每一组和总体都报它；没有就是 null。referenceCount(key, value)：参考集里带这个标签取值的有几段。
 */
function buildReport({ counts, models, baseline, items, referenceCount, speakerUnmeasurable, blindUnmeasurable, designSource = false }) {
  const speakerOf = (members) => speakerUnmeasurable ?? aggregateSpeaker(members, baseline);
  const blindOf = (members) => blindUnmeasurable ?? aggregateBlind(members.map((item) => ({ id: item.id, blind: item.blindListening })));
  // 按标签分组：有什么标签就分什么，先按标签名、再按取值排好
  const groups = [];
  for (const key of [...new Set(items.flatMap((item) => Object.keys(item.labels)))].sort()) {
    for (const value of [...new Set(items.map((item) => item.labels[key]).filter((v) => v !== undefined))].sort()) {
      const members = items.filter((item) => item.labels[key] === value);
      groups.push({ key, value, holdouts: members.length, references: referenceCount(key, value), speakerSimilarity: speakerOf(members), blindListening: blindOf(members) });
    }
  }
  return {
    counts,
    models,
    baseline,
    designSource,
    overall: { holdouts: items.length, speakerSimilarity: speakerOf(items), blindListening: blindOf(items) },
    groups,
    items,
    voided: listVoided(items),
    notHeard: listNotHeard(items),
    noSpeech: listNoSpeech(items),
  };
}

/**
 * 真人基线，或者「量不了」：嵌不出声纹的真录音去掉以后凑不出一对，是真录音的事，不是环境坏了，说话人相似度整体报「量不了」
 * （reason: not_enough_real_recordings，说明里写着几段里几段、是哪几段嵌不出；excluded 原样带着）。别的错误照常抛出。
 * @returns {Promise<object>} humanBaseline 的返回值，或者 unmeasurable 的记录
 */
async function baselineOrUnmeasurable(env, real) {
  try {
    return await humanBaseline(env, real);
  } catch (error) {
    if (!isVoicePackError(error, 'baseline_needs_two_recordings') || !Array.isArray(error.details?.excluded)) throw error;
    const { recordings: usable, excluded } = error.details;
    const which = excluded.map((entry) => entry.id).join(', ');
    return { ...unmeasurable('not_enough_real_recordings', `The human baseline needs at least two real recordings of the same person; ${excluded.length} of ${real.length} recordings (${which}) have no speech a voiceprint can be taken from, so only ${usable} usable`), excluded };
  }
}

/**
 * 量还原度，出一份报告。两种方法都量，缺哪项评测能力，那一项就报「量不了」并点名缺的能力，别的照常。
 *
 * 说话人相似度：生成的录音和对应的留出录音之间的相似度，除以真人基线。
 * 盲听：见 blindListen。收音校验没过、回答不是固定格式、回答没正常结束或是空的、或回答被模型的服务商拦下（provider_blocked）的那一条作废，记在 voided 里，不计入比例，别的条照常。
 * 单条服务出错不让整份报告作废：某条留出录音的盲听或说话人相似度碰到服务暂时出错（能力在 details.transient 里标出来的，见 lib/capability-calls.mjs 的 isServiceError），
 *   这一项记成「没听成」（notHeard）：写明是哪项、错误码、试了几次，不计入任何比例，接着做下一条。库不自动重试
 *   （建任务和补全可能已经计费），要补做由调用方用 planRedo 看要花多少次调用，再用 redoNotHeard 只补做没听成的那几项。
 *   别的错误（缺能力的 capability_missing 除外，它在开始前就变成「量不了」）照常抛出：输入不对、401、返回的形状不对、没标成服务暂时出错的……
 * 某一段录音里没有能嵌声纹的语音（说话人验证报标准的 no_speech，见读法第 9 点）不是环境坏了：那一条的说话人相似度记成「量不到」
 *   （noSpeech，写明是生成的还是留出的那一段），不进比例，不能补做，别的条照常量。留出的真录音自己嵌不出时真人基线也不用它（baseline.excluded）；
 *   参考录音嵌不出也一样；剩下的真录音凑不出一对时，说话人相似度整体「量不了」（not_enough_real_recordings），盲听照做。
 * 分组：按留出录音的标签（做包存下的是语言，别的评测集可以有别的键，有什么标签就分什么）一组一组报，每组带着参考集里有几段这个标签取值。
 *
 * @param {object} env 注入的运行环境：speaker-verification、audio-text-to-text 各自可选
 * @param {{
 *   references: { id: string, audio: AudioClip, text?: string, labels?: Record<string, string|number|boolean>, synthetic?: boolean }[],
 *   holdouts: { id: string, audio: AudioClip, text: string, labels?: Record<string, string|number|boolean>, generated: AudioClip }[],
 * }} input
 *   references：参考集里的真人原声（synthetic 为 true 的是克隆出来的，不是这个人录的：不进真人基线，也不数进 realRecordings）；
 *   holdouts：留出录音，generated 是用这个包把 text 合成出来的录音。labels 是标签。
 * @param {{ random?: () => number, maxErrorRate?: number }} [options] random：每条盲听抽一次，决定第一次问的时候谁在 X；maxErrorRate：收音校验的阈值
 * @returns {Promise<object>} 报告，形状见文件头
 */
export async function measureFidelity(env, input, options = {}) {
  const { references, holdouts } = normalizeFidelityInput(input);
  const blindOptions = normalizeBlindOptions(options);
  // role 只是让基线说得清哪一段真录音没用上（humanBaseline 的 excluded），库不看它。
  // 标了 synthetic 的参考是克隆出来的，不是这个人录的：不进真人基线，counts.realRecordings 也不数它
  const real = [
    ...references.filter((ref) => ref.synthetic !== true).map(({ id, audio }) => ({ id, audio, role: 'reference' })),
    ...holdouts.map(({ id, audio }) => ({ id, audio, role: 'holdout' })),
  ];
  const verifier = probeCapability(env, 'speaker-verification');
  const listener = probeCapability(env, 'audio-text-to-text');
  const items = holdouts.map((holdout) => ({ id: holdout.id, labels: holdout.labels, speakerSimilarity: null, blindListening: null }));
  let speakerModel;
  let blindModel;

  // ---- 说话人相似度：真人基线 + 每一条生成的录音和它的留出录音的相似度
  let baseline;
  let speakerUnmeasurable = null;
  if (!verifier.available) {
    baseline = speakerUnmeasurable = unmeasurableForMissing('speaker-verification', verifier.error);
  } else if (holdouts.length === 0) {
    baseline = speakerUnmeasurable = unmeasurable('no_holdout_recordings', 'There are no held-out recordings, so there is nothing to compare the generated recordings with');
  } else if (real.length < 2) {
    baseline = speakerUnmeasurable = unmeasurable('not_enough_real_recordings', `The human baseline needs at least two real recordings of the same person; only ${real.length} given`);
  } else {
    baseline = await baselineOrUnmeasurable(env, real);
    if (baseline.status === 'unmeasurable') {
      speakerUnmeasurable = baseline;
    } else {
      // 基线没用上的留出录音是真录音自己嵌不出声纹：它那一条就是量不到，不再为它调用能力
      const silentHoldouts = new Map((baseline.excluded ?? []).filter((entry) => entry.role === 'holdout').map((entry) => [entry.id, entry.error]));
      const seenModels = new Set(baseline.model === undefined ? [] : [baseline.model]);
      for (const [index, holdout] of holdouts.entries()) {
        if (silentHoldouts.has(holdout.id)) {
          items[index].speakerSimilarity = noSpeechRecord(silentHoldouts.get(holdout.id), 'holdout');
          continue;
        }
        const { speakerSimilarity: part, model } = await measureSpeakerItem(env, holdout, baseline.value, 1);
        if (model !== undefined) seenModels.add(model);
        assertSingleModel('speaker-verification', seenModels);
        items[index].speakerSimilarity = part;
      }
      if (seenModels.size === 1) speakerModel = [...seenModels][0];
      if (!(baseline.value > 0)) speakerUnmeasurable = unmeasurable('baseline_not_positive', `The human baseline is ${baseline.value}, not a positive number, so it cannot be used as the denominator`);
    }
  }

  // ---- 盲听：一条一条来，作废的、没听成的那一条记下来，其余照常
  let blindUnmeasurable = null;
  if (!listener.available) {
    blindUnmeasurable = unmeasurableForMissing('audio-text-to-text', listener.error);
  } else if (holdouts.length === 0) {
    blindUnmeasurable = unmeasurable('no_holdout_recordings', 'There are no held-out recordings, so there is nothing to blind-listen to');
  } else {
    const seenModels = new Set();
    for (const [index, holdout] of holdouts.entries()) {
      // 每条抽一次，出不出错都抽，后面的条的顺序才不会因为前面出错而变；抽到的记在没听成的记录里，补做时沿用
      const firstX = drawFirstX(blindOptions.random);
      const { blindListening: part, models } = await measureBlindItem(env, holdout, { firstX, maxErrorRate: blindOptions.maxErrorRate }, 1);
      models.forEach((model) => seenModels.add(model));
      assertSingleModel('audio-text-to-text', seenModels);
      items[index].blindListening = part;
    }
    if (seenModels.size === 1) blindModel = [...seenModels][0];
  }

  return buildReport({
    counts: { references: references.length, holdouts: holdouts.length, realRecordings: real.length },
    models: modelsOf(speakerModel, blindModel),
    baseline,
    items,
    referenceCount: (key, value) => references.filter((ref) => ref.labels[key] === value).length,
    speakerUnmeasurable,
    blindUnmeasurable,
    designSource: blindOptions.designSource,
  });
}

// ---------------------------------------------------------------- 补做没听成的

/** 一条盲听问几次：每条问两遍（换序再问一遍），和 blindListen 里的两种顺序对应。 */
const ASKS_PER_TRIAL = 2;
/** 一条里的每一项，用到哪项所需能力。 */
const CAPABILITY_OF = { 'blind-listening': 'audio-text-to-text', 'speaker-similarity': 'speaker-verification' };
/** 一条里的两个位置，各自放哪一项、可能是什么状态。 */
const REPORT_SLOTS = {
  speakerSimilarity: { item: 'speaker-similarity', statuses: ['measured', 'not_heard', 'no_speech'] },
  blindListening: { item: 'blind-listening', statuses: ['measured', 'voided', 'not_heard'] },
};

/**
 * 核对上一次的报告是 measureFidelity 出的形状（只核对要用到的），原样交回。
 * forRedo：补做要用的更多（基线、分组、总体、模型名），多核对几处；只算要补做什么（planRedo）时只看 items。
 * @throws {VoicePackError} fidelity_input_invalid：不是约定的形状。details.field 是出问题的字段，从 previous 起写
 */
function readPreviousReport(report, { forRedo = false } = {}) {
  const where = 'previous';
  if (!isPlainObject(report)) throw invalid(where, 'the previous report must be a report object produced by measureFidelity');
  if (!Array.isArray(report.items)) throw invalid(`${where}.items`, 'the previous report has no items (the result of each held-out recording): is it a report produced by measureFidelity?');
  const seen = new Set();
  report.items.forEach((item, index) => {
    const at = `${where}.items[${index}]`;
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') throw invalid(`${at}.id`, `${at}.id must be a non-empty string`);
    if (seen.has(item.id)) throw invalid(`${at}.id`, `${at}.id "${item.id}" is duplicated`);
    seen.add(item.id);
    if (forRedo && !isPlainObject(item.labels)) throw invalid(`${at}.labels`, `${at}.labels must be an object { label name: value }`);
    for (const [key, slot] of Object.entries(REPORT_SLOTS)) {
      const part = item[key];
      if (part === null) continue;
      if (!isPlainObject(part) || !slot.statuses.includes(part.status)) throw invalid(`${at}.${key}.status`, `${at}.${key}.status must be one of ${slot.statuses.join(', ')}, or the whole entry must be null`);
      if (part.status !== 'not_heard') continue;
      if (part.item !== slot.item) throw invalid(`${at}.${key}.item`, `${at}.${key} is a not-heard record, so item must be "${slot.item}"`);
      if (!isPlainObject(part.error)) throw invalid(`${at}.${key}.error`, `${at}.${key}.error must be the reason it was not heard ({ code, message, details })`);
      if (!Number.isInteger(part.attempts) || part.attempts < 1) throw invalid(`${at}.${key}.attempts`, `${at}.${key}.attempts must be an integer not less than 1 (how many times this item was tried)`);
      if (part.firstX !== undefined && part.firstX !== 'a' && part.firstX !== 'b') throw invalid(`${at}.${key}.firstX`, `${at}.${key}.firstX must be "a" or "b"`);
    }
  });
  if (forRedo) {
    for (const key of ['counts', 'models', 'baseline', 'overall']) {
      if (!isPlainObject(report[key])) throw invalid(`${where}.${key}`, `the previous report has no ${key}: is it a report produced by measureFidelity?`);
    }
    if (!Array.isArray(report.groups)) throw invalid(`${where}.groups`, 'the previous report has no groups (the groups split by label): is it a report produced by measureFidelity?');
    for (const key of Object.keys(REPORT_SLOTS)) {
      if (!isPlainObject(report.overall[key])) throw invalid(`${where}.overall.${key}`, `the previous report has no overall.${key}`);
    }
    const needsBaseline = report.items.some((item) => item.speakerSimilarity?.status === 'not_heard');
    if (needsBaseline && !(report.baseline.status === 'measured' && Number.isFinite(report.baseline.value))) {
      throw invalid(`${where}.baseline`, 'some speaker similarities were not heard, but the previous report has no measured human baseline: a redo needs it as the denominator');
    }
  }
  return report;
}

/** 从各条里算出要补做什么、各要调用多少次。 */
function planOf(items) {
  const entries = listNotHeard(items).map(({ id, item, attempts }) => ({ id, item, attempts }));
  const calls = {};
  for (const { item } of entries) {
    const capability = CAPABILITY_OF[item];
    calls[capability] = (calls[capability] ?? 0) + (item === 'blind-listening' ? ASKS_PER_TRIAL : 1);
  }
  return { items: entries, calls, total: Object.values(calls).reduce((sum, count) => sum + count, 0) };
}

/**
 * 补做没听成的那几项要花多少次调用：事先算清楚，调用方决定要不要补做、什么时候补做。只是算一算，不调用任何能力，不改报告。
 * @param {object} report 上一次的报告（measureFidelity 或 redoNotHeard 出的，存成 JSON 再读回来的也行）
 * @returns {{ items: { id: string, item: 'blind-listening' | 'speaker-similarity', attempts: number }[], calls: Record<string, number>, total: number }}
 *   items：要补做的项，按留出录音的先后，同一条里先说话人相似度、后盲听，attempts 是已经试了几次；
 *   calls：每项所需能力要调用几次（一条盲听 2 次，一条说话人相似度 1 次；一次也不用的能力不列）；total：合计
 * @throws {VoicePackError} fidelity_input_invalid：报告不是约定的形状
 */
export function planRedo(report) {
  return planOf(readPreviousReport(report).items);
}

/**
 * 补做：输入上一次的报告，只对没听成的那几项重新调用，输出合并以后的新报告。上一次的报告不改。
 * 已经量出来的、作废的、量不了的都原样保留，真人基线也不重算；补做成功的项和一次全成功的结果一样（顺序沿用第一次问的，
 * 所以同样的录音、同样的听者给出同样的回答时，合并以后的报告和一次做完的报告一模一样）；补做又失败的还是没听成，attempts 加 1。
 * 库不替调用方重试，也不会自己再补做一遍：调用几次由调用方定，先用 planRedo 看要花多少次。
 *
 * 要求：
 *   - input 里要有每一条要补做的留出录音（按 id 对上），用第一次那几条同样的录音和文本，和第一次那条生成的录音（generated）；
 *     别的留出录音和 references 不看，所以只给要补做的那几条也行。
 *   - 同一次评测只能用同一个评测模型：补做时能力报出的模型名和上一次不一样，抛 evaluation_model_mismatch。
 *   - options 同 measureFidelity，maxErrorRate 要和第一次一样（报告里没记，由调用方保证）。没听成的盲听记着第一次的顺序，不再抽随机数。
 *   - 先核对输入、再查缺不缺能力（缺的点名，抛 capability_missing），都过了才调用，不白花钱。
 *
 * @param {object} env 注入的运行环境：补做盲听要 audio-text-to-text，补做说话人相似度要 speaker-verification
 * @param {{ holdouts: object[] }} input 同 measureFidelity 的 input
 * @param {object} previous 上一次的报告
 * @param {{ random?: () => number, maxErrorRate?: number }} [options]
 * @returns {Promise<object>} 合并以后的新报告，形状同 measureFidelity
 * @throws {VoicePackError} fidelity_input_invalid（报告或输入不对，要补做的留出录音不在 input 里）、capability_missing、
 *   evaluation_model_mismatch，补做时的其他错误同 measureFidelity：没标成服务暂时出错的照常抛出，401 立即停
 */
export async function redoNotHeard(env, input, previous, options = {}) {
  readPreviousReport(previous, { forRedo: true });
  const blindOptions = normalizeBlindOptions(options);
  const report = structuredClone(previous);
  const plan = planOf(report.items);
  if (plan.total === 0) return report;

  const wanted = new Set(plan.items.map((entry) => entry.id));
  const byId = new Map(normalizeFidelityInput(input, { only: wanted }).holdouts.map((holdout) => [holdout.id, holdout]));
  for (const id of wanted) {
    if (!byId.has(id)) throw invalid('holdouts', `the held-out recording "${id}" to redo is not in the holdouts given: a redo needs the same recordings, texts and generated recordings that were measured the first time`);
  }
  for (const capability of Object.keys(plan.calls)) requireCapability(env, capability);

  const speakerModels = new Set(report.models['speaker-verification'] === undefined ? [] : [report.models['speaker-verification']]);
  const blindModels = new Set(report.models['audio-text-to-text'] === undefined ? [] : [report.models['audio-text-to-text']]);
  // 说话人相似度先、盲听后，和 measureFidelity 的先后一样
  for (const item of report.items) {
    const record = item.speakerSimilarity;
    if (record?.status !== 'not_heard') continue;
    const { speakerSimilarity: part, model } = await measureSpeakerItem(env, byId.get(item.id), report.baseline.value, record.attempts + 1);
    if (model !== undefined) speakerModels.add(model);
    assertSingleModel('speaker-verification', speakerModels);
    item.speakerSimilarity = part;
  }
  for (const item of report.items) {
    const record = item.blindListening;
    if (record?.status !== 'not_heard') continue;
    const firstX = record.firstX ?? drawFirstX(blindOptions.random);
    const { blindListening: part, models } = await measureBlindItem(env, byId.get(item.id), { firstX, maxErrorRate: blindOptions.maxErrorRate }, record.attempts + 1);
    models.forEach((model) => blindModels.add(model));
    assertSingleModel('audio-text-to-text', blindModels);
    item.blindListening = part;
  }

  return buildReport({
    counts: report.counts,
    models: modelsOf(speakerModels.size === 1 ? [...speakerModels][0] : undefined, blindModels.size === 1 ? [...blindModels][0] : undefined),
    baseline: report.baseline,
    items: report.items,
    referenceCount: (key, value) => report.groups.find((group) => group.key === key && group.value === value)?.references ?? 0,
    // 整类量不了的（缺能力、没有留出录音、基线不够）原样带过来
    speakerUnmeasurable: report.overall.speakerSimilarity.status === 'unmeasurable' ? report.overall.speakerSimilarity : null,
    blindUnmeasurable: report.overall.blindListening.status === 'unmeasurable' ? report.overall.blindListening : null,
    // 补做沿用上一次的读法：设计来源的还是设计来源的（补做的报告和做完的一样）
    designSource: report.designSource === true,
  });
}

// ---------------------------------------------------------------- 随机数

/**
 * 确定性的伪随机数（mulberry32）：随机数由外部注入的场合用它固定顺序，例如命令行的 --seed，或标定时要复现一次盲听。
 * @param {number} seed 32 位整数
 * @returns {() => number} 每次返回 [0, 1) 里的数
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
