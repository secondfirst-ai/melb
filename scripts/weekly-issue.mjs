import fs from 'node:fs/promises';
import { readDirectory } from './format.mjs';

export const TITLE = 'Weekly source check';
const labels = { fail: '不过', unable: '无法核对' };
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}|]/g, '\\$&').replace(/\r?\n/g, ' ').replace(/@/g, '@\u200b');

// 只接受 verify --all --literal-only 当前完整的 Markdown 格式；缺行、异常或退出状态不符都不能算全过。
export function parseReport(text, outcome) {
  const incomplete = reason => ({ failed: true, problems: [], errors: [`检查本身没跑完：${reason}`] });
  if (typeof text !== 'string' || !text.trim()) return incomplete('没有报告');
  if (/^脚本出错：/m.test(text)) return incomplete('verify 脚本出错，详情见本次 run');
  const summary = text.match(/^格式：(过|不过)。旧数据集 \d+ 个 \/ \d+ 条仅检查 JSON 和 id；问答共 (\d+) 条，本次核 (\d+) 条。$/m);
  const table = text.match(/^\| 题目 id \| 字面 \| 逐句 \| 结果 \|\n\|---\|---\|---\|---\|\n((?:\|[^\n]*\|\n)*)/m);
  if (!text.startsWith('<!-- melb-verify -->\n# melb verification\n') ||
      !text.includes('范围：全部问答。模式：只做格式和字面；没有跑逐句核对，不能自动合并。') ||
      !/^Claude [^\n]+：0 次请求，缓存命中 0 题，input 0 \/ output 0 tokens，估算 US\$0\.000000[^\n]*。\n?$/.test(text.split('\n\n').at(-1)) || !summary || !table) return incomplete('报告不完整或格式不符');
  const rows = table[1].trim() ? table[1].trim().split('\n') : [];
  const problems = [], ids = new Set();
  for (const row of rows) {
    const match = row.match(/^\| ([a-z0-9][a-z0-9-]{0,127}) \| (过|不过|无法核对) \| 未跑 \| (过（仅字面）|不过|无法核对) \|$/);
    if (!match || ids.has(match[1]) || match[2] !== match[3].replace('（仅字面）', '')) return incomplete('题目表格不完整或结论不符');
    const [, id, status] = match; ids.add(id);
    if (status === '过') continue;
    const heading = `## ${id} — ${status}\n`, start = text.indexOf(heading);
    if (start < 0) return incomplete(`缺少 ${id} 的原因`);
    const section = text.slice(start + heading.length).split('\n## ')[0];
    const reasons = section.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
    if (!reasons.length) return incomplete(`缺少 ${id} 的原因`);
    problems.push({ id, status: status === '不过' ? 'fail' : 'unable', reasons });
  }
  const errors = summary[1] === '不过' ? (text.match(/^## 格式错误\n([\s\S]*?)\n\n/m)?.[1] ?? '').split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) : [];
  if (rows.length !== Number(summary[3]) || (summary[1] === '过' && rows.length !== Number(summary[2])) || (summary[1] === '不过' && !errors.length)) return incomplete('报告的题数或格式错误清单不完整');
  const failed = problems.length > 0 || errors.length > 0;
  if (outcome !== (failed ? 'failure' : 'success')) return incomplete(`verify 状态为 ${outcome || '未知'}，与报告不符`);
  return { failed, problems, errors };
}

export function planWeeklyIssue({ report, outcome, issues, sourceURLs = {}, runURL }) {
  if (!Array.isArray(issues) || !issues.every(i => i && typeof i.title === 'string' && Number.isSafeInteger(i.number) && i.number > 0 && ['open', 'closed'].includes(i.state))) throw Error('issue 列表格式不对');
  if (!/^https:\/\/[^\s<>]+\/actions\/runs\/\d+$/.test(runURL ?? '')) throw Error('run 链接不对');
  const existing = issues.filter(i => i.state === 'open' && i.title === TITLE && !i.pull_request).sort((a, b) => a.number - b.number)[0];
  const result = parseReport(report, outcome), lines = [`本次 run：${runURL}`, ''];
  if (result.failed) {
    lines.push('本周原句检查有不过、无法核对或检查未完成的项目。');
    if (result.errors.length) lines.push('', '## 检查问题', ...result.errors.map(e => `- ${e.replace(/@(?!\u200b)/g, '@\u200b')}`));
    for (const p of result.problems) {
      const urls = sourceURLs[p.id];
      lines.push('', `## ${p.id} — ${labels[p.status]}`, `- 网址：${Array.isArray(urls) && urls.length ? urls.map(escape).join('；') : '报告未能对应来源，见下方原因及 run 报告'}`, ...p.reasons.map(reason => `- 原因：${reason.replace(/@(?!\u200b)/g, '@\u200b')}`));
    }
  } else lines.push('本周全过。');
  lines.push('');
  return { action: existing ? 'comment' : result.failed ? 'create' : 'none', title: TITLE, number: existing?.number, body: lines.join('\n'), failed: result.failed };
}

// 单个 issue 正文有长度上限；长清单分成后续评论，保留所有题目和原因。
export function splitBody(body, limit = 58_000) {
  const parts = [];
  while (body.length > limit) {
    let end = body.lastIndexOf('\n', limit);
    if (end <= 0) end = limit;
    if (/[\uD800-\uDBFF]/.test(body[end - 1])) end--;
    parts.push(body.slice(0, end)); body = body.slice(end);
  }
  parts.push(body); return parts;
}

export async function publishWeeklyIssue({ github, context, reportFile, outcome, dataDir = 'data' }) {
  const { owner, repo } = context.repo;
  const runURL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${owner}/${repo}/actions/runs/${context.runId}`;
  let report = null, sourceURLs = {};
  try {
    if ((await fs.stat(reportFile)).size <= 16 * 1024 * 1024) report = await fs.readFile(reportFile, 'utf8');
  } catch { /* 没出报告也必须报检查没跑完。 */ }
  try {
    for (const raw of (await readDirectory(dataDir)).values()) {
      const doc = JSON.parse(raw);
      for (const r of doc.records ?? []) if (r?.id && Array.isArray(r.sources)) sourceURLs[r.id] = r.sources.map(s => s.url).filter(u => typeof u === 'string');
    }
  } catch { /* 格式坏了时仍发布报告中的错误，不挡 issue。 */ }
  const issues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 });
  const plan = planWeeklyIssue({ report, outcome, issues, sourceURLs, runURL });
  if (plan.action === 'none') return plan;
  const bodies = splitBody(plan.body).map((body, i) => i ? `本次 run：${runURL}\n\n（清单续）\n${body}` : body);
  let number = plan.number;
  for (const body of bodies) {
    if (!number) {
      const response = await github.rest.issues.create({ owner, repo, title: plan.title, body });
      number = response?.data?.number;
      if (!Number.isSafeInteger(number) || number <= 0) throw Error('创建 issue 没返回有效编号');
    } else await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }
  return { ...plan, number };
}
