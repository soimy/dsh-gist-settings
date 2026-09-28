# Contributing

Thanks for taking the time. This is a small tool that holds other people's configuration, so the
bar is less about volume and more about not losing anyone's data.

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
npm test
```

There are no dependencies to install — the plugin deliberately imports nothing from the Harness
installation, and the tests use only Node built-ins.

To run it against a real profile, install the working copy as a bundle. `install_bundle` links the
directory, so edits to `index.js` and `lib/` take effect on reload:

```
plugin_manager  action: install_bundle  target: <absolute path to this checkout>
```

## What the test suites prove

Knowing which suite covers what saves a lot of guessing.

| Suite | Cases | Proves |
|---|---|---|
| `npm run test:sync` | 19 | The engine's whole lifecycle against an in-memory `gh`: create, upload, divergence, download, backup, pruning, recreation, idempotency. |
| `npm run test:tools` | 23 | The tool layer: registration, argument validation, config validation at load, profile-name resolution, and that one failing profile never aborts the others. |
| `npm run test:schema` | 49 | The hand-written definitions against the Harness's *own* validators — the registration contract, the supported JSON Schema subset, argument validation, and that each returned value satisfies its declared output schema. |
| `npm run test:regression` | 30 | The specific defects an adversarial review found. Every case here fails if its fix is reverted. |
| `npm run test:safety` | 36 | The guarantees the README makes: containment for the profile and every tracked file, an all-or-nothing download, `force` doing what it says, recovery of a profile whose directory is gone, one-sync convergence after a remote deletion, and cross-process state locking. |
| `npm run test:live` | 12 | The real GitHub round trip, including a file above the API's truncation threshold. Opt-in, and it deletes every gist it creates. |

`test/schema.test.mjs` **fails** rather than skipping when it cannot find a DSH installation, because
a silent skip would leave `npm test` green with none of those checks having run. Set
`DSH_ALLOW_SCHEMA_SKIP=1` when you are working on something unrelated.

`test/safety.test.mjs` has a skip mechanism, and it reports skips in the summary rather than counting
them as passes — a security case that quietly does nothing is worse than no case, because it reads as
coverage. The cases are written to avoid needing it: where Windows withholds the privilege for a file
symlink, the same last-segment containment check is exercised with a directory junction.

The regression and safety suites exist because a mutation audit found that 32 of 43 deliberately
injected bugs survived the original suite, and because two later reviews found guards that stopped one
level short of what they claimed. Treat "the tests pass" as a starting point, not a conclusion: prefer
a case that fails before your change.

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
```

It checks that `[Unreleased]` exists and comes first, that released headings are semver, strictly
descending, and dated, that `package.json`'s version has a heading, and that every heading has
exactly one link definition.

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
4. `npm test` and `npm run changelog:check`.
5. Tag `vX.Y.Z` and push the tag; the GitHub release is generated from the changelog section.

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
npm test
```

**无需安装任何依赖**——插件刻意不 import Harness 安装目录里的任何东西，测试也只使用 Node 内置模块。

要在真实 profile 上运行，把工作副本作为 bundle 安装即可。`install_bundle` 用的是符号链接，所以改 `index.js` 和 `lib/` 重载后即生效：

```
plugin_manager  action: install_bundle  target: <此仓库的绝对路径>
```

### 各测试套件证明了什么

| 套件 | 用例数 | 证明的内容 |
|---|---|---|
| `npm run test:sync` | 19 | 引擎完整生命周期（内存版 gh）：创建、上传、分叉、下载、备份、清理、重建、幂等。 |
| `npm run test:tools` | 23 | 工具层：注册、参数校验、加载时的配置校验、profile 名解析、单个 profile 失败不会中断其他。 |
| `npm run test:schema` | 49 | 手写定义 vs Harness **自带**校验器：注册契约、受支持的 JSON Schema 子集、参数校验、返回值满足声明的输出 schema。 |
| `npm run test:regression` | 30 | 对抗性审核发现的具体缺陷。**每一条在修复被回退时都会失败。** |
| `npm run test:safety` | 36 | README 承诺的那些保证：profile 与每个受追踪文件的目录包容、全有或全无的下载、`force` 说到做到、目录被整个删掉后的恢复、远端删除后一次同步即收敛、以及跨进程状态锁。 |
| `npm run test:live` | 12 | 真实 GitHub 往返，包含一个超过 API 截断阈值的文件。需显式开启，且会删除自己创建的每一个 gist。 |

`test/schema.test.mjs` 找不到 DSH 安装时**会失败而不是跳过**——静默跳过会让 `npm test` 全绿但实际上一个校验都没跑。做无关改动时可设 `DSH_ALLOW_SCHEMA_SKIP=1`。

`test/safety.test.mjs` 有 skip 机制，但会在汇总里明确报告 skip 数量，而不是把它算作通过——一条 quietly 什么都不做的安全用例比没有更糟，因为它读起来像是覆盖到了。这些用例刻意写成不需要 skip：在 Windows 不授予文件符号链接权限的地方，同一段"最后一段路径"的包容检查改用目录 junction 来验证。

回归套件与安全套件的存在，是因为变异审计发现：**43 个故意注入的 bug 里有 32 个能骗过原本的测试**，也因为随后两轮审核都发现防线只做到了它们声称的上一层。所以请把"测试通过"当成起点而非结论——最好能给出一个"改动前会失败"的用例。

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
```

它会检查：`[Unreleased]` 存在且位于最前；已发布版本的标题是语义化版本、严格降序、带日期；`package.json` 的版本有对应小节；每个标题恰好有一条链接定义。

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
4. 跑 `npm test` 和 `npm run changelog:check`。
5. 打 `vX.Y.Z` 标签并推送；GitHub Release 由 changelog 对应小节生成。

版本号遵循语义化版本的通常理解，但对这类工具而言："上传或删除的内容"或"状态文件的含义"发生变化，即使 API 看起来没变，也算破坏性变更。

### 安全

发现漏洞请**不要**开公开 issue，改用 GitHub 的[私密漏洞报告](https://github.com/soimy/dsh-gist-settings/security/advisories/new)，并附上复现步骤。

本项目关心的范围包括：任何逃出 profiles 目录的行为、把本应保密的 gist 公开、把凭据暴露进模型的上下文、以及在没有可恢复副本的情况下破坏配置。