import fs from 'node:fs/promises';

// 只由 base 的 workflow 调用；PR 的文字不拼进脚本或 shell。
const repo = process.env.GITHUB_REPOSITORY, number = process.env.PR_NUMBER;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(number ?? '')) throw Error('repo/PR 编号不对');
const base = `https://api.github.com/repos/${repo}`;
async function api(p, options = {}) {
  const r = await fetch(`${base}${p}`, { ...options, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' } });
  if (!r.ok) throw Error(`评论接口 HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
let body;
try { body = await fs.readFile('../verify-report.md', 'utf8'); }
catch { body = '<!-- melb-verify -->\n# melb verification\n\n工作流未完成，无法核对；不会自动合并。请看 Action 日志。'; }
if (body.length > 55_000) body = body.slice(0, 54_500) + '\n\n（评论太长已截短；完整报告见 Action artifact。）';
let existing;
for (let page = 1; !existing; page++) {
  const comments = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
  if (!Array.isArray(comments)) throw Error('评论接口没返回数组');
  existing = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith('<!-- melb-verify -->'));
  if (comments.length < 100) break;
}
await api(existing ? `/issues/comments/${existing.id}` : `/issues/${number}/comments`, { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
