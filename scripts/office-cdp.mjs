import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  // 锁子进程与终端分组隔离；Ctrl-C 由主进程收，等锁命令返回再确认是否需要 unlock。
  return new Promise((resolve, reject) => execFile(script, args, { detached: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(Error((String(stderr || stdout).trim().split('\n')[0] || '办公室浏览器锁命令失败').slice(0, 300)));
    else {
      const answer = stdout.trim();
      const allowed = args[0] === 'lock' ? ['拿到了', '本来就是你的，续上了'] : ['放了', '本来就空着'];
      if (!allowed.includes(answer)) reject(Error('办公室锁脚本返回格式不对'));
      else resolve(answer);
    }
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
  constructor({ caller = 'factcheck', lockScript = process.env.FACTCHECK_LOCK_SCRIPT || LOCK_SCRIPT, leaseRoot = process.env.FACTCHECK_DRIVER_DIR || path.join(os.tmpdir(), `secondfirst-factcheck-${process.getuid?.() ?? 'user'}`), connectImpl = connect, commandImpl = command, checkURL = url => publicURL(url, { allowHTTP: true }), timeout = 15_000, signal, now = () => Date.now() } = {}) {
    this.caller = caller; this.script = lockScript; this.connect = connectImpl; this.command = commandImpl; this.checkURL = checkURL; this.timeout = timeout; this.signal = signal; this.now = now;
    this.lease = path.join(leaseRoot, createHash('sha256').update(path.resolve(lockScript)).digest('hex'));
    this.targets = new Set(); this.marks = new Set(); this.creations = new Set(); this.locked = false; this.closed = false; this.startPromise = null; this.closePromise = null;
  }
  active() {
    this.signal?.throwIfAborted();
    if (this.closed) throw Error('办公室读取器已关闭');
    if (this.lockError) throw this.lockError;
  }
  async acquireLease() {
    // chrome.sh 会把同名 caller 当续租；本地独占目录阻止两个 factcheck 默认 caller 同时开车。
    await fs.mkdir(path.dirname(this.lease), { recursive: true, mode: 0o700 });
    try { await fs.mkdir(this.lease, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(path.join(this.lease, 'owner.json'), 'utf8')); } catch {}
      throw Error(`已有 factcheck 驱动占用：${String(owner?.caller ?? '另一进程').slice(0, 80)}，PID ${Number(owner?.pid) || '未知'}；锁目录 ${this.lease}`);
    }
    this.leaseHeld = true;
    await fs.writeFile(path.join(this.lease, 'owner.json'), JSON.stringify({ caller: this.caller, pid: process.pid }), { mode: 0o600 });
  }
  start() {
    if (!this.startPromise) this.startPromise = (async () => {
      this.active(); await this.acquireLease(); this.active();
      const answer = await this.command(this.script, ['lock', this.caller, 'factcheck']);
      if (answer === '本来就是你的，续上了') throw Error(`办公室锁已经在 ${this.caller} 手里；拒绝接管同名调用`);
      this.locked = true; this.lockedAt = this.now(); this.active();
      const pending = this.connect(ENDPOINT, { timeout: this.timeout });
      Promise.resolve(pending).then(browser => { if (this.closed) browser.close().catch(() => {}); }, () => {});
      this.browser = await wait(pending, this.timeout, this.signal);
      this.context = this.browser.contexts()[0];
      if (!this.context) throw Error('办公室浏览器没有默认 context');
      this.session = await wait(this.browser.newBrowserCDPSession(), this.timeout, this.signal);
      this.active();
      this.renewTimer = setInterval(() => this.renew().catch(() => {}), 5 * 60_000);
      this.renewTimer.unref();
    })();
    return this.startPromise;
  }
  renew() {
    if (!this.renewPromise) this.renewPromise = (async () => {
      this.active();
      await this.command(this.script, ['lock', this.caller, 'factcheck']);
      this.lockedAt = this.now();
    })().catch(error => { this.lockError = Error('办公室锁续租失败：' + safeError(error)); throw this.lockError; }).finally(() => { this.renewPromise = null; });
    return this.renewPromise;
  }
  async read(url) {
    this.active(); await wait(this.checkURL(url), this.timeout, this.signal); this.active();
    await this.start(); this.active();
    if (this.now() - this.lockedAt >= 5 * 60_000) await this.renew();
    this.active();
    const mark = 'about:blank#factcheck-' + randomUUID();
    this.marks.add(mark);
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal?.addEventListener('abort', abort, { once: true });
    const made = this.context.waitForEvent('page', { predicate: page => page.url() === mark, timeout: this.timeout, signal: controller.signal });
    made.catch(() => {});
    let id, guard;
    try {
      const pending = this.session.send('Target.createTarget', { url: mark, background: true });
      this.creations.add(pending);
      Promise.resolve(pending).then(target => {
        this.creations.delete(pending);
        if (typeof target?.targetId === 'string') this.targets.add(target.targetId);
      }, () => this.creations.delete(pending));
      const target = await wait(pending, this.timeout, this.signal);
      if (typeof target?.targetId !== 'string' || !target.targetId) throw Error('办公室浏览器没有返回自己的 targetId');
      id = target.targetId;
      const page = await wait(made, this.timeout, this.signal);
      guard = await wait(this.context.newCDPSession(page), this.timeout, this.signal);
      // 用目标级 Fetch 拦截每一跳；Playwright route 不覆盖同一重定向链的后续请求。
      guard.on('Fetch.requestPaused', event => {
        (async () => {
          try {
            this.active(); await wait(this.checkURL(event.request.url), this.timeout, this.signal);
            this.active(); await wait(guard.send('Fetch.continueRequest', { requestId: event.requestId }), this.timeout);
          } catch { await wait(guard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }), this.timeout).catch(() => {}); }
        })().catch(() => {});
      });
      await wait(guard.send('Network.setBypassServiceWorker', { bypass: true }), this.timeout, this.signal);
      await wait(guard.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }), this.timeout, this.signal);
      await wait(guard.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }), this.timeout, this.signal);
      const response = await wait(page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout }), this.timeout, this.signal);
      if (!response?.ok()) throw Error(`办公室浏览器 HTTP ${response?.status() ?? '无响应'}`);
      await wait(this.checkURL(page.url()), this.timeout, this.signal);
      const text = await wait(page.evaluate(() => {
        const body = document.body?.cloneNode(true);
        if (!body) return '';
        for (const node of body.querySelectorAll('script,style,noscript,template')) node.remove();
        return body.textContent;
      }), this.timeout, this.signal);
      return usable(text);
    } finally {
      controller.abort(); this.signal?.removeEventListener('abort', abort);
      try { if (id) { await this.closeTarget(id); this.marks.delete(mark); } }
      finally { if (guard) await wait(guard.detach(), this.timeout); }
    }
  }
  async closeTarget(id) {
    const result = await wait(this.session.send('Target.closeTarget', { targetId: id }), this.timeout);
    if (result?.success !== true) throw Error('办公室浏览器没有确认关闭自己的标签');
    this.targets.delete(id);
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      this.closed = true; clearInterval(this.renewTimer);
      const errors = [];
      try {
        // 不让仍在执行的 lock 命令在 finally 之后拿到锁。
        await this.startPromise?.catch(() => {});
        await this.renewPromise?.catch(() => {});
        for (const pending of this.creations) {
          try { await wait(pending, this.timeout); }
          catch (error) { errors.push('标签创建未确认：' + safeError(error)); }
        }
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
        if (this.leaseHeld) {
          try { await fs.rm(path.join(this.lease, 'owner.json'), { force: true }); await fs.rmdir(this.lease); this.leaseHeld = false; }
          catch (error) { errors.push('本地驱动锁：' + safeError(error)); }
        }
      }
      if (errors.length) throw Error('办公室浏览器清理失败：' + errors.join('；'));
    })();
    return this.closePromise;
  }
}
