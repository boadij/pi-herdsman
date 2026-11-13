# Community Contributors

Thank you to everyone who improves Pi Herdsman through code, bug reports,
investigations, testing, and ideas.

These acknowledgments highlight documented contributions, not a ranking or an
exhaustive history. A linked follow-up PR does not imply the issue reporter
authored the fix. Corrections and additions are welcome.

- **[@767251930](https://github.com/767251930)** - Fixed Windows extended-path handling for repository and worktree identity ([PR #663](https://github.com/boadij/pi-herdsman/pull/663)).

- **[@awerner](https://github.com/awerner)** - Investigated Manager tool-selection failures and Agent model restoration and extension discovery ([issue #832](https://github.com/boadij/pi-herdsman/issues/832), [issue #853](https://github.com/boadij/pi-herdsman/issues/853), [issue #882](https://github.com/boadij/pi-herdsman/issues/882); follow-up [PR #868](https://github.com/boadij/pi-herdsman/pull/868), [PR #864](https://github.com/boadij/pi-herdsman/pull/864), [PR #883](https://github.com/boadij/pi-herdsman/pull/883)).

- **[@Battlelamb](https://github.com/Battlelamb)** - Reported Agent discovery failures, Code Mode interoperability limitations, and an extension tool-name collision ([issue #880](https://github.com/boadij/pi-herdsman/issues/880), [issue #881](https://github.com/boadij/pi-herdsman/issues/881), [issue #869](https://github.com/boadij/pi-herdsman/issues/869); follow-up [PR #884](https://github.com/boadij/pi-herdsman/pull/884), [PR #885](https://github.com/boadij/pi-herdsman/pull/885)).

- **[@chsdwn](https://github.com/chsdwn)** - Reproduced a zsh prompt-hook race during Agent startup ([issue #168](https://github.com/boadij/pi-herdsman/issues/168); follow-up [PR #169](https://github.com/boadij/pi-herdsman/pull/169)).

- **[@cray-com](https://github.com/cray-com)** - Identified repeated full-transcript reads in status and supervision refreshes ([issue #228](https://github.com/boadij/pi-herdsman/issues/228); follow-up [PR #229](https://github.com/boadij/pi-herdsman/pull/229)).

- **[@FireTheDevil](https://github.com/FireTheDevil)** - Helped drive managed-Agent context sharing and lean definition discovery, and diagnosed and verified dynamic tool inheritance fixes ([issue #232](https://github.com/boadij/pi-herdsman/issues/232), [issue #367](https://github.com/boadij/pi-herdsman/issues/367), [issue #451](https://github.com/boadij/pi-herdsman/issues/451)).

- **[@G4bar](https://github.com/G4bar)** - Researched an opt-in project memory proposal with a prototype, tests, and benchmarks, helping clarify the boundary with standalone Pi extensions ([issue #410](https://github.com/boadij/pi-herdsman/issues/410)).

- **[@jszaday](https://github.com/jszaday)** - Implemented configurable Agent nesting and prompt visibility of nested descendants, and proposed nonblocking owner notifications ([PR #866](https://github.com/boadij/pi-herdsman/pull/866), [PR #877](https://github.com/boadij/pi-herdsman/pull/877), [issue #908](https://github.com/boadij/pi-herdsman/issues/908); follow-up [PR #917](https://github.com/boadij/pi-herdsman/pull/917)).

- **[@kozer](https://github.com/kozer)** - Fixed delegated-child model resolution for extension-provided providers and preserved useful startup failures ([PR #139](https://github.com/boadij/pi-herdsman/pull/139), [PR #140](https://github.com/boadij/pi-herdsman/pull/140)).

- **[@leakless21](https://github.com/leakless21)** - Diagnosed and fixed safe shell settlement when prompt hooks share a foreground process group ([issue #386](https://github.com/boadij/pi-herdsman/issues/386), [PR #388](https://github.com/boadij/pi-herdsman/pull/388)).

- **[@Lellarap](https://github.com/Lellarap)** - Diagnosed provider-incompatible tool schemas with a minimal reproduction ([issue #132](https://github.com/boadij/pi-herdsman/issues/132); follow-up [PR #133](https://github.com/boadij/pi-herdsman/pull/133)).

- **[@mdorman](https://github.com/mdorman)** - Reproduced incorrect Manager/repository message routing and blocking worktree-removal confirmation ([issue #636](https://github.com/boadij/pi-herdsman/issues/636), [issue #469](https://github.com/boadij/pi-herdsman/issues/469)).

- **[@morningwn](https://github.com/morningwn)** - Fixed inherited-tool handling with Pi's order-preserving selections and reported missing attachment errors ([PR #792](https://github.com/boadij/pi-herdsman/pull/792), [issue #870](https://github.com/boadij/pi-herdsman/issues/870)).

- **[@notsonormal](https://github.com/notsonormal)** - Reported Anthropic strict-schema failures and confirmed the correction ([issue #236](https://github.com/boadij/pi-herdsman/issues/236); follow-up [PR #239](https://github.com/boadij/pi-herdsman/pull/239)).

- **[@patresio](https://github.com/patresio)** - Fixed repository detection under non-English Git locales, restoring normal Lead tools ([PR #835](https://github.com/boadij/pi-herdsman/pull/835)).

- **[@primetimetank21](https://github.com/primetimetank21)** - Prevented unavailable close actions from being advertised while Agent results were pending ([PR #107](https://github.com/boadij/pi-herdsman/pull/107)).

- **[@punk-dev-robot](https://github.com/punk-dev-robot)** - Fixed discovery of symlinked Agent definitions, including disabled overlays ([issue #390](https://github.com/boadij/pi-herdsman/issues/390), [PR #392](https://github.com/boadij/pi-herdsman/pull/392)).

- **[@teddyhwang](https://github.com/teddyhwang)** - Identified shell-tool guidance given to Agents without shell access ([issue #395](https://github.com/boadij/pi-herdsman/issues/395); follow-up [PR #396](https://github.com/boadij/pi-herdsman/pull/396)).

- **[@teicheld](https://github.com/teicheld)** - Traced Chief's inability to discover ordinary Leads outside Git repositories ([issue #918](https://github.com/boadij/pi-herdsman/issues/918); follow-up [PR #937](https://github.com/boadij/pi-herdsman/pull/937)).

- **[@tsubus](https://github.com/tsubus)** - Reported repeated invalid delegation attempts that exposed a tool-input regression ([issue #146](https://github.com/boadij/pi-herdsman/issues/146); follow-up [PR #148](https://github.com/boadij/pi-herdsman/pull/148)).

- **[@urioTV](https://github.com/urioTV)** - Traced malformed delegation arguments to non-portable provider-facing schema patterns ([issue #432](https://github.com/boadij/pi-herdsman/issues/432); follow-up [PR #433](https://github.com/boadij/pi-herdsman/pull/433)).

- **[@vitaliyslion](https://github.com/vitaliyslion)** - Reproduced invalid Agent tool inputs and confirmed delegation after the fix ([issue #150](https://github.com/boadij/pi-herdsman/issues/150); follow-up [PR #148](https://github.com/boadij/pi-herdsman/pull/148)).

For the full history, see [issues](https://github.com/boadij/pi-herdsman/issues),
[pull requests](https://github.com/boadij/pi-herdsman/pulls), and [GitHub's contributor graph](https://github.com/boadij/pi-herdsman/graphs/contributors).
