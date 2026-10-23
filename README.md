# MergeBounty

GEN escrow for open-source work on GenLayer. A maintainer locks a fixed GEN reward with a GitHub issue link and acceptance criteria. A contributor opens a pull request in that same repository and writes their payout wallet into the PR description. GenLayer's AI consensus reads the issue, the pull request, and the evidence pages (Files changed, Checks/CI), then returns exactly one of `ACCEPTED` or `REJECTED`. A maintainer merge is not required for payment.

> MergeBounty needs GenLayer. No EVM contract can read a pull request diff and a CI result and compare them with criteria written in natural language, and no maintainer has time to review every small bounty. Only GenLayer's decentralized AI consensus can check the work and pay it automatically.

This is an original build inspired by the idea of automatic open-source bounties. It is not a copy of another project, it does not use another chain, and the reward is GEN.

## Why the verdict is binary

The reward is fixed when the bounty is created. Validators compare the verdict with absolute equality (`==`) and compare the `confidence >= 60` branch the same way. That branch decides whether money moves or stays in escrow. There is no percent tolerance and no arithmetic on the amount. Two validators cannot agree and then settle two different sums.

## Architecture

One contract, `contracts/merge_bounty.py`, holds the GEN itself.

1. `create_bounty` receives GEN with the transaction and locks `issue_url`, `acceptance_criteria`, `reward_amount`, and `deadline`. Nothing can edit those fields, and there is no cancel function.
2. `submit_solution` accepts only a pull request under `https://github.com/<owner>/<repo>/pull/` for that issue, plus at least one `https://github.com/` evidence page.
3. Anyone can call `resolve_submission`. Before the LLM runs, the contract checks that the submitter wallet (`gl.message.sender_address`, lowercase hex) appears in the pull request page. If it does not, the verdict is `REJECTED` with no LLM call.
4. `ACCEPTED` with confidence of at least 60 pays the full reward to the contributor. `REJECTED` before the deadline reopens the bounty and leaves the funds in escrow. `REJECTED` after the deadline refunds the maintainer.
5. Confidence under 60 sets `DISPUTED`. Only the current contributor can submit again. Everyone else is blocked until the next resolution or the deadline.
6. After the deadline, while the status is `OPEN` or `DISPUTED`, the maintainer calls `claim_expired_refund`. A `SUBMITTED` bounty that has expired cannot skip resolution.
7. Every transfer goes through `_settle`, which stores the recipient and the success status before `emit_transfer`. `retry_resolution` reads that stored intent and does not run the AI again.

## Money map

The only money field is `reward_amount`, in wei (1 GEN = 10^18). The deadline is a Unix second count, not money.

| Direction | Where | How |
|---|---|---|
| WRITE | Frontend, when creating a bounty | A GEN string (`"5"`, `"1.5"`) or a chip goes through `parseGenToWei`. The wei `bigint` is the `value` of `create_bounty`. |
| WRITE | Contract `create_bounty` | `reward_amount = bigint(gl.message.value)`. No multiply, divide, or rounding. |
| READ | Contract `get_bounty` | Returns `reward_amount` unchanged, in wei. |
| READ | Frontend bounty list and confirmation line | `formatWeiToGen(reward_amount)`. |
| Payout | `_try_settlement` | `emit_transfer(value=u256(reward_amount))` sends the locked amount to the recipient stored in the payout intent. |

`parseGenToWei` and `formatWeiToGen` use string splitting and `BigInt` only. `scripts/check-no-float-money.js` runs on `prebuild` and rejects `parseFloat`, `Math.round`, `Math.floor`, and `Math.ceil` when they sit near `reward`, `amount`, `payout`, `refund`, `balance`, `wei`, or `gen`.

## Honest limits

1. The AI judges whether a pull request meets the criteria. It does not guarantee that the code is absolutely correct. Objective, checkable criteria (CI passes, a specific test) make the result more reliable. Vague criteria make it less reliable.
2. The pull request text is written by the contributor, so it is not fully independent. The independent source is state GitHub itself produces (CI and Checks results, the list of changed files). The prompt prefers those sources when they disagree with the PR description.
3. The prompt-injection defense only reduces the risk. It does not remove it.
4. Only public GitHub repositories are supported. Pages that require login, private repositories, or GitHub pages that are blocked or rate-limited fail the fetch. The transaction reverts and can be retried.
5. Because a bounty reopens after each `REJECTED`, someone can submit junk and lock it for a while. `resolve_submission` is permissionless, so the lock lasts only until someone clicks resolve.
6. Each fetched page is cut at 20,000 characters so the prompt stays bounded. A very large pull request can be judged on incomplete text.
7. The maintainer cannot cancel a bounty. Funds stay locked until the deadline.

The LLM prompt states that everything fetched from the web is untrusted data, that instructions inside it must not be followed, and that an attempt to steer the verdict returns `REJECTED`. That reduces the risk. It does not eliminate it.

## Studio API in use

The contract header pins the runner:

```text
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

- Caller: `gl.message.sender_address`.
- GEN transfer: `gl.get_contract_at(recipient).emit_transfer(value=u256(amount))`.
- Time: parse `gl.message_raw["datetime"]` (the transaction's ISO-8601 time) into Unix seconds. On this runner, `gl.message` has no datetime field. `gl.block.timestamp` is not used.
- `create_bounty` is `@gl.public.write.payable`. Runner v0.2.16 rejects a non-zero value on a method that is not payable. The other methods do not receive GEN.
- The validator reads `Return.calldata`, which is the SDK field. `Return` has no `.value` field.

## Live App

https://mergebounty-genlayer.vercel.app

## Deployed Contract

- Address (studionet): `0x9FB944605bAFe0FfBBE679b65B054afA6bAb3CF1`
- Explorer: https://genlayer-explorer.vercel.app/address/0x9FB944605bAFe0FfBBE679b65B054afA6bAb3CF1

## Tests

```bash
python -m pytest tests/test_merge_bounty.py -q
```

Tests use gltest direct mode (`genlayer-test`). `vm.mock_web` and `vm.mock_llm` are installed before each nondeterministic transaction. `gltest.config.yaml` keeps the default network on studionet.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Dev server: http://localhost:5173 on studionet.

Criteria are checkboxes. The deadline is 7, 14, 30, or 60 days. The reward is a GEN chip. Every GitHub link has a paste button and must start with `https://github.com/`.

Version 2 adds a submission preflight. **Submit solution** stays disabled until the connected wallet is not the maintainer, the pull request is in the issue repository, and the evidence includes that pull request's `/files` and `/checks` pages. **Fill Files and Checks** writes those two links from the pull request URL. See `CHANGELOG.md`. The contract address did not change.
