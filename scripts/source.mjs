import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicURL, pinnedFetch, browserProxy } from './network.mjs';
export { publicURL } from './network.mjs';

export const FETCH_TIMEOUT_MS = 15_000;
export const MIN_PAGE_TEXT = 200;
const MAX_BYTES = 20 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export function normalize(s) {
  return s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐‑‒–—―−﹘﹣－]/g, '-').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function htmlText(html) {
  return execFileSync('python3', [fileURLToPath(new URL('./html-text.py', import.meta.url))], { input: html, encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BYTES, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function usable(text) {
  const n = normalize(text);
  if (n.length < MIN_PAGE_TEXT) throw Error(`页面正文不足 ${MIN_PAGE_TEXT} 字符`);
  if (/^(access denied|just a moment|attention required|verify (you are|that you are) human|checking your browser|enable javascript and cookies to continue)/.test(n) || /(?:cloudflare ray id|incapsula incident id|request (?:was )?blocked|captcha challenge)/.test(n.slice(0, 1500))) throw Error('页面是访问拦截/验证码');
  return n;
}
async function bytes(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('出处超过 20 MiB');
  const chunks = []; let n = 0;
  for await (const chunk of response.body ?? []) { n += chunk.byteLength; if (n > MAX_BYTES) throw Error('出处超过 20 MiB'); chunks.push(chunk); }
  if (!n) throw Error('出处为空');
  return Buffer.concat(chunks);
}

export class Sources {
  constructor({ fetchImpl = pinnedFetch, checkURL = publicURL, browserFactory, timeout = FETCH_TIMEOUT_MS, withVia = false } = {}) {
    this.fetch = fetchImpl; this.checkURL = checkURL; this.browserFactory = browserFactory; this.timeout = timeout;
    this.withVia = withVia;
    this.cache = new Map(); this.browserPromise = null; this.proxy = null;
  }
  async browser() {
    if (!this.browserPromise) this.browserPromise = this.browserFactory ? this.browserFactory() : (async () => {
      const { chromium } = await import('playwright');
      this.proxy = await browserProxy();
      try {
        return await chromium.launch({ headless: true, chromiumSandbox: true, proxy: { server: this.proxy.server }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      } catch (e) {
        const why = String(e.message).split('\n').find(s => /sandbox|namespace|Operation not permitted/i.test(s) && !s.includes('<launching>')) ?? safeError(e);
        throw Error(`Chromium sandbox 开启失败（不自动降级）：${why.slice(0, 300)}`);
      }
    })();
    return this.browserPromise;
  }
  async readBrowser(url) {
    const browser = await this.browser(), context = await browser.newContext({ userAgent: UA, serviceWorkers: 'block', acceptDownloads: false });
    try {
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        try {
          if (['image', 'media', 'font'].includes(route.request().resourceType())) return await route.abort();
          await this.checkURL(route.request().url());
          await route.continue();
        } catch { await route.abort().catch(() => {}); }
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      if (!response?.ok()) throw Error(`浏览器 HTTP ${response?.status() ?? '无响应'}`);
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => {
        const body = document.body?.cloneNode(true);
        if (!body) return '';
        for (const node of body.querySelectorAll('script,style,noscript,template')) node.remove();
        return body.textContent;
      });
      return usable(text);
    } finally { await context.close(); }
  }
  async readFetch(url) {
    return (await this.readHTTP(url)).text;
  }
  async readHTTP(url) {
    const signal = AbortSignal.timeout(this.timeout);
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const resolved = await this.checkURL(current);
      const response = await this.fetch(current, { redirect: 'manual', signal, headers: { 'user-agent': UA, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' } }, resolved);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get('location');
        await response.body?.cancel();
        if (!target) throw Error('重定向缺 Location');
        current = new URL(target, current).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Error(`fetch HTTP ${response.status}`); }
      const data = await bytes(response), pdf = data.subarray(0, 5).toString() === '%PDF-' || /application\/pdf/i.test(response.headers.get('content-type') ?? '');
      const text = pdf ? execFileSync('pdftotext', ['-enc', 'UTF-8', '-layout', '-', '-'], { input: data, encoding: 'utf8', timeout: 20_000, maxBuffer: MAX_BYTES, stdio: ['pipe', 'pipe', 'pipe'] }) : htmlText(data.toString('utf8'));
      // curl 是 factcheck 对 HTTP 抓取阶段的字段名；沿用既有 pinnedFetch，不另起 curl。
      return { text: usable(text), via: pdf ? 'pdf' : 'curl' };
    }
    throw Error('重定向超过 5 次');
  }
  read(url, quotes) {
    if (!this.cache.has(url)) this.cache.set(url, this.load(url, quotes));
    return this.cache.get(url);
  }
  async load(url, quotes) {
    const texts = [], errors = [], documents = []; let browserFailed = false;
    try {
      if (this.withVia) { const document = await this.readHTTP(url); texts.push(document.text); documents.push(document); }
      else texts.push(await this.readFetch(url));
    } catch (e) { errors.push(`fetch：${safeError(e)}`); }
    if (!texts.length || quotes.some((q) => !texts[0].includes(normalize(q)))) {
      try {
        await this.checkURL(url);
        const text = await this.readBrowser(url);
        if (!texts.includes(text)) { texts.push(text); documents.push({ text, via: 'headless' }); }
      } catch (e) { browserFailed = true; errors.push(`Playwright：${safeError(e)}`); }
    }
    return { texts, errors, browserFailed, ...(this.withVia ? { documents } : {}) };
  }
  async close() {
    try { if (this.browserPromise) { const browser = await this.browserPromise.catch(() => null); await browser?.close(); } }
    finally { await this.proxy?.close(); }
  }
}

export function safeError(error) {
  // 浏览器错误会附上整段启动参数；只留首行，API key 和响应正文从不进入错误报告。
  return (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '超时' : String(error?.message ?? '请求失败').split('\n')[0]).slice(0, 300);
}

export function excerpt(text, quote) {
  const needle = normalize(quote), at = text.indexOf(needle);
  return at < 0 ? text.slice(0, 2500) : text.slice(Math.max(0, at - 2500), at + needle.length + 2500);
}

export function literal(record, pages) {
  const issues = [], excerpts = [];
  for (const [i, s] of record.sources.entries()) {
    const page = pages.get(s.url), quote = normalize(s.quote);
    if (!page?.texts.length) {
      issues.push({ status: 'unable', text: `quote ${i + 1}：无法取得 ${s.url}（${page?.errors.join('；') ?? '未抓取'}）` });
      continue;
    }
    const text = page.texts.find((t) => t.includes(quote));
    if (!text) {
      issues.push({ status: page.browserFailed ? 'unable' : 'fail', text: page.browserFailed ? `quote ${i + 1} 不在 fetch 文字里，浏览器又未能核对：${page.errors.join('；')}（${s.url}）` : `quote ${i + 1} 不在页面上：${s.quote}（${s.url}）` });
      continue;
    }
    excerpts.push({ url: s.url, quote: s.quote, text: excerpt(text, quote) });
  }
  return { status: issues.some((i) => i.status === 'fail') ? 'fail' : issues.length ? 'unable' : 'pass', issues, excerpts };
}
