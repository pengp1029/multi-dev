# tmux-agent: VSCode Extension 设计文档

## 概述

tmux-agent 是一个 VSCode 扩展，用于管理多仓库隔离开发任务（Spec）。每个 Spec 关联多个 Git 仓库，通过 git worktree 实现代码隔离，每个 Spec 拥有独立的 VSCode workspace，切换 Spec 时 Git Source Control 视图自动切换。

## 核心概念

### Spec（开发规格）
一个 Spec 代表一个开发任务或 Feature，包含：
- 名称、描述
- Feature 分支名
- 关联的多个 Git 仓库
- AI Agent 命令（默认 ducc）

### 隔离机制
- 每个 Spec 的每个 Repo 都通过 `git worktree` 创建独立的工作目录
- 每个 Spec 生成独立的 `.code-workspace` 文件
- Workspace settings 限制 Git 扫描范围，确保 SCM 只显示当前 Spec 的变更

## 使用流程

### 1. 创建 Spec
- 点击侧边栏 "All Specs" 的 (+) 按钮
- 填写 Spec 名称、描述、Feature 分支
- 添加一个或多个 Git 仓库
- 点击 Create → 自动创建 worktrees、打开 workspace、启动 AI agent（tmux 会话）

### 2. 开发中添加 Repo
- 点击 "Current Spec" 的 (+) 按钮
- 选择本地 Git 仓库文件夹
- 输入分支名 → 立即添加到 workspace（无需重启）

### 3. 切换 Spec
- 点击 "All Specs" 中另一个 Spec → VSCode 重新加载对应 workspace
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
├── worktrees/       # Git worktree 工作目录
└── workspaces/      # .code-workspace 文件
```

## 技术栈

- TypeScript + VSCode Extension API
- js-yaml (YAML 读写)
- git CLI (worktree 操作)
- tmux (Agent 会话持久化，可选)
- VSCode Webview (创建表单)
- VSCode TreeView (侧边栏)
