# GitHub Stacks reference snapshot

[SKILL.md](SKILL.md) and [references/](references/) are unchanged copies of
`github/gh-stack:skills/gh-stack/` at the upstream commit in
[source.json](source.json). Copyright GitHub, Inc., distributed under the
upstream MIT [license](LICENSE) from that commit.

This project-local reference is explicitly attached only to the Ship Agent.
It does not install the `gh stack` extension, enable GitHub Stacks, authorize
writes, or override the repository's delivery safeguards. Check availability
and command side effects before use.

Update the snapshot and its source commit together after human review. Keep
the upstream bytes unchanged, including whitespace. The existing weekly drift
checker compares the skill and its references with upstream.
