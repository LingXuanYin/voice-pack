// SPDX-License-Identifier: Apache-2.0
//
// 设计出来的声音，从锁定试听到交出去的包，后面几步的命令（流程层，纯函数）。design 命令和 clean-room --designed 的「接下来」都打印它，写法只在这里；
// 流程和理由的正本是 references/make-pack.md「设计出来的声音怎么做包」。
//
//   designedPackSteps({ material, designSource, adapter, direction?, guidance?, sampleLines?, cardLine?, sourcePack? }) -> string[]
//     给人看的几行。material、designSource 是 design 命令写出的文件（还没有的写尖括号占位）；adapter 是接适配器的那一段命令行；
//     direction、guidance、sampleLines、cardLine 是写好的文字的文件，不给写占位；sourcePack 是 true：命令里带 --source-pack <来源包>（照一个已有的包做新包时）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export function designedPackSteps({ material, designSource, adapter, direction = '<音色.json>', guidance = '<指引.md>', sampleLines = '<示例台词.json>', cardLine = '<卡片台词.txt>', sourcePack = false }) {
  return [
    '  设计出来的声音还有三步，试听只当原料（references/make-pack.md「设计出来的声音怎么做包」）：',
    '  a. 用试听做临时的包，不交出去：',
    `     node cli.mjs make-pack ${material} --output <临时目录> --name <名字> --language <这个声音要说的语言> --default-segment intro --no-holdout ${adapter}`,
    '  b. 写一段带表演的话，存成台本（references/character-voice.md「默认段」）。先加 --dry-run 看是不是一个请求，再用临时的包配：',
    `     node cli.mjs dub <临时目录> <那一段.txt> --out <配音目录> --expressiveness 80 ${adapter}`,
    '  c. 把 <配音目录>/001-intro.<扩展名> 拷成 audio/acted.<同一个扩展名>，素材写成 { "segments": [ { "id": "acted", "audio": "audio/acted.<扩展名>", "scriptText": "<那一段的台本>" } ] }，做交出去的包：',
    `     node cli.mjs make-pack <正式素材.json> --output <新目录> --name <名字> --short-name <英文短名> --language <这个声音要说的语言> --design-source ${designSource} --direction ${direction} --guidance ${guidance} --sample-lines ${sampleLines} --card-line ${cardLine} --card-line-expressiveness 70 --default-segment acted --no-holdout${sourcePack ? ' --source-pack <来源包>' : ''} ${adapter}`,
  ];
}
