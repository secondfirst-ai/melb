import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gitData, inspect, readDirectory, selectChanged } from './format.mjs';
import { normalize, normalizeCase, publicURL } from './source.mjs';
import { sha256, recordHash } from './verdict-cache.mjs';
import { OfficeReader } from './office-cdp.mjs';

export const EVIDENCE_PATH = 'office-evidence.json';
const domains = JSON.parse(await fs.readFile(new URL('./office-evidence-domains.json', import.meta.url), 'utf8'));
const MAX_AGE = 30 * 24 * 60 * 60 * 1000, MAX_BYTES = 10 * 1024 * 1024;
export function permitted(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d)); } catch { return false; }
}
export function validEntry(entry, source, record, now = Date.now()) {
  if (!record || entry?.recordId !== record.id || entry?.recordHash !== recordHash(record)) return false;
  if (!entry || entry.url !== source.url || !permitted(entry.url) || entry.quote !== normalizeCase(source.quote) || !entry.quote || typeof entry.text !== 'string' || entry.text.length > 12000 || !entry.text.includes(entry.quote)) return false;
  if (!/^[a-f0-9]{64}$/.test(entry.pageSha256 ?? '') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.fetchedAt ?? '')) return false;
  const timestamp = Date.parse(entry.fetchedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === entry.fetchedAt && timestamp <= now && now - timestamp <= MAX_AGE;
}

// GitHub 的验证结果绑定签名提交、Git 对象及账户，不能信任提交自填的姓名或邮箱。
export async function trustedEvidence({ cwd, head, repository, trustedPR, request = fetch }) {
  if (!trustedPR || !/^[a-f0-9]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return null;
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BYTES + 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const tree = git('ls-tree', head, '--', EVIDENCE_PATH);
    if (!/^100644 blob [a-f0-9]{40}\toffice-evidence\.json$/.test(tree)) return null;
    const blob = tree.split(/\s+/)[2], commit = git('log', '-1', '--format=%H', head, '--', EVIDENCE_PATH);
    if (!/^[a-f0-9]{40}$/.test(commit) || git('rev-parse', `${commit}:${EVIDENCE_PATH}`) !== blob) return null;
    const response = await request(`https://api.github.com/repos/${repository}/commits/${commit}`, { headers: { 'user-agent': 'melb-office-evidence', accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.sha !== commit || data.commit?.verification?.verified !== true || data.author?.login !== '2nd1st' || data.committer?.login !== '2nd1st') return null;
    const raw = git('show', `${head}:${EVIDENCE_PATH}`);
    if (Buffer.byteLength(raw) > MAX_BYTES) return null;
    const evidence = JSON.parse(raw);
    return evidence.version === 1 && Array.isArray(evidence.entries) && evidence.entries.length <= 5000 ? evidence.entries : null;
  } catch { return null; }
}

export async function authenticatedChange(plan, getEvidence) {
  return !plan.files.includes(EVIDENCE_PATH) || Boolean(plan.trusted && await getEvidence());
}

export async function applyOfficeEvidence(pages, record, getEvidence, now = Date.now()) {
  const quotes = new Map();
  for (const s of record.sources) quotes.set(s.url, [...(quotes.get(s.url) ?? []), s.quote]);
  let entries;
  for (const [url, requested] of quotes) {
    const page = pages.get(url);
    const texts = page?.texts ?? [];
    if (!permitted(url) || requested.every(quote => texts.some(text => text.includes(normalize(quote)))) || (texts.length && !page.browserFailed)) continue;
    entries ??= await getEvidence() ?? [];
    const matches = requested.map(quote => entries.find(e => validEntry(e, { url, quote }, record, now)));
    // 同一 URL 的每句都要有证据，防止部分摘录造成错误的缺句判定。
    if (matches.every(Boolean)) pages.set(url, { texts: matches.map(e => normalize(e.text)), errors: [], browserFailed: false, office: true });
  }
}

export async function createEntries(chosen, reader, now = () => new Date(), urls = null) {
  const entries = [], failures = [], seen = new Set(), pages = new Map(), matched = new Set();
  for (const { record } of chosen) for (const source of record.sources) {
    if (!permitted(source.url) || (urls && !urls.has(source.url))) continue;
    matched.add(source.url);
    const quote = normalizeCase(source.quote), key = JSON.stringify([record.id, recordHash(record), source.url, quote]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pages.has(source.url)) {
      try { pages.set(source.url, { text: await reader.read(source.url) }); }
      catch (error) { pages.set(source.url, { error: String(error.message).split('\n')[0].slice(0, 200) }); }
    }
    const page = pages.get(source.url);
    if (page.error || typeof page.text !== 'string' || !page.text.includes(quote)) {
      failures.push({ id: record.id, url: source.url, reason: page.error || '办公室页面缺 quote' });
      continue;
    }
    const at = page.text.indexOf(quote);
    entries.push({ recordId: record.id, recordHash: recordHash(record), url: source.url, quote, text: page.text.slice(Math.max(0, at - 2500), at + quote.length + 2500), fetchedAt: now().toISOString(), pageSha256: sha256(page.text) });
  }
  if (urls) for (const url of urls) if (!matched.has(url)) failures.push({ id: '无匹配题目', url, reason: 'URL 不在变更题的来源中' });
  return { entries, failures };
}

export function mergeSelectedEntries(previous, entries, urls) {
  if (!urls) return entries;
  if (previous && (previous.version !== 1 || !Array.isArray(previous.entries) || previous.entries.length > 5000)) throw Error('现有证据文件格式不对');
  return [...(previous?.entries ?? []).filter(e => e && !urls.has(e.url)), ...entries];
}

export function repositoryFromOrigin(cwd) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
    return match?.[1] ?? null;
  } catch { return null; }
}

export async function main(args, { cwd = process.cwd(), request = fetch, makeReader = () => new OfficeReader({ caller: 'office-evidence', preserveCase: true, checkURL: url => { if (!permitted(url)) throw Error('办公室来源请求域名不在白名单'); return publicURL(url); } }), commit = () => {
  execFileSync('git', ['add', '--', EVIDENCE_PATH], { cwd, stdio: 'inherit' });
  execFileSync('git', ['commit', '-S', '--only', '-m', 'Add signed office evidence', '--', EVIDENCE_PATH], { cwd, stdio: 'inherit' });
} } = {}) {
  const usage = '本地用法：node scripts/office-evidence.mjs --base <main-ref> [--repository <owner/repo>] [--url <官方来源URL> ...]';
  if (process.env.GITHUB_ACTIONS || args.length < 2 || args[0] !== '--base' || !args[1] || args[1].startsWith('-') || (args.length - 2) % 2) throw Error(usage);
  const selected = [], repositories = [];
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] === '--url' && permitted(args[i + 1])) selected.push(args[i + 1]);
    else if (args[i] === '--repository' && /^[\w.-]+\/[\w.-]+$/.test(args[i + 1] ?? '')) repositories.push(args[i + 1]);
    else throw Error(usage);
  }
  if (repositories.length > 1) throw Error(usage);
  const urls = selected.length ? new Set(selected) : null;
  const base = gitData(args[1], cwd), data = await readDirectory(path.join(cwd, 'data'));
  const info = inspect(data, JSON.parse(await fs.readFile(new URL('./allowlist.json', import.meta.url), 'utf8')));
  if (info.errors.length) throw Error('数据格式错误：' + info.errors.join('；'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('status', '--porcelain', '--', EVIDENCE_PATH)) throw Error('证据文件已有未提交改动，请先处理');
  const evidencePath = path.join(cwd, EVIDENCE_PATH);
  const stat = await fs.lstat(evidencePath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat && !stat.isFile()) throw Error('证据路径不是普通文件');
  let previous = null;
  if (urls && stat) {
    const repository = repositories[0] ?? repositoryFromOrigin(cwd);
    const entries = await trustedEvidence({ cwd, head: git('rev-parse', 'HEAD'), repository, trustedPR: true, request });
    if (!entries) throw Error('旧证据未通过 GitHub 签名认证：去掉 --url 全量重采，或先处理旧文件；如 origin 不是 GitHub 地址，请用 --repository <owner/repo>');
    previous = { version: 1, entries };
  }
  const reader = makeReader();
  let entries, failures;
  try { ({ entries, failures } = await createEntries(selectChanged(info.records, base), reader, () => new Date(), urls)); } finally { await reader.close(); }
  if (!entries.length && !failures.length) throw Error('没有匹配的白名单来源');
  entries = mergeSelectedEntries(previous, entries, urls);
  if (entries.length > 5000) throw Error('证据超过 5000 条');
  const bytes = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('证据超过 10 MiB');
  await fs.writeFile(evidencePath, bytes, { flag: stat ? 'w' : 'wx' });
  if (failures.length) {
    for (const f of failures) console.error(`未采集 ${f.id} ${f.url}：${f.reason}`);
    console.error(`已保存 ${entries.length} 条部分结果，${failures.length} 条失败；未暂存、未签名，退出 1。请处理后重跑或选定需补证据的 URL。`);
    process.exitCode = 1; return;
  }
  await commit();
  console.log('已签名提交办公室证据；请检查提交并自行推送 PR 分支。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); } catch (e) { console.error(String(e.message).split('\n')[0]); process.exitCode = 1; }
}
