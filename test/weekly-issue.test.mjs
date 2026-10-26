import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { report } from '../scripts/verify.mjs';
import { parseReport, planWeeklyIssue, publishWeeklyIssue, splitBody, TITLE } from '../scripts/weekly-issue.mjs';

const runURL = 'https://github.com/secondfirst-ai/melb/actions/runs/12345';
const url = 'https://example.gov.au/water?a=1&b=2';
const sourceURLs = { water: [url] };
const existing = { number: 7, title: TITLE, state: 'open' };
function fixture(status = 'pass', changes = {}) {
  return report({ scope: '全部问答', literalOnly: true, errors: [], warnings: [], legacyFiles: 5, legacyRecords: 10, total: 1,
    results: [{ id: 'water', literal: status, semantic: 'skipped', status, issues: status === 'pass' ? [] : [{ text: status === 'fail' ? `quote 1 不在页面上：Safe water.（${url}）` : `quote 1：无法取得 ${url}（HTTP 403）` }], quotes: [{ url, quote: 'Safe water.' }] }],
    usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 }, ...changes });
}
const plan = (status, issues = [], extra = {}) => planWeeklyIssue({ report: fixture(status), outcome: status === 'pass' ? 'success' : 'failure', issues, sourceURLs, runURL, ...extra });

test('全过不新开issue；有精确标题的开放issue才评论本周全过', () => {
  assert.equal(plan('pass').action, 'none');
  const p = plan('pass', [existing]);
  assert.equal(p.action, 'comment'); assert.equal(p.number, 7); assert.equal(p.failed, false);
  assert.match(p.body, /本周全过/); assert.ok(p.body.includes(runURL));
  for (const issue of [{ ...existing, state: 'closed' }, { ...existing, title: TITLE + ' ' }, { ...existing, pull_request: {} }]) assert.equal(plan('pass', [issue]).action, 'none');
});

for (const status of ['fail', 'unable']) test(`${status}新开或评论，保留题目id、来源网址、原因和run`, () => {
  for (const issues of [[], [existing]]) {
    const p = plan(status, issues);
    assert.equal(p.action, issues.length ? 'comment' : 'create'); assert.equal(p.title, TITLE); assert.equal(p.failed, true);
    assert.match(p.body, /water/); assert.match(p.body, /https:\/\/example.gov.au\/water\?a=1&amp;b=2/);
    assert.match(p.body, status === 'fail' ? /不过[\s\S]*不在页面上/ : /无法核对[\s\S]*HTTP 403/); assert.ok(p.body.includes(runURL));
  }
});

test('缺失、崩溃、不完整、非literal-only或状态不符都开检查没跑完', () => {
  for (const [reportText, outcome] of [[null, 'failure'], ['', 'skipped'], ['<!-- melb-verify -->\n# melb verification\n\n脚本出错：broken\n', 'failure'], [fixture().slice(0, -80), 'success'], [fixture().replace('本次核 1 条', '本次核 2 条'), 'success'], [fixture().replace('只做格式和字面；没有跑逐句核对，不能自动合并', '格式 + 字面 + Claude 逐句核对'), 'success'], [fixture(), 'failure'], [fixture('unable'), 'success'], [fixture('unable').replace(/## water[\s\S]*?\n\nClaude/, '\nClaude'), 'failure']]) {
    for (const issues of [[], [existing]]) {
      const p = plan('pass', issues, { report: reportText, outcome });
      assert.equal(p.action, issues.length ? 'comment' : 'create'); assert.equal(p.failed, true);
      assert.match(p.body, /检查本身没跑完/); assert.ok(p.body.includes(runURL)); assert.doesNotMatch(p.body, /本周全过/);
    }
  }
});

test('格式错误不误报全过；合法零问答可全过；多个题目与格式转义不丢', () => {
  const p = plan('pass', [], { report: fixture('pass', { errors: ['bad.json：JSON 不能解析'], total: 0, results: [] }), outcome: 'failure' });
  assert.equal(p.action, 'create'); assert.match(p.body, /bad.json：JSON 不能解析/);
  assert.equal(parseReport(fixture('pass', { total: 0, results: [] }), 'success').failed, false);
  const result = parseReport(fixture('unable', { warnings: ['@someone <not-an-issue>'] }), 'failure');
  assert.equal(result.problems.length, 1); assert.equal(result.problems[0].status, 'unable');
  const mixed = report({ scope: '全部问答', literalOnly: true, errors: [], warnings: [], legacyFiles: 0, legacyRecords: 0, total: 2, results: ['fail', 'unable'].map((status, i) => ({ id: 'q-' + i, literal: status, semantic: 'skipped', status, issues: [{ text: 'quote 1：失败 @someone <unsafe>' }], quotes: [{ url, quote: 'quote' }] })), usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 } });
  const mixedPlan = plan('pass', [], { report: mixed, outcome: 'failure', sourceURLs: { 'q-0': [url], 'q-1': [url] } });
  assert.match(mixedPlan.body, /q-0 — 不过/); assert.match(mixedPlan.body, /q-1 — 无法核对/);
  assert.doesNotMatch(mixedPlan.body, /@someone|<unsafe>/);
  assert.throws(() => plan('pass', {}), /issue 列表/); assert.throws(() => plan('pass', [], { runURL: 'not a run' }), /run 链接/);
  assert.equal(plan('fail', [{ ...existing, number: 9 }, existing]).number, 7);
});

test('长清单分评论，字节内容及surrogate完整保留', () => {
  for (const text of ['long line '.repeat(50), '一行\n'.repeat(300), '😀'.repeat(200)]) {
    const parts = splitBody(text, 50);
    assert.equal(parts.join(''), text); assert.ok(parts.every(s => s.length <= 50));
    assert.ok(parts.every(s => !/[\uD800-\uDBFF]$/.test(s)));
  }
});

function fakeGitHub(issues) {
  const calls = [];
  const github = { rest: { issues: {
    listForRepo: Symbol('list'),
    create: async options => { calls.push(['create', options]); return { data: { number: 42 } }; },
    createComment: async options => { calls.push(['comment', options]); return { data: {} }; }
  } }, paginate: async (method, options) => { assert.equal(method, github.rest.issues.listForRepo); assert.deepEqual(options, { owner: 'secondfirst-ai', repo: 'melb', state: 'open', per_page: 100 }); return issues; } };
  return { github, calls };
}

test('离线发布接线：分页精确匹配，report缺失仍报，create/comment/noop都只走注入API', async t => {
  await fs.mkdir('.cache', { recursive: true }); const dir = await fs.mkdtemp(path.resolve('.cache/weekly-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'data'));
  await fs.writeFile(path.join(dir, 'data/water.json'), JSON.stringify({ records: [{ id: 'water', sources: [{ url }] }] }));
  const reportFile = path.join(dir, 'report.md'), context = { repo: { owner: 'secondfirst-ai', repo: 'melb' }, runId: 12345 };
  for (const [status, issues, action] of [['pass', [], 'none'], ['pass', [existing], 'comment'], ['fail', [], 'create'], ['unable', [existing], 'comment'], [null, [], 'create']]) {
    if (status) await fs.writeFile(reportFile, fixture(status)); else await fs.rm(reportFile);
    const fake = fakeGitHub(issues);
    const p = await publishWeeklyIssue({ github: fake.github, context, reportFile, dataDir: path.join(dir, 'data'), outcome: status === 'pass' ? 'success' : 'failure' });
    assert.equal(p.action, action); assert.equal(fake.calls.length, action === 'none' ? 0 : 1);
    if (action !== 'none') { assert.ok(fake.calls[0][1].body.includes('/actions/runs/12345')); if (status && status !== 'pass') assert.match(fake.calls[0][1].body, /example.gov.au/); }
  }
  await fs.writeFile(reportFile, fixture('pass', { errors: ['x'.repeat(60_000)], total: 0, results: [] }));
  const fake = fakeGitHub([]);
  await publishWeeklyIssue({ github: fake.github, context, reportFile, dataDir: path.join(dir, 'data'), outcome: 'failure' });
  assert.ok(fake.calls.length >= 2); assert.equal(fake.calls[0][0], 'create'); assert.ok(fake.calls.slice(1).every(([action]) => action === 'comment'));
  assert.ok(fake.calls.every(([, options]) => options.body.includes('/actions/runs/12345')));
});

test('同题网址只列一次、每个quote只有一条原因且保留原句', () => {
  const quotes = [{ url, quote: 'First exact sentence.' }, { url, quote: 'Second exact sentence.' }];
  const text = report({ scope: '全部问答', literalOnly: true, errors: [], warnings: [], legacyFiles: 0, legacyRecords: 0, total: 1,
    results: [{ id: 'water', literal: 'fail', semantic: 'skipped', status: 'fail', quotes, issues: [{ text: `quote 1 不在页面上：First exact sentence.（${url}）` }, { text: `quote 2：无法取得 ${url}（HTTP 403）` }] }], usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 } });
  const p = plan('fail', [], { report: text, sourceURLs: { water: [url, url] } });
  assert.equal(p.body.split('https://example.gov.au/water?a=1&amp;b=2').length - 1, 1);
  for (const n of [1, 2]) assert.equal((p.body.match(new RegExp('^- 原因：quote ' + n + '：', 'gm')) ?? []).length, 1);
  assert.match(p.body, /First exact sentence/); assert.match(p.body, /Second exact sentence/); assert.match(p.body, /HTTP 403/);
});

test('本机run标记格式及发布CLI：分页、新建、评论、缺token、任何输出和正文都不漏token', async t => {
  const { localMain } = await import('../scripts/weekly-issue.mjs');
  const localURL = 'local:melbourne-mac:2026-10-26T18:30:00+11:00';
  assert.match(plan('pass', [existing], { runURL: localURL }).body, /本次从墨尔本本机跑：local:/);
  for (const value of ['local:x:no-time', 'local:x\n:2026-10-26T18:30:00Z']) assert.throws(() => plan('pass', [], { runURL: value }), /run 链接/);
  const dir = await fs.mkdtemp(path.resolve('.cache/local-weekly-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.md'), token = 'FAKE_WEEKLY_PRIVATE_TOKEN', args = ['--publish', '--report', file, '--outcome', 'failure', '--run-url', localURL];
  await fs.writeFile(file, fixture('pass', { errors: ['fixture ' + token], total: 0, results: [] }));
  for (const opened of [false, true]) {
    const logs = [], calls = [];
    const fetchImpl = async (target, options) => {
      calls.push({ target, options }); assert.equal(options.headers.authorization, 'Bearer ' + token); assert.equal(options.redirect, 'error');
      if (options.method === 'GET') {
        if (target.endsWith('page=1')) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, title: 'not the issue', state: 'open' }))));
        return new Response(JSON.stringify(opened ? [existing] : []));
      }
      assert.ok(!options.body.includes(token)); return new Response(JSON.stringify({ number: 42 }));
    };
    const code = await localMain(args, { env: { MELB_ISSUES_TOKEN: token }, fetchImpl, out: s => logs.push(s), error: s => logs.push(s) });
    assert.equal(code, 1); assert.equal(calls.length, 3); assert.match(calls.at(-1).target, opened ? /issues\/7\/comments$/ : /issues$/);
    assert.ok(!logs.join('').includes(token)); assert.match(calls.at(-1).options.body, /redacted/);
  }
  let fetches = 0; const logs = [];
  assert.equal(await localMain(args, { env: {}, fetchImpl: () => { fetches++; throw Error('must not fetch'); }, error: s => logs.push(s) }), 2);
  assert.equal(fetches, 0); assert.match(logs.join(''), /MELB_ISSUES_TOKEN 没配/);
  const failedLogs = [];
  assert.equal(await localMain(args, { env: { MELB_ISSUES_TOKEN: token }, fetchImpl: () => { throw Error('failure ' + token); }, error: s => failedLogs.push(s) }), 2);
  assert.ok(!failedLogs.join('').includes(token)); assert.match(failedLogs.join(''), /redacted/);
  await fs.writeFile(file, fixture('pass'));
  let posts = 0;
  const code = await localMain(['--publish', '--report', file, '--outcome', 'success', '--run-url', localURL], { env: { MELB_ISSUES_TOKEN: token }, fetchImpl: async (_url, options) => { if (options.method !== 'GET') posts++; return new Response('[]'); }, out: () => {} });
  assert.equal(code, 0); assert.equal(posts, 0);
});
