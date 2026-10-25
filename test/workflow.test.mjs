import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const workflow = await fs.readFile('.github/workflows/verify.yml', 'utf8');
const testWorkflow = await fs.readFile('.github/workflows/test.yml', 'utf8');
const detector = workflow.match(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE\n/)?.[1].replace(/^          /gm, '');
assert.ok(detector, 'workflow 必须保留可运行的变更检测步骤');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repository(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'melb-ci-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'melb.si'); git(cwd, 'config', 'user.email', 'hello@melb.si');
  await fs.mkdir(path.join(cwd, 'data')); await fs.mkdir(path.join(cwd, 'scripts'));
  for (const [name, text] of [['README.md', 'README'], ['scripts/a.mjs', 'code'], ['data/a.json', '{}'], ['data/空 格\n题.json', '{}']]) await fs.writeFile(path.join(cwd, name), text);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'fixture base');
  return { cwd, base: git(cwd, 'rev-parse', 'HEAD') };
}
async function changed(cwd, base, head) {
  const output = path.join(cwd, 'step-output'); await fs.rm(output, { force: true });
  const result = spawnSync(process.execPath, ['--input-type=module'], { cwd, input: detector, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output } });
  if (result.status !== 0) return { result };
  const value = await fs.readFile(output, 'utf8'); assert.match(value, /^data_changed=(true|false)\n$/);
  return { result, changed: value === 'data_changed=true\n' };
}

for (const [name, expected, mutate] of [
  ['只改README', false, cwd => fs.appendFile(path.join(cwd, 'README.md'), '\nchanged')],
  ['只改scripts', false, cwd => fs.appendFile(path.join(cwd, 'scripts/a.mjs'), '\nchanged')],
  ['改问答JSON', true, cwd => fs.writeFile(path.join(cwd, 'data/a.json'), '{"new":true}')],
  ['同时改data和scripts', true, async cwd => { await fs.writeFile(path.join(cwd, 'data/a.json'), '{"new":true}'); await fs.appendFile(path.join(cwd, 'scripts/a.mjs'), '\nchanged'); }],
  ['data重命名到目录外', true, cwd => fs.rename(path.join(cwd, 'data/a.json'), path.join(cwd, 'scripts/renamed.json'))],
  ['目录外重命名到data', true, cwd => fs.rename(path.join(cwd, 'README.md'), path.join(cwd, 'data/renamed.json'))],
  ['data内部重命名', true, cwd => fs.rename(path.join(cwd, 'data/a.json'), path.join(cwd, 'data/renamed.json'))],
  ['删除问答JSON', true, cwd => fs.unlink(path.join(cwd, 'data/a.json'))],
  ['空格换行中文文件名', true, cwd => fs.appendFile(path.join(cwd, 'data/空 格\n题.json'), '\n')],
  ['data下非JSON', false, cwd => fs.writeFile(path.join(cwd, 'data/notes.md'), 'notes')],
  ['data子目录JSON保守进入原检查', true, async cwd => { await fs.mkdir(path.join(cwd, 'data/sub')); await fs.writeFile(path.join(cwd, 'data/sub/a.json'), '{}'); }],
]) test(`workflow 实际检测步骤：${name}`, async t => {
  const { cwd, base } = await repository(t); await mutate(cwd); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'fixture PR');
  const r = await changed(cwd, base, git(cwd, 'rev-parse', 'HEAD')); assert.equal(r.result.status, 0, r.result.stderr); assert.equal(r.changed, expected);
});

test('workflow 旧基线代码PR不把base后来的data改动算到PR头上', async t => {
  const { cwd, base } = await repository(t); git(cwd, 'switch', '-c', 'code-pr');
  await fs.appendFile(path.join(cwd, 'scripts/a.mjs'), '\ncode'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'code'); const head = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', 'main'); await fs.writeFile(path.join(cwd, 'data/a.json'), '{"main":true}'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'advanced main');
  const r = await changed(cwd, git(cwd, 'rev-parse', 'HEAD'), head); assert.equal(r.result.status, 0, r.result.stderr); assert.equal(r.changed, false);
  assert.notEqual(base, git(cwd, 'rev-parse', 'HEAD'));
});

test('workflow fork PR的head从base仓库PR ref可取得，并比较两侧历史', async t => {
  const { cwd, base } = await repository(t), fork = path.join(cwd, 'fork'), runner = path.join(cwd, 'runner');
  git(cwd, 'clone', cwd, fork); await fs.writeFile(path.join(fork, 'data/a.json'), '{"fork":true}');
  git(fork, '-c', 'user.name=melb.si', '-c', 'user.email=hello@melb.si', 'commit', '-am', 'fork PR'); const head = git(fork, 'rev-parse', 'HEAD');
  // 模拟 GitHub 在 base 仓库保存 PR ref；全程只有本地 fetch，不 push。
  git(cwd, 'fetch', fork, 'HEAD:refs/pull/7/head'); git(cwd, 'init', runner);
  git(runner, 'fetch', cwd, base, head, 'main:refs/remotes/origin/main'); git(runner, 'checkout', '--detach', base);
  const r = await changed(runner, base, head); assert.equal(r.result.status, 0, r.result.stderr); assert.equal(r.changed, true);
});

test('workflow 坏SHA、不可比较历史和git失败都不写false', async t => {
  const { cwd, base } = await repository(t);
  for (const head of ['bad', 'f'.repeat(40)]) {
    const r = await changed(cwd, base, head); assert.notEqual(r.result.status, 0); assert.equal(r.changed, undefined);
  }
  const r = await changed(cwd, base, base); assert.equal(r.result.status, 0, r.result.stderr); assert.equal(r.changed, false);
});

test('workflow 必过job继续实际执行，verify只执行base可信代码', () => {
  const literal = workflow.split('  literal:')[1].split('\n  semantic:')[0];
  const semantic = workflow.split('  semantic:')[1].split('\n  merge:')[0];
  assert.doesNotMatch(literal.split('    steps:')[0], /\n    if:/);
  assert.match(literal, /id: changes/); assert.match(literal, /没有改问答数据/); assert.match(semantic, /没有改问答数据/);
  assert.match(semantic.split('    steps:')[0], /if: always\(\) && !cancelled\(\) && needs.literal.result != 'skipped'/);
  assert.match(semantic, /name: No question data changes\n[^\n]*\n        working-directory: \$\{\{ github.workspace \}\}/);
  assert.match(workflow, /\n  pull_request_target:/);
  assert.doesNotMatch(workflow, /\n  node-test:|ref:.*pull_request\.head|repository:.*pull_request\.head|checkout[^\n]*HEAD_SHA/);
  assert.match(literal, /git -C trusted checkout --detach "\$BASE_SHA"/);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@v4\n([\s\S]*?)(?=\n      - |$)/g)];
  assert.equal(checkouts.length, 2);
  for (const [, checkout] of checkouts) {
    assert.match(checkout, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
    assert.match(checkout, /path: trusted/); assert.match(checkout, /persist-credentials: false/);
  }
});

test('node-test只在pull_request上下文每次跑全部测试，fork代码不进target', () => {
  assert.match(testWorkflow, /^on:\n  pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]/m);
  assert.doesNotMatch(testWorkflow, /pull_request_target|\n  (?:paths|paths-ignore|branches|branches-ignore):/);
  assert.match(testWorkflow, /^permissions:\n  contents: read\n/m);
  const node = testWorkflow.split('\n  node-test:')[1];
  assert.ok(node); assert.match(node, /name: node-test/);
  assert.doesNotMatch(node, /\n    (?:if|needs):/);
  assert.match(node, /uses: actions\/checkout@v4\n        with:\n          persist-credentials: false/);
  assert.match(node, /node-version: '22'/); assert.match(node, /npm ci --ignore-scripts/);
  assert.match(node, /run: node --test\s*$/);
});

test('node-test不使用secret、缓存或写权限，默认PR merge ref且不保存凭据', () => {
  assert.doesNotMatch(testWorkflow, /secrets[.\[]|actions\/cache|cache\s*:|pull-requests:|contents: write|id-token:|github\.token|repository:|\n\s+ref:/);
  assert.match(testWorkflow, /ANTHROPIC_API_KEY: ''/);
  assert.match(testWorkflow, /GITHUB_TOKEN: ''/); assert.match(testWorkflow, /GH_TOKEN: ''/);
});
