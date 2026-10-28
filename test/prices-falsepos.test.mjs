import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { factcheckHTML, formatHTML } from '../scripts/html-factcheck.mjs';
import { OfficeReader } from '../scripts/office-cdp.mjs';
import { main } from '../scripts/factcheck.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/factcheck-html/prices-2026-10-28.json', import.meta.url), 'utf8'));
const filler = 'Synthetic fixture body. '.repeat(20);
const guide = (text, url) => `<table><tr><td>${text} <a href="#s1">[1]</a></td></tr></table><ol><li id="s1"><a href="${url}">Source</a></li></ol>`;
const run = async (text, source, url = 'https://example.com/pricing') => (await factcheckHTML(guide(text, url), { sources: { async readHTTP() { return { text: source, via: 'curl' }; }, async close() {} } }))[0];

test('价格页强制CDP，不拿HTTP导航下结论；渲染后核价格，真改错仍✗', async () => {
  for (const [url, claim, rendered, wrong] of [
    ['https://chatgpt.com/pricing', 'ChatGPT Plus | A$30 / month', 'ChatGPT Plus A$30 per month', 'A$31'],
    ['https://claude.com/pricing', fixture.claudeClaim, 'Claude Pro A$28 annually, A$340 up front or A$34 monthly', 'A$35'],
  ]) {
    for (const bad of [false, true]) {
      let reads = 0, closed = 0, sourceClosed = 0;
      const [row] = await factcheckHTML(guide(bad ? claim.replace(/A\$\d+/, wrong) : claim, url), {
        cdp: true, env: {}, sources: { readHTTP() { assert.fail('不能先读HTTP导航'); }, async close() { sourceClosed++; } },
        officeFactory() { return { async read(actual) { reads++; assert.equal(actual, url); return rendered + filler; }, async close() { closed++; } }; },
      });
      assert.equal(row.status, bad ? '✗' : '✓'); assert.equal(reads, 1); assert.equal(closed, 1); assert.equal(sourceClosed, 1);
    }
  }
});

test('导航未出金额、等待超时、没给--cdp均未核；其他域名不强制浏览器', async () => {
  for (const url of ['https://chatgpt.com/pricing', 'https://www.claude.com/pricing']) {
    for (const mode of ['navigation', 'timeout', 'no-cdp']) {
      let closed = 0;
      const [row] = await factcheckHTML(guide('A$30', url), { cdp: mode !== 'no-cdp', env: {},
        sources: { readHTTP() { assert.fail(); }, async close() {} },
        officeFactory() { assert.notEqual(mode, 'no-cdp'); return { async read() { if (mode === 'timeout') throw Error('等待金额渲染超时'); return fixture.chatgptNavigation; }, async close() { closed++; } }; },
      });
      assert.equal(row.status, '未核'); assert.match(row.errors[0], /金额|cdp/i); assert.equal(closed, mode === 'no-cdp' ? 0 : 1);
    }
  }
  const [row] = await factcheckHTML(guide('A$30', 'https://chatgpt.com.evil.test/pricing'), { cdp: true, env: {},
    sources: { async readHTTP() { return { text: 'A$30', via: 'curl' }; }, async close() {} }, officeFactory() { assert.fail(); },
  });
  assert.equal(row.status, '✓');
});

test('括号内核对日期和站内Guide编号不当缺字；真实日期、原话和错价不放过', async () => {
  const source = 'Microsoft 365. New app from 18 Aug 2026. Training on conversation activity.';
  assert.equal((await run(fixture.copilotClaim, source)).status, '✓');
  assert.equal((await run(fixture.copilotClaim, source.replace('2026', '2025'))).status, '✗');
  for (const text of ['A$99 (checked 25 October 2026)', 'A$99 ( checked 25 October 2026 )', 'A$99 (25 Oct 2026)', 'A$99（checked on 25 October 2026）', 'A$99; details in Guide № 06', 'A$99; Guide No. 06', 'A$99; Guide #06']) {
    assert.equal((await run(text, 'A$99')).status, '✓', text);
    assert.equal((await run(text.replace('99', '98'), 'A$99')).status, '✗', text);
  }
  assert.equal((await run(fixture.guideClaim, 'No numeric claim')).status, '只能人看');
  for (const claim of ['A$99 launched 25 October 2026', 'A$99 (from 25 Oct 2026)', 'A$99 (5 users)', 'A$99 (checked 29 Feb 2026)', '“Guide № 06”', '“Released (25 Oct 2026)”']) {
    assert.equal((await run(claim, 'A$99')).status, '✗', claim);
  }
});

test('Giday 50c对元两方向等价；¢按最新Sc规则人工看，真错价仍✗', async () => {
  const source = fixture.gidayIntroduction + ' Synthetic rate fixture from Jian’s case: 50c per minute.';
  assert.equal((await run(fixture.gidayClaim, source, 'https://giday.com.au/pricing/')).status, '✓');
  assert.equal((await run(fixture.gidayClaim.replace('A$0.50', 'A$0.60'), source, 'https://giday.com.au/pricing/')).status, '✗');
  for (const [claim, text] of [['A$0.50', '50c'], ['50c', 'A$0.50']]) assert.equal((await run(claim, text)).status, '✓');
  for (const [claim, text] of [['A$0.50', '50¢'], ['125¢', 'A$1.25']]) assert.equal((await run(claim, text)).status, '只能人看');
  for (const [claim, text] of [['A$0.60', '50c'], ['50c', 'A$50'], ['50c', 'A$0.60'], ['A$0.50', '50cats']]) assert.equal((await run(claim, text)).status, '✗');
});

test('退回：外币分单位不换AUD，只看同一句，前后币种和小数点都守住', async () => {
  for (const text of ['50c USD', '50c NZD', 'USD 50c', 'NZD 50¢', '50c US$', 'US$ 50c', '50c €', '€ 50c', 'USD 0.50 or 50c', '50c or 0.50 USD', '50c TRY', 'TRY 50c', '50c incl. USD taxes', '50c, incl. USD taxes', '50c e.g. USD taxes', '50c excl. US$ taxes']) {
    assert.equal((await run('A$0.50', text)).status, '只能人看', text);
  }
  for (const text of ['50c AUD', '50c. USD 20.', 'NZD 20. 50c', '50c。NZD 20']) assert.equal((await run('A$0.50', text)).status, '✓', text);
  assert.equal((await run('A$0.60', '50c')).status, '✗');
});

test('退回：金额加ISO外币代码阻止.com.au裸$猜AUD，仍保留普通英文和显式AUD/USD', async () => {
  const url = 'https://example.com.au/pricing';
  for (const code of ['TRY', 'ALL', 'TOP', 'MAD', 'CUP', 'GEL', 'BAM', 'BOB', 'COP', 'SOS', 'SHP', 'USD', 'NZD', 'EUR', 'JPY', 'ILS']) {
    for (const text of [`$99per month. 99 ${code}`, `$99per month. ${code} 99`, `$99per month. ${code}99`, `$99per month. 99${code}`]) assert.equal((await run('A$99', text, url)).status, '只能人看', text);
  }
  assert.equal((await run('A$99', 'TRY now. ALL plans from $99per month', url)).status, '✓');
  assert.equal((await run('A$99', 'A$99 per month. 99 TRY', url)).status, '✓');
  assert.equal((await run('US$99', '$99 per month. 99 USD', url)).status, '✓');
  assert.equal((await run('A$98', '$99per month', url)).status, '✗');
});

test('AIVOX .com.au裸$99per可对A$99，错价/其他币种/非澳域名不放过', async () => {
  const url = 'https://aivox.com.au/pricing';
  assert.equal((await run(fixture.aivoxClaim, fixture.aivoxExcerpt, url)).status, '✓');
  assert.equal((await run(fixture.aivoxClaim.replace('A$99', 'A$98'), fixture.aivoxExcerpt, url)).status, '✗');
  for (const text of ['$99per month', '$99.00per month', '$99 per month']) assert.equal((await run('A$99', text, url)).status, '✓', text);
  for (const text of ['$99per month USD', '$99 per month, US dollars', '$99per month NZD', 'CAD $99 per month', '$99 per month EUR']) assert.equal((await run('A$99', text, url)).status, '只能人看', text);
  for (const text of ['$99per month ILS', '$99 per month. Currency: TRY']) assert.equal((await run('A$99', text, url)).status, '只能人看', text);
  assert.equal((await run('A$99', 'TRY now. ALL plans from $99per month', url)).status, '✓');
  for (const text of ['$99per month USD', '$99 per month USD']) assert.equal((await run('US$99', text, url)).status, '✓', text);
  assert.equal((await run('A$99', 'A$99 per month. USD also available', url)).status, '✓');
  assert.equal((await run('A$99', '$99 AUD. USD also available', url)).status, '✓');
  for (const text of ['USD $48 AUD', 'USD $48.00 AUD', '$48 USD AUD']) assert.equal((await run('A$48', text, url)).status, '✗', text);
  assert.equal((await run('US$99', '$99 NZD. USD also available', url)).status, '只能人看');
  for (const host of ['aivox.com', 'aivox.com.au.evil.test']) assert.equal((await run('A$99', '$99per month', `https://${host}/pricing`)).status, '✗');
  assert.equal((await run('A$99', '$99.50per month', url)).status, '✗');
});

test('10-30退回：Wen两份probe所有反例归只能人看，不用价格错的✗代替', async () => {
  for (const [claim, text] of [
    ['“Plan US$99 per month”', 'Plan $99 per month. USD 99. 99 TRY.'],
    ['A$99', '$99per month. 99 try'], ['A$0.50', '50c (U.S. dollars)'], ['A$99', '$99per month. 99 TRY'],
    ['A$0.50', '50c ₩'], ['A$0.50', '50c U.S. dollars'], ['A$99', '$99per month. ₩99'],
    ['A$0.50', '50c USD'], ['A$0.50', '50c NZD'],
  ]) {
    const row = await run(claim, text, 'https://example.com.au/pricing');
    assert.equal(row.status, '只能人看', text);
    assert.match(row.note, /币种不明确/);
    assert.match(formatHTML([row]), /只能人看/);
  }
});

test('通用非澳元：Sc全部符号、ISO大小写和国别dollars，不再按币种名补例外', async () => {
  const symbols = [];
  for (let point = 0; point <= 0x10ffff; point++) {
    const symbol = String.fromCodePoint(point);
    if (/\p{Sc}/u.test(symbol) && symbol !== '$') symbols.push(symbol);
  }
  assert(symbols.includes('₩') && symbols.includes('€') && symbols.includes('₹'));
  for (const symbol of symbols) {
    assert.equal((await run('A$0.50', `50c ${symbol}`)).status, '只能人看', symbol);
    assert.equal((await run('A$99', `$99per month. ${symbol}99`, 'https://example.com.au/price')).status, '只能人看', symbol);
  }
  assert.equal((await run('A$0.50', '50c (¢)')).status, '只能人看');
  for (const code of ['try', 'TrY', 'usd', 'nzd', 'cad', 'sgd', 'hkd', 'jpy', 'eur']) for (const text of [`99 ${code}`, `${code}99`, `99${code}`]) {
    assert.equal((await run('A$99', `$99per month. ${text}`, 'https://example.com.au/price')).status, '只能人看', text);
  }
  for (const name of ['U.S.', 'US', 'NZ', 'Canadian', 'canadian', 'Singapore', 'HK', 'Hong Kong', 'New Zealand', 'American', 'Taiwanese']) {
    assert.equal((await run('A$0.50', `50c ${name} dollars`)).status, '只能人看', name);
    assert.equal((await run('A$99', `$99per month. ${name} dollars`, 'https://example.com.au/price')).status, '只能人看', name);
  }
  for (const text of ['50c U.S. dollars', 'U.S. dollars: 50c', '50c incl. U.S. dollars', '50c (u.s. dollars)']) assert.equal((await run('A$0.50', text)).status, '只能人看', text);
});

test('独审：ISO代码在金额前也认粘连单位，不截断小数或把普通单词当币种', async () => {
  for (const code of ['NZD', 'CAD', 'nzd', 'try', 'TrY']) for (const price of ['99per month', '$99per month', '$99.50per month']) {
    const text = `${code} ${price}`;
    assert.equal((await run('A$99', `$99per month. ${text}`, 'https://example.com.au/price')).status, '只能人看', text);
    assert.equal((await run('A$0.50', `50c ${text}`)).status, '只能人看', text);
  }
  assert.equal((await run('A$99', 'NZD99per month. $99per month', 'https://example.com.au/price')).status, '只能人看');
  assert.equal((await run('A$99.50', '$99.50per month', 'https://example.com.au/price')).status, '✓');
  assert.equal((await run('A$99', '$99.50per month', 'https://example.com.au/price')).status, '✗');
  assert.equal((await run('A$0.50', '50c. TRY now for all users.')).status, '✓');
});

test('独审：非澳域名同句混币的USD引文不借裸$确认，明确USD原文及不同句仍可核', async () => {
  for (const url of ['https://example.com/pricing', 'https://example.com.au/pricing']) {
    for (const foreign of ['99 TRY', '₩99', 'nzd99per month', 'U.S. dollars, Canadian dollars']) {
      const text = `Plan $99 per month, USD 99, ${foreign}.`;
      assert.equal((await run('“Plan US$99 per month”', text, url)).status, '只能人看', text);
      assert.equal((await run('“Plan US$99 per month”', text.replace('$99', 'US$99'), url)).status, '✓', text);
      assert.equal((await run('“Plan USD 99 per month”', text.replace('$99', 'USD 99'), url)).status, '✓', text);
    }
  }
  assert.equal((await run('“Plan US$99 per month”', 'Plan $99 per month, USD 99. 99 TRY.', 'https://example.com/pricing')).status, '✓');
  assert.equal((await run('“Plan US$98 per month”', 'Plan $99 per month, USD 99.', 'https://example.com/pricing')).status, '✗');
});

test('通用判定仍保留明确AUD、裸cent及真错价格，多来源有明确证据可确认', async () => {
  for (const text of ['50c', '50c AUD', '50c Australian dollars', '50c. USD 20.']) assert.equal((await run('A$0.50', text)).status, '✓', text);
  for (const text of ['$99per month', '$99per month. Australian dollars', '$99per month. 99 AUD', '$99per month. 99 aud', '$99per month. TRY now, ALL plans']) assert.equal((await run('A$99', text, 'https://example.com.au/price')).status, '✓', text);
  assert.equal((await run('A$99', 'A$99 per month. ₩99', 'https://example.com.au/price')).status, '✓');
  assert.equal((await run('A$98', 'A$99 per month. ₩99', 'https://example.com.au/price')).status, '✗');
  assert.equal((await run('A$0.60', '50c')).status, '✗');
  assert.equal((await run('A$98', '$99per month', 'https://example.com.au/price')).status, '✗');
  assert.equal((await run('US$99', '$99 per month. 99 NZD', 'https://example.com.au/price')).status, '只能人看');
  const html = '<table><tr><td>A$99 <a href="#s1">[1]</a><a href="#s2">[2]</a></td></tr></table><ol><li id="s1"><a href="https://example.com.au/a">One</a></li><li id="s2"><a href="https://example.com.au/b">Two</a></li></ol>';
  const [row] = await factcheckHTML(html, { sources: { async readHTTP(url) { return { text: url.endsWith('/a') ? '$99per month. ₩99' : 'A$99 per month', via: 'curl' }; }, async close() {} } });
  assert.equal(row.status, '✓');
});

test('Microsoft被挡和New Callings读不到仍未核，不改读取失败分支', async () => {
  for (const url of ['https://www.microsoft.com/en-au/microsoft-365', 'https://newcallings.com/pricing']) {
    const [row] = await factcheckHTML(guide('A$99', url), { sources: { async readHTTP() { throw Error('fixture blocked or empty'); }, async close() {} } });
    assert.equal(row.status, '未核');
  }
});

async function officeFixture(t, mode) {
  await fs.mkdir('.cache', { recursive: true }); const dir = await fs.mkdtemp(path.resolve('.cache/prices-render-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [], targets = new Map(), controller = new AbortController(); let deliver, mark;
  const body = { innerText: 'Navigation only. 2026. ' + filler, cloneNode() { return { textContent: 'Navigation only. FreeA$0/monthPlusA$30/month ' + filler, querySelectorAll: () => [] }; } };
  const context = {
    waitForEvent() { return new Promise(resolve => { deliver = resolve; }); },
    async newCDPSession() { return { on() {}, async send() {}, async detach() { events.push('guard detach'); } }; },
  };
  const page = { url: () => mark, async goto(url) { mark = url; events.push('goto'); return { ok: () => true }; },
    async waitForFunction(fn, pattern, options) {
      events.push('wait'); assert.equal(options.timeout, 100);
      assert.equal(vm.runInNewContext('(' + fn.toString() + ')(pattern)', { document: { body }, pattern }), false);
      if (mode === 'timeout') throw Error('fixture rendering timeout');
      if (mode === 'abort') { controller.abort(Error('fixture interrupted')); return new Promise(() => {}); }
      await new Promise(resolve => setTimeout(resolve, 5)); body.innerText = 'ChatGPT Plus A$30 per month. ' + filler;
      assert.equal(vm.runInNewContext('(' + fn.toString() + ')(pattern)', { document: { body }, pattern }), true); events.push('rendered');
    },
    async evaluate(fn, prices) { events.push('evaluate'); return vm.runInNewContext('(' + fn.toString() + ')(prices)', { document: { body }, prices }); },
  };
  const session = { async send(method, args) {
    if (method === 'Target.createTarget') { assert.equal(args.background, true); mark = args.url; targets.set('own', mark); deliver(page); return { targetId: 'own' }; }
    if (method === 'Target.closeTarget') { assert.equal(args.targetId, 'own'); targets.delete('own'); events.push('close target'); return { success: true }; }
    if (method === 'Target.getTargets') return { targetInfos: [...targets].map(([targetId, url]) => ({ targetId, url })) };
    assert.fail(method);
  }, async detach() {} };
  const browser = { contexts: () => [context], async newBrowserCDPSession() { return session; }, async close() { events.push('disconnect'); } };
  const reader = new OfficeReader({ timeout: 100, preserveCase: true, signal: controller.signal, lockScript: path.join(dir, 'fake-lock'), leaseRoot: dir,
    commandImpl: async (_script, args) => { events.push(args[0]); return args[0] === 'lock' ? '拿到了' : '放了'; }, connectImpl: async () => browser, checkURL: async () => {},
  });
  return { reader, events, targets };
}

test('真实OfficeReader调用等待可见金额，再读取；导航结束不等于渲染完成', async t => {
  const { reader, events, targets } = await officeFixture(t, 'render');
  try { assert.match(await reader.read('https://chatgpt.com/pricing'), /A\$30/); }
  finally { await reader.close(); }
  assert(events.indexOf('evaluate') > events.indexOf('rendered')); assert.equal(targets.size, 0); assert.equal(events.at(-1), 'unlock');
  await assert.rejects(fs.access(reader.lease));
});

test('CLI --html和注入式工位读取器走可见价格；真实报告金额摘要模拟，美元仅人工核', async t => {
  // 摘录的金额来自验收记录；完整页面没有存档，文本布局是合成fixture。
  const chat = 'ChatGPT Free A$0 / month. Go A$13 / month. This plan may include ads. Plus A$30 / month. Pro A$155 / month. ' + filler;
  const claude = 'Claude Free $0. Pro $17 or $20. Max $100 and $200. Team US$20. ' + filler;
  const entries = [
    ['ChatGPT Free | A$0 / month', 's1'], ['ChatGPT Go | A$13 / month | “This plan may include ads.”', 's1'],
    ['ChatGPT Plus | A$30 / month', 's1'], ['ChatGPT Pro | A$155 / month', 's1'],
    ['Claude Free | A$0', 's2'], ['Claude Pro | A$28, A$340, A$34', 's2'],
    ['Claude Max | A$170.01', 's2'], ['Claude Team | A$34, A$43, A$170, A$213', 's2'],
  ];
  const html = `<table>${entries.map(([value, ref]) => `<tr><td>${value} <a href="#${ref}">[1]</a></td></tr>`).join('')}</table><ol><li id="s1"><a href="https://chatgpt.com/pricing">ChatGPT</a></li><li id="s2"><a href="https://claude.com/pricing">Claude</a></li></ol>`;
  await fs.mkdir('.cache', { recursive: true }); const dir = await fs.mkdtemp(path.resolve('.cache/prices-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'guide.html'); await fs.writeFile(file, html);
  const docs = new Map(), reads = [], sources = { async readHTTP(url) { reads.push(url); throw Error('价格页不能走HTTP'); }, async close() {} };
  const officeFactory = options => {
    assert.equal(options.preserveCase, true); assert.equal(options.caller, 'jian');
    return { async read(url) { reads.push(url); const text = url.includes('chatgpt') ? chat : claude; docs.set(url, text); return text; }, async close() {} };
  };
  let output = '', error = '';
  const code = await main(['--html', file, '--cdp', '--caller', 'jian', '--all'], { env: {}, sources, officeFactory, stdout: { write(s) { output += s; } }, stderr: { write(s) { error += s; } } });
  assert.equal(code, 0, error + output);
  const lines = output.trim().split('\n');
  assert.deepEqual(lines.slice(0, 8).map(line => line.split('\t')[0]), ['✓', '✓', '✓', '✓', '只能人看', '只能人看', '只能人看', '只能人看']);
  assert.equal(lines[8], '汇总：✓ 4 · ✗ 0 · 近似 0 · 只能人看 4 · 未核 0');
  assert.deepEqual(reads, ['https://chatgpt.com/pricing', 'https://claude.com/pricing']);
  assert.equal(docs.get('https://chatgpt.com/pricing'), chat);
  assert.equal(docs.get('https://claude.com/pricing'), claude);
});

test('独审：价格页行内粘连金额可认明确AUD，不把无标识或外币前缀的$猜成澳元', async () => {
  const check = async (claim, text, url = 'https://chatgpt.com/pricing') => (await factcheckHTML(guide(claim, url), {
    cdp: true, env: {}, sources: { readHTTP() { assert.fail('价格页不能走HTTP'); }, async close() {} },
    officeFactory() { return { async read() { return text + filler; }, async close() {} }; },
  }))[0].status;
  for (const text of ['FreeA$0/month GoA$13/month PlusA$30/month ProA$155/month', 'Free A$0per month Go A$13per month Plus A$30per month Pro A$155per month']) {
    for (const amount of [0, 13, 30, 155]) assert.equal(await check(`A$${amount}`, text), '✓', text);
    assert.equal(await check('A$31', text), '✗', text);
  }
  for (const text of ['Claude Free $0. TeamUS$20. Pro $17.', 'Free $0. Pro $17.', 'Free CA$0 and CA$17.']) {
    for (const amount of [0, 28]) assert.equal(await check(`A$${amount}`, text, 'https://claude.com/pricing'), '只能人看', text);
  }
  assert.equal(await check('A$0', 'FreeA$0/month. TeamUS$20.', 'https://claude.com/pricing'), '✓');
  assert.equal(await check('A$30', 'PlusA$30.50per month'), '✗');
  assert.equal(await check('A$30.50', 'PlusA$30.50per month'), '✓');
});

test('真实OfficeReader等待超时或中断也关自己的标签并释放lease/锁，不读导航正文', async t => {
  for (const mode of ['timeout', 'abort']) {
    const { reader, events, targets } = await officeFixture(t, mode);
    try { await assert.rejects(reader.read('https://claude.com/pricing'), /金额|interrupted/); }
    finally { await reader.close(); }
    assert(!events.includes('evaluate')); assert.equal(targets.size, 0); assert.equal(events.at(-1), 'unlock'); await assert.rejects(fs.access(reader.lease));
  }
});
