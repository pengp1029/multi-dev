# tmux-agent: VSCode Extension 设计文档

## 概述

tmux-agent 是一个 VSCode 扩展，用于管理多仓库隔离开发任务（Spec）。每个 Spec 关联多个 Git 仓库，通过 git worktree 实现代码隔离，每个 Spec 拥有独立的命名 `.code-workspace` 文件（通过 `vscode.openFolder` 打开，避免 "Untitled (Workspace)"），切换 Spec 时 Git Source Control 视图自动切换。

## 核心概念

### Spec（开发规格）
一个 Spec 代表一个开发任务或 Feature，包含：
- 名称、描述
- Feature 分支名
- 关联的多个 Git 仓库
- AI Agent 命令（默认 ducc）
- 可选的 `projectName`：所属 Project 的名称

### Project（项目）
一个 Project 是多个相关 Spec 的逻辑容器。Project 配置持久化于 `~/.tmux-agent/projects/<name>.yaml`。未指定 `projectName` 的 Spec 归入虚拟 `Ungrouped` 组（不写入磁盘）。

Project → Spec 两层模型贯穿侧边栏和 Dashboard，使并发管理多个 Feature 时的导航更清晰。

### 隔离机制
- 每个 Spec 的每个 Repo 都通过 `git worktree` 创建独立的工作目录
- 每个 Spec 生成独立的 `.code-workspace` 文件
- Workspace settings 限制 Git 扫描范围，确保 SCM 只显示当前 Spec 的变更

## 使用流程

### 1. 创建 Spec
- 点击侧边栏 "All Specs" 的 (+) 按钮
- 填写 Spec 名称、描述、Feature 分支
- 添加一个或多个 Git 仓库
- 点击 Create → 自动创建 worktrees、生成 `.code-workspace` 文件、刷新侧边栏视图
- 创建完成后不会自动切换到新 Spec（无窗口重新加载），用户可在 All Specs 视图中手动切换

### 2. 开发中添加 Repo
- 点击 "Current Spec" 的 (+) 按钮
- 选择本地 Git 仓库文件夹
- 输入分支名 → 立即添加到 workspace（无需重启）

### 3. 切换 Spec
- 点击 "All Specs" 中另一个 Spec
- 若当前已在某个 `.code-workspace` 文件中 → 在同一窗口内原子替换 workspace 文件夹（无需重新加载）
- 若当前不在 workspace 文件中 → 通过 `vscode.openFolder` 打开目标 `.code-workspace`（窗口重新加载）
- Git 视图自动切换到新 Spec 的 worktree 变更
- 旧 Spec 的 VSCode 终端关闭，但 tmux 会话（`ta-<specName>`）保持运行，ducc 进程不中断
- 新 Spec 若已有 tmux 会话则直接附着，恢复之前的会话上下文；否则创建新会话

### 4. 提交代码
- Command Palette: "Tmux Agent: Commit All"
- 输入 commit message → 对所有 worktree 执行 git add + commit
- 支持 amend 模式（追加到上一个 commit）

### 5. 清理
- Command Palette: "Tmux Agent: Cleanup Spec"
- 移除所有 worktrees、关闭 agent 终端、终止对应的 tmux 会话
- 可选：标记 completed 或完全删除

## Agent 终端架构

Agent 终端默认使用 tmux 实现会话持久化，VSCode 终端仅作为 tmux 会话的附着窗口。

```
启动/切换 Spec
    ↓
VSCode 终端存活? ──yes──→ 直接显示
    │ no
    ↓
销毁其他 Spec 的 VSCode 终端
    ↓
tmux 可用? ──no──→ 创建普通 VSCode 终端 + 发送 agent 命令（回退模式）
    │ yes
    ↓
tmux 会话 ta-<spec> 存在? ──no──→ tmux new-session + send-keys agent 命令
    │ yes                              ↓
    ↓                             VSCode 终端 attach
VSCode 终端 attach (上下文保留)
```

- **关闭 VSCode 终端**: 仅 detach，tmux 会话和 ducc 进程继续运行
- **关闭 VSCode 窗口**: tmux 会话不受影响，下次打开自动 reattach
- **删除/清理 Spec**: `tmux kill-session` 终止会话，确保无残留

## 数据存储

```
~/.tmux-agent/
├── specs/           # Spec YAML 配置文件
├── projects/        # Project YAML 配置文件（NEW）
├── worktrees/       # Git worktree 工作目录
│   └── <spec>/      # Spec 根目录（可放 spec.md、笔记、设计稿等任务级文件）
│       ├── .claude/
│       │   └── settings.json  # worktree 级 hook 配置（由 hookInstaller 写入）
│       └── <repo>/  # 各 repo 的 worktree
├── state/           # AI 状态文件（NEW）：{ status, message?, updatedAt }
└── workspaces/      # .code-workspace 文件
```

## 技术栈

- TypeScript + VSCode Extension API
- js-yaml (YAML 读写)
- git CLI (worktree 操作)
- tmux (Agent 会话持久化，可选)
- VSCode Webview (创建表单 + Dashboard)
- VSCode TreeView (侧边栏，两层 Project → Spec)
- Node.js fs.watch (AI 状态目录监听)

## Dashboard 交互流程

```
用户点击 Dashboard 图标
    ↓
DashboardPanel.createOrShow()
    ↓
读取 store.ts (所有 Spec) + specState.ts (所有 AI 状态) + gitOps.getChangeSummary()
    ↓
render() → postMessage(data) → Webview 渲染卡片墙（按 Project 分组）
    ↓
用户点击卡片操作按钮:
  ├── 进入 → postMessage({type:'switch'}) → extension switchSpec()
  ├── 提交 → postMessage({type:'commit'}) → extension commitSpec()
  ├── diff → postMessage({type:'diff'})   → extension 打开 diff 视图
  └── 预览 → Peek 面板（右侧滑出，不切换 workspace）
               ├── capturePane(specName)   → tmux 终端输出重放
               ├── getChangeSummary(spec)  → 聚合 diff 展示
               ├── 回复框 send-keys        → sendReply(specName, text)
               └── 批准继续 / 进入深度编辑
```

Dashboard 遵循**单向数据流**：扩展是唯一的数据源，Webview 只负责展示和回传操作意图；所有副作用（切换 Spec、提交等）由扩展处理。Peek 面板是只读审阅视图，不会切换当前 workspace。

## AI 状态上报机制

```
ducc 完成一轮 / 等待用户确认
    ↓
Claude Code 触发 Stop hook 或 Notification hook
    ↓
scripts/report-state.js <status> <spec>
（由 hookInstaller 写入 spec worktree 根目录的 .claude/settings.json）
    ↓
写入 ~/.tmux-agent/state/<spec>.json
{ status, message?, updatedAt }
    ↓
stateWatcher.ts (fs.watch + 100ms 防抖)
读取新状态，与内存缓存对比
    ↓ 仅状态实际改变时触发
onDidChangeState({ specName, prev, next })
    ↓
extension.ts 监听器（并行触发）:
  ├── refreshViews()                    — 刷新侧边栏状态徽章
  ├── DashboardPanel.current?.render()  — 刷新 Dashboard 卡片
  └── notify(specName, prev, next)      — 三通道通知（shouldNotify 去重）
        ├── 系统通知 (osascript/notify-send/BurntToast)
        ├── Webhook POST (fire-and-forget, 3s 超时)
        └── VSCode Toast（带"进入"按钮 → switchSpec）
```

`SpecStatus` 值及语义：

| 状态 | 触发时机 | 徽章 |
|------|----------|------|
| `working` | AI 正在执行（由扩展在启动 agent 时写入） | ●工作中 |
| `waiting_confirm` | Notification hook 触发（AI 等待用户确认） | ⚠等确认 |
| `done` | Stop hook 触发（AI 回合结束） | ✓完成 |
| `idle` | 初始状态 / 状态文件缺失 | ○空闲 |
