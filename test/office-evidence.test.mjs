import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { trustedEvidence, validEntry, createEntries, authenticatedChange, mergeSelectedEntries, main, repositoryFromOrigin } from '../scripts/office-evidence.mjs';
import { recordHash } from '../scripts/verdict-cache.mjs';
import { collectLiteral } from '../scripts/verify.mjs';

const url = 'https://www.ato.gov.au/example', quote = 'Tax is due.', now = Date.parse('2026-11-03T00:00:00.000Z');
const record = { id: 'fixture', question: { en: 'When?', zh: '何时？' }, answer: { en: 'Tax is due.', zh: '税款到期。' }, aliases: ['tax'], tags: ['tax'], sources: [{ url, quote }], checked: '2026-11-03' };
const entry = { recordId: record.id, recordHash: recordHash(record), url, quote, text: 'Official notice: Tax is due. Some context.', fetchedAt: new Date(now).toISOString(), pageSha256: 'a'.repeat(64) };
const doc = { dataset: 'fixture', title: { en: 'Fixture', zh: '例子' }, updated: '2026-11-03', notes: [], records: [record] };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(dir, 'office-evidence.json'), JSON.stringify({ version: 1, entries: [entry] }));
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'signed fixture');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}
function response(sha, extra = {}) { return { ok: true, json: async () => ({ sha, author: { login: '2nd1st' }, committer: { login: '2nd1st' }, commit: { verification: { verified: true } }, ...extra }) }; }

test('可信账号签名绑定证据 blob；外人、假身份、未验签、API失败及后续篡改都拒绝', async t => {
  const { dir, head } = await fixture(t);
  const args = { cwd: dir, head, repository: 'secondfirst-ai/melb', trustedPR: true, request: async u => { assert.equal(u, `https://api.github.com/repos/secondfirst-ai/melb/commits/${head}`); return response(head); } };
  assert.deepEqual(await trustedEvidence(args), [entry]);
  assert.equal(await trustedEvidence({ ...args, trustedPR: false, request: () => assert.fail('外人不查 API') }), null);
  for (const extra of [{ author: { login: 'outsider' } }, { committer: { login: 'outsider' } }, { commit: { verification: { verified: false } } }, { sha: '0'.repeat(40) }]) {
    assert.equal(await trustedEvidence({ ...args, request: async () => response(head, extra) }), null);
  }
  assert.equal(await trustedEvidence({ ...args, request: async () => { throw Error('offline'); } }), null);
  await fs.writeFile(path.join(dir, 'office-evidence.json'), JSON.stringify({ version: 1, entries: [{ ...entry, text: 'forged' }] }));
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'tamper'); const changed = git(dir, 'rev-parse', 'HEAD');
  assert.equal(await trustedEvidence({ ...args, head: changed, request: async () => response(head) }), null);
});

test('证据文件改动必须是可信 PR 且验签通过，否则 literal 红', async () => {
  const signed = async () => [entry];
  assert.equal(await authenticatedChange({ files: ['office-evidence.json'], trusted: true }, signed), true);
  assert.equal(await authenticatedChange({ files: ['office-evidence.json'], trusted: false }, () => assert.fail('外部 PR 不取证据')), false);
  assert.equal(await authenticatedChange({ files: ['office-evidence.json'], trusted: true }, async () => null), false);
  assert.equal(await authenticatedChange({ files: ['data/money-work.json'], trusted: false }, () => assert.fail('未改证据')), true);
});

test('过期、未来、缺原句、非官方域名与假哈希均拒绝', () => {
  assert.equal(validEntry(entry, { url, quote }, record, now), true);
  for (const bad of [
    { ...entry, text: 'no quote' }, { ...entry, url: 'https://ato.gov.au.evil.test/a' },
    { ...entry, fetchedAt: new Date(now - 30 * 86400000 - 1).toISOString() },
    { ...entry, fetchedAt: new Date(now + 1).toISOString() }, { ...entry, pageSha256: 'not a hash' },
  ]) assert.equal(validEntry(bad, { url: bad.url, quote }, record, now), false);
});

test('办公室采集只保存白名单正文及页 hash，缺原句失败', async () => {
  let reads = 0;
  const rows = [{ record: { ...record, sources: [record.sources[0], { url, quote: 'Read more.' }] } }], reader = { read: async () => { reads++; return 'A page says Tax is due. Read more.'; } };
  const result = await createEntries(rows, reader, () => new Date(now));
  assert.equal(result.entries.length, 2); assert.equal(reads, 1); assert.ok(result.entries[0].text.includes(quote)); assert.match(result.entries[0].pageSha256, /^[a-f0-9]{64}$/);
  const partial = await createEntries(rows, { read: async () => 'Tax is due.' });
  assert.equal(partial.entries.length, 1); assert.equal(partial.failures.length, 1);
  const failed = await createEntries(rows, { read: async () => { throw Error('blocked'); } });
  assert.equal(failed.entries.length, 0); assert.equal(failed.failures.length, 2);
});

test('集成 literal：可信证据通过；未授权、缺原句、过期、域名不符为 unable；能读时不使用证据', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-data-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'money-work.json'), JSON.stringify(doc));
  const read = text => ({ async read() { return { texts: text ? [text] : [], errors: ['fixture blocked'], browserFailed: true }; }, async close() {} });
  const run = entries => collectLiteral({ dataDir: dir }, { sources: read(''), officeEvidence: async () => entries });
  // 控制测试时间，实际集成按运行时检查过期。
  const recent = { ...entry, fetchedAt: new Date().toISOString() };
  assert.equal((await run([recent])).exitCode, 0);
  assert.equal((await run(null)).exitCode, 1);
  assert.equal((await run([{ ...recent, text: 'not present' }])).exitCode, 1);
  assert.equal((await run([{ ...recent, fetchedAt: '2000-01-01T00:00:00.000Z' }])).exitCode, 1);
  assert.equal((await run([{ ...recent, url: 'https://evil.test/a' }])).exitCode, 1);
  let called = false;
  const readable = await collectLiteral({ dataDir: dir }, { sources: read('official notice: tax is due.'), officeEvidence: async () => { called = true; throw Error('must not use evidence'); } });
  assert.equal(readable.exitCode, 0); assert.equal(called, false);
});

test('页面外壳及浏览器失败才回退证据；全部找到或浏览器成功时优先机房结果', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-shell-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secondQuote = 'Read more.';
  const candidate = { ...record, sources: [{ url, quote }, { url, quote: secondQuote }] };
  await fs.writeFile(path.join(dir, 'money-work.json'), JSON.stringify({ ...doc, records: [candidate] }));
  const recent = new Date().toISOString();
  const entries = [quote, secondQuote].map(q => ({ ...entry, recordHash: recordHash(candidate), quote: q, text: `Official notice: ${q}`, fetchedAt: recent }));
  const run = async page => {
    let calls = 0;
    const result = await collectLiteral({ dataDir: dir }, {
      sources: { async read() { return page; }, async close() {} },
      officeEvidence: async () => { calls++; return entries; },
    });
    return { result, calls };
  };
  for (const page of [
    { texts: ['official notice: tax is due.'], errors: ['browser blocked'], browserFailed: true },
    { texts: [], errors: ['blocked'], browserFailed: false },
  ]) {
    const { result, calls } = await run(page);
    assert.equal(result.results[0].literal, 'pass'); assert.equal(calls, 1);
  }
  const readable = await run({ texts: ['official notice: tax is due. read more.'], errors: ['browser blocked'], browserFailed: true });
  assert.equal(readable.result.results[0].literal, 'pass'); assert.equal(readable.calls, 0);
  const missing = await run({ texts: ['official notice: tax is due.'], errors: [], browserFailed: false });
  assert.equal(missing.result.results[0].literal, 'fail'); assert.equal(missing.calls, 0);
});


test('证据按题目 id 和完整内容绑定，同 URL 同 quote 也不能跨题重放', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-replay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const other = { ...record, id: 'other' };
  const changed = { ...record, answer: { ...record.answer, en: 'Changed answer.' } };
  const recent = { ...entry, fetchedAt: new Date().toISOString() };
  const sources = () => ({ async read() { return { texts: [], errors: ['blocked'], browserFailed: true }; }, async close() {} });
  for (const candidate of [other, changed]) {
    await fs.writeFile(path.join(dir, 'money-work.json'), JSON.stringify({ ...doc, records: [candidate] }));
    assert.equal((await collectLiteral({ dataDir: dir }, { sources: sources(), officeEvidence: async () => [recent] })).exitCode, 1);
  }
  await fs.writeFile(path.join(dir, 'money-work.json'), JSON.stringify({ ...doc, records: [record, other] }));
  const both = await collectLiteral({ dataDir: dir }, { sources: sources(), officeEvidence: async () => [recent] });
  assert.deepEqual(both.results.map(r => r.literal), ['pass', 'unable']);
});

test('按 URL 选择及逐条失败不会阻止其他页面采集', async () => {
  const second = 'https://www.ato.gov.au/other';
  const rows = [{ record: { ...record, sources: [{ url, quote }, { url: second, quote }] } }];
  const reader = { read: async u => { if (u === second) throw Error('blocked'); return quote; } };
  const all = await createEntries(rows, reader); assert.equal(all.entries.length, 1); assert.deepEqual(all.failures.map(f => f.url), [second]);
  const selected = await createEntries(rows, reader, () => new Date(), new Set([url]));
  assert.equal(selected.entries.length, 1); assert.equal(selected.failures.length, 0);
  const missing = await createEntries(rows, reader, () => new Date(), new Set([url, 'https://www.ato.gov.au/missing']));
  assert.equal(missing.entries.length, 1); assert.equal(missing.failures.length, 1); assert.match(missing.failures[0].reason, /不在变更题/);
});


test('外部 PR 只改证据文件，实际 literal pipeline 返回失败', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-only-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); await fs.mkdir(cwd);
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(cwd, 'README'), 'base'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', git(cwd, 'rev-parse', 'HEAD'));
  await fs.writeFile(path.join(cwd, 'office-evidence.json'), '{}'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'fake evidence');
  const event = path.join(root, 'event.json');
  await fs.writeFile(event, JSON.stringify({ pull_request: { number: 1, head: { sha: git(cwd, 'rev-parse', 'HEAD') }, base: { ref: 'main' }, author_association: 'NONE', user: { login: 'outsider' } } }));
  const result = spawnSync(process.execPath, [path.resolve('scripts/pipeline.mjs'), 'literal'], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: event } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(await fs.readFile(path.join(root, 'verify-report.md'), 'utf8'), /没有问答改动/);
});


test('按 URL 重采集保留其他 URL 的证据，同 URL 替换', () => {
  const second = { ...entry, url: 'https://www.ato.gov.au/other' };
  const replacement = { ...entry, text: 'Tax is due. refreshed' };
  assert.deepEqual(mergeSelectedEntries({ version: 1, entries: [entry, second] }, [replacement], new Set([url])), [second, replacement]);
  assert.deepEqual(mergeSelectedEntries({ version: 1, entries: [entry] }, [replacement], null), [replacement]);
  assert.throws(() => mergeSelectedEntries({ version: 9, entries: [] }, [], new Set([url])), /格式不对/);
});


test('按 URL 重采集先验签旧文件，拒绝未认证或未提交文件，认证后才保留其他 URL', async t => {
  const oldCI = process.env.GITHUB_ACTIONS; delete process.env.GITHUB_ACTIONS;
  t.after(() => { if (oldCI === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldCI; });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-capture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
  assert.equal(repositoryFromOrigin(dir), 'example/project');
  await fs.mkdir(path.join(dir, 'data'));
  await fs.writeFile(path.join(dir, 'data/money-work.json'), JSON.stringify({ ...doc, records: [] }));
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  const other = { ...entry, url: 'https://www.ato.gov.au/other' };
  const evidencePath = path.join(dir, 'office-evidence.json');
  const original = JSON.stringify({ version: 1, entries: [entry, other] });
  await fs.writeFile(path.join(dir, 'data/money-work.json'), JSON.stringify(doc));
  await fs.writeFile(evidencePath, original);
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'existing evidence');
  const head = git(dir, 'rev-parse', 'HEAD');
  let reads = 0, commits = 0, requests = 0;
  const options = { cwd: dir, request: async u => { requests++; assert.equal(u, `https://api.github.com/repos/example/project/commits/${head}`); return response(head, { commit: { verification: { verified: false } } }); },
    makeReader: () => ({ read: async () => { reads++; return 'refreshed Tax is due.'; }, close: async () => {} }),
    commit: () => { commits++; git(dir, 'add', 'office-evidence.json'); git(dir, 'commit', '-m', 'fixture capture'); } };
  const args = ['--base', base, '--url', url];
  await assert.rejects(main(args, options), /旧证据未通过.*去掉 --url/);
  assert.equal(requests, 1); assert.equal(reads, 0); assert.equal(commits, 0);
  assert.equal(await fs.readFile(evidencePath, 'utf8'), original); assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  await fs.writeFile(evidencePath, original + ' ');
  await assert.rejects(main(args, options), /未提交改动/);
  assert.equal(requests, 1); assert.equal(commits, 0);
  await fs.writeFile(evidencePath, original);
  options.request = async u => { assert.equal(u, `https://api.github.com/repos/custom/repo/commits/${head}`); return response(head); };
  await main([...args, '--repository', 'custom/repo'], options);
  const saved = JSON.parse(await fs.readFile(evidencePath, 'utf8')).entries;
  assert.equal(commits, 1); assert.equal(reads, 1); assert.deepEqual(saved[0], other);
  assert.equal(saved.length, 2); assert.equal(saved[1].url, url); assert.equal(saved[1].text, 'refreshed Tax is due.');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), head);
});
