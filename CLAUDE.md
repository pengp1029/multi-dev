# tmux-agent 项目规则

## 任务分类与文档维护

每次用户提出需求后，在完成代码修改的同时，必须执行以下文档维护流程：

### 1. 分类判断

根据用户描述和实际改动，将任务分为以下类型：

| 类型 | 判断标准 | 示例 |
|------|----------|------|
| **bugfix** | 现有功能不符合预期、报错、行为异常 | "切换 spec 后 Git 视图没更新"、"创建 worktree 失败" |
| **feature** | 新增功能、新增命令、新增 UI 元素 | "添加批量提交功能"、"新增 Webview 表单" |
| **refactor** | 不改变外部行为，优化内部结构 | "拆分大函数"、"统一错误处理" |

### 2. 文档更新映射

根据分类和改动范围，更新对应文档：

| 条件 | 需更新的文档 | 更新内容 |
|------|-------------|----------|
| 类型 = bugfix | `doc/pitfalls-and-fixes.md` | 追加 Bug 条目（报错、原因、修复、代码） |
| 类型 = feature | `doc/features.md` | 追加或更新功能描述 |
| 新增/删除/重命名了 `src/` 下的文件 | `doc/architecture.md` | 更新项目结构树 + 模块职责表 |
| 改变了模块间调用关系或数据流 | `doc/architecture.md` | 更新数据流图 |
| 新增了开发约定或 API 使用模式 | `doc/conventions.md` | 追加规范条目 |
| 改变了用户可感知的流程 | `doc/design.md` | 更新使用流程 |

### 3. 执行方式

主任务完成后，spawn 一个 **background sub-agent** 执行文档更新：

- agent 提示词中须包含：任务分类、改动摘要、涉及文件列表、需更新的文档清单
- agent 负责读取现有文档 → 追加/修改对应章节 → 保持文档风格一致
- 不阻塞主任务的用户反馈

### 4. pitfalls-and-fixes.md 条目格式

```markdown
## Bug N: 简短标题

**现象**: 用户看到的问题

**原因**: 根因分析

**修复**:
- 改动要点（用列表）

**代码** (`涉及文件`):
\```typescript
关键代码片段
\```

---
```

## 自动提交决策规则

每次 Stop hook 注入 `<auto-commit-check>` 提示时，必须执行以下决策流程：

### 1. 是否需要提交

| 情况 | 决策 |
|------|------|
| 有实质性代码/配置变更 | 需要提交 |
| 仅读取/分析/回答问题，无文件修改 | 不提交 |
| 变更仅为临时调试代码（console.log 等） | 不提交，提醒用户 |

### 2. Amend 还是新提交

| 条件 | 操作 |
|------|------|
| 本轮改动是对**上一次我创建的提交**的补充/修正（修 lint、补漏改、文档补全） | `git commit --amend` |
| 本轮是**独立的新任务**（新功能、新 bugfix、新 refactor） | 新提交 |
| 上一次提交**不是我创建的**（用户手动提交、其他工具提交） | 新提交 |
| 上一次提交**已推送到远端** | 新提交（禁止 amend 已发布的提交） |

### 3. 提交消息规范

- 格式：`<type>: <简短描述>`
- type 取值：`feat` / `fix` / `refactor` / `docs` / `chore`
- 提交时使用 `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

### 4. 执行步骤

1. 运行 `git status` 和 `git diff` 确认变更内容
2. 运行 `git log -1` 查看上一次提交
3. 检查上一次提交是否已推送：`git log --oneline origin/<branch>..HEAD`
4. 根据规则决策 amend/新提交
5. 执行 `git add` + `git commit`
6. 运行 `git status` 验证提交成功

## 代码规范

- 所有 md 文档保存在 `doc/` 目录下
- 遵循 `doc/conventions.md` 中的命名和模式约定
- 修改代码前先读取目标文件，理解上下文

## 构建 .vsix

```bash
# 编译 TypeScript
npm run compile

# 打包为 .vsix（需要全局安装 vsce: npm i -g @vscode/vsce）
vsce package
```

生成的 `.vsix` 文件在项目根目录，可通过 `code --install-extension tmux-agent-*.vsix` 安装。
