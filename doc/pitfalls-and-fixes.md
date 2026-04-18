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

## 踩坑总结

### VSCode `updateWorkspaceFolders()` API

1. **不能连续多次调用** — 必须合并为单次原子操作
2. **调用后 workspace 配置文件变 dirty** — 后续 Configuration API 写入会失败
3. **不能删除所有文件夹** — Extension Development Host 的项目文件夹不能被移除
4. **返回 false 不代表异步失败** — 是同步返回的操作结果
5. **返回 true 不代表变更已生效** — 必须监听 `onDidChangeWorkspaceFolders` 事件确认 folder 变更完成后，才能安全调用依赖 workspace folder 的 API

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

### Git Worktree

1. **空仓库（无 commits）不能创建 worktree** — 必须前置检查
2. **分支已 checkout 时不能创建同名 worktree** — 需要 detach 降级方案
3. **stale worktree 目录需要先 prune** — `git worktree prune` 清理悬挂引用
4. **用户选择的路径可能不是 repo 根目录** — 用 `git rev-parse --show-toplevel` 解析
