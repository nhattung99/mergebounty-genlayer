import { createClient } from 'genlayer-js';
import { studionet as officialStudionet } from 'genlayer-js/chains';
import { ExecutionResult, TransactionStatus } from 'genlayer-js/types';
import { parseGenToWei, formatWeiToGen, sanitizeGenInput, deadlineFromDays } from './money';

export { parseGenToWei, formatWeiToGen, sanitizeGenInput, deadlineFromDays };

export const studionet = officialStudionet || {
  id: 61999,
  name: 'GenLayer Studionet',
  rpcUrl: 'https://studio.genlayer.com/api',
  nativeCurrency: {
    name: 'GenLayer Token',
    symbol: 'GEN',
    decimals: 18
  }
};

const rawAddress = String(import.meta.env.VITE_CONTRACT_ADDRESS || '').trim();
export const CONTRACT_ADDRESS = /^0x[0-9a-fA-F]{40}$/.test(rawAddress) ? rawAddress : '';
export const HAS_CONTRACT = CONTRACT_ADDRESS.length > 0;

const toAddress = (account) => {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return account.address || '';
};

const toWriteAccount = (account) => {
  const address = toAddress(account);
  if (!address) return null;
  return { address };
};

export const getGenlayerClient = (account) => {
  try {
    const cfg = { chain: officialStudionet || studionet };
    const address = toAddress(account);
    if (address) cfg.account = address;
    if (typeof window !== 'undefined' && window.ethereum) {
      cfg.provider = window.ethereum;
    }
    return createClient(cfg);
  } catch (err) {
    console.warn('GenLayer client initialization fallback:', err);
    return null;
  }
};

const asPlain = (val) => {
  if (val instanceof Map) {
    const obj = {};
    for (const [k, v] of val.entries()) obj[String(k)] = asPlain(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(asPlain);
  return val;
};

export const formatWriteError = (err) => {
  const msg = String(err?.shortMessage || err?.details || err?.message || err || '');
  const low = msg.toLowerCase();
  if (low.includes('user rejected') || low.includes('user denied') || low.includes('rejected the request')) {
    return 'Đã huỷ giao dịch trong ví.';
  }
  if (low.includes('insufficient') || low.includes('funds')) {
    return 'Không đủ GEN cho tiền thưởng và phí gas.';
  }
  return msg || 'Giao dịch thất bại.';
};

const toValueBigInt = (value) => {
  if (typeof value === 'bigint') return value < 0n ? 0n : value;
  if (typeof value === 'number') return 0n;
  const raw = String(value || '0x0').trim();
  if (raw === '' || raw === '0x' || raw === '0x0') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
};

const isHexStub = (val) => typeof val === 'string' && /^0x[0-9a-fA-F]+$/.test(val);

const studionetChainIdHex = () => {
  const id = Number((officialStudionet || studionet).id || 61999);
  return `0x${id.toString(16)}`;
};

export const switchToGenlayerStudionet = async () => {
  if (typeof window === 'undefined' || !window.ethereum) return;
  const chainIdHex = studionetChainIdHex();
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }]
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      const chain = officialStudionet || studionet;
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainIdHex,
          chainName: chain.name || 'GenLayer Studionet',
          nativeCurrency: chain.nativeCurrency || {
            name: 'GenLayer Token',
            symbol: 'GEN',
            decimals: 18
          },
          rpcUrls: chain.rpcUrls?.default?.http || ['https://studio.genlayer.com/api'],
          blockExplorerUrls: [chain.blockExplorers?.default?.url || 'https://genlayer-explorer.vercel.app']
        }]
      });
    }
  }
};

export const sendContractTransaction = async ({ from, to = CONTRACT_ADDRESS, functionName, args = [], value = '0x0' }) => {
  if (!HAS_CONTRACT) {
    throw new Error('Chưa có địa chỉ contract. Deploy trên studionet rồi điền VITE_CONTRACT_ADDRESS.');
  }
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('Cần ví Web3 (MetaMask) để ký giao dịch trên GenLayer.');
  }
  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const sender = toAddress(from) || (accs && accs[0]);
  if (!sender) throw new Error('Chưa kết nối ví.');
  await switchToGenlayerStudionet();
  const client = getGenlayerClient(sender);
  if (!client || !client.writeContract) {
    throw new Error('GenLayer write client is not available.');
  }
  try {
    return await client.writeContract({
      account: toWriteAccount(sender),
      address: to,
      functionName,
      args,
      value: toValueBigInt(value)
    });
  } catch (err) {
    throw new Error(formatWriteError(err));
  }
};

const STUDIO_RPC = 'https://studio.genlayer.com/api';

const studioRpc = async (method, params = []) => {
  const res = await fetch(STUDIO_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  }).then((r) => r.json());
  if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res?.result;
};

const waitForStudioEvmReceipt = async (txHash, maxRetries = 24, intervalMs = 2000) => {
  for (let i = 0; i < maxRetries; i++) {
    const receipt = await studioRpc('eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (receipt) {
      const status = receipt.status;
      if (status === '0x0' || status === 0 || status === '0') {
        throw new Error('Giao dịch studionet bị revert. Trạng thái contract không đổi.');
      }
      await new Promise((r) => setTimeout(r, 1500));
      return receipt;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Hết thời gian chờ receipt ${txHash}.`);
};

export const waitForFinalizedTx = async (txHash, maxRetries = 24, intervalMs = 2000) => {
  if (!txHash) throw new Error('Thiếu mã giao dịch.');
  try {
    return await waitForStudioEvmReceipt(txHash, maxRetries, intervalMs);
  } catch (studioErr) {
    const studioMsg = String(studioErr?.message || '').toLowerCase();
    if (studioMsg.includes('revert')) throw studioErr;
    const client = getGenlayerClient();
    if (!client || !client.waitForTransactionReceipt) throw studioErr;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.ACCEPTED,
        retries: Math.min(maxRetries, 12),
        interval: intervalMs
      });
      const execName = receipt?.txExecutionResultName || receipt?.executionResult || receipt?.txExecutionResult;
      if (execName === ExecutionResult.FINISHED_WITH_ERROR) {
        const detail = receipt?.txExecutionError || receipt?.stderr || '';
        throw new Error('Contract thực thi lỗi. Trạng thái không đổi. ' + String(detail));
      }
      return receipt;
    } catch {
      throw studioErr;
    }
  }
};

export const readContractState = async (functionName, args = [], targetAddress = CONTRACT_ADDRESS) => {
  if (!HAS_CONTRACT) return null;
  const addr = targetAddress || CONTRACT_ADDRESS;
  try {
    const client = getGenlayerClient();
    if (client && client.readContract) {
      const result = await client.readContract({
        address: addr,
        functionName,
        args,
        stateStatus: 'accepted'
      });
      if (isHexStub(result)) return null;
      return asPlain(result);
    }
  } catch (err) {
    console.warn(`readContract ${functionName} note:`, err);
  }
  return null;
};
