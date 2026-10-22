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

test('临合并允许 main 前进，只重跑格式；改 base/head/草稿/作者拦住', async () => {
  const head = 'b'.repeat(40), base = 'a'.repeat(40), advanced = 'c'.repeat(40);
  const pr = { base: { ref: 'main', sha: base }, head: { sha: head }, author_association: 'MEMBER', state: 'open', draft: false };
  for (const change of [{ base: { ref: 'other' } }, { head: { sha: advanced } }, { draft: true }, { author_association: 'NONE' }]) {
    let merged = false, commented = false;
    assert.equal(await mergeVerified({ head, number: 7 }, { main: async () => base, pr: async () => ({ ...pr, ...change }), format: async () => {}, merge: async () => { merged = true; }, comment: async () => { commented = true; } }), 1);
    assert.equal(merged, false); assert.equal(commented, true);
  }
  let n = 0, formats = 0, merged = 0;
  assert.equal(await mergeVerified({ head, number: 7 }, { main: async () => ++n === 1 ? base : advanced, pr: async () => pr, format: async () => { formats++; }, merge: async () => { merged++; }, comment: async () => assert.fail('不该卡住落后分支') }), 0);
  assert.equal(formats, 2); assert.equal(merged, 1);
  let calls = 0;
  assert.equal(await mergeVerified({ head, number: 7 }, { main: async () => base, pr: async () => pr, format: async () => { throw Error('id 重复'); }, merge: async () => { calls++; }, comment: async s => assert.match(s, /id 重复/) }), 1);
  assert.equal(calls, 0);
});

test('错误 JSON 的 parse 错误也不会把 API key 带进报告', async () => {
  const key = 'FAKE_DO_NOT_LOG';
  const client = new Claude({ key, fetchImpl: async () => new Response(key, { headers: { 'content-type': 'application/json' } }) });
  const result = await client.check({ id: 'test', answer: { en: 'A sentence.', zh: '一句话。' } }, []);
  assert.equal(result.status, 'unable'); assert.ok(!JSON.stringify(result).includes(key));
});
