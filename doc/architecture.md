# tmux-agent 架构文档

## 概述

tmux-agent 是一个 VSCode 扩展，用于管理开发任务（Spec）。每个 Spec 关联多个 Git 仓库，通过 git worktree 实现分支隔离开发，并集成 AI CLI 终端（默认 ducc），提供一站式多仓库并行开发体验。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| VSCode Extension API | ^1.85.0 | 扩展宿主 |
| TypeScript | ^5.3.0 | 开发语言 |
| js-yaml | ^4.1.0 | Spec 配置序列化/反序列化 |
| git worktree | — | 分支隔离开发 |

## 项目结构

```
tmux-agent/
├── package.json              # 扩展清单：commands, views, menus
├── tsconfig.json             # TS 编译配置 (target: ES2020, strict)
├── .vscode/
│   ├── launch.json           # F5 调试配置 (extensionHost)
│   └── tasks.json            # compile / watch 任务
├── src/
│   ├── extension.ts          # activate/deactivate 入口
│   ├── types.ts              # Spec, RepoEntry 接口定义
│   ├── config.ts             # 路径常量 + ensureDirs()
│   ├── state.ts              # 全局状态管理 (workspaceState)
│   ├── store.ts              # Spec YAML CRUD (js-yaml)
│   ├── gitOps.ts             # git worktree 操作封装
│   ├── gitScm.ts             # VSCode Git SCM 视图管理 (开/关仓库)
│   ├── workspaceOps.ts       # workspace 文件夹动态管理 + git 隔离
│   ├── terminalOps.ts        # Agent 终端生命周期管理
│   ├── views/
│   │   ├── specTreeProvider.ts  # 侧边栏 TreeView (Current + All)
│   │   └── specWebview.ts       # Webview 表单 (创建 Spec)
│   └── commands/
│       ├── createSpec.ts     # 创建 Spec（含 Webview 表单）
│       ├── startSpec.ts      # 启动 Spec（创建 worktree + 打开）
│       ├── switchSpec.ts     # 切换 Spec（原子替换 workspace 文件夹）
│       ├── addRepo.ts        # 动态添加 Repo（无需重启）
│       ├── commitSpec.ts     # 批量提交所有 worktree
│       ├── cleanupSpec.ts    # 清理 Spec（移除 worktree，可保留配置）
│       └── deleteSpec.ts     # 删除 Spec（完全清理）
├── media/
│   └── icon.svg              # 侧边栏图标
└── doc/
    └── *.md                  # 文档
```

## 数据存储

所有数据存放在 `~/.tmux-agent/` 下：

```
~/.tmux-agent/
├── specs/                    # Spec 配置 YAML
│   ├── user-auth.yaml
│   └── payment.yaml
├── worktrees/                # git worktree 工作目录
│   ├── user-auth/
│   │   ├── backend/          # → feat/user-auth 分支
│   │   └── frontend/         # → feat/user-auth 分支
│   └── payment/
│       └── core-service/
└── workspaces/               # VSCode .code-workspace 文件
    ├── user-auth.code-workspace
    └── payment.code-workspace
```

## 数据流

```
用户操作 (侧边栏/Webview)
    ↓
commands/*.ts (命令处理)
    ↓
┌─────────┬──────────────┬───────────────┬──────────────┬──────────┐
│ store.ts│ gitOps.ts    │workspaceOps.ts│terminalOps.ts│ gitScm.ts│
│(YAML IO)│(git worktree)│(文件夹管理)    │(终端管理)     │(SCM 视图) │
└─────────┴──────────────┴───────────────┴──────────────┴──────────┘
    ↓                                          ↓              ↓
~/.tmux-agent/specs/     VSCode workspace API + Terminal API  Git Extension API
```

## 模块职责

### 核心模块

| 模块 | 职责 |
|------|------|
| `types.ts` | `Spec` 和 `RepoEntry` 接口定义 |
| `config.ts` | 路径常量 (`TMUX_AGENT_HOME`, `SPECS_DIR`, `WORKTREES_DIR`, `WORKSPACES_DIR`) + `ensureDirs()` |
| `state.ts` | 通过 `context.workspaceState` 管理当前活跃 Spec 名称 |
| `store.ts` | Spec 的 YAML 文件 CRUD，含 camelCase ↔ snake_case 转换 |

### 操作模块

| 模块 | 职责 |
|------|------|
| `gitOps.ts` | git worktree 增删、状态查询、提交、分支检测等 |
| `gitScm.ts` | 通过 VSCode Git 扩展 API 管理 SCM 视图中的仓库开关，确保只显示当前 Spec 的仓库 |
| `workspaceOps.ts` | `.code-workspace` 生成、workspace 文件夹动态增删切换、git 隔离设置 |
| `terminalOps.ts` | Agent 终端创建/销毁/生命周期追踪 |

### 视图模块

| 模块 | 职责 |
|------|------|
| `specTreeProvider.ts` | `CurrentSpecTreeProvider` (当前 Spec + Repos) + `AllSpecsTreeProvider` (所有 Specs 列表) |
| `specWebview.ts` | 创建 Spec 的 Webview HTML 表单 |

## Spec 生命周期

```
create → active → [switch between specs] → cleanup/delete
  │                      │                       │
  ├─ 创建 worktrees      ├─ 替换 workspace 文件夹  ├─ 移除 worktrees
  ├─ 保存 YAML           ├─ 更新 active state     ├─ 删除 workspace 文件
  ├─ 生成 .code-workspace├─ 启动新 agent 终端      ├─ 关闭终端
  ├─ 添加到 workspace     │                       └─ (可选) 删除 YAML
  └─ 启动 agent 终端      │
                          │
                     addRepo (动态添加)
                          ├─ 创建新 worktree
                          ├─ 更新 spec + workspace
                          └─ updateWorkspaceFolders()
```

## 侧边栏 UI 结构

```
┌─ CURRENT SPEC ──────────────────┐
│ ● user-auth ← current           │
│   ├ backend   feat/user-auth ✓  │
│   └ frontend  feat/user-auth ✓  │
│                    [+ Add Repo]  │
├─ ALL SPECS ─────────────────────┤
│ ● user-auth ← current     [✕]  │
│ ○ payment              [▸] [✕]  │
│ ○ refactor-api         [▸] [✕]  │
│                   [+] [↻]       │
└──────────────────────────────────┘
```

- `[+]` = createSpec, `[↻]` = refreshSpecs, `[▸]` = startSpec/switchSpec, `[✕]` = deleteSpec
