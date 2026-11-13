// SPDX-License-Identifier: Apache-2.0
//
// 设计出来的声音，从锁定试听到交出去的包，后面几步的命令（流程层，纯函数）。design 命令和 clean-room --designed 的「接下来」都打印它，写法只在这里；
// 流程和理由的正本是 references/make-pack.md「Making a pack from a designed voice」。
//
//   designedPackSteps({ material, designSource, adapter, direction?, guidance?, sampleLines?, cardLine?, setups?, sourcePack? }) -> string[]
//     给人看的几行。material、designSource 是 design 命令写出的文件（还没有的写尖括号占位）；adapter 是接适配器的那一段命令行；
//     direction、guidance、sampleLines、cardLine 是写好的文字的文件，setups 是默认预设的文件（一套 default 的设定，带这个角色的起伏），不给写占位；
//     起伏按角色取（models/scene3.md「How to choose the value」），这里不写死一个数：第 b 步配那一段用它，第 c 步写进默认预设，试听句照配音的规矩用默认预设的值；sourcePack 是 true：命令里带 --source-pack <来源包>（照一个已有的包做新包时，clean-room --designed）；
//     不是 true（design 命令不知道有没有来源包）：命令下面多一行，说照已有的包做新包的要加 --source-pack。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

export function designedPackSteps({ material, designSource, adapter, direction = '<direction.json>', guidance = '<guidance.md>', sampleLines = '<sample-lines.json>', cardLine = '<card-line.txt>', setups = '<setups.json>', sourcePack = false }) {
  return [
    '  A designed voice has three more steps; the audition is only raw material (references/make-pack.md「Making a pack from a designed voice」):',
    '  a. Make a temporary pack from the audition; it is not handed over:',
    `     node cli.mjs make-pack ${material} --output <temp directory> --name <name> --language <language this voice will speak> --default-segment intro --no-holdout ${adapter}`,
    '  b. Write an acted passage and save it as a script (references/character-voice.md「Default segment: a passage the character says naturally, with acting」). First add --dry-run to see whether it is one request, then dub it with the temporary pack:',
    `     node cli.mjs dub <temp directory> <passage.txt> --out <dub directory> --expressiveness <value for this role> ${adapter}`,
    '     <value for this role>: an integer from 0 to 100, set per role (models/scene3.md「How to choose the value」), not a fixed number; the "expressiveness" line in the text output of --dry-run says which value is used',
    '  c. Copy <dub directory>/001-intro.<extension> to audio/acted.<same extension>, write the material as { "segments": [ { "id": "acted", "audio": "audio/acted.<extension>", "scriptText": "<script of that passage>" } ] }, and write a default setups file (just one setup, with the same value; once the pack is made, dubbing and the audition line use it when no expressiveness is given): [ { "name": "default", "default": true, "expressiveness": <value for this role> } ], then make the pack to hand over:',
    `     node cli.mjs make-pack <final material.json> --output <new directory> --name <name> --short-name <English short name> --language <language this voice will speak> --design-source ${designSource} --direction ${direction} --guidance ${guidance} --sample-lines ${sampleLines} --card-line ${cardLine} --setups ${setups} --default-segment acted --no-holdout${sourcePack ? ' --source-pack <source pack>' : ''} ${adapter}`,
    // 不知道有没有来源包（design 命令）：紧跟着写明，照着最近一次打印的命令走的 agent 才不会漏掉查重
    ...(sourcePack ? [] : ['     If you are making a new pack from an existing pack (you went through clean-room), add --source-pack <source pack directory or share file> to this command: the duplicate check depends on it, and without it nothing is compared']),
  ];
}
