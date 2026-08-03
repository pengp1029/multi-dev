# tmux-agent 功能文档

## 核心功能

### 1. 创建 Spec (`tmuxAgent.createSpec`)

**入口**: 侧边栏 All Specs 视图的 `+` 按钮

**流程**:
1. 打开 Webview 表单，填写 Spec 名称、描述、feature branch、agent 命令
2. 在 Project 下拉中选择归属项目（`(Ungrouped)` / 已有 Project / `➕New` 新建）
3. 通过 Browse 按钮选择多个 Git 仓库
4. 点击 Create Spec：
   - 验证每个仓库是否是 git repo 且有 commits
   - 为每个仓库创建 git worktree（`~/.tmux-agent/worktrees/<spec>/<repo>/`）
   - 保存 Spec YAML 配置（含 `project_name` 字段）
   - 若选择或新建了 Project，更新 Project 的 features 列表并保存 Project YAML
   - 生成 `.code-workspace` 文件
   - 应用 git 隔离设置
   - 调用 `installHooks` 将 `scripts/report-state.js` 路径写入 spec worktree 根目录的 `.claude/settings.json`，注册 Notification hook（→ `waiting_confirm`）和 Stop hook（→ `done`）
   - 刷新侧边栏视图（新 Spec 出现在对应 Project 分组下）
   - **不会自动切换到新 Spec**，用户可通过 All Specs 视图手动切换

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

### 14. 项目分级（Project → Feature 两层模型）

**用途**: 将多个 Spec（Feature）归组到一个 Project 下，在侧边栏和 Dashboard 中以两层树形结构展示，便于在大量并发任务中快速定位。

**存储**: `~/.tmux-agent/projects/<name>.yaml`，每个文件描述一个 Project。Spec YAML 通过 `project_name` 字段记录所属 Project；无 `project_name` 的 Spec 自动归入虚拟 `Ungrouped` 组（不写入磁盘）。

**侧边栏显示**:

```
▼ my-project
   ● user-auth  ●工作中   [✕]
   ○ payment    ○空闲  [▸] [✕]
▼ Ungrouped
   ○ refactor   ○空闲  [▸] [✕]
```

**CRUD API** (`projectStore.ts`):

| 函数 | 说明 |
|------|------|
| `saveProject(project)` | 序列化并写入 Project YAML |
| `loadProject(name)` | 按名称读取并反序列化 Project |
| `listProjects()` | 返回所有已保存的 Project 列表 |
| `deleteProject(name)` | 删除指定 Project 的 YAML 文件 |
| `groupSpecsByProject(specs, projects)` | 纯函数，返回 `ProjectGroup[]`；未匹配的 Spec 归入 `Ungrouped` |

### 15. 总控台 Dashboard (`tmuxAgent.openDashboard`)

**入口**: 侧边栏 All Specs 视图标题栏的 Dashboard 图标按钮，或命令面板 `tmuxAgent.openDashboard`。

**卡片墙**: 按 Project 分组展示所有 Spec 卡片。每张卡片包含：

| 字段 | 说明 |
|------|------|
| Feature 名称 + 分支 | Spec 的 name 和 featureBranch |
| Repos 数量 | 该 Spec 关联的仓库数 |
| 变更文件数 | 聚合所有 worktree 的 `git status --porcelain` 结果 |
| AI 状态徽章 | ●工作中 / ⚠等确认 / ✓完成 / ○空闲 |
| 相对时间 | 最后状态更新的相对时间（如"3 分钟前"） |
| 操作按钮 | 进入（switchSpec）/ diff / 提交（commitSpec）/ 预览（Peek） |

**Peek 面板**（右侧滑出，只读审阅，不切换 workspace）:
- tmux `capture-pane` 重放 AI 终端输出
- 聚合 diff 展示所有 worktree 的变更
- 回复框：`send-keys` 向 tmux 会话发送文本
- 操作按钮：批准继续 / 进入深度编辑（switchSpec）

**数据流**: 扩展是唯一的数据源，通过 `render()` 向 Webview postMessage；Webview 通过 `postMessage` 回传操作请求（单向数据流，扩展处理所有副作用）。

**实时更新**: `StateWatcher.onDidChangeState` 触发 `DashboardPanel.current?.render()`，面板始终展示最新 AI 状态。

### 16. AI 状态提醒（三通道通知）

**触发**: ducc 的 Notification hook（AI 等待用户确认时）触发 → `waiting_confirm`；Stop hook（AI 回合结束时）触发 → `done`。hook 脚本 `scripts/report-state.js` 由 `hookInstaller.ts` 在创建 Spec 时写入 worktree 根目录的 `.claude/settings.json`。

**状态**: `SpecStatus = 'working' | 'waiting_confirm' | 'done' | 'idle'`

状态存储于 `~/.tmux-agent/state/<spec>.json`：

```json
{ "status": "waiting_confirm", "message": "optional context", "updatedAt": "2026-08-03T10:00:00.000Z" }
```

**去重**: `shouldNotify(prev, next)` 纯函数，仅当 `prev !== next` 时返回 `true`，避免重复推送同一状态。

**三个通知渠道**:

| 渠道 | 实现 | 平台 |
|------|------|------|
| 系统通知 | `execFile` 调用原生命令 | macOS: `osascript`；Linux: `notify-send`；Windows: PowerShell BurntToast |
| Webhook POST | fire-and-forget HTTP/HTTPS，3s 超时，失败静默 | 全平台，需在配置中设置 URL |
| VSCode Toast | `vscode.window.showInformationMessage` | 全平台，带"进入"按钮，点击后 `switchSpec` |

**配置**:

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tmuxAgent.notify.system` | boolean | `true` | 是否启用系统桌面通知 |
| `tmuxAgent.notify.webhookUrl` | string | `""` | Webhook URL；为空时跳过 |

**用途**: 将多个 Spec 归组到一个 Project 下，实现任务的逻辑分组管理。

**存储**: Project 配置保存在 `~/.tmux-agent/projects/<name>.yaml`，每个 YAML 文件描述一个 Project（名称、描述、关联的 Spec 列表等）。

**CRUD API**:

| 函数 | 说明 |
|------|------|
| `saveProject(project)` | 序列化并写入 Project YAML |
| `loadProject(name)` | 按名称读取并反序列化 Project |
| `listProjects()` | 返回所有已保存的 Project 列表 |
| `deleteProject(name)` | 删除指定 Project 的 YAML 文件 |

**分组函数** (`groupSpecsByProject`):

纯函数，接收 Spec 列表和 Project 列表，返回 `ProjectGroup[]`。每个 `ProjectGroup` 包含一个 Project 及其下属的 Spec 子列表。未被任何 Project 引用的 Spec 自动归入虚拟组 `Ungrouped`（不写入磁盘）。`ProjectGroup` 接口由 `projectStore.ts` 导出。

### 10. AI 状态持久化 (`specState.ts`)

**用途**: 为每个 Spec 持久化 AI 运行状态（`idle` / `running` / `waiting`），供 Dashboard 等视图实时展示。

**存储**: 状态文件保存在 `~/.tmux-agent/state/<specName>.json`，每个文件包含当前状态字段。

**API**:

| 函数 | 说明 |
|------|------|
| `stateFilePath(specName)` | 返回指定 Spec 的状态文件绝对路径 |
| `readSpecState(specName)` | 读取并解析状态文件，返回当前 AI 状态；文件缺失、JSON 损坏或未知状态值均返回 `"idle"` |
| `writeSpecState(specName, status)` | 将指定状态序列化写入对应的 JSON 文件 |

**容错设计**: 所有读取失败（ENOENT、JSON parse error、unknown status）均静默回退为 `idle`，不向上层抛出异常，保证扩展在状态文件不完整时仍可正常运行。

切换或启动一个 Spec 时，VSCode 资源管理器中的文件夹顺序为：

```
1. ~/.tmux-agent/worktrees/<spec>/        ← Spec 根目录（spec 级任务文件）
2. ~/.tmux-agent/worktrees/<spec>/repo1/  ← 第一个 repo 的 worktree
3. ~/.tmux-agent/worktrees/<spec>/repo2/  ← 第二个 repo 的 worktree
...
```

**Spec 根目录用途**: 放置任务级别的非代码文件，如 `spec.md`（任务说明）、设计稿、笔记、草稿等。这些文件在资源管理器顶层 folder 中可直接访问，无需进入某个具体 repo。切换/启动 Spec 时若根目录不存在会自动创建（`mkdir -p`）。

## Git SCM 隔离机制

每个 Spec 的 `.code-workspace` 文件包含隔离设置：

```json
{
  "folders": [
    { "name": "user-auth", "path": "~/.tmux-agent/worktrees/user-auth" },
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
| 首次启动 | `openWorkspaceFile()` | 打开 `.code-workspace` 文件（窗口重新加载） |
| 首次创建 | `refreshViews()` | 刷新侧边栏视图，不切换窗口 |
| 切换 Spec（已在 workspace 文件中） | `switchWorkspaceFolders()` | 原子替换 managed 文件夹（spec 根 + 各 repo） |
| 切换 Spec（不在 workspace 文件中） | `openWorkspaceFile()` | 打开 `.code-workspace` 文件（窗口重新加载） |
| 添加单个 Repo | `addFolderToCurrentWorkspace()` | 在末尾追加单个 |
| 删除/清理 | `removeFoldersFromCurrentWorkspace(spec)` | 原子移除 managed 文件夹（spec 根 + 各 repo） |

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

### 11. 三通道通知 (`notifier.ts`)

**用途**: 当 Spec 的 AI 状态发生变化时，通过多个渠道向用户发送通知，避免重复推送。

**触发条件**: 状态从 `prev` 转变为 `next`，由纯函数 `shouldNotify(prev, next)` 判断是否需要通知（相同状态不重复通知）。

**三个通知渠道**:

| 渠道 | 实现方式 | 说明 |
|------|----------|------|
| 系统通知 | `sendSystemNotification()` — 平台感知，调用 `execFile` | macOS: `osascript`；Linux: `notify-send`；Windows: PowerShell `New-BurntToastNotification` |
| Webhook POST | `postWebhook()` — fire-and-forget HTTP/HTTPS | 读取用户配置的 URL，3 秒超时，失败静默忽略 |
| VSCode Toast | `vscode.window.showInformationMessage()` | 带"进入"按钮，点击后切换到对应 Spec |

**API**:

| 函数 | 说明 |
|------|------|
| `shouldNotify(prev, next)` | 纯函数，`prev === next` 时返回 `false`，否则返回 `true`；用于去重 |
| `notify(specName, prev, next)` | 三通道分发入口；先调用 `shouldNotify`，若无需通知则提前返回 |
| `sendSystemNotification(title, body)` | 平台感知系统通知，通过 `execFile` 调用原生命令 |
| `postWebhook(url, payload)` | fire-and-forget HTTPS/HTTP POST，3 秒超时，失败不抛出 |

**懒加载设计**: `notify()` 内部通过 `require('vscode')` 懒加载 VSCode API，使 `notifier.ts` 在纯 Node.js 单元测试环境中可直接测试，无需 mock VSCode 宿主。

**单元测试**: `src/test/notifier.test.ts` — 5 个用例覆盖 `shouldNotify` 的各种状态转换场景。

### 12. 状态变更监听器 (`stateWatcher.ts`)

**用途**: 监听 `~/.tmux-agent/state/` 目录下的状态文件变化，检测 Spec AI 状态的实际变更，并以事件方式通知上层模块，驱动通知分发、视图刷新等后续逻辑。


**实现机制**:

1. 使用 `fs.watch()` 监听整个 `state/` 目录
2. 文件变更事件经过 100ms 防抖处理，合并短时间内的多次写入
3. 读取变更文件对应的 Spec 状态，与内存缓存（`Map<specName, SpecStatus>`）对比
4. 仅当状态实际发生改变时，才触发 `onDidChangeState` 事件

**事件结构**:

```typescript
interface StateChangeEvent {
  specName: string;   // 状态发生变化的 Spec 名称
  prev: SpecStatus;   // 变化前的状态
  next: SpecStatus;   // 变化后的新状态
}
```

**API**:

| 函数 / 属性 | 说明 |
|------------|------|
| `new StateWatcher()` | 构造函数，启动目录监听，初始化内存缓存 |
| `onDidChangeState` | 事件订阅接口，注册状态变更回调 |
| `dispose()` | 停止监听，释放资源 |

**设计约束**: `stateWatcher.ts` 不导入 `vscode` 模块，使用自包含的事件发射器实现，可在 `ts-node` 环境下直接进行单元测试，无需 VSCode 扩展宿主。

**单元测试**: `src/test/stateWatcher.test.ts` — 覆盖防抖逻辑、状态变更检测、重复状态不触发事件等场景。

### 13. Dashboard 命令与状态联动 (`tmuxAgent.openDashboard`)

**用途**: 在 VSCode Webview 面板中展示所有 Spec 的实时 AI 运行状态（Dashboard），并在扩展激活时启动 `StateWatcher`，将状态变更事件与视图刷新、通知分发联动。

**入口**: 侧边栏 All Specs 视图标题栏的 Dashboard 图标按钮，或命令面板中的 `tmuxAgent.openDashboard`。

**流程**:
1. 调用 `DashboardPanel.createOrShow(context.extensionUri)` 打开或聚焦 Dashboard Webview 面板
2. 面板首次创建时从 `store.ts` + `specState.ts` 读取所有 Spec 及其当前状态并渲染

**状态联动（StateWatcher 集成）**:

扩展激活（`activate()`）时启动 `StateWatcher`，订阅 `onDidChangeState` 事件，每次状态变更触发以下三个动作（顺序执行）：

```
StateWatcher.onDidChangeState({ specName, prev, next })
    ↓
1. refreshViews()                         — 刷新侧边栏 TreeView
2. DashboardPanel.current?.render()       — 刷新 Dashboard Webview（如已打开）
3. notify(specName, prev, next)           — 三通道通知分发（shouldNotify 去重）
```

**配置项** (`package.json` contributes.configuration):

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tmuxAgent.notify.system` | `boolean` | `true` | 是否启用系统级通知（桌面弹窗） |
| `tmuxAgent.notify.webhookUrl` | `string` | `""` | Webhook 通知的目标 URL；为空时跳过 Webhook 推送 |

**菜单注册**: `tmuxAgent.openDashboard` 命令注册在 `view/title` 菜单的 `tmuxAgentAllSpecs` 视图中，与现有的 `+`、`↻` 按钮并列显示。

**涉及文件**:
- `src/extension.ts` — 注册命令、启动 `StateWatcher`、绑定 `onDidChangeState` 监听器
- `src/views/dashboardWebview.ts` — `DashboardPanel` 类，Webview 面板的创建与渲染
- `package.json` — `contributes.commands`、`contributes.menus.view/title`、`contributes.configuration`
