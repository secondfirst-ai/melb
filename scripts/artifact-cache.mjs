import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findComment, cachePointer } from './comment-pr.mjs';
import { emptyCache, sha256, CACHE_VERSION } from './verdict-cache.mjs';
import { MODEL } from './model.mjs';

const LIMIT = 64 * 1024 * 1024;
export async function boundedJSON(filename, limit = LIMIT) {
  if ((await fs.stat(filename)).size > limit) throw Error('JSON artifact 过大');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
export function validateCache(bytes, pointer, number) {
  if (sha256(bytes) !== pointer.sha256) throw Error('语义缓存 artifact 的 hash 与 bot 评论不符；不重复付费');
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.version !== CACHE_VERSION || data.model !== MODEL || data.pr !== String(number) || !data.entries || Array.isArray(data.entries) || typeof data.entries !== 'object') throw Error('语义缓存版本/模型/PR 不符，需要人工确认后重核');
  if (Object.keys(data.entries).some(k => !/^[a-f0-9]{64}$/.test(k))) throw Error('语义缓存 record hash 无效');
  return data;
}
async function responseBytes(response) {
  if (!response.ok) throw Error(`缓存下载 HTTP ${response.status}，未调用 Claude`);
  const chunks = []; let n = 0;
  for await (const b of response.body) { n += b.length; if (n > LIMIT) throw Error('缓存 ZIP 超过 64 MiB'); chunks.push(b); }
  return Buffer.concat(chunks);
}
export async function loadCache(number, { find = findComment, fetchImpl = fetch } = {}) {
  const existing = await find(number), pointer = cachePointer(existing?.body);
  if (!pointer) return emptyCache(number);
  if (pointer.blocked) throw Error('上轮有已付费核对，但缓存未保存；请恢复缓存，不会自动重复付费');
  if (!/^\d+$/.test(String(pointer.artifact)) || !/^[a-f0-9]{64}$/.test(pointer.sha256 ?? '')) throw Error('bot 评论中的缓存指针无效');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('repo 无效');
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/artifacts/${pointer.artifact}/zip`, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
  let zip;
  if (response.status === 302) {
    const location = new URL(response.headers.get('location'));
    if (location.protocol !== 'https:' || location.username || location.password) throw Error('缓存下载重定向不是 HTTPS');
    await response.body?.cancel();
    // GitHub 给存储服务的签名 URL；绝不把 GitHub Authorization 交给重定向主机。
    zip = await responseBytes(await fetchImpl(location.href, { signal: AbortSignal.timeout(30_000) }));
  } else zip = await responseBytes(response);
  await fs.mkdir('.cache', { recursive: true }); const dir = await fs.mkdtemp(path.resolve('.cache/cache-download-'));
  try {
    const filename = path.join(dir, 'cache.zip'); await fs.writeFile(filename, zip);
    // 只读固定名称的 JSON 到 stdout，不把 ZIP 的任何路径解包到磁盘，更不执行 artifact 内容。
    const bytes = execFileSync('unzip', ['-p', filename, 'semantic-cache.json'], { timeout: 15_000, maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
    return validateCache(bytes, pointer, number);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
