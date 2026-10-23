import assert from 'node:assert/strict';
import test from 'node:test';
import { evidencePack, preflight, repoPrefix } from './preflight.js';

const ISSUE = 'https://github.com/nhattung99/mergebounty-genlayer/issues/1';
const PR = 'https://github.com/nhattung99/mergebounty-genlayer/pull/2';

test('repo prefix ignores path case', () => {
  assert.equal(repoPrefix('https://GitHub.com/NhatTung99/MergeBounty-GenLayer/issues/1'), 'https://github.com/nhattung99/mergebounty-genlayer');
  assert.equal(repoPrefix('https://example.com/a/b'), '');
});

test('evidence pack is the files and checks pages of that pull request', () => {
  assert.deepEqual(evidencePack(PR), [
    'https://github.com/nhattung99/mergebounty-genlayer/pull/2/files',
    'https://github.com/nhattung99/mergebounty-genlayer/pull/2/checks'
  ]);
  assert.deepEqual(evidencePack(ISSUE), []);
});

test('submit stays blocked until all five checks pass', () => {
  const blocked = preflight({
    issueUrl: ISSUE,
    prUrl: PR,
    evidence: [PR],
    account: '0x20bd0e407731477f2df6ec167a4189ba25c65988',
    maintainer: '0x4c562b4590a5c1e90bd4ac0d5c229492358db0eb'
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.checks.filter((item) => item.ok).length, 3);

  const ready = preflight({
    issueUrl: ISSUE,
    prUrl: 'https://github.com/nhattung99/mergebounty-genlayer/pull/2/',
    evidence: evidencePack(PR),
    account: '0x20BD0E407731477F2DF6EC167A4189BA25C65988',
    maintainer: '0x4c562b4590a5c1e90bd4ac0d5c229492358db0eb'
  });
  assert.equal(ready.ready, true);
});

test('the maintainer wallet cannot pass the preflight', () => {
  const result = preflight({
    issueUrl: ISSUE,
    prUrl: PR,
    evidence: evidencePack(PR),
    account: '0x4c562b4590a5c1e90bd4ac0d5c229492358db0eb',
    maintainer: '0x4c562b4590a5c1e90bd4ac0d5c229492358db0eb'
  });
  assert.equal(result.checks.find((item) => item.id === 'not-maintainer').ok, false);
  assert.equal(result.ready, false);
});
