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

## AI 状态文件规范

状态文件路径：`~/.tmux-agent/state/<specName>.json`

**Schema**：

```typescript
interface SpecState {
  status: SpecStatus;     // 必填
  message?: string;       // 可选，AI 上报的附加说明
  updatedAt: string;      // ISO 8601 时间戳
}

type SpecStatus = 'working' | 'waiting_confirm' | 'done' | 'idle';
```

**语义**：

| 状态 | 写入时机 |
|------|----------|
| `working` | 扩展启动 agent 时（可选，用于未来扩展） |
| `waiting_confirm` | ducc Notification hook 触发 `report-state.js waiting_confirm <spec>` |
| `done` | ducc Stop hook 触发 `report-state.js done <spec>` |
| `idle` | 初始状态；状态文件缺失、JSON 损坏、未知状态值均回退为 `idle` |

**容错原则**：`readSpecState()` 必须对所有读取失败（ENOENT、JSON parse error、unknown status）静默回退为 `'idle'`，不向上层抛出异常。

## Hook 注入规范

Hook 配置写入 **spec worktree 根目录**（`~/.tmux-agent/worktrees/<spec>/`）的 `.claude/settings.json`，而非全局或 repo 级别。

理由：hook 仅上报当前 managed worktree 的状态，避免污染用户其他项目的 Claude Code 配置。

`hookInstaller.ts` 负责此操作：

```typescript
// 纯函数，生成 hook 配置对象，便于测试
buildHookSettings(specName: string, scriptPath: string): object

// 副作用函数，写入文件系统
installHooks(spec: Spec, scriptPath: string): Promise<void>
```

`scriptPath` 来自 `context.extensionPath`，在 `createSpec.ts` 中传入。

## 纯逻辑与 VSCode 胶水代码分离规范

目的：使核心逻辑可在 `ts-node` 单元测试环境中直接测试，无需 VSCode 扩展宿主。

三条规则：

**1. 懒加载 `vscode` 模块**

需要同时运行于 Node.js 测试环境和 VSCode 宿主的模块，在函数内部懒加载 `vscode`：

```typescript
// notifier.ts
export async function notify(specName: string, prev: SpecStatus, next: SpecStatus) {
  // ... pure logic ...
  const vscode = require('vscode');  // 仅在运行时加载，单元测试不触发此行
  vscode.window.showInformationMessage(...);
}
```

不要在模块顶层 `import * as vscode from 'vscode'`，否则模块在纯 Node 环境下无法 require。

**2. 自包含事件发射器**

不依赖 `vscode` 的模块（如 `stateWatcher.ts`）使用自包含的事件发射器，遵循 `vscode.Event` 调用约定（subscribe 返回 Disposable），但不 import `vscode`：

```typescript
// stateWatcher.ts — 无 vscode import
type Listener = (e: StateChangeEvent) => void;
private listeners: Listener[] = [];
onDidChangeState = (listener: Listener) => {
  this.listeners.push(listener);
  return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
};
```

**3. VSCode 测试桩**

`src/test/vscode-stub.js` 提供 `vscode` 模块的最小化 Node.js 桩，`src/test/mocha-setup.js` 在 Mocha 启动时将其注入 `require.cache`，使需要懒加载 `vscode` 的模块在测试中可以安全 require。

测试运行：`npm test`（Mocha + ts-node + chai）。
