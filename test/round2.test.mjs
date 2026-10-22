import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire, release } from '../scripts/merge-lock.mjs';
import { mergeVerified } from '../scripts/merge-pr.mjs';
import { prepare, recordOnly } from '../scripts/prepare-pr.mjs';
import { inspect, readDirectory } from '../scripts/format.mjs';
import { emptyCache, recordHash, sha256 } from '../scripts/verdict-cache.mjs';
import { loadCache, validateCache } from '../scripts/artifact-cache.mjs';
import { validateEvidence, proofFor, checkProof } from '../scripts/pipeline.mjs';
import { judge } from '../scripts/verify.mjs';
import { Sources, literal } from '../scripts/source.mjs';
import { Claude, sentences, prompt } from '../scripts/model.mjs';

const record = id => ({ id, question: { en: 'Can I drink tap water?', zh: '能喝自来水吗？' }, answer: { en: 'Tap water is safe.', zh: '自来水可以饮用。' }, aliases: ['Tap water?', '自来水'], tags: ['water'], sources: [{ url: 'https://example.gov.au/water', quote: 'Tap water is safe.' }], checked: '2026-10-22' });
const doc = records => ({ dataset: 'sample', title: { en: 'Sample', zh: '例' }, updated: '2026-10-22', notes: [], records });
const verdict = (r, choice = 'yes') => ({ id: r.id, sentences: sentences(r.answer.en).map(text => ({ text, verdict: choice, why: 'quote 1' })), translation: { verdict: 'yes', why: 'same meaning' }, answer_en: r.answer.en, answer_zh: r.answer.zh });
const evidenceFor = records => ({ version: 1, errors: [], warnings: [], exitCode: 0, results: [], items: records.map(record => ({ file: 'driving.json', record, hash: recordHash(record), status: 'pass', issues: [], excerpts: record.sources.map(s => ({ ...s, text: s.quote })) })) });
async function repo(t) {
  await fs.mkdir('.cache', { recursive: true }); const cwd = await fs.mkdtemp(path.resolve('.cache/r2-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'melb.si'); git('config', 'user.email', 'hello@melb.si');
  await fs.mkdir(path.join(cwd, 'data'));
  const write = (name, value) => fs.writeFile(path.join(cwd, 'data', name), JSON.stringify(value));
  const commit = () => { git('add', 'data'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  await write('everyday.json', doc([record('original')])); const base = commit();
  return { cwd, git, write, commit, base };
}

test('两个旧基线 PR 改不同类别：合并 main 数据，跨文件重复拦住，同文件冲突要人看', async t => {
  const { cwd, git, write, commit, base } = await repo(t);
  git('checkout', '-b', 'b'); await write('driving.json', doc([record('same')])); const head = commit();
  git('checkout', 'main'); await write('health.json', doc([record('same')])); const advanced = commit();
  const dir = path.join(cwd, 'candidate');
  const plan = await prepare({ cwd, base: advanced, head, destination: dir, association: 'OWNER' });
  assert.equal(plan.autoEligible, true); assert.equal(plan.fork, base);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['driving.json', 'everyday.json', 'health.json']);
  assert.match(inspect(await readDirectory(dir), []).errors.join(' '), /重复/);
  await write('driving.json', doc([record('on-main')])); const conflict = commit();
  const denied = await prepare({ cwd, base: conflict, head, destination: path.join(cwd, 'no'), association: 'OWNER' });
  assert.equal(denied.autoEligible, false); assert.match(denied.reason, /同一文件/);
});

test('只自动处理新增/修改题目；删题、空集、notes/title/updated-only 都要人看', async t => {
  const old = doc([record('one')]);
  assert.equal(recordOnly(old, doc([record('one'), record('two')])), null);
  const revised = structuredClone(old); revised.records[0].answer.zh += '可直接喝。'; revised.updated = '2026-10-23';
  assert.equal(recordOnly(old, revised), null);
  for (const change of [d => d.records = [], d => d.records = [record('two')], d => d.notes.push({ en: 'new', zh: '新' }), d => d.title.en = 'Other', d => d.updated = '2026-10-23']) {
    const after = structuredClone(old); change(after); assert.ok(recordOnly(old, after));
  }
  const { cwd, git, write, commit, base } = await repo(t);
  for (const file of ['holidays.json', 'unknown.json', 'health.json']) {
    git('checkout', '-b', file.replace('.', '-'), base);
    if (file === 'health.json') await fs.unlink(path.join(cwd, 'data/everyday.json'));
    else await write(file, doc([record('new')]));
    const head = commit();
    assert.equal((await prepare({ cwd, base, head, destination: path.join(cwd, file), association: 'OWNER' })).autoEligible, false);
  }
});

test('相同 record 内容顺序无关缓存；失败结论也复用，改一题只付那题；unable 不缓存', async () => {
  const a = record('a'), b = record('b'), cache = emptyCache(7); let calls = 0, saves = 0;
  const model = { usage: { requests: 0 }, check: async r => { calls++; return { status: r.id === 'b' ? 'fail' : 'pass', issues: [], verdict: verdict(r, r.id === 'b' ? 'no' : 'yes') }; } };
  const first = await judge(evidenceFor([a, b]), { model, cache, saveCache: async () => { saves++; } });
  assert.equal(calls, 2); assert.equal(saves, 2); assert.equal(first.exitCode, 1);
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const second = await judge(evidenceFor([reordered, b]), { model, cache });
  assert.equal(calls, 2); assert.equal(second.cacheHits, 2); assert.equal(second.results[1].status, 'fail');
  b.checked = '2026-10-23'; await judge(evidenceFor([a, b]), { model, cache }); assert.equal(calls, 3);
  const unable = { usage: {}, check: async () => { calls++; return { status: 'unable', issues: [] }; } };
  const c = emptyCache(8); await judge(evidenceFor([a]), { model: unable, cache: c }); await judge(evidenceFor([a]), { model: unable, cache: c });
  assert.equal(calls, 5); assert.deepEqual(c.entries, {});
});

test('artifact 缓存须匹配 bot 评论摘要、模型、PR；遗失缓存不自动付钱', async () => {
  const bytes = Buffer.from(JSON.stringify(emptyCache(7))), pointer = { sha256: sha256(bytes) };
  assert.equal(validateCache(bytes, pointer, 7).pr, '7');
  assert.throws(() => validateCache(Buffer.from('{}'), pointer, 7), /hash/);
  assert.throws(() => validateCache(bytes, pointer, 8), /PR/);
  await assert.rejects(loadCache(7, { find: async () => ({ body: '<!-- melb-cache {"blocked":true} -->' }) }), /不会自动重复付费/);
});

test('缓存下载只读固定 JSON，跨主机跳转不转交 GitHub token', async t => {
  const { cwd } = await repo(t), bytes = Buffer.from(JSON.stringify(emptyCache(7)));
  await fs.writeFile(path.join(cwd, 'semantic-cache.json'), bytes);
  execFileSync('zip', ['-q', 'cache.zip', 'semantic-cache.json'], { cwd });
  const zip = await fs.readFile(path.join(cwd, 'cache.zip'));
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = 'secondfirst-ai/melb';
  try {
    let calls = 0;
    const result = await loadCache(7, { find: async () => ({ body: `<!-- melb-cache ${JSON.stringify({ artifact: 123, sha256: sha256(bytes) })} -->` }), fetchImpl: async (url, options) => {
      if (++calls === 1) { assert.match(options.headers.authorization, /^Bearer /); return new Response(null, { status: 302, headers: { location: 'https://storage.example/cache' } }); }
      assert.equal(options.headers, undefined); assert.equal(url, 'https://storage.example/cache'); return new Response(zip);
    } });
    assert.equal(result.pr, '7'); assert.equal(calls, 2);
  } finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});

test('artifact 必须逐条对应真实 git 候选与出处；语义 proof 不能换题或伪造 hash', async t => {
  const { cwd, write, commit, base } = await repo(t), r = record('new'); await write('driving.json', doc([r])); const head = commit();
  const pr = { number: 7, head: { sha: head }, base: { ref: 'main' }, author_association: 'OWNER' };
  const evidence = evidenceFor([r]); evidence.meta = { number: '7', head, base };
  const checked = await validateEvidence(evidence, { cwd, pr, currentMain: base, directory: path.join(cwd, 'candidate') });
  assert.equal(checked.exitCode, 0);
  const proof = Buffer.from(JSON.stringify(proofFor(evidence, 7)));
  checkProof(proof, sha256(proof), { number: 7, head, chosen: [{ record: r }] });
  assert.throws(() => checkProof(proof, '0'.repeat(64), { number: 7, head, chosen: [{ record: r }] }), /hash/);
  assert.throws(() => checkProof(proof, sha256(proof), { number: 8, head, chosen: [{ record: r }] }), /PR/);
  for (const [i, mutate] of [x => x.items = [], x => x.items[0].record.answer.zh = '不是同题', x => x.items[0].excerpts[0].text = 'No quote'].entries()) {
    const bad = structuredClone(evidence); mutate(bad);
    await assert.rejects(validateEvidence(bad, { cwd, pr, currentMain: base, directory: path.join(cwd, `bad-${i}`) }));
  }
});

test('fetch 有正文但缺 quote + 浏览器 403 为 unable；可靠浏览器缺 quote 才为 fail', async () => {
  const r = record('abf'), url = r.sources[0].url;
  for (const blocked of [true, false]) {
    const source = new Sources({ checkURL: async () => {}, fetchImpl: async () => new Response(`<p>${'Navigation only. '.repeat(40)}</p>`), browserFactory: async () => { throw Error('浏览器 HTTP 403'); } });
    if (!blocked) source.readBrowser = async () => 'No matching quote. '.repeat(40);
    const page = await source.read(url, [r.sources[0].quote]);
    assert.equal(literal(r, new Map([[url, page]])).status, blocked ? 'unable' : 'fail'); await source.close();
  }
});

test('提示词按事实含义判中文，不要求逐字；保留数值/条件等缺失拦截且不加请求、不发 temperature', async () => {
  const r = record('tap-water'), p = prompt(r, []);
  assert.match(p, /not word-for-word correspondence/); assert.match(p, /genuinely missing, added or changed factual claim/);
  let calls = 0;
  const model = new Claude({ key: 'FAKE_ONLY', fetchImpl: async (_url, options) => {
    calls++; const body = JSON.parse(options.body); assert.equal('temperature' in body, false);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(verdict(r)) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }));
  } });
  assert.equal((await model.check(r, [])).status, 'pass'); assert.equal(calls, 1);
});

test('workflow 抓取 job 无 token/key/checkout；不监听 edited（skipped 会把红 check 变灰）', async () => {
  const workflow = await fs.readFile('.github/workflows/verify.yml', 'utf8');
  const literalJob = workflow.split('  literal:')[1].split('\n  semantic:')[0];
  assert.match(literalJob, /permissions: \{\}/); assert.doesNotMatch(literalJob, /secrets\.|github\.token|actions\/checkout|GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /\bedited\b(?![：:])/); assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(await fs.readFile('scripts/source.mjs', 'utf8'), /chromiumSandbox: true/);
});


test('真实 git 两张旧基线 PR 无冲突：新 main 重建格式后可合并，第二轮语义直接命中缓存', async t => {
  const { cwd, git, write, commit, base } = await repo(t);
  const r = record('session-b');
  git('checkout', '-b', 'b'); await write('driving.json', doc([r])); const head = commit();
  git('checkout', 'main'); await write('health.json', doc([record('session-a')])); const advanced = commit();
  const pr = { number: 9, base: { ref: 'main', sha: advanced }, head: { sha: head }, author_association: 'OWNER', state: 'open', draft: false };
  const evidence = evidenceFor([r]); evidence.meta = { number: '9', head, base };
  const cache = emptyCache(9); let apiCalls = 0;
  const model = { usage: {}, check: async r => { apiCalls++; return { status: 'pass', issues: [], verdict: verdict(r) }; } };
  await judge(evidence, { cache, model });
  const rerun = await judge(evidence, { cache, model }); assert.equal(rerun.exitCode, 0); assert.equal(apiCalls, 1);
  const proof = Buffer.from(JSON.stringify(proofFor(evidence, 9))); let merges = 0;
  const code = await mergeVerified({ number: 9, head }, {
    main: async () => advanced, pr: async () => pr,
    format: async () => {
      const dir = path.join(cwd, 'latest');
      assert.equal((await prepare({ cwd, base: advanced, head, destination: dir, association: 'OWNER' })).autoEligible, true);
      const files = await readDirectory(dir), info = inspect(files, []); assert.deepEqual(info.errors, []);
      assert.deepEqual(info.records.map(x => x.record.id).sort(), ['original', 'session-a', 'session-b']);
      checkProof(proof, sha256(proof), { number: 9, head, chosen: info.records.filter(x => x.file === 'driving.json') });
    },
    merge: async () => { merges++; }, comment: async () => assert.fail('不该卡旧 main'),
  });
  assert.equal(code, 0); assert.equal(merges, 1); assert.equal(apiCalls, 1);
});


test('语义前 latest-main preflight：已知重复 id/同文件冲突先红，不付钱', async t => {
  const { cwd, git, write, commit, base } = await repo(t), r = record('collision');
  git('checkout', '-b', 'b'); await write('driving.json', doc([r])); const head = commit();
  git('checkout', 'main'); await write('health.json', doc([record('collision')])); const advanced = commit();
  const evidence = evidenceFor([r]); evidence.meta = { base, head, number: '7' };
  const pr = { number: 7, head: { sha: head }, base: { ref: 'main' }, author_association: 'OWNER' };
  await assert.rejects(validateEvidence(evidence, { cwd, pr, currentMain: advanced, directory: path.join(cwd, 'duplicate') }), /重复/);
  await write('driving.json', doc([record('main-drive')])); const conflict = commit();
  await assert.rejects(validateEvidence(evidence, { cwd, pr, currentMain: conflict, directory: path.join(cwd, 'conflict') }), /同一文件/);
});

test('原子 ref 锁等候不丢任务；超时红且不抢锁；只有持有者能释放', async () => {
  const sha = 'a'.repeat(40); let active = 0, maximum = 0, acquisitions = 0, held = null;
  const contend = async n => {
    await acquire({ create: async () => { if (held !== null) throw Object.assign(Error('exists'), { status: 422 }); held = n; }, read: async () => ({ object: { sha } }), wait: () => new Promise(r => setTimeout(r, 1)), log: () => {} });
    maximum = Math.max(maximum, ++active); acquisitions++;
    await new Promise(r => setTimeout(r, 2));
    active--; held = null;
  };
  await Promise.all(Array.from({ length: 9 }, (_, i) => contend(i)));
  assert.equal(acquisitions, 9); assert.equal(maximum, 1);
  let removed = 0;
  await assert.rejects(acquire({ create: async () => { throw Object.assign(Error('exists'), { status: 422 }); }, read: async () => ({ object: { sha } }), now: () => 0, timeout: 0, log: () => {} }), /超时/);
  await assert.rejects(release('b'.repeat(40), { read: async () => ({ object: { sha } }), remove: async () => { removed++; } }), /拒绝删除/);
  assert.equal(removed, 0);
  await release(sha, { read: async () => ({ object: { sha } }), remove: async () => { removed++; } }); assert.equal(removed, 1);
});
