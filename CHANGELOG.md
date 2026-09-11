# Changelog

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
