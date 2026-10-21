// SPDX-License-Identifier: Apache-2.0
//
// 评测集：量还原度用的一批数据（真人录音，和用这个包合成出来的录音）存成文件的样子。写和读都在这一个模块里：
// make-pack 命令用 --save-evaluation 把评测集写出来（evaluationSetFiles），fidelity 命令读它（readEvaluationSet）。
// 文件的样子只在这里写一份，两个命令都问这里，不各写各的（命令之间不互相引用，见 cli/input.mjs 的文件头）。
// Node 专有（node:fs），所以放在命令行层：库的接口上不出现路径，交进去的是字节加 MIME 类型（lib/fidelity.mjs）。
//
// 一个评测集目录里：
//   evaluation.json       评测集本身（下面）
//   audio/                它指到的音频文件
//   fidelity-report.json  做包时量出来的还原度报告（lib/fidelity.mjs 的 measureFidelity 的结果）：补做没听成的（fidelity --redo）用它
//
// evaluation.json（路径相对于这个 JSON 所在的目录；音频一律是文件路径，后缀认出是什么音频）：
//   {
//     "references": [ { "id": "ref-1", "audio": "audio/ref-1.wav", "text": "可省略", "labels": { "emotion": "calm" } } ],
//     "holdouts":   [ { "id": "h-1", "audio": "audio/h-1.wav", "text": "这条里说的话", "labels": { "emotion": "calm" },
//                       "generated": "audio/gen-h-1.mp3",   // 用这个包把 text 合成出来的录音；不给就用 voice-cloning 合成一条
//                       "reference": "ref-1" } ]            // 合成时用哪段参考；省略用第一段
//   }
//   id 在参考和留出录音之间不能重名（读进来以后由 lib/fidelity.mjs 核对）；留出录音的 text 必须有（收音校验要拿它核对模型的转写）。
//   读出来每一条是 { id, audio, text?, labels?, reference?, generated? }：audio 和 generated 是 { bytes, mimeType }。
//
// 抛出的错误（VoicePackError；code 小写下划线）：
//   evaluation_set_unreadable  评测集或音频文件读不了（不存在、没有权限）。details.file（音频文件还有 details.field）
//   evaluation_set_invalid     评测集不是约定的形状：不是 JSON、字段不对、音频后缀认不出、reference 指向的 id 不存在。details.field
//                              （fidelity 命令补做时，上一次报告里没听成的留出录音不在评测集里，也是这个 code，details.field 是 holdouts：invalidEvaluationSet）
//   redo_report_unreadable     --redo 给的报告文件读不了。details.file
//   redo_report_invalid        --redo 给的报告文件不是 JSON。details.file。（是 JSON 但不是报告的形状，由库报 fidelity_input_invalid，details.field 从 previous 起写）
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { AUDIO_EXTENSIONS, extensionOfMime, mimeOfFileName } from './audio-files.mjs';
import { isPlainObject } from './input.mjs';

export const EVALUATION_FILE = 'evaluation.json';
export const FIDELITY_REPORT_FILE = 'fidelity-report.json';

/** evaluation_set_invalid 这个错。读的时候用，fidelity 命令里别的和评测集有关的问题（补做要的留出录音不在评测集里……）也用它，code 和 details 的写法就一样。 */
export const invalidEvaluationSet = (field, message) => new VoicePackError('evaluation_set_invalid', message, { details: { field } });
const invalid = invalidEvaluationSet;

// ---------------------------------------------------------------- 读

/** 读一个音频文件：后缀认类型，读成字节。同一个文件在一次运行里只读一次（读出来的是同一个对象）。 */
function audioReader() {
  const cache = new Map();
  return (file, field) => {
    if (cache.has(file)) return cache.get(file);
    const mimeType = mimeOfFileName(file);
    if (mimeType === undefined) throw invalidEvaluationSet(field, `${field} 的后缀 .${path.extname(file).slice(1).toLowerCase()} 认不出是什么音频（能用的：${AUDIO_EXTENSIONS.join('、')}）：${file}`);
    let clip;
    try {
      clip = { bytes: new Uint8Array(fs.readFileSync(file)), mimeType };
    } catch (cause) {
      throw new VoicePackError('evaluation_set_unreadable', `读不了音频文件（${field}）：${file}`, { details: { file, field }, cause });
    }
    cache.set(file, clip);
    return clip;
  };
}

/**
 * 读一份评测集，把音频读成字节。
 * @param {string} file evaluation.json 的路径（音频的路径相对于它所在的目录）
 * @returns {{ references: object[], holdouts: object[] }} 每条是 { id, audio, text?, labels?, reference?, generated? }
 * @throws {VoicePackError} evaluation_set_unreadable、evaluation_set_invalid
 */
export function readEvaluationSet(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new VoicePackError('evaluation_set_unreadable', `读不了评测集：${file}`, { details: { file }, cause });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('evaluation_set_invalid', `评测集不是合法的 JSON：${file}（${cause.message}）`, { details: { field: 'file' }, cause });
  }
  if (!isPlainObject(data)) throw invalid('file', '评测集必须是一个 JSON 对象：{ references: […], holdouts: […] }');
  const root = path.dirname(file);
  const readAudio = audioReader();
  const pathField = (raw, name, where) => {
    if (typeof raw[name] !== 'string' || raw[name] === '') throw invalid(`${where}.${name}`, `${where}.${name} 必须是音频文件的路径`);
    return readAudio(path.resolve(root, raw[name]), `${where}.${name}`);
  };
  const readList = (list, field) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw invalid(field, `${field} 必须是数组`);
    return list.map((raw, index) => {
      const where = `${field}[${index}]`;
      if (!isPlainObject(raw)) throw invalid(where, `${where} 必须是一个对象`);
      if (typeof raw.id !== 'string' || raw.id === '') throw invalid(`${where}.id`, `${where}.id 必须是非空字符串`);
      const track = { id: raw.id, audio: pathField(raw, 'audio', where), labels: raw.labels };
      if (raw.text !== undefined) {
        if (typeof raw.text !== 'string') throw invalid(`${where}.text`, `${where}.text 必须是字符串（这段音频里说的话）`);
        track.text = raw.text;
      }
      if (field === 'holdouts') {
        if (track.text === undefined) throw invalid(`${where}.text`, `${where}.text 必须有：收音校验要拿它核对模型的转写`);
        if (raw.reference !== undefined) {
          if (typeof raw.reference !== 'string' || raw.reference === '') throw invalid(`${where}.reference`, `${where}.reference 必须是参考集里的 id`);
          track.reference = raw.reference;
        }
        if (raw.generated !== undefined) track.generated = pathField(raw, 'generated', where);
      }
      return track;
    });
  };
  const references = readList(data.references, 'references');
  const holdouts = readList(data.holdouts, 'holdouts');
  const referenceIds = new Set(references.map((track) => track.id));
  for (const [index, track] of holdouts.entries()) {
    if (track.reference !== undefined && !referenceIds.has(track.reference)) {
      throw invalid(`holdouts[${index}].reference`, `holdouts[${index}].reference 指向的 id「${track.reference}」不在参考集里`);
    }
  }
  return { references, holdouts };
}

/**
 * 读上一次的还原度报告（fidelity --redo 给的 JSON 文件：evaluationSetFiles 写的 fidelity-report.json，或 fidelity 的 --json 输出、--save-report 存的文件）。
 * 是不是 measureFidelity 出的报告的形状，由库核对（lib/fidelity.mjs 的 planRedo、redoNotHeard）。
 * @throws {VoicePackError} redo_report_unreadable、redo_report_invalid
 */
export function readPreviousReport(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new VoicePackError('redo_report_unreadable', `读不了 --redo 给的上一次的报告：${file}`, { details: { file }, cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('redo_report_invalid', `--redo 给的上一次的报告不是合法的 JSON：${file}（${cause.message}）。要的是 --json 的输出，或者 --save-report 存的文件`, { details: { file }, cause });
  }
}

// ---------------------------------------------------------------- 写

/**
 * 把做包量还原度用的那批数据写成评测集目录里的文件（读回来用 readEvaluationSet），再加上还原度报告。
 * @param {{ evaluation: { references: object[], holdouts: object[] }, report: { trial: { items: { id: string, pick: { segmentId: string } }[] }, fidelity: object } }} result
 *   makePack 的返回（lib/make-pack.mjs 文件头）：evaluation 是量还原度用的那批数据（每条的音频是 { bytes, mimeType }，留出录音带合成出来的 generated），
 *   report.trial.items 里每条留出录音合成时挑的参考段，report.fidelity 是还原度报告
 * @returns {Map<string, Uint8Array>} 目录里的相对路径 → 字节（交给 protocol/cli/disk.mjs 的 writeDirectory）
 */
export function evaluationSetFiles(result) {
  const files = new Map();
  const put = (name, clip) => {
    const file = `audio/${name}.${extensionOfMime(clip.mimeType)}`;
    files.set(file, clip.bytes);
    return file;
  };
  const picks = new Map(result.report.trial.items.map((item) => [item.id, item.pick.segmentId]));
  const references = result.evaluation.references.map((entry) => ({ id: entry.id, audio: put(`reference-${entry.id}`, entry.audio), text: entry.text, labels: entry.labels }));
  const holdouts = result.evaluation.holdouts.map((entry) => ({ id: entry.id, audio: put(`holdout-${entry.id}`, entry.audio), text: entry.text, labels: entry.labels, generated: put(`generated-${entry.id}`, entry.generated), reference: picks.get(entry.id) }));
  const json = (value) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  files.set(EVALUATION_FILE, json({ references, holdouts }));
  files.set(FIDELITY_REPORT_FILE, json(result.report.fidelity));
  return files;
}
