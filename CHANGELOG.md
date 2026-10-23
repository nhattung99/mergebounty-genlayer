# Changelog

## 2.0.0 — 2026-10-23

Submission preflight. The contract and the escrow address are unchanged.

- A solution stays disabled until five checks pass: a contributor wallet is connected, that wallet is not the maintainer, the pull request belongs to the issue repository, and the evidence includes that pull request's Files changed page and Checks page.
- One button fills those two evidence links from the pull request URL.
- Creating a bounty now warns that a CI criterion needs a real green check.

Before this release, any `https://github.com/` evidence link could be submitted, including a link from another repository or a pull request page with no Files or Checks evidence. After this release, those submissions cannot be sent.
