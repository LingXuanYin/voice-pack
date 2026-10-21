// SPDX-License-Identifier: Apache-2.0
//
// 挑参考（流程层）：把筛过、打好标签的片段分成参考集、留出录音和没用上的，挑出默认参考段。
// 哪些当参考、哪些当留出录音、默认参考段怎么挑，规则的正本是 lib/pack-material.mjs 的文件头（纯数据）；这里是它和做包的条目之间的一层：
// 把条目整理成它要的候选，把它的结论写回条目，没有一段能用、选出来的和作者明说的对不上时报错。
//
//   assertDefaultUsable(items, defaultSegment)                   作者明说的默认参考段这次已经被淘汰了，当不了：在花钱之前就报
//   pickMaterial(items, { previous, version, materialOptions })  挑。返回 { chosen, roleOf }：chosen 是 chooseMaterial 的结果（references、holdouts、unused、defaultSegment），
//                                                                roleOf 是 Map<段名, 'reference' | 'holdout'>。version 是 readInput 整理的版本字段，materialOptions 是挑素材的选项
//   isPlainSpeech 是文本能不能原样交给配音（留出录音要拿它合成，再和原话比），不是对外的函数，规则写在它上面的说明里
//
// 发新版本（previous 不是 null）时，上一版的段保持原来的角色（fixed），默认参考段沿用（作者明说换的除外）。上一版带过来的段按现在的阈值可能是 reject：
// 它们不淘汰（lib/make-pack-screen.mjs），排优先级时按 warn 看；报告里的 quality 还是真实的结论。
//
// 读条目的：id、index、unused、quality、text、tags、previous；写条目的：unused（chooseMaterial 淘汰的：reason 是 over_limit 等，details 是 {}）。
//
// 抛出的错误（details 的写法见 lib/make-pack.mjs 文件头「抛出的错误」）：
//   make_pack_no_material    没有一段能用，做不出包
//   make_pack_input_invalid  默认参考段这次被淘汰了，或者没进参考集（field 是 defaultSegment）；去掉以后参考集里一段都不剩（field 是 drop）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { parseScript } from '../tools/markup.mjs';
import { readDirections } from './line-hints.mjs';
import { tokenizeTranscript } from './fidelity.mjs';
import { chooseMaterial } from './pack-material.mjs';
import { invalid } from './make-pack-input.mjs';

/**
 * 文本能不能原样交给配音：没有台本标记、舞台提示、换行（配音会把它们当成要求，念出来的和原话就对不上了）。
 * 读舞台提示要和配音（lib/dub.mjs）读的一样：括号里词表认不出的内容，配音也拿掉，所以明确选「拿掉」；用默认的「保留」，
 * 「He said (see Table 2) that…」会被当成原样能配音，试合成念出来的却没有括号里的字。
 */
function isPlainSpeech(text) {
  const chapters = parseScript(text);
  if (chapters.length !== 1 || chapters[0].spans.length !== 1) return false;
  const [span] = chapters[0].spans;
  if (span.voice_id !== null || span.pause_ms_after !== 0 || span.speed !== null || span.text !== text.trim()) return false;
  const { pieces, directions } = readDirections(span.text, { unrecognized: 'remove' });
  return directions.length === 0 && pieces.length === 1 && pieces[0].text === span.text;
}

/** 作者明说的默认参考段，这次已经被淘汰了（没用上）：当不了默认参考段，在花钱之前就报。 */
export function assertDefaultUsable(items, defaultSegment) {
  const wanted = defaultSegment === undefined ? undefined : items.find((item) => item.id === defaultSegment);
  if (wanted?.unused !== undefined) throw invalid('defaultSegment', `${JSON.stringify(wanted.id)} 这次没能用上（${wanted.unused.reason}），当不了默认参考段`);
}

/** 挑参考集和留出录音，把没用上的原因写回条目；规则见 lib/pack-material.mjs。 */
export function pickMaterial(items, { previous, version, materialOptions }) {
  const usable = items.filter((item) => item.unused === undefined);
  if (usable.length === 0) {
    const unused = {};
    for (const item of items) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
    throw new VoicePackError('make_pack_no_material', `没有一段能用，做不出包：${Object.entries(unused).map(([reason, count]) => `${reason} ${count} 段`).join('、')}`, { details: { unused } });
  }

  const chosen = chooseMaterial(
    usable.map((item) => ({
      id: item.id,
      order: item.index,
      // 上一版带过来的段按现在的阈值可能是 reject：它们不淘汰（见 screen），排优先级时按 warn 看；报告里的 quality 还是真实的结论
      verdict: item.quality?.status === 'checked' ? (item.quality.verdict === 'reject' ? 'warn' : item.quality.verdict) : 'unchecked',
      durationSec: item.quality?.metrics?.durationSec ?? null,
      tokens: tokenizeTranscript(item.text).length,
      textChars: [...item.text].length,
      plain: isPlainSpeech(item.text),
      tags: item.tags,
    })),
    {
      ...materialOptions,
      // 发新版本：上一版的段保持原来的角色，默认参考段沿用（明说换的除外）
      ...(previous === null ? {} : { fixed: Object.fromEntries(usable.filter((item) => item.previous !== undefined).map((item) => [item.id, item.previous])) }),
      defaultSegment: version.defaultSegment ?? previous?.manifest.reference.defaultSegment,
    },
  );
  if (chosen.references.length === 0) throw invalid('drop', '去掉以后参考集里一段都不剩：至少要留一段参考');
  if (version.defaultSegment !== undefined && chosen.defaultSegment !== version.defaultSegment) {
    throw invalid('defaultSegment', `${JSON.stringify(version.defaultSegment)} 这次没进参考集（新补的段按规则当了留出录音，或者超过了参考的上限），当不了默认参考段`);
  }
  for (const dropped of chosen.unused) items.find((item) => item.id === dropped.id).unused = { reason: dropped.reason, details: {} };
  const roleOf = new Map([...chosen.references.map((id) => [id, 'reference']), ...chosen.holdouts.map((id) => [id, 'holdout'])]);
  return { chosen, roleOf };
}
