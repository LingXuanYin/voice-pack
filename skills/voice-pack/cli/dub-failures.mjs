// SPDX-License-Identifier: Apache-2.0
//
// dub 的报告（dub.json）里没做成的一句是哪一种：dub 的文字输出和 mix 不出成品时的提示都照它分开说怎么办（命令之间不互相引用，所以放在这里，见 cli/input.mjs 的文件头）。
// 分法只写在这里一份，每一种怎么办写在 cli/commands/dub.mjs 的文件头「没取回」「文字被拒」：
//   isTooShortUnit      比合成能力的下限短、并不了，没发请求（lib/dub.mjs 的 TEXT_TOO_SHORT）：要改台本让它够长，原样重做没有用
//   isUnretrievedUnit   服务那头做完了、结果没取回（error.details.unretrieved）：重做会再计一次费，不放进重做的命令
//   isTooLongScene      平台说一场戏一个请求装不下（error.details.problem 是 too_long_for_one_request）：切开以后序号会变，不给 --only
//   isTextRejectedUnit  文字被拒（error.details.textRejected）：原样再发还是会被拒，先改字再 --only；不是一场戏的一句装不下（isTooLong）也在这里，另说把它改短
//   别的失败（服务暂时出错之类）和这一次没做的（skipped）原样重做就行，给 --only。
// 只给一条重做的命令（rerunsWithoutOnly）：两条里先跑哪一条都会跑出一半，--only 没点到的文字被拒的、装不下的一场会记成这一次没做（skipped），
//   原因就从 dub.json 里丢了，mix 再叫人原样重做。所以：
//   有字太少的、一场戏装不下的（要先改台本，改了以后序号可能会变）：只说改好以后不带 --only 再跑，别的没做成的都在那一次里一起重做（文字被拒的先改字）；
//   没有这两种、有文字被拒的：文字被拒的和原样重做就行的并成一条 --only（先改字）；
//   都没有：原样重做就行的一条 --only。没取回的不在里面（不叫人重做）。
// 收的是报告里的一句：{ status, error?, scene? }（dub.json 的 units[i]；一场戏有 scene）。
import { TEXT_TOO_SHORT } from '../lib/dub.mjs';
import { isScene, TOO_LONG_FOR_ONE_REQUEST } from '../lib/scene-in-request.mjs';

/** 比合成能力的下限短、并不了的一句（lib/dub.mjs 第 5b 步）：没发请求，失败了，错误码是 TEXT_TOO_SHORT。 */
export const isTooShortUnit = (unit) => unit.status === 'failed' && unit.error?.code === TEXT_TOO_SHORT;
/** 服务那头做完了、结果没取回的一句（cli/commands/dub.mjs 的文件头「没取回」）：失败了，error.details.unretrieved 是 true。 */
export const isUnretrievedUnit = (unit) => unit.status === 'failed' && unit.error?.details?.unretrieved === true;
/** 平台说一个请求装不下（error.details.problem 是 too_long_for_one_request）。一场戏、不是一场戏的都可能（cli/commands/dub.mjs 的文件头「文字被拒」的例外）。 */
export const isTooLong = (unit) => unit.status === 'failed' && unit.error?.details?.problem === TOO_LONG_FOR_ONE_REQUEST;
/** 平台说装不下的一场（文件头「文字被拒」的例外）：只认一场戏；不是一场戏的一个请求装不下，照旧算文字被拒（另写一句怎么改）。 */
export const isTooLongScene = (unit) => isScene(unit) && isTooLong(unit);
/**
 * 文字被拒的一句（cli/commands/dub.mjs 的文件头「文字被拒」）：失败了，error.details.textRejected 是 true（服务商拒的，或者适配器调用之前查出来的），
 * 不是字太少（另有一段）、不是没取回的，也不是装不下的一场（另有一段）。
 */
export const isTextRejectedUnit = (unit) => unit.status === 'failed' && unit.error?.details?.textRejected === true && !isTooShortUnit(unit) && !isUnretrievedUnit(unit) && !isTooLongScene(unit);
/**
 * 这几句里有要先改台本、改好以后不带 --only 再跑的（字太少的、一场戏装不下的）：有，就只给这一条重做的办法，别的没做成的不另给 --only（文件头「只给一条重做的命令」）。
 */
export const rerunsWithoutOnly = (units) => units.some((unit) => isTooShortUnit(unit) || isTooLongScene(unit));
