import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { usdAmounts, usdMatch, usdLiteralMatch, USD_NOTE } from '../scripts/usd.mjs';
import { literal, normalize } from '../scripts/source.mjs';
import { factcheckHTML, formatHTML } from '../scripts/html-factcheck.mjs';
import { factcheck } from '../scripts/factcheck.mjs';
import { report, verify, judge } from '../scripts/verify.mjs';
import { parseReport } from '../scripts/weekly-issue.mjs';

const url = 'https://example.gov.au/price';
const html = (claim, urls = [url]) => `<p>${claim} ${urls.map((_, i) => `<a href="#s${i + 1}">[${i + 1}]</a>`).join(' ')}</p><ol>${urls.map((u, i) => `<li id="s${i + 1}"><a href="${u}">source</a></li>`).join('')}</ol>`;
const sources = pages => ({ async readHTTP(url) { if (!(url in pages)) throw Error('fixture missing'); return { text: pages[url], via: 'curl' }; }, async close() {} });

test('USD三种位置及无空格、USD$、逗号和.00共用同页美元判断', async () => {
  for (const claim of ['US$349', 'US$ 349', 'USD 349', 'USD349', 'USD$349', 'USD $349', '349 USD', '349USD', '$349 USD', 'US$349.00']) {
    assert.equal(usdAmounts(claim).length, 1, claim); assert.equal(usdAmounts(claim)[0].value, 349);
    assert.equal(usdMatch(349, '*Prices are in USD and exclude taxes. $349 /month'), 'declared');
    const [row] = await factcheckHTML(html('Price ' + claim), { sources: sources({ [url]: '*Prices are in USD and exclude taxes. $349 /month' }) });
    assert.equal(row.status, '✓', claim); assert.equal(row.note, USD_NOTE); assert.match(formatHTML([row]), /USD 写法对上（页上写明 USD）/);
  }
  assert.equal(usdMatch(1349, 'Prices in US dollars. $1,349.00'), 'declared');
  assert.equal(usdMatch(-349, 'Prices in US$. -$349'), 'declared');
  assert.equal(usdMatch(349, 'Prices in USD. -$349'), 'missing');
});

test('没USD、USDC/词内标记、金额不符和明确AUD金额都不能当美元', async () => {
  for (const text of ['$349 /month', 'USDC $349', 'USDT $349', 'notUSD $349', 'us dollarsToken $349', 'USD $1349', 'USD $349.50', 'USD A$349', 'USD AU$349', 'USD AUD $349', 'Prices in USD. Price $349 AUD']) {
    assert.equal(usdMatch(349, text), 'missing', text);
    assert.equal((await factcheckHTML(html('Price US$349'), { sources: sources({ [url]: text }) }))[0].status, '✗', text);
  }
  for (const marker of ['USD', 'usd', 'US$', 'US dollars', 'us DOLLAR']) assert.equal(usdMatch(349, marker + ' prices: $349'), 'declared');
});

test('同题多出处也不能跨页借USD声明；澳元旧行为不改', async () => {
  const other = 'https://example.gov.au/other';
  const [row] = await factcheckHTML(html('Price US$349', [url, other]), { sources: sources({ [url]: 'Prices in USD, no amount', [other]: '$349' }) });
  assert.equal(row.status, '✗');
  for (const claim of ['A$349', 'AU$349', 'AUD 349', '$349']) assert.equal((await factcheckHTML(html(claim), { sources: sources({ [url]: '$349.00' }) }))[0].status, '✓');
  assert.equal((await factcheckHTML(html('A$349'), { sources: sources({ [url]: 'US$349' }) }))[0].status, '✗');
});

test('字面路径只换USD金额，其他文字不放宽；多价格不乱改、金额边界不串用', async () => {
  for (const claim of ['US$349', 'USD349', 'USD$349', '349USD']) {
    const record = { sources: [{ url, quote: 'Price ' + claim + ' /month.' }] };
    const page = { texts: [normalize('Price $349 /month. Prices are in USD.')], errors: [] };
    const checked = literal(record, new Map([[url, page]])); assert.equal(checked.status, 'pass'); assert.match(checked.notes[0], /USD 写法对上/);
    page.texts = [normalize('Price $349 /month.')]; assert.equal(literal(record, new Map([[url, page]])).status, 'fail');
  }
  assert.equal(usdLiteralMatch('Price US$349 and $20.', 'Prices in USD. Price $349 and $20.'), true);
  assert.equal(usdLiteralMatch('Price US$349 and $349.', 'Prices in USD. Price $349 and $349.'), true);
  assert.equal(usdLiteralMatch('Price US$349 /month', 'USD. Price $3490 /month. Other $349'), false);
  assert.equal(usdLiteralMatch('Price US$349 per year', 'USD. Price $349 per month'), false);
  assert.equal(usdLiteralMatch('Price US$349.00.', 'USD. Price $349.'), true);
  const rows = await factcheck([{ url, quote: 'Price US$349 /month.' }], { sources: { async read() { return { documents: [{ text: normalize('Price $349 /month. USD.'), via: 'curl' }], errors: [] }; }, async close() {} } });
  assert.equal(rows[0].status, 'found'); assert.equal(rows[0].note, USD_NOTE);
});

test('美元原话引号和literal-only报告都保留说明，不误报每周报告不完整', async () => {
  const [quoted] = await factcheckHTML(html('“Price US$349 /month.”'), { sources: sources({ [url]: 'Price $349 /month. USD.' }) });
  assert.equal(quoted.status, '✓'); assert.equal(quoted.note, USD_NOTE);
  const md = report({ scope: '全部问答', literalOnly: true, errors: [], warnings: [], legacyFiles: 0, legacyRecords: 0, total: 1, results: [{ id: 'price', literal: 'pass', semantic: 'skipped', status: 'pass', issues: [], notes: [USD_NOTE], quotes: [] }], usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 } });
  assert.match(md, /USD 写法对上/); assert.equal(parseReport(md, 'success').failed, false);
});

test('verify --literal-only整条管线保留USD说明，不构造或调用模型', async t => {
  await fs.mkdir('.cache', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.cache/usd-')); t.after(() => fs.rm(root, { recursive: true })); await fs.mkdir(path.join(root, 'data'));
  const record = { id: 'usd-price', question: { en: 'How much does it cost?', zh: '价格多少？' }, answer: { en: 'It costs US$349.', zh: '价格US$349。' }, aliases: ['What is the price?'], tags: ['price'], sources: [{ url, quote: 'Price is US$349.' }], checked: '2026-10-28' };
  await fs.writeFile(path.join(root, 'data/daily-life.json'), JSON.stringify({ dataset: 'test', title: { en: 'Test', zh: '测试' }, updated: '2026-10-28', notes: [], records: [record] }));
  const result = await verify({ root, literalOnly: true }, { sources: { async read() { return { texts: [normalize('Price is $349. Prices in USD.')], errors: [] }; }, async close() {} }, model: { check() { assert.fail('must not call model'); } } });
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors)); assert.match(result.results[0].notes[0], /USD 写法对上/); assert.match(report(result), /USD 写法对上/); assert.equal(result.usage.requests, 0);
  const long = normalize('Unrelated opening. '.repeat(250) + 'Price is $349. ' + 'Unrelated middle. '.repeat(400) + 'Prices are in USD and exclude taxes.');
  const evidence = await verify({ root, literalOnly: true }, { sources: { async read() { return { texts: [long], errors: [] }; }, async close() {} } });
  const text = evidence.items[0].excerpts[0].text; assert.match(text, /349/); assert.match(text, /prices are in usd/); assert.ok(text.length < 6000);
  let called = 0;
  await judge(evidence, { model: { usage: { requests: 0, input: 0, output: 0, estimatedUSD: 0 }, async check(_record, excerpts) { called++; assert.match(excerpts[0].text, /349/); assert.match(excerpts[0].text, /prices are in usd/); return { status: 'pass', issues: [] }; } } });
  assert.equal(called, 1);
  const [json] = await factcheck([{ url, quote: 'Price is US$349.' }], { sources: { async read() { return { documents: [{ text: long, via: 'curl' }], errors: [] }; }, async close() {} } });
  assert.equal(json.status, 'found'); assert.match(json.excerpt, /349/); assert.match(json.excerpt, /prices are in usd/);
});
