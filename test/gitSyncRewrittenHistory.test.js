/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Updating must keep working after the upstream history is rewritten.
//
// Removing something from a published repository means rewriting its history, which gives
// every later commit a new ID. An existing install then has a history GitHub no longer shares,
// and the `git pull` in update.sh refuses to continue: the app keeps running, but it can never
// update again until someone fixes it by hand. git-sync.sh recognises that case and moves the
// install across.
//
// The danger is the opposite mistake: treating genuine local work as a rewrite and discarding
// it. So a rewrite is only recognised when every local-only commit has an exact counterpart
// upstream (same author, author time and title), and only acted on with no edited files.
// These tests build real repositories, publish a history with a fake secret in it, rewrite and
// force-push it the way a real clean-up would, and run the real script in a cloned install.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'git-sync.sh'), 'utf8');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.test',
  GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.test',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'pull.rebase=false', ...args],
    { cwd, env: ENV, encoding: 'utf8' }).trim();
}
function commit(cwd, file, content, subject, when) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  const env = { ...ENV, GIT_AUTHOR_DATE: `${when} +1000`, GIT_COMMITTER_DATE: `${when} +1000` };
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd, env });
}
function sync(install) {
  return spawnSync('bash', ['scripts/git-sync.sh'], { cwd: install, env: ENV, encoding: 'utf8' });
}

/**
 * upstream (bare) <- dev, publishing: base, a commit adding a secret, a commit removing it,
 * and one more. Returns paths plus a rewrite() that republishes the same history with the
 * secret replaced, keeping author, dates and titles, then force-pushes it.
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gitsync-'));
  const upstream = path.join(root, 'upstream.git');
  const dev = path.join(root, 'dev');
  git(root, 'init', '-q', '--bare', upstream);
  git(root, 'init', '-q', dev);
  const history = [
    ['scripts/git-sync.sh', SCRIPT_SRC, 'base', '2026-09-01T10:00:00'],
    ['watchdog.sh', 'VIN="SECRETSECRET12345"\n', 'add watchdog', '2026-09-14T09:00:00'],
    ['watchdog.sh', 'VIN="$(read from env)"\n', 'remove secret', '2026-10-12T10:00:00'],
    ['README', 'more work\n', 'later work', '2026-10-12T11:00:00'],
  ];
  const publish = (repl) => {
    for (const [f, c, s, w] of history) commit(dev, f, repl ? c.replace('SECRETSECRET12345', 'XXXXXXXXXXXXXXXXX') : c, s, w);
  };
  publish(false);
  git(dev, 'remote', 'add', 'origin', upstream);
  git(dev, 'push', '-q', 'origin', 'main');
  const rewrite = () => {
    // A fresh history with identical authors, dates and titles, the secret gone: what
    // git filter-repo --replace-text produces.
    const dev2 = path.join(root, 'dev2');
    git(root, 'init', '-q', dev2);
    for (const [f, c, s, w] of history) commit(dev2, f, c.replace('SECRETSECRET12345', 'XXXXXXXXXXXXXXXXX'), s, w);
    git(dev2, 'push', '-q', '--force', upstream, 'main');
    return git(dev2, 'rev-parse', 'HEAD');
  };
  const install = (at) => {
    const dir = path.join(root, `install-${Math.random().toString(36).slice(2, 8)}`);
    git(root, 'clone', '-q', upstream, dir);
    if (at) git(dir, 'reset', '-q', '--hard', at);
    return dir;
  };
  return { root, upstream, dev, rewrite, install, publish };
}

test('a normal update is still a plain pull', () => {
  const r = setup();
  const inst = r.install('HEAD~1');                       // one commit behind
  const res = sync(inst);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(inst, 'rev-parse', 'HEAD'), git(r.dev, 'rev-parse', 'HEAD'));
  assert.doesNotMatch(res.stdout, /rewritten/);
});

test('after a rewrite, an up-to-date install moves across and the secret is gone from it', () => {
  const r = setup();
  const inst = r.install();
  const newTip = r.rewrite();
  const res = sync(inst);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /history on GitHub was rewritten/);
  assert.equal(git(inst, 'rev-parse', 'HEAD'), newTip);
  assert.equal(git(inst, 'log', '--all', '-S', 'SECRETSECRET12345', '--oneline', 'HEAD'), '',
    'the current branch no longer reaches the old commits');
});

test('an install several versions behind moves across too', () => {
  const r = setup();
  const inst = r.install('HEAD~2');                       // still has the secret checked out
  const newTip = r.rewrite();
  const res = sync(inst);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(inst, 'rev-parse', 'HEAD'), newTip);
  assert.doesNotMatch(fs.readFileSync(path.join(inst, 'watchdog.sh'), 'utf8'), /SECRET/);
});

test('settings, data and other untracked or ignored files are never touched', () => {
  const r = setup();
  const inst = r.install();
  fs.writeFileSync(path.join(inst, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(inst, 'node_modules'));
  fs.writeFileSync(path.join(inst, 'node_modules', 'keep.txt'), 'deps');
  fs.writeFileSync(path.join(inst, 'my-notes.txt'), 'untracked');
  r.rewrite();
  assert.equal(sync(inst).status, 0);
  assert.equal(fs.readFileSync(path.join(inst, 'node_modules', 'keep.txt'), 'utf8'), 'deps');
  assert.equal(fs.readFileSync(path.join(inst, 'my-notes.txt'), 'utf8'), 'untracked');
});

test('an edited tracked file stops it moving, and the edit survives', () => {
  const r = setup();
  const inst = r.install();
  const oldHead = git(inst, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(inst, 'README'), 'my local edit\n');
  r.rewrite();
  const res = sync(inst);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /files in this install have been\s+edited/);
  assert.equal(git(inst, 'rev-parse', 'HEAD'), oldHead, 'not moved');
  assert.equal(fs.readFileSync(path.join(inst, 'README'), 'utf8'), 'my local edit\n');
});

test('a genuine local commit is never mistaken for a rewrite or thrown away', () => {
  const r = setup();
  const inst = r.install();
  commit(inst, 'local.txt', 'mine\n', 'my own change', '2026-10-12T12:00:00');
  const mine = git(inst, 'rev-parse', 'HEAD');
  r.rewrite();
  const res = sync(inst);
  assert.doesNotMatch(res.stdout, /history on GitHub was rewritten/);
  // Falls through to plain `git pull`, with whatever result that has. Either way the local
  // commit must still be there.
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', mine, 'HEAD'], { cwd: inst, env: ENV });
  assert.equal(isAncestor.status, 0, 'the local commit is still part of the current branch');
  assert.ok(fs.existsSync(path.join(inst, 'local.txt')));
  assert.equal(git(inst, 'cat-file', '-t', mine), 'commit');
});

test('local commits with no upstream changes at all are a normal update, not a rewrite', () => {
  const r = setup();
  const inst = r.install();
  commit(inst, 'local.txt', 'mine\n', 'my own change', '2026-10-12T12:00:00');
  const res = sync(inst);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /rewritten/);
  assert.ok(fs.existsSync(path.join(inst, 'local.txt')));
});

test('a detached checkout (rolled back to a tag) behaves exactly as before', () => {
  const r = setup();
  const inst = r.install();
  git(inst, 'checkout', '-q', '--detach', 'HEAD~1');
  const before = git(inst, 'rev-parse', 'HEAD');
  r.rewrite();
  const res = sync(inst);
  assert.doesNotMatch(res.stdout, /rewritten/);
  assert.equal(git(inst, 'rev-parse', 'HEAD'), before, 'nothing moved behind the user\'s back');
});
