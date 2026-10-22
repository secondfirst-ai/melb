import { createHash } from 'node:crypto';
import { MODEL, validateVerdict } from './model.mjs';

// 提示词/判定口径或缓存结构变化时递增；调价格不改变已有语义结论。
export const CACHE_VERSION = 1;
export const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const recordHash = r => sha256(JSON.stringify(canonical(r)));
export const emptyCache = pr => ({ version: CACHE_VERSION, model: MODEL, pr: String(pr), entries: {} });

export function readVerdict(cache, record) {
  if (cache.version !== CACHE_VERSION || cache.model !== MODEL) return null;
  const item = cache.entries?.[recordHash(record)];
  if (!item) return null;
  // 缓存来自有写评论权限的 job；仍重新校验逐句覆盖，不能把一张只有 pass 的表当证据。
  const verdict = validateVerdict(JSON.stringify(item.verdict), record), issues = [];
  for (const [i, s] of verdict.sentences.entries()) if (s.verdict !== 'yes') issues.push({ text: `句 ${i + 1} [${s.verdict}] ${s.text} — ${s.why}` });
  if (verdict.translation.verdict !== 'yes') issues.push({ text: `中文一致性 [${verdict.translation.verdict}] ${verdict.translation.why}` });
  return { status: issues.length ? 'fail' : 'pass', issues, verdict, cached: true };
}
