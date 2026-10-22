import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepare } from './prepare-pr.mjs';
import { inspect, gitData, readDirectory, selectChanged, similar } from './format.mjs';
import { collectLiteral, judge, report } from './verify.mjs';
import { normalize, safeError } from './source.mjs';
import { MODEL } from './model.mjs';
import { CACHE_VERSION, recordHash, sha256 } from './verdict-cache.mjs';
import { boundedJSON, loadCache } from './artifact-cache.mjs';
import { api, comment, findComment, cachePointer } from './comment-pr.mjs';

const cwd = process.cwd(), reportFile = path.resolve('../verify-report.md');
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const allowlist = JSON.parse(await fs.readFile(new URL('./allowlist.json', import.meta.url), 'utf8'));
const eventPR = async () => (await boundedJSON(process.env.GITHUB_EVENT_PATH)).pull_request;
const output = async (key, value) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const writeReport = async r => fs.writeFile(reportFile, report(r));
const failure = message => `<!-- melb-verify -->\n# melb verification\n\n${message}\n\n未合并；要人看。没有通过结果不能自动合并。\n`;
export function chosenAt(cwd, base, dir) {
  return readDirectory(dir).then(files => {
    const info = inspect(files, allowlist);
    if (info.errors.length) throw Error(`格式不过：${info.errors.join('；')}`);
    return { info, chosen: selectChanged(info.records, gitData(base, cwd)) };
  });
}

// 下一个 job 只信 git 中重建的数据，不让无权限 job 的 artifact 换题或漏题。
export async function validateEvidence(evidence, { cwd, pr, currentMain, directory }) {
  const meta = evidence.meta;
  if (evidence.version !== 1 || meta?.head !== pr.head.sha || String(meta?.number) !== String(pr.number) || !/^[a-f0-9]{40}$/.test(meta?.base ?? '')) throw Error('字面 artifact 的 PR/head/base 不符');
  execFileSync('git', ['merge-base', '--is-ancestor', meta.base, currentMain], { cwd, stdio: 'pipe' });
  let plan = await prepare({ cwd, base: meta.base, head: pr.head.sha, destination: directory, association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
  if (!plan.autoEligible) throw Error(plan.reason);
  let { info, chosen } = await chosenAt(cwd, meta.base, directory);
  if (!Array.isArray(evidence.items) || !chosen.length || evidence.items.length !== chosen.length) throw Error('字面 artifact 缺题/多题，或没有改动的题目');
  for (const [i, item] of evidence.items.entries()) {
    const actual = chosen[i];
    if (item.file !== actual.file || item.hash !== recordHash(actual.record) || recordHash(item.record) !== item.hash) throw Error('字面 artifact 的题目内容/hash 不符');
    if (!['pass', 'fail', 'unable'].includes(item.status) || !Array.isArray(item.issues)) throw Error('字面 artifact 的结论格式无效');
    if (item.status === 'pass') {
      if (!Array.isArray(item.excerpts) || item.excerpts.length !== actual.record.sources.length) throw Error('字面 artifact 缺出处摘录');
      for (const [j, s] of actual.record.sources.entries()) {
        const x = item.excerpts[j];
        if (x.url !== s.url || x.quote !== s.quote || typeof x.text !== 'string' || x.text.length > 12_000 || !normalize(x.text).includes(normalize(s.quote))) throw Error('字面 artifact 的出处/quote/摘录不符');
      }
    }
  }
  // 抓取期间 main 前进，先检查最新组合的冲突/格式；已知会被拦的候选不花 Claude 钱。
  if (currentMain !== meta.base) {
    const latestDirectory = directory + '-latest';
    plan = await prepare({ cwd, base: currentMain, head: pr.head.sha, destination: latestDirectory, association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
    if (!plan.autoEligible) throw Error(plan.reason);
    ({ info, chosen } = await chosenAt(cwd, currentMain, latestDirectory));
    if (JSON.stringify(chosen.map(i => recordHash(i.record)).sort()) !== JSON.stringify(evidence.items.map(i => i.hash).sort())) throw Error('最新 main 改变了待核题目，须重新跑字面；未调用 Claude');
  }
  return { ...evidence, errors: info.errors, warnings: [...info.warnings, ...similar(info.records, chosen)], legacyFiles: info.legacyFiles, legacyRecords: info.legacyRecords, total: info.records.length, exitCode: evidence.items.some(i => i.status !== 'pass') ? 1 : 0, plan };
}

export function proofFor(evidence, number) {
  return { version: CACHE_VERSION, model: MODEL, number: String(number), head: evidence.meta.head, hashes: evidence.items.map(i => i.hash).sort() };
}
export function checkProof(bytes, digest, { number, head, chosen }) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') || sha256(bytes) !== digest) throw Error('逐句通过凭据 hash 不符');
  const p = JSON.parse(bytes.toString());
  if (p.version !== CACHE_VERSION || p.model !== MODEL || p.number !== String(number) || p.head !== head || !Array.isArray(p.hashes) || !chosen.length || JSON.stringify(p.hashes) !== JSON.stringify(chosen.map(i => recordHash(i.record)).sort())) throw Error('逐句通过凭据的 PR/head/题目不符');
}

async function literalStage() {
  const pr = await eventPR(), base = git('rev-parse', 'refs/remotes/origin/main');
  const plan = await prepare({ cwd, base, head: pr.head.sha, destination: path.resolve('../candidate'), baseDestination: path.resolve('../main-data'), association: pr.author_association, login: pr.user?.login, baseBranch: pr.base.ref });
  await output('trusted', plan.trusted); await output('eligible', plan.autoEligible);
  if (!plan.autoEligible) {
    await fs.writeFile(reportFile, failure(plan.reason)); return 1;
  }
  const r = await collectLiteral({ dataDir: '../candidate', baseDir: '../main-data' });
  r.meta = { base, head: pr.head.sha, number: String(pr.number) };
  await fs.writeFile('../literal.json', JSON.stringify(r)); await writeReport(r);
  return r.exitCode;
}
async function semanticStage() {
  const pr = await eventPR(), evidence = await boundedJSON('../incoming/literal.json');
  await fs.mkdir('.cache', { recursive: true });
  const directory = path.join(await fs.mkdtemp(path.resolve('.cache/rebuild-')), 'candidate');
  try {
    const r = await validateEvidence(evidence, { cwd, pr, currentMain: git('rev-parse', 'refs/remotes/origin/main'), directory });
    if (r.exitCode || !r.plan.trusted) {
      await writeReport(r);
      if (!r.plan.trusted) await fs.appendFile(reportFile, '\n要人看：外部 PR 不跑 Claude，不自动合并。\n');
      return 1;
    }
    const cache = await loadCache(pr.number);
    // 每个有效回复落盘，失败的批次也上传；不会把 unable 当作可复用结论。
    await fs.writeFile('.cache/semantic-cache.json', JSON.stringify(cache));
    await fs.writeFile('.cache/paid-started', '核对可能已计费；缓存上传失败时禁止自动重付');
    const checked = await judge(r, { cache, saveCache: bytes => fs.writeFile('.cache/semantic-cache.json', bytes) });
    await writeReport(checked);
    if (!checked.exitCode) {
      const bytes = JSON.stringify(proofFor(r, pr.number));
      await fs.writeFile('.cache/semantic-proof.json', bytes); await output('proof_sha', sha256(bytes));
    }
    return checked.exitCode;
  } finally { await fs.rm(path.dirname(directory), { recursive: true, force: true }); }
}
async function finishStage() {
  const pr = await eventPR(), current = await api(`/pulls/${pr.number}`);
  if (current.head?.sha !== pr.head.sha || current.base?.ref !== pr.base.ref) return 0;
  const existing = cachePointer((await findComment(pr.number))?.body);
  // 老 run 即使取消太晚，也不能盖掉新 run 保存的缓存。
  if (existing?.run && BigInt(existing.run) > BigInt(process.env.GITHUB_RUN_ID)) return 0;
  let body;
  try { body = await fs.readFile(reportFile, 'utf8'); }
  catch { body = failure('本轮没有完成，查看 Action 日志；未调用成功不代表通过'); }
  let pointer;
  const cacheBytes = await fs.readFile('.cache/semantic-cache.json').catch(() => null);
  if (cacheBytes && /^\d+$/.test(process.env.CACHE_ARTIFACT_ID ?? '')) pointer = { artifact: process.env.CACHE_ARTIFACT_ID, sha256: sha256(cacheBytes), run: process.env.GITHUB_RUN_ID };
  else if (await fs.stat('.cache/paid-started').catch(() => false)) pointer = { blocked: true, run: process.env.GITHUB_RUN_ID };
  await comment(body, pr.number, pointer);
  return 0;
}
export async function main(mode) {
  try {
    if (mode === 'literal') return await literalStage();
    if (mode === 'semantic') return await semanticStage();
    if (mode === 'finish') return await finishStage();
    throw Error('pipeline 模式不对');
  } catch (e) {
    const message = safeError(e).replaceAll(process.env.ANTHROPIC_API_KEY || '\0', '[redacted]');
    console.error(message);
    if (mode !== 'finish') await fs.writeFile(reportFile, failure(message));
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv[2]);
