import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Claude, sentences } from '../scripts/model.mjs';
import { Sources } from '../scripts/source.mjs';
import { verify, report } from '../scripts/verify.mjs';
import { browserProxy } from '../scripts/network.mjs';

test('本地浏览器代理拒绝 loopback/metadata CONNECT 和普通 HTTP', async (t) => {
  let proxy;
  try { proxy = await browserProxy(); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip(`沙箱不准起代理：${e.code}`); return; } throw e; }
  try {
    for (const authority of ['127.0.0.1:443', '169.254.169.254:443', '[::1]:443', 'example.com:80']) {
      const code = await new Promise((resolve, reject) => {
        const req = http.request(proxy.server, { method: 'CONNECT', path: authority, agent: false });
        req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.once('response', res => { res.resume(); resolve(res.statusCode); });
        req.once('error', reject); req.setTimeout(2000, () => req.destroy(Error('proxy test timeout'))); req.end();
      });
      assert.equal(code, 403);
    }
    const response = await fetch(proxy.server);
    assert.equal(response.status, 403); await response.body.cancel();
  } finally { await proxy.close(); }
});

test('本地 HTTP 假 Anthropic：yes/partial/no、坏 JSON、超时；实际三题 fixture 差分', async (t) => {
  let mode = 'yes', calls = 0, pages = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      pages++;
      const existing = JSON.parse(await fs.readFile('data/everyday.json', 'utf8')).records[0];
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><body><script>ignore me</script><p>${'Reference text. '.repeat(30)}${existing.sources.map(s => s.quote).join(' ')}</p></body></html>`);
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    assert.equal(req.url, '/v1/messages'); assert.equal(input.model, 'claude-sonnet-5-5'); assert.equal(req.headers['x-api-key'], 'FAKE_ONLY');
    if (mode === 'timeout') { setTimeout(() => res.end('{}'), 250); return; }
    const data = JSON.parse(input.messages[0].content.match(/BEGIN_SOURCE_MATERIAL_[^\n]+\n([^\n]+)\nEND_/)[1]);
    const list = sentences(data.draft_en).map(text => ({ text, verdict: mode === 'fixture' ? (text.includes('A$0.01') ? 'no' : 'yes') : mode, why: text.includes('A$0.01') ? 'No quote gives this price.' : 'quote 1 supports the sentence' }));
    const answer = { id: data.id, sentences: list, answer_en: data.draft_en, answer_zh: data.draft_zh, translation: { verdict: 'yes', why: 'same meaning' } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: mode === 'bad' ? 'bad JSON' : JSON.stringify(answer) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) { t.skip(`沙箱不准起本地 HTTP：${e.code}`); return; }
    throw e;
  }
  const base = `http://127.0.0.1:${server.address().port}`, previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = base;
  console.log(`假服务 PID ${process.pid}，${base}；本进程 finally 关闭`);
  try {
    const r = { id: 'http-test', answer: { en: 'This is supported.', zh: '原文支持。' } };
    for (mode of ['yes', 'partial', 'no', 'bad', 'timeout']) {
      calls = 0;
      const client = new Claude({ key: 'FAKE_ONLY', timeout: mode === 'timeout' ? 40 : 2000 });
      const result = await client.check(r, [{ url: 'https://example.gov.au', quote: 'This is supported.', text: 'This is supported.' }]);
      assert.equal(result.status, mode === 'yes' ? 'pass' : ['partial', 'no'].includes(mode) ? 'fail' : 'unable');
      assert.equal(calls, ['bad', 'timeout'].includes(mode) ? 2 : 1);
      console.log(`HTTP ${mode} → ${result.status}（${calls} 次请求）`);
    }
    // 只供本地测试：保留官方 URL 作数据，用本地假页面响应；生产无这个重写入口。
    mode = 'fixture'; calls = 0; pages = 0;
    await fs.mkdir('.cache', { recursive: true });
    const fixture = await fs.mkdtemp(path.resolve('.cache/http-'));
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    await fs.cp('data', path.join(fixture, 'base'), { recursive: true });
    await fs.cp('data', path.join(fixture, 'head'), { recursive: true });
    await fs.copyFile('test/fixtures/seed-fixture.json', path.join(fixture, 'head/seed-fixture.json'));
    const result = await verify({ dataDir: path.join(fixture, 'head'), baseDir: path.join(fixture, 'base') }, { model: new Claude({ key: 'FAKE_ONLY' }), sources: new Sources({ checkURL: async () => {}, fetchImpl: (_url, opts) => fetch(`${base}/page`, opts) }) });
    assert.equal(result.exitCode, 1); assert.equal(result.results.length, 3); assert.equal(pages, 1); assert.equal(calls, 3);
    assert.deepEqual(result.results.map(r => r.literal), ['pass', 'pass', 'pass']);
    assert.deepEqual(result.results.map(r => r.status), ['pass', 'pass', 'fail']);
    await fs.writeFile('.cache/http-fixture-report.md', report(result));
    console.log('fixture：只核 3 条；页面抓 1 次；逐句 3 次；过/过/不过，错数题字面过。');
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
