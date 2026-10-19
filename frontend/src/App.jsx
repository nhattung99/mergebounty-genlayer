import React, { useEffect, useMemo, useState } from 'react';
import {
  CONTRACT_ADDRESS,
  HAS_CONTRACT,
  deadlineFromDays,
  formatWeiToGen,
  parseGenToWei,
  readContractState,
  sanitizeGenInput,
  sendContractTransaction,
  switchToGenlayerStudionet,
  waitForFinalizedTx
} from './genlayerClient';

const CRITERIA = [
  { id: 'ci', text: 'CI passes on the pull request.' },
  { id: 'tests', text: 'The change includes tests for the modified behavior.' },
  { id: 'scope', text: 'No files are changed outside the scope named in the issue.' },
  { id: 'docs', text: 'Related docs are updated when user-facing behavior changes.' },
  { id: 'deps', text: 'No new dependency is added.' }
];
const REWARD_CHIPS = ['1', '5', '10', '25', '50'];
const DAY_OPTIONS = [7, 14, 30, 60];

const isGithub = (value) => String(value || '').trim().toLowerCase().startsWith('https://github.com/');
const isIssue = (value) => isGithub(value) && String(value).toLowerCase().includes('/issues/');
const isPull = (value) => isGithub(value) && String(value).toLowerCase().includes('/pull/');

const sameAddr = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

const asAddress = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.address || String(value);
};

const asCount = (value) => {
  try {
    const n = typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
    if (n < 0n || n > 5000n) return 0;
    return Number(n);
  } catch {
    return 0;
  }
};

const formatWhen = (unix) => {
  try {
    const sec = BigInt(unix);
    const date = new Date(Number(sec * 1000n));
    if (Number.isNaN(date.getTime())) return String(unix);
    return date.toLocaleString('en-US');
  } catch {
    return String(unix ?? '');
  }
};

const nowSec = () => BigInt(Date.now()) / 1000n;

const composeCriteria = (selected, extra) => {
  const lines = CRITERIA.filter((item) => selected[item.id]).map((item) => item.text);
  const more = String(extra || '').trim();
  if (more) lines.push(more);
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
};

const statusTag = (status) => {
  if (status === 'RESOLVED_PAID') return 'good';
  if (status === 'PAYOUT_FAILED' || status === 'DISPUTED') return 'bad';
  if (status === 'SUBMITTED') return 'wait';
  return '';
};

const statusText = {
  OPEN: 'Open',
  SUBMITTED: 'Submitted, waiting for AI',
  DISPUTED: 'Needs fresh evidence',
  RESOLVED_PAID: 'Reward paid',
  RESOLVED_REFUNDED: 'Refunded to maintainer',
  EXPIRED_REFUNDED: 'Expired and refunded',
  PAYOUT_FAILED: 'Transfer failed'
};

function GithubField({ label, value, onChange, placeholder, kind }) {
  const trimmed = String(value || '').trim();
  const valid = trimmed === '' ? null : (kind === 'issue' ? isIssue(trimmed) : kind === 'pr' ? isPull(trimmed) : isGithub(trimmed));
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      onChange(String(text || '').trim());
    } catch (err) {
      console.warn('Clipboard read failed:', err);
    }
  };
  return (
    <div>
      <label>{label}</label>
      <div className="row">
        <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trimStart())} />
        <button type="button" className="ghost" onClick={paste}>Paste</button>
      </div>
      {valid === false && <p className="bad">The link must start with https://github.com/{kind === 'issue' ? ' and include /issues/' : kind === 'pr' ? ' and include /pull/' : ''}</p>}
      {valid === true && <p className="ok">Link looks valid.</p>}
    </div>
  );
}

export default function App() {
  const [account, setAccount] = useState('');
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');

  const [title, setTitle] = useState('');
  const [issueUrl, setIssueUrl] = useState('');
  const [selected, setSelected] = useState({ ci: true, tests: true, scope: false, docs: false, deps: false });
  const [showExtra, setShowExtra] = useState(false);
  const [extra, setExtra] = useState('');
  const [reward, setReward] = useState('5');
  const [days, setDays] = useState(14);

  const [prUrl, setPrUrl] = useState('');
  const [evidence, setEvidence] = useState(['']);

  const criteria = useMemo(() => composeCriteria(selected, showExtra ? extra : ''), [selected, extra, showExtra]);
  const rewardWei = useMemo(() => parseGenToWei(reward), [reward]);
  const payoutLine = account ? `Bounty payout wallet: ${account.toLowerCase()}` : '';

  const evidenceOk = evidence.map((item) => item.trim()).filter(Boolean);
  const canCreate = Boolean(title.trim() && isIssue(issueUrl) && criteria && rewardWei > 0n && HAS_CONTRACT && account && !busy);
  const canSubmit = Boolean(isPull(prUrl) && evidenceOk.length > 0 && evidenceOk.every(isGithub) && account && !busy);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    window.ethereum.request({ method: 'eth_accounts' }).then((accs) => {
      if (accs && accs[0]) setAccount(accs[0]);
    }).catch(() => {});
    const onAccounts = (accs) => setAccount(accs && accs[0] ? accs[0] : '');
    window.ethereum.on?.('accountsChanged', onAccounts);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccounts);
  }, []);

  const loadBounties = async () => {
    if (!HAS_CONTRACT) {
      setBounties([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const countRaw = await readContractState('get_bounty_count', []);
      const count = asCount(countRaw);
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const data = await readContractState('get_bounty', [String(i)]);
        if (data && typeof data === 'object') rows.push({ id: String(i), ...data });
      }
      setBounties(rows);
    } catch (err) {
      console.warn(err);
      setError('Could not load bounties. Check that the wallet is on studionet and the contract address is set.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadBounties(); }, []);

  const connect = async () => {
    if (!window.ethereum) {
      setError('MetaMask is required to connect a wallet on studionet.');
      return;
    }
    setError('');
    await switchToGenlayerStudionet();
    const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
    setAccount(accs && accs[0] ? accs[0] : '');
  };

  const runTx = async (label, functionName, args, value = 0n) => {
    setBusy(label);
    setError('');
    setMessage(label);
    try {
      const tx = await sendContractTransaction({
        from: account,
        functionName,
        args,
        value: value > 0n ? value.toString() : '0x0'
      });
      setMessage('Waiting for studionet to confirm...');
      await waitForFinalizedTx(tx);
      setMessage('Transaction accepted.');
      await loadBounties();
    } catch (err) {
      setError(String(err?.message || err));
      setMessage('');
    } finally {
      setBusy('');
    }
  };

  const createBounty = () => {
    const deadline = deadlineFromDays(days);
    runTx('Locking GEN and creating the bounty...', 'create_bounty', [title.trim(), issueUrl.trim(), criteria, deadline], rewardWei);
  };

  const submitSolution = (bountyId) => {
    runTx('Submitting the solution...', 'submit_solution', [bountyId, prUrl.trim(), evidenceOk]);
  };

  const copyLine = async () => {
    if (!payoutLine) return;
    try {
      await navigator.clipboard.writeText(payoutLine);
      setMessage('Wallet line copied. Paste it into the PR description before you submit.');
    } catch (err) {
      console.warn(err);
      setError('The browser blocked the clipboard. Select the wallet line and copy it yourself.');
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Open source · studionet</p>
          <div className="brand">
            <div className="mark">M</div>
            <h1>MergeBounty</h1>
          </div>
          <p className="sub">
            GEN escrow for pull requests. GenLayer's AI consensus checks the issue, the PR, and CI. A maintainer merge is not required to pay the reward.
          </p>
        </div>
        <div className="wallet">
          <span className="chip">studionet</span>
          {account ? (
            <span className="ghost">{account.slice(0, 6)}…{account.slice(-4)}</span>
          ) : (
            <button type="button" className="primary" onClick={connect}>Connect wallet</button>
          )}
        </div>
      </header>

      <div className="banner">Free to use. You only pay GenLayer gas when you sign a transaction. There is no platform fee.</div>
      {!HAS_CONTRACT && (
        <div className="warn">
          No contract address yet. You can draft a bounty, but nothing is sent on-chain. After a studionet deploy returns Result: SUCCESS, set <code>VITE_CONTRACT_ADDRESS</code> and rebuild.
        </div>
      )}
      {HAS_CONTRACT && <p className="hint">Contract: {CONTRACT_ADDRESS}</p>}

      <div className="layout">
        <section className="card">
          <h2>Create a bounty</h2>
          <div className="warn">
            Funds stay locked until the deadline. You cannot cancel early. The issue link and the criteria cannot be edited after creation. Objective criteria, such as a green CI run or a specific test, produce a more reliable result.
          </div>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the empty-input parser" />
          <GithubField label="GitHub issue link" value={issueUrl} onChange={setIssueUrl} kind="issue" placeholder="https://github.com/owner/repo/issues/1" />
          <label>Acceptance criteria</label>
          <div className="checks">
            {CRITERIA.map((item) => (
              <label className="check" key={item.id}>
                <input
                  type="checkbox"
                  checked={Boolean(selected[item.id])}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                />
                <span>{item.text}</span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setShowExtra((v) => !v)}>
              {showExtra ? 'Hide extra criterion' : 'Add another criterion'}
            </button>
          </div>
          {showExtra && (
            <textarea value={extra} maxLength={240} onChange={(e) => setExtra(e.target.value)} placeholder="One short, checkable sentence" />
          )}
          {criteria ? <pre className="preview">{criteria}</pre> : <p className="bad">Choose at least one criterion.</p>}

          <label>Reward (GEN)</label>
          <div className="pills">
            {REWARD_CHIPS.map((chip) => (
              <button type="button" key={chip} className={reward === chip ? 'pill on' : 'pill'} onClick={() => setReward(chip)}>
                {chip} GEN
              </button>
            ))}
          </div>
          <input
            value={reward}
            onChange={(e) => setReward(sanitizeGenInput(e.target.value))}
            placeholder="GEN amount"
          />
          <p className="hint">This locks {rewardWei > 0n ? formatWeiToGen(rewardWei) : '0'} GEN. The chain stores wei, with no floating-point rounding.</p>

          <label>Deadline</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>{option} days</option>
            ))}
          </select>
          <div className="actions">
            <button type="button" className="primary" disabled={!canCreate} onClick={createBounty}>
              {busy || 'Lock GEN and create bounty'}
            </button>
          </div>
        </section>

        <section className="card">
          <div className="board-head">
            <h2>Open bounties</h2>
            <button type="button" className="ghost" onClick={loadBounties} disabled={!HAS_CONTRACT || loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          {!HAS_CONTRACT && <p className="empty">No contract is configured, so there is nothing on-chain yet. The form still lets you check criteria and links.</p>}
          {HAS_CONTRACT && bounties.length === 0 && !loading && <p className="empty">No bounties yet.</p>}
          {bounties.map((bounty) => {
            const maintainer = asAddress(bounty.maintainer);
            const contributor = asAddress(bounty.current_contributor);
            const expired = (() => {
              try { return nowSec() > BigInt(bounty.deadline); } catch { return false; }
            })();
            const open = openId === bounty.id;
            const isMaintainer = sameAddr(account, maintainer);
            const isContributor = sameAddr(account, contributor);
            const canRefund = isMaintainer && expired && (bounty.status === 'OPEN' || bounty.status === 'DISPUTED');
            return (
              <article className="bounty" key={bounty.id}>
                <header>
                  <h3>{bounty.title || `Bounty ${bounty.id}`}</h3>
                  <span className={`tag ${statusTag(bounty.status)}`}>{statusText[bounty.status] || bounty.status}</span>
                </header>
                <div className="meta">
                  <span className="tag">{formatWeiToGen(bounty.reward_amount)} GEN</span>
                  <span className="tag">Deadline {formatWhen(bounty.deadline)}</span>
                  <span className="tag">Rejected {String(bounty.rejected_count ?? 0)} times</span>
                </div>
                <div className="actions">
                  <button type="button" className="ghost" onClick={() => setOpenId(open ? '' : bounty.id)}>
                    {open ? 'Collapse' : 'Open'}
                  </button>
                  {bounty.issue_url && <a href={bounty.issue_url} target="_blank" rel="noreferrer">Issue</a>}
                </div>
                {open && (
                  <div className="detail">
                    <p>{bounty.acceptance_criteria}</p>
                    <p className="hint">Maintainer {maintainer}</p>
                    {bounty.verdict && (
                      <p className="status-line">
                        {bounty.verdict} · confidence {String(bounty.confidence)} · {bounty.verdict_reason}
                      </p>
                    )}
                    {bounty.status === 'OPEN' && bounty.verdict === 'REJECTED' && <p className="ok">The bounty is open again. The funds are still in escrow.</p>}
                    {(bounty.status === 'OPEN' || (bounty.status === 'DISPUTED' && isContributor)) && !expired && (
                      <SubmitBox
                        payoutLine={payoutLine}
                        onCopy={copyLine}
                        prUrl={prUrl}
                        setPrUrl={setPrUrl}
                        evidence={evidence}
                        setEvidence={setEvidence}
                        canSubmit={canSubmit && HAS_CONTRACT}
                        onSubmit={() => submitSolution(bounty.id)}
                        disputed={bounty.status === 'DISPUTED'}
                      />
                    )}
                    {bounty.status === 'DISPUTED' && !isContributor && <p className="bad">This bounty is locked to the current contributor until they resubmit or the deadline passes.</p>}
                    {bounty.status === 'SUBMITTED' && (
                      <button type="button" className="primary" disabled={!!busy} onClick={() => runTx('AI is reading the issue, pull request, and evidence...', 'resolve_submission', [bounty.id])}>
                        {busy.startsWith('AI') ? busy : 'Ask AI to check'}
                      </button>
                    )}
                    {bounty.status === 'PAYOUT_FAILED' && (
                      <button type="button" className="danger" disabled={!!busy} onClick={() => runTx('Retrying the transfer...', 'retry_resolution', [bounty.id])}>
                        Try again
                      </button>
                    )}
                    {canRefund && (
                      <button type="button" className="primary" disabled={!!busy} onClick={() => runTx('Claiming the refund...', 'claim_expired_refund', [bounty.id])}>
                        Claim refund
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {message && <p className="notice tx">{message}</p>}
          {error && <p className="bad tx">{error}</p>}
        </section>
      </div>
    </div>
  );
}

function SubmitBox({ payoutLine, onCopy, prUrl, setPrUrl, evidence, setEvidence, canSubmit, onSubmit, disputed }) {
  return (
    <div>
      <p>{disputed ? 'Only the wallet that holds this submission can update the pull request and the evidence.' : 'Open a pull request in the same repository, then submit the links.'}</p>
      <div className="wallet-box">
        <code>{payoutLine || 'Connect a wallet to show the payout line.'}</code>
        <button type="button" onClick={onCopy} disabled={!payoutLine}>Copy</button>
      </div>
      <p className="hint">Paste this line into the pull request description before you submit. Otherwise the submission is rejected automatically.</p>
      <GithubField label="Pull request link" value={prUrl} onChange={setPrUrl} kind="pr" placeholder="https://github.com/owner/repo/pull/2" />
      <label>Files changed and Checks links</label>
      {evidence.map((item, index) => (
        <GithubField
          key={`evidence-${index}`}
          label={`Evidence ${index + 1}`}
          value={item}
          onChange={(next) => setEvidence((prev) => prev.map((row, i) => (i === index ? next : row)))}
          kind="page"
          placeholder="https://github.com/owner/repo/pull/2/files"
        />
      ))}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => setEvidence((prev) => [...prev, ''])}>Add link</button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={onSubmit}>Submit solution</button>
      </div>
    </div>
  );
}
