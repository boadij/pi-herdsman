# Changelog

## [0.35.0](https://github.com/boadij/pi-herdsman/compare/v0.34.1...v0.35.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* clarify project and work assignment semantics ([#657](https://github.com/boadij/pi-herdsman/issues/657))

### Fixes

* **peer:** explain remote discovery failures and build mismatches ([#651](https://github.com/boadij/pi-herdsman/issues/651)) ([e75e28e](https://github.com/boadij/pi-herdsman/commit/e75e28ed9fa796a1b6ec10c3905cc150068caac9)), closes [#644](https://github.com/boadij/pi-herdsman/issues/644)
* **smoke:** wait for core session PID observations ([#648](https://github.com/boadij/pi-herdsman/issues/648)) ([d0bb1a8](https://github.com/boadij/pi-herdsman/commit/d0bb1a8772f7ab4b08b8d4e57941bcb5512593c6)), closes [#646](https://github.com/boadij/pi-herdsman/issues/646)
* **ui:** enable navigation from truncated Manager branches ([#655](https://github.com/boadij/pi-herdsman/issues/655)) ([d470043](https://github.com/boadij/pi-herdsman/commit/d470043c37a1735c6df6397326e4d20cba26fe56))


### Refactoring

* clarify project and work assignment semantics ([#657](https://github.com/boadij/pi-herdsman/issues/657)) ([2b78e1b](https://github.com/boadij/pi-herdsman/commit/2b78e1b7b4a62240f7be881ab066be4cefbee612))


### Tests

* **agent:** defer independent result eligibility ([#647](https://github.com/boadij/pi-herdsman/issues/647)) ([#649](https://github.com/boadij/pi-herdsman/issues/649)) ([67fa938](https://github.com/boadij/pi-herdsman/commit/67fa938bac1edfa8830e4808fa35dd89b29d29f6))
* label Manager activation wait failures ([#650](https://github.com/boadij/pi-herdsman/issues/650)) ([a051a72](https://github.com/boadij/pi-herdsman/commit/a051a72e93fdbda6ae79a61ab2751979a76c1f57)), closes [#634](https://github.com/boadij/pi-herdsman/issues/634)

## [0.34.1](https://github.com/boadij/pi-herdsman/compare/v0.34.0...v0.34.1) (2026-10-28)


### Fixes

* **agent:** forward explicit nested result evidence on completion ([#642](https://github.com/boadij/pi-herdsman/issues/642)) ([d80df03](https://github.com/boadij/pi-herdsman/commit/d80df037a0d6a5ada09d3602b5e6fe39a696089f))
* **manager:** resolve repository and Manager authority independently of workspace order ([#638](https://github.com/boadij/pi-herdsman/issues/638)) ([e766992](https://github.com/boadij/pi-herdsman/commit/e766992d5627d170a4c56942e9531a61e3988400))
* **ui:** unify status lifecycle and freshness presentation ([#641](https://github.com/boadij/pi-herdsman/issues/641)) ([066c155](https://github.com/boadij/pi-herdsman/commit/066c155c4eafd6b60647d0ba6d92e041bc77c687))

## [0.34.0](https://github.com/boadij/pi-herdsman/compare/v0.33.1...v0.34.0) (2026-10-27)


### Features

* **manager:** initialize Git repositories on explicit activation ([#609](https://github.com/boadij/pi-herdsman/issues/609)) ([ac878e9](https://github.com/boadij/pi-herdsman/commit/ac878e9f2084848818db383214eaa49e2131b352))


### Fixes

* **agent:** preserve continuation after verified stop ([#620](https://github.com/boadij/pi-herdsman/issues/620)) ([9df5180](https://github.com/boadij/pi-herdsman/commit/9df518042ed7d57c3c5fd04308a0f091f7067a6b))
* **coordination:** clarify lifecycle tool contracts and results ([#623](https://github.com/boadij/pi-herdsman/issues/623)) ([87542da](https://github.com/boadij/pi-herdsman/commit/87542daf05cff4c79b3960ba71315cb7cfa4ec37))
* **coordination:** clarify supervisor and peer messaging ([#627](https://github.com/boadij/pi-herdsman/issues/627)) ([0ee23c3](https://github.com/boadij/pi-herdsman/commit/0ee23c393f0441a68d0add87772ec8cbe9da07bd))
* **manager:** allow safe legacy orphan retirement ([#628](https://github.com/boadij/pi-herdsman/issues/628)) ([1afcab3](https://github.com/boadij/pi-herdsman/commit/1afcab376e8c67ae4155ce630b35c242f0237628))
* **manager:** default new Git bootstrap repositories to main ([#629](https://github.com/boadij/pi-herdsman/issues/629)) ([5869bea](https://github.com/boadij/pi-herdsman/commit/5869bea6168fdfecb8df75c2fdbf609aacacedbd))
* **manager:** retire failed-start project assignments safely ([#617](https://github.com/boadij/pi-herdsman/issues/617)) ([5df49d7](https://github.com/boadij/pi-herdsman/commit/5df49d72cfdeec3a101c501353e3207ad3c9873a))
* **supervision:** wait for project assignment authority ([#624](https://github.com/boadij/pi-herdsman/issues/624)) ([87c2ecb](https://github.com/boadij/pi-herdsman/commit/87c2ecb90c4767b0e311bd0576087dd9444c10df))


### Refactoring

* **test:** eliminate redundant suite coverage and fixtures ([#631](https://github.com/boadij/pi-herdsman/issues/631)) ([f8fc67b](https://github.com/boadij/pi-herdsman/commit/f8fc67b7583a239c2df90662a755e9fca41f302e)), closes [#630](https://github.com/boadij/pi-herdsman/issues/630)


### Documentation

* **agents:** clarify capability-based delegation descriptions ([#610](https://github.com/boadij/pi-herdsman/issues/610)) ([40c7534](https://github.com/boadij/pi-herdsman/commit/40c7534d00beb8c47b1a768ff08838091533a78e))


### CI

* use static peer federation job name ([#632](https://github.com/boadij/pi-herdsman/issues/632)) ([51a757c](https://github.com/boadij/pi-herdsman/commit/51a757cfc4676109de7293d75a31de44652e0056))


### Other Changes

* **deps:** update ghcr.io/jdx/mise docker tag to v2026.10.20 ([#626](https://github.com/boadij/pi-herdsman/issues/626)) ([7ce4643](https://github.com/boadij/pi-herdsman/commit/7ce464313a696fbf383e016c0f6c570896f16f0c))
* **deps:** update ghcr.io/jdx/mise docker tag to v2026.10.21 ([#633](https://github.com/boadij/pi-herdsman/issues/633)) ([c3723b4](https://github.com/boadij/pi-herdsman/commit/c3723b40fea944b082fc46b34d6071cb6a5e349f))

## [0.33.1](https://github.com/boadij/pi-herdsman/compare/v0.33.0...v0.33.1) (2026-10-25)


### Fixes

* **coordination:** prefer direct peer collaboration across supervisors ([#597](https://github.com/boadij/pi-herdsman/issues/597)) ([4c87b23](https://github.com/boadij/pi-herdsman/commit/4c87b231598a9f0f7660abd18ce67dadfd43bd90))
* **instructions:** isolate ordinary and managed Lead contracts ([#605](https://github.com/boadij/pi-herdsman/issues/605)) ([c393b54](https://github.com/boadij/pi-herdsman/commit/c393b5415f8a262b35b678c9d4d9d01482348ef8))
* **lead:** serialize project authority with delegation publication ([#601](https://github.com/boadij/pi-herdsman/issues/601)) ([121744f](https://github.com/boadij/pi-herdsman/commit/121744f87ff5179c3fa38e8bd4480ccccbc6e95a))
* **lock:** handle concurrent lock retirement during acquisition ([#604](https://github.com/boadij/pi-herdsman/issues/604)) ([c11e92c](https://github.com/boadij/pi-herdsman/commit/c11e92c003cd580c0a2cd3fc715ec9ad996f990e))
* **peer:** require fresh Lead discovery and diagnose send rejection ([#594](https://github.com/boadij/pi-herdsman/issues/594)) ([405395d](https://github.com/boadij/pi-herdsman/commit/405395d9cb39d49b2b0bcd28a2d571fce6bc84ca))
* **smoke:** report failed supervisor handoffs promptly ([#603](https://github.com/boadij/pi-herdsman/issues/603)) ([623c1dc](https://github.com/boadij/pi-herdsman/commit/623c1dc25d16aa38b5d3b059ea23ba4792fad583))
* **supervision:** deduplicate Herdr worktree discovery ([#608](https://github.com/boadij/pi-herdsman/issues/608)) ([c08b4ec](https://github.com/boadij/pi-herdsman/commit/c08b4ecb45e384b83f53e0b3b3bdf286cf9acd71))


### Documentation

* align current coordination and validation guidance ([#600](https://github.com/boadij/pi-herdsman/issues/600)) ([dc75aa3](https://github.com/boadij/pi-herdsman/commit/dc75aa3ff2d3ed1346666485f15d3a26a5112e1e))
* **readme:** restore Pi and herdr orchestration positioning ([#607](https://github.com/boadij/pi-herdsman/issues/607)) ([1066232](https://github.com/boadij/pi-herdsman/commit/10662322fb5a40b533977acd61a9c17ecde58400))

## [0.33.0](https://github.com/boadij/pi-herdsman/compare/v0.32.1...v0.33.0) (2026-10-24)


### Features

* **agent:** prefer context-relevant session continuation ([#569](https://github.com/boadij/pi-herdsman/issues/569)) ([00f8b86](https://github.com/boadij/pi-herdsman/commit/00f8b867408173b47aaa094f2f06d51d469bca76)), closes [#568](https://github.com/boadij/pi-herdsman/issues/568)
* **manager:** integrate managed branches and finalize worktrees ([#575](https://github.com/boadij/pi-herdsman/issues/575)) ([21cb133](https://github.com/boadij/pi-herdsman/commit/21cb1336cab7a140b82bf7e8ff34f28a649640e3))
* **peer:** coordinate Managers across Herdr machines ([#508](https://github.com/boadij/pi-herdsman/issues/508)) ([75924b3](https://github.com/boadij/pi-herdsman/commit/75924b3b1634a8f56a46def0273bf84d66003741))
* **peer:** federate ordinary Leads across Herdr machines ([#573](https://github.com/boadij/pi-herdsman/issues/573)) ([4bba4c7](https://github.com/boadij/pi-herdsman/commit/4bba4c7b24e35e9be072dc8d370a1669f51c4bca))
* **peer:** show reply-only Managers in peer discovery ([#562](https://github.com/boadij/pi-herdsman/issues/562)) ([49b348d](https://github.com/boadij/pi-herdsman/commit/49b348d69ef7ad12d8f67c2e310b713c17177424)), closes [#561](https://github.com/boadij/pi-herdsman/issues/561) [#474](https://github.com/boadij/pi-herdsman/issues/474) [#508](https://github.com/boadij/pi-herdsman/issues/508) [#547](https://github.com/boadij/pi-herdsman/issues/547) [#549](https://github.com/boadij/pi-herdsman/issues/549) [#203](https://github.com/boadij/pi-herdsman/issues/203)


### Fixes

* **agent:** avoid futile continuation of retired sessions ([#553](https://github.com/boadij/pi-herdsman/issues/553)) ([c6e7c23](https://github.com/boadij/pi-herdsman/commit/c6e7c23fd00d5530d9419f612b47c121702bd583))
* **ci:** reconcile npm PR preview lifecycle ([#572](https://github.com/boadij/pi-herdsman/issues/572)) ([b7b29e7](https://github.com/boadij/pi-herdsman/commit/b7b29e7a6396b31948f6c119b241a314e36bf817))
* **ci:** recover incomplete release publication ([#551](https://github.com/boadij/pi-herdsman/issues/551)) ([cdca764](https://github.com/boadij/pi-herdsman/commit/cdca76435106be69b71bb78d979b6a2675ee6977))
* **instructions:** expose the verified active role to the model ([#581](https://github.com/boadij/pi-herdsman/issues/581)) ([073e265](https://github.com/boadij/pi-herdsman/commit/073e2653c6343ffc3492a4e5d9d9fc8b6fa02e08))
* **lock:** prevent false liveness after PID reuse ([#567](https://github.com/boadij/pi-herdsman/issues/567)) ([f5ec2c3](https://github.com/boadij/pi-herdsman/commit/f5ec2c307c919231a43116db368cb3608a33118e))
* **onboarding:** simplify first use and reconcile existing installations ([#558](https://github.com/boadij/pi-herdsman/issues/558)) ([6a946fb](https://github.com/boadij/pi-herdsman/commit/6a946fb6c7cb2a8d4e70726580c06f68e5bbef46))
* **peer:** restore timely unattended Manager replies ([#549](https://github.com/boadij/pi-herdsman/issues/549)) ([893962e](https://github.com/boadij/pi-herdsman/commit/893962e837aa8b066a8830f5515914ba8986d4ea))
* **peer:** show origin identity for reply-only Managers ([#565](https://github.com/boadij/pi-herdsman/issues/565)) ([3435e2f](https://github.com/boadij/pi-herdsman/commit/3435e2f64a0589c66dfa2767ed674aff6c006d68))
* **runtime:** prevent stale presentation callbacks after session replacement ([#580](https://github.com/boadij/pi-herdsman/issues/580)) ([a31b790](https://github.com/boadij/pi-herdsman/commit/a31b79088f70c88cc49accb40e499e3297db33e1))
* **runtime:** remove invalid startup metadata publication ([#585](https://github.com/boadij/pi-herdsman/issues/585)) ([ca2a0a9](https://github.com/boadij/pi-herdsman/commit/ca2a0a9905e451483454ee602aa007a8b9b78175))
* **supervision:** avoid redundant managed Lead completion announcements ([#556](https://github.com/boadij/pi-herdsman/issues/556)) ([cd700af](https://github.com/boadij/pi-herdsman/commit/cd700af1443629b31d8fb584c17db8904fb739df))
* **supervision:** preserve ordinary Lead reporting guidance ([#557](https://github.com/boadij/pi-herdsman/issues/557)) ([12b861c](https://github.com/boadij/pi-herdsman/commit/12b861c3efa9c722c90bd1d7506459b271c0a647))
* **supervision:** surface incompatible staff without granting actions ([#582](https://github.com/boadij/pi-herdsman/issues/582)) ([0e2203d](https://github.com/boadij/pi-herdsman/commit/0e2203d47eb7ec59b2c51289d087a79a8ad8e07a))


### Performance

* **ci:** scope expensive acceptance and consolidate validation ([#592](https://github.com/boadij/pi-herdsman/issues/592)) ([5efdcf5](https://github.com/boadij/pi-herdsman/commit/5efdcf5548cf6de72d47337507805487e276311b)), closes [#590](https://github.com/boadij/pi-herdsman/issues/590)
* **test:** isolate slow startup diagnostics for parallel execution ([#593](https://github.com/boadij/pi-herdsman/issues/593)) ([486d154](https://github.com/boadij/pi-herdsman/commit/486d154f68fd97e2cd2c2668d2c76b475b7f0584))


### Documentation

* protect privacy while preserving attribution ([#554](https://github.com/boadij/pi-herdsman/issues/554)) ([d0135e1](https://github.com/boadij/pi-herdsman/commit/d0135e1c37a667405035191d1f41a963e7c63928))
* require sensitive-data review before publication ([#550](https://github.com/boadij/pi-herdsman/issues/550)) ([d7190bd](https://github.com/boadij/pi-herdsman/commit/d7190bd077429f792c7bd7158c6bdce7a4207bd8))


### Tests

* **ci:** diagnose Windows peer correspondence worker failures ([#560](https://github.com/boadij/pi-herdsman/issues/560)) ([5b95fbc](https://github.com/boadij/pi-herdsman/commit/5b95fbcae48204a92f45f92f45e85b11d8421b32))
* **ci:** stabilize peer authorization checks on Windows ([#546](https://github.com/boadij/pi-herdsman/issues/546)) ([c8a7a5a](https://github.com/boadij/pi-herdsman/commit/c8a7a5ab0d6aad582644b5d182e4cc06aca3cc1e))
* **runtime:** verify malformed Chief coordination diagnostics ([#586](https://github.com/boadij/pi-herdsman/issues/586)) ([0804c3c](https://github.com/boadij/pi-herdsman/commit/0804c3c1d47b14a0fa964f581e20aee21701e3e2)), closes [#584](https://github.com/boadij/pi-herdsman/issues/584)


### Other Changes

* **deps:** update ghcr.io/jdx/mise docker tag to v2026.10.18 ([#570](https://github.com/boadij/pi-herdsman/issues/570)) ([a056e64](https://github.com/boadij/pi-herdsman/commit/a056e64b43169c8c2e2dc96c48804fc294f74b8c))
* **deps:** update ghcr.io/jdx/mise docker tag to v2026.10.19 ([#589](https://github.com/boadij/pi-herdsman/issues/589)) ([62af5d2](https://github.com/boadij/pi-herdsman/commit/62af5d250a89e3c3841d4488b416d0ed047399ad))

## [0.32.1](https://github.com/boadij/pi-herdsman/compare/v0.32.0...v0.32.1) (2026-10-22)


### Fixes

* **agent:** preserve accepted assignments during cleanup contention ([#544](https://github.com/boadij/pi-herdsman/issues/544)) ([d95d715](https://github.com/boadij/pi-herdsman/commit/d95d715f6b8d808300d4b30ce7dfc655f1b9c7fe)), closes [#503](https://github.com/boadij/pi-herdsman/issues/503)
* **deps:** exclude Node runtime version updates ([#526](https://github.com/boadij/pi-herdsman/issues/526)) ([3cd1ed8](https://github.com/boadij/pi-herdsman/commit/3cd1ed8946018826f3a091d084b5b6ec675248cf))
* **deps:** match Node runtime by dependency name ([#527](https://github.com/boadij/pi-herdsman/issues/527)) ([8e2196b](https://github.com/boadij/pi-herdsman/commit/8e2196bed14528e44a665088d59d0bf59a2d6a59))
* **deps:** retry npm lockfile generation ([#542](https://github.com/boadij/pi-herdsman/issues/542)) ([a91a87b](https://github.com/boadij/pi-herdsman/commit/a91a87bb35e5bac7d7f5b5a6c07525f825a52659))


### Tests

* **ci:** decouple release assertion from setup-node major version ([#539](https://github.com/boadij/pi-herdsman/issues/539)) ([eefb45e](https://github.com/boadij/pi-herdsman/commit/eefb45eca0c2b1fba128d36ca332f1053c2c2eb0))
* **smoke:** gate Manager handoff on verified Lead provenance ([#528](https://github.com/boadij/pi-herdsman/issues/528)) ([7283128](https://github.com/boadij/pi-herdsman/commit/7283128737d2c32fc6c6e15ae99e3fc1c6b0403e))


### Other Changes

* **deps:** configure Renovate updates ([#523](https://github.com/boadij/pi-herdsman/issues/523)) ([dd146e7](https://github.com/boadij/pi-herdsman/commit/dd146e70e3cfbfb460e4d353b80f4b46cd605dce))
* **deps:** update actions/checkout action to v7 ([#534](https://github.com/boadij/pi-herdsman/issues/534)) ([0b7ca97](https://github.com/boadij/pi-herdsman/commit/0b7ca9701cb073e6aa8a9444351b4a263fb7da2f))
* **deps:** update actions/setup-node action to v7 ([#535](https://github.com/boadij/pi-herdsman/issues/535)) ([957aaf0](https://github.com/boadij/pi-herdsman/commit/957aaf07c86d4d8b229812ab525b1a437e89e944))
* **deps:** update dependency @howaboua/pi-codex-conversion to v4 ([#536](https://github.com/boadij/pi-herdsman/issues/536)) ([ae7f9c6](https://github.com/boadij/pi-herdsman/commit/ae7f9c695189babcbfb70f4c133bb972fd635567))
* **deps:** update dependency typebox to v1.4.3 ([#529](https://github.com/boadij/pi-herdsman/issues/529)) ([aade3ce](https://github.com/boadij/pi-herdsman/commit/aade3ceff58f7e449209acca2a303c3b9beffa32))
* **deps:** update ghcr.io/jdx/mise docker tag to v2026.10.17 ([#530](https://github.com/boadij/pi-herdsman/issues/530)) ([0565079](https://github.com/boadij/pi-herdsman/commit/0565079f7eb96860b870f8adf95d4774750086a2))
* **deps:** update node.js to v26.12.1 ([#532](https://github.com/boadij/pi-herdsman/issues/532)) ([4cbbcb7](https://github.com/boadij/pi-herdsman/commit/4cbbcb709f16a4c8707ea67491e923b01f2df7a9))
* **deps:** update tailscale/tailscale docker tag to v1.104.2 ([#533](https://github.com/boadij/pi-herdsman/issues/533)) ([3cb3ebb](https://github.com/boadij/pi-herdsman/commit/3cb3ebb4583bb558cee1ec0bd6fa4025a5d6c43f))

## [0.32.0](https://github.com/boadij/pi-herdsman/compare/v0.31.1...v0.32.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **lead:** use dedicated Managed Lead sessions ([#477](https://github.com/boadij/pi-herdsman/issues/477))

### Features

* **evidence:** deliver historical requirements through semantic refs ([#493](https://github.com/boadij/pi-herdsman/issues/493)) ([50e9f81](https://github.com/boadij/pi-herdsman/commit/50e9f815f22fa9b435917ba0459c8666d2e9abc4))
* **evidence:** preserve current batches and report handoff receipts ([#502](https://github.com/boadij/pi-herdsman/issues/502)) ([7064231](https://github.com/boadij/pi-herdsman/commit/7064231fe441d41f4c417c9d95dcc4c075aeb0b5))
* **lead:** use dedicated Managed Lead sessions ([#477](https://github.com/boadij/pi-herdsman/issues/477)) ([ffb8533](https://github.com/boadij/pi-herdsman/commit/ffb8533f1a7d7e557026467eff4003c200fc9fcc))


### Fixes

* **agent:** prevent transient managed authority loss during verification ([#516](https://github.com/boadij/pi-herdsman/issues/516)) ([a29ffd6](https://github.com/boadij/pi-herdsman/commit/a29ffd6d37ec22c064253bd87e2ab3f78cdb8980))
* **agent:** recover interrupted execution and historical continuation ([#501](https://github.com/boadij/pi-herdsman/issues/501)) ([dc6ecf3](https://github.com/boadij/pi-herdsman/commit/dc6ecf3fcb491d4ea7685a9ad73e1fa673e4cc10))
* **manager:** handle delayed worktree removal completion ([#507](https://github.com/boadij/pi-herdsman/issues/507)) ([18fc48d](https://github.com/boadij/pi-herdsman/commit/18fc48df319790b7283c1bda7251295996cacc4a))
* **manager:** make removal approvals durable and accessible ([#520](https://github.com/boadij/pi-herdsman/issues/520)) ([9bd746a](https://github.com/boadij/pi-herdsman/commit/9bd746af4f219ad749563cf6fd9af5b622096c21))
* **manager:** restore actionable removal with project-scoped approval ([#513](https://github.com/boadij/pi-herdsman/issues/513)) ([39ecb1e](https://github.com/boadij/pi-herdsman/commit/39ecb1e32407f37014923d60c4728c221cb24661))
* **manager:** serialize project-assignment lock acquisition ([#491](https://github.com/boadij/pi-herdsman/issues/491)) ([5d5cb0b](https://github.com/boadij/pi-herdsman/commit/5d5cb0b38c2a9b7bcde8623811c8d8a672d0a08f))
* **smoke:** diagnose accepted nested delegation stalls ([#505](https://github.com/boadij/pi-herdsman/issues/505)) ([fbfdd00](https://github.com/boadij/pi-herdsman/commit/fbfdd006e38f8e768b0cfee63e6ef8de63c49176))
* **ui:** restore static indicators and lowercase lead modes ([#514](https://github.com/boadij/pi-herdsman/issues/514)) ([6048398](https://github.com/boadij/pi-herdsman/commit/60483987b9d7611c02fb50488b754a6d277d6322))


### Refactoring

* **prompts:** clarify Manager and managed Lead ownership ([#492](https://github.com/boadij/pi-herdsman/issues/492)) ([7c00506](https://github.com/boadij/pi-herdsman/commit/7c005066b25d2a3a1866e018b92ca8f74163dac7))


### Documentation

* add pull request template ([#521](https://github.com/boadij/pi-herdsman/issues/521)) ([9c669fd](https://github.com/boadij/pi-herdsman/commit/9c669fd57531af7395ada8d032f7b089e11c08db))
* establish positional salience principle for model-facing context ([#494](https://github.com/boadij/pi-herdsman/issues/494)) ([757901d](https://github.com/boadij/pi-herdsman/commit/757901d05ceb96b485f1fd68326ae9e626551688))
* **principles:** minimize model-facing reference burden ([#488](https://github.com/boadij/pi-herdsman/issues/488)) ([3f45b4b](https://github.com/boadij/pi-herdsman/commit/3f45b4b2efe739ad921cbf95ccc1108a1b01e22a))


### Tests

* **ci:** restore Windows suite headroom ([#498](https://github.com/boadij/pi-herdsman/issues/498)) ([a86f21a](https://github.com/boadij/pi-herdsman/commit/a86f21a4ef6d3ff105898b03bd49c8e76ea7bc02)), closes [#497](https://github.com/boadij/pi-herdsman/issues/497)


### Other Changes

* **runtime:** adopt Pi 1.4.0 ([#519](https://github.com/boadij/pi-herdsman/issues/519)) ([cffa319](https://github.com/boadij/pi-herdsman/commit/cffa319d2690b90c13d816d51d2fac1e5c7c930f))

## [0.31.1](https://github.com/boadij/pi-herdsman/compare/v0.31.0...v0.31.1) (2026-10-20)


### Fixes

* **agent:** restore scoped continuation after mailbox cleanup ([#482](https://github.com/boadij/pi-herdsman/issues/482)) ([8df4f2d](https://github.com/boadij/pi-herdsman/commit/8df4f2d4fa91fcbfb645c3abd197e08ecf628f6e))
* **coordination:** deliver complete text evidence within configured limits ([#481](https://github.com/boadij/pi-herdsman/issues/481)) ([cadad11](https://github.com/boadij/pi-herdsman/commit/cadad11fdadd43c4288c7b7518424655dc94c450))
* **lead:** preserve live inherited tools across reconciliation ([#463](https://github.com/boadij/pi-herdsman/issues/463)) ([4aa5a3e](https://github.com/boadij/pi-herdsman/commit/4aa5a3e7a0c7297b0fb0cc73b87d9a593e55efbc))


### Tests

* **ci:** make attachment mutation regression portable ([#485](https://github.com/boadij/pi-herdsman/issues/485)) ([73b33af](https://github.com/boadij/pi-herdsman/commit/73b33af08d37aa461528e299460dd04c877e88ad))

## [0.31.0](https://github.com/boadij/pi-herdsman/compare/v0.30.0...v0.31.0) (2026-10-19)


### Features

* **coordination:** propagate required assignment evidence ([#450](https://github.com/boadij/pi-herdsman/issues/450)) ([c6e6de1](https://github.com/boadij/pi-herdsman/commit/c6e6de170b7bc70d604482b21dfde57c4cd1dee7))
* **ui:** clarify definitions and project settings ([#461](https://github.com/boadij/pi-herdsman/issues/461)) ([9317d78](https://github.com/boadij/pi-herdsman/commit/9317d7809fc6c576fa814cd0f4f51087757623a4))


### Fixes

* **evidence:** name generated assignment notes as Markdown ([#472](https://github.com/boadij/pi-herdsman/issues/472)) ([8749f82](https://github.com/boadij/pi-herdsman/commit/8749f8263e43b12f404720e0def38026581bfd2d))
* **evidence:** restrict project retention to Manager ([#467](https://github.com/boadij/pi-herdsman/issues/467)) ([e6c29e2](https://github.com/boadij/pi-herdsman/commit/e6c29e23e260b737d7018a5a79210e72e870dcf7))
* **evidence:** use Markdown extension for project briefs ([#460](https://github.com/boadij/pi-herdsman/issues/460)) ([801acb1](https://github.com/boadij/pi-herdsman/commit/801acb19a40056238d1324158a9aef2392285d13))
* **manager:** decouple worktree confirmation from coordination ([#475](https://github.com/boadij/pi-herdsman/issues/475)) ([31561eb](https://github.com/boadij/pi-herdsman/commit/31561ebcde9fd00e923dcc13a4e5434ee359e7aa))
* **smoke:** fail fast on failed project delegation ([#456](https://github.com/boadij/pi-herdsman/issues/456)) ([74489b0](https://github.com/boadij/pi-herdsman/commit/74489b06c3c8f5c57c645238ea6e4388f9c67fdd)), closes [#454](https://github.com/boadij/pi-herdsman/issues/454)
* **test:** prevent startup-lock test contamination ([#464](https://github.com/boadij/pi-herdsman/issues/464)) ([717dca7](https://github.com/boadij/pi-herdsman/commit/717dca75603a551152629201782ec6ab20a99c65))
* **ui:** unify Herdsman menu spacing ([#468](https://github.com/boadij/pi-herdsman/issues/468)) ([758af3e](https://github.com/boadij/pi-herdsman/commit/758af3efbb732261c12579a2becf3d80d05dacd8))


### Refactoring

* **instructions:** keep bundled definitions strategy-only ([#473](https://github.com/boadij/pi-herdsman/issues/473)) ([733ca18](https://github.com/boadij/pi-herdsman/commit/733ca18b076fcc6cf12a7cd8c3cc03309b3bcf01))
* **instructions:** preserve tool contracts across role overrides ([#459](https://github.com/boadij/pi-herdsman/issues/459)) ([1dfbaa3](https://github.com/boadij/pi-herdsman/commit/1dfbaa3476dc4b67db338252fcf9ada1a66a0b71))

## [0.30.0](https://github.com/boadij/pi-herdsman/compare/v0.29.0...v0.30.0) (2026-10-18)


### Features

* **config:** support trusted project preference overrides ([#446](https://github.com/boadij/pi-herdsman/issues/446)) ([5189afa](https://github.com/boadij/pi-herdsman/commit/5189afa4741edb3f58670f9f14bff43b5b9933fa))
* **manager:** deliver passive worktree retirement notices ([#436](https://github.com/boadij/pi-herdsman/issues/436)) ([dbbba71](https://github.com/boadij/pi-herdsman/commit/dbbba71a9f4aee1eb2d48c12624dcee5939fa2e0))


### Fixes

* **lock:** prevent stranded locks after interrupted release ([#435](https://github.com/boadij/pi-herdsman/issues/435)) ([31b5b98](https://github.com/boadij/pi-herdsman/commit/31b5b985299f519a9a1921431c8f46a05303b541))
* **manager:** preserve pending handoffs during project retirement ([#434](https://github.com/boadij/pi-herdsman/issues/434)) ([00c05a8](https://github.com/boadij/pi-herdsman/commit/00c05a8fd9de2142c10ed86db3da26bf84850c30))


### Tests

* **smoke:** cover Agent failures and Manager handoff recovery ([#448](https://github.com/boadij/pi-herdsman/issues/448)) ([36ea3f9](https://github.com/boadij/pi-herdsman/commit/36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4))


### Other Changes

* **repo:** add lightweight GitHub issue forms ([#445](https://github.com/boadij/pi-herdsman/issues/445)) ([cf9a62f](https://github.com/boadij/pi-herdsman/commit/cf9a62f45c674271302e594969d3d15be05afa1a)), closes [#443](https://github.com/boadij/pi-herdsman/issues/443)

## [0.29.0](https://github.com/boadij/pi-herdsman/compare/v0.28.0...v0.29.0) (2026-10-17)


### ⚠ BREAKING CHANGES

* **supervision:** unify direct-report capabilities ([#419](https://github.com/boadij/pi-herdsman/issues/419))

### Features

* **supervision:** unify direct-report capabilities ([#419](https://github.com/boadij/pi-herdsman/issues/419)) ([1cca816](https://github.com/boadij/pi-herdsman/commit/1cca816276306abbe4d3e1f21c6ac8180f626cc6))


### Fixes

* **manager:** ignore unrelated Leads in project work status ([#426](https://github.com/boadij/pi-herdsman/issues/426)) ([be8a6c9](https://github.com/boadij/pi-herdsman/commit/be8a6c958c5c2bcb7b805e4c5c9f6cecf106756f))
* **peer:** recognize project-message directories in authority scans ([#429](https://github.com/boadij/pi-herdsman/issues/429)) ([3e4b13b](https://github.com/boadij/pi-herdsman/commit/3e4b13b923a0c0bd920ef533d66c027d1756dd2c))
* **runtime:** tolerate incidental metadata in authority scans and locks ([#425](https://github.com/boadij/pi-herdsman/issues/425)) ([0be6ffa](https://github.com/boadij/pi-herdsman/commit/0be6ffad4f958a4ade982f17b28029c5fd490000))
* **smoke:** gate simulated continuation completion on live evidence ([#431](https://github.com/boadij/pi-herdsman/issues/431)) ([390923d](https://github.com/boadij/pi-herdsman/commit/390923daee8dc326aad6796f5b587cbffc1b2b32))
* **tools:** use portable non-empty coordination strings ([#433](https://github.com/boadij/pi-herdsman/issues/433)) ([ed87613](https://github.com/boadij/pi-herdsman/commit/ed876134fdb778d006d2a19e50b866b0462d6f13))


### Tests

* **ci:** gate runtime changes with simulated smoke acceptance ([#418](https://github.com/boadij/pi-herdsman/issues/418)) ([37e54ab](https://github.com/boadij/pi-herdsman/commit/37e54ab03a560fc6f0aa2f1e5d4bc4c1540268b4))

## [0.28.0](https://github.com/boadij/pi-herdsman/compare/v0.27.0...v0.28.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **manager:** default to coordination-only tools ([#411](https://github.com/boadij/pi-herdsman/issues/411))

### Features

* **agents:** enable optional Manager and Chief delegation ([#409](https://github.com/boadij/pi-herdsman/issues/409)) ([9fd51d8](https://github.com/boadij/pi-herdsman/commit/9fd51d81038cf1265ea2864ff52ab9059bef99e9))
* **peer:** scope managed Leads to verified worktree groups ([#406](https://github.com/boadij/pi-herdsman/issues/406)) ([3e45a1b](https://github.com/boadij/pi-herdsman/commit/3e45a1b47b96a571e685cd9e5d5ae3f7244f92e7))
* **supervision:** include ordinary Leads in project supervision ([#405](https://github.com/boadij/pi-herdsman/issues/405)) ([1d0a407](https://github.com/boadij/pi-herdsman/commit/1d0a4073bd0ae2114b9bf132e20661b248658a8a))
* **ui:** expose worktree removal in Manager overview ([#401](https://github.com/boadij/pi-herdsman/issues/401)) ([f2064d9](https://github.com/boadij/pi-herdsman/commit/f2064d9536b7fe25ad053371bed9517ff121abf4))


### Fixes

* **lifecycle:** settle prompt-hook shells safely ([#388](https://github.com/boadij/pi-herdsman/issues/388)) ([6f9706d](https://github.com/boadij/pi-herdsman/commit/6f9706d01a06d8d8d924796e1aed30699c01d299))
* **supervision:** wake ordinary Leads on Manager messages ([#413](https://github.com/boadij/pi-herdsman/issues/413)) ([a47b2d9](https://github.com/boadij/pi-herdsman/commit/a47b2d942977fe6662f47d41f1877c7694a2fb25))


### Refactoring

* **instructions:** remove prescribed coordination workspace ([#399](https://github.com/boadij/pi-herdsman/issues/399)) ([f0267ac](https://github.com/boadij/pi-herdsman/commit/f0267ac823c6aa8c9679a3c4074fbc45c723ac7d))
* **manager:** default to coordination-only tools ([#411](https://github.com/boadij/pi-herdsman/issues/411)) ([4c3ca87](https://github.com/boadij/pi-herdsman/commit/4c3ca8764e9e69b7219da7881a423237ba1d01a5))


### Documentation

* **principles:** minimize model decision burden ([#407](https://github.com/boadij/pi-herdsman/issues/407)) ([7caebe4](https://github.com/boadij/pi-herdsman/commit/7caebe48896390ee739e8ea98ee46456c74d3da3))


### Other Changes

* **runtime:** adopt Pi 1.3.0 ([#404](https://github.com/boadij/pi-herdsman/issues/404)) ([ec4a0bf](https://github.com/boadij/pi-herdsman/commit/ec4a0bf1e19fa3541a17bc2470a151e7f7c093dc))

## [0.27.0](https://github.com/boadij/pi-herdsman/compare/v0.26.0...v0.27.0) (2026-10-15)


### Features

* **agents:** clarify internal review and roster-agnostic guidance ([#384](https://github.com/boadij/pi-herdsman/issues/384)) ([0dc62d3](https://github.com/boadij/pi-herdsman/commit/0dc62d39b63afe2d273d687b9e49e7114f2fcfa3))
* **agents:** streamline runtime capability discovery ([#380](https://github.com/boadij/pi-herdsman/issues/380)) ([a422c80](https://github.com/boadij/pi-herdsman/commit/a422c804b5fdf2f2bf631695bb12d8539e053071))


### Fixes

* **agents:** follow symlinked agent definitions ([#392](https://github.com/boadij/pi-herdsman/issues/392)) ([d919eae](https://github.com/boadij/pi-herdsman/commit/d919eaed8383fc56a2e8a9eeabfaa9cb21470e26))
* **agents:** remove misleading shared shell guidance ([#396](https://github.com/boadij/pi-herdsman/issues/396)) ([c373f45](https://github.com/boadij/pi-herdsman/commit/c373f458ca3cb7cc5f487acd7d1d034f56082c3d))
* **runtime:** adopt Pi 1.2.0 and validate custom-message startup ([#385](https://github.com/boadij/pi-herdsman/issues/385)) ([24e085b](https://github.com/boadij/pi-herdsman/commit/24e085b14598dc3990c36a4c83cc7715735cee62))


### Tests

* **smoke:** own Herdr bootstrap and preserve failure evidence ([#394](https://github.com/boadij/pi-herdsman/issues/394)) ([1a7c90d](https://github.com/boadij/pi-herdsman/commit/1a7c90d66cf961659d419a79f292d35d486c6b5c))


### Other Changes

* **runtime:** adopt Herdr 0.9.5 ([#397](https://github.com/boadij/pi-herdsman/issues/397)) ([0562c43](https://github.com/boadij/pi-herdsman/commit/0562c4392c1e64b35e962a26e68c5ca115090cd6))

## [0.26.0](https://github.com/boadij/pi-herdsman/compare/v0.25.1...v0.26.0) (2026-10-12)


### Features

* **manager:** add accessible worktree removal ([#373](https://github.com/boadij/pi-herdsman/issues/373)) ([d548c48](https://github.com/boadij/pi-herdsman/commit/d548c48e945182d5343d6b1b113f9e7808713e6a))
* **ui:** name Herdr tabs by Herdsman role ([#378](https://github.com/boadij/pi-herdsman/issues/378)) ([c72acad](https://github.com/boadij/pi-herdsman/commit/c72acadfe7ab1f6602bb698c6ef1d29eea34bf35))


### Fixes

* **runtime:** converge terminal execution failures across hierarchy ([#366](https://github.com/boadij/pi-herdsman/issues/366)) ([321114d](https://github.com/boadij/pi-herdsman/commit/321114de1b061502a39aa67cf1f368a42c7b8689))


### Documentation

* clarify architectural history and interface contracts ([#370](https://github.com/boadij/pi-herdsman/issues/370)) ([0447493](https://github.com/boadij/pi-herdsman/commit/0447493b07d26f5c6c03f83ac9f5a3827b897c69))
* **testing:** prefer simulated smoke before live acceptance ([#379](https://github.com/boadij/pi-herdsman/issues/379)) ([56bd025](https://github.com/boadij/pi-herdsman/commit/56bd02583aaba027ab044bf027a4693d558e8f66))


### Tests

* **smoke:** add Pi-native simulated smoke testing ([#377](https://github.com/boadij/pi-herdsman/issues/377)) ([44698e4](https://github.com/boadij/pi-herdsman/commit/44698e40fcd6b5b50d6e073fbbdadf951b424ef5))


### Other Changes

* **dev:** add on-demand simplification audit skill ([#359](https://github.com/boadij/pi-herdsman/issues/359)) ([7cf50e8](https://github.com/boadij/pi-herdsman/commit/7cf50e824b8b5a7a9af0b4130cb533e24a0e0b57))

## [0.25.1](https://github.com/boadij/pi-herdsman/compare/v0.25.0...v0.25.1) (2026-10-10)


### Refactoring

* **controller:** share managed-agent listing dependencies ([#362](https://github.com/boadij/pi-herdsman/issues/362)) ([0869b58](https://github.com/boadij/pi-herdsman/commit/0869b5814e6070bb53dd89a66aab3df18b578b2a)), closes [#360](https://github.com/boadij/pi-herdsman/issues/360)
* **supervision:** consolidate atomic record publication ([#364](https://github.com/boadij/pi-herdsman/issues/364)) ([5b08161](https://github.com/boadij/pi-herdsman/commit/5b0816158464e33387cd34d52f9ad0f38224930b)), closes [#361](https://github.com/boadij/pi-herdsman/issues/361)
* **supervision:** remove unused record aliases ([#365](https://github.com/boadij/pi-herdsman/issues/365)) ([445bb4e](https://github.com/boadij/pi-herdsman/commit/445bb4ed8a62b106aeace064020b99a4051fa57c))

## [0.25.0](https://github.com/boadij/pi-herdsman/compare/v0.24.0...v0.25.0) (2026-10-10)


### Features

* **config:** add Manager and Chief role definitions ([#354](https://github.com/boadij/pi-herdsman/issues/354)) ([bce241d](https://github.com/boadij/pi-herdsman/commit/bce241df0b87d21444824ed231a9836d234e2c84))
* **lead:** align dependency-aware delegation across orchestration Leads ([#356](https://github.com/boadij/pi-herdsman/issues/356)) ([304854b](https://github.com/boadij/pi-herdsman/commit/304854bc514f32e13689f46fd8417be167143b20))
* **session:** automatically name managed Pi sessions ([#358](https://github.com/boadij/pi-herdsman/issues/358)) ([5ff11c6](https://github.com/boadij/pi-herdsman/commit/5ff11c61cd377d9d4b3cee525c3caa576c4a8b86))


### Fixes

* **agents:** stop owned agent trees across workspaces ([#349](https://github.com/boadij/pi-herdsman/issues/349)) ([0c779bb](https://github.com/boadij/pi-herdsman/commit/0c779bb7266fe71eabf3ae80194bb073acb43cfd))
* **dev:** prepare dependencies before delegated worktree startup ([#351](https://github.com/boadij/pi-herdsman/issues/351)) ([87388e7](https://github.com/boadij/pi-herdsman/commit/87388e71a50aff29f289b5888402460b94bd97c6))


### Other Changes

* **dev:** pin Prettier and enforce formatting ([#357](https://github.com/boadij/pi-herdsman/issues/357)) ([540fab0](https://github.com/boadij/pi-herdsman/commit/540fab08421054f28fccd2a0449344409d3eea5a)), closes [#346](https://github.com/boadij/pi-herdsman/issues/346)

## [0.24.0](https://github.com/boadij/pi-herdsman/compare/v0.23.0...v0.24.0) (2026-10-10)


### Features

* **ui:** enable verified click-to-focus in status widgets ([#342](https://github.com/boadij/pi-herdsman/issues/342)) ([b7ca8fd](https://github.com/boadij/pi-herdsman/commit/b7ca8fdbfac7c431d1f4d22bc90ac8c6452c6f7e))


### Fixes

* **supervision:** preserve messages until delivery and reconcile Manager identity ([#339](https://github.com/boadij/pi-herdsman/issues/339)) ([f9b955a](https://github.com/boadij/pi-herdsman/commit/f9b955a815b05b624c8a8f6c343c5c3bf914d860))
* **ui:** repair managed Lead to Manager navigation ([#344](https://github.com/boadij/pi-herdsman/issues/344)) ([d0777bc](https://github.com/boadij/pi-herdsman/commit/d0777bc651ed3ccf4a87cdf646dcf842d7b05fe4))

## [0.23.0](https://github.com/boadij/pi-herdsman/compare/v0.22.2...v0.23.0) (2026-10-09)


### Features

* **agents:** land managed-agent context sharing ([#329](https://github.com/boadij/pi-herdsman/issues/329)) ([2733566](https://github.com/boadij/pi-herdsman/commit/273356684bd43d91c7478cbd9d5e792f8a24fc01))

## [0.22.2](https://github.com/boadij/pi-herdsman/compare/v0.22.1...v0.22.2) (2026-10-09)


### Fixes

* **manager:** reconcile project assignments with worktrees ([#334](https://github.com/boadij/pi-herdsman/issues/334)) ([bc679d7](https://github.com/boadij/pi-herdsman/commit/bc679d7f55af946b1fd7798ded92ea3e149681d3))


### Refactoring

* **lead:** default orchestrators to coordination-only tools ([#336](https://github.com/boadij/pi-herdsman/issues/336)) ([9ee5b39](https://github.com/boadij/pi-herdsman/commit/9ee5b397ac9aa0127dcc2f55f4ad79bbb965576e))


### Documentation

* **adr:** define worktree-backed project assignment lifecycle ([#331](https://github.com/boadij/pi-herdsman/issues/331)) ([123848b](https://github.com/boadij/pi-herdsman/commit/123848b506a8da94f48b1a482fd43dcc87c1358d))
* establish performance and efficiency principle ([#335](https://github.com/boadij/pi-herdsman/issues/335)) ([7d1dfef](https://github.com/boadij/pi-herdsman/commit/7d1dfef0be280d748d21cede5861d35411ff135c))

## [0.22.1](https://github.com/boadij/pi-herdsman/compare/v0.22.0...v0.22.1) (2026-10-09)


### Performance

* **runtime:** reduce idle mailbox polling ([#325](https://github.com/boadij/pi-herdsman/issues/325)) ([4c5c46d](https://github.com/boadij/pi-herdsman/commit/4c5c46dc2bed70408a4b701a7872ed68614fec39))
* **snapshot:** eliminate redundant scans and traversals ([#328](https://github.com/boadij/pi-herdsman/issues/328)) ([9b9c218](https://github.com/boadij/pi-herdsman/commit/9b9c2186c68477884b009da9d4df0f19db49c8b7)), closes [#321](https://github.com/boadij/pi-herdsman/issues/321)
* **supervision:** reduce redundant fleet observation ([#326](https://github.com/boadij/pi-herdsman/issues/326)) ([91c5422](https://github.com/boadij/pi-herdsman/commit/91c54221c635efb54138eac5568497db1f7bcd03))


### Documentation

* **readme:** Revise demo description and update demo link ([#322](https://github.com/boadij/pi-herdsman/issues/322)) ([d5bf7e6](https://github.com/boadij/pi-herdsman/commit/d5bf7e62885b20b2a1e6aa0b1b6325fb1c51caa6))

## [0.22.0](https://github.com/boadij/pi-herdsman/compare/v0.21.3...v0.22.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* adopt verb-first coordination semantics ([#297](https://github.com/boadij/pi-herdsman/issues/297))

### Features

* adopt verb-first coordination semantics ([#297](https://github.com/boadij/pi-herdsman/issues/297)) ([05eec19](https://github.com/boadij/pi-herdsman/commit/05eec19182f4d65c2f5d6c291efc3eb444110610))
* **lead:** add configurable execution profiles ([#304](https://github.com/boadij/pi-herdsman/issues/304)) ([96041a0](https://github.com/boadij/pi-herdsman/commit/96041a0e58ca84ccf00d4d4697a523dba4a759c5))
* **manager:** define managed Lead authority and takeover ([#284](https://github.com/boadij/pi-herdsman/issues/284)) ([c063fec](https://github.com/boadij/pi-herdsman/commit/c063fec3412b43131e262ceab37c8503f7947184))
* **ui:** show effective Lead execution mode in status widget ([#318](https://github.com/boadij/pi-herdsman/issues/318)) ([72a1fd2](https://github.com/boadij/pi-herdsman/commit/72a1fd23e3804caf76f1dceaad8f769c6a77367f))


### Fixes

* **config:** preserve agent-definition key order ([#308](https://github.com/boadij/pi-herdsman/issues/308)) ([cfefb54](https://github.com/boadij/pi-herdsman/commit/cfefb54d8da8e7cb6d760751ae84b46691e81e9e))
* **context:** deliver retirement guidance before continuation ([#310](https://github.com/boadij/pi-herdsman/issues/310)) ([c0df272](https://github.com/boadij/pi-herdsman/commit/c0df27207d54ecb0baa5c991fdc7e65c1750c4d5))
* **manager:** clarify project report evidence boundaries ([#315](https://github.com/boadij/pi-herdsman/issues/315)) ([5f48aa9](https://github.com/boadij/pi-herdsman/commit/5f48aa985aff93bdae67f24768fd519e92275387))
* **runtime:** adopt Pi 1.1.0 with cancellation-safe settlement ([#305](https://github.com/boadij/pi-herdsman/issues/305)) ([b452e9b](https://github.com/boadij/pi-herdsman/commit/b452e9bfa710ba464dffd8badea67214526b3d47))
* **ui:** align Agent Definition click expansion ([#296](https://github.com/boadij/pi-herdsman/issues/296)) ([2136666](https://github.com/boadij/pi-herdsman/commit/2136666ae95b46bc20765ba737c3619ad8d2b715)), closes [#295](https://github.com/boadij/pi-herdsman/issues/295)


### Refactoring

* **ui:** make /herdsman the progressive entry point ([#300](https://github.com/boadij/pi-herdsman/issues/300)) ([3603d9f](https://github.com/boadij/pi-herdsman/commit/3603d9fca8b5bbe1cc9682d8c1ca8087dd96c9d6))


### Documentation

* define progressive product power ([#299](https://github.com/boadij/pi-herdsman/issues/299)) ([6454f43](https://github.com/boadij/pi-herdsman/commit/6454f43bf0b5543fa2fb1706bf8ca3e6d3d96dde))


### Other Changes

* **agent-definitions:** standardize frontmatter key order and array syntax ([23fec74](https://github.com/boadij/pi-herdsman/commit/23fec74bbd5bc45b8484dae6034bdf108ca6b2f6))
* **test:** generalize bundled definition path assertion ([#314](https://github.com/boadij/pi-herdsman/issues/314)) ([a61afef](https://github.com/boadij/pi-herdsman/commit/a61afef35cdd78e5ac8153f26c69ff31833e3f14))

## [0.21.3](https://github.com/boadij/pi-herdsman/compare/v0.21.2...v0.21.3) (2026-10-06)


### Fixes

* **package:** update agent-definitions skill path ([#292](https://github.com/boadij/pi-herdsman/issues/292)) ([ef0b1a5](https://github.com/boadij/pi-herdsman/commit/ef0b1a5991e47a37e144fd6be709e13d202b201f))
* **ui:** align custom message click expansion ([#290](https://github.com/boadij/pi-herdsman/issues/290)) ([bb08c0b](https://github.com/boadij/pi-herdsman/commit/bb08c0bce68f5c2cfb00262a53b3ae2c38bcfc66))


### Refactoring

* **skills:** rename pi-herdsman-agent-definitions to agent-definitions ([41d5c02](https://github.com/boadij/pi-herdsman/commit/41d5c02cb8837c791330c3dfbf2f11747b523528))

## [0.21.2](https://github.com/boadij/pi-herdsman/compare/v0.21.1...v0.21.2) (2026-10-06)


### Refactoring

* **context:** persist retirement guidance ([#280](https://github.com/boadij/pi-herdsman/issues/280)) ([e538a4b](https://github.com/boadij/pi-herdsman/commit/e538a4b404c342f7d1ce4468452e3922da7c28be))

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
