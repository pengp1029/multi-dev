# 多项目总控台与 AI 状态提醒 — 设计文档

- **日期**: 2026-08-03
- **状态**: 已批准（待用户审阅）
- **作者**: Ducc + pengp1029
- **涉及项目**: tmux-agent（VSCode 扩展）

## 1. 背景与目标

当前 tmux-agent 以扁平的 Spec（feature）为核心，每个 Spec 关联多个 git worktree，切换 Spec 时在同一窗口原子替换 workspace 文件夹。随着并行开发的 feature 增多，暴露出几个痛点：

1. **缺少项目层级**：所有 feature 平铺，无法按产品/大方向组织。
2. **无法一窗纵览**：想看多个 feature 的状态需要开多个 VSCode 窗口。
3. **git 变动分散**：只能靠 VSCode 内置 SCM 看单个 feature，缺少跨 feature 的聚合概览。
4. **AI 无提醒**：ducc 需要人确认或任务完成时，用户不知情，需要主动去看终端。

### 目标

用 **VSCode 插件**（而非独立软件）实现：

- 项目 → feature 两层管理
- 一个总控台窗口纵览所有项目和 feature 及其状态
- 按 feature 聚合的 git 变动概览（不依赖 VSCode 内置 SCM）
- AI 需要确认 / 完成时的多渠道提醒

### 非目标（YAGNI）

- **不支持**在同一编辑器里左右并排编辑两个 feature 的代码（用户已确认接受"一次专注一个 feature"）。总控台负责纵览，进入某个 feature 后专注编辑。
- **不做**独立 Electron 软件——那等于重造 VSCode（编辑器、终端、git、LSP）。
- 首期外部推送**不做**如意/微信专用格式，仅通用 webhook。

## 2. 为什么是插件而非独立软件

| 需求 | 插件能否实现 | 说明 |
|------|------------|------|
| 项目/feature 两层管理 | ✅ | 数据模型 + TreeView/Webview |
| 一窗口纵览所有项目/feature | ✅ | Webview 卡片墙 |
| 点进去专注单 feature（原子切换） | ✅ | 复用现有 `switchWorkspaceFolders` |
| 检索只在当前 worktree | ✅ | 切进 feature 后 workspace 仅含该 worktree，VSCode 搜索天然限定 |
| git 只显示当前 worktree 变动 | ✅ | 概览用卡片聚合 `git status`，细节用切进去后的隔离 SCM |
| AI 等确认/完成提醒 | ✅ | hook 写状态文件 + 系统通知 + 外部推送 |

唯一逼向独立软件的场景是"同一编辑器并排编辑多 feature"，已被列为非目标。**结论：插件是正确选择。**

## 3. 数据模型

引入 **Project 父层**，形成"项目 → feature"两层结构。项目是纯组织层，不持有 worktree；git worktree 仍挂在 feature（spec）下，与现状一致。

### 存储布局

```
~/.tmux-agent/
├── projects/              # 【新增】项目配置
│   ├── user-auth.yaml
│   └── payment.yaml
├── specs/                 # feature(spec) 配置，新增 projectName 字段
│   ├── login-flow.yaml
│   └── oauth-refactor.yaml
├── worktrees/
│   └── <spec>/<repo>/     # 不变
├── workspaces/            # 不变
└── state/                 # 【新增】AI 状态文件，hook 写入
    └── <spec>.json
```

### 类型定义

```typescript
// 新增
interface Project {
  name: string;              // 唯一标识（文件名 slug）
  description?: string;
  features: string[];        // 归属的 spec 名称列表（冗余，便于查询）
  createdAt: string;
}

// state/<spec>.json
type SpecStatus = 'working' | 'waiting_confirm' | 'done' | 'idle';
interface SpecState {
  status: SpecStatus;
  message?: string;          // hook 传入的简短说明
  updatedAt: string;         // ISO 时间戳
}

// Spec 增加字段
interface Spec {
  // ... 现有字段
  projectName?: string;      // 【新增】归属项目；缺省视为 Ungrouped
}
```

### 向后兼容

- 老的没有 `projectName` 的 spec **惰性归入**一个虚拟的 `Ungrouped` 项目，不做数据迁移、不报错。
- `Ungrouped` 是 UI 层的虚拟分组，不落盘为 `projects/Ungrouped.yaml`。

## 4. 架构分层

### 新增模块

| 模块 | 职责 |
|------|------|
| `projectStore.ts` | Project YAML CRUD；聚合 spec 归属；Ungrouped 兼容 |
| `stateWatcher.ts` | `fs.watch` 监听 `state/` 目录，状态变化时分发到 dashboard / notifier / tree |
| `notifier.ts` | 三渠道提醒：系统通知 / 外部 webhook / 总控台徽记；去重 |
| `dashboardWebview.ts` | 总控台卡片墙 Webview（单向数据流） |
| `hookInstaller.ts` | 创建 worktree 时往 spec 根写 `.claude/settings.json` 注册状态上报 hook |
| `scripts/report-state.*` | 扩展自带的 dumb 脚本，被 hook 调用，写 `state/<spec>.json` |

### 改动模块

| 模块 | 改动 |
|------|------|
| `types.ts` | `Spec` 增加 `projectName`；新增 `Project`、`SpecState`、`SpecStatus` |
| `store.ts` | 读写 spec 时处理 `projectName` |
| `config.ts` | 新增 `PROJECTS_DIR`、`STATE_DIR` 路径常量 + ensureDirs |
| `gitOps.ts` | 新增 `getChangeSummary(spec)`：遍历各 worktree 跑 `git status --porcelain` 聚合变动文件数与列表 |
| `commands/createSpec.ts` | 表单增加项目选择/新建；创建 worktree 后调用 hookInstaller |
| `specTreeProvider.ts` | 树支持项目分组；订阅 stateWatcher 刷新徽记 |
| `extension.ts` | 注册 dashboard 命令、启动 stateWatcher |

### 数据流

```
用户操作（总控台 / 侧边栏）
    ↓
commands / dashboardWebview（message 回传）
    ↓
projectStore / store / gitOps / workspaceOps / terminalOps / hookInstaller
    ↓
~/.tmux-agent/{projects,specs,worktrees,state}

ducc 运行（worktree 内）
    ↓ Claude Code hook 触发
scripts/report-state → 写 state/<spec>.json
    ↓ fs.watch
stateWatcher
    ↓ 分发
dashboardWebview(postMessage) / notifier(系统通知+webhook) / specTreeProvider(刷新徽记)
```

## 5. 总控台（Dashboard Webview）

通过命令 `Tmux Agent: Open Dashboard` 或侧边栏顶部按钮打开。

### 布局

```
┌─ TMUX AGENT DASHBOARD ─────────────────────[↻][+项目][+feature]┐
│                                                                 │
│ ▼ user-auth (项目)                                              │
│   ┌────────────────────┐  ┌────────────────────┐               │
│   │ ⚠ login-flow        │  │ ✓ oauth-refactor    │              │
│   │ feat/login-flow     │  │ feat/oauth          │              │
│   │ 2 repos · 5 changed │  │ 3 repos · 0 changed │              │
│   │ ⚠ 等待你确认         │  │ ✓ 已完成 · 2min前    │             │
│   │ [进入][diff][提交]   │  │ [进入][diff][提交]   │             │
│   └────────────────────┘  └────────────────────┘               │
│                                                                 │
│ ▼ payment (项目)                                                │
│   ┌────────────────────┐                                        │
│   │ ● core-service      │                                        │
│   └────────────────────┘                                        │
│                                                                 │
│ ▼ Ungrouped                                                     │
│   ...（无 projectName 的老 spec）                                │
└─────────────────────────────────────────────────────────────────┘

状态徽记：● 工作中(蓝)  ⚠ 等确认(黄)  ✓ 完成(绿)  ○ 空闲(灰)
```

### 卡片信息（只读聚合，无需进 SCM）

- feature 名 + 分支名
- repo 数 + 聚合变动文件数（`gitOps.getChangeSummary` 遍历各 worktree 跑 `git status --porcelain` 求和）
- **AI 状态徽记**：读 `state/<spec>.json`，四态配颜色 + 文案 + 相对时间
- 操作按钮：
  - `进入`：原子切换到该 feature（复用 `switchWorkspaceFolders`）；当前 feature 时为 no-op 并高亮 current
  - `diff`：在卡片下方**内联展开变动文件列表**（文件名 + repo + ±行数），点具体文件用 VSCode 原生 diff 打开该 worktree 里的文件。**不**内联完整 diff 文本
  - `提交`：触发现有 `commitSpec`

### 单向数据流

扩展是 source of truth。Webview 只渲染 `postMessage` 下发的数据；所有操作通过 message 回传给扩展执行命令，扩展执行后再 push 新状态。避免 Webview 与扩展状态漂移。

## 6. AI 状态上报（Hook 注入）

### 作用域

**仅服务于本扩展管理的 worktree**（用户明确要求）。ducc 在某 worktree 内启动时，只加载该目录的项目级 `.claude/settings.json`，不影响用户手动开的全局 ducc 会话。

### 注入内容

创建 worktree 时，`hookInstaller` 往 **spec 根目录** `~/.tmux-agent/worktrees/<spec>/` 写：

```jsonc
// .claude/settings.json
{
  "hooks": {
    "Notification": [{
      "matcher": "*",
      "hooks": [{ "type": "command",
        "command": "<扩展内置脚本> report-state waiting_confirm <spec>" }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{ "type": "command",
        "command": "<扩展内置脚本> report-state done <spec>" }]
    }]
  }
}
```

### 状态语义映射

| Hook | 含义 | 写入状态 |
|------|------|---------|
| `Notification` | ducc 请求输入/确认 | `waiting_confirm` |
| `Stop` | ducc 一轮回复结束 | `done` |
| （可选）`UserPromptSubmit` | ducc 开始处理 | `working` |

- `working` 首期可省略，靠 tmux 活动或省缺推断；`idle` 为默认（无状态文件时）。
- `report-state` 脚本保持 dumb：仅把 `{ status, message, updatedAt }` 写到 `state/<spec>.json`。
- 与现有 auto-commit hook 共存：auto-commit 在真实仓库、本 hook 在 worktree，Claude Code 会合并多层 settings，不冲突。

## 7. 提醒（notifier）

`stateWatcher` 感知状态变化后分发。**仅当状态变为 `waiting_confirm` 或 `done` 时**推送打扰型通知；`working` 只更新卡片。

| 渠道 | 实现 | 触发状态 |
|------|------|---------|
| 总控台徽记 | Webview postMessage，卡片变色 | 所有状态 |
| 系统通知（含声音） | macOS `terminal-notifier` / Linux `notify-send` / Windows PowerShell toast；缺失时回退 `vscode.window.showInformationMessage` | waiting_confirm / done |
| 外部推送 | 用户配置的通用 webhook URL，POST `{ spec, status, message, updatedAt }`；未配置则跳过 | waiting_confirm / done |

- **通知带跳转**：系统通知 / VSCode 弹窗点击 → 原子切换到该 feature。
- **去重**：同一 spec 同一状态在短时间窗口内只推一次。
- **可配置**（`settings.json`）：每渠道开关、webhook URL、是否响铃。
- **外部推送扩展点**：首期通用 webhook；预留后续接入如意/微信专用格式的适配层（当需要交互式回调时启用）。

## 8. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 老 spec 无 `projectName` | 归入虚拟 `Ungrouped`，不报错、不迁移 |
| 删除项目时下面还有 feature | modal 确认：「连同 feature 一起删」或「移到 Ungrouped」 |
| `state/<spec>.json` 损坏/缺失 | 视为 `idle`，灰点，不崩 |
| hook 脚本写状态失败 | 静默失败（不阻塞 ducc），卡片停留旧状态 |
| worktree 被外部删除 | 复用现有 self-heal；卡片标"缺失"并提供重建 |
| 系统通知工具缺失 | 回退 VSCode 内弹窗 |
| webhook POST 失败/超时 | 3s 超时，失败仅记 output channel 日志，不打扰 |
| `git status` 在大仓库慢 | 卡片变动数异步加载 + 缓存，先渲染骨架 |
| Webview / 扩展状态不同步 | 单向数据流，扩展为 source of truth |

## 9. 测试策略

当前项目暂无测试框架 → 引入 **Mocha + VSCode test runner**（ecosystem 标准）。

### 单元测试

- `projectStore` CRUD + Ungrouped 兼容
- `state` 文件解析容错（损坏 / 缺失）
- `notifier` 渠道选择与去重逻辑
- `hookInstaller` 生成的 settings.json 结构正确
- `gitOps.getChangeSummary` 聚合正确

### 集成 / 手动验证清单

- 创建项目 → 建 feature → hook 注入生效 → ducc 触发 → 状态文件写入 → 卡片变色 → 系统通知弹出 → 点击跳转切换
- 老 spec 打开自动归 Ungrouped
- diff 列表点击打开正确 worktree 的文件
- 删除项目的两种选择路径

每次改完跑 `npm run compile` + `npm run lint`。

## 10. 分阶段落地

1. **数据层**：Project 模型 + `projectStore` + 老 spec 兼容（不动 UI）
2. **总控台 Webview**：卡片墙 + 项目分组 + 进入/diff/提交（读现有数据）
3. **状态上报**：`hookInstaller` + `report-state` 脚本 + `stateWatcher` + 卡片徽记
4. **提醒**：`notifier` 三渠道 + 跳转 + 去重
5. **QuickPick 快速切换器**（锦上添花，键盘流跳转）

## 11. 涉及文档更新（实现后）

- `doc/architecture.md`：项目结构树 + 新模块职责 + 数据流图
- `doc/features.md`：总控台、项目管理、状态提醒功能
- `doc/design.md`：两层模型、总控台交互流程
- `doc/conventions.md`：状态文件格式、hook 注入约定
- `doc/pitfalls-and-fixes.md`：实现中遇到的坑（若有）
