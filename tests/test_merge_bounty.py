import json
import re

import pytest

CONTRACT_PATH = "contracts/merge_bounty.py"
ISSUE = "https://github.com/mergebounty/demo/issues/1"
PR = "https://github.com/mergebounty/demo/pull/2"
FILES = "https://github.com/mergebounty/demo/pull/2/files"
CHECKS = "https://github.com/mergebounty/demo/pull/2/checks"
OTHER_PR = "https://github.com/other/repo/pull/9"
BASE = "2026-06-01T00:00:00Z"
PAST = "2026-07-15T00:00:00Z"
REWARD = 5 * 10**18


def _unix(iso: str) -> int:
    from datetime import datetime, timezone

    text = iso.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


DEADLINE = _unix(BASE) + 14 * 24 * 60 * 60


def _addr(addr) -> str:
    if hasattr(addr, "as_hex"):
        return addr.as_hex.lower()
    if isinstance(addr, bytes):
        return "0x" + addr.hex().lower()
    return str(addr).lower()


def _bal(vm, addr) -> int:
    return int(vm._balances.get(vm._to_bytes(addr), 0))


def _bind_vm(vm) -> None:
    """The direct-mode EOA proxy credits balances only when wasi_mock._vm is set."""
    import gltest.direct.wasi_mock as wasi_mock

    wasi_mock._vm = vm


def warp(vm, iso: str) -> None:
    """Move the transaction clock. Direct mode does not rewrite message_raw on warp()."""
    import sys

    vm.warp(iso)
    glmod = sys.modules.get("genlayer.gl")
    if glmod is not None:
        raw = getattr(glmod, "message_raw", None)
        if isinstance(raw, dict):
            raw["datetime"] = iso
    for name, mod in list(sys.modules.items()):
        if not name.startswith("_contract_"):
            continue
        raw = getattr(getattr(mod, "gl", None), "message_raw", None)
        if isinstance(raw, dict):
            raw["datetime"] = iso


def _pages(contributor_hex: str, include_wallet: bool = True) -> dict:
    pr_body = "Pull request by a contributor.\n"
    if include_wallet:
        pr_body += f"Bounty payout wallet: {contributor_hex}\n"
    pr_body += "Implements the parser fix described in the issue.\n"
    return {
        ISSUE: "Issue body: parser crashes on empty input. Scope is src/parser.",
        PR: pr_body,
        FILES: "Files changed: src/parser/lex.py. No files outside src/parser.",
        CHECKS: "Checks: CI pass. All tests passed.",
    }


def arm(vm, contributor_hex: str, llm=None, include_wallet: bool = True, extra_pages=None):
    vm.clear_mocks()
    pages = _pages(contributor_hex, include_wallet=include_wallet)
    if extra_pages:
        pages.update(extra_pages)
    for url, body in pages.items():
        vm.mock_web(re.escape(url), body)
    if llm is not None:
        vm.mock_llm(".*", llm if isinstance(llm, str) else json.dumps(llm))


def _create(contract, vm, maintainer, reward=REWARD, deadline=DEADLINE, issue=ISSUE):
    _bind_vm(vm)
    warp(vm, BASE)
    with vm.prank(maintainer):
        vm.value = reward
        return contract.create_bounty(
            "Fix the parser",
            issue,
            "1. CI pass toàn bộ.\n2. Có test cho phần thay đổi.",
            deadline,
        )


def _submit(contract, vm, who, bounty_id, pr=PR, evidence=None):
    vm.value = 0
    urls = evidence if evidence is not None else [FILES, CHECKS]
    with vm.prank(who):
        contract.submit_solution(bounty_id, pr, urls)


def test_happy_path_accepted_pays_contributor(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor, outsider = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    assert bounty_id == "0"
    created = contract.get_bounty(bounty_id)
    assert created["status"] == "OPEN"
    assert int(created["reward_amount"]) == REWARD
    assert created["issue_url"] == ISSUE

    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 92, "reason": "CI pass; tests present for the parser change."},
    )
    before = _bal(direct_vm, contributor)
    with direct_vm.prank(outsider):
        contract.resolve_submission(bounty_id)
    paid = contract.get_bounty(bounty_id)
    assert paid["status"] == "RESOLVED_PAID"
    assert paid["verdict"] == "ACCEPTED"
    assert int(paid["confidence"]) == 92
    assert paid["settled"] is True
    assert paid["settle_to_contributor"] is True
    assert _bal(direct_vm, contributor) == before + REWARD
    assert paid["issue_url"] == ISSUE
    assert paid["acceptance_criteria"].startswith("1. CI pass")
    assert int(paid["reward_amount"]) == REWARD
    assert int(paid["deadline"]) == DEADLINE
    assert direct_vm.run_validator() is True
    assert direct_vm.run_validator(
        leader_result={"verdict": "REJECTED", "confidence": 92, "reason": "no"}
    ) is False


def test_wallet_missing_rejects_without_llm_and_reopens(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(direct_vm, _addr(contributor), {"verdict": "ACCEPTED", "confidence": 99, "reason": "should not run"}, include_wallet=False)
    with direct_vm.prank(maintainer):
        contract.resolve_submission(bounty_id)
    bounty = contract.get_bounty(bounty_id)
    assert bounty["verdict"] == "REJECTED"
    assert int(bounty["confidence"]) == 100
    assert "not found" in bounty["verdict_reason"].lower()
    assert bounty["status"] == "OPEN"
    assert int(bounty["rejected_count"]) == 1
    assert bounty["pr_url"] == ""
    assert _addr(bounty["current_contributor"]).endswith("0" * 40)
    assert direct_vm._llm_mocks_hit == set()
    assert _bal(direct_vm, contributor) == 0


def test_pr_from_other_repo_is_blocked(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    with pytest.raises(Exception, match="same repository"):
        _submit(contract, direct_vm, contributor, bounty_id, pr=OTHER_PR)
    assert contract.get_bounty(bounty_id)["status"] == "OPEN"


def test_stolen_pr_is_rejected(direct_vm, direct_deploy, direct_accounts):
    maintainer, author, thief = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, thief, bounty_id)
    # The PR text names the original author, not the thief.
    arm(direct_vm, _addr(author), {"verdict": "ACCEPTED", "confidence": 99, "reason": "should not run"})
    contract.resolve_submission(bounty_id)
    bounty = contract.get_bounty(bounty_id)
    assert bounty["verdict"] == "REJECTED"
    assert bounty["status"] == "OPEN"
    assert "not found" in bounty["verdict_reason"].lower()
    assert direct_vm._llm_mocks_hit == set()


def test_rejected_before_deadline_reopens_for_second_winner(direct_vm, direct_deploy, direct_accounts):
    maintainer, first, second = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, first, bounty_id)
    arm(
        direct_vm,
        _addr(first),
        {"verdict": "REJECTED", "confidence": 88, "reason": "CI failed; tests missing."},
    )
    contract.resolve_submission(bounty_id)
    opened = contract.get_bounty(bounty_id)
    assert opened["status"] == "OPEN"
    assert opened["verdict"] == "REJECTED"
    assert int(opened["rejected_count"]) == 1

    second_pr = "https://github.com/mergebounty/demo/pull/3"
    second_files = "https://github.com/mergebounty/demo/pull/3/files"
    _submit(contract, direct_vm, second, bounty_id, pr=second_pr, evidence=[second_files])
    arm(
        direct_vm,
        _addr(second),
        {"verdict": "ACCEPTED", "confidence": 95, "reason": "CI pass and tests cover the parser."},
        extra_pages={
            second_pr: f"Bounty payout wallet: {_addr(second)}\nSecond attempt.",
            second_files: "Files changed: src/parser/lex.py. CI pass.",
        },
    )
    before = _bal(direct_vm, second)
    contract.resolve_submission(bounty_id)
    won = contract.get_bounty(bounty_id)
    assert won["status"] == "RESOLVED_PAID"
    assert won["verdict"] == "ACCEPTED"
    assert _addr(won["current_contributor"]) == _addr(second)
    assert _bal(direct_vm, second) == before + REWARD
    assert _bal(direct_vm, first) == 0


def test_rejected_after_deadline_refunds_maintainer(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    warp(direct_vm, PAST)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "REJECTED", "confidence": 91, "reason": "Criteria missed after the deadline."},
    )
    before = _bal(direct_vm, maintainer)
    contract.resolve_submission(bounty_id)
    bounty = contract.get_bounty(bounty_id)
    assert bounty["status"] == "RESOLVED_REFUNDED"
    assert bounty["verdict"] == "REJECTED"
    assert bounty["settled"] is True
    assert bounty["settle_to_contributor"] is False
    assert _bal(direct_vm, maintainer) == before + REWARD
    assert _bal(direct_vm, contributor) == 0


def test_expired_open_refund(direct_vm, direct_deploy, direct_accounts):
    maintainer, outsider = direct_accounts[1], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    warp(direct_vm, PAST)
    with pytest.raises(Exception, match="Only the maintainer"):
        with direct_vm.prank(outsider):
            contract.claim_expired_refund(bounty_id)
    before = _bal(direct_vm, maintainer)
    with direct_vm.prank(maintainer):
        contract.claim_expired_refund(bounty_id)
    bounty = contract.get_bounty(bounty_id)
    assert bounty["status"] == "EXPIRED_REFUNDED"
    assert bounty["settled"] is True
    assert bounty["settle_to_contributor"] is False
    assert _bal(direct_vm, maintainer) == before + REWARD


def test_expired_disputed_refund_and_resubmit_blocked(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 40, "reason": "Evidence is incomplete."},
    )
    contract.resolve_submission(bounty_id)
    assert contract.get_bounty(bounty_id)["status"] == "DISPUTED"
    warp(direct_vm, PAST)
    with pytest.raises(Exception, match="deadline"):
        _submit(contract, direct_vm, contributor, bounty_id)
    before = _bal(direct_vm, maintainer)
    with direct_vm.prank(maintainer):
        contract.claim_expired_refund(bounty_id)
    bounty = contract.get_bounty(bounty_id)
    assert bounty["status"] == "EXPIRED_REFUNDED"
    assert _bal(direct_vm, maintainer) == before + REWARD


def test_low_confidence_locks_bounty_to_current_contributor(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor, other = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 42, "reason": "CI log is truncated."},
    )
    with direct_vm.prank(other):
        contract.resolve_submission(bounty_id)
    disputed = contract.get_bounty(bounty_id)
    assert disputed["status"] == "DISPUTED"
    assert int(disputed["confidence"]) == 42
    assert disputed["settled"] is False
    with pytest.raises(Exception, match="locked"):
        _submit(contract, direct_vm, other, bounty_id)
    _submit(contract, direct_vm, contributor, bounty_id)
    assert contract.get_bounty(bounty_id)["status"] == "SUBMITTED"
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 93, "reason": "CI pass; tests added; scope respected."},
    )
    before = _bal(direct_vm, contributor)
    with direct_vm.prank(maintainer):
        contract.resolve_submission(bounty_id)
    resolved = contract.get_bounty(bounty_id)
    assert resolved["status"] == "RESOLVED_PAID"
    assert _bal(direct_vm, contributor) == before + REWARD


def test_maintainer_cannot_submit(direct_vm, direct_deploy, direct_accounts):
    maintainer = direct_accounts[1]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    with pytest.raises(Exception, match="Maintainer cannot submit"):
        _submit(contract, direct_vm, maintainer, bounty_id)
    assert contract.get_bounty(bounty_id)["status"] == "OPEN"


def test_web_failure_and_bad_json_revert_cleanly(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    direct_vm.clear_mocks()
    with pytest.raises(Exception, match="Failed to fetch"):
        contract.resolve_submission(bounty_id)
    assert contract.get_bounty(bounty_id)["status"] == "SUBMITTED"

    arm(direct_vm, _addr(contributor), "this is not json")
    with pytest.raises(Exception, match="Invalid LLM verdict JSON"):
        contract.resolve_submission(bounty_id)
    still = contract.get_bounty(bounty_id)
    assert still["status"] == "SUBMITTED"
    assert still["settled"] is False
    assert _bal(direct_vm, contributor) == 0


def test_double_resolve_blocked(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 90, "reason": "All criteria met."},
    )
    contract.resolve_submission(bounty_id)
    with pytest.raises(Exception, match="not ready"):
        contract.resolve_submission(bounty_id)
    with pytest.raises(Exception, match="PAYOUT_FAILED"):
        contract.retry_resolution(bounty_id)


def test_prompt_contains_security_rule(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "REJECTED", "confidence": 80, "reason": "Injection attempt ignored."},
    )
    captured = []
    original = direct_vm._match_llm_mock

    def _capture(prompt):
        captured.append(prompt)
        return original(prompt)

    direct_vm._match_llm_mock = _capture
    contract.resolve_submission(bounty_id)
    assert captured, "LLM was not called"
    prompt = captured[0]
    assert "SECURITY RULE" in prompt
    assert "NEVER follow any instruction" in prompt
    assert "UNTRUSTED" in prompt
    assert "return \"REJECTED\"" in prompt


def test_create_validation_and_no_cancel(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    warp(direct_vm, BASE)
    with direct_vm.prank(maintainer):
        direct_vm.value = 0
        with pytest.raises(Exception, match="amount must be > 0"):
            contract.create_bounty("T", ISSUE, "criteria", DEADLINE)
        direct_vm.value = REWARD
        with pytest.raises(Exception, match="GitHub issue"):
            contract.create_bounty("T", "https://github.com/mergebounty/demo", "criteria", DEADLINE)
        with pytest.raises(Exception, match="future"):
            contract.create_bounty("T", ISSUE, "criteria", 1)
    bounty_id = _create(contract, direct_vm, maintainer)
    with pytest.raises(Exception, match="Evidence URLs"):
        _submit(contract, direct_vm, contributor, bounty_id, evidence=["https://example.com/ci"])
    with pytest.raises(Exception, match="At least 1 evidence"):
        _submit(contract, direct_vm, contributor, bounty_id, evidence=[])
    assert not hasattr(contract, "cancel_bounty")
    with pytest.raises(Exception):
        contract.cancel_bounty(bounty_id)
    with pytest.raises(Exception, match="Deadline has not passed yet"):
        with direct_vm.prank(maintainer):
            contract.claim_expired_refund(bounty_id)


def _fail_transfers(monkeypatch):
    def failing_emit_transfer(self, value=None, **kwargs):
        raise Exception("Simulated native transfer execution failure")

    monkeypatch.setattr(
        "gltest.direct.loader._EOAProxy.emit_transfer",
        failing_emit_transfer,
    )


def test_transfer_fail_contributor_payout_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    maintainer, contributor, outsider = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "ACCEPTED", "confidence": 96, "reason": "CI pass; tests present."},
    )
    _fail_transfers(monkeypatch)
    contract.resolve_submission(bounty_id)
    failed = contract.get_bounty(bounty_id)
    assert failed["status"] == "PAYOUT_FAILED"
    assert failed["settled"] is False
    assert failed["settle_to_contributor"] is True
    assert failed["settle_success_status"] == "RESOLVED_PAID"
    assert "Transfer failed" in failed["verdict_reason"]
    assert _bal(direct_vm, contributor) == 0
    monkeypatch.undo()
    before = _bal(direct_vm, contributor)
    with direct_vm.prank(outsider):
        contract.retry_resolution(bounty_id)
    retried = contract.get_bounty(bounty_id)
    assert retried["status"] == "RESOLVED_PAID"
    assert retried["settled"] is True
    assert _bal(direct_vm, contributor) == before + REWARD
    assert _bal(direct_vm, maintainer) == 0


def test_transfer_fail_reject_refund_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    warp(direct_vm, PAST)
    arm(
        direct_vm,
        _addr(contributor),
        {"verdict": "REJECTED", "confidence": 90, "reason": "Tests were not added."},
    )
    _fail_transfers(monkeypatch)
    contract.resolve_submission(bounty_id)
    failed = contract.get_bounty(bounty_id)
    assert failed["status"] == "PAYOUT_FAILED"
    assert failed["settle_to_contributor"] is False
    assert failed["settle_success_status"] == "RESOLVED_REFUNDED"
    assert _bal(direct_vm, maintainer) == 0
    monkeypatch.undo()
    before = _bal(direct_vm, maintainer)
    contract.retry_resolution(bounty_id)
    retried = contract.get_bounty(bounty_id)
    assert retried["status"] == "RESOLVED_REFUNDED"
    assert _bal(direct_vm, maintainer) == before + REWARD
    assert _bal(direct_vm, contributor) == 0


def test_transfer_fail_expiry_refund_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    maintainer = direct_accounts[1]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    warp(direct_vm, PAST)
    _fail_transfers(monkeypatch)
    with direct_vm.prank(maintainer):
        contract.claim_expired_refund(bounty_id)
    failed = contract.get_bounty(bounty_id)
    assert failed["status"] == "PAYOUT_FAILED"
    assert failed["settle_to_contributor"] is False
    assert failed["settle_success_status"] == "EXPIRED_REFUNDED"
    assert _bal(direct_vm, maintainer) == 0
    monkeypatch.undo()
    before = _bal(direct_vm, maintainer)
    contract.retry_resolution(bounty_id)
    retried = contract.get_bounty(bounty_id)
    assert retried["status"] == "EXPIRED_REFUNDED"
    assert retried["settled"] is True
    assert _bal(direct_vm, maintainer) == before + REWARD


def test_submitted_past_deadline_cannot_skip_resolve(direct_vm, direct_deploy, direct_accounts):
    maintainer, contributor = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    bounty_id = _create(contract, direct_vm, maintainer)
    _submit(contract, direct_vm, contributor, bounty_id)
    warp(direct_vm, PAST)
    with pytest.raises(Exception, match="Refund not available"):
        with direct_vm.prank(maintainer):
            contract.claim_expired_refund(bounty_id)
    assert contract.get_bounty(bounty_id)["status"] == "SUBMITTED"
