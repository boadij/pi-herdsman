# Changelog

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
