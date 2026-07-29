# tmux-agent 踩坑记录与 Bug 修复

## Bug 1: 空仓库创建 worktree 失败

**报错**: `fatal: not a valid object name: 'HEAD'`

**原因**: 仓库没有任何 commit（`git init` 后未执行 `git commit`），`git worktree add` 需要一个有效的 HEAD 引用。

**修复**:
- 新增 `hasCommits()` 检查 HEAD 是否有效
- 新增 `getRepoRoot()` 解析真实 git 根目录（用户可能选了子目录）
- 在创建 Spec 和添加 Repo 时前置验证

**代码** (`gitOps.ts`):
```typescript
export function hasCommits(repoPath: string): boolean {
  try {
    execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' });
    return true;
  } catch { return false; }
}
```

---

## Bug 2: "already checked out" 分支冲突

**报错**: `fatal: 'feat/xxx' is already checked out at '/path/to/repo'`

**原因**: 要创建 worktree 的分支正好是原始仓库当前检出的分支，git 不允许同一分支被两个 worktree 同时检出。

**修复**: 先以 detached HEAD 创建 worktree，再在新 worktree 内 checkout 目标分支。

**代码** (`gitOps.ts`):
```typescript
try {
  execSync(`git worktree add "${worktreePath}" "${branch}"`);
} catch (e) {
  if (msg.includes('already checked out')) {
    execSync(`git worktree add --detach "${worktreePath}"`);
    execSync(`git checkout "${branch}"`, { cwd: worktreePath });
  }
}
```

---

## Bug 3: 切换 Spec 时终端中断

**报错**: 切换 Spec 后 AI CLI 终端被关闭，对话丢失

**原因**: 最初方案使用 `vscode.commands.executeCommand('vscode.openFolder', wsPath)` 打开 `.code-workspace` 文件，这会重新加载整个 VSCode 窗口，导致所有终端被销毁。

**修复**: 废弃 `openFolder` 方案，改用 `workspace.updateWorkspaceFolders()` 在同一窗口内动态替换文件夹。引入 `state.ts` 用 `context.workspaceState` 追踪 active spec（替代 workspace settings）。

**关键设计**: `isManagedFolder()` 判断哪些文件夹由扩展管理，切换时只替换 managed 文件夹，用户自己的项目文件夹不受影响。

---

## Bug 4: "Failed to switch workspace folders."

**报错**: `Failed to switch workspace folders.`

**原因**: `switchWorkspaceFolders()` 中循环调用 `updateWorkspaceFolders()` 逐个删除文件夹：

```typescript
// ❌ 错误写法
for (const idx of managedIndices) {
  vscode.workspace.updateWorkspaceFolders(idx, 1);  // 第二次调用失败！
}
```

VSCode API 规定 `updateWorkspaceFolders()` 不能连续调用，必须等待 `onDidChangeWorkspaceFolders` 事件。

**修复**: 合并为单次原子调用：

```typescript
// ✅ 正确写法
const start = managedIndices[0];
const deleteCount = managedIndices.length;
return vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...newFolders);
```

同样修复了 `removeFoldersFromCurrentWorkspace()` 的多次调用问题。

---

## Bug 5: 创建 Spec 时 workspace settings 写入失败

**报错**: `Failed to create spec: 由于该文件具有未保存的更改，因此无法写入到工作区设置。请先保存该工作区设置文件，然后重试。`

**原因**: `addSpecFoldersToWorkspace()` 调用 `updateWorkspaceFolders()` 后，workspace 配置文件被标记为 dirty（未保存）。紧接着 `applyGitIsolationSettings()` 尝试通过 Configuration API 写入同一文件，被 VSCode 拒绝。

**修复**: 调整执行顺序——先写 settings，再改文件夹：

```typescript
// ✅ 先 settings 再 folders
await applyGitIsolationSettings();
addSpecFoldersToWorkspace(spec);
```

影响文件：`createSpec.ts`, `startSpec.ts`, `switchSpec.ts`

---

## Bug 6: Webview 添加多个仓库只显示一个

**现象**: 在创建 Spec 的 Webview 表单中，点击 Browse 添加第二个仓库后，列表中仍然只显示第一个。

**原因**: `showOpenDialog()` 弹出文件选择对话框时会抢占焦点，Webview 面板退到后台。选择完毕后 `postMessage()` 发给了后台的 Webview，消息未被正确处理。

**修复**: 在 `postMessage` 前先调用 `reveal()` 将 Webview 面板拉回前台：

```typescript
if (uris && uris.length > 0) {
  this.panel?.reveal();  // 确保 Webview 在前台
  await this.panel?.webview.postMessage({ type: 'repoPath', ... });
}
```

---

## Bug 7: 切换 Spec 后 Git SCM 视图未更新

**现象**: 切换到另一个 Spec 后，左侧 Git Source Control 视图仍显示旧 Spec 的仓库。

**原因**: `switchWorkspaceFolders()` 只替换了 workspace 文件夹，但未主动通知 VSCode Git 扩展关闭旧仓库/打开新仓库。扩展完全依赖 Git 扩展被动检测 workspace folder 变化，但 `git.openRepositoryInParentFolders: "never"` 隔离设置阻止了 Git 扩展自动发现新仓库。

**修复**:
- 新增 `gitScm.ts` 模块，通过 `vscode.extensions.getExtension('vscode.git')` 获取 Git 扩展 API
- `refreshGitRepositories(newPaths)`: 先用 `git.close` 关闭不属于新 Spec 的旧仓库，再用 `api.openRepository()` 打开新仓库
- 在 `switchSpec.ts` 和 `startSpec.ts` 的 workspace folder 切换后调用
- `package.json` 添加 `extensionDependencies: ["vscode.git"]` 确保 Git 扩展先激活

**代码** (`gitScm.ts`):
```typescript
export async function refreshGitRepositories(newPaths: string[]): Promise<void> {
  const api = await getGitAPI();
  if (!api) { return; }
  const newPathSet = new Set(newPaths);
  // Close stale repos
  for (const repo of [...api.repositories]) {
    if (!newPathSet.has(repo.rootUri.fsPath)) {
      await vscode.commands.executeCommand('git.close', repo.rootUri);
    }
  }
  // Open new repos
  for (const p of newPaths) {
    if (!openPaths.has(p)) {
      await api.openRepository(vscode.Uri.file(p));
    }
  }
}
```

---

## Bug 8: 扩展激活时 Git SCM 显示所有 Spec 的仓库

**现象**: 默认选择了一个 Spec，但 Git SCM 视图显示了全部 Spec 的仓库（如 test-1 的 wm-dataset + test 的 wm-dataset 同时出现）。

**原因**: `extension.ts` 激活逻辑只启动了 Agent 终端，未调用 `switchWorkspaceFolders()` 清理残留的其他 Spec 文件夹，也未调用 `refreshGitRepositories()` 同步 SCM 视图。上次 VSCode 会话中多个 Spec 的 workspace folders 被持久化，重启后 Git 扩展发现了所有文件夹中的仓库。

**修复**:
- 激活时如有 active spec，立即调用 `switchWorkspaceFolders()` 清理非当前 Spec 的 managed 文件夹
- 延迟 2 秒后调用 `refreshGitRepositories()` 确保 Git 扩展只保留当前 Spec 的仓库
- 同时修复 `gitScm.ts` 中 `git.close` 的参数：传 `repo.rootUri`（Uri 类型）而非 repo 对象
- `getGitAPI()` 改为异步，Git 扩展未激活时先 `await activate()`

**代码** (`extension.ts`):
```typescript
const activeSpecName = getActiveSpecName();
if (activeSpecName) {
  const spec = loadSpec(activeSpecName);
  if (spec && spec.status === 'active') {
    applyGitIsolationSettings().then(() => {
      switchWorkspaceFolders(spec);
    });
    setTimeout(async () => {
      await refreshGitRepositories(spec.repos.map(r => r.worktreePath));
      launchAgentTerminal(spec);
    }, 2000);
  }
}
```

---

## Bug 9: Git worktree repos blocked by `openRepositoryInParentFolders: "never"`

**现象**: 切换 spec 后 SCM 视图显示 "在工作区的父文件夹或打开的文件中找到了 Git 存储库"，需手动点击 "打开存储库"。首次加载时也无 Git 信息。

**原因**: Git worktree 目录下的 `.git` 是一个文件（非目录），内容指向原始仓库的 `.git/worktrees/<name>`。VS Code Git 扩展跟随此指针后，将仓库归类为 "parent folder repository"。`openRepositoryInParentFolders: "never"` 设置导致 Git 扩展**拒绝打开**这类仓库——无论是自动发现还是通过 `api.openRepository()` 编程调用都会被阻止。

**修复**:
- 移除 `openRepositoryInParentFolders: "never"` 和 `repositoryScanMaxDepth: 1` 设置
- `applyGitIsolationSettings()` 改为清除这些设置（设为 `undefined`），而非设置它们
- `generateWorkspaceFile()` 不再在 `.code-workspace` 中包含这些 git 设置
- Spec 间的仓库隔离完全依靠 workspace folder 管理 + `git.close` 显式关闭
- `refreshGitRepositories()` 改为等待 `onDidOpenRepository` 事件确认自动发现，超时后再手动 `openRepository` 兜底

**代码** (`workspaceOps.ts`):
```typescript
export async function applyGitIsolationSettings(): Promise<void> {
  const gitConfig = vscode.workspace.getConfiguration('git');
  // Do NOT set openRepositoryInParentFolders to "never" — git worktrees have a
  // .git file pointing to the original repo, and the Git extension classifies them
  // as "parent folder repositories". Setting "never" prevents Git from opening
  // worktree repos even when they are direct workspace folders.
  // Instead, rely on workspace folder management + explicit git.close for isolation.
  await gitConfig.update('openRepositoryInParentFolders', undefined, vscode.ConfigurationTarget.Workspace);
  await gitConfig.update('repositoryScanMaxDepth', undefined, vscode.ConfigurationTarget.Workspace);
}
```

**代码** (`gitScm.ts`):
```typescript
export async function refreshGitRepositories(newPaths: string[]): Promise<void> {
  const api = await getGitAPI();
  if (!api) { return; }

  const newPathSet = new Set(newPaths);

  // 1. Close repositories that are no longer in the new spec
  const reposToClose = [...api.repositories].filter(r => !newPathSet.has(r.rootUri.fsPath));
  for (const repo of reposToClose) {
    await vscode.commands.executeCommand('git.close', repo.rootUri);
  }

  // 2. Wait for Git extension to auto-discover new repos from workspace folders
  const pathsToOpen = newPaths.filter(
    p => !api.repositories.some(r => r.rootUri.fsPath === p)
  );
  if (pathsToOpen.length === 0) { return; }

  const opened = await waitForReposToOpen(api, pathsToOpen, 3000);

  // 3. Fallback: if auto-discovery timed out, open manually
  if (!opened) {
    const stillMissing = newPaths.filter(
      p => !api.repositories.some(r => r.rootUri.fsPath === p)
    );
    for (const p of stillMissing) {
      await api.openRepository(vscode.Uri.file(p));
    }
  }
}
```

---

## Bug 10: CURRENT SPEC tree view 切换 spec 后不刷新

**现象**: 用户在 ALL SPECS 中点击 spec 切换后，CURRENT SPEC 区域仍显示 "No active spec"，不会刷新为新的当前 spec。

**原因**: `switchSpec` 命令中，`refreshViews()` 在 `switchWorkspaceFolders()` 之后才调用。但 `vscode.workspace.updateWorkspaceFolders()` 是异步生效的，可能触发扩展宿主重启或异步重渲染，导致 `refreshViews()` 要么不执行（宿主重启），要么执行后被 VS Code 的重渲染覆盖。同时 `activate()` 恢复路径中也缺少 `refreshViews()` 调用。

**修复**:
- 在 `switchSpec` 中将 `refreshViews()` 提前到 `switchWorkspaceFolders()` 之前执行（此时 `setActiveSpecName` 已完成，tree provider 可以读到新 spec）
- 在 `switchWorkspaceFolders()` 之后再次调用 `refreshViews()` 覆盖正常路径
- 在 `activate()` 的恢复路径 `setTimeout` 回调末尾添加 `refreshViews()`，确保扩展重启后 tree view 也能刷新

**代码** (`src/commands/switchSpec.ts`):
```typescript
// Refresh views BEFORE switchWorkspaceFolders — the API call triggers an
// async workspace-change event that may cause VS Code to re-render the
// sidebar, and subsequent code may not execute if the extension host
// restarts.
refreshViews();

// Switch workspace folders (may trigger extension host restart)
const success = switchWorkspaceFolders(spec);
```

**代码** (`src/extension.ts`):
```typescript
setTimeout(async () => {
  await refreshGitRepositories(spec.repos.map(r => r.worktreePath));
  // ...
  // Refresh tree views after activation restore
  refreshViews();
}, 2000);
```

---

## Bug 11: Active Spec 在 workspace 文件重载后丢失

**现象**: 创建/启动 Spec 后窗口重新加载（通过 `vscode.openFolder` 打开 `.code-workspace` 文件），"Current Spec" 侧边栏显示为空，扩展不知道当前哪个 Spec 处于激活状态。

**原因**: `getActiveSpecName()` 只从 `workspaceState` 读取，而 `workspaceState` 是 per-workspace 的。当通过 `vscode.openFolder` 打开 `.code-workspace` 文件时，VS Code 创建了一个全新的 workspace context，其 `workspaceState` 是空的——之前通过 `setActiveSpecName()` 写入的值随旧 workspace 一起丢失。

**修复**:
- `getActiveSpecName()` 增加 fallback 逻辑：当 `workspaceState` 无值时，从 `vscode.workspace.getConfiguration()` 读取 `tmuxAgent.activeSpec`
- 该配置值由 `generateWorkspaceFile()` 写入 `.code-workspace` 文件的 `settings` 字段中，因此通过 workspace 文件打开时总能读到

**代码** (`src/state.ts`):
```typescript
export function getActiveSpecName(): string | undefined {
  // Try workspaceState first (set during this session)
  const fromState = _context?.workspaceState.get<string>('tmuxAgent.activeSpec');
  if (fromState) { return fromState; }
  // Fall back to workspace settings (written into .code-workspace file by generateWorkspaceFile)
  return vscode.workspace.getConfiguration().get<string>('tmuxAgent.activeSpec');
}
```

---

## Bug 12: switchWorkspaceFolders 对无变化操作返回 false

**现象**: 切换到当前已激活的 Spec 时报错 "Failed to switch workspace folders"。

**原因**: 当通过 `.code-workspace` 文件打开时，workspace 文件夹已经是正确的。`switchWorkspaceFolders()` 尝试用相同的文件夹替换相同的文件夹，`updateWorkspaceFolders()` 对这种无变化操作返回 `false`，上层代码将其视为失败。

**修复**:
- 在调用 `updateWorkspaceFolders` 之前，检测当前 managed 文件夹是否已与目标匹配
- 如果 managed 文件夹数量相同且每个路径一一对应，则直接返回 `true`，跳过无意义的 API 调用

**代码** (`src/workspaceOps.ts`):
```typescript
// If the managed folders already match the target, skip the no-op call —
// updateWorkspaceFolders returns false when nothing changes.
if (deleteCount === newFolders.length) {
  const managedFolders = managedIndices.map(i => folders[i]);
  const alreadyMatch = newFolders.every((nf, idx) =>
    managedFolders[idx].uri.fsPath === nf.uri.fsPath,
  );
  if (alreadyMatch) { return true; }
}
```

---

## Bug 13: 写入活跃 .code-workspace 文件导致无限重载循环

**现象**: 切换 Spec 时 VSCode 窗口无限重新加载（死循环）。

**原因**: `extension.ts` 激活逻辑和 `switchSpec.ts` 中，`generateWorkspaceFile(spec)` 在 `isInWorkspaceFile()` 检查之前无条件调用。当已经在目标 `.code-workspace` 文件内时，`fs.writeFileSync` 写入当前活跃的 workspace 文件 → VSCode 检测到 workspace 文件被修改 → 触发窗口重新加载 → activation 再次运行 → 再次写入 → 无限循环。

**修复**:
- 将 `generateWorkspaceFile()` 调用移到 `isInWorkspaceFile()` 检查的 `else` 分支中
- 仅在即将打开另一个 `.code-workspace` 文件时才生成文件
- 当已经在正确的 `.code-workspace` 中时，文件内容已是最新的，不需要重新生成

**代码** (`src/extension.ts`):
```typescript
if (isInWorkspaceFile(activeSpecName)) {
  // Already in the correct .code-workspace — sync folders in-place.
  // Do NOT call generateWorkspaceFile here — writing to the active
  // .code-workspace triggers a VSCode reload → infinite loop.
  applyGitIsolationSettings().then(() => {
    switchWorkspaceFolders(spec);
  });
  // ...
} else {
  // Not in the right workspace file — generate and open it (reloads window)
  generateWorkspaceFile(spec);
  openWorkspaceFile(activeSpecName);
}
```

**代码** (`src/commands/switchSpec.ts`):
```typescript
if (isInWorkspaceFile(spec.name)) {
  // Already in this spec's workspace file — update folders in-place (no reload).
  // Do NOT call generateWorkspaceFile here — writing to the active
  // .code-workspace triggers a VSCode reload.
  // ...
} else {
  // Not in a .code-workspace file (or in a different spec's workspace) —
  // generate the target workspace file and open it.
  generateWorkspaceFile(spec);
  await openWorkspaceFile(spec.name);
}
```

---

## Bug 14: 远程分支未 fetch 导致 worktree 创建为新分支

**现象**: 用户输入一个远程已有的分支名（如 `feat/login`），创建 Spec 后 worktree 内的代码是从 HEAD 新建的空分支，而非远程分支的内容。

**原因**: `createWorktree()` 中只检查了本地是否存在该分支（`git rev-parse --verify`），如果本地不存在就直接用 `git worktree add -b` 从当前 HEAD 创建新分支。完全忽略了分支可能存在于 remote 的情况——用户 clone 后未 fetch 所有分支，或队友新推了分支但本地还没有。

**修复**:
- 新增 `remoteBranchExists(repoPath, branch)` 函数，通过 `git branch -r --list "*/<branch>"` 检查远程是否存在该分支
- 新增 `fetchBranch(repoPath, branch)` 函数，先尝试 `git fetch origin "<branch>"`，失败则 fallback 到 `git fetch --all`
- `createWorktree()` 在本地分支不存在时，先调用 `remoteBranchExists()` 检查远程；如存在则 fetch 后创建 tracking worktree

**代码** (`src/gitOps.ts`):
```typescript
export function remoteBranchExists(repoPath: string, branch: string): string | undefined {
  try {
    const output = execSync(`git branch -r --list "*/${branch}"`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (output) {
      return output.split('\n')[0].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// In createWorktree(), when branch doesn't exist locally:
const remoteRef = remoteBranchExists(repoRoot, branch);
if (remoteRef) {
  fetchBranch(repoRoot, branch);
  execSync(`git worktree add --track -b "${branch}" "${worktreePath}" "${remoteRef}"`, {
    cwd: repoRoot, stdio: 'pipe',
  });
} else {
  // Branch doesn't exist anywhere — create new branch based on current HEAD
  execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: repoRoot, stdio: 'pipe' });
}
```

---

## Bug 15: 工作目录锁定在上一个 Spec 的仓库

**现象**: 用户在 VSCode 中打开一个新文件夹（非扩展管理的 `.code-workspace` 文件），扩展仍然将旧 Spec 的 workspace folders 应用到当前窗口，且 repo guard 阻止了用户自己的仓库（关闭非 Spec 管理的 Git 仓库）。

**原因**: `extension.ts` 激活时读取 `workspaceState` 中存储的 `activeSpecName`，无条件执行 `switchWorkspaceFolders(spec)` 和 `refreshGitRepositories()`——即使用户已经离开了管理的 workspace 文件、打开了完全不相关的项目文件夹。`workspaceState` 中的残留值在新窗口中仍可读取（同一 storage key），导致扩展错误地认为当前仍在某个 Spec 的上下文中。

**修复**:
- 新增 `isInManagedWorkspaceFile()` 检查：验证当前打开的文件是否位于扩展管理的 workspaces 目录且为 `.code-workspace` 文件
- 激活时仅在 `isInManagedWorkspaceFile()` 返回 true 时才恢复 Spec 状态（sync folders、refresh Git、launch terminal）
- 当 `activeSpecName` 存在但不在管理的 workspace 文件中时，调用 `setActiveSpecName(undefined)` 清除残留状态，防止 repo guard 误杀用户自己的仓库

**代码** (`src/extension.ts`):
```typescript
const activeSpecName = getActiveSpecName();
if (activeSpecName && isInManagedWorkspaceFile()) {
  // In a managed workspace — restore spec state normally
  const spec = loadSpec(activeSpecName);
  if (spec && spec.status === 'active') {
    applyGitIsolationSettings().then(() => {
      switchWorkspaceFolders(spec);
    });
    setTimeout(async () => {
      await refreshGitRepositories(spec.repos.map(r => r.worktreePath));
      launchAgentTerminal(spec);
      refreshViews();
    }, 2000);
  }
} else if (activeSpecName && !isInManagedWorkspaceFile()) {
  // User opened a different folder/workspace — clear stale active spec
  // from workspaceState so the repo guard doesn't block repos.
  setActiveSpecName(undefined);
}
```

---

## Bug 16: GitHub 扩展疯狂刷新 / 重新打开 spec 时 GitHub 仓库信息丢失

**现象**:
1. 切换 / 打开某个 spec 后，VSCode 内置 Git 扩展和 GitHub 扩展的 Source Control / Pull Request 视图持续闪烁，反复显示 `sim_extension` 等仓库的 git tree。
2. 重新打开 `multi-dev` 管理的 spec 时，GitHub 扩展把仓库信息丢掉，需要手动 "Add Repository" 才能恢复。

**原因**:

A. 仓库 guard 与 Git 扩展打架（开/关循环）

`startRepoGuard()` 监听 `onDidOpenRepository`，凡是不在当前 spec `repos` 列表里的仓库一律 `git.close`。但是 git worktree 目录中的 `.git` 是一个文件（`gitdir: <parent>/.git/worktrees/<name>`），指向原始仓库。Git 扩展在跟随这个指针后会把**原始仓库**也注册进来。原始仓库不在 spec.repos 里 → guard 立即 `git.close` → Git 扩展从 worktree 的 `.git` 指针重新发现原始仓库 → guard 再 `git.close`，无限循环。视觉表现就是 GitHub / Git 扩展的 tree 被反复创建销毁。

B. Git 扩展 API 未就绪窗口期

`vscode.git` 的 `getAPI(1)` 即使返回成功，`api.state` 也可能仍为 `'uninitialized'`，此时 `api.repositories` 为空、`openRepository()` 是 no-op。`extension.ts` 激活路径里只 `setTimeout(2000)` 一刀切，如果 Git 扩展在 2 秒后才 initialize 完成，`refreshGitRepositories()` 会全部踩空，没打开任何仓库；后续 GitHub 扩展跟着 Git API 跑，自然就丢失了仓库信息。

**修复** (`src/gitScm.ts`):

1. 仓库 guard 重新限定作用域 — 只关闭位于 `~/.tmux-agent/worktrees/` 目录下、且不属于当前 spec 的仓库（即"别的 spec 的 worktree"）。父仓库（如 `/home/pp/baidu/adu/sim_extension`）、用户自己的仓库、插件本身仓库一律放过。
2. 增加节流 — 同一路径 5 秒内只允许 close 一次，万一仍出现循环也只是低频抖动，不会再"疯狂刷新"。
3. `getGitAPI()` 增加 initialize 等待 — 通过 `onDidChangeState` 阻塞到 `state === 'initialized'`（5s 超时兜底），避免在 API 未就绪时就调用 `repositories` / `openRepository()`。
4. `refreshGitRepositories()` 用事件驱动等待替代固定 sleep — `onDidOpenRepository` 监听到所有目标 worktree 都被自动发现时立即继续；超时（1.5s）后才对仍缺失的路径手动 `openRepository()` 兜底。
5. 路径比较前统一 `path.resolve()` 归一，避免末尾斜杠 / 相对路径导致误判。
6. `package.json` 声明 `extensionDependencies: ["vscode.git"]` 确保 Git 扩展先完成激活。

**关键代码** (`src/gitScm.ts`):

```typescript
function isUnderWorktreesDir(candidate: string): boolean {
  const c = path.resolve(candidate);
  const root = path.resolve(WORKTREES_DIR);
  if (c === root) { return false; }
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  return c.startsWith(rootSep);
}

repoGuardDisposable = api.onDidOpenRepository(async (repo) => {
  const repoPath = path.resolve(repo.rootUri.fsPath);
  if (!isUnderWorktreesDir(repoPath)) { return; }   // 父仓库 / 用户仓库不动
  const allowed = getActiveSpecWorktreePaths();
  if (allowed.has(repoPath) || allowed.size === 0) { return; }
  if (shouldThrottleClose(repoPath)) { return; }    // 5s 冷却
  await vscode.commands.executeCommand('git.close', repo.rootUri);
});
```

```typescript
async function getGitAPI(): Promise<GitAPI | undefined> {
  // ...
  const api = gitExtension.exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>(resolve => {
      const d = api.onDidChangeState(s => {
        if (s === 'initialized') { d.dispose(); resolve(); }
      });
      setTimeout(() => { d.dispose(); resolve(); }, 5000);
    });
  }
  return api;
}
```

---

## Bug 18: 空窗口创建 Spec 后侧边栏看不到 spec，再次创建报"已经存在"

**现象**: 在空的 VSCode 窗口（未打开任何文件夹）下创建 spec，磁盘上会生成 worktree 目录，但侧边栏（TreeView）看不到该 spec；再次创建同名 spec 时报错 `fatal: '<dir>' 已经存在`。

**原因**:
- `src/gitOps.ts` 的 `createWorktree` 使用**同步阻塞**的 `execSync('git worktree add ...')` 执行 checkout，对巨型仓库（几十 GB）会**冻结整个扩展宿主进程**数分钟，宿主可能在 checkout 中途被杀。
- `src/commands/createSpec.ts` 旧逻辑顺序是「先 createWorktree 循环 → 再 saveSpec + generateWorkspaceFile + refreshViews」。checkout 卡死或宿主被杀后，`saveSpec`/`refreshViews` 从未执行 → spec YAML 从未写入 → 侧边栏为空。
- 磁盘上残留**半 checkout 的孤儿目录**（有文件、但 `.git` 尚未写完、也未注册进 `git worktree list`）。旧代码用同步 `fs.rmSync` 清理（同样会卡死），即便走到 `git worktree add` 也因目录已存在报 `已经存在`。

**修复**:
- `src/gitOps.ts`：新增 `runGitAsync()`（基于 `child_process.spawn`，异步、不阻塞事件循环）；`createWorktree` 改为 `async`，所有 `git worktree add`/`git checkout` 走异步；孤儿目录清理改用 `fs.promises.rm`（异步删除大目录不冻结）。
- `src/commands/createSpec.ts`（关键）：**调整顺序为先 `saveSpec` + `generateWorkspaceFile` + `refreshViews`，再 checkout worktree**，使 spec 立即出现在侧边栏；即使 checkout 中途崩溃，spec 记录已持久化，后续可用 Start 重试；checkout 包裹在 `vscode.window.withProgress` 中逐仓库显示进度。
- `src/commands/startSpec.ts`、`src/commands/addRepo.ts`：适配为 `await createWorktree(...)`。

**代码** (`src/gitOps.ts`):
```typescript
// 异步 git 执行，不阻塞事件循环
function runGitAsync(cwd: string, args: string[], timeoutMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited with ${code}`)));
  });
}

// 孤儿目录异步清理
if (fs.existsSync(worktreePath)) {
  await fs.promises.rm(worktreePath, { recursive: true, force: true });
}
await runGitAsync(repoRoot, ['worktree', 'add', worktreePath, branch]);
```

**代码** (`src/commands/createSpec.ts`):
```typescript
// ✅ 先持久化 spec，再 checkout —— 确保侧边栏立即可见，checkout 崩溃也不丢 spec
saveSpec(spec);
generateWorkspaceFile(spec);
refreshViews();

await vscode.window.withProgress(
  { location: vscode.ProgressLocation.Notification, title: `Creating worktrees for spec "${data.name}"` },
  async progress => {
    for (const repo of repos) {
      progress.report({ message: `${repo.name} (${repo.branch})` });
      await createWorktree(repo.originPath, repo.worktreePath, repo.branch);
    }
  },
);
```

---

## Bug 17: 空窗口切换 / 启动 Spec 无效（窗口无反应）

**现象**: 直接打开一个空的 VSCode 窗口（没有打开任何文件夹或工作区），通过扩展切换 Spec 或启动 Spec 时，窗口毫无反应；必须先随便打开一个文件夹，再切换才能生效。

**原因**: `src/workspaceOps.ts` 的 `openWorkspaceFile()` 调用内置命令 `vscode.openFolder` 时只传了 `{ forceNewWindow: false }`，未传 `forceReuseWindow`。此时 VSCode 退回到 `window.openFoldersInNewWindow` 启发式策略来决定在哪个窗口打开：对于**空窗口**，该启发式常常选择"在新窗口打开"或直接 no-op，导致当前空窗口不动；当窗口已打开了某个文件夹时，启发式才会复用当前窗口，所以"先开文件夹再切换"的路径能正常工作。

**修复**:
- 在 `openWorkspaceFile` 中显式传入 `forceReuseWindow: !forceNewWindow`，强制复用当前窗口打开 workspace 文件
- 该函数同时被 `switchSpec`（切换 spec）和 `startSpec`（启动 spec）复用，两条路径均被修复

**代码** (`src/workspaceOps.ts`):
```typescript
// ❌ 修复前：仅传 forceNewWindow，空窗口下 VSCode 启发式策略可能 no-op
await vscode.commands.executeCommand('vscode.openFolder', wsUri, {
  forceNewWindow,
});

// ✅ 修复后：显式传 forceReuseWindow，强制复用当前窗口
await vscode.commands.executeCommand('vscode.openFolder', wsUri, {
  forceNewWindow,
  forceReuseWindow: !forceNewWindow,
});
```

---

## Bug 19: 空 git 仓库创建 spec 报错 "has no commits yet"

**现象**: 对一个刚 `git init`、还没有任何 commit 的空仓库创建 spec（或 addRepo），报错 `"xxx" has no commits yet. Please make an initial commit first.`，流程被阻断。

**原因**: 空仓库的 HEAD 处于 unborn 状态，`git worktree add` 无法基于 unborn HEAD 创建 worktree。原代码在 `src/commands/createSpec.ts`、`src/commands/addRepo.ts`、`src/gitOps.ts` 三处都用 `hasCommits()` 做前置校验并直接抛错，把手动 commit 的负担丢给用户。

**修复**:
- 在 `src/gitOps.ts` 新增 `ensureInitialCommit(repoPath)`，若仓库无 commit 则自动执行 `git commit --allow-empty -m "Initial commit"`（正是原错误提示要用户手动做的事）
- 仅当仓库未配置 `user.email` 时才注入临时身份 `-c user.name="tmux-agent" -c user.email="tmux-agent@localhost"`，已有配置绝不覆盖
- `createWorktree()` 开头调用 `ensureInitialCommit(repoRoot)` 取代原抛错逻辑
- 移除 `createSpec.ts` / `addRepo.ts` 中的 `hasCommits` 阻断校验及对应 import

**代码** (`src/gitOps.ts`):
```typescript
export function ensureInitialCommit(repoPath: string): void {
  if (hasCommits(repoPath)) { return; }
  let identityArgs = '';
  try {
    const email = execSync('git config user.email', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!email) { throw new Error('no committer identity configured'); }
  } catch {
    identityArgs = '-c user.name="tmux-agent" -c user.email="tmux-agent@localhost"';
  }
  const cmd = `git ${identityArgs} commit --allow-empty -m "Initial commit"`.replace(/\s+/g, ' ').trim();
  execSync(cmd, { cwd: repoPath, stdio: 'pipe' });
}
```

---

## Bug 20: 切换 spec 报 "Starting directory (cwd) ... does not exist"

**现象**: 在一个窗口创建 spec 后，新开 VSCode 窗口切换到该 spec，agent 终端报 `The terminal process failed to launch: Starting directory (cwd) "/home/pp/.tmux-agent/worktrees/<spec>/<repo>" does not exist.`。

**原因**:
1. `createWorktree` 的 already-checked-out fallback 坏了：当目标分支（如 `master`）已在主仓库检出时，旧代码走 `git worktree add --detach <path>`（不带分支）再 `git checkout <branch>`，但第二步同样报 "already checked out" 失败，导致 worktree 目录根本没建成，只留下空壳。切换时 workspace folder 和 agent 终端的 cwd 都指向这个不存在的目录。
2. git 本地化问题：用户 git 输出中文（"已经检出"），而 fallback 判断靠匹配英文 substring `"already checked out"`，中文环境下判断永远 false，直接抛错。
3. `startSpec` 里的 `catch {}` 吞掉了 worktree 创建失败，隐藏了错误。

**修复**:
- `runGitAsync` 注入 `LC_ALL=C` / `LANG=C`，强制 git 用英文 stderr，保证 `"already checked out"` 等 substring 匹配稳定
- `createWorktree` 的 already-checked-out fallback 改为一步 `git worktree add --detach <path> <branch>`（检出到该分支 tip，不再做会失败的 checkout）
- 新增 `ensureSpecWorktrees(spec)`：切换/启动 spec 前检查每个 repo 的 worktree 目录，缺失就重新 `createWorktree`，实现 switch/start 自愈
- `switchSpec` / `startSpec` 改用 `ensureSpecWorktrees`；`startSpec` 移除吞错的 `catch`，失败弹给用户

**代码** (`src/gitOps.ts`):
```typescript
// runGitAsync: force C locale so stderr matching is stable
const child = spawn('git', args, {
  cwd, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
});

// already-checked-out fallback: one-step detached checkout at branch tip
if (msg.includes('already checked out')) {
  await runGitAsync(repoRoot, ['worktree', 'add', '--detach', worktreePath, branch]);
}

export async function ensureSpecWorktrees(spec: Spec): Promise<void> {
  for (const repo of spec.repos) {
    if (fs.existsSync(repo.worktreePath)) { continue; }
    await createWorktree(repo.originPath, repo.worktreePath, repo.branch);
  }
}
```

---

## Bug 21: 切换 spec 后 tmux 视图没有切换

**现象**: 切换到另一个 spec 后，VSCode 里的 Agent 终端视图仍停留在旧 spec 的 tmux session，没有跟着切过去。

**原因**: `launchWithTmux` 用 `tmux switch-client` 在同一个 VSCode 终端里原地把 tmux client 从旧 session 切到新 session。定位"哪个 client 属于当前窗口"时，`switchTmuxClient` 用 `tmux list-clients -t <fromSession> -F '#{client_tty}'` 取第一个 client tty。但 VSCode 的 Terminal API 不暴露其底层 pty 的 tty，无法可靠映射"某个 VSCode 终端 → 某个 tmux client tty"。当同一个 session 有多个 client attach（用户开了多个 VSCode 窗口/外部终端都 attach 到同一个 `ta-*` session）时，取到的往往不是当前窗口的 tty，`switch-client` 作用在了别的 client 上，当前窗口视图纹丝不动。`switchAnyTaClient` fallback 更糟，随便抓一个 `ta-*` client 就切。

**修复**:
- 放弃 `switch-client` 方案（先天不可靠）
- `launchWithTmux` 切到不同 session 时改为 dispose 当前 Agent 终端 + 新建一个 `tmux attach-session -t <目标session>` 的终端，tmux session 本身及其中运行的 agent 不受影响，只是换了个终端 attach 上去，视图必然跟着切
- 删除不再使用的 `switchTmuxClient` / `switchAnyTaClient` 两个函数
- 代价：切换时 Agent 终端会重建（闪一下），换来确定性正确

**代码** (`src/terminalOps.ts`):
```typescript
// Need to show a DIFFERENT session. Do NOT use `tmux switch-client`:
// VSCode's Terminal API doesn't expose its pty tty, so when multiple
// clients share a session we can't tell which one is this window's.
// Dispose + re-attach instead; the tmux session (and its agent) persists.
if (agentTerminal && isTerminalAlive(agentTerminal)) {
  agentTerminal.dispose();
  agentTerminal = undefined;
  currentTmuxSession = undefined;
}
disposeStaleAgentTerminals();
agentTerminal = vscode.window.createTerminal({
  name: 'Agent',
  shellPath: 'tmux',
  shellArgs: ['attach-session', '-t', sessionName],
});
agentTerminal.show();
currentTmuxSession = sessionName;
```

---

## 踩坑总结

### VSCode `updateWorkspaceFolders()` API

1. **不能连续多次调用** — 必须合并为单次原子操作
2. **调用后 workspace 配置文件变 dirty** — 后续 Configuration API 写入会失败
3. **不能删除所有文件夹** — Extension Development Host 的项目文件夹不能被移除
4. **返回 false 不代表异步失败** — 是同步返回的操作结果
5. **返回 true 不代表变更已生效** — 必须监听 `onDidChangeWorkspaceFolders` 事件确认 folder 变更完成后，才能安全调用依赖 workspace folder 的 API
6. **调用后可能触发扩展宿主重启** — 后续代码可能不执行；需要在调用前完成关键状态持久化和 UI 刷新
7. **无变化操作返回 false** — 当新旧文件夹完全相同时，API 返回 `false`；需在调用前检测并短路，避免误判为失败

### VSCode `workspaceState`

1. **per-workspace 作用域** — `workspaceState` 绑定到当前 workspace，通过 `vscode.openFolder` 打开新的 `.code-workspace` 文件后，`workspaceState` 是全新的空状态
2. **需要持久化 fallback** — 关键状态不能只存 `workspaceState`，应同时写入 `.code-workspace` settings 作为兜底，通过 `vscode.workspace.getConfiguration()` 读取

### VSCode Webview

1. **`showOpenDialog` 会让 Webview 失焦** — 发消息前必须 `reveal()`
2. **`retainContextWhenHidden: true` 保留 JS 状态** — 但消息传递可能受影响
3. **`postMessage` 返回 `Thenable<boolean>`** — 建议 `await` 确保送达

### VSCode Git Extension API

1. **`git.close` 命令接受 `Uri` 参数** — 传 repo 对象无效，需传 `repo.rootUri`
2. **Git 扩展可能未激活** — 通过 `extensionDependencies` 声明依赖或在代码中 `await activate()`
3. **`openRepositoryInParentFolders` 不能设为 `"never"`** — Git worktree 的 `.git` 文件指向原始仓库，Git 扩展将其归类为 "parent folder repository"；设为 `"never"` 会彻底阻止 Git 扩展打开 worktree 仓库（包括 `api.openRepository()` 编程调用），必须保持默认值或设为 `"prompt"`/`"always"`
4. **workspace folder 变化不等于 SCM 视图更新** — 必须通过 Git API 显式管理仓库
5. **`onDidOpenRepository`/`onDidCloseRepository` 事件可用于同步等待** — 替代固定延时，实现可靠的仓库就绪检测
6. **`getAPI(1)` 不保证 `state === 'initialized'`** — 即使 `extension.activate()` 完成，API 仍可能处于 `uninitialized` 状态，此时 `repositories` 为空、`openRepository()` 是 no-op；必须额外 `await onDidChangeState` 直到 `'initialized'`
7. **关闭 worktree 父仓库会触发循环** — Git 扩展跟随 worktree 的 `.git` 指针反向发现父仓库；如果 guard 无差别 close 父仓库，会被 Git 扩展立即重新打开，形成 open ↔ close 抖动循环（视觉上是 SCM/GitHub 扩展疯狂刷新）；必须把 guard 作用域限定在自己管理的目录（`WORKTREES_DIR`）下，并对同一路径添加冷却节流

### `.code-workspace` 文件操作

1. **禁止写入当前活跃的 workspace 文件** — `fs.writeFileSync` 修改当前打开的 `.code-workspace` 文件会触发 VSCode 自动重载窗口；如果写入发生在 `activate()` 路径中，会形成 写入 → 重载 → activate → 写入 的无限循环
2. **`generateWorkspaceFile()` 必须在 `isInWorkspaceFile()` 守卫之后** — 仅在即将通过 `openWorkspaceFile()` 打开另一个 workspace 文件时才调用；已在正确 workspace 中时，文件内容已是最新的

### VSCode 扩展激活与状态管理

1. **`workspaceState` 可能跨窗口残留** — 用户打开新文件夹时旧状态可能仍可读取，激活逻辑必须验证当前环境是否匹配存储的状态
2. **激活时必须检查 workspace 类型** — 使用 `isInManagedWorkspaceFile()` 区分"在管理的 workspace 中"和"在普通文件夹中"，避免对非管理环境施加 Spec 逻辑

### Git Worktree

1. **空仓库（无 commits）不能创建 worktree** — 必须前置检查
2. **分支已 checkout 时不能创建同名 worktree** — 需要 detach 降级方案
3. **stale worktree 目录需要先 prune** — `git worktree prune` 清理悬挂引用
4. **用户选择的路径可能不是 repo 根目录** — 用 `git rev-parse --show-toplevel` 解析
5. **本地不存在的分支可能存在于远程** — 创建 worktree 前需 `git branch -r --list` 检查远程分支，存在则 fetch 后创建 tracking worktree，避免从 HEAD 误建空分支
6. **同步 `git worktree add` 会阻塞扩展宿主** — 巨型仓库检出耗时数分钟，`execSync` 会冻结整个 extension host 甚至被系统杀死；应改用基于 `spawn` 的异步封装（`runGitAsync`），孤儿目录清理同样用 `fs.promises.rm` 异步执行；且必须**先持久化 spec（saveSpec + generateWorkspaceFile + refreshViews）再启动 checkout**，避免 checkout 中途崩溃导致 spec 不可见与半成品孤儿目录（残留目录在下次创建时报 `已经存在`）
