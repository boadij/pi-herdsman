# Changelog

## [0.21.1](https://github.com/boadij/pi-herdsman/compare/v0.21.0...v0.21.1) (2026-10-06)


### Fixes

* **agent:** project direct ownership into managed Agent context ([#287](https://github.com/boadij/pi-herdsman/issues/287)) ([3fa80a6](https://github.com/boadij/pi-herdsman/commit/3fa80a6c74070efec418d22e0a0551070afde0b4))
* **runtime:** adopt Pi 1.0.4 with closed tool policy ([#286](https://github.com/boadij/pi-herdsman/issues/286)) ([e92f58d](https://github.com/boadij/pi-herdsman/commit/e92f58dc418de5d2812d1a2de095b9e5525deab3))
* **ui:** restore Lead ancestry in delegating Agent breadcrumbs ([#283](https://github.com/boadij/pi-herdsman/issues/283)) ([ce22333](https://github.com/boadij/pi-herdsman/commit/ce223336408ae11109e4a1315b98df2d0177e460))

## [0.21.0](https://github.com/boadij/pi-herdsman/compare/v0.20.1...v0.21.0) (2026-10-05)


### Features

* **config:** add Agent-definition management skill ([#271](https://github.com/boadij/pi-herdsman/issues/271)) ([47e8714](https://github.com/boadij/pi-herdsman/commit/47e87148936489157d12d377c92b8a23d7db2fb0))


### Fixes

* **manager:** consume delivered project messages ([#269](https://github.com/boadij/pi-herdsman/issues/269)) ([fd71d4d](https://github.com/boadij/pi-herdsman/commit/fd71d4d4f62be7610cd3ec9835e9699382a4dcec))
* **presentation:** preserve staff project context ([#268](https://github.com/boadij/pi-herdsman/issues/268)) ([e154b97](https://github.com/boadij/pi-herdsman/commit/e154b976fa4ac722772ed57459d44fff4c71b518))
* **release:** publish preview tarball locally ([#276](https://github.com/boadij/pi-herdsman/issues/276)) ([b680574](https://github.com/boadij/pi-herdsman/commit/b6805746289c83c4ef2af8d0be901ba143a18e60))
* **release:** tag preview dry-run publish ([#275](https://github.com/boadij/pi-herdsman/issues/275)) ([dea6768](https://github.com/boadij/pi-herdsman/commit/dea6768582384ef7978edda93c06f6a9ba7259ad))
* **supervision:** steer active direct reports ([#272](https://github.com/boadij/pi-herdsman/issues/272)) ([ee69e58](https://github.com/boadij/pi-herdsman/commit/ee69e582759f2c43a33f4589877cdaa8a38123e0))


### Documentation

* make positive steering structural ([#263](https://github.com/boadij/pi-herdsman/issues/263)) ([7595a37](https://github.com/boadij/pi-herdsman/commit/7595a37602884f73701ef2ddb218dfb0287228bb))

## [0.20.1](https://github.com/boadij/pi-herdsman/compare/v0.20.0...v0.20.1) (2026-10-04)


### Fixes

* **stats:** avoid global session discovery for Manager stats ([#258](https://github.com/boadij/pi-herdsman/issues/258)) ([7dcc10e](https://github.com/boadij/pi-herdsman/commit/7dcc10ecae85aeb49abd2d28bc6151c8f98d74ec))
* **ui:** identify Lead role in status widget ([#259](https://github.com/boadij/pi-herdsman/issues/259)) ([a819aeb](https://github.com/boadij/pi-herdsman/commit/a819aebbe003ba3e4df189fc5ba68bc1496f5121))

## [0.20.0](https://github.com/boadij/pi-herdsman/compare/v0.19.1...v0.20.0) (2026-10-04)


### Features

* **config:** expose managed Lead settings in Definitions ([#249](https://github.com/boadij/pi-herdsman/issues/249)) ([df361e0](https://github.com/boadij/pi-herdsman/commit/df361e010941cb310446cb374bf91fb14ea29b4c))
* **config:** make managed project Leads definition-driven ([#247](https://github.com/boadij/pi-herdsman/issues/247)) ([e489fe0](https://github.com/boadij/pi-herdsman/commit/e489fe05bc9664c6739103ac91eb4278763d2496))
* **manager:** support optional automatic activation ([#245](https://github.com/boadij/pi-herdsman/issues/245)) ([1405eb4](https://github.com/boadij/pi-herdsman/commit/1405eb460bb5dc2a0ee44945de20bc5fe79fbc2a))
* **stats:** include managed Lead trees in Manager session stats ([#255](https://github.com/boadij/pi-herdsman/issues/255)) ([0152a93](https://github.com/boadij/pi-herdsman/commit/0152a9348c6375728707bb1c9b28e3f0ae12ec1d))
* **ui:** unify Herdsman management menus ([#254](https://github.com/boadij/pi-herdsman/issues/254)) ([900f585](https://github.com/boadij/pi-herdsman/commit/900f585fd7a6bc32db4341580dcb0aea6c17cb8a))


### Fixes

* **installer:** preserve native runtime update paths ([#240](https://github.com/boadij/pi-herdsman/issues/240)) ([bf5d7c2](https://github.com/boadij/pi-herdsman/commit/bf5d7c23ccc204a54a03398def40f4dd33397546))
* **manager:** hand off project Lead responses without Agent runs ([#252](https://github.com/boadij/pi-herdsman/issues/252)) ([99a8843](https://github.com/boadij/pi-herdsman/commit/99a884324f97b900980a88c91b69dedf0fe0d5b8))
* **manager:** prevent project message replay after tree navigation ([#241](https://github.com/boadij/pi-herdsman/issues/241)) ([387d232](https://github.com/boadij/pi-herdsman/commit/387d23261482d3d59f00233159968343f61d79bb))
* **presentation:** clarify coordination identity and Chief hierarchy ([#244](https://github.com/boadij/pi-herdsman/issues/244)) ([335d195](https://github.com/boadij/pi-herdsman/commit/335d195a38d360fb3789e711af014f36e550527b))
* **smoke:** enforce package runtime baselines ([#251](https://github.com/boadij/pi-herdsman/issues/251)) ([1094a43](https://github.com/boadij/pi-herdsman/commit/1094a43b9e1272953d30ec9638c1ea9366c3a625))
* **tools:** stop opting into provider strict sampling ([#239](https://github.com/boadij/pi-herdsman/issues/239)) ([71a4208](https://github.com/boadij/pi-herdsman/commit/71a4208e10f61fb517b3e5bf8c6c9c5d1f5d9491))


### Refactoring

* **coordination:** harden Lead runtime contract ([#253](https://github.com/boadij/pi-herdsman/issues/253)) ([9e5bbd7](https://github.com/boadij/pi-herdsman/commit/9e5bbd7bc81afedbd95623a4ca4b2af89487a25e))
* **runtime:** extract extension runtime boundaries ([#238](https://github.com/boadij/pi-herdsman/issues/238)) ([4b3747b](https://github.com/boadij/pi-herdsman/commit/4b3747bb9eaaf9e1410724627aa7ac86e09ffc6e))


### Documentation

* **adr:** use integration-agnostic orchestration primitives ([#234](https://github.com/boadij/pi-herdsman/issues/234)) ([6f166a6](https://github.com/boadij/pi-herdsman/commit/6f166a67e997791a6bc25d38cbcf4dcea14ce470))
* define product philosophy ([#233](https://github.com/boadij/pi-herdsman/issues/233)) ([31e0865](https://github.com/boadij/pi-herdsman/commit/31e0865f242b936c3782a042693beb83cb5b8a94))

## [0.19.1](https://github.com/boadij/pi-herdsman/compare/v0.19.0...v0.19.1) (2026-10-02)


### Performance

* make periodic status and supervision transcript-free ([#229](https://github.com/boadij/pi-herdsman/issues/229)) ([f4f249a](https://github.com/boadij/pi-herdsman/commit/f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80))

## [0.19.0](https://github.com/boadij/pi-herdsman/compare/v0.18.0...v0.19.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* add project-scoped Manager work orchestration ([#144](https://github.com/boadij/pi-herdsman/issues/144))

### Features

* add owned session usage stats ([#177](https://github.com/boadij/pi-herdsman/issues/177)) ([5d1800c](https://github.com/boadij/pi-herdsman/commit/5d1800c657017a2de1d4403820885455663f9fd5))
* add project-scoped Manager work orchestration ([#144](https://github.com/boadij/pi-herdsman/issues/144)) ([8f389b7](https://github.com/boadij/pi-herdsman/commit/8f389b71464e4a9582bedb3558496d4306a76608))
* **manager:** automate project handoffs and supervisor awareness ([#201](https://github.com/boadij/pi-herdsman/issues/201)) ([5909f7d](https://github.com/boadij/pi-herdsman/commit/5909f7dc82ff51bdf197c841badee9be30729e9c))
* reject incompatible live Herdsman builds ([#219](https://github.com/boadij/pi-herdsman/issues/219)) ([fd2de5a](https://github.com/boadij/pi-herdsman/commit/fd2de5af43bc0eac21432afe28651092c22c61dd))
* **ui:** align supervision with Lead status ([#215](https://github.com/boadij/pi-herdsman/issues/215)) ([d77655e](https://github.com/boadij/pi-herdsman/commit/d77655e15c171b35afe964312d72b3488d267687))


### Fixes

* allocate semantic result refs globally ([#213](https://github.com/boadij/pi-herdsman/issues/213)) ([9688a33](https://github.com/boadij/pi-herdsman/commit/9688a3392f01faec64391ae0062b992854b6c8f2))
* **context:** place pre-turn synthetic context before user message ([#221](https://github.com/boadij/pi-herdsman/issues/221)) ([b38a6d3](https://github.com/boadij/pi-herdsman/commit/b38a6d384df5dfb6ecc78c3c981ce8e80fa68e51))
* **coordination:** make file handoff guidance consistent across roles ([#223](https://github.com/boadij/pi-herdsman/issues/223)) ([e75a7dd](https://github.com/boadij/pi-herdsman/commit/e75a7dd700df4323cf32bf9cf046dc5a1f21c117))
* keep bootstrap-installed extension updateable ([#175](https://github.com/boadij/pi-herdsman/issues/175)) ([bace16d](https://github.com/boadij/pi-herdsman/commit/bace16daa07791ad67bdb742da975456ce7dc553))
* **manager:** align project assignment payload limits ([#217](https://github.com/boadij/pi-herdsman/issues/217)) ([01f9b27](https://github.com/boadij/pi-herdsman/commit/01f9b271383514af435cd3699627b205e153467e))
* **presentation:** restore project message rendering ([#216](https://github.com/boadij/pi-herdsman/issues/216)) ([40cb1a2](https://github.com/boadij/pi-herdsman/commit/40cb1a2e27f2bac239f8d90f710dcc6c74ea4271))
* preserve semantic result refs across handoffs ([#211](https://github.com/boadij/pi-herdsman/issues/211)) ([5a29780](https://github.com/boadij/pi-herdsman/commit/5a29780fe346ad08fde26851d2b7dd6c117f8cb6))


### Refactoring

* **coordination:** make managed Leads orchestration-first ([#224](https://github.com/boadij/pi-herdsman/issues/224)) ([85a4ddf](https://github.com/boadij/pi-herdsman/commit/85a4ddf721158c9650df1bd15b643b2153bdd7f7))
* **manager:** make project lifecycle manager-owned ([#196](https://github.com/boadij/pi-herdsman/issues/196)) ([156b1c6](https://github.com/boadij/pi-herdsman/commit/156b1c661a2e147d6bb2ef415abe44dd6b11af2f))
* **manager:** retire project work on worktree removal ([#226](https://github.com/boadij/pi-herdsman/issues/226)) ([ad403ad](https://github.com/boadij/pi-herdsman/commit/ad403ad4c3d78b07c2f449e5a57f38f00206fc74))
* **manager:** split staff_delegate and staff_resume ([#220](https://github.com/boadij/pi-herdsman/issues/220)) ([382a188](https://github.com/boadij/pi-herdsman/commit/382a18800198b082730d89cd4132d38d25b5d669)), closes [#197](https://github.com/boadij/pi-herdsman/issues/197)


### Documentation

* add community discussions link ([98e5bf8](https://github.com/boadij/pi-herdsman/commit/98e5bf8659c37dd60c6ee4b53ea6aadf09dcc58a))
* **adr:** preserve prompt-cache continuity and pre-compaction retirement ([#191](https://github.com/boadij/pi-herdsman/issues/191)) ([464b3d6](https://github.com/boadij/pi-herdsman/commit/464b3d62bdda7bca853617f89b068dfe6ca88f1a))
* backfill architecture decisions ([#188](https://github.com/boadij/pi-herdsman/issues/188)) ([d35eb33](https://github.com/boadij/pi-herdsman/commit/d35eb33998a51d0f8cb71cdcbcdc151da90b5b35))
* establish architecture decision records ([#186](https://github.com/boadij/pi-herdsman/issues/186)) ([7c7ecda](https://github.com/boadij/pi-herdsman/commit/7c7ecda1937aafc11e1f8c281464f56771f4a374))
* install dependencies before local validation ([#212](https://github.com/boadij/pi-herdsman/issues/212)) ([3e7692b](https://github.com/boadij/pi-herdsman/commit/3e7692b7540fcd8f283bfb7c21ebd69add95dc03))
* prefer positive steering in agent instructions ([#193](https://github.com/boadij/pi-herdsman/issues/193)) ([077366b](https://github.com/boadij/pi-herdsman/commit/077366b58ae4b4d67a4b57d6bf250930f0b4c30f))
* redesign README and documentation architecture ([#182](https://github.com/boadij/pi-herdsman/issues/182)) ([a209ff7](https://github.com/boadij/pi-herdsman/commit/a209ff79d0436120cf7adfb7d6850b8616b4d0c5))


### Tests

* harden live smoke against stalls and transient observations ([#210](https://github.com/boadij/pi-herdsman/issues/210)) ([e9a4766](https://github.com/boadij/pi-herdsman/commit/e9a476601f4fa167fce011d58eff041800cb7d0a))


### Other Changes

* **deps:** update supported Pi runtime to 0.99.2 ([#194](https://github.com/boadij/pi-herdsman/issues/194)) ([a6e07e1](https://github.com/boadij/pi-herdsman/commit/a6e07e13e3f034af244f2148ab7121dffce97a9b))
* **deps:** update supported Pi runtime to 1.0.0 ([#209](https://github.com/boadij/pi-herdsman/issues/209)) ([9015413](https://github.com/boadij/pi-herdsman/commit/90154134fdaf3851b7e7768abf697506ca5e344a))

## [0.18.0](https://github.com/boadij/pi-herdsman/compare/v0.17.1...v0.18.0) (2026-09-28)


### Features

* add deterministic host installer ([#167](https://github.com/boadij/pi-herdsman/issues/167)) ([91ad5b1](https://github.com/boadij/pi-herdsman/commit/91ad5b1238d3080832672e197669c239d4cbe74d))


### Tests

* decouple smoke model from invoking agent ([#174](https://github.com/boadij/pi-herdsman/issues/174)) ([472bc3a](https://github.com/boadij/pi-herdsman/commit/472bc3ae9469f950ce01d00f4ed26822414485ac))
* make async synchronization deterministic ([#172](https://github.com/boadij/pi-herdsman/issues/172)) ([8360920](https://github.com/boadij/pi-herdsman/commit/8360920beaf59f09cf887d3daa29efcc10b4ec56))

## [0.17.1](https://github.com/boadij/pi-herdsman/compare/v0.17.0...v0.17.1) (2026-09-27)


### Fixes

* tolerate transient fresh-pane startup ([#169](https://github.com/boadij/pi-herdsman/issues/169)) ([612d0de](https://github.com/boadij/pi-herdsman/commit/612d0de9bc720a151bfa84b1b2dc5e2cf4a3cef4))

## [0.17.0](https://github.com/boadij/pi-herdsman/compare/v0.16.0...v0.17.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* expose semantic coordination tools ([#154](https://github.com/boadij/pi-herdsman/issues/154))

### Features

* add isolated live smoke harness ([#156](https://github.com/boadij/pi-herdsman/issues/156)) ([f0aec40](https://github.com/boadij/pi-herdsman/commit/f0aec405d8607522a2d48611942c14aa1df124c5))
* expose semantic coordination tools ([#154](https://github.com/boadij/pi-herdsman/issues/154)) ([cc33216](https://github.com/boadij/pi-herdsman/commit/cc3321644c5c316fb781ff130770b8b5b031504c))
* **ui:** polish status and management presentation ([#162](https://github.com/boadij/pi-herdsman/issues/162)) ([258de17](https://github.com/boadij/pi-herdsman/commit/258de17151fe43f8689f0a981f9f94b7997758d2))


### Fixes

* make stale-agent recovery converge ([#166](https://github.com/boadij/pi-herdsman/issues/166)) ([f9d1287](https://github.com/boadij/pi-herdsman/commit/f9d1287f3479133555f837996f93d8d3cfcce49d))
* require relevant artifacts in agent handoffs ([#164](https://github.com/boadij/pi-herdsman/issues/164)) ([2a146f0](https://github.com/boadij/pi-herdsman/commit/2a146f09f5b3e4a3f2e5bf950165a8f473bc91ca))
* resolve continue from owned session history ([#159](https://github.com/boadij/pi-herdsman/issues/159)) ([f88fb37](https://github.com/boadij/pi-herdsman/commit/f88fb37470fe94ece8bf6ad892af02a3818a6eff))


### Documentation

* document isolated smoke harness ([a414dcd](https://github.com/boadij/pi-herdsman/commit/a414dcd84b4664b1add6c8e559a10d28499a9482))


### CI

* add npm PR preview publishing ([#149](https://github.com/boadij/pi-herdsman/issues/149)) ([fa2d141](https://github.com/boadij/pi-herdsman/commit/fa2d14143cf9228f90682445318600665f458917))


### Other Changes

* add focused testing skill ([#165](https://github.com/boadij/pi-herdsman/issues/165)) ([b51bc52](https://github.com/boadij/pi-herdsman/commit/b51bc52ea04c309bd6ce350d0bd8650cb91e45a6))

## [0.16.0](https://github.com/boadij/pi-herdsman/compare/v0.15.0...v0.16.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* agent delegate no longer accepts fork or timeoutMs, and agent continue no longer accepts timeoutMs. Use continue for an existing managed-agent session and task/files for explicit fresh-agent handoffs.

### Fixes

* canonicalize agent tool inputs ([#148](https://github.com/boadij/pi-herdsman/issues/148)) ([4c728a9](https://github.com/boadij/pi-herdsman/commit/4c728a9db7a12c5e5e97b2abe8eaaa037e15c8a1))
* **container:** suppress npm update notices ([#145](https://github.com/boadij/pi-herdsman/issues/145)) ([7faf5a3](https://github.com/boadij/pi-herdsman/commit/7faf5a311fc20b49ac8a45cb83f73f40db1061ce))


### Documentation

* add contribution guidelines ([c827b0b](https://github.com/boadij/pi-herdsman/commit/c827b0bea1742753f19eed63efa66b48ba90c42c))

## [0.15.0](https://github.com/boadij/pi-herdsman/compare/v0.14.2...v0.15.0) (2026-09-24)


### Features

* include agent session IDs in result provenance ([#138](https://github.com/boadij/pi-herdsman/issues/138)) ([de002d2](https://github.com/boadij/pi-herdsman/commit/de002d200f3eeca6a8f7727b16d5b234d2221b90))
* preserve agent provenance in result handoffs ([#136](https://github.com/boadij/pi-herdsman/issues/136)) ([d4b6373](https://github.com/boadij/pi-herdsman/commit/d4b6373c984f6b5b37f6ae7594d2fb85a394bf82))


### Fixes

* **agents:** let delegated children resolve the model they are given ([#139](https://github.com/boadij/pi-herdsman/issues/139)) ([ea62b36](https://github.com/boadij/pi-herdsman/commit/ea62b3606bced1aed77fd1009f84b1368deb1350))
* **agents:** report Herdr's startup failure instead of our own kill ([#140](https://github.com/boadij/pi-herdsman/issues/140)) ([c2b9d92](https://github.com/boadij/pi-herdsman/commit/c2b9d925852ed5e6a94884db1f2956b49bbfaa15))


### Build

* publish debuggable source-mapped bundle ([#135](https://github.com/boadij/pi-herdsman/issues/135)) ([b7ed794](https://github.com/boadij/pi-herdsman/commit/b7ed794b9ad30e8fca6cb5ce976c85d66cff404f))

## [0.14.2](https://github.com/boadij/pi-herdsman/compare/v0.14.1...v0.14.2) (2026-09-24)


### Fixes

* make Herdsman tool schemas provider-safe ([#133](https://github.com/boadij/pi-herdsman/issues/133)) ([97301db](https://github.com/boadij/pi-herdsman/commit/97301db642a4c166d88f73f6547ea15a24aec037))

## [0.14.1](https://github.com/boadij/pi-herdsman/compare/v0.14.0...v0.14.1) (2026-09-23)


### Fixes

* fail fast on SSH-unsafe home permissions ([#130](https://github.com/boadij/pi-herdsman/issues/130)) ([398cc0f](https://github.com/boadij/pi-herdsman/commit/398cc0fc82ce47a529f404aa6e32fa7b8c01b769))


### CI

* scope validation to affected surfaces ([#129](https://github.com/boadij/pi-herdsman/issues/129)) ([026e1e8](https://github.com/boadij/pi-herdsman/commit/026e1e834af97799c92d6c792919765baf05d7df))

## [0.14.0](https://github.com/boadij/pi-herdsman/compare/v0.13.2...v0.14.0) (2026-09-23)


### Features

* add SSH-ready Herdsman container ([#124](https://github.com/boadij/pi-herdsman/issues/124)) ([9bb43d9](https://github.com/boadij/pi-herdsman/commit/9bb43d99b5a0bf5e476add06f26291ed82736819))

## [0.13.2](https://github.com/boadij/pi-herdsman/compare/v0.13.1...v0.13.2) (2026-09-23)


### Fixes

* attach bounded diagnosis to stale attention ([#126](https://github.com/boadij/pi-herdsman/issues/126)) ([738ec43](https://github.com/boadij/pi-herdsman/commit/738ec43dbdb4ea158fbd13c8987ddef155cb120d))
* continue interrupted agents after Pi settlement ([#123](https://github.com/boadij/pi-herdsman/issues/123)) ([4389247](https://github.com/boadij/pi-herdsman/commit/43892477bfa4a209b7cee0efdf4c525197d22700))
* harden managed-agent cleanup lifecycle ([#127](https://github.com/boadij/pi-herdsman/issues/127)) ([3330696](https://github.com/boadij/pi-herdsman/commit/3330696ddee703956fb367ba9d5c077b6740c592))

## [0.13.1](https://github.com/boadij/pi-herdsman/compare/v0.13.0...v0.13.1) (2026-09-22)


### Refactoring

* consolidate agent handoff contract ([#120](https://github.com/boadij/pi-herdsman/issues/120)) ([b8f58c4](https://github.com/boadij/pi-herdsman/commit/b8f58c46195259e4bc05a9c81e85127646a2f809))


### Other Changes

* validate Pi 0.87.1 ([#121](https://github.com/boadij/pi-herdsman/issues/121)) ([0e36eb0](https://github.com/boadij/pi-herdsman/commit/0e36eb0d477997614bc854bac54829cfe3952b90))

## [0.13.0](https://github.com/boadij/pi-herdsman/compare/v0.12.1...v0.13.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* remove delegate cwd override ([#114](https://github.com/boadij/pi-herdsman/issues/114))

### Fixes

* advertise herdsman tools in pi prompt ([#113](https://github.com/boadij/pi-herdsman/issues/113)) ([986ef5a](https://github.com/boadij/pi-herdsman/commit/986ef5a6fe7390ecc069c95521c31bfd7eaddce9))
* align close availability with preflight ([#109](https://github.com/boadij/pi-herdsman/issues/109)) ([c0f0c59](https://github.com/boadij/pi-herdsman/commit/c0f0c59926bc646a8d900afe5cf69c645b54b0c8))
* align delegating ask_owner guidance ([#115](https://github.com/boadij/pi-herdsman/issues/115)) ([982c7aa](https://github.com/boadij/pi-herdsman/commit/982c7aa74ae9915e60c82a214b22b7926c4f1fa6))
* distinguish unresolved mailbox state during chief activation ([#118](https://github.com/boadij/pi-herdsman/issues/118)) ([0c49b81](https://github.com/boadij/pi-herdsman/commit/0c49b8111d744ce46afaf85ad889d7836a8579a9))
* enforce chief ask finality ([#110](https://github.com/boadij/pi-herdsman/issues/110)) ([3bbf132](https://github.com/boadij/pi-herdsman/commit/3bbf1326c537c7ca62b70aa6eaaa3a922b454aac))
* **settling:** hide close while result delivery is pending ([#107](https://github.com/boadij/pi-herdsman/issues/107)) ([9e4bb79](https://github.com/boadij/pi-herdsman/commit/9e4bb79664c4eaa96f9cff840a4dcea687cf4904))
* surface agent orchestration guidelines ([#116](https://github.com/boadij/pi-herdsman/issues/116)) ([0417b55](https://github.com/boadij/pi-herdsman/commit/0417b555c37a97e8de1d95045cbca143090273be))
* unify agent result handoffs ([#112](https://github.com/boadij/pi-herdsman/issues/112)) ([1fa7685](https://github.com/boadij/pi-herdsman/commit/1fa7685ba661074642fb9d2aa5bfb7300a559029))
* unify process lock validation ([#117](https://github.com/boadij/pi-herdsman/issues/117)) ([bf60fc1](https://github.com/boadij/pi-herdsman/commit/bf60fc1ca1ede5ab5c3df7d035b43b0da8cdbb4b))
* withdraw unhealthy peer presence ([#111](https://github.com/boadij/pi-herdsman/issues/111)) ([a8a19df](https://github.com/boadij/pi-herdsman/commit/a8a19df10b3f4ffceb668fd7fff6a293a05b7f22))


### Refactoring

* remove delegate cwd override ([#114](https://github.com/boadij/pi-herdsman/issues/114)) ([124a7a6](https://github.com/boadij/pi-herdsman/commit/124a7a6b81b4ee5efba901a030d84e109ab39c28))


### Documentation

* codify instruction and interface design principles ([#119](https://github.com/boadij/pi-herdsman/issues/119)) ([61c20be](https://github.com/boadij/pi-herdsman/commit/61c20be77041d8ef5e3f624f6532b5d164e7446c))

## [0.12.1](https://github.com/boadij/pi-herdsman/compare/v0.12.0...v0.12.1) (2026-09-21)


### Fixes

* support peer result selectors ([#105](https://github.com/boadij/pi-herdsman/issues/105)) ([76a07ae](https://github.com/boadij/pi-herdsman/commit/76a07ae41ac2af79d7a90d6902adc289f95979d8))

## [0.12.0](https://github.com/boadij/pi-herdsman/compare/v0.11.1...v0.12.0) (2026-09-21)


### Features

* add cross-runtime lead peer coordination ([#99](https://github.com/boadij/pi-herdsman/issues/99)) ([f0c14ac](https://github.com/boadij/pi-herdsman/commit/f0c14acef540d82c65d6ba2a5fbabfb82371387c))


### Fixes

* add stable agent result handles ([#103](https://github.com/boadij/pi-herdsman/issues/103)) ([b27e706](https://github.com/boadij/pi-herdsman/commit/b27e706d27ba6c44a04f6ccf622c4619e57d9004))
* align session lifecycle with Pi 0.87 ([#101](https://github.com/boadij/pi-herdsman/issues/101)) ([5d4e6ab](https://github.com/boadij/pi-herdsman/commit/5d4e6abce559719278a8a0e3df53429ffe7eb749))
* render result handles in coordination calls ([#104](https://github.com/boadij/pi-herdsman/issues/104)) ([569ae3b](https://github.com/boadij/pi-herdsman/commit/569ae3b52cef7381f433db34e87261daa2b782c9))

## [0.11.1](https://github.com/boadij/pi-herdsman/compare/v0.11.0...v0.11.1) (2026-09-20)


### Fixes

* preserve chief supervision context continuity ([#97](https://github.com/boadij/pi-herdsman/issues/97)) ([8f9ba12](https://github.com/boadij/pi-herdsman/commit/8f9ba12fc1ddbfa4016b9f774d46ac8f4efbad64))

## [0.11.0](https://github.com/boadij/pi-herdsman/compare/v0.10.1...v0.11.0) (2026-09-20)


### Features

* align chief supervision with lead semantics ([#93](https://github.com/boadij/pi-herdsman/issues/93)) ([f82a194](https://github.com/boadij/pi-herdsman/commit/f82a194d38c0829b1fb26318e48fa2f15fea4945))


### CI

* validate built extension with Pi loader ([#96](https://github.com/boadij/pi-herdsman/issues/96)) ([1bd83d8](https://github.com/boadij/pi-herdsman/commit/1bd83d8752826c3c6e0efee0bb3a7c4da0e1ff6f))


### Other Changes

* validate Pi 0.86.1 ([#95](https://github.com/boadij/pi-herdsman/issues/95)) ([8ddf4ae](https://github.com/boadij/pi-herdsman/commit/8ddf4ae8cda3181ee90a5872194c08d616029471))

## [0.10.1](https://github.com/boadij/pi-herdsman/compare/v0.10.0...v0.10.1) (2026-09-19)


### Fixes

* reconcile queues across agent interrupt ([#92](https://github.com/boadij/pi-herdsman/issues/92)) ([16a7b4e](https://github.com/boadij/pi-herdsman/commit/16a7b4ece9fa0249c698977c2c67e6c108b614e6))
* reconcile unresolved agent attention ([#89](https://github.com/boadij/pi-herdsman/issues/89)) ([eff9461](https://github.com/boadij/pi-herdsman/commit/eff946145b7e1ef4fb493be4ea0fadd853b47ce6))


### Other Changes

* audit unresolved work liveness ([#91](https://github.com/boadij/pi-herdsman/issues/91)) ([f68a74f](https://github.com/boadij/pi-herdsman/commit/f68a74f397ad0e74ab245b1eac05bc66c0891202))

## [0.10.0](https://github.com/boadij/pi-herdsman/compare/v0.9.0...v0.10.0) (2026-09-18)


### Features

* add /herdsman alias for /agents ([#88](https://github.com/boadij/pi-herdsman/issues/88)) ([ac1bd2f](https://github.com/boadij/pi-herdsman/commit/ac1bd2f283ec254cb54e3e627db4c22f4e0cfc1d))
* add preemptive agent interrupt ([#84](https://github.com/boadij/pi-herdsman/issues/84)) ([ae23e51](https://github.com/boadij/pi-herdsman/commit/ae23e5165dc65f8246cb2f66f116ceed3dd63454))


### Fixes

* continue interrupted agents with follow-up ([#87](https://github.com/boadij/pi-herdsman/issues/87)) ([15880be](https://github.com/boadij/pi-herdsman/commit/15880be58dcfc9f61b9133319005afe04e2ee477))
* gate npm publish on release creation ([#86](https://github.com/boadij/pi-herdsman/issues/86)) ([b373963](https://github.com/boadij/pi-herdsman/commit/b37396305d2522597ceeaa7ad3ea8334ce2d6642))

## [0.9.0](https://github.com/boadij/pi-herdsman/compare/v0.8.1...v0.9.0) (2026-09-18)


### Features

* add agent transcript action ([#81](https://github.com/boadij/pi-herdsman/issues/81)) ([6a490f7](https://github.com/boadij/pi-herdsman/commit/6a490f7734bf0d0d1d0ad5f78483b40ee111de75))


### Fixes

* improve agent transcript readiness and bounds ([#83](https://github.com/boadij/pi-herdsman/issues/83)) ([b5e0ca6](https://github.com/boadij/pi-herdsman/commit/b5e0ca694f3e7abd50b78e3fc3196275572cff82))

## [0.8.1](https://github.com/boadij/pi-herdsman/compare/v0.8.0...v0.8.1) (2026-09-18)


### Fixes

* make agent inspection passive ([#80](https://github.com/boadij/pi-herdsman/issues/80)) ([7e48ced](https://github.com/boadij/pi-herdsman/commit/7e48ced8eb8741c4b7f0d5608a87e2c33cfdea64))
* preserve cleanup and recovery evidence in agent output ([#78](https://github.com/boadij/pi-herdsman/issues/78)) ([51bcd3c](https://github.com/boadij/pi-herdsman/commit/51bcd3c4df6d50319f7e3e02ae73c417b653f589))


### Refactoring

* **agentic-system-audit:** streamline workflow and enforce reachability verification ([f7bf08a](https://github.com/boadij/pi-herdsman/commit/f7bf08a1ff8ebc364ad49593db08fcd941ae9086))

## [0.8.0](https://github.com/boadij/pi-herdsman/compare/v0.7.4...v0.8.0) (2026-09-17)


### Features

* **chief:** show delegated activity in ambient widget ([#75](https://github.com/boadij/pi-herdsman/issues/75)) ([9dd8765](https://github.com/boadij/pi-herdsman/commit/9dd87655e3c5a0fa75a22d51ccffe9a311f693b4))


### Fixes

* isolate lead agent visibility by ownership ([#77](https://github.com/boadij/pi-herdsman/issues/77)) ([50ebfa8](https://github.com/boadij/pi-herdsman/commit/50ebfa85dbd62d9618600edf57d34009f7d1d50f))

## [0.7.4](https://github.com/boadij/pi-herdsman/compare/v0.7.3...v0.7.4) (2026-09-16)


### Fixes

* harden agent startup rollback ownership ([#72](https://github.com/boadij/pi-herdsman/issues/72)) ([7020157](https://github.com/boadij/pi-herdsman/commit/7020157079887b3f62ce5c71c93cfc5b13c69b1c))
* require Herdr 0.9.1 ([#74](https://github.com/boadij/pi-herdsman/issues/74)) ([b4dbf36](https://github.com/boadij/pi-herdsman/commit/b4dbf368fa9af702cef404ba6a3becbfb4637ac2))

## [0.7.3](https://github.com/boadij/pi-herdsman/compare/v0.7.2...v0.7.3) (2026-09-16)


### Fixes

* diagnose blocked shell startup before agent launch ([#70](https://github.com/boadij/pi-herdsman/issues/70)) ([9f82301](https://github.com/boadij/pi-herdsman/commit/9f82301e92f6215054fc6cb50d8d18d1284c9074))

## [0.7.2](https://github.com/boadij/pi-herdsman/compare/v0.7.1...v0.7.2) (2026-09-15)


### Fixes

* clarify delegated work ownership ([#66](https://github.com/boadij/pi-herdsman/issues/66)) ([f9f65a6](https://github.com/boadij/pi-herdsman/commit/f9f65a60e8a0625e7fa5df50e2a6b002545710ef))
* guide delegated controller navigation ([#69](https://github.com/boadij/pi-herdsman/issues/69)) ([46f4ba0](https://github.com/boadij/pi-herdsman/commit/46f4ba0ff712f6da2380762f39b2eb1f08669eaf))
* preserve agent control during unresolved work ([#68](https://github.com/boadij/pi-herdsman/issues/68)) ([1c325cc](https://github.com/boadij/pi-herdsman/commit/1c325cc404e6eebebb75ce79d38a8fc7f57b3dc6))

## [0.7.1](https://github.com/boadij/pi-herdsman/compare/v0.7.0...v0.7.1) (2026-09-14)


### Fixes

* harden managed-agent lifecycle recovery ([#63](https://github.com/boadij/pi-herdsman/issues/63)) ([6a7bb27](https://github.com/boadij/pi-herdsman/commit/6a7bb271e3276353a00fc74af492a7c430732ca0))

## [0.7.0](https://github.com/boadij/pi-herdsman/compare/v0.6.2...v0.7.0) (2026-09-13)


### Features

* retire managed sessions at compaction ([#62](https://github.com/boadij/pi-herdsman/issues/62)) ([7c7fac4](https://github.com/boadij/pi-herdsman/commit/7c7fac44531f5d736e115149f5520ec0caf27181))

## [0.6.2](https://github.com/boadij/pi-herdsman/compare/v0.6.1...v0.6.2) (2026-09-12)


### Fixes

* detect and bound managed-agent stalls ([#59](https://github.com/boadij/pi-herdsman/issues/59)) ([aeb5716](https://github.com/boadij/pi-herdsman/commit/aeb5716df17d9a89e11d1daaec4fcdbce535adc5))
* keep agent startup status continuous ([#61](https://github.com/boadij/pi-herdsman/issues/61)) ([10ea89a](https://github.com/boadij/pi-herdsman/commit/10ea89a1970087adf93602fbfce29147950abbf7))

## [0.6.1](https://github.com/boadij/pi-herdsman/compare/v0.6.0...v0.6.1) (2026-09-12)


### Fixes

* remove Unix-only portability assumptions ([#56](https://github.com/boadij/pi-herdsman/issues/56)) ([c2da24e](https://github.com/boadij/pi-herdsman/commit/c2da24e1f7abe4a408045937383ba8152ea285ea))


### Documentation

* add project badges ([#58](https://github.com/boadij/pi-herdsman/issues/58)) ([75e5269](https://github.com/boadij/pi-herdsman/commit/75e5269e77205ead9ef80ccc6f4d921f55a7121d))

## [0.6.0](https://github.com/boadij/pi-herdsman/compare/v0.5.2...v0.6.0) (2026-09-12)


### Features

* improve first-use guidance ([#53](https://github.com/boadij/pi-herdsman/issues/53)) ([32021fe](https://github.com/boadij/pi-herdsman/commit/32021fee247be17e28b76088caafc8680e0f131d))
* inherit agent execution settings from controller ([#52](https://github.com/boadij/pi-herdsman/issues/52)) ([e7a16b3](https://github.com/boadij/pi-herdsman/commit/e7a16b352ee5ffb17807ad6dc66138be41308be1))
* polish agents menu navigation and model selection ([#55](https://github.com/boadij/pi-herdsman/issues/55)) ([45b613d](https://github.com/boadij/pi-herdsman/commit/45b613d1654813a81ac1b0ff8ede7f7566350bdc))

## [0.5.2](https://github.com/boadij/pi-herdsman/compare/v0.5.1...v0.5.2) (2026-09-11)


### Fixes

* harden runtime contracts ([#50](https://github.com/boadij/pi-herdsman/issues/50)) ([6d54d6f](https://github.com/boadij/pi-herdsman/commit/6d54d6f7d902f27f8ee8d12c34eb60971d6b7778))


### Documentation

* improve agent fleet discoverability ([#49](https://github.com/boadij/pi-herdsman/issues/49)) ([5613e14](https://github.com/boadij/pi-herdsman/commit/5613e14adad17c3384b9f59c372c959e99a77e4a))

## [0.5.1](https://github.com/boadij/pi-herdsman/compare/v0.5.0...v0.5.1) (2026-09-11)


### Fixes

* clarify missing result references ([#48](https://github.com/boadij/pi-herdsman/issues/48)) ([df98d22](https://github.com/boadij/pi-herdsman/commit/df98d2275cd69f2b72963e41fe4325964e89ca2a))
* prevent stale owner ask notifications ([#46](https://github.com/boadij/pi-herdsman/issues/46)) ([b5b3e7c](https://github.com/boadij/pi-herdsman/commit/b5b3e7c9b212abd53bd0dce800e9c098366c4f44))
* render continued agent identity ([#44](https://github.com/boadij/pi-herdsman/issues/44)) ([e8fa53d](https://github.com/boadij/pi-herdsman/commit/e8fa53de2009a211d638c979d99a809da6f22ffc))
* silence transient result cleanup retries ([#47](https://github.com/boadij/pi-herdsman/issues/47)) ([e7222c8](https://github.com/boadij/pi-herdsman/commit/e7222c8ba38934a1cb7c5a68f8de1e371d9c0e74))

## [0.5.0](https://github.com/boadij/pi-herdsman/compare/v0.4.0...v0.5.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* delegate no longer accepts session; use continue with session for historical context. The legacy resume, start, and assign actions and continuation cross-fields are rejected.
* agent delegate with session no longer accepts label; continuations inherit the label persisted in the saved managed-agent session.
* Pi Herdsman configuration now lives exclusively under <Pi agent dir>/pi-herdsman/config.json. Existing piHerdsman values in Pi global or project settings are no longer read, and project-scoped Herdsman configuration has been removed. No migration or compatibility fallback is provided; missing config uses defaults.

### Features

* split agent continuation from delegation ([#43](https://github.com/boadij/pi-herdsman/issues/43)) ([5088af9](https://github.com/boadij/pi-herdsman/commit/5088af9b0306f701da767ba0fa28ddc3f267a46f))


### Fixes

* decouple agent messaging from Pi keybindings ([#37](https://github.com/boadij/pi-herdsman/issues/37)) ([85dc7fa](https://github.com/boadij/pi-herdsman/commit/85dc7fa35081c5c82bd083b33adb3d4fbbf02dd0))
* **handoff:** replace result paths with stable references ([#40](https://github.com/boadij/pi-herdsman/issues/40)) ([d7c6e4e](https://github.com/boadij/pi-herdsman/commit/d7c6e4ed50f01207bfc0eb0d104e82010d543357))
* show agent definitions in compact calls ([#39](https://github.com/boadij/pi-herdsman/issues/39)) ([9b5ec55](https://github.com/boadij/pi-herdsman/commit/9b5ec55652396dcb2688f0fb76a2dc9d4400c385))
* **storage:** persist herdsman coordination state ([#36](https://github.com/boadij/pi-herdsman/issues/36)) ([ad91a9c](https://github.com/boadij/pi-herdsman/commit/ad91a9ce33551720dfdb1b1a8f2983a4b1a43ab8))


### Refactoring

* consolidate Herdsman persistent state ([#41](https://github.com/boadij/pi-herdsman/issues/41)) ([86e2133](https://github.com/boadij/pi-herdsman/commit/86e21335d350091a3deb2f20adee3eb0cefb0944))
* inherit agent labels on session continuation ([#42](https://github.com/boadij/pi-herdsman/issues/42)) ([a946d6f](https://github.com/boadij/pi-herdsman/commit/a946d6f98d4a901ad082f96e83143ffff21be2f9))

## [0.4.0](https://github.com/boadij/pi-herdsman/compare/v0.3.2...v0.4.0) (2026-09-10)


### Features

* adopt Pi subagent interoperability conventions ([#34](https://github.com/boadij/pi-herdsman/issues/34)) ([9782cc9](https://github.com/boadij/pi-herdsman/commit/9782cc9d25dc8689c1c2d945da2a5d5527048339))


### Fixes

* improve agent definition details ([#32](https://github.com/boadij/pi-herdsman/issues/32)) ([e08579f](https://github.com/boadij/pi-herdsman/commit/e08579f781cc1762a79c7ce1031e35ebe832b299))


### Refactoring

* consolidate on native Pi and Herdr contracts ([#30](https://github.com/boadij/pi-herdsman/issues/30)) ([7af0d4a](https://github.com/boadij/pi-herdsman/commit/7af0d4a714c94290e7846676eaa83cc45b0738cb))


### Documentation

* **assets:** update banner and thumbnail images ([8fa1625](https://github.com/boadij/pi-herdsman/commit/8fa1625463ad743bea33ce9b1506d4d424271bd3))


### CI

* validate pull requests ([#35](https://github.com/boadij/pi-herdsman/issues/35)) ([fc5afb8](https://github.com/boadij/pi-herdsman/commit/fc5afb8b08660c70e470c79f0f2584850c36fcd3))

## [0.3.2](https://github.com/boadij/pi-herdsman/compare/v0.3.1...v0.3.2) (2026-09-10)


### Documentation

* **assets:** replace banner image with thumbnail in package manifest ([95b89c3](https://github.com/boadij/pi-herdsman/commit/95b89c32f223382758863cb1c1d8c262a5a3a185))

## [0.3.1](https://github.com/boadij/pi-herdsman/compare/v0.3.0...v0.3.1) (2026-09-09)


### Fixes

* **agent-definitions:** support native YAML arrays ([#29](https://github.com/boadij/pi-herdsman/issues/29)) ([6a53ee5](https://github.com/boadij/pi-herdsman/commit/6a53ee5d57621b29ff2cb47d39c9d5dffedb6c1a))


### Documentation

* **validation:** clarify pre-commit validation order and formatting step ([14e8100](https://github.com/boadij/pi-herdsman/commit/14e8100799d5239821eb709060c2d37e3b5bc733))

## [0.3.0](https://github.com/boadij/pi-herdsman/compare/v0.2.1...v0.3.0) (2026-09-09)


### Features

* **placement:** add lead-scoped agent layouts ([#26](https://github.com/boadij/pi-herdsman/issues/26)) ([9414f90](https://github.com/boadij/pi-herdsman/commit/9414f90d586124fabe2d7b839af1c1e6ae5b8e5d))


### Fixes

* **runtime:** improve cross-platform tooling ([#25](https://github.com/boadij/pi-herdsman/issues/25)) ([a834dc4](https://github.com/boadij/pi-herdsman/commit/a834dc46bf89a86a0a6ed2dbd18ddb23fb5e33fb))
* **runtime:** isolate temporary state per user ([#22](https://github.com/boadij/pi-herdsman/issues/22)) ([49657c9](https://github.com/boadij/pi-herdsman/commit/49657c9fbcc1cba9d702dab91f29f5c9f567518f))
* **runtime:** remove shell allowlist ([#24](https://github.com/boadij/pi-herdsman/issues/24)) ([d359dbd](https://github.com/boadij/pi-herdsman/commit/d359dbd1dfb082337d4b8a4132863ea457baa93c))


### Documentation

* **audit:** restrict generalist fallback to read-only tool policy ([fee7fab](https://github.com/boadij/pi-herdsman/commit/fee7fab0a8f8290aa8702963bd26535c4d04b402))


### Other Changes

* **release:** include commit authors ([#27](https://github.com/boadij/pi-herdsman/issues/27)) ([679ddfd](https://github.com/boadij/pi-herdsman/commit/679ddfd13574b0a673d32e904ee750a8eb72b0ca))

## [0.2.1](https://github.com/boadij/pi-herdsman/compare/v0.2.0...v0.2.1) (2026-09-09)


### Fixes

* **presentation:** preserve coordination warnings ([#21](https://github.com/boadij/pi-herdsman/issues/21)) ([1e35604](https://github.com/boadij/pi-herdsman/commit/1e356048931629c6669c93544d010e791064eda8))


### Documentation

* **agent-definitions:** clarify role descriptions and selection boundaries ([38e1236](https://github.com/boadij/pi-herdsman/commit/38e12368aefc1bbe5d6750a28d6eef2ce6303210))

## [0.2.0](https://github.com/boadij/pi-herdsman/compare/v0.1.5...v0.2.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* The `worker` tool is renamed to `agent`, `/workers` command is renamed to `/agents`, definition frontmatter `workers` is renamed to `agents`, error codes `worker_label_exists`/`worker_busy` are renamed to `agent_label_exists`/`agent_busy`, and mailbox protocol V3 is upgraded to V4 under `mailboxes-v4`.

### Features

* **controller:** support session labels and expand inspect context ([#15](https://github.com/boadij/pi-herdsman/issues/15)) ([ac4c94b](https://github.com/boadij/pi-herdsman/commit/ac4c94bfc13e88bb828f90a1278910b315f2da8d))
* **coordination:** track herd run duration ([3229890](https://github.com/boadij/pi-herdsman/commit/3229890533e9da140b87143c362aed76c720d2a4))
* expand chief supervision and worker lifecycle contracts ([91e2a56](https://github.com/boadij/pi-herdsman/commit/91e2a565971d90d81efb0993f80a6460e2a591c5))
* **handoffs:** use Pi-style file framing ([#17](https://github.com/boadij/pi-herdsman/issues/17)) ([816d5af](https://github.com/boadij/pi-herdsman/commit/816d5af8ab1bb07f37da8784479a446a20dc9d20))
* **ui:** improve coordination chat presentation ([a9ec88b](https://github.com/boadij/pi-herdsman/commit/a9ec88b6881e66eb6db9f07029ee9b51ff97c647))
* **ui:** render coordination prose with markdown ([#18](https://github.com/boadij/pi-herdsman/issues/18)) ([8fb6aa4](https://github.com/boadij/pi-herdsman/commit/8fb6aa4ecf7f0b10332ca060fc8628d4498366f0))


### Fixes

* **ci:** reconcile recovered release state ([d1c31e7](https://github.com/boadij/pi-herdsman/commit/d1c31e7ca16cbdd53f4192dae3634c66f71f1d38))
* make chief coordination event-driven ([#9](https://github.com/boadij/pi-herdsman/issues/9)) ([183d809](https://github.com/boadij/pi-herdsman/commit/183d8098836db17d1d8375ad4287c6fa150b1fab))


### Refactoring

* rename managed workers to agents ([#14](https://github.com/boadij/pi-herdsman/issues/14)) ([cd454a1](https://github.com/boadij/pi-herdsman/commit/cd454a11537680b693ec239c6c7c06ad311cc5fc))


### CI

* automate release publication ([786612a](https://github.com/boadij/pi-herdsman/commit/786612a285c53cec852e615328e56bb5113a5728))
* grant release action pull request access ([f1dcc9f](https://github.com/boadij/pi-herdsman/commit/f1dcc9fe621d265ba3aeaf59887a4fcba049bce4))
* simplify release workflow ([d21ef67](https://github.com/boadij/pi-herdsman/commit/d21ef6749399543098604541510a579d305ceb9f))


### Other Changes

* add .local to .gitignore ([e2fdaea](https://github.com/boadij/pi-herdsman/commit/e2fdaea178aba5781814f08120011dba1a5f06fd))

## [0.1.5](https://github.com/boadij/pi-herdsman/compare/v0.1.4...v0.1.5) (2026-09-07)


### Documentation

* add banner image to package metadata ([9e45229](https://github.com/boadij/pi-herdsman/commit/9e45229b313fc146143d91a73176258be959971f))
* improve subagent discoverability ([#5](https://github.com/boadij/pi-herdsman/issues/5)) ([e4339fd](https://github.com/boadij/pi-herdsman/commit/e4339fd1b405d5ab5c30bca73fd94dfab9324bb4))


### CI

* permit release metadata comments ([dd16f8d](https://github.com/boadij/pi-herdsman/commit/dd16f8d7975deedf894d5baf967bd2132e04734a))
* recover interrupted v0.1.4 publication ([cccc3c4](https://github.com/boadij/pi-herdsman/commit/cccc3c41d1ae5cfc3617b07bbb71eeca5e6406e6))

## [0.1.4](https://github.com/boadij/pi-herdsman/compare/v0.1.3...v0.1.4) (2026-09-07)


### CI

* add manual release workflow ([a992304](https://github.com/boadij/pi-herdsman/commit/a992304350bc0940df133eb96a4959afbe99e714))


### Other Changes

* update package-lock.json version to 0.1.3 ([80f450c](https://github.com/boadij/pi-herdsman/commit/80f450cc910bc360289ea463d857c23fcc802658))
