import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DATA_FILE, MAX_FILE_BYTES } from './format.mjs';
import { trustedAuthor } from './trusted.mjs';

export function changedPaths(cwd, base, head) {
  return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head, '--'], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).split('\0').filter(Boolean);
}
export async function prepare({ cwd, base, head, destination, association, login, baseBranch = 'main' }) {
  for (const sha of [base, head]) if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('base/head 不是 commit SHA');
  const files = changedPaths(cwd, base, head);
  const nonData = files.filter((p) => !p.startsWith('data/') || !DATA_FILE.test(p.slice(5)));
  const trusted = trustedAuthor(association, login);
  if (baseBranch !== 'main' || nonData.length || !files.length) return { dataOnly: false, trusted, reason: '改了 data 以外的文件，要人看（只接受对 main 的 data/*.json PR；不跑 Claude、不自动合并）。' };
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, stdio: 'ignore' });
  } catch {
    return { dataOnly: false, trusted, reason: '未合并：PR 分支没有包含当前 main。须同步 main 并重新核对；本轮不跑 Claude。' };
  }
  // 不 checkout/解包 PR。只读 100644 blob，名字限一层 JSON，拒绝 symlink/submodule。
  const tree = execFileSync('git', ['ls-tree', '-rz', head, '--', 'data'], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).split('\0').filter(Boolean);
  const entries = [];
  for (const line of tree) {
    const tab = line.indexOf('\t'), meta = line.slice(0, tab), filename = line.slice(tab + 1);
    if (!filename.endsWith('.json')) continue;
    const match = /^100644 blob ([a-f0-9]{40})$/.exec(meta);
    if (!match || !filename.startsWith('data/') || !DATA_FILE.test(filename.slice(5))) return { dataOnly: false, trusted, reason: 'data 里有非普通 JSON 文件，要人看；不执行 PR 内容、不跑 Claude。' };
    entries.push({ oid: match[1], name: filename.slice(5) });
  }
  if (!entries.length || entries.length > 64) return { dataOnly: false, trusted, reason: 'data 文件数不在 1–64 范围内，要人看。' };
  await fs.mkdir(destination, { recursive: false });
  let total = 0;
  for (const { oid, name } of entries) {
    const size = Number(execFileSync('git', ['cat-file', '-s', oid], { cwd, encoding: 'utf8' }).trim());
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES || (total += size) > 30 * 1024 * 1024) throw Error('PR data 文件过大（每个 5 MiB / 合计 30 MiB）');
    const raw = execFileSync('git', ['cat-file', 'blob', oid], { cwd, maxBuffer: MAX_FILE_BYTES });
    await fs.writeFile(path.join(destination, name), raw, { flag: 'wx' });
  }
  return { dataOnly: true, trusted, reason: trusted ? '成员 PR：核对两道，全部通过后可合并。' : '外部 PR：只核格式和字面，不使用 secret，不自动合并。' };
}
async function main() {
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), pr = event.pull_request;
  const prepared = await prepare({ cwd: process.cwd(), base: pr.base.sha, head: pr.head.sha, destination: path.resolve('../candidate'), association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
  await fs.appendFile(process.env.GITHUB_OUTPUT, `data_only=${prepared.dataOnly}\ntrusted=${prepared.trusted}\n`);
  if (!prepared.dataOnly) await fs.writeFile('../verify-report.md', `<!-- melb-verify -->\n# melb verification\n\n${prepared.reason}\n`);
  console.log(prepared.reason);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
