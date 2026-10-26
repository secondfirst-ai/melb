import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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


// 按 quote 编号合并原因和原句补充，保留没有编号的独立问题。
export function uniqueReasons(reasons) {
  const groups = new Map();
  for (const reason of reasons) {
    const match = reason.match(/^quote (\d+)(?=[ ：])/);
    const key = match ? `quote ${match[1]}` : reason;
    if (!groups.has(key)) groups.set(key, { number: match?.[1], reasons: [], quotes: [] });
    const group = groups.get(key), detail = reason.match(/^quote \d+：(.+) — (https?:\/\/\S+)$/);
    if (detail) {
      if (!group.quotes.some(q => q.text === detail[1] && q.url === detail[2])) group.quotes.push({ text: detail[1], url: detail[2] });
    } else if (!group.reasons.includes(reason)) group.reasons.push(reason);
  }
  return [...groups.values()].map(g => {
    if (!g.number) return g.reasons.join('；');
    const reasons = g.reasons.map(r => r.replace(/^quote \d+[ ：]*/, ''));
    for (const { text, url } of g.quotes) {
      if (!reasons.some(r => r.includes(text))) reasons.push(`原句：${text}`);
      if (!reasons.some(r => r.includes(url))) reasons.push(`出处：${url}`);
    }
    return `quote ${g.number}：${reasons.join('；')}`;
  });
}
const validRunURL = value => /^https:\/\/[^\s<>]+\/actions\/runs\/\d+$/.test(value ?? '') ||
  /^local:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value ?? '');
const runLine = value => value.startsWith('local:') ? `本次从墨尔本本机跑：${value}` : `本次 run：${value}`;

export function planWeeklyIssue({ report, outcome, issues, sourceURLs = {}, runURL }) {
  if (!Array.isArray(issues) || !issues.every(i => i && typeof i.title === 'string' && Number.isSafeInteger(i.number) && i.number > 0 && ['open', 'closed'].includes(i.state))) throw Error('issue 列表格式不对');
  if (!validRunURL(runURL)) throw Error('run 链接不对');
  const existing = issues.filter(i => i.state === 'open' && i.title === TITLE && !i.pull_request).sort((a, b) => a.number - b.number)[0];
  const result = parseReport(report, outcome), lines = [runLine(runURL), ''];
  if (result.failed) {
    lines.push('本周原句检查有不过、无法核对或检查未完成的项目。');
    if (result.errors.length) lines.push('', '## 检查问题', ...result.errors.map(e => `- ${e.replace(/@(?!\u200b)/g, '@\u200b')}`));
    for (const p of result.problems) {
      // 报告内的网址已经转义；即使 data 缺失，也从明细保留网址和每个 quote 的对应关系。
      const urls = [...new Set([...(Array.isArray(sourceURLs[p.id]) ? sourceURLs[p.id].map(escape) : []), ...p.reasons.flatMap(r => r.match(/https?:\/\/[^\s<>（）]+/g) ?? [])])];
      const reasons = uniqueReasons(p.reasons).map(reason => {
        // 原因用编号引用网址，完整网址每题只列一次；长 URL 先替换，避免前缀相同互相截断。
        for (const { url, index } of urls.map((url, index) => ({ url, index })).sort((a, b) => b.url.length - a.url.length)) reason = reason.split(url).join(`网址${index + 1}`);
        return reason.replace(/@(?!\u200b)/g, '@\u200b');
      });
      lines.push('', `## ${p.id} — ${labels[p.status]}`, `- 网址：${urls.length ? urls.map((u, i) => `[${i + 1}] ${u}`).join('；') : '报告未能对应来源，见下方原因及 run 报告'}`, ...reasons.map(reason => `- 原因：${reason}`));
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

export async function publishWeeklyIssue({ github, context, reportFile, outcome, dataDir = 'data', runURL: providedRunURL }) {
  const { owner, repo } = context.repo;
  const runURL = providedRunURL ?? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${owner}/${repo}/actions/runs/${context.runId}`;
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
  const bodies = splitBody(plan.body).map((body, i) => i ? `${runLine(runURL)}\n\n（清单续）\n${body}` : body);
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


// 本机入口复用相同的分页、issue 选择及长正文规则；不引入第三方 GitHub client。
const redactToken = (value, token) => token ? [...new Set([token, escape(token)])].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join('[redacted]'), String(value)) : String(value);

export function localGitHub(token, fetchImpl = fetch) {
  const scrub = value => redactToken(value, token);
  const request = async (suffix, method = 'GET', payload) => {
    const response = await fetchImpl(`https://api.github.com/repos/secondfirst-ai/melb${suffix}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(payload ? { body: JSON.stringify(payload, (_key, value) => typeof value === 'string' ? scrub(value) : value) } : {}),
    });
    if (!response.ok) throw Error(`GitHub HTTP ${response.status}`);
    return response.json();
  };
  return {
    rest: { issues: {
      listForRepo: 'open-issues',
      create: async ({ title, body }) => ({ data: await request('/issues', 'POST', { title, body }) }),
      createComment: async ({ issue_number, body }) => ({ data: await request(`/issues/${issue_number}/comments`, 'POST', { body }) }),
    } },
    paginate: async () => {
      const all = [];
      for (let page = 1; ; page++) {
        const rows = await request(`/issues?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw Error('GitHub issue 列表不是数组');
        all.push(...rows);
        if (rows.length < 100) return all;
      }
    },
  };
}

export async function localMain(args = process.argv.slice(2), { env = process.env, fetchImpl = fetch, out = text => console.log(text), error = text => console.error(text) } = {}) {
  const token = env.MELB_ISSUES_TOKEN;
  const scrub = value => redactToken(value, token);
  try {
    if (!token?.trim()) throw Error('MELB_ISSUES_TOKEN 没配，没跑');
    const options = {};
    if (args[0] !== '--publish') throw Error('用法：weekly-issue.mjs --publish --report FILE --outcome success|failure --run-url URL');
    for (let i = 1; i < args.length; i += 2) {
      const key = { '--report': 'reportFile', '--outcome': 'outcome', '--run-url': 'runURL' }[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw Error('发布参数不对');
      options[key] = args[i + 1];
    }
    if (!options.reportFile || !['success', 'failure'].includes(options.outcome) || !validRunURL(options.runURL)) throw Error('发布参数不完整或格式不对');
    const plan = await publishWeeklyIssue({ github: localGitHub(token, fetchImpl), context: { repo: { owner: 'secondfirst-ai', repo: 'melb' } }, ...options });
    out(scrub(`Weekly issue: ${plan.action}${plan.number ? ' #' + plan.number : ''}`));
    return plan.failed ? 1 : 0;
  } catch (e) { error(scrub(e.message)); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await localMain();
