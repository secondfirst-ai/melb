import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspect, selectChanged, gitData } from '../scripts/format.mjs';
import { Sources, literal, normalize, htmlText, publicURL } from '../scripts/source.mjs';
import { Claude, sentences, validateVerdict } from '../scripts/model.mjs';
import { verify, report, mapLimit, main } from '../scripts/verify.mjs';
import { prepare } from '../scripts/prepare-pr.mjs';

export const record = (id = 'sample') => ({ id, question: { en: 'Is tap water safe in Melbourne?', zh: '墨尔本自来水安全吗？' }, answer: { en: 'Tap water is safe. Every drop met the guidelines.', zh: '自来水安全，每一滴都符合指南。' }, aliases: ['Can I drink it?', '能直接喝吗'], tags: ['water'], sources: [{ url: 'https://example.gov.au/water', quote: 'Tap water is safe.' }], checked: '2026-10-22' });
const doc = (records) => ({ dataset: 'test', title: { en: 'Test', zh: '测试' }, updated: '2026-10-22', notes: [], records });
const files = (records) => new Map([['daily-life.json', JSON.stringify(doc(records))]]);
export function verdict(r, kind = 'yes') { return { id: r.id, sentences: sentences(r.answer.en).map((text) => ({ text, verdict: kind, why: 'quote 1' })), translation: { verdict: 'yes', why: 'same meaning' }, answer_en: r.answer.en, answer_zh: r.answer.zh }; }
export const apiResponse = (v) => new Response(JSON.stringify({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
const temporary = async (t) => { const dir = await fs.mkdtemp(path.join(process.cwd(), '.cache/test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
await fs.mkdir('.cache', { recursive: true });

test('格式拦错误；旧五类只查 JSON/id；跨文件不能重复', () => {
  assert.deepEqual(inspect(files([record()]), []).errors, []);
  for (const change of [r => delete r.question.zh, r => r.checked = '2026-02-30', r => r.valid_until = '2026-13-01', r => r.sources[0].url = 'http://x.gov.au', r => delete r.sources[0].quote, r => delete r.tags]) {
    const r = record(); change(r); assert.ok(inspect(files([r]), []).errors.length);
  }
  const f = files([record()]); f.set('other.json', JSON.stringify(doc([record()])));
  assert.match(inspect(f, []).errors.join(' '), /重复/);
  f.set('bad.json', '{'); assert.match(inspect(f, []).errors.join(' '), /JSON/);
  assert.deepEqual(inspect(new Map([['holidays.json', JSON.stringify({ records: [{ id: 'old', date: null }] })]]), []).errors, []);
  assert.equal(inspect(files([{ ...record(), sources: [{ url: 'https://operator.example/water', quote: 'safe' }] }]), []).warnings.length, 1);
});

test('差分按 id：不核移动/重排字段，只核 3 条新题和真正改动', () => {
  const old = record('old'), current = files([old, record('new1'), record('new2'), record('new3')]);
  const base = new Map([['everyday.json', JSON.stringify(doc([old]))]]);
  assert.deepEqual(selectChanged(inspect(current, []).records, base).map(x => x.record.id), ['new1', 'new2', 'new3']);
  const reordered = Object.fromEntries(Object.entries(old).reverse());
  assert.equal(selectChanged([{ file: 'moved.json', record: reordered }], base).length, 0);
  reordered.answer = { ...old.answer, en: 'Different answer.' };
  assert.equal(selectChanged([{ file: 'moved.json', record: reordered }], base).length, 1);
});

test('HTML5 实体、script/style、各种引号和连字符', () => {
  assert.equal(normalize(htmlText('<style>BAD</style><script>BAD</script><p>‘Tap’&nbsp;water &amp; &#x2014; safe &hellip; &ldquo;yes&rdquo;</p>')), `'tap' water & - safe … "yes"`);
  assert.equal(normalize(htmlText('<p>use the <a href="#">Auto-Registration system</a>. Next</p><ul><li>one</li><li>two</li></ul>')), 'use the auto-registration system. next one two');
});

test('一次 url 只抓一次；缓存涵盖同页不同 quote；不存在为不过', async () => {
  let hits = 0;
  const source = new Sources({ checkURL: async () => {}, fetchImpl: async () => { hits++; return new Response(`<p>${'normal text '.repeat(30)}Tap water is safe. Every drop met the guidelines.</p>`); }, browserFactory: async () => { throw Error('browser unavailable'); } });
  const r = record(), p = await source.read(r.sources[0].url, ['Tap water is safe.']);
  assert.equal(await source.read(r.sources[0].url, ['different']), p); assert.equal(hits, 1);
  assert.equal(literal(r, new Map([[r.sources[0].url, p]])).status, 'pass');
  r.sources[0].quote = 'There is a price of $99.';
  assert.equal(literal(r, new Map([[r.sources[0].url, p]])).status, 'fail'); await source.close();
});

test('抓不到/挡页/短页用浏览器，仍抓不到为无法核对；禁止内网重定向', async () => {
  for (const response of [() => new Response('bad', { status: 403 }), () => new Response('short'), () => new Response('Access denied ' + 'bad '.repeat(100))]) {
    let browser = 0;
    const source = new Sources({ checkURL: async () => {}, fetchImpl: async () => response(), browserFactory: async () => { browser++; throw Error('blocked'); } });
    const r = record(), p = await source.read(r.sources[0].url, ['Tap water is safe.']);
    assert.equal(browser, 1); assert.equal(literal(r, new Map([[r.sources[0].url, p]])).status, 'unable'); await source.close();
  }
  await assert.rejects(publicURL('https://127.0.0.1/'), /私有/);
  await assert.rejects(publicURL('https://[::1]/'), /私有/);
  await assert.rejects(publicURL('https://10.0.0.1/'), /私有/);
  let calls = 0;
  const s = new Sources({ checkURL: async (u) => { if (u.includes('127.0.0.1')) throw Error('private'); }, fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/' } }); } });
  await assert.rejects(s.readFetch('https://example.gov.au/'), /private/); assert.equal(calls, 1);
});

test('PDF 用 pdftotext 取字，不拿二进制当 HTML', async () => {
  const text = 'Tap water is safe. ' + 'Every drop met the guidelines. '.repeat(12);
  const stream = `BT /F1 8 Tf 10 780 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const source = new Sources({ checkURL: async () => {}, fetchImpl: async () => new Response(Buffer.from(pdf), { headers: { 'content-type': 'application/pdf' } }) });
  const result = await source.read('https://example.gov.au/water.pdf', ['Tap water is safe.']);
  assert.equal(result.texts.length, 1); assert.ok(result.texts[0].includes('tap water is safe.')); await source.close();
});

test('API：yes/partial/no/中文不同；坏 JSON 重试一次；漏句也拒绝', async () => {
  for (const kind of ['yes', 'partial', 'no']) {
    const r = record(), client = new Claude({ key: 'fake', fetchImpl: async () => apiResponse(verdict(r, kind)) });
    assert.equal((await client.check(r, [])).status, kind === 'yes' ? 'pass' : 'fail');
    assert.equal(client.usage.estimatedUSD, 0.0004);
  }
  const r = record(), v = verdict(r); v.translation.verdict = 'no';
  assert.equal((await new Claude({ key: 'fake', fetchImpl: async () => apiResponse(v) }).check(r, [])).status, 'fail');
  v.sentences.pop(); assert.throws(() => validateVerdict(JSON.stringify(v), r), /缺句子/);
  let calls = 0;
  const recovering = new Claude({ key: 'fake', fetchImpl: async () => apiResponse(++calls === 1 ? 'bad JSON' : verdict(r)) });
  assert.equal((await recovering.check(r, [])).status, 'pass'); assert.equal(calls, 2);
  const bad = new Claude({ key: 'fake', fetchImpl: async () => apiResponse('bad JSON') });
  assert.equal((await bad.check(r, [])).status, 'unable'); assert.equal(bad.usage.requests, 2);
});

test('API 超时重试一次；不回显错误正文/密钥；无 key 不发请求', async () => {
  let calls = 0;
  const client = new Claude({ key: 'FAKE_PRIVATE_KEY', timeout: 10, fetchImpl: async (_url, { signal }) => { calls++; return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); setTimeout(() => reject(Error('unexpected timeout')), 50); }); } });
  const result = await client.check(record(), []);
  assert.equal(result.status, 'unable'); assert.equal(calls, 2); assert.match(result.issues[0].text, /超时/);
  const failure = await new Claude({ key: 'FAKE_PRIVATE_KEY', fetchImpl: async () => new Response('FAKE_PRIVATE_KEY', { status: 401 }) }).check(record(), []);
  assert.ok(!JSON.stringify(failure).includes('FAKE_PRIVATE_KEY'));
  assert.equal((await new Claude({ key: '', fetchImpl: async () => { throw Error('should not run'); } }).check(record(), [])).status, 'unable');
});

test('端到端差分 3 题：错数题字面过、逐句不过；外部模式不调用 API', async (t) => {
  const dir = await temporary(t); await fs.mkdir(path.join(dir, 'data')); await fs.mkdir(path.join(dir, 'base'));
  const old = record('old'), a = record('seed-a'), b = record('seed-b'), c = record('seed-bad'); c.answer.en += ' It costs $99.';
  await fs.writeFile(path.join(dir, 'base/old.json'), JSON.stringify(doc([old])));
  await fs.writeFile(path.join(dir, 'data/new.json'), JSON.stringify(doc([old, a, b, c])));
  let requests = 0, pages = 0;
  const deps = () => ({ sources: new Sources({ checkURL: async () => {}, fetchImpl: async () => { pages++; return new Response(`<p>${'normal reference '.repeat(30)}Tap water is safe. Every drop met the guidelines.</p>`); } }), model: new Claude({ key: 'fake', fetchImpl: async (_url, opts) => {
    requests++; const input = JSON.parse(opts.body), p = input.messages[0].content, data = JSON.parse(p.match(/BEGIN_SOURCE_MATERIAL_[^\n]+\n([^\n]+)\nEND_/)[1]);
    const r = { id: data.id, answer: { en: data.draft_en, zh: data.draft_zh } }, v = verdict(r);
    if (r.id === 'seed-bad') { v.sentences.at(-1).verdict = 'no'; v.sentences.at(-1).why = 'No quote states $99.'; }
    return apiResponse(v);
  } }) });
  const r = await verify({ root: dir, baseDir: 'base' }, deps());
  assert.equal(r.exitCode, 1); assert.equal(r.results.length, 3); assert.equal(requests, 3); assert.equal(pages, 1);
  assert.deepEqual(r.results.map(x => x.status), ['pass', 'pass', 'fail']); assert.ok(r.results.every(x => x.literal === 'pass'));
  assert.match(report(r), /No quote states/);
  requests = 0;
  const external = await verify({ root: dir, baseDir: 'base', literalOnly: true }, deps());
  assert.equal(external.exitCode, 0); assert.equal(requests, 0); assert.match(report(external), /不能自动合并/);
});

test('并发始终不超过四；结果保留输入顺序', async () => {
  let n = 0, max = 0;
  const r = await mapLimit(Array.from({ length: 12 }, (_, i) => i), async i => { max = Math.max(max, ++n); await new Promise(r => setTimeout(r, 5)); n--; return i; });
  assert.equal(max, 4); assert.deepEqual(r, Array.from({ length: 12 }, (_, i) => i));
});

test('PR 安全：只提取普通 JSON blob；代码改动/路径穿越/symlink 不运行 API', async (t) => {
  const cwd = await temporary(t), git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(cwd, 'data')); await fs.writeFile(path.join(cwd, 'data/base.json'), JSON.stringify(doc([record('old')])));
  git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(cwd, 'data/new.json'), JSON.stringify(doc([record('new')]))); git('add', '.'); git('commit', '-m', 'data'); const head = git('rev-parse', 'HEAD');
  const output = path.join(cwd, 'candidate');
  assert.deepEqual(await prepare({ cwd, base, head, destination: output, association: 'NONE' }), { dataOnly: true, trusted: false, reason: '外部 PR：只核格式和字面，不使用 secret，不自动合并。' });
  assert.deepEqual(await fs.readdir(output), ['base.json', 'new.json']);
  assert.equal(gitData(base, cwd).size, 1);
  await fs.writeFile(path.join(cwd, 'danger.sh'), 'exit 99'); git('add', 'danger.sh'); git('commit', '-m', 'code');
  assert.equal((await prepare({ cwd, base, head: git('rev-parse', 'HEAD'), destination: path.join(cwd, 'denied'), association: 'OWNER' })).dataOnly, false);
  // 在干净的 base 上构造只改 data 的 symlink，不执行它指向的内容。
  git('checkout', '-b', 'symlink', base); await fs.symlink('../outside', path.join(cwd, 'data/link.json')); git('add', 'data/link.json'); git('commit', '-m', 'symlink');
  assert.equal((await prepare({ cwd, base, head: git('rev-parse', 'HEAD'), destination: path.join(cwd, 'link-output'), association: 'OWNER' })).dataOnly, false);
});

test('CLI 参数出错退出 2；格式错退出 1 且生成报告', async (t) => {
  const cwd = process.cwd(), dir = await temporary(t); process.chdir(dir);
  try {
    assert.equal(await main(['--wrong']), 2); assert.match(await fs.readFile('verify-report.md', 'utf8'), /脚本出错/);
    await fs.mkdir('data'); await fs.writeFile('data/broken.json', '{');
    assert.equal(await main(['--all']), 1); assert.match(await fs.readFile('verify-report.md', 'utf8'), /JSON 不能解析/);
  } finally { process.chdir(cwd); }
});
