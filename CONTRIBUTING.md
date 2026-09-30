# Contributing

Thanks for taking the time. This is a small tool that holds other people's configuration, so the
bar is less about volume and more about not losing anyone's data.

The long form of the material below lives under [`docs/`](docs/index.md) — architecture, development,
testing, the release process, and the documentation rules themselves. This file stays the contract.

[English](CONTRIBUTING.md) · [中文说明见下](#中文说明)

- [Reporting a problem](#reporting-a-problem)
- [Requesting a feature](#requesting-a-feature)
- [Development setup](#development-setup)
- [What the test suites prove](#what-the-test-suites-prove)
- [Changing behaviour](#changing-behaviour)
- [Changelog](#changelog)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Releases](#releases)
- [Security](#security)
- [中文说明](#中文说明)

## Reporting a problem

Use the [bug report form](https://github.com/soimy/dsh-gist-settings/issues/new?template=bug_report.yml).
It asks for the things that actually decide the answer: your `gist_status` output, the exact tool
call, and your versions.

**Redact before you paste.** A secret gist URL is a bearer read capability — anyone holding it can
read the gist without logging in — and `gist_status` prints those URLs. Your tracked configuration
may also contain API keys inline. Keep the first few characters of a URL (`…/0f8fb0…`) and replace
secret values with `<redacted>`.

If you lost local files, check `<stateDir>/backups/<profile>/` first: a download copies the previous
files there before it overwrites anything, whether or not it was forced.

## Requesting a feature

Use the [feature request form](https://github.com/soimy/dsh-gist-settings/issues/new?template=feature_request.yml).
Describe the situation rather than the API you have in mind.

Two properties are load-bearing here, and a proposal that keeps them is far easier to accept:

- **Never guess.** When both sides changed, the tool stops and asks. When it cannot tell whether a
  gist was deleted or merely unreachable, it refuses rather than minting a replacement.
- **Never delete the last copy.** Pruning removes what is no longer *tracked*; it never removes a
  tracked file that is merely missing from disk.

A feature that trades either away needs a strong argument in the issue.

## Development setup

```bash
git clone https://github.com/soimy/dsh-gist-settings.git
cd dsh-gist-settings
npm install --include=dev       # typescript and @types/node, both exact-pinned devDependencies
npm test                        # builds through `pretest`, then runs the suites and the checks
```

The plugin has no *runtime* dependencies: it deliberately imports nothing from the Harness
installation, imports nothing outside `node:` and ships no dependency of its own, so the suites
themselves use only Node built-ins. What that install adds is the toolchain — the type checker and the
build — as exact-pinned devDependencies, and `--include=dev` is what makes it happen: npm omits
devDependencies whenever `NODE_ENV=production`, and such an install exits 0 having installed nothing,
which reads as success right up until `tsc` is missing.

`index.ts` and `lib/core.ts` are the sources; the Harness loads `dist/`. A profile reaches this package
through a junction inside the profile's own `node_modules`, and Node refuses to strip types for any file
it resolves under `node_modules` — it throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — so the
package cannot be run as raw TypeScript. `npm run build` compiles it (`tsc -p tsconfig.json`),
`npm run build:watch` does the same while watching, and `npm run typecheck` checks the whole
repository — runtime, tests and scripts — through `tsconfig.check.json` without emitting. `dist/` is
regenerated output: never edited by hand, never committed. The tests and `scripts/` are TypeScript too,
and nothing compiles them: Node strips their types as it loads them, which is allowed outside
`node_modules`, so a single suite still runs as `node test/sync.test.ts` with no build step. Only
`test/entry.test.ts` and `test/guards.test.ts` read `dist/`, and `npm test` builds before they run.

To run it against a real profile, install the working copy as a bundle. `install_bundle` links the
directory, so what a reload picks up is `dist/`: an edit to `index.ts` or `lib/core.ts` reaches the
running Harness only after a rebuild, which is what `npm run build:watch` is for.

```
plugin_manager  action: install_bundle  target: <absolute path to this checkout>
```

## What the test suites prove

Knowing which suite covers what saves a lot of guessing. `npm test` compiles first — its `pretest` step
runs `npm run build` — so a test run cannot exercise a stale `dist/`.

| Suite | Cases | Proves |
|---|---|---|
| `npm run test:entry` | 6 | The boundary a profile actually crosses. Other suites import the sources; this one loads the plugin the way the Cordis loader does — by package name, through `exports` — and pins that the export names the build rather than the sources, that the artifact and its declarations exist, that a registering context gets all four tools with the shape the registry requires, and that the build registers exactly what the source does. A wrong export, a missing or stale `dist/`, or an entry that loads and registers nothing each fail it. |
| `npm run test:guards` | 7 | The repository's own invariants, which no behavioural suite can see. It discovers every `.ts` file in the tree rather than listing them, and asserts that each still survives Node's own type stripper; that every relative import — single-line, wrapped, bare or dynamic — names a file that exists (a directory is not a file), and that the runtime still names `.ts`; that no compiled JavaScript is left beside its own source or outside `dist/`; that every string anywhere in `exports`, and every `files` entry, exists after a build (`*` patterns included, which have to match something); that every suite and script is actually *run* by a package script, with the live suite required to stay out of `npm test` itself; that the compiler flags this repository depends on are on in both tsconfigs; and that the declared Node floor is a matrix leg CI genuinely runs. Each case was verified by breaking its invariant by hand and watching only that case go red. |
| `npm run test:sync` | 19 | The engine's whole lifecycle against an in-memory `gh`: create, upload, divergence, download, backup, pruning, recreation, idempotency. |
| `npm run test:tools` | 23 | The tool layer: registration, argument validation, config validation at load, profile-name resolution, and that one failing profile never aborts the others. |
| `npm run test:schema` | 50 | The hand-written definitions against the Harness's *own* validators — the registration contract, the supported JSON Schema subset, argument validation, and that each returned value satisfies its declared output schema — plus the loader's compatibility gate, called on this repository's `package.json` so a peer declaration the installed runtime cannot satisfy fails here rather than in a user's profile. |
| `npm run test:regression` | 32 | The specific defects an adversarial review found. Every case here fails if its fix is reverted. |
| `npm run test:safety` | 38 | The guarantees the README makes: containment for the profile and every tracked file, an all-or-nothing download, `force` doing what it says, recovery of a profile whose directory is gone, one-sync convergence after a remote deletion, cross-process state locking, and a rollback that never overwrites a revision it cannot prove it wrote. |
| `npm run test:docs` | 13 | The documentation checker: the destination shapes Markdown allows (angle brackets, balanced parentheses, backslash escapes) and the containment rule — a link out of the repository, written directly or reached through a link inside it, is refused. Each of those was a real defect at some point, which is why the checker has its own suite. |
| `npm run test:release` | 6 | The release-notes script: the success path, and every way it is meant to refuse a tag — a version that disagrees with `package.json`, no dated section, an empty section, a malformed tag. It is the one script here that normally first runs on a tag push, so the refusals matter as much as the success. |
| `npm run test:live` | 12 | The real GitHub round trip, including a file above the API's truncation threshold. Opt-in, and it deletes every gist it creates. |

`test/schema.test.ts` **fails** rather than skipping when it cannot find a DSH installation, because
a silent skip would leave `npm test` green with none of those checks having run. Set
`DSH_ALLOW_SCHEMA_SKIP=1` when you are working on something unrelated.

`test/safety.test.ts` has a skip mechanism, and it reports skips in the summary rather than counting
them as passes — a security case that quietly does nothing is worse than no case, because it reads as
coverage. The cases are written to avoid needing it: where Windows withholds the privilege for a file
symlink, the same last-segment containment check is exercised with a directory junction.

The regression and safety suites exist because a mutation audit found that 32 of 43 deliberately
injected bugs survived the original suite, and because two later reviews found guards that stopped one
level short of what they claimed. Treat "the tests pass" as a starting point, not a conclusion: prefer
a case that fails before your change.

## Continuous integration

`.github/workflows/ci.yml` runs `npm test` — the same command you run — on Linux, Windows and macOS at
Node 22.x and 24.x, plus one leg on **22.19.0**, the floor `engines` names. That floor is the Harness's,
not the engine's: `@deepseek-harness-tui/dsh-tui` declares `engines: ^22.19 || >=24`, and a plugin
nothing can load is not supported by anything. The platform matrix is
not padding: containment takes a different path per OS (junctions and reserved device names on Windows,
Unicode normalisation on macOS, rename-over-a-file semantics everywhere), so a green Linux run says
nothing about the code path a Windows user gets.

Three things about it are deliberate:

- **The pinned toolchain is installed.** `npm test` builds the JavaScript the Harness loads — `pretest`
  runs `tsc` — so each leg installs it with `npm install --include=dev`: `typescript` and `@types/node`,
  both exact-pinned, and nothing else. The flag is load-bearing rather than decorative: npm omits
  devDependencies whenever `NODE_ENV=production`, and such an install exits 0 having installed nothing,
  so the failure would surface later as a missing `tsc`. There is still no `npm ci` — the package has no
  runtime dependencies and deliberately commits no lockfile, so `npm ci` would refuse to run.
- **`fail-fast` is off.** One platform failing does not cancel the others — which platform disagrees is
  usually the whole diagnosis.
- **The live suite is not in CI.** It writes to a real GitHub account, so it needs a `gist`-scoped token
  and a decision to spend it. Run it yourself with `npm run test:live` when a change touches the API
  round trip; it deletes every gist it creates.

The `typecheck` job closes the gap the matrix cannot see. `npm test` builds the runtime through its
`pretest` step, but it never compiles the suites or the scripts: Node erases their types as it loads
them, and erasing is not checking. A mistyped test therefore passes all seven legs above and fails only
`npm run typecheck`. That job runs the same command once, on the floor, where the runtime, every suite
and every script are checked together.

The `schema` job is separate on purpose. `test/schema.test.ts` checks the hand-written tool
definitions against the Harness's *own* validators, so it needs a Harness installation — and no runner
has one. It runs one leg per version named in `peerDependencies`, reading that list out of the
declaration itself so the matrix cannot drift from it, and installs each version in turn: a declared
target that nothing installs is a claim, not a check. The suite matrix, meanwhile, opts into the schema
suite's explicit skip with `DSH_ALLOW_SCHEMA_SKIP=1`, which prints a `SKIP:` line, so the other cases
still run on all seven legs. The skip is visible in the log rather than silent, because a contract
check that quietly runs nothing reads as coverage.

That install lives in one composite action, `.github/actions/install-harness`, which the release job uses
too. Two jobs need a Harness; they should not each have their own way of getting one — and the release
job in particular must not take the matrix's skip, so `npm test` there runs the schema contract for real.

Actions are pinned to commit SHAs rather than to `@v4` tags: a tag is mutable, a repointed one would run
inside this repository's token on the next push, and the release job holds `contents: write`.

`.github/workflows/release.yml` runs on a `v*` tag and publishes the GitHub release from the changelog
section, after re-running `npm test` on the tagged commit. See [Releases](#releases).

## Changing behaviour

Anything that can delete, overwrite or publish needs an answer to three questions in the pull
request:

1. **What is backed up before the destructive step, and where?**
2. **What happens if that step fails halfway?**
3. **How does a user recover?**

The current answers are in [the safety model](README.md#the-safety-model) — read it before changing
one of them, and update it if you do.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- Add user-visible changes under `## [Unreleased]`, in one of the `Added` / `Changed` / `Deprecated` /
  `Removed` / `Fixed` / `Security` sections. Create the section if it is not there.
- Write it for someone deciding whether to upgrade, not as a diff summary: what changed for them,
  not which function moved.
- On release, rename `[Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add link definitions for both the
  new version and the fresh `[Unreleased]`, and bump `package.json` in the same pull request.
- Internal changes with no user-visible effect do not need an entry.

The convention is enforced, not just documented:

```bash
npm run changelog:check    # also part of npm test
npm run docs:check         # also part of npm test
```

The first checks that `[Unreleased]` exists and comes first, that released headings are semver, strictly
descending, and dated, that `package.json`'s version has a heading, and that every heading has exactly
one link definition.

The second resolves every relative link in every Markdown file, refuses one that points outside the
repository, and requires the two READMEs to link to each other — the pairing rule above, which nothing
else notices when it breaks.

## Commit messages

Conventional-commit style prefixes, an imperative subject under about 72 characters, and a body that
explains **why** when it is not obvious:

```
fix: refuse to prune a tracked file that is only missing locally

Upload pruned remote files absent from disk rather than absent from the
tracked set, so losing a local file deleted the gist's only copy and the
profile then reported in-sync.
```

Prefixes in use: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`.

## Pull requests

Small, single-concern pull requests get reviewed properly; a PR that fixes a bug, reformats a file
and adds a feature will be asked to split.

Complete the checklist in the template. The parts that matter most:

- **A test that fails without the change.** Not "tests still pass" — name the case.
- **Both READMEs.** `README.md` and `README.zh-CN.md` must stay in sync; a behaviour or config change
  that updates only one of them will be sent back.
- **No secrets in the diff.** No tokens, no real gist URLs, no profile contents.
- **The changelog entry.**

## Releases

1. Move `[Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD` heading and add a fresh
   `[Unreleased]`.
2. Add the two link definitions at the bottom of the file.
3. Bump `package.json`.
4. `npm test`, which covers the changelog and documentation checks as well as the suites.
5. Tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` re-runs `npm test` on the tagged
   commit and publishes the GitHub release from that version's changelog section.

Preview the notes before you tag, and let the script catch the usual mistake — tagging before the
version bump merged:

```bash
npm run release:notes -- v0.2.0
```

It refuses a tag that does not match `package.json`, a version with no dated changelog section, and an
empty section, writing nothing to stdout when it refuses. That is what makes the release job's
`> notes.md` safe to pipe: a failure cannot publish a release with no notes.

Versioning follows the usual reading of Semantic Versioning for a tool like this: a change to what
gets uploaded or deleted, or to the state file's meaning, is breaking even when the API looks the same.

## Security

Do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/soimy/dsh-gist-settings/security/advisories/new)
instead, and include a reproduction.

Relevant in scope here: anything that escapes the profiles directory, publishes a gist that was
meant to be secret, exposes a credential to a model's context, or destroys configuration without a
recoverable copy.

---

## 中文说明

感谢你愿意花时间。这个工具保管的是别人的配置，所以标准不在于提交多少，而在于**不弄丢任何人的数据**。

下面这些材料的长文版本在 [`docs/`](docs/index.md)——架构、开发、测试、发版流程，以及文档约定本身。本文件保持为"约定"本身。

### 报告问题

请使用 [bug 报告表单](https://github.com/soimy/dsh-gist-settings/issues/new?template=bug_report.yml)。它会问真正决定答案的东西：`gist_status` 的输出、确切的工具调用、以及你的版本号。

**粘贴前务必打码。** secret gist 的 URL 是"持有即可读"的凭据——任何人拿到链接无需登录就能读取——而 `gist_status` 会打印这些 URL。你被追踪的配置里也可能内联着 API key。请只保留 URL 前几位（`…/0f8fb0…`），并把密钥值替换成 `<redacted>`。

如果你丢失了本地文件，先看 `<stateDir>/backups/<profile>/`：下载在覆盖之前会把原文件复制进去，无论是否使用了 `force`。

### 提交功能请求

请使用 [功能请求表单](https://github.com/soimy/dsh-gist-settings/issues/new?template=feature_request.yml)。描述**你遇到的处境**，而不是你设想的 API。

有两条性质是这个项目的承重墙，保留它们的提案会容易接受得多：

- **绝不猜测。** 两边都变了就停下发问；无法判断 gist 是"被删除"还是"暂时不可达"时，宁可拒绝也不新建一个替代品。
- **绝不删除最后一份。** 清理只删除**不再被追踪**的文件，绝不删除"只是本地暂时缺失"的被追踪文件。

要牺牲这两条中的任何一条，需要在 issue 里给出充分理由。

### 开发环境

```bash
git clone https://github.com/soimy/dsh-gist-settings.git
cd dsh-gist-settings
npm install --include=dev       # typescript 与 @types/node，两者都是精确锁定的 devDependencies
npm test                        # 先经由 `pretest` 构建，再跑各套件与各项检查
```

插件没有**运行时**依赖：它刻意不 import Harness 安装目录里的任何东西，除 `node:` 外不 import 任何东西，也不自带任何依赖，因此各套件本身只使用 Node 内置模块。那次安装装的是构建工具链——类型检查器与构建——形式是精确锁定的 devDependencies；而 `--include=dev` 正是让它真的发生：只要 `NODE_ENV=production`，npm 就会跳过 devDependencies，那次安装会以退出码 0 结束、什么都没装，于是要到后面才发现 `tsc` 不见了。

`index.ts` 与 `lib/core.ts` 是源码，而 Harness 加载 `dist/`。profile 是通过**它自己 `node_modules` 里的 junction** 抵达这个包的，而 Node 拒绝对任何解析到 `node_modules` 下的文件做类型擦除——它会抛 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`——所以这个包无法"直接跑 TypeScript"。`npm run build` 负责编译（`tsc -p tsconfig.json`），`npm run build:watch` 是同一件事的监听模式，`npm run typecheck` 则通过 `tsconfig.check.json` 对整个仓库——运行时、测试与脚本——做检查且不产出文件。`dist/` 是重新生成的产物：不手工编辑，也不提交。各套件与 `scripts/` 同样是 TypeScript，也没有任何东西编译它们：Node 在加载时擦除它们的类型，而这在 `node_modules` 之外是允许的——所以单套件仍然可以 `node test/sync.test.ts` 这样跑，不需要构建；只有 `test/entry.test.ts` 与 `test/guards.test.ts` 会读 `dist/`，而 `npm test` 会先构建。

要在真实 profile 上运行，把工作副本作为 bundle 安装即可。`install_bundle` 用的是符号链接，所以重载拿到的是 `dist/`：对 `index.ts` 或 `lib/core.ts` 的改动要等重新构建之后才会到达运行中的 Harness——这正是 `npm run build:watch` 的用途。

```
plugin_manager  action: install_bundle  target: <此仓库的绝对路径>
```

### 各测试套件证明了什么

知道哪套覆盖什么能省下大量猜测。`npm test` 会先编译——它的 `pretest` 步骤跑 `npm run build`——因此一次测试运行不可能对着陈旧的 `dist/` 跑。

| 套件 | 用例数 | 证明的内容 |
|---|---|---|
| `npm run test:entry` | 6 | profile 真正跨过的那道边界。其他套件 import 源码；这一套按 Cordis loader 的方式加载插件 —— 按包名、经 `exports` —— 并钉住：export 指向的是构建产物而非源码、产物与其声明文件存在、注册的上下文拿到四个工具且形状满足注册要求、产物注册的内容与源码完全一致。export 写错、`dist/` 缺失或陈旧、入口加载成功却不注册工具，都会让它失败。 |
| `npm run test:guards` | 7 | 仓库自身的不变量，行为套件一条也看不见。它遍历整棵树里的每个 `.ts` 文件（而不是写死一份清单），断言：每个文件仍能被 Node 自带的类型擦除器处理；每条相对 import —— 单行、折行、bare、动态 —— 都指向真实存在的文件（目录不算文件），且运行时仍写 `.ts`；没有任何编译出来的 JavaScript 落在源码旁边或 `dist/` 之外；`exports` 里任意层级、以及 `files` 里的每个路径都在构建后真实存在（`*` 通配也算，且必须能匹配到东西）；每个套件与脚本都**真正被**某条 package script 运行（并单独要求 live 套件不得进入 `npm test` 本身）；本仓库依赖的编译旗标在两个 tsconfig 里都仍在；声明的 Node 下限就是 CI 真正会跑的那条矩阵支线。每一条都通过手工破坏其不变量、且只让该条变红来验证。 |
| `npm run test:sync` | 19 | 引擎完整生命周期（内存版 gh）：创建、上传、分叉、下载、备份、清理、重建、幂等。 |
| `npm run test:tools` | 23 | 工具层：注册、参数校验、加载时的配置校验、profile 名解析、单个 profile 失败不会中断其他。 |
| `npm run test:schema` | 50 | 手写定义 vs Harness **自带**校验器：注册契约、受支持的 JSON Schema 子集、参数校验、返回值满足声明的输出 schema；外加加载器的兼容性闸门——直接拿本仓库的 `package.json` 去调用，因此一处当前运行时无法满足的 peer 声明会在这里失败，而不是在用户的 profile 里失败。 |
| `npm run test:regression` | 32 | 对抗性审核发现的具体缺陷。**每一条在修复被回退时都会失败。** |
| `npm run test:safety` | 38 | README 承诺的那些保证：profile 与每个受追踪文件的目录包容、全有或全无的下载、`force` 说到做到、目录被整个删掉后的恢复、远端删除后一次同步即收敛、跨进程状态锁，以及绝不覆盖「无法证明是自己写的那一版」的回滚。 |
| `npm run test:docs` | 13 | 文档链接检查器：Markdown 允许的各种目标写法（尖括号、配对括号、反斜杠转义），以及仓库包容规则 —— 指向仓库之外的链接，无论是直写还是经由仓库内部的链接抵达，都会被拒绝。这些每一项都曾是真实缺陷，所以这个检查器有自己的套件。 |
| `npm run test:release` | 6 | 发布说明脚本：成功路径，以及它**应当拒绝**的每一种 tag —— 版本与 `package.json` 不一致、没有带日期的小节、小节为空、tag 格式不合法。这是本仓库唯一一个通常要到打 tag 才第一次运行的脚本，所以"拒绝"与"成功"同样重要。 |
| `npm run test:live` | 12 | 真实 GitHub 往返，包含一个超过 API 截断阈值的文件。需显式开启，且会删除自己创建的每一个 gist。 |

`test/schema.test.ts` 找不到 DSH 安装时**会失败而不是跳过**——静默跳过会让 `npm test` 全绿但实际上一个校验都没跑。做无关改动时可设 `DSH_ALLOW_SCHEMA_SKIP=1`。

`test/safety.test.ts` 有 skip 机制，但会在汇总里明确报告 skip 数量，而不是把它算作通过——一条 quietly 什么都不做的安全用例比没有更糟，因为它读起来像是覆盖到了。这些用例刻意写成不需要 skip：在 Windows 不授予文件符号链接权限的地方，同一段"最后一段路径"的包容检查改用目录 junction 来验证。

回归套件与安全套件的存在，是因为变异审计发现：**43 个故意注入的 bug 里有 32 个能骗过原本的测试**，也因为随后两轮审核都发现防线只做到了它们声称的上一层。所以请把"测试通过"当成起点而非结论——最好能给出一个"改动前会失败"的用例。

### 持续集成

`.github/workflows/ci.yml` 跑的就是 `npm test`——与你在本地跑的同一条命令——覆盖 Linux、Windows、macOS 三个平台与 Node 22.x、24.x，另加一条直接在 **22.19.0**（`engines` 声明的下限）上跑的支线。这个下限来自 Harness 而非引擎本身：`@deepseek-harness-tui/dsh-tui` 声明 `engines: ^22.19 || >=24`，而一个根本加载不了的环境谈不上"支持"。平台矩阵不是凑数：目录包容在每个系统上走的是不同代码路径（Windows 上是 junction 与保留设备名，macOS 上是 Unicode 规范化，各处的 rename-over-file 语义也不同），所以 Linux 全绿并不能说明 Windows 用户拿到的路径是对的。

其中三点是刻意的：

- **会安装固定版本的构建工具链。** `npm test` 要构建 Harness 加载的那部分 JavaScript——`pretest` 会跑 `tsc`——所以每条支线都用 `npm install --include=dev` 装上它：`typescript` 与 `@types/node`，两者精确锁定，别无其他。这个参数是承重的而不是装饰：只要 `NODE_ENV=production`，npm 就会跳过 devDependencies，那次安装会以退出码 0 结束、什么都没装，于是故障要到后面才以"找不到 `tsc`"的形式浮现。这里仍然没有 `npm ci`——本包没有运行时依赖，也刻意不提交 lockfile，所以 `npm ci` 会直接拒绝运行。
- **关掉了 `fail-fast`。** 一个平台失败不会取消其他平台——「哪个平台不同意」通常就是全部诊断信息。
- **CI 里不含真实用例。** 它会写入真实 GitHub 账号，因此需要一个 `gist` 权限的 token，以及决定去花它的人。改动涉及 API 往返时请自己跑 `npm run test:live`；它会删除自己创建的每一个 gist。

`typecheck` 任务补上的是矩阵看不见的那个缺口。`npm test` 通过 `pretest` 构建运行时，但它从不编译各套件与脚本：Node 在加载时擦除它们的类型，而擦除不等于检查。因此一处写错的测试会在上面全部七条支线上通过，只在 `npm run typecheck` 上失败。这个任务把同一条命令跑一次，跑在下限版本上，在那里运行时、每一个套件与每一个脚本被一起检查。

`schema` 任务也是刻意独立的。`test/schema.test.ts` 拿手写的工具定义去撞 Harness **自带**的校验器，因此需要一份 Harness 安装——而运行器上没有。它为 `peerDependencies` 里声明的**每一个**版本各跑一条支线，并且是从声明本身读出这份清单，矩阵因此不会与它漂移；每个版本都会被真正安装——一个没人安装的"声明目标"只是声称，不是检查。与此同时，套件矩阵那边选择接受这套件的显式跳过（`DSH_ALLOW_SCHEMA_SKIP=1`，日志里会打印 `SKIP:` 行），从而让其余用例仍然在全部七条支线上跑。这个跳过是**日志里看得见的**，而不是静默的，因为一个 quietly 什么都不跑的契约检查读起来像是覆盖到了。

这份安装逻辑放在唯一的 composite action（`.github/actions/install-harness`）里，发布任务也复用它。有两个任务需要 Harness，它们就不该各自发明一套拿 Harness 的办法——尤其发布任务**不能**沿用矩阵的那个跳过，所以那边的 `npm test` 会真的执行 schema 契约。

所有 action 都按 commit SHA 固定，而不是 `@v4` 这类标签：标签是可变的，被改指的标签会在下一次推送时带着本仓库的 token 运行，而发布任务持有 `contents: write`。

`.github/workflows/release.yml` 在推送 `v*` 标签时运行：先在被打标签的提交上重跑 `npm test`，再用 changelog 对应小节发布 GitHub Release。见[发布](#发布)。

### 修改行为

任何可能删除、覆盖或对外发布内容的改动，都需要在 PR 里回答三个问题：

1. **破坏性步骤之前备份了什么，备份在哪里？**
2. **该步骤中途失败会怎样？**
3. **用户如何恢复？**

现有答案写在[安全模型](README.zh-CN.md#安全模型)里——改动其中任何一条之前请先读它，改了就要同步更新文档。

### CHANGELOG

[`CHANGELOG.md`](CHANGELOG.md) 遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

- 用户可见的改动写进 `## [Unreleased]`，归入 `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` 之一，没有该小节就新建。
- 写给"正在决定要不要升级的人"看，而不是写 diff 摘要：说清**对他而言什么变了**，而不是哪个函数挪了位置。
- 发版时把 `[Unreleased]` 改名为 `## [x.y.z] - YYYY-MM-DD`，补上新版本和新的 `[Unreleased]` 两条链接定义，并在同一个 PR 里升 `package.json`。
- 对用户没有可见影响的内部改动不必写。

这个约定是**被强制执行**的，不只是文档：

```bash
npm run changelog:check    # 也包含在 npm test 里
npm run docs:check         # 也包含在 npm test 里
```

前者检查：`[Unreleased]` 存在且位于最前；已发布版本的标题是语义化版本、严格降序、带日期；`package.json` 的版本有对应小节；每个标题恰好有一条链接定义。

后者解析每个 Markdown 文件里的全部相对链接，拒绝指向仓库之外的链接，并要求两个 README 互相链接——也就是上面那条配对规则，它一旦断了没有别的东西会发现。

### 提交信息

采用约定式前缀，祈使句主题、约 72 字符以内；原因不显然时在正文里说明**为什么**：

```
fix: refuse to prune a tracked file that is only missing locally

Upload pruned remote files absent from disk rather than absent from the
tracked set, so losing a local file deleted the gist's only copy and the
profile then reported in-sync.
```

在用前缀：`feat`、`fix`、`docs`、`test`、`chore`、`refactor`。

### Pull Request

小而聚焦的 PR 才会被认真审阅；一个同时修 bug、重排格式、外加新功能的 PR 会被要求拆分。

请填完模板里的清单，其中最重要的是：

- **一个"没有这个改动就会失败"的测试**——不是"测试仍然通过"，而是指出具体是哪一条。
- **两份 README 都要改。** `README.md` 和 `README.zh-CN.md` 必须保持同步；只改其中一份的行为/配置变更会被退回。
- **diff 里不能有密钥。** 不要出现 token、真实 gist URL、真实 profile 内容。
- **CHANGELOG 条目。**

### 发版

1. 把 `[Unreleased]` 的内容移到新的 `## [x.y.z] - YYYY-MM-DD` 标题下，并新建空的 `[Unreleased]`。
2. 在文件底部补上两条链接定义。
3. 升 `package.json` 版本号。
4. 跑 `npm test`，它已经把 changelog 与文档链接检查连同各套件一起覆盖了。
5. 打 `vX.Y.Z` 标签并推送。`.github/workflows/release.yml` 会在被打标签的提交上重跑 `npm test`，并用该版本的 changelog 小节发布 GitHub Release。

打标签之前可以先预览发布说明，也让脚本替你抓那个最常见的错误——版本号还没合并就先打了标签：

```bash
npm run release:notes -- v0.2.0
```

标签与 `package.json` 不一致、版本没有带日期的 changelog 小节、小节内容为空，这三种情况它都会拒绝，且在拒绝时**不向 stdout 写任何东西**。正因如此，发布任务里的 `> notes.md` 才可以安全地接管道：失败不可能发布出一个没有说明的 Release。

版本号遵循语义化版本的通常理解，但对这类工具而言："上传或删除的内容"或"状态文件的含义"发生变化，即使 API 看起来没变，也算破坏性变更。

### 安全

发现漏洞请**不要**开公开 issue，改用 GitHub 的[私密漏洞报告](https://github.com/soimy/dsh-gist-settings/security/advisories/new)，并附上复现步骤。

本项目关心的范围包括：任何逃出 profiles 目录的行为、把本应保密的 gist 公开、把凭据暴露进模型的上下文、以及在没有可恢复副本的情况下破坏配置。