import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { api, comment } from './comment-pr.mjs';

export const LOCK_REF = 'heads/melb-merge-lock';
const gitRef = () => api(`/git/ref/${LOCK_REF}`);
const removeRef = () => api(`/git/refs/${LOCK_REF}`, { method: 'DELETE' });
const post = (route, data) => api(route, { method: 'POST', body: JSON.stringify(data) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function acquire({ create, read, wait = pause, now = Date.now, timeout = 12 * 60_000, log = console.log }) {
  const deadline = now() + timeout;
  while (true) {
    try { await create(); return; }
    catch (e) { if (e.status !== 422) throw e; }
    // GitHub create-ref 是原子的；已有锁就等，不使用会丢 pending 的 concurrency 队列。
    const held = await read();
    if (!/^[a-f0-9]{40}$/.test(held?.object?.sha ?? '')) throw Error('合并锁不是可识别的 commit，请人检查');
    if (now() >= deadline) throw Error(`等合并锁超时（${held.object.sha}）。要人看锁对应 run；重跑会复用语义缓存。禁止在持锁 run 运行时删锁`);
    log(`等待合并锁 ${held.object.sha}，不调用 Claude`);
    await wait(15_000 + Math.floor(Math.random() * 5000));
  }
}
export async function release(sha, { read = gitRef, remove = removeRef } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('缺合并锁 SHA，不删任何 ref');
  let held;
  try { held = await read(); } catch (e) { if (e.status === 404) return; throw e; }
  if (held?.object?.sha !== sha) throw Error('合并锁已不属于本 run，拒绝删除');
  // 只有持有者释放；不自动删除/抢占旧锁，避免 GitHub delete-ref 没有 CAS 的竞态。
  await remove();
}
export async function assertHeld(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || (await gitRef()).object?.sha !== sha) throw Error('本 run 没有持有合并锁，不合并');
}
async function main(mode) {
  if (mode === 'release') return release(process.env.LOCK_SHA);
  if (mode !== 'acquire') throw Error('merge-lock 模式不对');
  const run = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT, number = process.env.PR_NUMBER;
  if (![run, attempt, number].every(s => /^\d+$/.test(s ?? ''))) throw Error('合并锁 run/attempt/PR 无效');
  const main = await api('/git/ref/heads/main');
  if (!/^[a-f0-9]{40}$/.test(main?.object?.sha ?? '')) throw Error('main SHA 无效，不创建锁');
  const commit = await api(`/git/commits/${main.object.sha}`);
  if (!/^[a-f0-9]{40}$/.test(commit?.tree?.sha ?? '')) throw Error('main tree SHA 无效，不创建锁');
  const owner = { name: 'melb.si', email: 'hello@melb.si' };
  const lock = await post('/git/commits', { message: `melb automated merge lock\n${JSON.stringify({ run, attempt, number })}`, tree: commit.tree?.sha, parents: [main.object.sha], author: owner, committer: owner });
  if (!/^[a-f0-9]{40}$/.test(lock?.sha ?? '')) throw Error('创建合并锁 commit 失败');
  await acquire({
    create: () => post('/git/refs', { ref: `refs/${LOCK_REF}`, sha: lock.sha }),
    read: async () => { try { return await gitRef(); } catch (e) { if (e.status === 404) return { object: { sha: lock.sha } }; throw e; } },
  });
  await fs.appendFile(process.env.GITHUB_OUTPUT, `sha=${lock.sha}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv[2]); }
  catch (e) {
    const message = String(e.message).split('\n')[0].slice(0, 500);
    console.error(message); process.exitCode = 1;
    if (process.argv[2] === 'acquire') await comment(`<!-- melb-verify -->\n# melb verification\n\n未合并，要人看：${message}。核对缓存保留，重跑不需重付已缓存题目。`).catch(() => console.error('锁失败的评论也未能保存，请看 Action 日志'));
  }
}
