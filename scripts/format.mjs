import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

export const LEGACY = new Set(['about.json', 'ai_help.json', 'ai_rules.json', 'events.json', 'holidays.json']);
export const SIMILARITY_THRESHOLD = 0.65;
export const DATA_FILE = /^[a-z0-9][a-z0-9_-]*\.json$/;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 3000;
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bilingual = (x) => object(x) && text(x.en) && text(x.zh);
export function date(x) {
  return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
}

export async function readDirectory(dir) {
  const files = new Map();
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.json')) continue;
    if (!DATA_FILE.test(entry.name) || !entry.isFile()) throw Error(`不接受的 data 文件：${entry.name}`);
    const p = path.join(dir, entry.name), stat = await fs.lstat(p);
    if (stat.size > MAX_FILE_BYTES) throw Error(`data/${entry.name} 超过 5 MiB`);
    files.set(entry.name, await fs.readFile(p, 'utf8'));
  }
  return files;
}

export function gitData(ref, cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error('base ref 没解析成 commit');
  const tree = git('ls-tree', '-rz', sha, '--', 'data').split('\0').filter(Boolean), files = new Map();
  for (const line of tree) {
    const [meta, filename] = line.split('\t');
    if (!/^data\/[^/]+\.json$/.test(filename)) continue;
    if (!DATA_FILE.test(filename.slice(5)) || !meta.startsWith('100644 blob ')) throw Error('base 的 data 文件格式不对');
    const raw = git('show', `${sha}:${filename}`);
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw Error('base data 文件过大');
    files.set(filename.slice(5), raw);
  }
  return files;
}

export function inspect(files, allowlist) {
  const errors = [], warnings = [], records = [], ids = new Map();
  let legacyFiles = 0, legacyRecords = 0;
  if (!files.size) errors.push('data/ 没有 JSON 文件');
  for (const [file, raw] of files) {
    let doc;
    try { doc = JSON.parse(raw); } catch { errors.push(`${file}：JSON 不能解析`); continue; }
    const legacy = LEGACY.has(file);
    if (legacy) legacyFiles++;
    if (!legacy) {
      if (!object(doc) || !text(doc.dataset) || !bilingual(doc.title) || !date(doc.updated) || !Array.isArray(doc.notes) || !doc.notes.every(bilingual) || !Array.isArray(doc.records)) {
        errors.push(`${file}：必填 dataset/title.en/title.zh/updated/notes/records 缺失或格式不对`);
        continue;
      }
    }
    const rows = Array.isArray(doc?.records) ? doc.records : [];
    if (legacy) legacyRecords += rows.length;
    for (const r of rows) {
      const id = object(r) ? r.id : null, where = `${file} / ${text(id) ? id : '(没有 id)'}`;
      if (text(id)) {
        if (ids.has(id)) errors.push(`${where}：id 和 ${ids.get(id)} 重复`);
        else ids.set(id, file);
      } else if (!legacy) errors.push(`${where}：缺 id`);
      if (legacy) continue;
      records.push({ file, record: r });
      if (!object(r)) { errors.push(`${where}：record 必须是对象`); continue; }
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id ?? '')) errors.push(`${where}：id 只用小写字母、数字和连字符`);
      for (const field of ['question', 'answer']) if (!bilingual(r[field])) errors.push(`${where}：缺 ${field}.en 或 ${field}.zh`);
      for (const field of ['aliases', 'tags']) if (!Array.isArray(r[field]) || !r[field].length || !r[field].every(text)) errors.push(`${where}：${field} 必须是非空文字数组`);
      if (!date(r.checked)) errors.push(`${where}：checked 必须是真实的 YYYY-MM-DD 日期`);
      if ('valid_until' in r && !date(r.valid_until)) errors.push(`${where}：valid_until 必须是真实的 YYYY-MM-DD 日期`);
      if ('note' in r && !bilingual(r.note)) errors.push(`${where}：note 必须有 en 和 zh`);
      if (JSON.stringify(r).length > 40_000 || (r.answer?.en?.length ?? 0) > 6000 || (r.answer?.zh?.length ?? 0) > 6000) errors.push(`${where}：单题过长（record 40,000 / 答案各 6,000 字符以内）`);
      if (!Array.isArray(r.sources) || !r.sources.length || r.sources.length > 12) { errors.push(`${where}：sources 必须有 1–12 个出处`); continue; }
      for (const [i, s] of r.sources.entries()) {
        let u;
        try { u = new URL(s?.url); } catch { /* 下面统一记格式错误。 */ }
        if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) errors.push(`${where}：source ${i + 1} 要用无凭据、无自定义端口的 https URL`);
        else if (!(u.hostname.endsWith('.gov.au') || allowlist.some((d) => u.hostname === d || u.hostname.endsWith('.' + d)))) warnings.push(`${where}：source ${i + 1} 域名 ${u.hostname} 不在白名单（不拦）`);
        if (!text(s?.quote) || s.quote.length > 6000) errors.push(`${where}：source ${i + 1} 缺原句 quote，或超过 6,000 字符`);
      }
    }
  }
  if (records.length > MAX_RECORDS) errors.push(`问答超过 ${MAX_RECORDS} 条，需人工调整上限`);
  return { errors, warnings, records, legacyFiles, legacyRecords };
}

export function selectChanged(records, baseFiles) {
  if (!baseFiles) return records;
  const old = new Map();
  for (const [file, raw] of baseFiles) {
    if (LEGACY.has(file)) continue;
    const doc = JSON.parse(raw);
    for (const r of doc.records ?? []) old.set(r.id, r);
  }
  return records.filter(({ record }) => !isDeepStrictEqual(old.get(record?.id), record));
}

export function similar(records, selected) {
  const tokenize = (s) => new Set([...new Intl.Segmenter('en', { granularity: 'word' }).segment(s.toLowerCase())].filter((x) => x.isWordLike && !/^(a|an|the|is|are|do|does|i|in|to|of|for|and|can|how|what)$/.test(x.segment)).map((x) => x.segment));
  const tokens = records.map(({ record: r }) => ({ id: r.id, words: tokenize(`${r.question.en} ${r.question.zh}`) }));
  const chosen = new Set(selected.map(({ record: r }) => r.id)), warnings = [];
  for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) {
    const a = tokens[i], b = tokens[j];
    if (!chosen.has(a.id) && !chosen.has(b.id)) continue;
    const intersection = [...a.words].filter((w) => b.words.has(w)).length;
    const score = intersection / (a.words.size + b.words.size - intersection);
    if (intersection >= 2 && score >= SIMILARITY_THRESHOLD) warnings.push(`近似问题：${a.id} / ${b.id}，词集合重合 ${score.toFixed(2)} ≥ ${SIMILARITY_THRESHOLD}（不拦）`);
  }
  return warnings;
}
