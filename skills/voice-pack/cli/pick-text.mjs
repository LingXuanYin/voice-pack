// SPDX-License-Identifier: Apache-2.0
//
// 用的哪一段参考、为什么，写成给人看的文字：dub 命令和 convert 命令都用它（命令之间不互相引用，所以放在这里，见 cli/input.mjs 的文件头）。
// 两个命令的 pick 是同一个写法（lib/reference-pick.mjs 的 picks[i]：{ segmentId, tag, by, crossLanguage }；dub 的一句还可能有 followsLine），说法只写在这里一份。
//
//   pickText(pick)       → [参考段（和标签）, 为什么, 跨语言的说明?]：命令自己决定怎么接（dub 前面可能加包 ID，两个命令都用 ' · ' 连）
//   segmentText(pick)    参考段 id，有音色基底标签就跟在后面的括号里
//   BY_LABELS            为什么是这一段（pick.by）
//   CROSS_LANGUAGE       跨语言的几种说法（pick.crossLanguage 是 true 时）

/** 为什么用这一段（pick.by，lib/reference-pick.mjs 的文件头）：调用方指定的标签、设定写的默认参考、这一句的语言的默认段（包里没有这种语言时是主语言的默认段）。 */
export const BY_LABELS = Object.freeze({ 'reference-tag': 'set by --reference-tag', setup: "the setup's default reference", default: 'default segment' });

/**
 * pick.crossLanguage：没定标签的一句，是包里没有这一句的语言、用了主语言的默认段（line）；定了标签的一句，是这种语言里没有这个标签的段（tagged）；
 * 有 pick.followsLine 的，是 dub 一行里另一种语言的那一块跟着这一行用的段（一行只挑一段参考，lib/dub.mjs 的 paragraphPicks），包里其实有它的语言（followsLine）；
 * dub 一场戏里一个说话人的，是整场用的那段和他有一轮的语言对不上（lib/dub.mjs 的 sceneUnit，speaker）。
 */
export const CROSS_LANGUAGE = Object.freeze({ line: 'the pack has no segment in this language', tagged: 'cross-language: no segment in this language has this tag', followsLine: "cross-language: this line mixes languages, so it follows the line's reference segment", speaker: 'some turns are cross-language' });

/** 一段参考：段 id，后面是它的音色基底标签。 */
export const segmentText = (pick) => (pick.tag === undefined ? pick.segmentId : `${pick.segmentId} (${pick.tag})`);

/** 一句（或一段要换声的音频）用的参考：参考段（和标签）、为什么、跨语言的说明（不跨语言就没有这一项）。 */
export function pickText(pick) {
  const cross = pick.crossLanguage ? [pick.followsLine ? CROSS_LANGUAGE.followsLine : pick.by === 'default' ? CROSS_LANGUAGE.line : CROSS_LANGUAGE.tagged] : [];
  return [segmentText(pick), BY_LABELS[pick.by], ...cross];
}
