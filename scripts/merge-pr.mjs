import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { api, comment } from './comment-pr.mjs';
import { trustedAuthor } from './trusted.mjs';
import { prepare } from './prepare-pr.mjs';
import { chosenAt, checkProof } from './pipeline.mjs';
import { assertHeld } from './merge-lock.mjs';

export function mergeReason({ head, pr }) {
  if (pr.base?.ref !== 'main') return 'PR 的目标分支已改变';
  if (pr.head?.sha !== head) return 'PR 的 head 已改变';
  if (pr.draft || pr.state !== 'open') return 'PR 已不是可合并的 open 非 draft 状态';
  if (!trustedAuthor(pr.author_association, pr.user?.login)) return 'PR 作者不是成员';
  return null;
}
export async function mergeVerified({ head, number }, io) {
  if (!/^[a-f0-9]{40}$/.test(head) || !/^\d+$/.test(String(number))) throw Error('合并参数不对');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const main = await io.main(), pr = await io.pr(number), reason = mergeReason({ head, pr });
      if (reason) throw Error(reason);
      // 此处只重建最新 main + PR，检查格式和语义通过凭据；不抓网页、不调 Claude。
      await io.format({ main, pr, head, number });
      if (await io.main() !== main) continue;
      const latest = await io.pr(number), changed = mergeReason({ head, pr: latest });
      if (changed) throw Error(changed);
      await io.merge(number, head);
      return 0;
    }
    throw Error('main 连续前进三次，请重跑本轮；缓存题目不重付');
  } catch (e) {
    await io.comment(`<!-- melb-verify -->\n# melb verification\n\n未合并：${String(e.message).split('\n')[0].slice(0, 500)}。要人看或重跑；只检查新候选格式，不重复付费。`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd(), git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  process.exitCode = await mergeVerified({ head: process.env.PR_HEAD_SHA, number: process.env.PR_NUMBER }, {
    main: async () => {
      const data = await api('/git/ref/heads/main');
      if (!/^[a-f0-9]{40}$/.test(data?.object?.sha ?? '')) throw Error('读不到 main SHA');
      return data.object.sha;
    },
    pr: number => api(`/pulls/${number}`), comment,
    format: async ({ main, head, pr, number }) => {
      await assertHeld(process.env.LOCK_SHA);
      git('fetch', '--no-tags', 'origin', main, head);
      await fs.mkdir('.cache', { recursive: true });
      const dir = await fs.mkdtemp(path.resolve('.cache/merge-'));
      try {
        const destination = path.join(dir, 'candidate');
        const plan = await prepare({ cwd, base: main, head, destination, association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
        if (!plan.autoEligible) throw Error(plan.reason);
        const { chosen } = await chosenAt(cwd, main, destination);
        const bytes = await fs.readFile('../proof/semantic-proof.json');
        checkProof(bytes, process.env.PROOF_SHA, { number, head, chosen });
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
    merge: async (number, head) => {
      await assertHeld(process.env.LOCK_SHA);
      execFileSync('gh', ['pr', 'merge', String(number), '--squash', '--match-head-commit', head], { stdio: 'inherit' });
    },
  });
}
