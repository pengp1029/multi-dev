# Tmux Agent — Spec Manager

> VSCode extension for managing multi-repo isolated development tasks with AI agent integration

---

## 简介

**Tmux Agent** 是一个 VSCode 扩展，专为"**一个任务跨多个 Git 仓库并行开发**"场景设计。它将 git worktree 隔离、VSCode workspace 管理和 tmux 会话持久化融合为一个"Spec"概念，让你在多个功能分支之间一键切换，同时 AI Agent（ducc / Claude Code）的上下文完整保留。

---

## 核心概念：Spec

一个 **Spec** 代表一个开发任务（Feature / Bugfix / Refactor），包含：

| 字段 | 说明 |
|------|------|
| `name` | Spec 唯一标识（用于 worktree 路径、tmux 会话名） |
| `description` | 任务描述 |
| `featureBranch` | 所有 Repo 使用的 feature 分支名 |
| `agentCommand` | 默认 `ducc`，可改为 `claude`、`aider` 等 |
| `repos` | 关联的多个 Git 仓库列表 |
| `status` | `draft` → `active` → `completed` |

---

## 依赖工具

| 工具 | 版本要求 | 说明 |
|------|----------|------|
| **VSCode** | `^1.85.0` | 扩展宿主环境 |
| **git** | `2.5+` | git worktree 支持（2.5 开始引入） |
| **tmux** | 任意版本 | Agent 会话持久化（**可选**，未安装时自动回退到普通终端） |
| **Node.js** | `^18` | 构建扩展（使用扩展无需） |
| **AI Agent CLI** | — | 默认 `ducc`，可配置为任意命令行 AI Agent |

---

## 界面布局

```
┌─ VSCode Activity Bar ───────────────────────────────────────┐
│  🔧 Tmux Agent 图标 (侧边栏入口)                             │
└──────────────────────────────────────────────────────────────┘

┌─ CURRENT SPEC ──────────────────────────────── [+ Add Repo] ─┐
│                                                               │
│  ● user-auth    (右键: Commit All / Cleanup)                  │
│    ├── backend        feat/user-auth  ✓ worktree 正常         │
│    └── frontend       feat/user-auth  ✓ worktree 正常         │
│                                                               │
├─ ALL SPECS ──────────────────────────────── [+] [↻] ─────────┤
│                                                               │
│  ● user-auth    ← 当前活跃                        [✕ 删除]   │
│  ○ payment      ← draft                    [▸ 启动] [✕ 删除] │
│  ○ refactor-api ← draft                    [▸ 启动] [✕ 删除] │
│                                                               │
└───────────────────────────────────────────────────────────────┘

┌─ VSCode Explorer ────────────────────────────────────────────┐
│  📁 backend (feat/user-auth)                                  │
│     ~/.tmux-agent/worktrees/user-auth/backend/                │
│  📁 frontend (feat/user-auth)                                 │
│     ~/.tmux-agent/worktrees/user-auth/frontend/               │
└───────────────────────────────────────────────────────────────┘

┌─ VSCode Source Control (Git) ────────────────────────────────┐
│  ✱ backend (feat/user-auth)   — 仅显示当前 Spec 的变更        │
│  ✱ frontend (feat/user-auth)                                  │
└───────────────────────────────────────────────────────────────┘

┌─ VSCode Terminal ────────────────────────────────────────────┐
│  Agent: user-auth                                             │
│  $ tmux attach-session -t ta-user-auth                        │
│  ducc> █ ← AI Agent 运行中，切换 Spec 不会中断进程            │
└───────────────────────────────────────────────────────────────┘
```

---

## 功能一览

### 1. 创建 Spec — Webview 表单

点击侧边栏 `[+]` 按钮，弹出 Webview 表单：

```
┌─ Create New Spec ────────────────────────────────────────────┐
│                                                               │
│  Name:           [user-auth                    ]             │
│  Description:    [Implement user authentication ]             │
│  Feature Branch: [feat/user-auth               ]             │
│  Agent Command:  [ducc                         ]             │
│                                                               │
│  Repositories:                                               │
│  ┌─────────────────────────────────────────── [Browse] ──┐  │
│  │ /Users/dev/projects/backend                            │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────── [Browse] ──┐  │
│  │ /Users/dev/projects/frontend                           │  │
│  └────────────────────────────────────────────────────────┘  │
│  [+ Add Repo]                                                 │
│                                                               │
│                                    [Cancel]  [Create Spec →] │
└───────────────────────────────────────────────────────────────┘
```

**执行流程**:
1. 验证每个仓库是否为有效 git repo（含 commits）
2. 为每个 repo 执行 `git worktree add ~/.tmux-agent/worktrees/<spec>/<repo>/ feat/<branch>`
3. 写入 `~/.tmux-agent/specs/<name>.yaml`
4. 生成 `~/.tmux-agent/workspaces/<name>.code-workspace`（含 git 隔离配置）
5. 调用 `vscode.openFolder()` 打开 workspace 文件（触发窗口重载）
6. 激活时自动恢复：同步 SCM 视图 + 启动 Agent 终端

---

### 2. 切换 Spec — 无缝切换

```
当前在 user-auth workspace 中，切换到 payment:

  [切换前]                          [切换后]
  Explorer:                         Explorer:
  📁 backend (feat/user-auth)   →   📁 core-service (feat/payment)
  📁 frontend (feat/user-auth)  →   📁 payment-ui (feat/payment)

  SCM 视图:                          SCM 视图:
  ✱ backend                     →   ✱ core-service
  ✱ frontend                    →   ✱ payment-ui

  Terminal:                          Terminal:
  Agent: user-auth (tmux 保活)  →   Agent: payment (新建或重附着)
```

**两种切换策略**:

| 当前状态 | 策略 | 效果 |
|---------|------|------|
| 已在某个 `.code-workspace` 文件中 | `updateWorkspaceFolders()` | **原地替换**，无需重载窗口 |
| 未在 workspace 文件中 | `vscode.openFolder()` | 打开目标 workspace 文件，触发重载 |

---

### 3. Agent 终端 — tmux 会话持久化

```
  VSCode 关闭 ← → VSCode 打开
       ↕                ↕
  tmux detach      tmux attach
       ↕                ↕
  ┌─────────────────────────────┐
  │  tmux session: ta-user-auth │
  │  ducc> 正在分析代码...      │  ← 进程始终在后台运行
  │  (AI 分析不会中断)           │
  └─────────────────────────────┘

切换 Spec 时:
  旧 Spec VSCode 终端 → 关闭（仅 UI）
  旧 Spec tmux 会话  → 保持运行（进程不中断）
  新 Spec tmux 会话  → 存在则 attach，不存在则 new-session
```

---

### 4. Git SCM 隔离

每个 Spec 的 `.code-workspace` 包含：

```json
{
  "settings": {
    "git.openRepositoryInParentFolders": "never",
    "git.repositoryScanMaxDepth": 1,
    "tmuxAgent.activeSpec": "user-auth"
  }
}
```

扩展还通过 VSCode Git Extension API 主动管理仓库：
- 切换 Spec 时，**关闭**不属于当前 Spec 的仓库，**打开**当前 Spec 的仓库
- 注册 `onDidOpenRepository` 监听器，阻止未授权仓库出现在 SCM 视图

---

### 5. 批量提交

右键当前 Spec 节点 → `Commit All`:

```
提示输入 commit message:
  [feat: add user login API                  ]
  ○ New Commit   ● Amend Last Commit

执行结果:
  ✓ backend    — 已提交 "feat: add user login API"
  ✓ frontend   — 已提交 "feat: add user login API"
  - core-svc   — 无变更，跳过
```

---

## 架构图

### 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                        VSCode Extension Host                    │
│                                                                  │
│  ┌──────────────────┐    ┌────────────────────────────────────┐ │
│  │    Views (UI)    │    │           Commands                  │ │
│  │                  │    │                                     │ │
│  │ specTreeProvider │───▶│ createSpec  startSpec  switchSpec   │ │
│  │  ├ CurrentSpec   │    │ addRepo     commitSpec  cleanupSpec │ │
│  │  └ AllSpecs      │    │ deleteSpec  refreshSpecs            │ │
│  │                  │    └──────────┬────────────┬────────────┘ │
│  │ specWebview      │               │            │              │
│  │  └ Create Form   │               ▼            ▼              │
│  └──────────────────┘    ┌──────────────┐  ┌──────────────┐    │
│                           │   Core Ops   │  │  State/Store │    │
│                           │              │  │              │    │
│                           │ gitOps.ts    │  │ store.ts     │    │
│                           │ gitScm.ts    │  │ (YAML CRUD)  │    │
│                           │ workspaceOps │  │              │    │
│                           │ terminalOps  │  │ state.ts     │    │
│                           │ config.ts    │  │ (activeSpec) │    │
│                           └──────┬───────┘  └──────────────┘    │
│                                  │                               │
└──────────────────────────────────│───────────────────────────────┘
                                   │
         ┌─────────────────────────┼──────────────────────────┐
         │                         │                          │
         ▼                         ▼                          ▼
┌─────────────────┐    ┌───────────────────────┐    ┌────────────────┐
│   File System   │    │     Git CLI           │    │ tmux CLI       │
│                 │    │                       │    │                │
│ ~/.tmux-agent/  │    │ git worktree add/rm   │    │ new-session    │
│ ├─ specs/*.yaml │    │ git status            │    │ attach-session │
│ ├─ worktrees/   │    │ git add && commit     │    │ kill-session   │
│ └─ workspaces/  │    └───────────────────────┘    │ switch-client  │
│   *.code-       │                                  └────────────────┘
│    workspace    │
└─────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│                  VSCode Extension APIs                          │
│                                                                  │
│  vscode.workspace.updateWorkspaceFolders()                      │
│  vscode.openFolder() / vscode.commands.executeCommand()         │
│  vscode.window.createTerminal()                                 │
│  vscode.git (Git Extension API — openRepository/closeRepository)│
└────────────────────────────────────────────────────────────────┘
```

### 数据存储结构

```
~/.tmux-agent/
├── specs/
│   ├── user-auth.yaml          # Spec 配置（YAML，snake_case）
│   │   # name: user-auth
│   │   # feature_branch: feat/user-auth
│   │   # agent_command: ducc
│   │   # status: active
│   │   # repos:
│   │   #   - name: backend
│   │   #     origin_path: /Users/dev/backend
│   │   #     worktree_path: ~/.tmux-agent/worktrees/user-auth/backend
│   │   #     branch: feat/user-auth
│   └── payment.yaml
│
├── worktrees/
│   ├── user-auth/
│   │   ├── backend/            # git worktree (feat/user-auth 分支)
│   │   └── frontend/           # git worktree (feat/user-auth 分支)
│   └── payment/
│       └── core-service/
│
└── workspaces/
    ├── user-auth.code-workspace
    └── payment.code-workspace
```

### Spec 生命周期

```
         ┌──────────────┐
         │    create    │  填写表单 → 创建 worktrees → 打开 workspace
         └──────┬───────┘
                │ status: draft → active
                ▼
         ┌──────────────┐
   ┌────▶│    active    │◀────────────────────────────────┐
   │     └──────┬───────┘                                 │
   │            │                                         │
   │     ┌──────┴──────────────────────────────┐         │
   │     │         operations                   │         │
   │     │                                      │         │
   │     │  addRepo → 动态追加 repo + worktree   │         │
   │     │  commitSpec → 批量 git commit         │         │
   │     │  switchSpec → 切换到其他 Spec ─────────┼─────────┘
   │     └──────┬───────────────────────────────┘
   │            │
   │     ┌──────▼───────┐
   │     │   cleanup    │  移除 worktrees（保留/删除 YAML）
   │     └──────┬───────┘
   │            │ status → completed
   │            ▼
   │     ┌──────────────┐
   └─────│  completed   │  可重新 startSpec 激活
         └──────┬───────┘
                │
         ┌──────▼───────┐
         │    delete    │  完全删除：worktrees + workspace + YAML
         └──────────────┘
```

---

## 安装

### 方式一：从 .vsix 安装

```bash
code --install-extension tmux-agent-1.0.0.vsix
```

或在 VSCode 中：`Extensions` 视图 → `...` → `Install from VSIX...`

### 方式二：从源码构建

```bash
git clone <repo>
cd tmux-agent
npm install
npm run compile

# 打包
npx vsce package
code --install-extension tmux-agent-1.0.0.vsix
```

---

## 快速上手

**1. 打开侧边栏**

点击左侧活动栏的 `🔧` 图标，展开 Tmux Agent 面板。

**2. 创建 Spec**

点击 `All Specs` 标题栏的 `+` 按钮，填写：
- Name: `my-feature`
- Feature Branch: `feat/my-feature`
- Agent Command: `ducc`（或 `claude`、`aider` 等）
- Repos: 选择本地 Git 仓库目录

**3. 开发**

创建后 VSCode 自动：
- 打开 `~/.tmux-agent/workspaces/my-feature.code-workspace`
- Explorer 显示各 repo 的 worktree 目录
- SCM 视图只显示当前 Spec 的变更
- 终端自动启动 AI Agent（tmux 会话 `ta-my-feature`）

**4. 切换任务**

点击 `All Specs` 中另一个 Spec 旁的 `▸` / `⇆` 按钮，无缝切换。

**5. 批量提交**

右键侧边栏当前 Spec 节点 → `Commit All`，输入消息后一键提交所有 repo 的变更。

---

## 命令参考

| 命令 | 触发方式 | 说明 |
|------|----------|------|
| `Tmux Agent: Create Spec` | 侧边栏 `[+]` | 打开 Webview 创建表单 |
| `Tmux Agent: Start Spec` | 侧边栏 `[▸]` | 启动 draft Spec，创建 worktrees |
| `Tmux Agent: Switch Spec` | 侧边栏 `[⇆]` | 切换活跃 Spec |
| `Tmux Agent: Add Repo` | Current Spec `[+]` | 动态添加仓库（无需重启） |
| `Tmux Agent: Commit All` | 右键当前 Spec | 批量提交所有 worktree 变更 |
| `Tmux Agent: Cleanup Spec` | 右键当前 Spec | 清理 worktrees，保留/删除配置 |
| `Tmux Agent: Delete Spec` | 侧边栏 `[✕]` | 完全删除 Spec |
| `Tmux Agent: Refresh` | 侧边栏 `[↻]` | 刷新两个 TreeView |

---

## 项目结构

```
src/
├── extension.ts          # 扩展入口 (activate/deactivate)
├── types.ts              # Spec / RepoEntry 接口
├── config.ts             # 路径常量 + ensureDirs()
├── state.ts              # activeSpec 状态管理 (workspaceState)
├── store.ts              # Spec YAML CRUD (js-yaml)
├── gitOps.ts             # git worktree 操作
├── gitScm.ts             # VSCode SCM 视图管理
├── workspaceOps.ts       # workspace 文件夹动态管理
├── terminalOps.ts        # Agent 终端 + tmux 会话
├── views/
│   ├── specTreeProvider.ts  # 侧边栏 TreeView
│   └── specWebview.ts       # 创建表单 Webview
└── commands/
    ├── createSpec.ts
    ├── startSpec.ts
    ├── switchSpec.ts
    ├── addRepo.ts
    ├── commitSpec.ts
    ├── cleanupSpec.ts
    └── deleteSpec.ts
```

---

## 常见问题

**Q: tmux 未安装会怎样？**

自动回退到普通 VSCode 终端，直接执行 agent 命令。切换 Spec 时 AI Agent 进程会中断（不能持久化），但基本功能不受影响。

**Q: 切换 Spec 需要重载窗口吗？**

如果你已在某个 Spec 的 `.code-workspace` 文件中工作，切换到其他 Spec 使用 `updateWorkspaceFolders()` 原地替换，**不需要重载**。首次打开某个 Spec 才需要窗口重载。

**Q: worktrees 存放在哪里？**

`~/.tmux-agent/worktrees/<specName>/<repoName>/`，与原始仓库完全隔离。

**Q: 如何使用非 ducc 的 AI Agent？**

创建 Spec 时在 `Agent Command` 字段填入任意可执行命令，如 `claude`、`aider`、`cursor` 等。

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| VSCode Extension API | ^1.85.0 | 扩展宿主、TreeView、Webview、Terminal |
| TypeScript | ^5.3.0 | 开发语言（strict 模式） |
| js-yaml | ^4.1.0 | Spec 配置 YAML 序列化 |
| git CLI | 2.5+ | worktree 增删管理 |
| tmux | 任意 | Agent 会话持久化（可选） |

---

## 文档

- [doc/architecture.md](architecture.md) — 模块架构与数据流
- [doc/design.md](design.md) — 设计思路与使用流程
- [doc/features.md](features.md) — 各命令详细说明
- [doc/conventions.md](conventions.md) — 开发规范
- [doc/pitfalls-and-fixes.md](pitfalls-and-fixes.md) — 已知问题与修复记录
