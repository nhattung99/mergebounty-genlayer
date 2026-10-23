export function repoPrefix(url) {
  const parts = String(url || '').trim().split('/');
  if (
    parts.length < 5
    || parts[0] !== 'https:'
    || parts[1] !== ''
    || parts[2].toLowerCase() !== 'github.com'
    || parts[3] === ''
    || parts[4] === ''
  ) {
    return '';
  }
  return parts.slice(0, 5).join('/').toLowerCase();
}

export function pullNumber(url) {
  const match = String(url || '').trim().toLowerCase().match(/\/pull\/(\d+)/);
  return match ? match[1] : '';
}

export function evidencePack(prUrl) {
  const prefix = repoPrefix(prUrl);
  const number = pullNumber(prUrl);
  if (!prefix || !number) return [];
  return [`${prefix}/pull/${number}/files`, `${prefix}/pull/${number}/checks`];
}

export function preflight({ issueUrl, prUrl, evidence, account, maintainer }) {
  const pack = evidencePack(prUrl);
  const have = new Set((evidence || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  const sameRepo = Boolean(repoPrefix(issueUrl) && repoPrefix(issueUrl) === repoPrefix(prUrl) && pullNumber(prUrl));
  const wallet = String(account || '').toLowerCase();
  const owner = String(maintainer || '').toLowerCase();
  const checks = [
    { id: 'wallet', ok: Boolean(wallet), label: 'A contributor wallet is connected.' },
    { id: 'not-maintainer', ok: Boolean(wallet) && wallet !== owner, label: 'This wallet is not the maintainer.' },
    { id: 'same-repo', ok: sameRepo, label: 'The pull request is in the same repository as the issue.' },
    { id: 'files', ok: Boolean(pack[0]) && have.has(pack[0]), label: 'Evidence includes the Files changed page.' },
    { id: 'checks', ok: Boolean(pack[1]) && have.has(pack[1]), label: 'Evidence includes the Checks page.' }
  ];
  return { pack, checks, ready: checks.every((item) => item.ok) };
}
