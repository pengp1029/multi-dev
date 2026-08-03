# tmux-agent 架构文档

## 概述

tmux-agent 是一个 VSCode 扩展，用于管理开发任务（Spec）。每个 Spec 关联多个 Git 仓库，通过 git worktree 实现分支隔离开发，并集成 AI CLI 终端（默认 ducc），提供一站式多仓库并行开发体验。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| VSCode Extension API | ^1.85.0 | 扩展宿主 |
| TypeScript | ^5.3.0 | 开发语言 |
| js-yaml | ^4.1.0 | Spec 配置序列化/反序列化 |
| git worktree | — | 分支隔离开发 |
| tmux | — | Agent 会话持久化（可选，未安装时回退到普通终端） |

## 项目结构

```
tmux-agent/
├── package.json              # 扩展清单：commands, views, menus, configuration
├── tsconfig.json             # TS 编译配置 (target: ES2020, strict)
├── .mocharc.json             # Mocha 测试配置 (ts-node, src/test/)
├── .vscode/
│   ├── launch.json           # F5 调试配置 (extensionHost)
│   └── tasks.json            # compile / watch 任务
├── scripts/
│   └── report-state.js       # 钩子脚本：node report-state.js <status> <spec>
│                             # 写入 ~/.tmux-agent/state/<spec>.json，无外部依赖
├── src/
│   ├── extension.ts          # activate/deactivate 入口；注册命令、启动 StateWatcher
│   ├── types.ts              # Spec（含 projectName?）、RepoEntry、Project、SpecStatus、SpecState 接口
│   ├── config.ts             # 路径常量：TMUX_AGENT_HOME, SPECS_DIR, WORKTREES_DIR,
│   │                         #   WORKSPACES_DIR, PROJECTS_DIR, STATE_DIR + ensureDirs()
│   ├── state.ts              # 全局状态管理 (workspaceState)
│   ├── store.ts              # Spec YAML CRUD (js-yaml)；round-trips project_name
│   ├── projectStore.ts       # Project YAML CRUD + groupSpecsByProject()
│   ├── specState.ts          # AI 状态文件读写 (~/.tmux-agent/state/<spec>.json)
│   ├── stateWatcher.ts       # 状态目录监听器 (fs.watch + 防抖 + onDidChangeState 事件)
│   ├── notifier.ts           # 三通道通知分发 (系统通知 / webhook / VSCode toast)
│   ├── hookInstaller.ts      # buildHookSettings() 纯函数 + installHooks()；
│   │                         # 写入 spec worktree 根目录的 .claude/settings.json
│   ├── gitOps.ts             # git worktree 操作封装；新增 getChangeSummary()
│   ├── gitScm.ts             # VSCode Git SCM 视图管理 (开/关仓库)
│   ├── workspaceOps.ts       # workspace 文件夹动态管理 + git 隔离
│   ├── terminalOps.ts        # Agent 终端生命周期管理；导出 getTmuxSessionName、
│   │                         # capturePane、sendReply
│   ├── views/
│   │   ├── specTreeProvider.ts  # 侧边栏 TreeView：两层（Project → Spec → Repos）
│   │   │                        # spec 节点显示 AI 状态徽章
│   │   ├── specWebview.ts       # Webview 表单（创建 Spec，含 Project 下拉）
│   │   └── dashboardWebview.ts  # DashboardPanel 单例：卡片墙 + Peek 面板
│   ├── commands/
│   │   ├── createSpec.ts     # 创建 Spec；选择/创建 Project；安装 hooks
│   │   ├── startSpec.ts      # 启动 Spec（创建 worktree + 打开）
│   │   ├── switchSpec.ts     # 切换 Spec；接受 {spec}/{specName} payload
│   │   ├── addRepo.ts        # 动态添加 Repo（无需重启）
│   │   ├── commitSpec.ts     # 批量提交所有 worktree
│   │   ├── cleanupSpec.ts    # 清理 Spec（移除 worktree，可保留配置）
│   │   └── deleteSpec.ts     # 删除 Spec（完全清理）
│   └── test/
│       ├── mocha-setup.js    # Mocha 全局 setup（加载 vscode stub）
│       ├── vscode-stub.js    # vscode 模块的 Node.js 桩，供单元测试使用
│       ├── notifier.test.ts  # shouldNotify 单元测试（5 个用例）
│       └── stateWatcher.test.ts # StateWatcher 防抖、变更检测单元测试
├── media/
│   └── icon.svg              # 侧边栏图标
└── doc/
    └── *.md                  # 文档
```

## 数据存储

所有数据存放在 `~/.tmux-agent/` 下：

```
~/.tmux-agent/
├── specs/                    # Spec 配置 YAML
│   ├── user-auth.yaml
│   └── payment.yaml
├── projects/                 # (NEW) Project 配置 YAML
│   ├── my-project.yaml
│   └── another-project.yaml
├── worktrees/                # git worktree 工作目录
│   ├── user-auth/            # Spec 根目录（可放 spec.md、笔记等任务级文件）
│   │   ├── .claude/
│   │   │   └── settings.json # (NEW) worktree 级 hook 配置（由 hookInstaller 写入）
│   │   ├── backend/          # → feat/user-auth 分支
│   │   └── frontend/         # → feat/user-auth 分支
│   └── payment/
│       └── core-service/
├── state/                    # (NEW) AI 状态文件（每个 Spec 一个 JSON）
│   ├── user-auth.json        # { status, message?, updatedAt }
│   └── payment.json
└── workspaces/               # VSCode .code-workspace 文件
    ├── user-auth.code-workspace
    └── payment.code-workspace
```

## 数据流

```
用户操作 (侧边栏/Webview)
    ↓
commands/*.ts (命令处理)
    ↓
┌─────────┬──────────────┬───────────────┬──────────────┬──────────┐
│ store.ts│ gitOps.ts    │workspaceOps.ts│terminalOps.ts│ gitScm.ts│
│(YAML IO)│(git worktree)│(workspace 管理)│(tmux 会话管理)│(SCM 视图) │
└─────────┴──────────────┴───────────────┴──────────────┴──────────┘
    ↓                          ↓                ↓              ↓
~/.tmux-agent/specs/     ┌────┴────┐       tmux CLI       Git Extension API
                         │         │      (execFileSync)
                 vscode.openFolder │         ↕ attach/detach
                 (打开 .code-workspace,│   VSCode Terminal API
                  触发窗口重新加载)   │
                         │         │
                 updateWorkspaceFolders
                 (已在 workspace 内时
                  原子替换文件夹)
```

### AI 状态变更数据流（StateWatcher 联动）

```
~/.tmux-agent/state/<spec>.json (文件系统写入，由 AI agent 触发)
    ↓
stateWatcher.ts (fs.watch + 100ms 防抖 + 内存缓存对比)
    ↓  onDidChangeState({ specName, prev, next })
extension.ts (监听器)
    ↓
┌─────────────────────┬──────────────────────────┬─────────────────────┐
│ refreshViews()      │ DashboardPanel.current   │ notify()            │
│ (刷新侧边栏 TreeView)│  ?.render()              │ (三通道通知分发)     │
│                     │ (刷新 Dashboard Webview) │                     │
└─────────────────────┴──────────────────────────┴─────────────────────┘
                                ↓                           ↓
                    views/dashboardWebview.ts     notifier.ts
                    (展示各 Spec 实时状态)         ├─ 系统通知 (osascript/notify-send)
                                                  ├─ Webhook POST (fire-and-forget)
                                                  └─ VSCode Toast (带"进入"按钮)
```

## 模块职责

### 核心模块

| 模块 | 职责 |
|------|------|
| `types.ts` | `Spec` 和 `RepoEntry` 接口定义 |
| `config.ts` | 路径常量 (`TMUX_AGENT_HOME`, `SPECS_DIR`, `WORKTREES_DIR`, `WORKSPACES_DIR`) + `ensureDirs()` |
| `state.ts` | 通过 `context.workspaceState` 管理当前活跃 Spec 名称 |
| `store.ts` | Spec 的 YAML 文件 CRUD，含 camelCase ↔ snake_case 转换 |
| `projectStore.ts` | Project 的 YAML 文件 CRUD (`saveProject`, `loadProject`, `listProjects`, `deleteProject`)；导出 `ProjectGroup` 接口；纯函数 `groupSpecsByProject()` 将 Spec 列表按所属 Project 分组，无匹配的 Spec 归入虚拟 `Ungrouped` 组 |
| `specState.ts` | AI 状态文件的容错读写（`~/.tmux-agent/state/<spec>.json`）；导出 `stateFilePath`、`readSpecState`、`writeSpecState`；文件缺失、JSON 损坏、未知状态值均静默回退为 `idle`，不抛出异常 |
| `stateWatcher.ts` | 监听 `~/.tmux-agent/state/` 目录的文件变更（`fs.watch`），100ms 防抖后读取对应 Spec 状态，与内存缓存对比；仅当状态实际改变时触发 `onDidChangeState` 事件（`{specName, prev, next}`）；不依赖 `vscode` 模块，可在 ts-node 单元测试环境下直接使用 |
| `notifier.ts` | 三通道通知分发：`shouldNotify(prev, next)` 纯函数去重；`notify()` 依次触发系统通知、webhook POST、VSCode toast（带"进入"按钮）；`sendSystemNotification()` 平台感知（darwin/linux/win32）；`postWebhook()` fire-and-forget HTTP/HTTPS，3s 超时；仅在 `notify()` 内部懒加载 `vscode`，便于纯 Node 单元测试 |
| `hookInstaller.ts` | 纯函数 `buildHookSettings(specName, scriptPath)` 生成 `.claude/settings.json` 内容；`installHooks(spec, scriptPath)` 将该配置写入 spec worktree 根目录，使 ducc 的 Notification hook（→ `waiting_confirm`）和 Stop hook（→ `done`）仅作用于该 managed worktree |

### 操作模块

| 模块 | 职责 |
|------|------|
| `gitOps.ts` | git worktree 增删、状态查询、提交、分支检测等；新增 `getChangeSummary(spec)` 聚合所有 worktree 的 `git status --porcelain`，返回 `ChangeSummary`（totalChanged + 各 repo 文件列表） |
| `gitScm.ts` | 通过 VSCode Git 扩展 API 管理 SCM 视图中的仓库开关，确保只显示当前 Spec 的仓库 |
| `workspaceOps.ts` | `.code-workspace` 生成、通过 `vscode.openFolder` 打开命名 workspace、workspace 文件夹动态增删切换、git 隔离设置、workspace 文件状态检测 |
| `terminalOps.ts` | Agent 终端生命周期管理：优先通过 tmux 会话（`ta-<specName>`）持久化 ducc 进程，VSCode 终端仅作为附着窗口；tmux 不可用时回退到普通终端。导出 `getTmuxSessionName`；纯函数 `buildCaptureArgs`/`buildSendKeysArgs`；`capturePane(specName)`/`sendReply(specName, text)` 在 tmux 会话不存在时优雅降级（返回 `undefined`/`false`） |

### 视图模块

| 模块 | 职责 |
|------|------|
| `specTreeProvider.ts` | `CurrentSpecTreeProvider` (当前 Spec + Repos) + `AllSpecsTreeProvider` (所有 Specs 两层列表：Project → Spec → Repos；spec 节点显示 AI 状态徽章) |
| `specWebview.ts` | 创建 Spec 的 Webview HTML 表单；含 Project 下拉（(Ungrouped) / 已有 Project / ➕New） |
| `dashboardWebview.ts` | `DashboardPanel` 单例 Webview 面板；卡片墙按 Project 分组，每张卡片展示 feature 名称、分支、repos 数、变更文件数、AI 状态徽章（●工作中/⚠等确认/✓完成/○空闲）和相对时间；按钮：进入/diff/提交/预览；Peek 面板（右侧滑出，只读）：tmux capture-pane 重放 + 聚合 diff + 回复框 (send-keys) + 批准继续/进入深度编辑；`createOrShow()` 复用已有面板或新建；`current` 静态属性供外部触发 `render()` 刷新 |

## Spec 生命周期

```
create → active → [switch between specs] → cleanup/delete
  │                      │                       │
  ├─ 创建 worktrees      ├─ 重新生成 .code-workspace├─ 移除 worktrees
  ├─ 保存 YAML           ├─ 更新 active state     ├─ 删除 workspace 文件
  ├─ 生成 .code-workspace├─ 已在 workspace 内?     ├─ 关闭终端
  ├─ openWorkspaceFile() │  ├─ yes: 原子替换文件夹  └─ (可选) 删除 YAML
  │  (窗口重新加载)       │  │   (spec 根 + 各 repo)
  └─ 激活时恢复终端等     │  └─ no: openWorkspaceFile()
                          │       (窗口重新加载)
                          │
                     addRepo (动态添加)
                          ├─ 创建新 worktree
                          ├─ 更新 spec + workspace
                          └─ updateWorkspaceFolders()
```

## 侧边栏 UI 结构

```
┌─ CURRENT SPEC ──────────────────┐
│ ● user-auth ← current           │
│   ├ backend   feat/user-auth ✓  │
│   └ frontend  feat/user-auth ✓  │
│                    [+ Add Repo]  │
├─ ALL SPECS ─────────────────────┤
│ ▼ my-project                    │
│   ● user-auth ●工作中     [✕]   │
│   ○ payment   ○空闲   [▸] [✕]   │
│ ▼ Ungrouped                     │
│   ○ refactor-api      [▸] [✕]  │
│                [+] [↻] [Dashboard]│
└──────────────────────────────────┘
```

- `[+]` = createSpec, `[↻]` = refreshSpecs, `[▸]` = startSpec/switchSpec, `[✕]` = deleteSpec
- `[Dashboard]` = openDashboard（打开总控台 Webview 面板）
- AI 状态徽章：`●工作中` = working，`⚠等确认` = waiting_confirm，`✓完成` = done，`○空闲` = idle
- All Specs 视图采用两层结构：Project 节点（可折叠）→ Spec 节点；projectName 未设置的 Spec 自动归入虚拟 `Ungrouped` 组
