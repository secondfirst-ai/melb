import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gitData } from './format.mjs';
import { trustedAuthor } from './trusted.mjs';

export const QUESTION_FILES = new Set(['everyday', 'transport', 'driving', 'health', 'housing', 'money-work', 'daily-life', 'government', 'students-newcomers', 'chinese-services'].map(x => `data/${x}.json`));
export function changedPaths(cwd, base, head) {
  return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head, '--'], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).split('\0').filter(Boolean);
}
export function recordOnly(before, after) {
  if (!after || !Array.isArray(after.records) || !after.records.length) return '没有问答 record，或删除了文件/全部题目';
  if (!before) return null;
  if (!Array.isArray(before.records)) return '不是问答数据集';
  const meta = d => Object.fromEntries(Object.entries(d).filter(([k]) => !['records', 'updated'].includes(k)));
  if (!isDeepStrictEqual(meta(before), meta(after))) return '改了 notes/title/dataset 等题目以外的内容';
  const previous = new Map(before.records.map(r => [r?.id, r])), next = new Map(after.records.map(r => [r?.id, r]));
  if ([...previous.keys()].some(id => !next.has(id))) return '删除了题目';
  if (![...next].some(([id, r]) => !isDeepStrictEqual(previous.get(id), r))) return '没有新增或修改题目（只改 updated/顺序/排版也需人看）';
  return null;
}

export async function prepare({ cwd, base, head, destination, baseDestination, association, login, baseBranch = 'main' }) {
  for (const sha of [base, head]) if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('base/head 不是 commit SHA');
  const trusted = trustedAuthor(association, login);
  const reject = reason => ({ dataOnly: false, autoEligible: false, trusted, base, head, reason: `要人看：${reason}；未合并，不跑 Claude。` });
  if (baseBranch !== 'main') return reject('PR 目标不是 main');
  const fork = execFileSync('git', ['merge-base', base, head], { cwd, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(fork)) throw Error('找不到 PR 和 main 的共同基线');
  const files = changedPaths(cwd, fork, head);
  if (!files.length || files.some(p => !QUESTION_FILES.has(p))) return reject('改了允许的十个问答 JSON 以外的文件，或没有改动');
  const mainChanges = new Set(changedPaths(cwd, fork, base));
  if (files.some(p => mainChanges.has(p))) return reject('main 和 PR 改了同一文件，需人工处理冲突（不重付逐句核对）');
  const original = gitData(fork, cwd), proposed = gitData(head, cwd), current = gitData(base, cwd);
  for (const p of files) {
    const name = p.slice(5);
    if (!proposed.has(name)) return reject('删除了问答文件');
    let before, after;
    try { before = original.has(name) ? JSON.parse(original.get(name)) : null; after = JSON.parse(proposed.get(name)); }
    catch { return reject('格式不过，JSON 不能解析'); }
    const reason = recordOnly(before, after);
    if (reason) return reject(reason);
    current.set(name, proposed.get(name));
  }
  if (current.size > 64 || [...current.values()].reduce((n, s) => n + Buffer.byteLength(s), 0) > 30 * 1024 * 1024) return reject('候选数据超过 64 文件/30 MiB');
  const write = async (dir, data) => {
    await fs.mkdir(dir, { recursive: false });
    for (const [name, raw] of data) await fs.writeFile(path.join(dir, name), raw, { flag: 'wx' });
  };
  await write(destination, current);
  if (baseDestination) await write(baseDestination, gitData(base, cwd));
  return { dataOnly: true, autoEligible: true, trusted, base, head, fork, files, reason: trusted ? '成员 PR：main 与 PR 改动已组合，核对两道。' : '外部 PR：只核格式/字面，不能自动合并。' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), pr = event.pull_request;
  const base = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim();
  const result = await prepare({ cwd: process.cwd(), base, head: pr.head.sha, destination: path.resolve('../candidate'), baseDestination: path.resolve('../main-data'), association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
  await fs.writeFile('../plan.json', JSON.stringify(result));
  await fs.appendFile(process.env.GITHUB_OUTPUT, `data_only=${result.dataOnly}\ntrusted=${result.trusted}\n`);
  if (!result.dataOnly) { await fs.writeFile('../verify-report.md', `<!-- melb-verify -->\n# melb verification\n\n${result.reason}\n`); process.exitCode = 1; }
  console.log(result.reason);
}
