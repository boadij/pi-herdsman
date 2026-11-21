# Community Contributors

Thank you to everyone who has meaningfully contributed to Pi Herdsman's
development through code, bug reports, investigations, testing, technical
discussions, and ideas.

These acknowledgments recognize documented contributions that helped improve
the project, deepen understanding, or inform its technical direction.
Contributions do not need to result in merged code or accepted proposals to
qualify.

This is not a ranking or exhaustive history. Credit reflects each person's
actual contribution, without attributing implementations to people who did not
author them. Corrections and additions are welcome.

- **[@767251930](https://github.com/767251930)** - Fixed Windows extended-path handling for repository and worktree identity ([PR #663](https://github.com/boadij/pi-herdsman/pull/663)).

- **[@aholbreich](https://github.com/aholbreich)** - Preserved provider failure causes and failed model identity in managed-Agent execution-error results ([PR #966](https://github.com/boadij/pi-herdsman/pull/966)).

- **[@Audrique](https://github.com/Audrique)** - Requested NixOS installation support and verified that a community-provided Nix derivation works without maintaining a fork ([issue #327](https://github.com/boadij/pi-herdsman/issues/327)).

- **[@awerner](https://github.com/awerner)** - Investigated Manager tool-selection failures and Agent model restoration and extension discovery ([issue #832](https://github.com/boadij/pi-herdsman/issues/832), [issue #853](https://github.com/boadij/pi-herdsman/issues/853), [issue #882](https://github.com/boadij/pi-herdsman/issues/882); follow-up [PR #868](https://github.com/boadij/pi-herdsman/pull/868), [PR #864](https://github.com/boadij/pi-herdsman/pull/864), [PR #883](https://github.com/boadij/pi-herdsman/pull/883)).

- **[@Battlelamb](https://github.com/Battlelamb)** - Reported Agent discovery failures, Code Mode interoperability limitations, and an extension tool-name collision ([issue #880](https://github.com/boadij/pi-herdsman/issues/880), [issue #881](https://github.com/boadij/pi-herdsman/issues/881), [issue #869](https://github.com/boadij/pi-herdsman/issues/869); follow-up [PR #884](https://github.com/boadij/pi-herdsman/pull/884), [PR #885](https://github.com/boadij/pi-herdsman/pull/885)).

- **[@chsdwn](https://github.com/chsdwn)** - Reproduced a zsh prompt-hook race during Agent startup ([issue #168](https://github.com/boadij/pi-herdsman/issues/168); follow-up [PR #169](https://github.com/boadij/pi-herdsman/pull/169)).

- **[@cray-com](https://github.com/cray-com)** - Identified repeated full-transcript reads in status and supervision refreshes ([issue #228](https://github.com/boadij/pi-herdsman/issues/228); follow-up [PR #229](https://github.com/boadij/pi-herdsman/pull/229)).

- **[@FireTheDevil](https://github.com/FireTheDevil)** - Helped shape and test managed-Agent context sharing ([issue #232](https://github.com/boadij/pi-herdsman/issues/232); [PR #329](https://github.com/boadij/pi-herdsman/pull/329)), lean capability discovery ([issue #367](https://github.com/boadij/pi-herdsman/issues/367); [PR #380](https://github.com/boadij/pi-herdsman/pull/380)), and dynamic tool inheritance ([issue #451](https://github.com/boadij/pi-herdsman/issues/451); [PR #463](https://github.com/boadij/pi-herdsman/pull/463)).

- **[@G4bar](https://github.com/G4bar)** - Researched an opt-in project memory proposal with a prototype, tests, and benchmarks, helping clarify the boundary with standalone Pi extensions ([issue #410](https://github.com/boadij/pi-herdsman/issues/410)).

- **[@gian-reto](https://github.com/gian-reto)** - Shared a working declarative Nix derivation for Pi Herdsman, demonstrating an installation approach without requiring a dedicated flake ([issue #327](https://github.com/boadij/pi-herdsman/issues/327)).

- **[@gnuts](https://github.com/gnuts)** - Shared multi-repository and cross-model review experience, highlighting supervision challenges and motivating an on-demand workflow guide and opt-in cross-directory delegation ([discussion #179](https://github.com/boadij/pi-herdsman/discussions/179); follow-up [PR #1054](https://github.com/boadij/pi-herdsman/pull/1054), [PR #1058](https://github.com/boadij/pi-herdsman/pull/1058)).

- **[@jadc](https://github.com/jadc)** - Identified shell-history pollution from automatically launched Pi commands, prompting discussion of an upstream Herdr improvement ([issue #143](https://github.com/boadij/pi-herdsman/issues/143)).

- **[@jszaday](https://github.com/jszaday)** - Implemented configurable Agent nesting and prompt visibility of nested descendants, and proposed nonblocking owner notifications ([PR #866](https://github.com/boadij/pi-herdsman/pull/866), [PR #877](https://github.com/boadij/pi-herdsman/pull/877), [issue #908](https://github.com/boadij/pi-herdsman/issues/908); follow-up [PR #917](https://github.com/boadij/pi-herdsman/pull/917)).

- **[@kozer](https://github.com/kozer)** - Fixed delegated-child model resolution for extension-provided providers and preserved useful startup failures ([PR #139](https://github.com/boadij/pi-herdsman/pull/139), [PR #140](https://github.com/boadij/pi-herdsman/pull/140)).

- **[@leakless21](https://github.com/leakless21)** - Diagnosed and fixed safe shell settlement when prompt hooks share a foreground process group ([issue #386](https://github.com/boadij/pi-herdsman/issues/386), [PR #388](https://github.com/boadij/pi-herdsman/pull/388)).

- **[@Lellarap](https://github.com/Lellarap)** - Diagnosed provider-incompatible tool schemas with a minimal reproduction ([issue #132](https://github.com/boadij/pi-herdsman/issues/132); follow-up [PR #133](https://github.com/boadij/pi-herdsman/pull/133)).

- **[@mcdp-adk](https://github.com/mcdp-adk)** - Reproduced and traced the loss of late-activated Code Mode and MCP tools during session-tree navigation ([issue #1006](https://github.com/boadij/pi-herdsman/issues/1006); follow-up [PR #1010](https://github.com/boadij/pi-herdsman/pull/1010)).

- **[@mdorman](https://github.com/mdorman)** - Reproduced incorrect Manager/repository message routing and blocking worktree-removal confirmation ([issue #636](https://github.com/boadij/pi-herdsman/issues/636), [issue #469](https://github.com/boadij/pi-herdsman/issues/469)).

- **[@morningwn](https://github.com/morningwn)** - Fixed inherited-tool handling with Pi's order-preserving selections ([PR #792](https://github.com/boadij/pi-herdsman/pull/792)) and identified lost attachment-error context in Agent results ([issue #870](https://github.com/boadij/pi-herdsman/issues/870); follow-up [PR #874](https://github.com/boadij/pi-herdsman/pull/874)).

- **[@nathannli](https://github.com/nathannli)** - Investigated Pi-Bolt compatibility, reported agent visibility differences, and identified relevant upstream Herdr integration work ([issue #369](https://github.com/boadij/pi-herdsman/issues/369)).

- **[@notsonormal](https://github.com/notsonormal)** - Reported Anthropic strict-schema failures and confirmed the correction ([issue #236](https://github.com/boadij/pi-herdsman/issues/236); follow-up [PR #239](https://github.com/boadij/pi-herdsman/pull/239)).

- **[@patresio](https://github.com/patresio)** - Fixed repository detection under non-English Git locales, restoring normal Lead tools ([PR #835](https://github.com/boadij/pi-herdsman/pull/835)).

- **[@primetimetank21](https://github.com/primetimetank21)** - Prevented unavailable close actions from being advertised while Agent results were pending ([PR #107](https://github.com/boadij/pi-herdsman/pull/107)) and advanced the design discussion on task-scoped specialist, model, and thinking-level selection ([issue #1043](https://github.com/boadij/pi-herdsman/issues/1043)).

- **[@punk-dev-robot](https://github.com/punk-dev-robot)** - Fixed discovery of symlinked Agent definitions, including disabled overlays ([issue #390](https://github.com/boadij/pi-herdsman/issues/390), [PR #392](https://github.com/boadij/pi-herdsman/pull/392)).

- **[@raphaelbahat](https://github.com/raphaelbahat)** - Explored explicit delegation dependencies and the Manager/runtime scheduling boundary ([issue #343](https://github.com/boadij/pi-herdsman/issues/343)), and reproduced incorrect Pi agent-directory inheritance in Manager-created worktree Leads ([issue #1072](https://github.com/boadij/pi-herdsman/issues/1072); follow-up [PR #1076](https://github.com/boadij/pi-herdsman/pull/1076)).

- **[@teddyhwang](https://github.com/teddyhwang)** - Identified misleading shell-tool guidance for read-only Agents ([issue #395](https://github.com/boadij/pi-herdsman/issues/395); follow-up [PR #396](https://github.com/boadij/pi-herdsman/pull/396)) and documented the operational cost of managed-Agent startup timeouts after child exit ([issue #1002](https://github.com/boadij/pi-herdsman/issues/1002)).

- **[@teicheld](https://github.com/teicheld)** - Traced Chief's inability to discover ordinary Leads outside Git repositories and reproduced Manager-to-Chief reply delivery failures on a fresh default installation ([issue #918](https://github.com/boadij/pi-herdsman/issues/918), [issue #1045](https://github.com/boadij/pi-herdsman/issues/1045); follow-up [PR #937](https://github.com/boadij/pi-herdsman/pull/937), [PR #1050](https://github.com/boadij/pi-herdsman/pull/1050)).

- **[@tsubus](https://github.com/tsubus)** - Reported repeated invalid delegation attempts that exposed a tool-input regression ([issue #146](https://github.com/boadij/pi-herdsman/issues/146); follow-up [PR #148](https://github.com/boadij/pi-herdsman/pull/148)).

- **[@urioTV](https://github.com/urioTV)** - Traced malformed delegation arguments to non-portable provider-facing schema patterns ([issue #432](https://github.com/boadij/pi-herdsman/issues/432); follow-up [PR #433](https://github.com/boadij/pi-herdsman/pull/433)).

- **[@vitaliyslion](https://github.com/vitaliyslion)** - Reproduced invalid Agent tool inputs and confirmed delegation after the fix ([issue #150](https://github.com/boadij/pi-herdsman/issues/150); follow-up [PR #148](https://github.com/boadij/pi-herdsman/pull/148)).

For the full history, see [issues](https://github.com/boadij/pi-herdsman/issues),
[pull requests](https://github.com/boadij/pi-herdsman/pulls), and [GitHub's contributor graph](https://github.com/boadij/pi-herdsman/graphs/contributors).
