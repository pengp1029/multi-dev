# tmux-agent 功能文档

## 核心功能

### 1. 创建 Spec (`tmuxAgent.createSpec`)

**入口**: 侧边栏 All Specs 视图的 `+` 按钮

**流程**:
1. 打开 Webview 表单，填写 Spec 名称、描述、feature branch、agent 命令
2. 通过 Browse 按钮选择多个 Git 仓库
3. 点击 Create Spec：
   - 验证每个仓库是否是 git repo 且有 commits
   - 为每个仓库创建 git worktree（`~/.tmux-agent/worktrees/<spec>/<repo>/`）
   - 保存 Spec YAML 配置
   - 生成 `.code-workspace` 文件
   - 应用 git 隔离设置
   - 通过 `vscode.openFolder` 打开 `.code-workspace` 文件（窗口重新加载）
   - 设为活跃 Spec
   - 激活时自动恢复：同步 workspace 文件夹、Git SCM 视图、启动 Agent 终端

### 2. 启动 Spec (`tmuxAgent.startSpec`)

**入口**: 侧边栏 All Specs 视图的 `▸` 按钮 或命令面板

**流程**:
1. 加载已有的 Spec 配置
2. 创建 worktrees（如果不存在则创建，已存在则跳过）
3. 更新状态为 active
4. 生成/更新 `.code-workspace`
5. 通过 `vscode.openFolder` 打开 `.code-workspace` 文件（窗口重新加载）
6. 激活时自动恢复：应用 git 隔离设置、同步 workspace 文件夹、Git SCM 视图、启动 Agent 终端

### 3. 切换 Spec (`tmuxAgent.switchSpec`)

**入口**: 侧边栏 All Specs 视图的 `⇆` 按钮 或命令面板

**核心机制**: 若当前已在目标 Spec 的 `.code-workspace` 文件中，使用 `switchWorkspaceFolders()` 在同一窗口内原子替换文件夹（无需重新加载）；否则通过 `openWorkspaceFile()` 打开目标 `.code-workspace`，触发窗口重新加载。

**流程**:
1. 持久化目标 Spec 为 active spec
2. 应用 git 隔离设置
3. 重新生成 `.code-workspace` 文件
4. **已在目标 workspace 文件中**: 原子替换 managed 文件夹 → 刷新 Git SCM 视图 → 启动 Agent 终端
5. **不在目标 workspace 文件中**: 通过 `vscode.openFolder` 打开 `.code-workspace`（窗口重新加载，激活时自动恢复）
6. 刷新侧边栏

### 4. 添加 Repo (`tmuxAgent.addRepo`)

**入口**: 侧边栏 Current Spec 视图的 `+` 按钮

**流程**:
1. 检查当前是否有活跃 Spec
2. 打开文件夹选择对话框
3. 验证 git repo + 有 commits + 未重复添加
4. 询问分支名（默认使用 Spec 的 feature branch）
5. 创建 worktree → 更新 Spec + workspace 文件 → 动态添加文件夹

**特点**: 无需重启 VSCode，新文件夹立即出现在 Explorer 和 SCM 视图。

### 5. 批量提交 (`tmuxAgent.commitSpec`)

**入口**: Current Spec 右键菜单

**流程**:
1. 输入提交信息
2. 选择 New Commit 或 Amend
3. 遍历所有 repos，对有变更的执行 `git add -A && git commit`
4. 以 modal 对话框展示每个 repo 的提交结果

### 6. 清理 Spec (`tmuxAgent.cleanupSpec`)

**入口**: Current Spec 右键菜单

**流程**:
1. 确认清理（modal 警告）
2. 选择"标记完成"（保留配置）或"完全删除"
3. 移除 workspace 文件夹 → 关闭终端 → 移除 worktrees
4. 根据选择更新或删除 Spec

### 7. 删除 Spec (`tmuxAgent.deleteSpec`)

**入口**: 侧边栏 All Specs 视图每个 Spec 右侧的 `✕` 按钮

**流程**:
1. 确认删除（modal 警告）
2. 若为当前活跃 Spec，先移除 workspace 文件夹
3. 关闭 Agent 终端
4. 移除所有 worktrees
5. 删除 worktree 根目录、workspace 文件、Spec YAML

### 8. 刷新视图 (`tmuxAgent.refreshSpecs`)

**入口**: 侧边栏 All Specs 视图的 `↻` 按钮

重新读取 YAML 文件和 git status，刷新两个 TreeView。

## Git SCM 隔离机制

每个 Spec 的 `.code-workspace` 文件包含隔离设置：

```json
{
  "folders": [
    { "name": "backend (feat/user-auth)", "path": "~/.tmux-agent/worktrees/user-auth/backend" }
  ],
  "settings": {
    "git.openRepositoryInParentFolders": "never",
    "git.repositoryScanMaxDepth": 1,
    "tmuxAgent.activeSpec": "user-auth"
  }
}
```

- `git.openRepositoryInParentFolders: "never"` — 阻止 VSCode Git 扩展扫描父目录
- `git.repositoryScanMaxDepth: 1` — 限制扫描深度为根目录

### 主动 SCM 仓库管理 (`gitScm.ts`)

仅靠 workspace settings 无法保证 SCM 视图正确切换，扩展通过 `vscode.git` API 主动管理：

- **切换/启动 Spec 时**: `refreshGitRepositories()` 关闭不属于当前 Spec 的仓库，打开当前 Spec 的仓库
- **扩展激活时**: 若已在正确的 `.code-workspace` 文件中，同步 workspace folders 和 SCM 仓库到 active spec，清理上次会话残留；否则自动打开正确的 workspace 文件（触发窗口重新加载）
- **依赖声明**: `package.json` 中 `extensionDependencies: ["vscode.git"]` 确保 Git 扩展先于本扩展激活

## Workspace 文件夹管理策略

### Managed vs Non-managed

```
workspace 文件夹:
├── /Users/user/project/tmux-agent     ← non-managed (用户自己的)
├── ~/.tmux-agent/worktrees/spec/repo1 ← managed (由扩展管理)
└── ~/.tmux-agent/worktrees/spec/repo2 ← managed (由扩展管理)
```

`isManagedFolder()` 通过检查路径是否以 `WORKTREES_DIR` 开头来判断。切换 Spec 时只替换 managed 文件夹，用户自己的文件夹不受影响。

### 操作分类

| 场景 | 函数 | 策略 |
|------|------|------|
| 首次创建/启动 | `openWorkspaceFile()` | 打开 `.code-workspace` 文件（窗口重新加载） |
| 切换 Spec（已在 workspace 文件中） | `switchWorkspaceFolders()` | 原子替换 managed 文件夹 |
| 切换 Spec（不在 workspace 文件中） | `openWorkspaceFile()` | 打开 `.code-workspace` 文件（窗口重新加载） |
| 添加单个 Repo | `addFolderToCurrentWorkspace()` | 在末尾追加单个 |
| 删除/清理 | `removeFoldersFromCurrentWorkspace()` | 原子移除 managed 文件夹 |

## Agent 终端管理

- 终端名称：`Agent: <specName>`
- CWD：`~/.tmux-agent/worktrees/<specName>/`（Spec 级目录，而非某个 repo）
- 自动启动：创建/启动/切换 Spec 时自动创建终端并执行 agent 命令
- 生命周期追踪：`agentTerminals` Map 追踪所有终端，`onDidCloseTerminal` 清理已关闭的
- 扩展激活时：如有 active spec，同步 workspace folders 并刷新 Git SCM 视图，延迟 2 秒恢复终端

### 系统 Prompt 注入

Agent 启动时自动通过 `--system-prompt` 命令行参数注入 workspace 上下文信息，使 agent 了解当前工作环境。

**注入内容**:
- Spec 名称、描述、feature branch
- 工作目录路径
- 所有仓库列表（名称、worktree 路径、origin 路径、分支）
- 指令：在 worktree 文件夹内搜索代码
- 若无仓库：提醒用户添加代码仓库

**实现位置**: `src/terminalOps.ts` — `buildSystemPrompt()` + `buildAgentCommandWithPrompt()`

### tmux 会话持久化

Agent 终端默认运行在 tmux 会话中，实现跨切换和重启的上下文持久化。

**会话命名**: 每个 Spec 对应一个 tmux 会话 `ta-<specName>`（如 `ta-user-auth`），名称中的特殊字符会被替换为 `-`。

**启动流程** (check → reuse → attach → create):
1. 若当前 Spec 已有存活的 VSCode 终端 → 直接显示
2. 否则销毁其他 Spec 的 VSCode 终端（同一时刻只保留一个 Agent 终端）
3. 若 tmux 会话 `ta-<specName>` 已存在 → 创建 VSCode 终端附着到该会话（上下文保留）
4. 若 tmux 会话不存在 → 创建新的后台 tmux 会话、发送 agent 命令、再创建 VSCode 终端附着

**切换 Spec 时**: 旧 Spec 的 VSCode 终端关闭，但其 tmux 会话保持运行（ducc 进程不中断）。切换回来时重新附着，恢复之前的会话上下文。

**关闭 VSCode 时**: tmux 会话不受影响，所有 Spec 的 ducc 进程继续在后台运行。重新打开 VSCode 后自动重新附着。

**删除/清理 Spec 时**: 同时终止对应的 tmux 会话（`tmux kill-session`），确保不留残余进程。

**tmux 未安装时的回退**: 如果系统未安装 tmux，自动回退到普通 VSCode 终端模式——直接在终端中执行 agent 命令，行为与旧版本一致。tmux 可用性在首次调用时检测并缓存。

## 自动提交决策机制

通过 Claude Code 的 Stop hook 与 CLAUDE.md 规则协作，实现每次 AI 任务完成后自动判断是否需要 git 提交，以及采用新提交还是 amend。

### 触发流程

1. AI 每次回复结束后，Stop hook 脚本（`.claude/hooks/auto-commit-prompt.sh`）自动执行
2. 脚本检测当前仓库是否存在未提交的 git 变更（staged + unstaged + untracked）
3. 若有变更，向对话注入 `<auto-commit-check>` 提示块，触发 AI 进入提交决策流程
4. 若无变更，hook 静默退出，不干扰对话

### 决策规则

AI 根据 CLAUDE.md 中定义的规则进行判断：

| 场景 | 决策 | 理由 |
|------|------|------|
| 上一次提交已推送到远程 | **新提交** | 已推送的提交禁止 amend，避免 force push 风险 |
| 当前改动属于独立新任务 | **新提交** | 语义上是不同的工作单元，应有独立的提交记录 |
| 当前改动是对上次未推送提交的补充 | **amend** | 属于同一工作单元的增量修改，合并为一个提交更清晰 |
| 变更仅涉及文档更新（由 sub-agent 产生） | **amend** | 文档随代码一起提交，不单独占用提交记录 |

### 涉及文件

- `.claude/hooks/auto-commit-prompt.sh` — Stop hook 脚本，检测变更并注入提示
- `.claude/settings.json` — 注册 Stop hook
- `CLAUDE.md` — 定义提交决策规则段落
