import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// 只由 base 的 workflow 调用；PR 的文字不拼进脚本或 shell。
export async function api(p, options = {}) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('repo 不对');
  const r = await fetch(`https://api.github.com/repos/${repo}${p}`, { ...options, signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' } });
  if (!r.ok) throw Object.assign(Error(`GitHub 接口 HTTP ${r.status}`), { status: r.status });
  return r.status === 204 ? null : r.json();
}
export async function findComment(number = process.env.PR_NUMBER) {
  if (!/^\d+$/.test(String(number ?? ''))) throw Error('PR 编号不对');
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw Error('评论接口没返回数组');
    existing = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith('<!-- melb-verify -->'));
    if (comments.length < 100) break;
  }
  return existing;
}
export function cachePointer(body) {
  const match = body?.match(/<!-- melb-cache (\{[^\n]*\}) -->/);
  return match ? JSON.parse(match[1]) : null;
}
export async function comment(body, number = process.env.PR_NUMBER, pointer) {
  const existing = await findComment(number);
  if (pointer === undefined) pointer = cachePointer(existing?.body);
  body = body.replace(/<!-- melb-cache [^\n]* -->/g, '').replace(/@(?!\u200b)/g, '@\u200b');
  if (body.length > 54_000) body = body.slice(0, 53_500) + '\n\n（评论太长已截短；完整报告见 Action artifact。）';
  if (pointer) body += `\n<!-- melb-cache ${JSON.stringify(pointer)} -->`;
  await api(existing ? `/issues/comments/${existing.id}` : `/issues/${number}/comments`, { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let body;
  try { body = await fs.readFile('../verify-report.md', 'utf8'); }
  catch { body = '<!-- melb-verify -->\n# melb verification\n\n工作流未完成，无法核对；不会自动合并。请看 Action 日志。'; }
  await comment(body);
}
