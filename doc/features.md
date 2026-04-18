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
   - 动态添加 worktree 文件夹到 VSCode workspace
   - 设为活跃 Spec
   - 启动 Agent 终端

### 2. 启动 Spec (`tmuxAgent.startSpec`)

**入口**: 侧边栏 All Specs 视图的 `▸` 按钮 或命令面板

**流程**:
1. 加载已有的 Spec 配置
2. 创建 worktrees（如果不存在则创建，已存在则跳过）
3. 更新状态为 active
4. 生成/更新 `.code-workspace`
5. 应用 git 隔离设置 + 添加文件夹到 workspace
6. 启动 Agent 终端

### 3. 切换 Spec (`tmuxAgent.switchSpec`)

**入口**: 侧边栏 All Specs 视图的 `⇆` 按钮 或命令面板

**核心机制**: 使用 `switchWorkspaceFolders()` 在同一 VSCode 窗口内原子替换 workspace 文件夹，终端不中断。

**流程**:
1. 应用 git 隔离设置
2. 原子替换 managed 文件夹（一次 `updateWorkspaceFolders` 调用）
3. 通过 Git 扩展 API 关闭旧 Spec 仓库、打开新 Spec 仓库（`refreshGitRepositories`）
4. 更新 active spec state
5. 启动新 Spec 的 Agent 终端
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
- **扩展激活时**: 自动同步 workspace folders 和 SCM 仓库到 active spec，清理上次会话残留
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
| 首次创建/启动 | `addSpecFoldersToWorkspace()` | 在末尾追加 |
| 切换 Spec | `switchWorkspaceFolders()` | 原子替换 managed 文件夹 |
| 添加单个 Repo | `addFolderToCurrentWorkspace()` | 在末尾追加单个 |
| 删除/清理 | `removeFoldersFromCurrentWorkspace()` | 原子移除 managed 文件夹 |

## Agent 终端管理

- 终端名称：`Agent: <specName>`
- CWD：`~/.tmux-agent/worktrees/<specName>/`（Spec 级目录，而非某个 repo）
- 自动启动：创建/启动/切换 Spec 时自动创建终端并执行 agent 命令
- 生命周期追踪：`agentTerminals` Map 追踪所有终端，`onDidCloseTerminal` 清理已关闭的
- 扩展激活时：如有 active spec，同步 workspace folders 并刷新 Git SCM 视图，延迟 2 秒恢复终端
