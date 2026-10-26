// SPDX-License-Identifier: Apache-2.0
//
// 音质检查：量一段音频的时长、采样率、削波、静音占比、响度、底噪和信噪比，给出能不能当参考音频的结论和原因。只做计算，不用模型。
// 对参考集的建议是：每段 5–20 秒，干净，不带伴奏。这里把它落成可以量的数，数值（REFERENCE_THRESHOLDS）是这份实现定的，依据写在下面。
//
// 三个函数，分开用也行：
//   measureAudio(audio)                       量。audio 是解码出来的 { sampleRate, samples: Float32Array[] }（decodeAudio 的结果可以直接给）
//   judgeReference(metrics, thresholds?)      判。metrics 是 measureAudio 的结果
//   checkAudioQuality(env, bytes, options?)   解码（audio-decode.mjs，非 WAV 要环境里的 ffmpeg）、量、判，一步到位
// 另外导出 REFERENCE_THRESHOLDS（阈值）和 kWeightingCoefficients（响度用的 K 计权滤波器的系数）。
//
// ---------------------------------------------------------------- 量出来的数（measureAudio）
//   durationSec     帧数 / 采样率，保留到毫秒
//   sampleRate      Hz
//   channels        声道数
//   peakDbfs        所有声道里绝对值最大的采样，dBFS（满幅 1.0 是 0 dBFS）；全 0 记 −120。保留 0.1 dB
//   clipping        { samples, ratio }：落在平顶里的采样个数，和它占全部采样（所有声道）的比例（保留到 1e-6）。
//                   平顶 = 同一个声道里连续 3 个以上、同一个方向（都正或都负）、绝对值 ≥ 0.999（约 −0.01 dBFS）的采样
//   silenceRatio    静音占比：每 20 毫秒一个窗口（不足一个窗口的零头不算），窗口的电平（各声道功率相加后的有效值 RMS，写在下面 noiseFloorDbfs 那条）比整体响度（下面的 loudnessLufs）低 30 dB 以上就算静音，
//                   静音窗口占全部窗口的比例（保留到 1e-4）；一个完整的窗口都没有（短于 20 毫秒）记 null。
//                   线跟着这一段自己的响度走，不是一个固定的电平：整体加减多少 dB，响度和每个窗口的电平一起加减，数出的窗口不变。
//                   量不出响度（短于 400 毫秒，或者几乎是静音）就没有可比的电平，退回绝对的 −50 dBFS
//   noiseFloorDbfs  底噪估计：同样的窗口里，最安静的 10% 的窗口的电平（窗口电平从小到大排，取 10% 位置上的那一个），dBFS，全 0 记 −120。
//                   它反映停顿里和字词之间的背景有多响；一个完整的窗口都没有记 null。保留 0.1 dB
//                   窗口电平 = 窗口里所有声道的采样平方加起来，除以窗口的采样数，再开方：各声道功率相加，每个声道权重都是 1，和响度同一个基准。
//                   单声道就是它自己的有效值；两个声道一样的录音，窗口电平和底噪都比单声道高 3.01 dB（和响度一样高），所以信噪比、静音占比和单声道一样。
//                   旧的先把声道平均成单声道再量，和响度（相加）不在一个基准上：两个声道一样时信噪比高 3 dB，左右噪声各自独立时高 6 dB，只有一个声道有声时高 6 dB，
//                   反相的两个声道平均成全 0，整段被当成静音。这个 dBFS 在多个声道时是功率相加的电平，不是其中某一个声道的
//   loudnessLufs    整体响度，ITU-R BS.1770-4：K 计权（两级滤波，系数在 48 kHz 时和标准给的表一致，别的采样率按同样的公式算），
//                   400 毫秒的块、每次错开 100 毫秒，绝对门限 −70 LUFS，相对门限比绝对门限之后的平均低 10 LU，各声道的权重都是 1
//                   （一个单声道文件按单声道算，997 Hz 的满幅正弦是 −3.01 LUFS；不认声道布局，多于两个声道时每个声道权重都是 1）。
//                   短于 400 毫秒、或者所有的块都低于绝对门限（几乎是静音）记 null。保留 0.1 LU
//   snrDb           信噪比：loudnessLufs − noiseFloorDbfs，用报告里写的这两个（保留后的）数相减，保留 0.1 dB：说话（整体响度）比背景（最安静的一成窗口）高多少 dB。
//                   整体加减多少 dB，两个数一起加减，差不变。同一段内容放进几个声道（一样的、只有一个声道有声的、左右不同的……），两个数也一起变，差和单声道一样。
//                   响度或者底噪量不出来记 null
// 数值都是 JSON 能表示的（没有 Infinity 和 NaN）。「判」看的是这些保留后的数，所以报告里写的数和结论总是一致的。
//
// ---------------------------------------------------------------- 阈值和依据（REFERENCE_THRESHOLDS）
// 「提醒」（warn）：能用，但最好先处理或者留意。「拒绝」（reject）：不能直接当参考。区间都是闭区间在「好」的一边：5 秒和 20 秒本身没问题。
//
//   量              提醒                           拒绝
//   时长            < 5 秒，或 > 20 秒             < 3 秒，或 > 30 秒
//   采样率          < 16000 Hz                     < 12000 Hz
//   削波比例        ≥ 0.1%                         ≥ 1%
//   静音占比        > 30%                          > 60%
//   整体响度        （高低都不判）                 量不出来（所有的块都低于 −70 LUFS）
//   信噪比          < 12 dB                        < 6 dB
//   底噪（相对的）  信噪比 12 到 20 dB             （不拒绝；不到 12 dB 的已经是上一行，不叠）
//
//   这里的每条线，同一段录音整体加减 20 dB，判出来的原因都不变（削波除外：满幅是数字音频的硬上限，量的是电平本身；量不出响度的 −70 LUFS 也是电平的下限）。
//   同一段内容放进几个声道（一样的、只有一个声道有声的、左右不同的……），判出来的信噪比和静音方面的原因也不变（窗口电平的基准见 noiseFloorDbfs）。
//   绝对的电平线不在此列：量不出响度的 −70 LUFS，和量不出响度时退回的 −50 dBFS 静音线，量的都是功率相加的电平，两个声道一样的录音，每个声道要比单声道轻 3 dB 才碰到它们；
//   这两条只管短于 400 毫秒或者几乎全 0 的录音，它们本来就因为时长或 loudness_inaudible 不能用。
//   带电平的绝对线（原来的底噪、太响、静音和太轻）都已经去掉或换成相对的：底噪换成了信噪比的一档，太响去掉了，静音和太轻见下面各条。
//
//   时长     5–20 秒是对参考集的建议。拒绝线取 3 秒和 30 秒：短于 3 秒装不下一句完整的话，语气和音色都带不出来；
//            长于 30 秒已经远超建议，应当先切成段（做包的流程先切再判）。
//   采样率   录音里最高的频率是采样率的一半：16 kHz 的录音没有 8 kHz 以上的部分。但 16 kHz 是语音常用的采样率：公开语料（LibriSpeech、AISHELL-1）、
//            转写网关、还原度标定用的说话人相似度模型吃的都是 16 kHz；还原度标定里克隆的参考就是这类 16 kHz 的语料录音，克隆出来的声音和留出录音的说话人相似度
//            是真人基线的 0.83（平均，12 次克隆，没有更高采样率的参考做对照）。所以提醒线放在 16000，低于它的提醒；电话音频（8 kHz）和 11.025 kHz 的录音
//            高频缺得更多，克隆出来会闷，拒绝线是 12000。
//            2026-10-15 校准：82 条 16 kHz 的公开语料录音（好的和各种坏的都有）里，旧的提醒线 22050 把它们全部提醒了，一点区分力都没有，所以下调。
//            没有拿低于 16 kHz 的真实录音试过 12000 和 16000 这两条线，也没有量过 16 kHz 的参考比更高采样率的参考克隆得差多少：这两条线靠上面的依据，不是实测。
//   削波     硬削波的特征是平顶：波形被削掉以后，连续几个采样顶在数字上限上。所以量的是「连续 3 个以上顶在上限的采样」，不是「碰到上限的采样」：
//            单个碰到满幅的采样很常见，把峰值调到满幅的健康录音有，持续的元音和正弦波每个周期都有（满幅的正弦有 2.8% 的采样在 0.999 以上，
//            却一点没削波）；平顶要连续好几个。比例上，千分之一提醒，百分之一已经是严重失真。
//            只认顶在数字上限（≥ 0.999）的平顶：削掉以后又整体调低了的录音，平顶不在上限，这里看不出来。
//   静音     自然的朗读，停顿占一到三成；超过三成，能听出音色的部分太少；超过六成基本是空的。整段全 0 是 100%。
//            静音线是「比整体响度低 30 dB」，不是固定的电平。做包把写进包里的参考统一到 −20 LUFS（lib/make-pack-loudness.mjs），在这个响度上，低 30 dB 正好是原来的
//            −50 dBFS（比常见的房间底噪 −60 到 −70 dBFS 高，比说话的有效值 −20 到 −35 dBFS 低得多，能把两者分开），所以 30% 和 60% 沿用；逐窗口对过这个等价。
//            原来的 −50 dBFS 是绝对的：录得轻的好录音，字词之间的停顿和轻的音节整段落到线下，「静音」被数多了（50 条好录音误报 7 条）；
//            改成跟着响度走以后，同一段录音整体加减 20 dB，数出的静音窗口不变。
//            2026-10-17 校准：校准用的那 90 条真实录音（下面叫「存下的 90 条」，只存了每条量出来的数，音频不在手上，重取要联网）里存的是旧定义的静音占比，没有窗口电平，所以新的静音占比不能在那 90 条上重量；
//            用现成的 296 条真实干净录音（AISHELL-1 汉语 168 条、LibriSpeech 英语 128 条，12 位说话人，16 kHz，单句朗读）代替，整体 −20、0、+20 dB 各量一遍：旧的静音线和响度线提醒 275、92、0 条，
//            新的静音线和信噪比线都是 6 条（2.0%，全是 silence_high，没有拒绝，三个增益下是同一批）；同样的录音接上 35%、65% 的数字静音，99 条全抓到，三个增益一样。
//            真实的坏录音没有拿它重验过（缺语料）。
//   响度     高低都不判；量不出响度（所有的块都低于 −70 LUFS）拒绝：几乎听不见，也量不了。广播的语音是 −23 LUFS（EBU R128），播客常见 −16 LUFS；
//            要的响度由做包的流程统一（lib/make-pack-loudness.mjs 在量完、挑好素材以后，把写进包里的参考和留出录音统一到 −20 LUFS，tools/loudness-normalize.mjs），原始录音录得多响不是问题。
//            「太轻」（原来的线：低于 −35 LUFS 提醒，低于 −55 LUFS 拒绝；50 条好录音里 6 条误报，全是录得轻的）后来换成了信噪比：轻而干净的录音，调高响度就行，
//            要看的是调高响度时噪声会不会一起被抬上来，那是下面的信噪比。
//            「太响」（原来的线：高于 −10 LUFS 提醒，理由是这么响的人声几乎一定压得很狠或者削波了）后来去掉了：整体响度是绝对电平，同一段录音整体加 20 dB，
//            296 条干净录音里 216 条被提醒（原样 0 条）。想换成不随增益变的量，看过峰值减响度（PLR，压得很狠的录音 PLR 小）：296 条干净录音（单句朗读）里最小 9.0 dB，
//            低于 10 dB 的 4 条（同一位说话人，LibriSpeech 3853，响度 −10.5 到 −11.2 LUFS），低于 11 dB 的 15 条，低于 13 dB 的 30 条；存下的 90 条里好的 40 条最小 15.0 dB。
//            照「不多出误报的最后一个整数」的办法取，线是 9 dB：干净录音和好录音都是 0 条，可是 24 条噪声、音乐、混响里只抓到 1 条（一条 −6.5 LUFS、峰值 0 dBFS 的音乐），
//            线就压在干净录音的最小值上，一点余量也没有。多于一个声道时响度是各声道功率相加，立体声的 PLR 比同样内容的单声道低（两个声道一样时低 3 dB：
//            同一段合成的语音，单声道 11.1 dB，双声道 8.0 dB，测过）；存下的 8 条立体声录音全是音乐，它们 PLR 低有一部分是这个原因，不是压得更狠。
//            底噪和静音线的窗口电平已经改成了和响度同一个基准（各声道功率相加），没有把峰值也改成相加：峰值量的是离数字满幅还有多远，逐个采样取所有声道里最大的（满幅的立体声文件读 0 dBFS，不是 +3 dBFS），
//            它不是能量，没有「相加」可言；PLR 的这 3 dB 是定义带来的（峰值逐采样取最大，响度是功率相加），工具里没有哪条线用 PLR（太响的线已经去掉），所以没有改。
//            更要紧的是语料里没有一条标了「压得很狠」的录音（削波也一样，找过没找到），这条线抓得到什么、抓不到什么，定不了。
//            没有合理的线，所以不判；真正的削波有 clipping（平顶）管着。要抓「压得很狠」，得先有标好的语料，是以后的事。
//            数字是用存下的 90 条加 296 条干净录音量的。
//   信噪比   响度减底噪，说话比背景高多少 dB。不随整体增益变：轻而干净的录音信噪比高，响而吵的录音信噪比低（原来的响度线正好反过来）。
//            2026-10-17 校准，用存下的 90 条真实录音里已有的响度和底噪（没有重量音频）：好的 40 条加不好断言的 10 条里，信噪比最低的两条是 9.8、10.4 dB
//            （AISHELL，录得轻、底噪相对高），其余在 12.3 dB 以上，好的 40 条的中位数约 28 dB；噪声、音乐、混响三类坏录音共 24 条，11 条低于 12 dB。
//            提醒线 12 dB 是不多出误报的最后一个整数（12 到 13 之间多提醒 2 条好录音，同时多抓 2 条坏录音）：好录音 2/50 被提醒，坏录音 11/24 抓到。
//            拒绝线 6 dB：好录音里最低的 9.8，留了 3.8 dB 的余量；坏录音里只有 1 条（空调，4.2 dB）低于它。对照旧的静音线和响度线：同样 50 条好录音被提醒 11 条。
//   底噪     信噪比在 12 到 20 dB 之间提醒（noise_floor_high；不到 12 dB 的已经是 snr_low、snr_too_low，不再叠一条）。意思是整段都有持续的背景（噪声、房间声，或者背景音乐），背景离说话太近。
//            量的是信噪比，不是底噪的电平（REFERENCE_THRESHOLDS 里这一组叫 noiseFloorSnrDb）；底噪的电平（noiseFloorDbfs）还在 metrics 里：信噪比用它，报告和 quality 命令也写它。
//            这是在最初的五项（时长、削波、静音占比、响度、采样率）之外多加的一项：对参考的要求是「干净、不带伴奏」，前五项量不出这一点。原来的线是绝对电平（最安静的一成窗口高于 −40 dBFS 提醒），
//            后来发现它随整体增益变：同一段录音整体加 20 dB，296 条干净录音里 212 条被提醒（整体 −20 dB 0 条，原样 6 条）；一段吵的录音（信噪比 11 dB 上下）整体 +20 dB 时多一条原因，原样和 −20 dB 时没有。
//            最初量它在好录音上 0/50 误报，那是在没动过电平的录音上量的：同样 50 条好录音整体调到 −20 LUFS 再量，误报变成 12/50（−23 LUFS 是 9/50，见 lib/long-recording.mjs 的注释）。
//            相对的写法就是信噪比：做包把参考统一到 −20 LUFS，在这个响度上，旧线的 −40 dBFS 就是信噪比 20 dB，所以新线放在 20 dB，旧线在做包用的响度上的意思没变。
//            它和 snr_low 量的是同一个量，只是线放得高（snr_low 是 12 dB），所以两条不叠：不到 12 dB 的只报 snr_low。线不是对着标好的语料校准出来的（没有标好「背景太近」的语料），是旧线在 −20 LUFS 上的意思。
//            这条线曾经去掉过一次：20 dB 对干净录音太严（296 条里 36 条、存下的 40 条好录音里 12 条低于 20 dB），当时没有合理的线。2026-10-18 定下补回来，按上面的写法：
//            提醒只影响做包挑参考时的先后（lib/make-pack-pick.mjs 经 lib/pack-material.mjs 把有提醒的排在 ok 的后面，有提醒的段照样用；app 只说「几段音质不合格、没用上」，不显示提醒），
//            所以代价只是信噪比 12 到 20 dB 的段排得靠后一点，而这样的段本来就该排在更干净的后面；去掉它，带音乐、带噪声的段就和干净的段排成一样。
//            量出来的（2026-10-18）：296 条干净录音里 36 条（12.2%）有这条提醒，都没有别的内容方面的原因；整体 −20、0、+20 dB 三个增益下 295 条的原因完全一样，
//            另 1 条（BAC009S0770W0130）信噪比正压在线上：响度和底噪各自保留 0.1 dB，相减以后三个增益下是 20.0、19.9、19.9 dB，−20 dB 那一版因此少一条提醒（舍入，只会发生在离线不到 0.1 dB 的录音上；
//            snr_low 的 12 dB 线在这 296 条上没有这样的）；存下的 40 条好录音里 10 条有这条提醒（另有 2 条是 snr_low）；噪声、音乐、混响 24 条里 9 条
//            （另有 11 条是 snr_low、snr_too_low，4 条在 20 dB 以上）。旧的两条绝对线提醒过的 13 条里，现在信噪比的三条线抓得到 12 条，抓不到的一条是信噪比 23.6 dB 的音乐（响度 −13.2 LUFS，录得响，在线的上面）。
//
// 这些阈值是按常见做法定的，用合成的信号验过算术，响度还和 ffmpeg 的 ebur128 滤镜对过。
// 采样率的提醒线经真实录音校准（2026-10-15，82 条 16 kHz 的公开语料录音），信噪比的两条线经存下的 90 条真实录音校准（2026-10-17），
// 静音线用 296 条真实干净录音查过误报；底噪线（20 dB）没有校准，是旧线在 −20 LUFS 上的意思，提醒的条数在那 90 条和 296 条上量过（上面「底噪」）；多个声道和单声道的一致性用 296 条录音造的多声道版本和 8 条真的双声道录音查过（见「已知的限制」）；其他指标的阈值沿用最初定的数。调整要拿真实录音试；校准用的录音、量数的脚本和记录不在这个目录里，留在这些注释里的是量出来的数。
// 改阈值数值时，改 REFERENCE_THRESHOLDS 和这张表，别的地方不写数。调用方可以只覆盖其中一部分：judgeReference(metrics, { duration: { warnAbove: 30 } })，没写的限值照旧。
//
// ---------------------------------------------------------------- 已知的限制（量出来的，不是推测）
//   混响、多人同时说话：现在没有任何一条量能检出来（2026-10-15 的校准：8 条远讲麦克风的录音里 2 条一条原因都没有，8 条多人同时说话的录音里 EN2002 的 4 条没被提醒）。
//            原来被旧的静音线和响度线抓到的几条（远讲麦克风、会议的混合轨），是因为录得轻，不是检出了混响或者多人；这两条线改成相对的以后，这样的「抓到」多半没有了
//            （新的静音占比在这些录音上没量，只有信噪比线的数）：多人同时说话的 8 条里，旧线抓到 4 条（TS3003 的混合轨，录得轻），信噪比线一条也没抓到（信噪比 23.8–35.1 dB）；
//            混响的 8 条里，旧线抓到 6 条，信噪比线（snr_low）抓到 5 条，再加上底噪线（noise_floor_high）8 条都有提醒（远讲录音的信噪比低，是副作用，不是检出了混响）。要检出它们得有新的量（混响时间、说话人个数），是以后的事。
//   停顿里有明显的背景噪声：离整体响度不到 30 dB 的窗口不算静音，静音占比数少了。同样的录音接上 65% 的 −50 dBFS 房间底噪当停顿，旧线在原来的电平上抓到 99 条里的 99 条，
//            新线 32 条（其中 19 条靠信噪比线）；信噪比在 12–25 dB 之间、停顿全是中等噪声的录音，两条线都管不到。「比底噪高不到 N dB 的窗口算静音」试过，没有采用：
//            它随噪声变，同一批干净录音加上轻的白噪声，静音占比就大幅涨高，把吵的录音也算成停顿多。
//   背景音乐和中等噪声（信噪比 13–24 dB）：和干净录音的信噪比范围重叠（296 条干净录音的信噪比最低 12.9 dB，有 36 条低于 20 dB），现有的量分不开，只能提醒，不能拒绝。
//            存下的 90 条里噪声、音乐、混响共 24 条，整个工具（任一条原因）提醒的：旧的两条绝对线在时 21 条（噪声 6、音乐 8、混响 7），第一次去掉它们时降到 14 条，
//            底噪换成相对的线（noise_floor_high）以后又是 21 条（噪声 6、音乐 7、混响 8）：旧线提醒过的 13 条里现在抓得到 12 条，抓不到的是 1 条信噪比 23.6 dB 的音乐（录得响），
//            同时多抓到 1 条混响（信噪比在 12 到 20 dB 之间，旧线没提醒它）。
//            代价在干净录音一边：信噪比 12 到 20 dB 的好录音也会得到 noise_floor_high（296 条干净录音里 36 条，存下的 40 条好录音里 10 条），做包挑参考时它们排在更干净的后面，照样能用。
//            要把带音乐的和干净的分开，得有新的量（人声和伴奏的分离程度之类），是以后的事。
//            这里的「任一条原因」里，静音占比是存下的旧定义（新定义的静音占比在这 90 条上没量过，音频不在手上），所以这几个数是个大概。
//   压得很狠的录音：没有线管它（「太响」线去掉了，理由和数字见上面「响度」）；真正的削波有 clipping。
//   信噪比拿最安静的一成窗口当背景：没有停顿的连续音（持续的音乐，一口气不停的话）这一成窗口也不安静，信噪比偏低，会被提醒；没有停顿的录音本来就不适合当参考，不算误报。
//   多个声道：窗口电平和响度都是各声道功率相加，所以同一段内容放进几个声道，信噪比、静音占比和单声道一样。量过的：
//            296 条干净的单声道录音，各造成「两个声道一样、三个声道一样、只有左声道有声、右声道轻 6 dB、右声道是左声道的反相」五种多声道版本，信噪比和单声道的差最大 0.1 dB（响度和底噪各自保留 0.1 dB 相减的舍入），
//            静音占比一条不差，静音和信噪比方面的原因一条不差；旧的（先平均成单声道再量窗口电平）信噪比平均高 3.0、4.8、6.0、3.5 dB，原因不一样 34、49、55、38 条，反相的 296 条全成了 silence_dominant。
//            手上真有的 8 条两个声道一样的真实录音（单声道语料复制成两个声道）：新的和各自的单声道逐条一样；旧的信噪比都高 3 dB，其中 1 条的 noise_floor_high 被吃掉。
//            没量过的：真实的、左右声道内容不同的立体声录音。手上没有；存下的 90 条里 8 条立体声（全是音乐）的音频不在手上（重取要联网），它们存下的信噪比是旧量法量的、没有重量。
//            旧量法对任何立体声内容都偏高，至少高 10·log10(声道数) dB（立体声 3.01 dB）：平均以后的功率不会超过各声道功率之和除以声道数（m² ≤ Σx²/n），每个窗口的电平都不低于旧的加这么多，
//            所以这 8 条的真实信噪比至少比存下的低 3.01 dB，上面「底噪」「背景音乐」两条里音乐被信噪比线抓到的条数是下限（不会更少，可能更多）。
//            左右不同的情形只用合成的信号验过（两路不同的说话，左右噪声各自独立）。
//
// ---------------------------------------------------------------- 结论（judgeReference）
//   { verdict: 'ok' | 'warn' | 'reject', usable: boolean, reasons: [{ code, severity: 'warn' | 'reject', message, value, limit }] }
//   verdict   有一条拒绝就是 'reject'，只有提醒是 'warn'，什么都没有是 'ok'。usable = verdict !== 'reject'。
//   reasons   按检查的顺序（时长、采样率、削波、静音、响度、信噪比、底噪）；value 是量出来的数，limit 是越过的那条线；message 是给人看的中文，说明原因和怎么办。
//   code      duration_too_short  duration_short  duration_long  duration_too_long
//             sample_rate_too_low  sample_rate_low
//             clipping_severe  clipping
//             silence_dominant  silence_high
//             loudness_inaudible  loudness_unmeasured
//             snr_too_low  snr_low  noise_floor_high
//             noise_floor_high 沿用原来的名字，以前的报告里就是这个 code，意思没变（背景离说话太近），只是触发条件从底噪的电平改成了信噪比（value 是信噪比，limit 是 20）。
//             loudness_high 去掉了（绝对电平的线，随整体增益变）。这个 code 在这个目录里只出现在这个文件里：
//             词表、适配器、协议文档、做包报告的格式、用到这个工具的应用都没有按它取文字或分支，所以去掉不破坏对外的约定。noise_floor_high 同样没有谁按它取文字或分支。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { decodeAudio } from './audio-decode.mjs';

const FLOOR_DB = -120; // 全 0 的电平：不用 -Infinity，JSON 表示不了
const CLIP_LEVEL = 0.999;
const CLIP_RUN = 3;
export const WINDOW_SECONDS = 0.02;
const SILENCE_BELOW_LOUDNESS_DB = 30; // 比整体响度低这么多 dB 的窗口算静音
const SILENCE_FALLBACK_DBFS = -50; // 量不出响度（没有可比的电平）时才用的绝对静音线
const NOISE_PERCENTILE = 0.1;
const LOUDNESS_BLOCK_SECONDS = 0.4;
const LOUDNESS_HOP_SECONDS = 0.1;
const LOUDNESS_ABSOLUTE_GATE = -70;
const LOUDNESS_RELATIVE_GATE = -10;

const deepFreeze = (value) => {
  for (const inner of Object.values(value)) if (inner && typeof inner === 'object') deepFreeze(inner);
  return Object.freeze(value);
};

/**
 * 阈值的默认值，依据见文件头。分组的名字就是 judgeReference 覆盖时用的名字。
 * 没有响度这一组：太响的线是绝对电平，随整体增益变，去掉了（量还在 metrics 里）。
 * noiseFloorSnrDb 是底噪的线，量的是信噪比（和 snrDb 同一个量，线放得更高：不到 snrDb.warnBelow 的已经是 snr_low、snr_too_low，这一条管它和这条线之间的），不是底噪的电平：
 * 原来的底噪线是绝对电平（−40 dBFS），随整体增益变，换成了这条相对的。
 */
export const REFERENCE_THRESHOLDS = deepFreeze({
  duration: { rejectBelow: 3, warnBelow: 5, warnAbove: 20, rejectAbove: 30 },
  sampleRate: { rejectBelow: 12000, warnBelow: 16000 },
  clippingRatio: { warnAtOrAbove: 0.001, rejectAtOrAbove: 0.01 },
  silenceRatio: { warnAbove: 0.3, rejectAbove: 0.6 },
  snrDb: { rejectBelow: 6, warnBelow: 12 },
  noiseFloorSnrDb: { warnBelow: 20 },
});

const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
const toDb = (amplitude) => (amplitude > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(amplitude)) : FLOOR_DB);

export function checkedAudio(audio) {
  const ok =
    audio !== null && typeof audio === 'object' &&
    Number.isInteger(audio.sampleRate) && audio.sampleRate > 0 &&
    Array.isArray(audio.samples) && audio.samples.length > 0 &&
    audio.samples.every((s) => s !== null && typeof s === 'object' && typeof s.length === 'number' && s.length === audio.samples[0].length);
  if (!ok) throw new TypeError('audio 必须是 { sampleRate: 正整数, samples: 至少一个声道的数组，每个声道一样长 }');
  return audio;
}

// ---------------------------------------------------------------- 响度（ITU-R BS.1770-4）

// K 计权：第 1 级是高频搁架（+4 dB 左右），第 2 级是 RLB 高通（约 38 Hz）。参数是标准给的模拟原型，
// 按双线性变换算出任意采样率的系数；48 kHz 时和标准的表 1、表 2 一致（逐项核对过，差在 1e-9 以内）。
/**
 * K 计权两级滤波器的系数，写法同标准的表：b = [b0, b1, b2]，a = [1, a1, a2]。
 * @param {number} sampleRate Hz
 * @returns {[{ b: number[], a: number[] }, { b: number[], a: number[] }]} [高频搁架, RLB 高通]
 */
export function kWeightingCoefficients(sampleRate) {
  const k1 = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const q1 = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const d1 = 1 + k1 / q1 + k1 * k1;
  const shelf = {
    b: [(vh + (vb * k1) / q1 + k1 * k1) / d1, (2 * (k1 * k1 - vh)) / d1, (vh - (vb * k1) / q1 + k1 * k1) / d1],
    a: [1, (2 * (k1 * k1 - 1)) / d1, (1 - k1 / q1 + k1 * k1) / d1],
  };
  const k2 = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const q2 = 0.5003270373238773;
  const d2 = 1 + k2 / q2 + k2 * k2;
  const highpass = { b: [1, -2, 1], a: [1, (2 * (k2 * k2 - 1)) / d2, (1 - k2 / q2 + k2 * k2) / d2] };
  return [shelf, highpass];
}

const powerToLufs = (power) => -0.691 + 10 * Math.log10(power);

// 滤波器的状态（两级的输出）绝对值小于它就置 0（flush to zero）。次正规数是 2.2e-308 以下的浮点数，CPU 上算得慢好几倍；
// 数字静音之后两级的状态按指数衰减，会一路落进去（改之前，几秒的声音接几十秒的 0，有 1,216,881 个采样的滤波输出是次正规数）。
// 1e-30 比 2.2e-308 大 10 的 277 次方以上：状态不小于 1e-30 时，乘上 K 计权的系数（整数采样率下非零的绝对值都在 2.8e-5 以上，1000 到 200000 Hz 逐个量过），
// 还是正规数，所以算出来的项和它们的和也不会是次正规数。被清零的状态绝对值都在 1e-30 以下，它造成的能量差远小于
// 超过 −70 LUFS 门限的块的功率（约 1e-7）的一个 ULP（约 1e-23），所以量出来的值不变。
// 没有数字 0 的语音，状态从来到不了 1e-30，清零一次也不发生，算出来的值逐位一样（改前改后逐位比过）。
const FLUSH_BELOW = 1e-30;

/**
 * K 计权的一个声道：两级递推（高频搁架、RLB 高通），逐个采样喂进去。step 返回这个采样的输出（第 2 级）；
 * 第 1 级的输出留在 y1 里（数次正规数两级都要看）。integratedLoudness 用的就是这份递推。
 */
export class KWeighting {
  constructor(sampleRate) {
    const [shelf, highpass] = kWeightingCoefficients(sampleRate);
    this.sb0 = shelf.b[0]; this.sb1 = shelf.b[1]; this.sb2 = shelf.b[2];
    this.sa1 = shelf.a[1]; this.sa2 = shelf.a[2];
    this.hb0 = highpass.b[0]; this.hb1 = highpass.b[1]; this.hb2 = highpass.b[2];
    this.ha1 = highpass.a[1]; this.ha2 = highpass.a[2];
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; // 第 1 级的状态：输入和输出的历史
    this.u1 = 0; this.u2 = 0; this.w1 = 0; this.w2 = 0; // 第 2 级的状态：输入（第 1 级的输出）和输出的历史
  }

  step(x) {
    let y = this.sb0 * x + this.sb1 * this.x1 + this.sb2 * this.x2 - this.sa1 * this.y1 - this.sa2 * this.y2;
    if (Math.abs(y) < FLUSH_BELOW) y = 0;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    let w = this.hb0 * y + this.hb1 * this.u1 + this.hb2 * this.u2 - this.ha1 * this.w1 - this.ha2 * this.w2;
    if (Math.abs(w) < FLUSH_BELOW) w = 0;
    this.u2 = this.u1; this.u1 = y; this.w2 = this.w1; this.w1 = w;
    return w;
  }
}

// 整体响度，LUFS；短于一个块、或者所有的块都低于绝对门限，返回 null。不取整：tools/loudness-normalize.mjs 要用精确值
export function integratedLoudness(samples, rate) {
  const hop = Math.max(1, Math.round(rate * LOUDNESS_HOP_SECONDS));
  const perBlock = Math.max(1, Math.round(LOUDNESS_BLOCK_SECONDS / LOUDNESS_HOP_SECONDS));
  const frames = samples[0].length;
  const segments = Math.floor(frames / hop);
  if (segments < perBlock) return null;
  const energy = new Float64Array(segments); // 每 100 毫秒一段：所有声道经过 K 计权以后的平方和
  for (const channel of samples) {
    const kw = new KWeighting(rate);
    for (let s = 0; s < segments; s++) {
      let sum = 0;
      for (let i = s * hop, end = i + hop; i < end; i++) {
        const w = kw.step(channel[i]);
        sum += w * w;
      }
      energy[s] += sum;
    }
  }
  const blocks = segments - perBlock + 1;
  const power = new Float64Array(blocks); // 每个块的平均功率（各声道权重都是 1）
  for (let j = 0; j < blocks; j++) {
    let sum = 0;
    for (let k = 0; k < perBlock; k++) sum += energy[j + k];
    power[j] = sum / (perBlock * hop);
  }
  const mean = (keep) => {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < blocks; j++) if (keep(j)) { sum += power[j]; n++; }
    return n === 0 ? null : sum / n;
  };
  const afterAbsolute = mean((j) => power[j] > 0 && powerToLufs(power[j]) > LOUDNESS_ABSOLUTE_GATE);
  if (afterAbsolute === null) return null;
  const relativeGate = powerToLufs(afterAbsolute) + LOUDNESS_RELATIVE_GATE;
  const afterRelative = mean((j) => power[j] > 0 && powerToLufs(power[j]) > LOUDNESS_ABSOLUTE_GATE && powerToLufs(power[j]) > relativeGate);
  return afterRelative === null ? null : powerToLufs(afterRelative);
}

// ---------------------------------------------------------------- 量

// 每 20 毫秒一个窗口的电平（dBFS）：窗口里所有声道的采样平方加起来，除以窗口的采样数，再开方。定义和理由见文件头 noiseFloorDbfs 那条。
// 导出给 silence-split.mjs 用：它找静音用的是同一把尺，不另写一份
export function windowLevels(samples, rate) {
  const size = Math.max(1, Math.round(rate * WINDOW_SECONDS));
  const count = Math.floor(samples[0].length / size);
  const levels = new Float64Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    for (const channel of samples) {
      for (let i = w * size, end = i + size; i < end; i++) sum += channel[i] * channel[i];
    }
    levels[w] = toDb(Math.sqrt(sum / size));
  }
  return levels;
}

// 平顶里的采样个数：每个声道各自找，连续 CLIP_RUN 个以上、同一个方向、绝对值 ≥ CLIP_LEVEL 的一段算一个平顶
function clippedSamples(samples, frames) {
  let clipped = 0;
  for (const channel of samples) {
    let run = 0;
    let direction = 0;
    for (let i = 0; i < frames; i++) {
      const v = channel[i];
      const d = v >= CLIP_LEVEL ? 1 : v <= -CLIP_LEVEL ? -1 : 0;
      if (d !== 0 && d === direction) run++;
      else {
        if (run >= CLIP_RUN) clipped += run;
        run = d !== 0 ? 1 : 0;
        direction = d;
      }
    }
    if (run >= CLIP_RUN) clipped += run;
  }
  return clipped;
}

/**
 * 量一段音频。每一项的定义见文件头。
 * @param {{ sampleRate: number, samples: ArrayLike<number>[] }} audio decodeAudio 的结果可以直接给
 * @returns {{ durationSec: number, sampleRate: number, channels: number, peakDbfs: number, clipping: { samples: number, ratio: number }, silenceRatio: number|null, noiseFloorDbfs: number|null, loudnessLufs: number|null, snrDb: number|null }}
 * @throws {TypeError} audio 的形状不对
 */
export function measureAudio(audio) {
  const { sampleRate, samples } = checkedAudio(audio);
  const channels = samples.length;
  const frames = samples[0].length;
  let peak = 0;
  for (const channel of samples) {
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }
  }
  const clipped = clippedSamples(samples, frames);
  const levels = windowLevels(samples, sampleRate);
  const loudness = integratedLoudness(samples, sampleRate);
  const loudnessLufs = loudness === null ? null : round(Math.max(FLOOR_DB, loudness), 1);
  let silenceRatio = null;
  let noiseFloorDbfs = null;
  if (levels.length > 0) {
    // 静音线跟着这一段自己的响度走（比它低 30 dB），不是一个固定的电平：整体加减多少 dB，响度和每个窗口的电平一起加减，数出的窗口不变。
    // 用没取整的响度，免得取整的 0.05 dB 在线附近翻转窗口。量不出响度（短于 400 毫秒，或者几乎是静音）就没有可比的电平，退回绝对线
    const silenceLine = loudness === null ? SILENCE_FALLBACK_DBFS : loudness - SILENCE_BELOW_LOUDNESS_DB;
    let silent = 0;
    for (const level of levels) if (level < silenceLine) silent++;
    silenceRatio = round(silent / levels.length, 4);
    const sorted = Float64Array.from(levels).sort();
    noiseFloorDbfs = round(sorted[Math.floor((sorted.length - 1) * NOISE_PERCENTILE)], 1);
  }
  return {
    durationSec: round(frames / sampleRate, 3),
    sampleRate,
    channels,
    peakDbfs: round(toDb(peak), 1),
    clipping: { samples: clipped, ratio: round(clipped / (frames * channels || 1), 6) },
    silenceRatio,
    noiseFloorDbfs,
    loudnessLufs,
    // 信噪比：报告里响度和底噪这两个数相减，所以报告里的数和结论总是一致的
    snrDb: loudnessLufs === null || noiseFloorDbfs === null ? null : round(loudnessLufs - noiseFloorDbfs, 1),
  };
}

// ---------------------------------------------------------------- 判

function mergedThresholds(overrides) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('thresholds 必须是对象，例如 { duration: { warnAbove: 30 } }');
  const merged = {};
  for (const group of Object.keys(overrides)) {
    if (!(group in REFERENCE_THRESHOLDS)) throw new TypeError(`thresholds 里没有 ${group} 这一组（有：${Object.keys(REFERENCE_THRESHOLDS).join('、')}）`);
    for (const limit of Object.keys(overrides[group] ?? {})) {
      if (!(limit in REFERENCE_THRESHOLDS[group])) throw new TypeError(`thresholds.${group} 里没有 ${limit} 这条线（有：${Object.keys(REFERENCE_THRESHOLDS[group]).join('、')}）`);
    }
  }
  for (const group of Object.keys(REFERENCE_THRESHOLDS)) merged[group] = { ...REFERENCE_THRESHOLDS[group], ...(overrides[group] ?? {}) };
  return merged;
}

const pct = (ratio) => `${round(ratio * 100, 2)}%`;

function judge(metrics, t) {
  const need = ['durationSec', 'sampleRate', 'clipping', 'silenceRatio', 'noiseFloorDbfs', 'loudnessLufs', 'snrDb'];
  if (metrics === null || typeof metrics !== 'object' || need.some((k) => !(k in metrics)) || metrics.clipping === null || typeof metrics.clipping !== 'object') {
    throw new TypeError(`metrics 必须是 measureAudio 的结果（要有 ${need.join('、')}）`);
  }
  const reasons = [];
  const add = (code, severity, message, value, limit) => reasons.push({ code, severity, message, value, limit });
  const { durationSec: dur, sampleRate: rate, silenceRatio: silence, loudnessLufs: loud, snrDb: snr } = metrics;
  const clip = metrics.clipping.ratio;

  const d = t.duration;
  if (dur < d.rejectBelow) add('duration_too_short', 'reject', `时长 ${dur} 秒，短于 ${d.rejectBelow} 秒：装不下一句完整的话，语气和音色都带不出来，不能当参考`, dur, d.rejectBelow);
  else if (dur < d.warnBelow) add('duration_short', 'warn', `时长 ${dur} 秒，短于建议的 ${d.warnBelow} 秒：能用，但内容少，最好换一段更长的`, dur, d.warnBelow);
  if (dur > d.rejectAbove) add('duration_too_long', 'reject', `时长 ${dur} 秒，长于 ${d.rejectAbove} 秒：先切成 ${d.warnBelow}–${d.warnAbove} 秒的段再用`, dur, d.rejectAbove);
  else if (dur > d.warnAbove) add('duration_long', 'warn', `时长 ${dur} 秒，长于建议的 ${d.warnAbove} 秒：最好切短`, dur, d.warnAbove);

  const s = t.sampleRate;
  if (rate < s.rejectBelow) add('sample_rate_too_low', 'reject', `采样率 ${rate} Hz，低于 ${s.rejectBelow} Hz：高频缺得太多（电话音质），克隆出来会发闷，不能当参考`, rate, s.rejectBelow);
  else if (rate < s.warnBelow) add('sample_rate_low', 'warn', `采样率 ${rate} Hz，低于 ${s.warnBelow} Hz：${rate / 2} Hz 以上的高频没有，音色会暗一些；有更高采样率的原声就用原声`, rate, s.warnBelow);

  const c = t.clippingRatio;
  if (clip >= c.rejectAtOrAbove) add('clipping_severe', 'reject', `削波严重：${pct(clip)} 的采样在平顶上（${metrics.clipping.samples} 个顶在满幅），声音已经失真，不能当参考`, clip, c.rejectAtOrAbove);
  else if (clip >= c.warnAtOrAbove) add('clipping', 'warn', `有削波：${pct(clip)} 的采样在平顶上（${metrics.clipping.samples} 个顶在满幅），会带进失真；能重录就重录，或者换一段`, clip, c.warnAtOrAbove);

  const q = t.silenceRatio;
  if (silence !== null) {
    if (silence > q.rejectAbove) add('silence_dominant', 'reject', `静音占 ${pct(silence)}，超过 ${pct(q.rejectAbove)}：基本是空的，能听出音色的部分太少，不能当参考`, silence, q.rejectAbove);
    else if (silence > q.warnAbove) add('silence_high', 'warn', `静音占 ${pct(silence)}，超过 ${pct(q.warnAbove)}：停顿太多，有效的说话时间短；最好裁掉长停顿`, silence, q.warnAbove);
  }

  // 响度只剩「量不出来」这一条：高低不判（太轻换成了信噪比，太响没有不随增益变的合理的线），见文件头
  if (loud === null) {
    if (dur >= LOUDNESS_BLOCK_SECONDS) add('loudness_inaudible', 'reject', `整段都低于 ${LOUDNESS_ABSOLUTE_GATE} LUFS：几乎听不见，不能当参考`, null, LOUDNESS_ABSOLUTE_GATE);
    else add('loudness_unmeasured', 'warn', `短于 ${LOUDNESS_BLOCK_SECONDS} 秒，量不出响度`, null, LOUDNESS_BLOCK_SECONDS);
  }

  const r = t.snrDb;
  const n = t.noiseFloorSnrDb;
  if (snr !== null) {
    if (snr < r.rejectBelow) add('snr_too_low', 'reject', `信噪比 ${snr} dB（响度减底噪），低于 ${r.rejectBelow} dB：说话几乎被背景盖住，不能当参考`, snr, r.rejectBelow);
    else if (snr < r.warnBelow) add('snr_low', 'warn', `信噪比 ${snr} dB（响度减底噪），低于 ${r.warnBelow} dB：背景噪声偏大（噪声、房间声或背景音乐）；能重录就换个安静的地方重录，或者换一段`, snr, r.warnBelow);
    // 底噪偏高：信噪比不到 snr_low 的线的，上面已经说了，这里管 snr_low 的线和这条线之间的；量的是信噪比，随整体增益不变，见文件头「底噪」
    else if (snr < n.warnBelow) add('noise_floor_high', 'warn', `信噪比 ${snr} dB（响度减底噪），低于 ${n.warnBelow} dB：背景离说话太近，整段都有持续的背景声（噪声、房间声或背景音乐）；这个量分不清噪声和伴奏，要听一下`, snr, n.warnBelow);
  }

  const verdict = reasons.some((r) => r.severity === 'reject') ? 'reject' : reasons.length > 0 ? 'warn' : 'ok';
  return { verdict, usable: verdict !== 'reject', reasons };
}

/**
 * 按阈值给出结论。
 * @param {ReturnType<typeof measureAudio>} metrics measureAudio 的结果
 * @param {{ [group: string]: { [limit: string]: number } }} [thresholds] 要覆盖的阈值，没写的用 REFERENCE_THRESHOLDS
 * @returns {{ verdict: 'ok'|'warn'|'reject', usable: boolean, reasons: { code: string, severity: 'warn'|'reject', message: string, value: number|null, limit: number|null }[] }}
 * @throws {TypeError} metrics 缺字段，或 thresholds 写了不存在的组和线（写错名字不会悄悄不起作用）
 */
export function judgeReference(metrics, thresholds = {}) {
  return judge(metrics, mergedThresholds(thresholds));
}

/**
 * 解码、量、判，一步到位。
 * @param {object|undefined} env 注入的运行环境；音频是自己能解的 WAV 时可以不给，其他格式要 env.runtimes.ffmpeg（见 audio-decode.mjs）
 * @param {Uint8Array} bytes 音频文件的字节
 * @param {{ thresholds?: object }} [options] thresholds：要覆盖的阈值，写法同 judgeReference；写错名字在解码之前就报，不白解码
 * @returns {Promise<{ decoder: 'wav'|'ffmpeg', metrics: ReturnType<typeof measureAudio>, verdict: string, usable: boolean, reasons: object[] }>}
 * @throws 解码的错（audio_decode_failed、wav_invalid、runtime_missing……）原样抛出，见 audio-decode.mjs
 */
export async function checkAudioQuality(env, bytes, { thresholds = {} } = {}) {
  const merged = mergedThresholds(thresholds);
  const audio = await decodeAudio(env, bytes);
  const metrics = measureAudio(audio);
  return { decoder: audio.decoder, metrics, ...judge(metrics, merged) };
}
