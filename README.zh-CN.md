# dsh-gist-settings

[![CI](https://github.com/soimy/dsh-gist-settings/actions/workflows/ci.yml/badge.svg)](https://github.com/soimy/dsh-gist-settings/actions/workflows/ci.yml)

[English](README.md) · **中文**

一款 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Cordis 插件：借助你**已经装好并登录**的 `gh` 命令，把 Harness 的 **profile 配置**备份到 **GitHub Gist**，也能从 Gist 恢复。

每个 profile 一个 secret gist，存放该 profile 被追踪的配置文件。上传、下载，以及带保护的
双向同步都以 agent 工具的形式暴露，因此你可以在对话里直接驱动它们。

## 状态

| 部分 | 状态 |
|---|---|
| 同步引擎（`lib/core.js`） | 已完成 |
| Host 插件 + 4 个 agent 工具 | **已安装并生效**，可在会话中调用 |
| 真实 GitHub 往返 | **已在真实账号上验证** |
| 测试 | **六套共 165 项离线用例，另有 12 项真实用例**，全部通过 |
| CI | 在 Linux、Windows、macOS 上跑离线用例与仓库检查，覆盖 Node 20.3、20.x、22.x、24.x |
| Client 设置页 | 尚未开始 —— 见[设置页](#设置页) |
| 许可证 | MIT |

这份代码经过了两轮对抗性审核（先是独立的安全性、正确性、集成、变异测试与文档审计，随后是针对
修复结果的复审）。审核中被证实的缺陷都已修复，并由回归测试锁定；下面的[安全模型](#安全模型)
描述的是**修复之后的实际行为**，而不是最初的设计意图。

## 环境要求

- **Node.js 20.3+** —— 引擎使用 `node:` 前缀的内置模块、用于识别嵌套加锁的 `AsyncLocalStorage`，以及
  `AbortSignal.any`：读取被截断的 gist 内容时，它给全局 `fetch` 加上统一时限。下限是 20.3 而不是
  20.0 正因如此：在 20.0–20.2 上插件能加载，但第一次需要读取超过 API 截断阈值的文件时就会失败。
  `.github/workflows/ci.yml` 直接在 20.3.0 上跑测试，所以这个下限是被验证的，而不是被声称的。
- **`gh` 命令，已安装并已登录。**

  ```bash
  gh auth login
  ```

  Gist 的读写全部通过 `gh api` 完成，因此除默认权限外无需额外 OAuth scope。插件自身从不保存、
  读取或索要 token —— 凭据完全由 `gh` 保管。

  如果运行 Harness 的进程在 `PATH` 里找不到 `gh`（Windows 上刚装完很常见，`PATH` 往往还没刷新），
  插件会依次探测常见的安装位置；你也可以用 `ghPath` 直接指定二进制路径。

## 安装

安装需要**完全访问权限**的会话或一次审批；否则 `plugin_manager` 会拒绝。安装过程还可能请求
批准包的构建脚本，而本 bundle 并没有构建脚本。

```
plugin_manager  action: install_bundle  target: <此目录的绝对路径>
```

该操作会把此目录链接进 profile、把 bundle 加入 `dsh.profile.bundles`，并应用 `cordis.patch.yml`
中的补丁。之后需要重启，才能加载新的模块代际。

**不要**手工往 profile 里添加 bundle 行或依赖 —— 那是 `install_bundle` 的职责。但该行的
`config:` 配置块是留给你编辑的（见[配置](#配置)）。

### 卸载

```
plugin_manager  action: remove_bundle  target: @local/dsh-gist-settings
```

插件创建的 gist **不会**被删除。若要一并清理，先在 GitHub 上删除它们（URL 在 `state.json` 里），
再删除状态目录：

```
<stateDir>            # 默认：<dshHome>/gist-settings
```

该目录包含 `state.json`（profile → gist 的映射）、`state.json.bak`、插件做过的所有备份，以及在被
写入期间存在的 `state.lock`。删除它会丢失映射关系与本地备份，但不会影响 gist 本身。

下载还会在它正在写入的那个 profile 目录里，短期创建一个
`.dsh-gist-settings-staging-<pid>-<时间>` 目录，用于把新内容先暂存在同一卷上，再动任何受追踪的
文件。被杀掉的进程可能留下一个；它是惰性的 —— 不被追踪、不会被上传、列 profile 时会被跳过，而
正常路径下都会由下载自己的 `finally` 清理掉。

## 工具

| 工具 | 方向 | 作用 |
|---|---|---|
| `gist_status` | — | 报告 `gh` 是否已安装并登录，然后列出每个 profile 及其 gist URL 与同步状态。不会改动 profile 文件或 gist；但可能会修复自身状态文件里陈旧的同步基线。 |
| `gist_upload` | 本地 → gist | 首次上传时创建 secret gist，之后更新同一个 gist。**会删除 gist 上不再被追踪的文件** —— 见下方警告。绝不修改本地文件。目录已消失的受追踪 profile 会在结果里被点名，而不是被静默跳过。 |
| `gist_download` | gist → 本地 | 从 gist 恢复本地文件。覆盖前会先备份现有本地文件，且写入是"全有或全无"。 |
| `gist_sync` | 双向 | 哪边变了就快进哪边；本地被误删的受追踪文件会被恢复；两边一致时什么都不做。真正的分叉会拒绝猜测，且绝不传播删除操作。 |

四个工具都接受可选的 `profile` 参数；省略即对所有 profile 生效。**某个 profile 失败不会中断
其他 profile。** 所有参数都会被类型校验 —— 类型错误或未知键名会直接报错，绝不静默转换，
因此 `force: "false"` 不可能变成强制执行覆盖。

"对所有 profile 生效"的唯一例外是 `gist_upload`：不带 `profile` 时，它只覆盖**本机仍然存在目录**的
那些 profile，因为被删掉的目录里没有任何东西可上传。这样的 profile 会在结果里被点名并指向
`gist_download`，而不是被从报告里去掉 —— 那里的沉默会被读成"备份齐全"，而事实并非如此。

**profile 名按原样精确匹配。** 当目录名是 `alpha` 时传入 `ALPHA` 会被拒绝 —— 因为在 Windows 和
macOS 上它们是同一个目录，两者都接受就会把同一个 profile 备份成两个 gist，然后再悄无声息地
互相分叉。报错信息会指出真实的名字。传入不存在的名字时，会连同现有 profile 列表一起拒绝，
而不是等到后面抛出一句令人费解的"没有任何被追踪的文件"。

### 状态词表

`gist_status` 只会输出以下这些：

| 输出 | 含义 |
|---|---|
| `not tracked` | 该 profile 还没有 gist。 |
| `in sync` | 本地与 gist 一致。 |
| `local changes to upload` | 自上次同步以来只有本地变了。 |
| `gist changes to download` | 自上次同步以来只有 gist 变了。 |
| `DIVERGED - needs a decision` | 两边都变了。不做任何猜测，由你决定方向。 |
| `tracked files missing locally - run gist_download to restore` | 某个受追踪文件在本地不见了，但 gist 上还在。 |
| `gist deleted - the next upload recreates it` | GitHub 对该 gist 返回了真正的 404。 |
| `gist UNREACHABLE (not deleted) - retry when connected` | 因其他原因读取失败 —— 离线、401、5xx、限流。 |
| `unknown - gh is unavailable, remote state not checked` | `gh` 缺失或未登录，因此只知道本地记录。 |

> **`gist_upload` 会删除 gist 上"不再被追踪"的文件，且不为其保留备份。** 这里的"不再被追踪"
> 指的是**不在配置的 `profileFiles` 里**，而**不是**"本地磁盘上暂时不存在"。手工加到 gist 上的
> 文件（比如通过 GitHub 网页界面）**会**在下一次上传时被删除。
>
> 而"受追踪文件只是本地缺失"是另一回事：上传会**直接失败**并提示你去下载，因为 gist 上那份
> 可能已是仅存的副本。`force: true` 会覆盖这一保护，把它也从 gist 上删掉 —— 结果里会列出被删掉
> 的文件名，因此这两种情况永远不会混淆。

## 配置

可调项写在 profile 的补丁层里，因此能跨插件升级保留。编辑你的 profile `cordis.patch.yml` 中
`dsh-gist-settings` 那一行的 `config:` 块（本仓库 `cordis.patch.yml` 里注释掉的那段就是模板）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `ghPath` | 先探测 `PATH`，再探测常见安装目录 | `gh` 二进制路径。也可写成 `[命令, ...前置参数]` 数组，以便通过包装器调用 gh，例如 `['wsl', 'gh']`。 |
| `profileFiles` | `['cordis.patch.yml', 'package.json']` | 每个 profile 目录里要追踪哪些文件。 |
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | Harness 主目录。开头的 `~` 会被展开，相对路径会基于进程工作目录解析。 |
| `profilesDir` | `<dshHome>/profiles` | profile 所在目录。 |
| `stateDir` | `<dshHome>/gist-settings` | gist 索引与备份的写入位置。 |

`profileFiles` 的每个条目同时是 gist 里的文件名和备份目录里的路径，因此它必须是一个纯粹的**单段**
名字：不能含分隔符、不能含 `..`、不能是绝对路径或盘符相对路径、不能含冒号，也不能出现两个在本
平台上折叠为同一文件的名字。拒绝分隔符是因为 gist 是扁平的文件集合而不是目录树 —— GitHub 对含斜杠
的文件名会返回 `HTTP 422 Validation Failed`，而那个文件名正是必须发出去的东西。任何根本无法处理的
名字都会在**插件加载时**被拒绝，而不是拖到第一次工具调用。

插件没有声明 `Config` schema，而是在加载时自行校验：未知键名会被拒绝并列出全部合法键名，
类型错误会被拒绝而不是静默回退到默认值。因此一个笔误会**明确报错**，而不是悄悄改变被备份的文件。

## 安全模型

**Gist 布局。** 每个 profile 一个 secret gist，描述为 `DeepSeek Harness profile config: <名称>`，
其中以原文件名存放该 profile 被追踪的文件。profile 与 gist 的映射保存在
`<stateDir>/state.json`。

**瞬时故障绝不当作"被删除"。** `gh` 报告"gist 已被删除"和"token 已失效"的方式是一样的 ——
退出码 1 加一行 stderr。只有真正的 `HTTP 404` 才会被解读为"gist 没了"；401、5xx、限流或 DNS
失败一律归类为 `unreachable`，上传与同步都会拒绝执行，而不会新建一个替代 gist 把原来那个抛下。

**分叉绝不猜测。** 状态文件记录上次达成一致时的内容哈希作为基线。用当前本地哈希和 gist 哈希
与之比较，可以区分"只有本地变了"（可安全上传）、"只有 gist 变了"（可安全下载）和"两边都变了"
（`diverged`，插件停下）。比较只针对 **gist 上被追踪的那部分文件**，因此 gist 里多一个文件不会
让 profile 永远显得不同步。

**本地缺失的受追踪文件是"恢复"而不是"删除"。** 它有自己的状态；同步会把它下载回来，上传则
在没有 `force` 时拒绝执行。这是工具绝不自行替用户决定的一处不对称，因为 gist 上那份可能是仅存的副本。

**破坏性写入前先备份，且写入是"全有或全无"。** `gist_download` 在覆盖任何东西之前，会把该
profile 被追踪的文件复制到 `<stateDir>/backups/<profile>/<时间戳>/`，即使使用了 `force` 也一样。
新内容随后会先写进 profile 目录下的暂存区并逐个核对字节数，全部落盘后才逐个 rename 就位 ——
每个文件一次原子 rename，落地的要么是旧内容、要么是新内容，绝不会是截断的混合体。若某个 rename
仍然失败，已经替换掉的文件会用与备份相同的内容还原回去，报错也会说明这一点并给出备份目录。
因此失败的下载会让 profile 保持原样，而不是停在一个哪边都不存在的版本上 —— 但有一个刻意的例外：
回滚只撤销**本次事务真正写入过**的东西。若某个文件此后已被改动，或者回滚**读不回它的当前内容**
因而无法比对，它会被原样留下并在报错里点名：下载之后才产生的编辑不在任何备份里，靠猜去覆盖它是
唯一可能毁掉无法恢复的数据的做法。另外两处诚实的限定：回滚是尽力而为的，若某个文件无法还原，报错
会点名是哪一个，并以备份目录作为恢复途径；而如果文件全部就位之后**写 state 失败**，报错会如实说明
这一点，而不是谎称下载失败 —— 下一次 `gist_status` 会修复陈旧的基线。

**目录包容 —— 先管 profile，再管它里面的每一个受追踪文件。** profile 名称按框架自身的规则校验，
解析出的目录还会与 `realpath(profilesDir)` 再核对一次，因此放在 `profiles/<名称>` 处的 junction 会被
**拒绝**而不是跟随。每个受追踪文件随后被约束在 **profile 自己的边界**内：`profileFiles` 条目必须是
纯相对路径（无 `..`、无盘符、无保留字符），且解析出的路径**每一段**都会重新核对。一个本身指向树外
的受追踪文件、位于被链接出去的子目录下的文件，或**伸手到兄弟 profile** 的文件（那会让一个 profile
的 gist 发布并覆盖另一个 profile 的配置）的文件，都会被拒绝。路径检查在**每次写入之前**重做，而不是
每次操作只做一次，这把"下载途中把 profile 目录换成链接"的窗口压缩到 rename 调用本身；要彻底关掉它，
需要 Node 的 `fs` 并不提供的句柄相对操作。这里要说清楚它覆盖到什么程度：检查时**仍然存在**的链接会
被拦住，而**悬空**的链接根本无法被写入穿过，但这个检查本身仍是"先检查再使用"——窗口被收窄了，
并没有被关死。

**删除操作绝不传播，两个方向都是。** 手工从 gist 上删掉一个受追踪文件，不会把它从本地删掉：下载会
保留它，而且 `gist_sync` 会在**同一次调用**里把它放回 gist，因此一次同步就能到达稳定状态，而不会在
一次"声称已完成"的同步之后仍显示 `local changes to upload`。反过来，在本地删掉它也不会从 gist 上
删掉：上传会拒绝执行。**没有任何开关能把远端的删除应用到本地** —— 想这么做就自己删掉本地那份，然后
同步。唯一有意保留的覆盖方式是 `gist_upload` 的 `force: true`，它会把本地缺失的文件从 gist 上删掉。

**同一时刻只有一个写入者，且跨进程生效。** 对 `state.json` 的"读取-修改-写回"由进程内的队列
**和**一个锁文件（`<stateDir>/state.lock`，其中记录持有者的 pid）共同串行化。因此共享同一状态
目录的两个 Harness 宿主会排队而不是互相覆盖 —— 没有这层保护时的故障形态是丢失某条 profile 记录
（等于取消追踪并把它对应的 gist 变成孤儿），或者为同一个 profile 建出两个 gist。持有者进程已经
退出的锁会被立刻回收；另一台机器写入的锁无法用本机的 pid 规则判断，于是改用时间老化，并在持有期间
由心跳保持新鲜。释放锁时，只有它仍然是本进程持有的那一把才会被删除。嵌套加锁会得到明确报错，
而不是死锁。

**绝不启动交互式编辑器。** gist 的读写全走 `gh api`。显而易见的替代方案 `gh gist edit` 会拉起
`$EDITOR`，在无人值守的插件宿主里会直接挂住。

**大文件会完整取回。** 超过 1 MB 的 gist 文件，其 `content` 在 API 响应里会被截断，剩余部分由
`raw_url` 指路。该 URL 会先校验为 https 的 GitHub raw 主机，重定向之后再校验一次，然后用 `fetch`
**直接**取回（不走 `gh api` —— 后者按文档只接受 API endpoint，并且会把调用方的 token 带到一个它从未
被配置过的主机），并受 60 秒超时与 64 MiB 体积上限约束。这次请求不携带任何凭据，这正是它能成功的
原因：secret gist 是"不公开列出"，而不是"访问受控"。Node 的 `fetch` 不像 `gh` 那样遵循
`HTTP(S)_PROXY` 与系统证书库，因此**传输层**失败会回退到 `gh` 本会发出的那个请求；HTTP 错误状态
不会回退，因为 404 必须仍然是 404。截断只为**本 profile 追踪的文件**解析，所以别人通过网页界面加
进去的大附件既不会让每次 status 都多一次请求，也不会把 status 弄挂。`test/regression.test.mjs`
钉住这条路径的离线部分，`test/live.test.mjs` 用 1.5 MB 的文件对真实 GitHub 做往返来证明其余部分。

**不 import Harness 安装目录里的任何东西。** 工具定义是按 `defineTool` 的产物形状手写的普通
对象。这让 bundle 不受模块解析方式变化的影响；`test/schema.test.mjs` 会重放 Harness **自带**的
校验器，确保定义不会悄悄偏离契约。代价是 Harness 的版本闸门也看不到这个插件，因此
`peerDependencies` 固定了它所针对的 DSH 版本。

**secret gist 的 URL 是"持有即可读"的凭据。** 任何人拿到链接无需登录即可读取，而工具会把该
URL 输出到结果里，进而进入对话记录。请据此对待这些链接。

## 仓库结构

```
index.js               Host 插件：注册四个 agent 工具
lib/core.js            同步引擎 —— 不依赖 Cordis，可独立测试
cordis.patch.yml       bundle 补丁（插入插件行；并记录配置说明）
client.js              Client 设置页（尚未编写）
locale/{en,zh}.json    Plugin Manager 卡片用的展示元数据
icon.svg               bundle 图标
test/                  六套共 165 项离线用例，另有 12 项真实用例
scripts/               check-changelog.mjs —— 校验 CHANGELOG.md
.github/               Issue 表单与 PR 模板
```

## 文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 本文件的英文版。两份保持同步；只改其中一份的行为变更不算完成。 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 报告问题、开发环境、每套测试证明什么，以及 changelog、提交与发布约定。 |
| [CHANGELOG.md](CHANGELOG.md) | 所有值得记录的变更，最新在前，遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。 |
| [LICENSE](LICENSE) | MIT。 |

## 开发

```bash
npm test                # 六套离线用例（165 项），外加 CHANGELOG 与文档链接检查
npm run test:sync       # 用假 gh 跑引擎完整生命周期
npm run test:tools      # 工具层、参数校验、故障隔离
npm run test:schema     # 定义 vs. Harness 自带校验器
npm run test:regression # 对抗性审核发现的具体缺陷
npm run test:safety     # 目录包容、原子写入、强制删除、灾难恢复、跨进程锁
npm run changelog:check # 校验 CHANGELOG.md 结构与版本一致性
npm run test:live       # 需显式开启：真实 GitHub
```

`test/fake-gh.mjs` 是 `gh` 的内存替身，实现了 `--version`、`auth status` 和 `/gists` 接口，并可选
注入"截断文件""不可信的 `raw_url` 主机""HTTP 500""未登录的 CLI"。`sync`、`tools`、`regression`、
`safety` 四套把 `ghPath` 指向它，因此整个生命周期 —— 创建、上传、下载、分叉、备份、清理、gist
重建、幂等、恢复 —— 都能在无网络、无 GitHub 账号的情况下跑完。

`test/schema.test.mjs` 会从 `process.execPath` 定位已安装的 `@deepseek-ai/dsh-tools`
（设置了 `DSH_TOOLS_DIR` 时会优先搜索它），并重放运行时的检查：注册契约、受支持的 JSON Schema 子集、
参数校验，以及每个工具的返回值是否满足它声明的输出 schema。**找不到安装时它会失败而不是跳过** ——
静默跳过会让 `npm test` 全绿但一个校验都没跑；想刻意接受跳过可设 `DSH_ALLOW_SCHEMA_SKIP=1`。

`test/live.test.mjs` 需要**显式开启**，因为它会创建真实的 secret gist。它在系统临时目录下使用
一次性的 `DSH_HOME`，因此不会读写你的真实 profile；即使断言失败，它也会删除自己创建的**每一个**
gist。除 `gh api` 往返之外，它还覆盖了假替身无法作证的那条路径：被真实 GitHub 在 JSON 响应里
截断的 1.5 MB 文件，能否从 API 给出的 `raw_url` 完整取回。

```powershell
$env:DSH_GIST_LIVE_TEST='1'; npm run test:live     # PowerShell
```

```bash
DSH_GIST_LIVE_TEST=1 npm run test:live             # bash
```

由于 `install_bundle` 会把此目录链接进 profile，**工作副本就是线上插件**：改 `index.js` 和 `lib/`
重载后即生效。

## 设置页

Client 设置页已规划但尚未编写。有两项发现决定了它的形态：

1. **当前 profile 没有 Web 界面。** `dsh-tui` 组合的是终端界面；提供浏览器界面与 settings 插槽的
   `dsh-web-app` bundle 在它是禁用的。因此除非把插件同时装进 `web` profile，或为 `dsh-tui` 启用
   该 bundle，否则设置页没有渲染面。

2. **Client→Host 调用需要一条受支持的通道。** 官方提供且带类型的路径是 settings 域
   （`ctx.remote.settings.*`，或 `ctx.configForms` 包装），但它要求 Host 侧声明 settings 命名空间 ——
   这意味着要从工作区安装的 bundle 里 import Harness 的 `schemastery`，而这对非官方 bundle
   是否可行尚未验证。另一条路是原生的 `ctx.connection.rpc` 通道，类型完备，但在官方代码里除
   API gateway 外没有使用先例。这是动手写 `client.js` 之前需要先解决的问题。

设置页计划注册到 `settings.section` 插槽（Settings 对话框中的一个导航项），展示与 `gist_status`
相同的表格，并把四个操作接上按钮。

## 许可证

[MIT](LICENSE) © 2026 Shen Yiming。

`package.json` 中的 `"private": true` 是刻意的：它表示这个包**不会**发布到 npm，而只作为本地
bundle 安装。这与 MIT 许可证并不冲突。

## 审核历史

对本仓库的对抗性审核曾发现：一次 `gh` 失败可能**杀死整个 Harness 进程**；所有 gist 读取错误都被
当成"已被删除"，从而静默分叉备份；以及一次上传会删掉"仅本地缺失"文件在 gist 上的唯一副本。
这些都已修复，并由 `test/regression.test.mjs` 覆盖 —— 该文件里每一条用例在修复被回退时都会失败。

审核同时确认了几件事本来就是正确的：注册契约、effect 与销毁生命周期、manifest，以及两侧哈希
同一文件集时的分叉分类器。

第二轮审核（[issue #1](https://github.com/soimy/dsh-gist-settings/issues/1)）复查了上述修复，
发现那些防线都**早停了一层**：profile 目录做了包容，但目录里的受追踪文件没有；下载仍可能半途
生效；`force: true` 被接受却被忽略；目录被整个删掉的 profile 对任何批量操作都不可见；远端删除
后一次同步无法收敛；状态锁只在本进程内有效；截断内容仍通过 `gh api` 在未证实的假设上取回。
这七项已全部修复。

针对**上一轮修复本身**的审核又发现了更多问题，其中一条正是那轮修复引入的：当受追踪路径的父目录
缺失时，路径解析返回的是被截短的路径，于是把 `config/app.yml` 下载进一个没有 `config/` 的 profile
时，内容会写进一个名叫 `config` 的**文件**，而且报告成功。同一轮修复的还有：包容边界停在 profiles
目录而不是 profile 本身，导致指向**兄弟 profile** 的链接会让一个 profile 的 gist 发布并覆盖另一个
profile 的配置；路径每次操作只解析一次，因此下载途中把某个目录换成链接就能把写入重定向到树外；当
profiles 目录本身是链接时，被删掉的 profile 会被误判为逃逸，从而让灾难恢复失效；两个折叠到同一
文件的名字会被接受，随后让所有下载永久失败；state 写入失败会报成"下载失败"并残留临时文件；用于
截断内容的 `fetch` 没有超时、没有体积上限、不校验重定向、也没有代理回退；一个未被追踪的大文件
能让整个 profile 变成不可达；以及文档声称可以用 `gist_download` 的 `force` 应用远端删除，而实际
没有任何代码路径做这件事。`test/safety.test.mjs`、`test/regression.test.mjs` 与
`test/live.test.mjs` 为每一条都钉了用例。