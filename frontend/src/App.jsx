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
  { id: 'ci', text: 'CI pass toàn bộ trên pull request.' },
  { id: 'tests', text: 'Có test cho phần thay đổi.' },
  { id: 'scope', text: 'Không sửa file ngoài phạm vi nêu trong issue.' },
  { id: 'docs', text: 'Cập nhật tài liệu liên quan nếu hành vi người dùng đổi.' },
  { id: 'deps', text: 'Không thêm dependency mới.' }
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
    return date.toLocaleString('vi-VN');
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
  OPEN: 'Đang mở',
  SUBMITTED: 'Đã nộp, chờ AI',
  DISPUTED: 'Cần nộp lại bằng chứng',
  RESOLVED_PAID: 'Đã trả thưởng',
  RESOLVED_REFUNDED: 'Đã hoàn maintainer',
  EXPIRED_REFUNDED: 'Hết hạn, đã hoàn',
  PAYOUT_FAILED: 'Chuyển tiền lỗi'
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
        <button type="button" className="ghost" onClick={paste}>Dán</button>
      </div>
      {valid === false && <p className="bad">Link phải bắt đầu bằng https://github.com/{kind === 'issue' ? ' và chứa /issues/' : kind === 'pr' ? ' và chứa /pull/' : ''}</p>}
      {valid === true && <p className="ok">Link hợp lệ.</p>}
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
      setError('Không đọc được danh sách bounty. Kiểm tra mạng studionet và địa chỉ contract.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadBounties(); }, []);

  const connect = async () => {
    if (!window.ethereum) {
      setError('Cần MetaMask để kết nối ví trên studionet.');
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
      setMessage('Đang chờ studionet xác nhận...');
      await waitForFinalizedTx(tx);
      setMessage('Giao dịch đã được chấp nhận.');
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
    runTx('Đang tạo bounty và khoá GEN...', 'create_bounty', [title.trim(), issueUrl.trim(), criteria, deadline], rewardWei);
  };

  const submitSolution = (bountyId) => {
    runTx('Đang nộp lời giải...', 'submit_solution', [bountyId, prUrl.trim(), evidenceOk]);
  };

  const copyLine = async () => {
    if (!payoutLine) return;
    try {
      await navigator.clipboard.writeText(payoutLine);
      setMessage('Đã chép dòng ví. Dán vào mô tả PR trước khi nộp.');
    } catch (err) {
      console.warn(err);
      setError('Trình duyệt chặn clipboard. Hãy chọn và chép dòng ví bằng tay.');
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
            Escrow thưởng GEN cho pull request. AI của GenLayer đối chiếu tiêu chí với issue, PR và trang CI — merge của maintainer không phải điều kiện trả thưởng.
          </p>
        </div>
        <div className="wallet">
          <span className="chip">studionet</span>
          {account ? (
            <span className="ghost">{account.slice(0, 6)}…{account.slice(-4)}</span>
          ) : (
            <button type="button" className="primary" onClick={connect}>Kết nối ví</button>
          )}
        </div>
      </header>

      <div className="banner">Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.</div>
      {!HAS_CONTRACT && (
        <div className="warn">
          Chưa có địa chỉ contract. App vẫn mở được để soạn bounty, nhưng chưa gửi giao dịch. Sau khi deploy tay trên studionet và có Result: SUCCESS, điền <code>VITE_CONTRACT_ADDRESS</code> rồi build lại.
        </div>
      )}
      {HAS_CONTRACT && <p className="hint">Contract: {CONTRACT_ADDRESS}</p>}

      <div className="layout">
        <section className="card">
          <h2>Tạo bounty</h2>
          <div className="warn">
            Tiền sẽ bị khoá tới hết hạn, không huỷ được giữa chừng. Link issue và tiêu chí không thể sửa sau khi tạo. Tiêu chí càng khách quan (CI pass, test cụ thể) thì kết quả càng đáng tin.
          </div>
          <label>Tiêu đề</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sửa parser rỗng" />
          <GithubField label="Link issue GitHub" value={issueUrl} onChange={setIssueUrl} kind="issue" placeholder="https://github.com/owner/repo/issues/1" />
          <label>Tiêu chí chấp nhận</label>
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
              {showExtra ? 'Ẩn tiêu chí khác' : 'Thêm tiêu chí khác'}
            </button>
          </div>
          {showExtra && (
            <textarea value={extra} maxLength={240} onChange={(e) => setExtra(e.target.value)} placeholder="Một câu ngắn, kiểm chứng được" />
          )}
          {criteria ? <pre className="preview">{criteria}</pre> : <p className="bad">Chọn ít nhất một tiêu chí.</p>}

          <label>Thưởng (GEN)</label>
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
            placeholder="Số GEN"
          />
          <p className="hint">Sẽ khoá {rewardWei > 0n ? formatWeiToGen(rewardWei) : '0'} GEN. Đơn vị trên chuỗi là wei, không làm tròn số thực.</p>

          <label>Hạn</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>{option} ngày</option>
            ))}
          </select>
          <div className="actions">
            <button type="button" className="primary" disabled={!canCreate} onClick={createBounty}>
              {busy || 'Khoá GEN và tạo bounty'}
            </button>
          </div>
        </section>

        <section className="card">
          <div className="board-head">
            <h2>Bảng bounty</h2>
            <button type="button" className="ghost" onClick={loadBounties} disabled={!HAS_CONTRACT || loading}>
              {loading ? 'Đang đọc...' : 'Làm mới'}
            </button>
          </div>
          {!HAS_CONTRACT && <p className="empty">Chưa gắn contract nên chưa có bounty trên chuỗi. Form bên cạnh vẫn dùng để kiểm tra tiêu chí và link.</p>}
          {HAS_CONTRACT && bounties.length === 0 && !loading && <p className="empty">Chưa có bounty nào.</p>}
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
                  <span className="tag">Hạn {formatWhen(bounty.deadline)}</span>
                  <span className="tag">Bị từ chối {String(bounty.rejected_count ?? 0)} lần</span>
                </div>
                <div className="actions">
                  <button type="button" className="ghost" onClick={() => setOpenId(open ? '' : bounty.id)}>
                    {open ? 'Thu gọn' : 'Mở'}
                  </button>
                  {bounty.issue_url && <a href={bounty.issue_url} target="_blank" rel="noreferrer">Issue</a>}
                </div>
                {open && (
                  <div className="detail">
                    <p>{bounty.acceptance_criteria}</p>
                    <p className="hint">Maintainer {maintainer}</p>
                    {bounty.verdict && (
                      <p className="status-line">
                        {bounty.verdict} · độ tin cậy {String(bounty.confidence)} · {bounty.verdict_reason}
                      </p>
                    )}
                    {bounty.status === 'OPEN' && bounty.verdict === 'REJECTED' && <p className="ok">Bounty đã mở lại. Tiền vẫn nằm trong escrow.</p>}
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
                    {bounty.status === 'DISPUTED' && !isContributor && <p className="bad">Bounty đang khoá với contributor hiện tại cho tới khi họ nộp lại hoặc hết hạn.</p>}
                    {bounty.status === 'SUBMITTED' && (
                      <button type="button" className="primary" disabled={!!busy} onClick={() => runTx('AI đang đọc issue, PR và bằng chứng...', 'resolve_submission', [bounty.id])}>
                        {busy.startsWith('AI') ? busy : 'Yêu cầu AI kiểm tra'}
                      </button>
                    )}
                    {bounty.status === 'PAYOUT_FAILED' && (
                      <button type="button" className="danger" disabled={!!busy} onClick={() => runTx('Đang thử chuyển lại...', 'retry_resolution', [bounty.id])}>
                        Thử lại
                      </button>
                    )}
                    {canRefund && (
                      <button type="button" className="primary" disabled={!!busy} onClick={() => runTx('Đang nhận lại tiền...', 'claim_expired_refund', [bounty.id])}>
                        Nhận lại tiền
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
      <p>{disputed ? 'Chỉ ví đang giữ bài nộp được cập nhật PR và bằng chứng.' : 'Làm xong PR trong cùng repo, rồi nộp link.'}</p>
      <div className="wallet-box">
        <code>{payoutLine || 'Kết nối ví để hiện dòng Bounty payout wallet.'}</code>
        <button type="button" onClick={onCopy} disabled={!payoutLine}>Copy</button>
      </div>
      <p className="hint">Dán dòng này vào mô tả PR trước khi nộp, nếu không bài nộp sẽ bị từ chối tự động.</p>
      <GithubField label="Link pull request" value={prUrl} onChange={setPrUrl} kind="pr" placeholder="https://github.com/owner/repo/pull/2" />
      <label>Link Files changed / Checks</label>
      {evidence.map((item, index) => (
        <GithubField
          key={`evidence-${index}`}
          label={`Bằng chứng ${index + 1}`}
          value={item}
          onChange={(next) => setEvidence((prev) => prev.map((row, i) => (i === index ? next : row)))}
          kind="page"
          placeholder="https://github.com/owner/repo/pull/2/files"
        />
      ))}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => setEvidence((prev) => [...prev, ''])}>Thêm link</button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={onSubmit}>Nộp lời giải</button>
      </div>
    </div>
  );
}
