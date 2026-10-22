# Contributing

Contributions are welcome. Please keep changes focused and avoid unrelated refactors.

## Before opening a pull request

Open an issue first for:

- New features
- Breaking changes
- Significant behavioral changes
- Substantial refactors

This allows the proposed direction to be discussed before implementation work begins.

Bug fixes, documentation changes, tests, and small maintenance improvements may be submitted directly as pull requests.

If an issue already exists, link it from the pull request using `Fixes #123` or `Closes #123`.

## Pull requests

- Keep each pull request focused on one change.
- Clearly describe the problem being solved and the approach taken.
- Include relevant tests when behavior changes.
- Run the repository's validation checks before submitting.
- Avoid unrelated formatting or cleanup changes.
- Use a Conventional Commit formatted pull request title.

Pull requests are squash-merged, so the pull request title becomes the commit message on `main` and is used by the release workflow.

Examples:

```text
feat: add delegated launch metadata
fix: preserve cleanup history
docs: clarify container setup
test: cover interrupted delegation
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

Individual commits should follow the same convention, although the pull request title is particularly important because it becomes the squash-merge commit.

## AI-assisted contributions

AI-assisted contributions are welcome, but contributors remain responsible for understanding, reviewing, and testing the code they submit.

## Public disclosure safety

Before publishing to GitHub or other public destinations, review the complete
outgoing material, including changes and commit metadata, issue and pull
request text, comments, validation output, logs, screenshots, and attachments.
Remove secrets, personal information, confidential content, and private
infrastructure details. Use synthetic or non-reconstructable placeholders where
technical evidence is needed. Automated checks cannot replace this review.

If sensitive information is exposed, avoid reproducing it publicly, revoke or
rotate compromised credentials promptly, and coordinate remediation privately.
For security vulnerabilities, use the private reporting guidance below.

## Security issues

Please do not report security vulnerabilities in public issues.

Use GitHub's private vulnerability reporting or another private contact method instead.
