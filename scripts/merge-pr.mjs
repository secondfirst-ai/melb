import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { api, comment } from './comment-pr.mjs';

export function mergeReason({ base, head, main, pr }) {
  if (main !== base) return 'main 在本轮核对后已经更新';
  if (pr.base?.ref !== 'main' || pr.base?.sha !== base) return 'PR 的目标分支/base 已改变';
  if (pr.head?.sha !== head) return 'PR 的 head 已改变';
  if (pr.draft || pr.state !== 'open') return 'PR 已不是可合并的 open 非 draft 状态';
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association)) return 'PR 作者不是成员';
  return null;
}
export async function mergeVerified({ base, head, number }, io) {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head) || !/^\d+$/.test(String(number))) throw Error('合并参数不对');
  const main = await io.main(), pr = await io.pr(number), reason = mergeReason({ base, head, main, pr });
  if (reason) {
    await io.comment(`<!-- melb-verify -->\n# melb verification\n\n未合并：${reason}。须同步 main 并重新核对；之前的通过结果不能用于当前合并。`);
    return 1;
  }
  await io.merge(number, head);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await mergeVerified({ base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA, number: process.env.PR_NUMBER }, {
    main: async () => {
      const data = await api('/git/ref/heads/main');
      if (!/^[a-f0-9]{40}$/.test(data?.object?.sha ?? '')) throw Error('读不到 main SHA');
      return data.object.sha;
    },
    pr: (number) => api(`/pulls/${number}`),
    comment,
    merge: (number, head) => execFileSync('gh', ['pr', 'merge', String(number), '--squash', '--match-head-commit', head], { stdio: 'inherit' }),
  });
}
