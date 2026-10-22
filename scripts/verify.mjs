import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, readDirectory, gitData, selectChanged, similar, LEGACY } from './format.mjs';
import { Sources, literal } from './source.mjs';
import { Claude, MODEL, INPUT_USD_PER_M, OUTPUT_USD_PER_M } from './model.mjs';
import { emptyCache, recordHash, readVerdict } from './verdict-cache.mjs';

export async function mapLimit(items, fn, limit = 4) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}|]/g, '\\$&').replace(/\r?\n/g, ' ').replace(/@/g, '@\u200b');  // 不让 PR 里的 @某人 在机器人评论里真的去 @ 人
const labels = { pass: '过', fail: '不过', unable: '无法核对' };
export function report(result) {
  const lines = ['<!-- melb-verify -->', '# melb verification', '', `范围：${result.scope}。模式：${result.literalOnly ? '只做格式和字面；没有跑逐句核对，不能自动合并' : '格式 + 字面 + Claude 逐句核对'}。`, '', `格式：${result.errors.length ? '不过' : '过'}。旧数据集 ${result.legacyFiles} 个 / ${result.legacyRecords} 条仅检查 JSON 和 id；问答共 ${result.total} 条，本次核 ${result.results.length} 条。`];
  if (result.errors.length) lines.push('', '## 格式错误', ...result.errors.map((e) => `- ${escape(e)}`));
  lines.push('', '| 题目 id | 字面 | 逐句 | 结果 |', '|---|---|---|---|');
  for (const r of result.results) lines.push(`| ${escape(r.id)} | ${labels[r.literal]} | ${r.semantic === 'skipped' ? '未跑' : labels[r.semantic]}${r.cached ? '（缓存）' : ''} | ${labels[r.status]}${result.literalOnly && r.status === 'pass' ? '（仅字面）' : ''} |`);
  for (const r of result.results.filter((r) => r.issues.length)) {
    lines.push('', `## ${escape(r.id)} — ${labels[r.status]}`, ...r.issues.map((i) => `- ${escape(i.text)}`));
    if (r.status === 'fail') lines.push(...r.quotes.map((s, i) => `- quote ${i + 1}：${escape(s.quote)} — ${escape(s.url)}`));
  }
  if (result.warnings.length) lines.push('', '## 提醒（不拦）', ...result.warnings.map((w) => `- ${escape(w)}`));
  const u = result.usage;
  lines.push('', `Claude ${MODEL}：${u.requests} 次请求，缓存命中 ${result.cacheHits ?? 0} 题，input ${u.input} / output ${u.output} tokens，估算 US$${u.estimatedUSD.toFixed(6)}（每百万 input US$${INPUT_USD_PER_M} / output US$${OUTPUT_USD_PER_M}；不是账单；包括可取得用量的坏 JSON 重试）。`, '');
  return lines.join('\n');
}

export async function collectLiteral(options = {}, dependencies = {}) {
  const root = options.root ?? process.cwd(), dataDir = path.resolve(root, options.dataDir ?? 'data');
  const allowlist = JSON.parse(await fs.readFile(new URL('./allowlist.json', import.meta.url), 'utf8'));
  if (!Array.isArray(allowlist) || !allowlist.every(d => typeof d === 'string' && /^[a-z0-9.-]+$/.test(d))) throw Error('allowlist.json 格式不对');
  const files = await readDirectory(dataDir), info = inspect(files, allowlist);
  const base = options.baseDir ? await readDirectory(path.resolve(root, options.baseDir)) : options.base ? gitData(options.base, root) : null;
  const chosen = info.errors.length ? [] : selectChanged(info.records, base);
  const result = { version: 1, scope: base ? '只核 base 以来新增或修改的 record（按 id）' : '全部问答', literalOnly: true, errors: info.errors, warnings: info.warnings, legacyFiles: info.legacyFiles, legacyRecords: info.legacyRecords, total: info.records.length, results: [], items: [], usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 } };
  if (!info.errors.length) {
    result.warnings.push(...similar(info.records, chosen));
    const sources = dependencies.sources ?? new Sources();
    try {
      const quotes = new Map();
      for (const { record } of chosen) for (const s of record.sources) quotes.set(s.url, [...(quotes.get(s.url) ?? []), s.quote]);
      const pages = new Map(await mapLimit([...quotes], async ([url, q]) => [url, await sources.read(url, q)]));
      result.items = chosen.map(({ file, record }) => ({ file, record, hash: recordHash(record), ...literal(record, pages) }));
    } finally { await sources.close(); }
    result.results = result.items.map(i => ({ file: i.file, id: i.record.id, literal: i.status, semantic: 'skipped', status: i.status, issues: i.issues, quotes: i.record.sources }));
  }
  result.exitCode = result.errors.length || result.results.some(r => r.status !== 'pass') ? 1 : 0;
  return result;
}

// 此阶段不构造 Sources，不抓页面、不启动浏览器；CI 在另一个有 key 的 job 里调用。
export async function judge(evidence, { model = new Claude(), cache = emptyCache('local'), saveCache = async () => {} } = {}) {
  const result = { ...evidence, literalOnly: false, usage: model.usage, cacheHits: 0 };
  if (evidence.exitCode) return result;
  let saves = Promise.resolve();
  result.results = await mapLimit(evidence.items, async item => {
    const { record } = item;
    let checked = readVerdict(cache, record);
    if (checked) result.cacheHits++;
    else {
      checked = await model.check(record, item.excerpts);
      if (checked.verdict) {
        cache.entries[item.hash] = { verdict: checked.verdict };
        const bytes = JSON.stringify(cache);
        saves = saves.then(() => saveCache(bytes));
        await saves;
      }
    }
    return { file: item.file, id: record.id, literal: item.status, semantic: checked.status, status: checked.status, issues: checked.issues, quotes: record.sources, cached: Boolean(checked.cached) };
  });
  result.exitCode = result.errors.length || result.results.some(r => r.status !== 'pass') ? 1 : 0;
  return result;
}

export async function verify(options = {}, dependencies = {}) {
  const evidence = await collectLiteral(options, dependencies);
  return options.literalOnly || evidence.exitCode ? evidence : judge(evidence, dependencies);
}

export async function main(args = process.argv.slice(2)) {
  const options = {}; let out = path.resolve('verify-report.md'), all = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--all') all = true;
      else if (a === '--literal-only') options.literalOnly = true;
      else if (['--base', '--base-dir', '--data-dir', '--report'].includes(a) && args[i + 1] && !args[i + 1].startsWith('--')) {
        const value = args[++i];
        if (a === '--report') out = path.resolve(value);
        else options[{ '--base': 'base', '--base-dir': 'baseDir', '--data-dir': 'dataDir' }[a]] = value;
      } else throw Error('用法：node scripts/verify [--all | --base REF | --base-dir DIR] [--data-dir DIR] [--literal-only] [--report FILE]');
    }
    if ([all, Boolean(options.base), Boolean(options.baseDir)].filter(Boolean).length > 1) throw Error('--all/--base/--base-dir 只能选一个');
    const r = await verify(options), md = report(r);
    await fs.writeFile(out, md);
    console.log(`格式：${r.errors.length ? '不过' : '过'}；旧数据 ${r.legacyFiles} 个 / ${r.legacyRecords} 条；问答 ${r.total} 条，本次核 ${r.results.length} 条。`);
    for (const e of r.errors) console.log(`不过：${e}`);
    for (const row of r.results) console.log(`${labels[row.status]} ${row.id}（字面 ${labels[row.literal]} / 逐句 ${row.semantic === 'skipped' ? '未跑' : labels[row.semantic]}）${row.issues.length ? '：' + row.issues.map((i) => i.text).join('；') : ''}`);
    console.log(`提醒 ${r.warnings.length} 条；估算 US$${r.usage.estimatedUSD.toFixed(6)}；报告 ${out}`);
    return r.exitCode;
  } catch (error) {
    const message = String(error.message).split('\n')[0].slice(0, 500);
    await fs.writeFile(out, `<!-- melb-verify -->\n# melb verification\n\n脚本出错：${escape(message)}\n\n估算花费未能完成；不会自动合并。\n`);
    console.error(`脚本出错：${message}`);
    return 2;
  }
}
