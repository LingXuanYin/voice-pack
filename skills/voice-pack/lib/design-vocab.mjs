// SPDX-License-Identifier: Apache-2.0
//
// 设计词表和场景词表的查询（流程层，纯数据）：音色标签只能从设计词表里取，适合的场景只能从场景词表里取。
// 词表的正本是 vocab/design.json 和 vocab/scenes.json，这里不写任何词；词表加了新词，这里自动认。
//
//   lookupDesignTag(text)       音色标签的规范写法（别名换成它指向的规范写法），不在词表里给 null
//   lookupScene(text)           场景的规范写法（场景 id），不在词表里给 null
//   normalizeDirection(direction)   把配音指引里的结构化部分 { description?, tags?, scenes? } 的标签和场景换成规范写法，列出不在词表里的
//
// 认哪些写法（大小写、全半角、两头的空白不论）：
//   音色标签   设计词表 categories 里每个分类的取值（性别、年龄、音高、风格、英语口音、中文方言；「Auto」不算标签），
//             加上 extra 里的音色、节奏、情绪标签；这些的中文名（zh 里的 male -> 男声，extra 里的 温暖 -> warm）也认；
//             再加上别名（aliases 里每一项 [写法, 规范写法]：明亮 -> bright，British -> british accent）。规范写法：英文名（中文方言是它自己）
//   场景      场景词表里每一项的 id、中文名、英文名；规范写法是 id
// 换成规范写法以后重复的只留第一个；标签最多 32 个，场景最多 16 个（protocol/FORMAT.md「角色部分的清单」）。
//
// 规范写法和别名（vocab/design.json）：规范写法是一个音色标签唯一的写法（一个概念一个），清单的 direction.tags 里存的就是它；
// 别名是意思和某个规范写法相同的另一种写法，读入时换成那个规范写法，包里不存别名。
// 基础部分发布以后，规范写法只能加，不能删，也不能改写法：它已经存在发出去的包里（包是别人手里的 zip，收不回来），也存在收到这些包的服务那边的记录里，
// 以后的搜索、筛选、显示都按它算；词表随基础部分发布，已发布的版本不可变。删掉或改掉一个，旧包照样过检查（检查不看词表），没有报错，只是悄悄变差：
// 这个包发新版本时，带着它的 direction 会因为「不在设计词表里」被拒绝（make_pack_input_invalid），要作者自己把那个标签拿掉；
// 按规范写法查显示名、性别、年龄的地方（搜索、筛选、显示）认不出它，显示退回原样，靠它筛选就找不到带着它的包。写错了的也一样删不掉，所以加之前先确认它是一个新概念。
// 别名随时可以加：它不存进任何包，加别名不碰已存的东西。删别名或改它指向的写法不会让哪个包坏掉，但老声音迁移过来的、作者的指引里用这个词的，从此认不出它。
// 这里只写这个模块怎么用：
//   lookupDesignTag 把别名换成规范写法，所以做包写进清单（direction.tags）的永远是规范写法；别名只在读入的时候认，设计页和包编辑器的选项（来自 categories 和 extra）里没有别名。
//   服务端搜索也认别名：搜别名，找到带着那个概念的所有包。
//   什么词能当规范写法：说声音听起来怎样、怎么说的词（音色、节奏、情绪和态度），一个概念一个。角色、体裁、场合、用途的词（老师、都市、娱乐……）不是标签，词表不收；
//   只有一个已有概念明显对得上的，才做成那个概念的别名。拿不准的词先做别名：以后发现它其实是另一个概念，再升成规范写法，旧包存的仍是原来的规范写法，照样读。
// 词表里一个中文名只对一个规范写法，一个规范写法只对一个中文名；别名的写法也不能和任何规范写法、中文名、别的别名重名；别名指向的必须是一个真有的规范写法
// （categories、zh、extra、aliases 合起来）：服务端按规范写法反查中文名，
// app 按规范写法找显示名，重名会让其中一个词搜不到。下面 tagTable 的「先到先得」只是兜底，不是让词表可以重名。
// 场景 id（vocab/scenes.json）同理：存在清单的 direction.scenes 和收到包的服务那边的记录里，基础部分发布以后只能加，不能删、不能改、不能挪位置；
// 违反了会坏在哪里和上面一样（旧包照样过检查，发新版本时被拒绝，按 id 查显示名、用途的地方认不出它）。场景没有别名这一层，加了就收不回。
// 场景的中文名、英文名不存进包里，可以改（lookupScene 认的写法跟着变，不影响已发布的包）。
//
// normalizeDirection 返回 { direction, problems }：direction 是换好的新对象（没改传进来的）；problems 是 [{ field, message }]，field 写成 tags[1]、scenes[0]、
//   description 这样的路径（相对 direction），空数组就是都对。形状不对（不是对象、tags 不是数组……）也记成 problems，不抛错：调用方（lib/make-pack-input.mjs）按它报 make_pack_input_invalid。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import design from '../vocab/design.json' with { type: 'json' };
import scenesVocabulary from '../vocab/scenes.json' with { type: 'json' };

export const MAX_TAGS = 32;
export const MAX_SCENES = 16;
export const MAX_DESCRIPTION = 500;

const keyOf = (text) => String(text).normalize('NFKC').trim().toLowerCase();

/** 词表里每个能认的写法 -> 规范写法。 */
function tagTable() {
  const table = new Map();
  const add = (written, canonical) => {
    if (!table.has(keyOf(written))) table.set(keyOf(written), canonical);
  };
  for (const values of Object.values(design.categories)) for (const value of values) if (value !== 'Auto') add(value, value);
  for (const [english, chinese] of Object.entries(design.zh)) add(chinese, english);
  for (const pairs of Object.values(design.extra)) for (const [chinese, english] of pairs) { add(english, english); add(chinese, english); }
  for (const [written, canonical] of design.aliases) add(written, canonical);
  return table;
}

function sceneTable() {
  const table = new Map();
  for (const [id, chinese, english] of scenesVocabulary.scenes) for (const written of [id, chinese, english]) if (!table.has(keyOf(written))) table.set(keyOf(written), id);
  return table;
}

const TAGS = tagTable();
const SCENES = sceneTable();

export const lookupDesignTag = (text) => (typeof text === 'string' ? TAGS.get(keyOf(text)) ?? null : null);
export const lookupScene = (text) => (typeof text === 'string' ? SCENES.get(keyOf(text)) ?? null : null);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 一个列表：每一项换成规范写法，重复的去掉，不在词表里的记成问题。 */
function normalizeList(list, name, lookup, { limit, vocabulary }) {
  const problems = [];
  if (!Array.isArray(list)) return { list: undefined, problems: [{ field: name, message: `必须是数组（${vocabulary}里的名字）` }] };
  const out = [];
  list.forEach((entry, index) => {
    const canonical = lookup(entry);
    if (canonical === null) problems.push({ field: `${name}[${index}]`, message: `${JSON.stringify(entry)} 不在${vocabulary}里` });
    else if (!out.includes(canonical)) out.push(canonical);
  });
  if (out.length > limit) problems.push({ field: name, message: `最多 ${limit} 个，换成规范写法去重以后还有 ${out.length} 个` });
  return { list: out, problems };
}

export function normalizeDirection(direction) {
  if (!isPlainObject(direction)) return { direction: undefined, problems: [{ field: '', message: '必须是对象 { description?, tags?, scenes? }' }] };
  const problems = [];
  const out = {};
  for (const key of Object.keys(direction)) {
    if (!['description', 'tags', 'scenes'].includes(key)) problems.push({ field: key, message: `不认识的字段（只有 description、tags、scenes）` });
  }
  if (direction.description !== undefined) {
    if (typeof direction.description !== 'string' || direction.description.trim() === '' || [...direction.description].length > MAX_DESCRIPTION) problems.push({ field: 'description', message: `必须是 1–${MAX_DESCRIPTION} 个字符的一句音色描述` });
    else out.description = direction.description.trim();
  }
  if (direction.tags !== undefined) {
    const result = normalizeList(direction.tags, 'tags', lookupDesignTag, { limit: MAX_TAGS, vocabulary: '设计词表（vocab/design.json：性别、年龄、音高、风格、口音、方言的取值，加上音色、节奏、情绪标签）' });
    problems.push(...result.problems);
    if (result.list !== undefined) out.tags = result.list;
  }
  if (direction.scenes !== undefined) {
    const result = normalizeList(direction.scenes, 'scenes', lookupScene, { limit: MAX_SCENES, vocabulary: '场景词表（vocab/scenes.json）' });
    problems.push(...result.problems);
    if (result.list !== undefined) out.scenes = result.list;
  }
  return { direction: out, problems };
}
