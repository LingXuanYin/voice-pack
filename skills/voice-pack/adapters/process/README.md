# 进程适配器

官方适配器 `process`：把每次能力调用变成对**你自己的程序**的一次请求，经程序的标准输入输出，一行一个 JSON。模型是现成的 Python 之类的程序时用它：不用写适配器的代码，只写（或改）那个程序。适配器是什么、工厂怎么写、出错怎么报，约定只写在 `../README.md`；这里写进程适配器自己的：**怎么用、进程协议、出错、程序怎么被收掉**。进程协议只在这一份里写，适配器的实现（`wire.mjs`、`cli/session.mjs`）和生成的程序骨架都指向这里。

## 怎么用

| 想做什么 | 命令 |
|---|---|
| 程序已经写好 | `node cli.mjs dub <包目录> <台本> --out <目录> --adapter process --command "python my_tts.py"`（`--command` 是进程适配器的参数，等于 `--adapter-option command="python my_tts.py"`） |
| 还没有程序，要一个骨架 | `node cli.mjs adapter new <目录> --kind process --capabilities text-to-speech,voice-cloning`：生成 `adapter.mjs` 和 `program.py`，填写 `program.py`，再 `--adapter <目录>`（见 `../README.md`「做自己的适配器」） |
| 在自己的适配器里用 | `export default ({ use }) => use('process', { command: ['python', 'my_tts.py'], capabilities: ['text-to-speech'] })` |

程序可以是任何语言写的，只要照下面的进程协议读标准输入、写标准输出。生成的骨架是 Python 的，并且自带了协议的那一半（读请求、写回应、把标准输出让给协议）。

## 选项

命令行上用 `--adapter-option 键=值`（`command` 还有简写 `--command`）；在自己的适配器里 `use('process', { … })` 给对象，值可以是数和数组。键写错报 `process_option_invalid`。

| 选项 | 意思 | 默认 |
|---|---|---|
| `command` | 必给。程序怎么起：一个字符串（按空白分开；`"…"` 和 `'…'` 里的空白不分开，引号本身不留；没有别的转义，Windows 路径里的反斜杠照原样），或一个字符串数组（只能在 `use()` 里给，每项就是一个参数）。**不经 shell**：`.cmd`、`.bat` 起不来，写 `python`、`node` 或程序的完整路径 | |
| `capabilities` | 这个适配器提供哪些能力，逗号隔开或数组。给了：加载时**不起程序**（结构检查看到的就是它），程序在第一次调用时才起，起来以后核对它在 `ready` 里有没有说有这些；没给：加载时就起程序，它在 `ready` 里说它有什么，就有什么 | 不给 |
| `timeout` | 一个请求最多等多少秒，超时就结束程序 | 300 |
| `startTimeout` | 等程序说 `ready` 最多多少秒（载入模型可能很慢） | 300 |
| `cwd` | 程序的当前目录。相对的写法相对适配器自己的目录 | 适配器自己的目录（命令行上直接给 `--adapter process` 时，是命令的当前目录） |

程序继承命令的环境变量，另外加上 `PYTHONUNBUFFERED=1` 和 `PYTHONIOENCODING=utf-8`（Python 的标准输入输出不缓冲、用 UTF-8）。

**没有单独的配置文件**：选项写在命令行上；要固定下来，用 `adapter new … --kind process` 生成的 `adapter.mjs`（里面的 `command`、`capabilities` 就是上面的选项），命令行上再给 `--adapter-option` 就盖过里面的同名项。

名字在 `DECLARED_CAPABILITIES`（只是声明的能力，目前只有 `style-instruction`，见 `../README.md`）里的，适配器返回 `true`，不发请求；程序在 `ready` 里仍然要说有它：这是程序对「合成会按 `instructions` 里的话调整」的承诺。

## 进程协议（版本 1）

**传输**：程序的标准输入和标准输出，UTF-8，**一行一个 JSON 对象**，换行结尾（`\r\n` 也认）。适配器写程序的标准输入，读程序的标准输出。标准错误不属于协议：程序的日志写在那里，出错时适配器会把最后一段带给使用者看。

**三种消息**：

1. 程序写 `ready`：程序载入完模型以后写**一次**，在这之前适配器不发任何请求。

   ```json
   {"event":"ready","protocol":1,"capabilities":["text-to-speech","style-instruction"],"info":{"program":"my_tts","device":"cuda"}}
   ```

   `protocol` 必须是 `1`；`capabilities` 是能力名的数组（非空字符串，重复的合并），包括只是声明的能力；`info` 可选，写什么都行（程序名、版本、设备），适配器不看。

2. 适配器写请求：

   ```json
   {"id":1,"capability":"voice-cloning","params":{"text":"Hello.","ref_audio":{"bytes":"UklGRg==","mimeType":"audio/wav"},"ref_text":"Hello."}}
   ```

   `id` 是适配器给的整数（从 1 起，每个请求加 1），程序原样放在回应里。`params` 是这项能力的参数，字段名就是 `vocab/capability-signatures.md` 里每项能力的调用写法里的那几个；**音频**是 `{ "bytes": <Base64 字符串>, "mimeType": "audio/wav" }`，参考音频的数组（融合）就是这样的对象的数组。`enhancers`（增强件是要 `load()` 才读得到内容的函数）不传。整行只含 ASCII（非 ASCII 的字符写成 JSON 的 `\uXXXX`），所以程序的标准输入不管默认是什么编码都读得对，按标准 JSON 解码就行。

   **一次只有一个请求在途**：回应（或程序死了）以后才发下一个，别的调用排队，按调用的先后。

3. 程序写回应，每个请求一个：

   ```json
   {"id":1,"ok":true,"result":{"bytes":"UklGRg==","mimeType":"audio/wav","model":"my-tts-v1"}}
   ```

   ```json
   {"id":1,"ok":false,"error":{"code":"gpu_busy","message":"the device is busy","transient":true,"details":{"device":0}}}
   ```

   - `ok` 必给，是 `true` 或 `false`。`ok` 为 `true` 时 `result` 必须是对象，字段就是这项能力的返回值（音频同样是 Base64 加 `mimeType`；`model` 愿意报就报，见 `../README.md`「验证记录里的模型名从哪来」）。
   - `ok` 为 `false` 时 `error.code` 必给（非空字符串）。`code` 是小写字母、数字、下划线、字母开头，就原样成为这个错误的 code；不是这个写法（例如 `"Out Of Memory"`），错误的 code 是 `process_program_error`，原来的放在 `details.programCode`。`message` 可选。`transient: true` 表示服务暂时出错、稍后重来也许就成（含义见 `../README.md`「出错的约定」）：**只认 `error.transient`**，`error.details` 里夹带的 `transient` 不算。`details` 可选，是对象，并进错误的 `details`（适配器再加上 `capability`）。
   - 请求的是程序没有的能力：回一个 `error`（骨架里的 `code` 是 `capability_unsupported`）。

**不是协议的行**：程序标准输出里不是协议消息的行（不是 JSON 对象、没有 `id` 也没有 `event` 的 JSON、不认识的 `event`）当作日志忽略，最后几行会放进出错的 `details.output`。所以多一两行 `print` 不会弄坏协议，但别指望它：生成的骨架把 `sys.stdout` 换成了标准错误，标准输出只给协议用。不认识的 `event` 也忽略，以后可以加新的事件。

**结束**：命令结束时适配器**关掉程序的标准输入**，程序读到输入结束就应该退出；3 秒内不退出，就被结束。程序自己的清理（保存状态、释放显卡）在读到输入结束之后做。

## 出错

下面都是 `VoicePackError`（`code` 在表里；`details` 里有什么在表里写明）。程序自己报的错（`error`）见上，code 由程序定。

| code | 什么时候 | details |
|---|---|---|
| `process_option_invalid` | 选项写错（没给 `command`、引号没配对、不认识的选项、`timeout` 不是正数……），在加载时报，不起程序 | `key` |
| `process_spawn_failed` | 程序起不来：找不到（检查 PATH，或把完整路径写进命令）、`cwd` 不存在、没有权限 | `command`、`reason`（系统给的原因，例如 `ENOENT`） |
| `process_start_timeout` | 超过 `startTimeout` 秒还没说 `ready`，已结束程序 | `seconds`、`stderr`、`output` |
| `process_exited` | 程序退出了，而 `ready` 或回应还没有来 | `stage`（`start` 或 `request`）、`exitCode`、`signal`、`capability`（`stage` 是 `request` 时）、`stderr`、`output` |
| `process_timeout` | 一个请求超过 `timeout` 秒没有回应，已结束程序 | `capability`、`seconds`、`stderr`、`output` |
| `process_not_running` | 程序已经不在了（此前起不来、退出了、超时被结束、违反了协议，或会话关了），这个调用没有发出去 | `capability`、`reason`（当初出的那个错的 code；会话被关了是 `closed`） |
| `process_protocol_error` | 程序违反了协议：`ready` 写得不对（`protocol` 不是 1、`capabilities` 不是名字的数组），或回应的 `id` 不是在途的请求（回了两次、回了没发过的 `id`）。已结束程序 | `reason`（`ready_invalid` 或 `unknown_id`）、`id`（`unknown_id` 时）、`stderr`、`output` |
| `process_capability_unsupported` | 选项 `capabilities` 里写了的能力，程序在 `ready` 里没说有。已结束程序 | `missing`、`announced` |
| `process_response_invalid` | 回应是协议的消息，但内容不对：没有 `ok`、`ok` 为 `true` 而 `result` 不是对象、`ok` 为 `false` 而 `error` 里没有 `code`、音频的 Base64 写得不对。**只这一个请求报错，程序不动**，后面的请求照常 | `capability`、`problem` |
| `process_request_invalid` | 请求编不出来：参数里有裸的字节（音频要写成 `{ bytes, mimeType }`）、循环引用。在发之前报，程序不动 | `capability`、`problem`（`bare_bytes` 或 `not_json`）、`field` |
| `process_program_error` | 程序报的 `error.code` 不合 code 的写法 | 程序给的 `details`、`capability`、`programCode`、`transient`（程序标了才有） |

`stderr` 是程序写在标准错误里的最后一段（不超过 2000 个字符），`output` 是它写在标准输出里的、不是协议消息的最后几行，帮人找原因（例如 Python 的栈追踪在 `stderr` 里）。

**超时和退出不标 `details.transient`**：适配器分不清一个卡住的程序和一个必现的 bug，宁可马上停下来让人看。程序知道自己的某个失败是暂时的，就在自己的 `error` 里写 `transient: true`。

## 生命周期

- **一个会话只起一次程序**。起不来、退出了、超时被结束、违反协议以后，会话就死了，后面的调用马上报 `process_not_running`，**不重起**：重起会让一个卡死的输入拖着后面的每个输入各等一次启动。要接着做，重新运行命令，它会起一个新的程序。
- **谁来收程序**：命令正常结束（事件循环空了）时，关程序的标准输入，请它退出，3 秒内不退就结束它；命令调了 `process.exit()` 或抛了没接住的异常时，同步地结束它；宿主被信号杀死、断电这类连退出事件都没有的情况：Windows 上 Node 把子进程放进一个宿主退出就关掉的作业对象，系统会收掉它，别的系统靠程序读到标准输入结束就退出（上面「结束」那一条）。超时、违反协议这类「宿主还活着、程序不行了」的结束，Windows 上用 `taskkill /T` 连它起的子进程一起结束（虚拟环境里的 `python.exe` 是个启动器，会再起真正的解释器，只结束启动器会留下解释器），别的系统只结束程序本身。**程序自己起的子进程（多进程的推理、数据加载）归程序管**：它们要在标准输入结束时自己退出。
- 程序是在本机、以你自己的权限、按你给的命令起的，和包里的脚本一样不隔离（见 `../README.md`「信任」）：只给自己信得过的命令。

## 费用说明和字数上限

进程适配器只返回 `capabilities`：它不知道你的程序花不花钱、一次最多合成多少字。要告诉命令（`dub` 在开始之前说明费用、按字数上限切句子），在自己的适配器里加上：

```js
export default async ({ use }) => ({
  ...(await use('process', { command: ['python', 'my_tts.py'] })),
  billing: '在我自己的服务器上调用，费用记在我自己的账户上',
  limits: { maxChars: 200 },
});
```

两个键的意思和不给的后果见 `../README.md`「返回的形状」。

## 写程序

用 `adapter new … --kind process` 生成的 `program.py` 已经把协议那一半写好了（读请求、分发、写回应、`ready`、把标准输出让给协议、异常变成 `error`），你只填每项能力的函数和 `load_models()`。用别的语言写，照上面的协议就行：先载入模型，写 `ready`，然后一行一行地读标准输入，每个请求写一个回应，读到输入结束就退出。写完用 `node cli.mjs adapter check <适配器> --live` 把每项能力真调一次，核对返回的音频能解码、长度大于 0、`mimeType` 对得上字节。
