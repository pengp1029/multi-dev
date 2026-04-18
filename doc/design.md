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
- 点击 Create → 自动创建 worktrees、打开 workspace、启动 AI agent

### 2. 开发中添加 Repo
- 点击 "Current Spec" 的 (+) 按钮
- 选择本地 Git 仓库文件夹
- 输入分支名 → 立即添加到 workspace（无需重启）

### 3. 切换 Spec
- 点击 "All Specs" 中另一个 Spec → VSCode 重新加载对应 workspace
- Git 视图自动切换到新 Spec 的 worktree 变更

### 4. 提交代码
- Command Palette: "Tmux Agent: Commit All"
- 输入 commit message → 对所有 worktree 执行 git add + commit
- 支持 amend 模式（追加到上一个 commit）

### 5. 清理
- Command Palette: "Tmux Agent: Cleanup Spec"
- 移除所有 worktrees、关闭 agent 终端
- 可选：标记 completed 或完全删除

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
- VSCode Webview (创建表单)
- VSCode TreeView (侧边栏)
