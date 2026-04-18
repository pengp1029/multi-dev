# tmux-agent 开发规范

## 代码规范

### TypeScript 配置

- **target**: ES2020
- **module**: commonjs
- **strict**: true（启用所有严格类型检查）
- **sourceMap**: true（支持调试）
- **outDir**: `out/`，**rootDir**: `src/`

### 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| TS 接口/类型 | PascalCase | `Spec`, `RepoEntry`, `SpecTreeItem` |
| TS 函数/变量 | camelCase | `createWorktree`, `specName` |
| YAML 字段 | snake_case | `feature_branch`, `origin_path` |
| 命令 ID | 点分法 | `tmuxAgent.createSpec` |
| TreeView contextValue | camelCase | `specActive`, `specInactive` |
| 终端名称 | `Agent: <specName>` | `Agent: user-auth` |

### store.ts 中的命名转换

TypeScript 使用 camelCase，YAML 使用 snake_case，在 `store.ts` 中通过 `specToYaml()` / `yamlToSpec()` 双向转换：

```typescript
// camelCase → snake_case
featureBranch → feature_branch
originPath   → origin_path
worktreePath → worktree_path
agentCommand → agent_command
createdAt    → created_at
```

## 命令注册模式

所有命令遵循统一模式：

```typescript
// src/commands/xxxSpec.ts
export function registerXxxSpecCommand(refreshViews: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('tmuxAgent.xxxSpec', async (item?: SpecTreeItem) => {
    // 1. 获取 specName（从 TreeItem 或用户输入）
    // 2. 加载 spec
    // 3. 执行核心逻辑
    // 4. refreshViews() 刷新侧边栏
    // 5. showInformationMessage 提示用户
  });
}
```

- 每个命令一个文件，导出 `registerXxxCommand` 函数
- 接受 `refreshViews` 回调刷新 TreeView
- 支持从 TreeItem 右键菜单触发（`item?: SpecTreeItem`）
- 在 `extension.ts` 的 `activate()` 中统一注册

## TreeView contextValue 体系

```
specActive    → 当前活跃的 Spec（显示 commit, cleanup 菜单）
specInactive  → 非活跃但已激活的 Spec（显示 switch 按钮）
spec          → 其他状态的 Spec（draft/completed，显示 start 按钮）
repo          → Spec 下的仓库条目
```

菜单匹配使用正则 `viewItem =~ /spec.*/` 实现对所有 spec 状态的通配。

## VSCode workspace.updateWorkspaceFolders 使用规范

**核心原则：每次操作只调用一次 `updateWorkspaceFolders`**

```typescript
// ✅ 正确：单次原子调用
vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...newFolders);

// ❌ 错误：循环多次调用（VSCode 不允许连续调用）
for (const idx of indices) {
  vscode.workspace.updateWorkspaceFolders(idx, 1);  // 第二次会失败！
}
```

## 操作顺序规范

`applyGitIsolationSettings()` 必须在 `updateWorkspaceFolders()` 之前调用：

```typescript
// ✅ 正确顺序
await applyGitIsolationSettings();   // 先写 settings
addSpecFoldersToWorkspace(spec);     // 再改文件夹

// ❌ 错误顺序（workspace 文件变 dirty，settings 写入被拒绝）
addSpecFoldersToWorkspace(spec);     // 先改文件夹 → 文件变 dirty
await applyGitIsolationSettings();   // 写入失败！
```

## Webview 通信规范

```
Webview (HTML/JS)  ←→  Extension (TS)
   postMessage()   →   onDidReceiveMessage
   addEventListener ←   panel.webview.postMessage()
```

发送消息回 Webview 前必须先 `reveal()` 确保面板在前台：

```typescript
this.panel?.reveal();
await this.panel?.webview.postMessage({ type: 'repoPath', ... });
```

## Git 操作安全规范

1. 创建 worktree 前必须检查 `hasCommits()`（空仓库无法创建 worktree）
2. 使用 `getRepoRoot()` 解析真实 git 根目录（用户可能选了子目录）
3. 创建前用 `worktreeExists()` 检查避免重复创建
4. 处理 "already checked out" 错误：先 detach 再 checkout
5. 清理 stale worktree 目录：先 `git worktree prune`，再 `rmSync`
