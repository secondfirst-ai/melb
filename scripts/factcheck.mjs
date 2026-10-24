import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Sources, normalize, excerpt, safeError, usable } from './source.mjs';
import { OfficeReader, wait } from './office-cdp.mjs';

class UsageError extends Error {}
const USAGE = '用法：node scripts/factcheck.mjs in.json|- [--cdp] [--caller 名字]';

export function inputs(value) {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || typeof row.url !== 'string' || typeof row.quote !== 'string' || !row.quote.trim())) throw new UsageError('输入要是非空url/quote对象的数组');
  for (const row of value) {
    let url;
    try { url = new URL(row.url); } catch { throw new UsageError('输入含无效URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\x00-\x20\x7f]/.test(row.url)) throw new UsageError('URL须为无凭据的http/https地址');
  }
  return value;
}

export async function factcheck(value, { cdp = false, caller = 'factcheck', env = process.env, signal, sources = new Sources({ withVia: true }), officeFactory = options => new OfficeReader(options) } = {}) {
  const rows = inputs(value);
  if (cdp && env.GITHUB_ACTIONS) throw new UsageError('GITHUB_ACTIONS 中拒绝 --cdp，只能本地使用');
  const groups = new Map(), pages = new Map();
  for (const row of rows) { const url = new URL(row.url).href; groups.set(url, [...(groups.get(url) ?? []), row.quote]); }
  let office;
  try {
    for (const [url, quotes] of groups) {
      signal?.throwIfAborted();
      let page;
      try { page = await wait(sources.read(url, quotes), 120_000, signal); }
      catch (error) { if (signal?.aborted) throw signal.reason; page = { texts: [], documents: [], errors: [safeError(error)] }; }
      const documents = [...(page.documents ?? page.texts.map(text => ({ text, via: 'curl' })))];
      let via = 'headless';
      if (!documents.length && cdp) {
        via = 'cdp';
        office ??= officeFactory({ caller, signal });
        try { documents.push({ text: usable(await wait(office.read(url), 120_000, signal)), via }); }
        catch (error) { if (signal?.aborted) throw signal.reason; page.errors.push('CDP：' + safeError(error)); }
      }
      pages.set(url, { documents, via, errors: page.errors });
    }
    return rows.map(row => {
      const page = pages.get(new URL(row.url).href), needle = normalize(row.quote);
      const document = page.documents.find(document => document.text.includes(needle)) ?? page.documents.at(-1);
      if (!document) return { url: row.url, quote: row.quote, status: 'unreachable', via: page.via, excerpt: '', error: page.errors.join('；') || '无法取得正文' };
      return { url: row.url, quote: row.quote, status: document.text.includes(needle) ? 'found' : 'not_found', via: document.via, excerpt: excerpt(document.text, row.quote) };
    });
  } finally {
    try { await office?.close(); } finally { await sources.close(); }
  }
}

function options(args, env) {
  let file, cdp = false, caller = 'factcheck';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cdp') cdp = true;
    else if (arg === '--caller' && args[i + 1] && !args[i + 1].startsWith('--')) caller = args[++i];
    else if (!file && (arg === '-' || !arg.startsWith('-'))) file = arg;
    else throw new UsageError(USAGE);
  }
  if (!file || !caller.trim() || /[\x00-\x20\x7f]/.test(caller) || caller.length > 80) throw new UsageError(USAGE);
  if (cdp && env.GITHUB_ACTIONS) throw new UsageError('GITHUB_ACTIONS 中拒绝 --cdp，只能本地使用');
  return { file, cdp, caller };
}

export async function main(args = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, ...dependencies } = {}) {
  const controller = new AbortController();
  const interrupted = () => { controller.abort(Error('factcheck 已中断')); stdin.destroy?.(); };
  process.once('SIGINT', interrupted);
  try {
    const config = options(args, env);
    let text;
    try {
      if (config.file === '-') { text = await wait((async () => { const chunks = []; for await (const chunk of stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); })(), 120_000, controller.signal); }
      else text = await fs.readFile(config.file, 'utf8');
    } catch { throw new UsageError('无法读取输入JSON文件或stdin'); }
    let value;
    try { value = inputs(JSON.parse(text)); } catch (error) { throw new UsageError(error instanceof UsageError ? error.message : '输入不是有效JSON'); }
    const results = await factcheck(value, { ...config, ...dependencies, env, signal: controller.signal });
    stdout.write(JSON.stringify(results, null, 2) + '\n');
    for (const row of results) stderr.write(`${row.status}\t${row.via}\t${row.url}\n`);
    return results.every(row => row.status === 'found') ? 0 : 1;
  } catch (error) {
    stderr.write((controller.signal.aborted ? 'factcheck 已中断' : safeError(error)) + '\n');
    return controller.signal.aborted ? 130 : error instanceof UsageError ? 2 : 1;
  } finally { process.removeListener('SIGINT', interrupted); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
