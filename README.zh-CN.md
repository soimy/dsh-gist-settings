# dsh-gist-settings

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
| 测试 | **111 项离线用例 + 10 项真实用例**，全部通过 |
| Client 设置页 | 尚未开始 —— 见[设置页](#设置页) |
| 许可证 | MIT |

这份代码经过了一轮对抗性审核（独立的安全性、正确性、集成、变异测试与文档审计）。审核中
被证实的缺陷都已修复，并由回归测试锁定；下面的[安全模型](#安全模型)描述的是**修复之后的实际
行为**，而不是最初的设计意图。

## 环境要求

- **Node.js 20+**（测试中使用了 `import.meta` 与 `node:` 前缀的内置模块）。
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

该目录包含 `state.json`（profile → gist 的映射）、`state.json.bak`，以及插件做过的所有备份。
删除它会丢失映射关系与本地备份，但不会影响 gist 本身。

## 工具

| 工具 | 方向 | 作用 |
|---|---|---|
| `gist_status` | — | 报告 `gh` 是否已安装并登录，然后列出每个 profile 及其 gist URL 与同步状态。不会改动 profile 文件或 gist；但可能会修复自身状态文件里陈旧的同步基线。 |
| `gist_upload` | 本地 → gist | 首次上传时创建 secret gist，之后更新同一个 gist。**会删除 gist 上不再被追踪的文件** —— 见下方警告。绝不修改本地文件。 |
| `gist_download` | gist → 本地 | 从 gist 恢复本地文件。覆盖前会先备份现有本地文件。 |
| `gist_sync` | 双向 | 哪边变了就快进哪边；本地被误删的受追踪文件会被恢复；两边一致时什么都不做。真正的分叉会拒绝猜测。 |

四个工具都接受可选的 `profile` 参数；省略即对所有 profile 生效。**某个 profile 失败不会中断
其他 profile。** 所有参数都会被类型校验 —— 类型错误或未知键名会直接报错，绝不静默转换，
因此 `force: "false"` 不可能变成强制执行覆盖。

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
> 可能已是仅存的副本。`force: true` 会覆盖这一保护，把它也从 gist 上删掉。

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

**破坏性写入前先备份。** `gist_download` 在覆盖任何东西之前，会把该 profile 被追踪的文件复制到
`<stateDir>/backups/<profile>/<时间戳>/`，即使使用了 `force` 也一样。备份发生在第一次写入之前，
因此被取消或失败的下载不会让 profile 处于半改状态。

**目录包容。** profile 名称按框架自身的规则校验，解析出的目录还会与 `realpath(profilesDir)`
再核对一次。放在 `profiles/<名称>` 处的 junction 或符号链接会被**拒绝**而不是跟随，因此工具
无法读写 profiles 目录之外的内容。

**绝不启动交互式编辑器。** gist 的读写全走 `gh api`。显而易见的替代方案 `gh gist edit` 会拉起
`$EDITOR`，在无人值守的插件宿主里会直接挂住。

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
test/                  四套共 111 项离线用例，另有 10 项真实用例
```

## 开发

```bash
npm test                # 四套离线用例（111 项）
npm run test:sync       # 用假 gh 跑引擎完整生命周期
npm run test:tools      # 工具层、参数校验、故障隔离
npm run test:schema     # 定义 vs. Harness 自带校验器
npm run test:regression # 对抗性审核发现的具体缺陷
npm run test:live       # 需显式开启：真实 GitHub
```

`test/fake-gh.mjs` 是 `gh` 的内存替身，实现了 `--version`、`auth status` 和 `/gists` 接口，并可选
注入"截断文件""HTTP 500""未登录的 CLI"。`sync`、`tools`、`regression` 三套把 `ghPath` 指向它，
因此整个生命周期 —— 创建、上传、下载、分叉、备份、清理、gist 重建、幂等、恢复 —— 都能在
无网络、无 GitHub 账号的情况下跑完。

`test/schema.test.mjs` 会从 `process.execPath` 定位已安装的 `@deepseek-ai/dsh-tools`
（可用 `DSH_TOOLS_DIR` 覆盖），并重放运行时的检查：注册契约、受支持的 JSON Schema 子集、
参数校验，以及每个工具的返回值是否满足它声明的输出 schema。**找不到安装时它会失败而不是跳过** ——
静默跳过会让 `npm test` 全绿但一个校验都没跑；想刻意接受跳过可设 `DSH_ALLOW_SCHEMA_SKIP=1`。

`test/live.test.mjs` 需要**显式开启**，因为它会创建真实的 secret gist。它在系统临时目录下使用
一次性的 `DSH_HOME`，因此不会读写你的真实 profile；即使断言失败，它也会删除自己创建的 gist。

```powershell
$env:DSH_GIST_LIVE_TEST='1'; npm run test:live     # PowerShell
```

```bash
DSH_GIST_LIVE_TEST=1 npm run test:live             # bash
```

由于 `install_bundle` 用的是符号链接，**工作副本就是线上插件**：改 `index.js` 和 `lib/` 重载后即生效。

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