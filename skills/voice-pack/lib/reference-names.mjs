// SPDX-License-Identifier: Apache-2.0
// 第 7c 步的名字（lib/dub.mjs 文件头「7c 角色名和语言提示」）：一个包认哪些名字（namesOfPack），和名字对不上时规划、正式运行的说明（referenceNameNotes）。
// 从 lib/dub.mjs 挪出来的：dub.mjs 一个文件不超过 256 KiB（基础部分的大小测试）。补名字本身（applyReferenceNames）还在 dub.mjs。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { itemValues, namesOf } from './guidance-items.mjs';

/**
 * 这个包认的名字（第 7c 步）：清单的 name，加上配音指引「换语言时怎么说」「名字」项列的每种语言的全名（lib/guidance-items.mjs）。
 * 「缺」的、没有这一节或这一项的，只认 name。label 是 name，entries 是「名字」项拆出来的 { tag, name }，recognized 是认的名字（去了重）。
 */
export function namesOfPack(manifest, rawGuidance) {
  const entries = namesOf(itemValues(rawGuidance, '换语言时怎么说')?.get('名字'));
  return { label: manifest.name, entries, recognized: [...new Set([manifest.name, ...entries.map((entry) => entry.name)])] };
}

/**
 * 规划和正式运行的说明 reference_name_missing、reference_name_not_full、reference_name_inconsistent（第 7c 步，文件头「说明」）：每个包一条（inconsistent 每个用的名字一条），列出那几句（applyReferenceNames 的三张表）。
 * 每条都点名是哪个包（message 开头是包名，details.pack 是包 ID；一个包也点名）。没有这样的句子，就没有这一条。只提醒，不改字、不拦。
 */
export function referenceNameNotes({ missing, notFull, inconsistent }, { packs, perPack }) {
  const QUOTED = 5; // 说明里只引前几句，全部的在 details 里
  const notes = [];
  for (const pack of packs) {
    const { recognized } = perPack.get(pack).names;
    const named = (message) => `${pack.manifest.name}: ${message}`;
    const who = { pack: pack.manifest.id };
    const absent = [...(missing.get(pack)?.values() ?? [])];
    if (absent.length > 0) {
      const quoted = absent.slice(0, QUOTED).map(({ line, opening }) => `line ${line + 1} ${opening}`).join(', ');
      const more = absent.length > QUOTED ? ` etc. (${absent.length} lines)` : '';
      notes.push({
        code: 'reference_name_missing',
        message: named(`${absent.length} ${absent.length === 1 ? 'line opens' : 'lines open'} with a square bracket that is not a name this pack recognizes: ${quoted}${more}. These lines do not name the reference text: it takes the name of the first line of its request (or the speaker's, in a scene), or none if that is not recognized. The names this pack recognizes are ${recognized.map((name) => `"${name}"`).join(', ')}. Write the character's full name in the line's language before any cue (models/scene3.md「Put the character name first」). This is only a note: the line is sent as written`),
        details: { lines: absent.map(({ line, opening }) => ({ line, opening })), names: recognized, ...who },
      });
    }
    const wrong = [...(notFull.get(pack)?.values() ?? [])];
    if (wrong.length > 0) {
      const quoted = wrong.slice(0, QUOTED).map((item) => `line ${item.line + 1} ${item.opening} (${item.language}: "${item.name}")`).join(', ');
      const more = wrong.length > QUOTED ? ` etc. (${wrong.length} lines)` : '';
      notes.push({
        code: 'reference_name_not_full',
        message: named(`${wrong.length} ${wrong.length === 1 ? 'line opens' : 'lines open'} with the pack's name, which is not the full name in that line's language: ${quoted}${more}. The reference text keeps the name its first line gives it, as before; write the full name in the line's language at the start of the line (models/scene3.md「Put the character name first」). This is only a note`),
        details: { lines: wrong.map((item) => ({ line: item.line, opening: item.opening, language: item.language, name: item.name })), ...who },
      });
    }
    for (const [name, byParagraph] of inconsistent.get(pack) ?? []) {
      const items = [...byParagraph.values()];
      const quoted = items.slice(0, QUOTED).map(({ line, opening }) => `line ${line + 1} ${opening}`).join(', ');
      const more = items.length > QUOTED ? ` etc. (${items.length} lines)` : '';
      notes.push({
        code: 'reference_name_inconsistent',
        message: named(`${items.length} ${items.length === 1 ? 'line opens' : 'lines open'} with a name other than "${name}", which the reference text takes from its first line: ${quoted}${more}. This is only a note`),
        details: { pack: pack.manifest.id, name, lines: items.map(({ line, opening }) => ({ line, opening })) },
      });
    }
  }
  return notes;
}
