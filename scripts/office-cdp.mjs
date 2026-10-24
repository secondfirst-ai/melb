import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { publicURL, safeError, usable } from './source.mjs';

const ENDPOINT = 'http://127.0.0.1:9333';
const LOCK_SCRIPT = '/Volumes/secondfirst/team/wen/browser/chrome.sh';

export function wait(task, timeout, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value);
    };
    const abort = () => finish(reject, signal.reason ?? Error('已中断'));
    const timer = setTimeout(() => finish(reject, Error('读取超时')), timeout);
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function command(script, args) {
  return new Promise((resolve, reject) => execFile(script, args, { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(Error((String(stderr || stdout).trim().split('\n')[0] || '办公室浏览器锁命令失败').slice(0, 300)));
    else resolve();
  }));
}

async function connect(endpoint, options) {
  // 办公室 README 要求1.64.1+；只复用已安装的tools依赖，不动repo里CI用的1.63。
  const require = createRequire('/Volumes/secondfirst/team/wen/browser/tools/ob.mjs');
  let chromium, version;
  try { ({ chromium } = require('playwright-core')); version = require('playwright-core/package.json').version; }
  catch { throw Error('办公室 tools 缺少 playwright-core 1.64.1+，请 Wen 检查。'); }
  const [major, minor, patch] = version.split('.').map(Number);
  if (!(major > 1 || major === 1 && (minor > 64 || minor === 64 && patch >= 1))) throw Error('办公室 CDP 需要 playwright-core 1.64.1+。');
  return chromium.connectOverCDP(endpoint, options);
}

export class OfficeReader {
  constructor({ caller = 'factcheck', lockScript = process.env.FACTCHECK_LOCK_SCRIPT || LOCK_SCRIPT, connectImpl = connect, commandImpl = command, checkURL = publicURL, timeout = 15_000, signal } = {}) {
    this.caller = caller; this.script = lockScript; this.connect = connectImpl; this.command = commandImpl; this.checkURL = checkURL; this.timeout = timeout; this.signal = signal;
    this.targets = new Set(); this.marks = new Set(); this.locked = false; this.closed = false; this.startPromise = null; this.closePromise = null;
  }
  start() {
    if (!this.startPromise) this.startPromise = (async () => {
      await this.command(this.script, ['lock', this.caller, 'factcheck']);
      this.locked = true; this.signal?.throwIfAborted();
      const pending = this.connect(ENDPOINT, { timeout: this.timeout });
      Promise.resolve(pending).then(browser => { if (this.closed) browser.close().catch(() => {}); }, () => {});
      this.browser = await wait(pending, this.timeout, this.signal);
      this.context = this.browser.contexts()[0];
      if (!this.context) throw Error('办公室浏览器没有默认 context');
      this.session = await wait(this.browser.newBrowserCDPSession(), this.timeout, this.signal);
    })();
    return this.startPromise;
  }
  async read(url) {
    await this.checkURL(url);
    await this.start();
    this.signal?.throwIfAborted();
    const mark = 'about:blank#factcheck-' + randomUUID();
    // 唯一URL认领自己的page；别的page事件不能被当成自己的标签而读/关。
    this.marks.add(mark);
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal?.addEventListener('abort', abort, { once: true });
    const made = this.context.waitForEvent('page', { predicate: page => page.url() === mark, timeout: this.timeout, signal: controller.signal });
    made.catch(() => {});
    let id;
    try {
      const pending = this.session.send('Target.createTarget', { url: mark, background: true });
      // 超时之后才回来的创建结果也只关闭它自己的 target。
      Promise.resolve(pending).then(target => {
        if (this.closed && typeof target?.targetId === 'string') this.session.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      }, () => {});
      const target = await wait(pending, this.timeout, this.signal);
      if (typeof target.targetId !== 'string' || !target.targetId) throw Error('办公室浏览器没有返回自己的 targetId');
      id = target.targetId; this.targets.add(id);
      const page = await wait(made, this.timeout, this.signal);
      const response = await wait(page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout }), this.timeout, this.signal);
      if (!response?.ok()) throw Error(`办公室浏览器 HTTP ${response?.status() ?? '无响应'}`);
      const text = await wait(page.evaluate(() => {
        const body = document.body?.cloneNode(true);
        if (!body) return '';
        for (const node of body.querySelectorAll('script,style,noscript,template')) node.remove();
        return body.textContent;
      }), this.timeout, this.signal);
      return usable(text);
    } finally {
      controller.abort(); this.signal?.removeEventListener('abort', abort);
      if (id) { await this.closeTarget(id); this.marks.delete(mark); }
    }
  }
  async closeTarget(id) {
    const result = await wait(this.session.send('Target.closeTarget', { targetId: id }), this.timeout);
    if (result?.success !== true) throw Error('办公室浏览器没有确认关闭自己的标签');
    this.targets.delete(id);
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      this.closed = true;
      const errors = [];
      try {
        if (this.session && this.marks.size) {
          try {
            const { targetInfos } = await wait(this.session.send('Target.getTargets'), this.timeout);
            if (!Array.isArray(targetInfos)) throw Error('办公室浏览器没有返回 targets');
            for (const target of targetInfos) if (this.marks.has(target.url) && typeof target.targetId === 'string') this.targets.add(target.targetId);
          } catch (error) { errors.push(safeError(error)); }
        }
        for (const id of this.targets) {
          try { await this.closeTarget(id); }
          catch (error) { errors.push(safeError(error)); }
        }
        try { if (this.session) await wait(this.session.detach(), this.timeout); } catch (error) { errors.push(safeError(error)); }
        try { if (this.browser) await wait(this.browser.close(), this.timeout); } catch (error) { errors.push(safeError(error)); }
      } finally {
        if (this.locked) {
          try { await this.command(this.script, ['unlock', this.caller]); this.locked = false; }
          catch (error) { errors.push('unlock：' + safeError(error)); }
        }
      }
      if (errors.length) throw Error('办公室浏览器清理失败：' + errors.join('；'));
    })();
    return this.closePromise;
  }
}
