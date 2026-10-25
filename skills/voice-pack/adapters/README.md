# 适配器

**适配器**是一个运行环境的那一份：把所需能力（`vocab/capabilities.json`）对到这个环境里具体的模型或服务。模型只从适配器接进来；所有适配器所在的这一层（本目录 `adapters/`）叫**环境适配层**。

这份文件是适配器约定的**唯一正本**：工厂的签名、返回的形状、出错的约定、只是声明的能力、验证记录里的模型名从哪来，都只写在这里。别处只指向它，改了就改这一处。

## 谁是适配器

| 种类 | 在哪 | 命令行上怎么给 |
|---|---|---|
| 官方适配器 | `adapters/<名字>/adapter.mjs`（名字是小写字母、数字、连字符）；官方的只有 `process`（`process/README.md`：把能力调用转给你自己的程序） | `--adapter <名字>`；`adapter.json` 里声明了简写的，还可以用简写（下面「命令行上怎么给」） |
| 别的适配器（自己写的，或者别的产品带的） | 一个 ES 模块文件，或一个里面有 `adapter.mjs` 的目录，放在哪都行 | `--adapter <模块文件或目录>`（给的不是官方名字就当路径，相对命令的当前目录；官方名字只由小写字母、数字、连字符组成，所以当前目录里一个叫 `mytts` 的目录要写成 `./mytts`） |

两种写法一样：默认导出同一个**工厂**（或者导出名叫 `createAdapter` 的函数）。**加一个官方适配器只加目录** `adapters/<名字>/`，不改别的文件。模型名只出现在 `adapters/<名字>/` 里；通用层（`protocol/`、`lib/`、`tools/`、`cli/`）不 import 任何一个适配器，文字里也不出现某个适配器专有的东西，用适配器只经过 `cli/adapters.mjs`。

## 工厂

```js
export default async function createAdapter({ cwd, dir, env, options, use, VoicePackError }) {
  return { capabilities, runtimes, fetch, billing, limits, previewCard };   // 每一项都可选
}
```

可以是同步函数，也可以是异步函数。拿到的参数：

| 参数 | 是什么 |
|---|---|
| `cwd` | 命令的当前目录 |
| `dir` | 适配器自己的目录（自己的适配器：模块文件所在的目录，或给的那个目录）。官方适配器在命令行上给名字时，是命令的当前目录 |
| `env` | 命令此刻已有的运行环境（命令自己的，加上前面给的适配器），只读着看。要看有没有某项能力、有没有 `fetch`，从这里看 |
| `options` | 命令行上给这个适配器的参数，`{ 键: 字符串 }`，没给就是 `{}`。键认哪些，由适配器自己说（见下面「命令行上怎么给」） |
| `use(名字, 选项)` | 加载另一个官方适配器，返回它的返回值（**不**并进环境，怎么用由你定）。名字不是现有的官方适配器（写法不对的，例如带路径，也算）抛 `adapter_not_found`；名字不是字符串是调用写错了，抛 `TypeError` |
| `VoicePackError` | 库的错误类（见「出错的约定」），免得自己的适配器要 import 基础部分的文件 |

### 返回的形状

返回一个对象，下面六个键都可选，**不认识的键报错**（多半是拼错了，不悄悄忽略）：

| 键 | 值 | 通用层怎么用它 | 不给的话 |
|---|---|---|---|
| `capabilities` | `{ 能力名: 函数 }`，能力名只能取自能力词表；只是声明的能力值写 `true`（下面「只是声明的能力」） | 并进命令的运行环境的 `capabilities` | 这个适配器没有提供任何能力（只是「没有」，不是错误；检查会给一条警告） |
| `runtimes` | `{ 工具名: 函数 }`，命令行工具的实现，例如 `ffmpeg`；签名写在第一个调用它的模块的文件头（`@runtime`） | 并进 `runtimes` | 用命令已有的 |
| `fetch` | 函数，形同标准 `fetch(input, init)` | 成为命令的网络读取（所有网络读取都走它） | 用命令已有的 |
| `billing` | 非空字符串：一句话说明调用这个适配器的能力，**费用记在哪里**。写成能接在「要」后面的短语，例如「在某个账户上调用，费用记在使用者自己的账户上」 | 每次花钱的几步开始之前，命令把它写到标准错误里，开头是「要」，后面接各项能力调几次；`--json` 时不说，免得弄脏机器读的输出（`dub`、`convert`、`make-pack`、`fidelity` 都这样） | 命令不说费用：这个适配器不花钱，或者费用不归这里管 |
| `limits` | `{ maxChars?, minChars? }`：`maxChars` 是**一次合成最多多少个字**，整数，不小于 10（同 `dub` 的 `--max-chars`）；`minChars` 是**合成能力一次至少要多少个字**，整数，不小于 1（码位，同 `minChars` 选项，见 `lib/dub.mjs`），例如 15 | `maxChars`：`dub` 默认按它把长句子按句子切开；命令行上给的 `--max-chars` 盖过它。`minChars`：`dub`、`make-pack` 的试合成按它并段，并不了的那一段记成失败、不调用能力（规则见 `lib/dub.mjs` 的文件头） | 不限制：`dub` 不切，也不并段（同没给 `--max-chars`） |
| `previewCard` | `{ productName?, links?: { open?, make? } }`：这个适配器背后的**产品**，在分享文件的预览卡片（`index.html`）上写什么。`productName` 是「在 X 里打开」里的 X；`links.open` 是打开入口，`links.make` 是「做一个你自己的」入口，都是完整的 `http`、`https` 地址，里面的 `{id}` 换成包 ID。形状同核心层 `pack` 命令的 `--product-name`、`--open-link`、`--make-link` | `make-pack` 的 `--share-file` 打分享文件时把它交给卡片生成程序（`protocol/lib/preview-card.mjs` 不写任何产品的名字和地址，只收调用方给的值） | 卡片上没有产品名，也没有这两个入口（只用别的适配器，或者不用适配器，都是这样） |

几个适配器一起给时怎么合并（同名的能力谁盖过谁、`billing` 怎么连起来、`limits` 和 `previewCard` 取谁的），**只在 `cli/adapters.mjs` 的文件头写一处**，这里不重述。

`billing`、`limits.maxChars` 和 `previewCard` 是适配器自己的事（费用记在哪个账户、一次最多合成多少字、卡片上写哪个产品），放进返回值里，通用层就不用去读某个适配器的产品契约。**适配器给的数不要在代码里再写一份**：它有自己的数据就从那里取（例如一个产品带的适配器，`maxChars` 和 `previewCard` 从这个产品自己的契约文件里读）。

返回的形状由 `lib/adapter-check.mjs` 的 `checkAdapterShape` 核对，加载时不合格报 `adapter_invalid`，`details.problems` 一条一条说哪里不对。

### 能力

一项能力就是一个函数：**一个对象参数**，**返回值（可以是 Promise）**；参数和返回值的字段、报错，每项能力的签名**只写在 `vocab/capability-signatures.md`**，这里不重抄。音频一律是字节加 MIME 类型 `{ bytes, mimeType }`，不收 URL、Base64 字符串、文件路径。

环境缺哪项就不提供哪项：不要假装有，用到它的功能会抛 `capability_missing` 并点名。

### 只是声明的能力

有一类能力不是函数，是**声明**：环境提供它，表示别的能力会按它说的做。目前只有一个：`style-instruction`，写成 `'style-instruction': true`，表示合成能力会按参数 `instructions` 里的话调整语气（理由和用法见 `vocab/capability-signatures.md`「怎么念」）。名单只在 `protocol/lib/env.mjs` 的 `DECLARED_CAPABILITIES` 里写，检查、骨架生成都按它认；值不是 `true` 报 `declaration_not_true`。

声明说的是**这个环境能为调用方做到什么**，不是模型或服务的请求格式里恰好有哪个字段。模型或服务要是有别的途径接受这类说明（一个 meta 字段、一次单独的调用、一段拼进提示的文字），适配器就翻译过去，再声明它。「模型或服务做不到」和「这个适配器没往请求里放」是两回事：后者要在适配器里补上，不能拿来当不声明的理由。判断依据是模型或服务能不能做到，不是现在的请求拼装代码里有没有那个键。

### 验证记录里的模型名从哪来

做包时写进验证记录的「用的是哪个模型」，来自**能力的返回值里的 `model`**（非空字符串）：适配器愿意报出实际用了哪个模型就报，库把它记进验证记录和还原度报告；不报，验证记录里就写不出这一项（检查会给一条警告 `model_missing`）。验证记录里的「环境」，命令行上取适配器的名字（几个就用 `+` 连起来），可以用 `--environment` 改。

## 出错的约定

适配器抛的错，通用层按下面几条对待：

1. **抛什么错、`VoicePackError` 的字段怎么写，照 `protocol/README.md` 的「错误」一节**；`VoicePackError` 这个类就在工厂参数里（见上面的表），不用自己 import。适配器抛的 `code` 谁抛谁定义，写在适配器自己的文件头。
2. **服务暂时出错要标出来**：上游 5xx、网关超时、网络错误、超时……这类稍后重来也许就成的，抛 `VoicePackError` 并在 **`details.transient` 里写 `true`**（有 HTTP 状态就放 `details.status`）。一次要调很多次能力的功能（`fidelity`、`dub`、`make-pack`、长录音的转写）据此把这一条记成「没听成」或「失败」，接着做别的，事后再决定要不要补做，不让整件事作废。**重来也没用的不标**：缺能力、参数错、凭据被拒、返回的形状不对、服务明确报的业务错。没标的错，通用层一律原样往上抛，不按 HTTP 状态去猜。
3. **凭据被拒要拦住后面的调用**：服务回凭据不对（HTTP 401，或等价的）时，抛一个不带 `transient` 的错，并且**这个适配器之后不再向服务发任何请求**：后面的调用直接抛同一个 `code`，`details.halted` 为 `true`，说明是此前被拒过。理由：有的服务把一次凭据被拒当作登录失效，会清掉用户本机的登录态，再试一次是把事情弄糟。调用方应当停下来，让使用者处理，不要重试。
4. **不替会计费的调用重试**：库不重试能力调用（建任务、补全这类重试可能重复计费），只有两处例外：做包时每段录音最多转写 3 次、最多让听者（`audio-text-to-text`）打 3 次标签，暂时出错（`details.transient`）才再来（`lib/call-attempts.mjs`，盲听出错不在这里，它有自己的补做）。所以暂时出错要标对：标了 `transient` 的错，库会为同一段录音再调一次，没标的不会。多调的次数照最多的次数写进「确认费用」，用户同意的是上限；某个环境上量到的计费事实（失败的调用收不收费），写在那个环境的适配器里。适配器自己只重试不花钱、可以重复做的几步（例如只读的轮询），并且写明哪些重试、重试几次。
5. **凭据的值不进任何地方**：报错的 `message`、`details`、日志、`cause` 里都不能有令牌、密钥的值。适配器读到的凭据只用来发请求。
6. **服务商拦下了回答，要报成被拦下，不要当成回答交出去**：听音频的能力（`audio-text-to-text`）拿到的回答，如果是服务商用内容过滤拦下时的那句说明，抛 `provider_blocked`，不带 `transient`（同一段录音再问还是被拦）。认的是服务商的原话，所以只写在适配器里，通用层只认这个 code。写法和库怎么对待它，只在 `vocab/capability-signatures.md` 的 `audio-text-to-text` 一节。

加载适配器时的错（`cli/adapters.mjs`）：`adapter_invalid`（`details.reason`：`load` 模块加载不了、`not_function` 没有默认导出的函数、`factory_failed` 工厂抛了错、`shape` 返回的形状不对、`manifest` 官方适配器的 `adapter.json` 写坏了）和 `adapter_not_found`（给的是名字，`adapters/` 里没有这个官方适配器，错误说明会教人自己的适配器要给路径；适配器里 `use(名字)` 的名字不对也是它）。工厂自己抛的 `VoicePackError` 原样往上，不包。

## 命令行上怎么给

`dub`、`convert`、`make-pack`、`fidelity` 都认同一套参数。统一的入口只有 `cli/adapters.mjs`（合并规则见上，只在它的文件头写）：

- `--adapter <名字|模块文件>`：可以给多个。
- **适配器的参数怎么传**：`--adapter-option <键=值>`，跟在它要给的那个 `--adapter` 后面（值是字符串，值里可以有 `=` 和空格）；工厂从 `options` 里读。键是字母开头的字母、数字、下划线。每个适配器认哪些键，写在它自己的文件头；不认识的键适配器自己决定报不报。
- **官方适配器可以在 `adapters/<名字>/adapter.json` 里声明命令行上的样子**（可选）：
  ```json
  { "summary": "一句话", "shorthand": true, "flags": { "--zone": "zone" } }
  ```
  `shorthand` 为 `true`：`--<名字>` 是 `--adapter <名字>` 的简写。`flags`：这个适配器专有的参数，`--zone <值>` 等于 `--adapter-option zone=<值>`，它属于离它最近的前一个同名适配器，前面没有就属于后面第一个同名的；命令行上一个这样的适配器也没有，报用法错误（退出 2），不悄悄忽略。命令的用法说明里的这一段也按 `adapter.json` 生成。**声明的参数名由入口在命令看到参数之前取走**，所以命令自己不能再用同一个名字。
- 现在官方的只有一个：
  - `process`：`--adapter process --command "python my_tts.py"`，`--command` 就是 `--adapter-option command="python my_tts.py"`（没有简写；选项和进程协议见 `process/README.md`）。

## 做自己的适配器

四步，每步一条命令（`node cli.mjs adapter …`，命令的用法看 `node cli.mjs help adapter`）：

1. **生成骨架**：`adapter new <目录> --capabilities <能力,…> [--kind module|process]`。目录必须还不存在，不覆盖任何东西；能力名要在能力词表里（拼错在写任何文件之前报，列出词表）。
   - `module`（默认）：一个 ES 模块 `adapter.mjs`，每项能力一个函数，函数体抛 `adapter_not_implemented`（还没实现；定义在 `lib/adapter-skeleton.mjs` 的 `NOT_IMPLEMENTED`）；只是声明的能力写 `true`。
   - `process`：模型是 Python 之类的程序时用：`program.py`（协议那一半已经写好）加 `adapter.mjs`（把能力调用交给 `program.py`，经进程适配器）；需要本机有 Python 3。协议和选项见 `process/README.md`。
   - 每项能力上面的注释（说明、参数、返回值）**从 `vocab/capability-signatures.md` 生成**，不在生成程序里抄一份；签名表改了，新生成的骨架跟着变。官方适配器加一个 `skeleton.mjs`（导出 `generateSkeleton`）就多一种骨架，写法在 `lib/adapter-skeleton.mjs` 的文件头。
2. **填写**：把每项能力里「还没有实现」的那一行换成真的调用，返回值照注释里写的（音频是 `{ bytes, mimeType }`；愿意报模型名就在返回里写 `model`）。
3. **检查**：`adapter check <名字|模块文件|目录> [--live] [--capability <能力,…>] [--text <文字>]`。适配器的参数照上面「命令行上怎么给」写在后面（例如 `adapter check process --command "python my_tts.py"`）。
   - 默认只看**结构**，不调用任何能力：能加载、返回的形状对、能力名都在能力词表里、能力是函数、只是声明的能力是 `true`、`billing` 和 `limits` 写得对；`--capability` 点名的能力必须有。加载不了（找不到、写坏了、起程序失败）也是一次不通过的检查，错误写在结果里。规则和每个问题的 code 在 `lib/adapter-check.mjs` 的文件头。
   - `--live`：再把每项**有调用写法的**能力用一段很短的输入（一句 `Hello, this is a check.`，或 `--text` 给的；要音频的给基础部分附带的一段人声 `lib/adapter-check-voice.wav`，5–8 秒，逐字文本在旁边的 `.json` 里）**真调用一次**，核对返回：音频的 `mimeType` 对得上字节、能解码、长度大于 0，文字、相似度、说话区间的形状对，`model` 有没有（没有只是警告）。会真的调用模型，可能花钱、占算力：**调之前**在标准错误里说明调哪几项、各几次，适配器给了 `billing` 也写上（`--json` 时不说，计划在输出的 `live.plan` 里）。结构不合格就不做真调用。一项失败不影响别的项接着查。只是声明的、没有真调用写法的能力不调，说明了原因（原因各是一个词：`no_signature` 是签名表里还没有它的调用写法，`not_wired` 是签名表里有、但检查还没接上，现在还没有后者）。声音设计（`voice-design`）也在真调用里：输入是固定的一段够长的试听文本加一句短描述（它不收 `Hello.` 这样的短句），会花一次设计请求，调之前的说明里有它。骨架里还没填写的能力报「还没有实现」，不当成适配器坏了。
   - 退出码：0 通过；1 不通过；2 用法错误。`--json` 输出一份 JSON（形状在 `cli/commands/adapter.mjs` 的文件头）。
4. **使用**：`--adapter <目录>` 交给 `dub`、`convert`、`make-pack`、`fidelity`（上面「命令行上怎么给」）。

`lib/adapter-check.mjs`（检查）和 `lib/adapter-skeleton.mjs`（生成）都是纯函数，浏览器、Node、Bun 都能跑：app 自己组装的环境可以在测试里直接调检查，不必经命令行。

## Node 专有的东西放哪

适配器要读环境变量、按 PATH 找程序、起进程，这些是 Node 专有的，库的程序里不许出现（`protocol/README.md`「模块约定」）。所以：

- **工厂文件 `adapters/<名字>/adapter.mjs` 是例外**：它在适配器的主人一侧运行，可以用 Node 专有的东西，也可以 import 自己目录里的 `cli/`；只有 `cli/adapters.mjs` 加载它，app 和浏览器从不加载它。例外只给这一个文件名，适配器目录里别的文件照旧不许用 Node 专有的东西。
- **纯的部分放在别的文件里**，浏览器和 Node 都能跑，app 才能直接用它：组装能力的那部分不碰环境变量、不起进程，客户端、凭据、网络读取都由调用方给；`adapter.mjs` 只负责把 Node 一侧的东西（环境变量、本机的客户端）接上去。进程适配器就是这样：`wire.mjs`（请求的编码、回应的解析）是纯的，起进程的 `cli/session.mjs` 是 Node 专有的。骨架生成器 `skeleton.mjs` 也是纯的。
- 适配器只依赖核心层（`protocol/lib/`）和自己的目录。

## 信任

适配器在本进程里直接运行，不隔离，不让使用者确认，和包里的脚本一样。用不用、用哪个适配器，是命令行上这个人的决定；不要把别人给的适配器不看就接上。
