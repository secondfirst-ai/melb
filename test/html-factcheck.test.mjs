import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Sources, normalize, normalizeCase } from '../scripts/source.mjs';
import { claims, tokens, factcheckHTML, checkGuide, formatHTML } from '../scripts/html-factcheck.mjs';
import { main } from '../scripts/factcheck.mjs';

const fixture = name => fs.readFile(new URL('./fixtures/factcheck-html/' + name, import.meta.url), 'utf8');
const captured = Object.fromEntries(await Promise.all(['xero', 'xero-ai', 'xero-reconcile', 'microsoftFAQ', 'microsoftControls', 'gemini', 'digitalSolutions'].map(async name => [name, await fixture(name + '.txt')])));
const excerpts = JSON.parse(await fixture('acceptance-excerpts.json'));
const urls = {
  xero: 'https://www.xero.com/au/pricing-plans/',
  microsoftFAQ: 'https://support.microsoft.com/en-au/microsoft-copilot/privacy-faq-for-microsoft-copilot',
  microsoftControls: 'https://support.microsoft.com/en-au/microsoft-copilot/microsoft-copilot-privacy-controls',
  gemini: 'https://support.google.com/gemini/answer/13594961?hl=en',
  digitalSolutions: 'https://www.melbourneinnovation.com.au/digital-solutions',
};
const guide = (sentence, sources = [urls.xero], tag = 'p') => `<${tag}>${sentence} ${sources.map((_, i) => `<a href="#s${i + 1}">[${i + 1}]</a>`).join(' ')}</${tag}><ol>${sources.map((url, i) => `<li id="s${i + 1}"><a href="${url}">Source</a></li>`).join('')}</ol>`;
function reader(pages) {
  const f = { calls: [], closed: 0, async readHTTP(url, options) {
    f.calls.push([url, options]); const text = pages[url]; if (text instanceof Error || text === undefined) throw text ?? Error('fixture 404');
    return options?.html ? { html: text, via: 'curl' } : { text, via: 'curl' };
  }, async close() { f.closed++; } }; return f;
}
const run = async (sentence, name, text = captured[name], options = {}) => (await factcheckHTML(guide(sentence, [urls[name]]), { sources: reader({ [urls[name]]: text }), ...options }))[0];
const quote = 'advertising, digital safety, security, and compliance purposes';

test('验收1：原指南 $8.00 在三个 Xero 相关正文片段均缺失，18.00 不算 8.00', async () => {
  const html = await fixture('xero-guide-before.html'), row = claims(html).find(r => r.text.includes('$8.00'));
  assert.equal(row.urls.length, 3);
  const pages = { [urls.xero]: captured.xero, 'https://www.xero.com/au/ai-in-accounting/': captured['xero-ai'], 'https://www.xero.com/au/accounting-software/reconcile-bank-transactions/': captured['xero-reconcile'] };
  const [result] = await factcheckHTML(guide(row.text, row.urls), { sources: reader(pages) });
  assert.equal(result.status, '✗'); assert.deepEqual(result.missing, ['$8.00']);
  assert.equal((await run('Price: $8.00', 'xero', 'Price: $18.00')).status, '✗');
});
test('验收2：微软引错 FAQ 为 ✗，换 privacy-controls 为 ✓，for one 不是数量', async () => {
  const sentence = `Microsoft, for one, says opting out doesn’t stop your chats being used for “${quote}”.`;
  assert.equal((await run(sentence, 'microsoftFAQ')).status, '✗');
  assert.equal((await run(sentence, 'microsoftControls')).status, '✓');
});
test('验收3：冻结的 Keep activity 片段对 Keep Activity 报近似', async () => {
  assert.equal((await run('Yes, while “Keep Activity” is on', 'gemini', excerpts.gemini)).status, '近似');
});
test('验收4：A$110 / five 与真实出处 $110 / 5 等价，不按整句硬匹配', async () => {
  const result = await run('Digital Solutions: A$110 for up to five hours of one-on-one mentoring', 'digitalSolutions');
  assert.equal(result.status, '✓'); assert.deepEqual(result.missing, []);
});
test('验收5：直弯引号等价，冻结的原话片段完全匹配', async () => {
  assert.equal((await run(`Microsoft: “${excerpts.microsoftFAQ}”`, 'microsoftFAQ', excerpts.microsoftFAQ)).status, '✓');
  assert.equal((await run(`Microsoft: "${excerpts.microsoftFAQ}"`, 'microsoftFAQ', excerpts.microsoftFAQ)).status, '✓');
});
test('验收6：无数字无引号的表格行只能人看，不抓出处、不硬判 ✓', async () => {
  const sources = reader({}), result = await factcheckHTML(guide('Business and Enterprise: not by default', [urls.xero], 'tr'), { sources });
  assert.equal(result[0].status, '只能人看'); assert.equal(sources.calls.length, 0); assert.equal(sources.closed, 1);
});
test('验收7：404/抓不到是未核，没有 --cdp 绝不启办公室浏览器', async () => {
  const result = await run('Price: $8.00', 'xero', Error('fixture HTTP 404'), { officeFactory() { assert.fail('no CDP'); } });
  assert.equal(result.status, '未核'); assert.match(result.errors[0], /404/);
});
test('本次抓取片段与验收描述的差异也被保留：Google 首字母现已大写，微软句尾现为逗号', async () => {
  assert.equal((await run('Yes, while “Keep Activity” is on', 'gemini')).status, '✓');
  assert.equal((await run(`“${excerpts.microsoftFAQ}”`, 'microsoftFAQ')).status, '近似');
});
test('引用对句而不是整段，表格整行、嵌套元素、实体、文字 [N]，Sources 不被当成待核句', () => {
  const html = `<script><p>Fake $99 <a href="#s1">[1]</a></p></script><p>Uncited $99. Price <strong>A$110</strong>. <a href="#s1">[1]</a> Other 25%. <a href="#s2">[2]</a></p><table><tr><th>Tool [1]</th><td>Settings → Privacy → “Keep activity” &amp; $110</td></tr></table><ol><li id="s1"><a href="https://example.com/a">A</a></li><li id="s2"><a href="https://example.com/b">B</a></li></ol>`;
  const rows = claims(html); assert.equal(rows.length, 3); assert.equal(rows[0].text, 'Price A$110.'); assert.deepEqual(rows[1].refs, ['s2']); assert.match(rows[2].text, /Tool.*Keep activity.*& \$110/); assert.deepEqual(rows[2].refs, ['s1']);
});
test('有效 HTML 的省略结束标签仍保留每个表格行和 Sources 项，嵌套块之间不粘字', () => {
  const html = '<p>Price $110 <a href="#s1">[1]</a><p>Time 5 hours <a href="#s2">[2]</a><table><tr><td><p>$110</p><p>five hours</p><td><a href="#s1">[1]</a><tr><td>20%<td><a href="#s2">[2]</a></table><ol><li id="s1"><a href="https://example.com/a">A</a><li id="s2"><a href="https://example.com/b">B</a></ol>';
  const rows = claims(html); assert.equal(rows.length, 4); assert.deepEqual(rows.map(r => r.refs), [['s1'], ['s2'], ['s1'], ['s2']]); assert.deepEqual(rows.map(r => r.urls), [['https://example.com/a'], ['https://example.com/b'], ['https://example.com/a'], ['https://example.com/b']]); assert.match(rows[2].text, /\$110 five hours/);
});
test('日期三种写法、百分比、整数/英文数词、有数字边界和无引号设置开关', async () => {
  for (const date of ['25 October 2026', '25 Oct 2026', '2026-10-25', '25 Oct']) {
    assert.equal((await run(`${date}: $110, five hours, 20%. Settings → Privacy → Keep activity`, 'xero', 'October 25, 2026. A$110 for 5 hours. 20 percent. Keep activity')).status, '✓', date);
  }
  for (const [claim, source] of [['8', '18'], ['$8.00', '$18.00'], ['8.00', '18.00'], ['5%', '15%'], ['2026-10-25', '2025-10-25']]) assert.equal((await run(claim, 'xero', source)).status, '✗', claim);
  assert.equal(tokens('Settings → Privacy → “Keep activity”').length, 1);
  assert.equal((await run('Settings > Privacy > Keep activity', 'xero', 'Keep activity')).status, '✓');
});
test('标点/大小写近似；词边界不能把 switch 当作 switches，数字不是近似', async () => {
  assert.equal((await run('“Keep activity”', 'xero', 'Keep Activity')).status, '近似');
  assert.equal((await run('“Opt-out is allowed.”', 'xero', 'Opt out is allowed!')).status, '近似');
  assert.equal((await run('“switch”', 'xero', 'switches')).status, '✗');
  assert.equal((await run('“First sentence. Second sentence.”', 'xero', 'First sentence. Second sentence.')).status, '✓');
  assert.equal((await run('You can ask whether they can book one.', 'xero', 'Interpreter service')).status, '只能人看');
  assert.equal((await run('One hour costs $110', 'xero', '1 hour costs $110')).status, '✓');
  assert.equal((await run("The label is 'Don't train'.", 'xero', 'Unrelated source')).status, '✗');
  assert.equal((await run("'You don't have to opt in.'", 'xero', "You don't have to opt in.")).status, '✓');
  assert.equal((await run('‘We respect users’ privacy.’', 'xero', 'We respect users.')).status, '✗');
  assert.equal((await run('‘We respect users’ privacy.’', 'xero', "We respect users' privacy.")).status, '✓');
  assert.equal((await run("'Plans' or '5 hours'", 'xero', 'Plans; 5 hours')).status, '✓');
  assert.equal((await run('“Cost is $8.00”', 'xero', 'Cost is $8,00')).status, '✗');
  assert.equal((await run('“$”', 'xero', 'Unrelated source')).status, '✗');
  assert.equal((await run('Go to Settings → Privacy → Keep activity and turn it off.', 'xero', 'Keep activity')).status, '✓');
  assert.equal((await run('one hundred and five hours', 'xero', '105 hours')).status, '✓');
  assert.equal((await run('105 hours', 'xero', 'one hundred and five hours')).status, '✓');
  assert.equal((await run('“The price is $8.”', 'xero', 'The price is $8.50 per month.')).status, '✗');
  assert.equal((await run('“The price is $8.”', 'xero', 'The price is $8.50 per month. A different product costs $8.')).status, '✗');
  assert.equal((await run('“8 units”', 'xero', '0.8 units; elsewhere 8 items.')).status, '✗');
  assert.equal((await run('“1,000 hours”', 'xero', '1.000 hours')).status, '✗');
  assert.equal((await run('The rate is -5%.', 'xero', 'The rate is 5%.')).status, '✗');
  assert.equal((await run('A$330', 'xero', 'AI for Small Business - $330.00')).status, '✓');
  assert.equal((await run('$330', 'xero', '-$330')).status, '✗');
  assert.equal((await run('Round 3 closes at the end of 2026.', 'xero', 'Round 3 closes on 31 December 2026.')).status, '✓');
  assert.equal((await run("Settings > Privacy > Don't train", 'xero', "Don't train")).status, '✓');
});
test('数字或小写开头的引用句不串用前句出处，月份缩写中的点不拆日期', async () => {
  const html = '<p>Cost is $8. <a href="#s1">[1]</a> 5 hours included. <a href="#s2">[2]</a> twenty minutes. <a href="#s3">[3]</a></p><ol><li id="s1"><a href="https://example.com/a">A</a></li><li id="s2"><a href="https://example.com/b">B</a></li><li id="s3"><a href="https://example.com/c">C</a></li></ol>';
  const rows = await factcheckHTML(html, { sources: reader({ 'https://example.com/a': '$8 and 5 hours', 'https://example.com/b': '$8', 'https://example.com/c': '20 minutes' }) });
  assert.equal(rows.length, 3); assert.deepEqual(rows.map(r => r.status), ['✓', '✗', '✓']); assert.deepEqual(rows.map(r => r.refs), [['s1'], ['s2'], ['s3']]);
  assert.equal((await run('25 Oct. 2026.', 'xero', '2026-10-25')).status, '✓');
  const beforePeriod = html.replace('is $8. <a href="#s1">[1]</a>', 'is $8 <a href="#s1">[1]</a>.').replace('5 hours included. <a href="#s2">[2]</a>', 'five hours included <a href="#s2">[2]</a>.');
  const beforeRows = await factcheckHTML(beforePeriod, { sources: reader({ 'https://example.com/a': '$8 and 5 hours', 'https://example.com/b': '$8', 'https://example.com/c': '20 minutes' }) });
  assert.deepEqual(beforeRows.map(r => r.status), ['✓', '✗', '✓']);
});
test('多出处逐 token 任一命中就够、同 URL 只抓一次；部分打不开且缺 token 为未核', async () => {
  const html = guide('$110 for five hours', [urls.xero, urls.digitalSolutions]);
  const sources = reader({ [urls.xero]: '$110', [urls.digitalSolutions]: '5 hours' });
  const rows = await factcheckHTML(html + html, { sources }); assert(rows.every(row => row.status === '✓')); assert.equal(sources.calls.length, 2); assert.equal(sources.closed, 1);
  const partial = reader({ [urls.xero]: '$110' }); assert.equal((await factcheckHTML(html, { sources: partial }))[0].status, '未核');
  assert.equal((await factcheckHTML(guide('$110', [urls.xero, urls.digitalSolutions]), { sources: reader({ [urls.xero]: '$110' }) }))[0].status, '✓');
});
test('缺失引用或只有非公网来源不得冒充已核；相对地址可由指南 URL 解析', async () => {
  const html = '<p>$8 <a href="#s99">[99]</a></p>';
  const row = (await factcheckHTML(html, { sources: reader({}) }))[0]; assert.equal(row.status, '未核'); assert.deepEqual(row.missingRefs, ['s99']);
  assert.deepEqual(claims(guide('$8', ['/source']), 'https://example.com/guide')[0].urls, ['https://example.com/source']);
  let office = 0;
  const sources = new Sources({ withVia: true, preserveCase: true, fetchImpl() { assert.fail('private URL must not fetch'); } });
  const denied = await factcheckHTML(guide('$8', ['http://127.0.0.1/private']), { sources, officeFactory() { office++; assert.fail(); } });
  assert.equal(denied[0].status, '未核'); assert.equal(office, 0);
});
test('CDP 只在 HTTP 失败后显式使用、保留大小写、共用一个 reader 并清理；缺词不走 CDP', async () => {
  const sources = reader({}), calls = []; let close = 0, made = 0;
  const rows = await factcheckHTML(guide('“Keep Activity”', [urls.xero, urls.gemini]), { sources, cdp: true, env: {}, officeFactory(options) { assert.equal(options.preserveCase, true); made++; return { async read(url) { calls.push(url); return 'Keep activity. ' + 'Public source text. '.repeat(20); }, async close() { close++; } }; } });
  assert.equal(rows[0].status, '近似'); assert.equal(made, 1); assert.equal(close, 1); assert.equal(calls.length, 2);
  assert.equal((await run('$8', 'xero', '$18', { cdp: true, env: {}, officeFactory() { assert.fail(); } })).status, '✗');
  const failure = reader({}); await assert.rejects(factcheckHTML(guide('$8'), { sources: failure, cdp: true, env: { GITHUB_ACTIONS: '1' }, officeFactory() { assert.fail(); } }), /GITHUB_ACTIONS/); assert.equal(failure.calls.length, 0); assert.equal(failure.closed, 1);
});
test('取消和解析失败也清理，空文档不冒充成功', async () => {
  const sources = reader({}), c = new AbortController(); c.abort(Error('stop'));
  await assert.rejects(factcheckHTML(guide('$8'), { sources, signal: c.signal }), /stop/); assert.equal(sources.closed, 1);
  const empty = reader({}); await assert.rejects(factcheckHTML('<p>No citations</p>', { sources: empty }), /没有带 #sN/); assert.equal(empty.closed, 1);
});
test('Sources HTML/保留大小写选项不改变默认归一化，指南逐跳重定向仍走同一公网校验', async () => {
  const calls = [], source = new Sources({ withVia: true, preserveCase: true, checkURL: async url => { calls.push(url); if (url.includes('private')) throw Error('private redirect'); }, fetchImpl: async url => url.endsWith('/redirect') ? new Response(null, { status: 302, headers: { location: '/private' } }) : new Response('<p>Keep Activity. ' + 'Body text. '.repeat(25) + '</p>') });
  assert.match((await source.readHTTP('https://example.com/source')).text, /^Keep Activity/);
  assert.match((await source.readHTTP('https://example.com/source', { html: true })).html, /^<p>/);
  await assert.rejects(source.readHTTP('https://example.com/redirect', { html: true }), /private redirect/); assert.equal(calls.at(-1), 'https://example.com/private'); await source.close();
  assert.equal(normalize('“Keep Activity”'), '"keep activity"'); assert.equal(normalizeCase('“Keep Activity”'), '"Keep Activity"');
});
test('指南重定向后的相对出处必须以最终地址为基准', async () => {
  const calls = [], source = new Sources({ withVia: true, preserveCase: true, checkURL: async () => {}, fetchImpl: async url => {
    calls.push(url);
    if (url === 'https://example.com/old/guide') return new Response(null, { status: 302, headers: { location: '/new/guide' } });
    if (url === 'https://example.com/new/guide') return new Response(guide('$8', ['./source']));
    if (url === 'https://example.com/new/source') return new Response('<p>$8. ' + 'Source content. '.repeat(25) + '</p>');
    assert.fail(url);
  } });
  const [row] = await checkGuide('https://example.com/old/guide', { sources: source }); assert.deepEqual(row.urls, ['https://example.com/new/source']); assert.equal(row.status, '✓'); assert.equal(calls.length, 3);
});
test('HTML 模式 PDF 出处真实经 pdftotext 保留大小写，PDF 不能冒充指南 HTML', async () => {
  const text = 'Keep Activity. ' + 'Public source text. '.repeat(20), stream = `BT /F1 8 Tf 10 780 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const source = () => new Sources({ withVia: true, preserveCase: true, checkURL: async () => {}, fetchImpl: async () => new Response(Buffer.from(pdf), { headers: { 'content-type': 'application/pdf' } }) });
  assert.equal((await factcheckHTML(guide('“Keep activity”'), { sources: source() }))[0].status, '近似');
  await assert.rejects(checkGuide('https://example.com/guide.pdf', { sources: source() }), /不能是 PDF/);
});
test('CLI 默认只报三类，--all 打全部、总数含隐藏行；本地文件/公开URL入口和旧 JSON 参数互不混用', async t => {
  await fs.mkdir('.cache', { recursive: true }); const dir = await fs.mkdtemp(path.resolve('.cache/html-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'guide.html'), html = guide('$8', [urls.xero]) + guide('No numbers', [urls.xero]); await fs.writeFile(file, html);
  let out = ''; const status = await main(['--html', file], { sources: reader({ [urls.xero]: '$18' }), stdout: { write(s) { out += s; } }, stderr: { write() {} } });
  assert.equal(status, 1); assert.match(out, /✗\t/); assert(!out.includes('只能人看\t')); assert.match(out, /汇总：✓ 0 · ✗ 1 · 近似 0 · 只能人看 1 · 未核 0/);
  const url = 'https://example.com/guide', sources = reader({ [url]: html, [urls.xero]: '$8' });
  const rows = await checkGuide(url, { sources }); assert.equal(rows[0].status, '✓'); assert.equal(sources.calls[0][1].html, true); assert.match(formatHTML(rows, true), /只能人看\t/);
  let io = 0; assert.equal(await main(['--html', file, '--cdp'], { env: { GITHUB_ACTIONS: '1' }, sources: { readHTTP() { io++; }, close() {} }, stdout: { write() {} }, stderr: { write() {} } }), 2); assert.equal(io, 0);
  for (const args of [['--all', file], ['--html'], ['--html', file, file]]) assert.equal(await main(args, { stdout: { write() {} }, stderr: { write() {} } }), 2);
});
