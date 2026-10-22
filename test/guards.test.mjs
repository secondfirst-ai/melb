import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { connectTarget, pinnedFetch } from '../scripts/network.mjs';
import { mergeVerified } from '../scripts/merge-pr.mjs';
import { prepare } from '../scripts/prepare-pr.mjs';
import { Claude } from '../scripts/model.mjs';

test('浏览器代理对每个 CONNECT 限公网 HTTPS，IPv4/IPv6/非443/带凭据都拦', async () => {
  for (const authority of ['127.0.0.1:443', '169.254.169.254:443', '10.0.0.1:443', '[::1]:443', 'localhost:443', 'host.example:80', 'host.example:8443', 'user:pw@host.example:443']) await assert.rejects(connectTarget(authority));
  const result = await connectTarget('example.gov.au:443', async (u) => {
    assert.equal(u, 'https://example.gov.au:443/');
    return { addresses: [{ address: '1.1.1.1', family: 4 }] };
  });
  assert.equal(result.address, '1.1.1.1');
});

test('HTTPS 固定已验 IP；客户端不会再把域名解析成内网，保留原 hostname/TLS 校验', async () => {
  let options;
  const request = (url, opts, callback) => {
    assert.equal(url.hostname, 'rebind.example'); options = opts;
    const req = new EventEmitter();
    req.end = () => {
      const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': 'text/html' };
      callback(res); res.end('safe response');
    };
    return req;
  };
  const r = await pinnedFetch('https://rebind.example/', { headers: {}, signal: AbortSignal.timeout(1000) }, { addresses: [{ address: '1.1.1.1', family: 4 }] }, request);
  assert.equal(await r.text(), 'safe response');
  assert.equal(options.agent, false); assert.notEqual(options.rejectUnauthorized, false);
  options.lookup('rebind.example', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
  options.lookup('rebind.example', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); });
});

test('临合并核 main/base/head/作者/草稿；main 前进、改 base、改 head 都不调 gh', async () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40), advanced = 'c'.repeat(40);
  const pr = { base: { ref: 'main', sha: base }, head: { sha: head }, author_association: 'MEMBER', state: 'open', draft: false };
  for (const changes of [{ main: advanced }, { pr: { ...pr, base: { ref: 'other', sha: base } } }, { pr: { ...pr, head: { sha: advanced } } }, { pr: { ...pr, draft: true } }, { pr: { ...pr, author_association: 'NONE' } }]) {
    let calls = 0, comment;
    const result = await mergeVerified({ base, head, number: 7 }, { main: async () => changes.main ?? base, pr: async () => changes.pr ?? pr, merge: async () => { calls++; }, comment: async (s) => { comment = s; } });
    assert.equal(result, 1); assert.equal(calls, 0); assert.match(comment, /未合并/); assert.match(comment, /同步 main 并重新核对/);
  }
  let calls = 0;
  assert.equal(await mergeVerified({ base, head, number: 7 }, { main: async () => base, pr: async () => pr, merge: async (number, sha) => { assert.equal(number, 7); assert.equal(sha, head); calls++; }, comment: async () => { throw Error('should not comment'); } }), 0);
  assert.equal(calls, 1);
});

test('PR 分支落后事件 base 时不提取数据，不把 main 已有新 id 漏掉', async (t) => {
  await fs.mkdir('.cache', { recursive: true }); const cwd = await fs.mkdtemp(path.resolve('.cache/ancestry-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(cwd, 'data')); await fs.writeFile(path.join(cwd, 'data/base.json'), '{}'); git('add', '.'); git('commit', '-m', 'base'); const original = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'pr-b'); await fs.writeFile(path.join(cwd, 'data/b.json'), '{"records":[{"id":"same"}]}'); git('add', '.'); git('commit', '-m', 'b'); const head = git('rev-parse', 'HEAD');
  git('checkout', 'main'); await fs.writeFile(path.join(cwd, 'data/a.json'), '{"records":[{"id":"same"}]}'); git('add', '.'); git('commit', '-m', 'a'); const current = git('rev-parse', 'HEAD');
  assert.notEqual(current, original);
  const result = await prepare({ cwd, base: current, head, destination: path.join(cwd, 'candidate'), association: 'OWNER' });
  assert.equal(result.dataOnly, false); assert.match(result.reason, /同步 main/); await assert.rejects(fs.stat(path.join(cwd, 'candidate')));
});

test('错误 JSON 的 parse 错误也不会把 API key 带进报告', async () => {
  const key = 'FAKE_DO_NOT_LOG';
  const client = new Claude({ key, fetchImpl: async () => new Response(key, { headers: { 'content-type': 'application/json' } }) });
  const result = await client.check({ id: 'test', answer: { en: 'A sentence.', zh: '一句话。' } }, []);
  assert.equal(result.status, 'unable'); assert.ok(!JSON.stringify(result).includes(key));
});
