# 多项目总控台与 AI 状态提醒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 tmux-agent VSCode 扩展加上「项目 → feature 两层管理 + 总控台卡片墙 + AI 状态提醒 + 只读 Peek 审阅面板」，让用户一窗纵览所有 feature、被动收到 AI 需确认/完成的提醒，并能不切窗口就审代码/回确认。

**Architecture:** 在现有扁平 spec 之上引入纯组织层 `Project`（YAML），feature 通过 `spec.projectName` 归属；AI 通过 worktree 内注入的 Claude Code hook 写状态文件到 `~/.tmux-agent/state/<spec>.json`，扩展用 `fs.watch` 感知后分发到总控台 Webview（单向数据流）、系统通知与外部 webhook。切换沿用现有 `switchWorkspaceFolders` 原子替换。**关键约束**：新模块尽量不 import `vscode`，把纯逻辑（store / 状态解析 / diff 聚合 / 设置生成 / 去重）与 vscode 胶水分离，使其可用纯 Mocha 单测。

**Tech Stack:** TypeScript 5.3 + VSCode Extension API 1.85 + js-yaml + git CLI + tmux CLI；测试用 Mocha + ts-node（纯逻辑单测，不启动 electron）。

---

## File Structure

新增文件（尽量不依赖 `vscode`，标注 `[pure]` 者可单测）：

- `src/projectStore.ts` `[pure]` — Project YAML CRUD + 归组（含 Ungrouped）
- `src/specState.ts` `[pure]` — 读写 `state/<spec>.json`，容错解析
- `src/notifier.ts` — 三渠道提醒；纯逻辑 `shouldNotify` 可单测，系统通知/弹窗部分依赖 vscode/child_process
- `src/stateWatcher.ts` — `fs.watch(STATE_DIR)`，防抖后触发事件（依赖 vscode EventEmitter）
- `src/hookInstaller.ts` `[pure]` — 生成并写入 worktree 内 `.claude/settings.json`
- `scripts/report-state.js` — 扩展自带 dumb 脚本，被 hook 调用写状态文件
- `src/views/dashboardWebview.ts` — 总控台卡片墙 Webview + Peek 面板
- `src/test/*.test.ts` — 单元测试

改动文件：

- `src/types.ts` — `Spec` 加 `projectName?`；新增 `Project`、`SpecState`、`SpecStatus`
- `src/config.ts` — 加 `PROJECTS_DIR`、`STATE_DIR` + ensureDirs
- `src/store.ts` — 读写 spec 时处理 `projectName`
- `src/gitOps.ts` — 加 `getChangeSummary(spec)`
- `src/commands/createSpec.ts` — 创建后调用 `hookInstaller`
- `src/views/specWebview.ts` — 表单加项目选择/新建
- `src/views/specTreeProvider.ts` — 项目分组 + 状态徽记
- `src/extension.ts` — 注册 dashboard 命令、启动 stateWatcher
- `package.json` — 加命令/菜单/脚本/devDeps

---

### Task 0: 搭建单元测试基础设施

**Files:**
- Modify: `package.json`（scripts + devDependencies）
- Create: `.mocharc.json`
- Create: `src/test/sanity.test.ts`

- [ ] **Step 1: 安装测试依赖**

Run:
```bash
npm install -D mocha @types/mocha ts-node chai @types/chai eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```
Expected: 依赖写入 `package.json` 的 devDependencies，`node_modules/.bin/mocha` 存在。

- [ ] **Step 2: 添加 `.mocharc.json`**

Create `.mocharc.json`（用 ts-node 直接跑 TS 测试，不编译、不启动 electron）：
```json
{
  "extension": ["ts"],
  "spec": "src/test/**/*.test.ts",
  "require": "ts-node/register",
  "timeout": 10000
}
```

- [ ] **Step 3: 在 package.json 增加 test 脚本**

把 `scripts` 改为（保留现有键，新增 `test`）：
```json
"scripts": {
  "vscode:prepublish": "npm run compile",
  "compile": "tsc -p ./",
  "watch": "tsc -watch -p ./",
  "lint": "eslint src --ext ts",
  "test": "mocha"
}
```

- [ ] **Step 4: 写冒烟测试** `src/test/sanity.test.ts`

```typescript
import { expect } from 'chai';

describe('sanity', () => {
  it('runs mocha + ts-node', () => {
    expect(1 + 1).to.equal(2);
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS，输出 `1 passing`。

- [ ] **Step 6: 排除测试目录不进扩展产物**

在 `tsconfig.json` 的 `exclude` 数组加 `"src/test"`（避免测试被编进 `out/`）。改后：
```json
"exclude": ["node_modules", ".vscode-test", "src/test"]
```
Run: `npm run compile`
Expected: 编译成功，`out/` 下无 test 文件。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .mocharc.json tsconfig.json src/test/sanity.test.ts
git commit -m "chore: set up mocha + ts-node unit test infra"
```

---

### Task 1: 类型定义与路径常量

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `src/test/config.test.ts`

- [ ] **Step 1: 扩展 `src/types.ts`**

在文件末尾追加新类型，并给 `Spec` 加可选 `projectName`。改后完整内容：
```typescript
export interface RepoEntry {
  name: string;
  originPath: string;
  worktreePath: string;
  branch: string;
}

export interface Spec {
  name: string;
  description: string;
  featureBranch: string;
  status: 'draft' | 'active' | 'completed';
  agentCommand: string;
  repos: RepoEntry[];
  createdAt: string;
  projectName?: string;      // 归属项目；缺省视为 Ungrouped
}

export interface Project {
  name: string;              // 唯一标识（文件名 slug）
  description?: string;
  features: string[];        // 归属的 spec 名称列表（冗余，便于查询）
  createdAt: string;
}

export type SpecStatus = 'working' | 'waiting_confirm' | 'done' | 'idle';

export interface SpecState {
  status: SpecStatus;
  message?: string;          // hook 传入的简短说明
  updatedAt: string;         // ISO 时间戳
}

export const UNGROUPED_PROJECT = 'Ungrouped';
```

- [ ] **Step 2: 扩展 `src/config.ts`**

加 `PROJECTS_DIR`、`STATE_DIR` 并纳入 ensureDirs。改后完整内容：
```typescript
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export const TMUX_AGENT_HOME = path.join(os.homedir(), '.tmux-agent');
export const SPECS_DIR = path.join(TMUX_AGENT_HOME, 'specs');
export const WORKTREES_DIR = path.join(TMUX_AGENT_HOME, 'worktrees');
export const WORKSPACES_DIR = path.join(TMUX_AGENT_HOME, 'workspaces');
export const PROJECTS_DIR = path.join(TMUX_AGENT_HOME, 'projects');
export const STATE_DIR = path.join(TMUX_AGENT_HOME, 'state');

export function ensureDirs(): void {
  for (const dir of [TMUX_AGENT_HOME, SPECS_DIR, WORKTREES_DIR, WORKSPACES_DIR, PROJECTS_DIR, STATE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
```

- [ ] **Step 3: 写测试** `src/test/config.test.ts`

```typescript
import { expect } from 'chai';
import * as fs from 'fs';
import { PROJECTS_DIR, STATE_DIR, ensureDirs } from '../config';

describe('config', () => {
  it('exposes projects and state dirs under ~/.tmux-agent', () => {
    expect(PROJECTS_DIR.endsWith('/.tmux-agent/projects')).to.equal(true);
    expect(STATE_DIR.endsWith('/.tmux-agent/state')).to.equal(true);
  });

  it('ensureDirs creates projects and state dirs', () => {
    ensureDirs();
    expect(fs.existsSync(PROJECTS_DIR)).to.equal(true);
    expect(fs.existsSync(STATE_DIR)).to.equal(true);
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（config 2 个用例 + sanity）。

- [ ] **Step 5: 编译验证**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts src/test/config.test.ts
git commit -m "feat: add Project/SpecState types and projects/state dirs"
```

---

### Task 2: store.ts 读写 projectName

**Files:**
- Modify: `src/store.ts:50-84`（`specToYaml` / `yamlToSpec`）
- Test: `src/test/store.test.ts`

- [ ] **Step 1: 写失败测试** `src/test/store.test.ts`

```typescript
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR } from '../config';
import { saveSpec, loadSpec, deleteSpec } from '../store';
import { Spec } from '../types';

function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    name: 'test-spec-store',
    description: 'd',
    featureBranch: 'feat/x',
    status: 'active',
    agentCommand: 'ducc',
    repos: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('store projectName', () => {
  afterEach(() => {
    const f = path.join(SPECS_DIR, 'test-spec-store.yaml');
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('persists and reloads projectName', () => {
    saveSpec(makeSpec({ projectName: 'user-auth' }));
    const loaded = loadSpec('test-spec-store');
    expect(loaded?.projectName).to.equal('user-auth');
  });

  it('loads legacy spec without projectName as undefined', () => {
    const f = path.join(SPECS_DIR, 'test-spec-store.yaml');
    fs.writeFileSync(f, 'name: test-spec-store\nfeature_branch: feat/x\nstatus: active\n', 'utf-8');
    const loaded = loadSpec('test-spec-store');
    expect(loaded?.projectName).to.equal(undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `persists and reloads projectName` 断言 `undefined !== 'user-auth'`（当前 store 未处理该字段）。

- [ ] **Step 3: 实现**

在 `src/store.ts` 的 `specToYaml` 里，`created_at` 之后加一行：
```typescript
    created_at: spec.createdAt,
    project_name: spec.projectName,
```
在 `yamlToSpec` 的 return 对象里，`createdAt` 之后加一行：
```typescript
    createdAt: (raw['created_at'] as string) || new Date().toISOString(),
    projectName: (raw['project_name'] as string) || undefined,
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（store 2 用例通过）。

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/test/store.test.ts
git commit -m "feat: persist spec projectName in store"
```

---

### Task 3: projectStore.ts — Project CRUD + 归组

**Files:**
- Create: `src/projectStore.ts`
- Test: `src/test/projectStore.test.ts`

**说明**：`groupSpecsByProject` 是纯函数（输入 specs + projects，输出分组），不碰 fs，便于测试。CRUD 部分读写 `PROJECTS_DIR` 下 YAML。

- [ ] **Step 1: 写失败测试** `src/test/projectStore.test.ts`

```typescript
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '../config';
import { saveProject, loadProject, listProjects, deleteProject, groupSpecsByProject } from '../projectStore';
import { Spec, Project, UNGROUPED_PROJECT } from '../types';

function spec(name: string, projectName?: string): Spec {
  return { name, description: '', featureBranch: 'feat/x', status: 'active', agentCommand: 'ducc', repos: [], createdAt: '', projectName };
}

describe('projectStore', () => {
  afterEach(() => {
    for (const n of ['proj-a', 'proj-b']) {
      const f = path.join(PROJECTS_DIR, `${n}.yaml`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); }
    }
  });

  it('saves and loads a project', () => {
    const p: Project = { name: 'proj-a', description: 'A', features: [], createdAt: new Date().toISOString() };
    saveProject(p);
    expect(loadProject('proj-a')?.description).to.equal('A');
    expect(listProjects().some(x => x.name === 'proj-a')).to.equal(true);
  });

  it('deleteProject removes the file', () => {
    saveProject({ name: 'proj-b', features: [], createdAt: '' });
    deleteProject('proj-b');
    expect(loadProject('proj-b')).to.equal(undefined);
  });

  it('groups specs by projectName, unknown/absent → Ungrouped', () => {
    const projects: Project[] = [{ name: 'proj-a', features: [], createdAt: '' }];
    const specs = [spec('s1', 'proj-a'), spec('s2'), spec('s3', 'ghost-project')];
    const groups = groupSpecsByProject(specs, projects);
    const a = groups.find(g => g.project.name === 'proj-a');
    const ung = groups.find(g => g.project.name === UNGROUPED_PROJECT);
    expect(a?.specs.map(s => s.name)).to.deep.equal(['s1']);
    expect(ung?.specs.map(s => s.name).sort()).to.deep.equal(['s2', 's3']);
  });

  it('omits Ungrouped group when all specs are grouped', () => {
    const projects: Project[] = [{ name: 'proj-a', features: [], createdAt: '' }];
    const groups = groupSpecsByProject([spec('s1', 'proj-a')], projects);
    expect(groups.some(g => g.project.name === UNGROUPED_PROJECT)).to.equal(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../projectStore'`。

- [ ] **Step 3: 实现** `src/projectStore.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Project, Spec, UNGROUPED_PROJECT } from './types';
import { PROJECTS_DIR, ensureDirs } from './config';

export interface ProjectGroup {
  project: Project;
  specs: Spec[];
}

function projectToYaml(p: Project): Record<string, unknown> {
  return { name: p.name, description: p.description, features: p.features, created_at: p.createdAt };
}

function yamlToProject(raw: Record<string, unknown>): Project {
  return {
    name: raw['name'] as string,
    description: (raw['description'] as string) || undefined,
    features: (raw['features'] as string[]) || [],
    createdAt: (raw['created_at'] as string) || new Date().toISOString(),
  };
}

export function saveProject(p: Project): void {
  ensureDirs();
  const filePath = path.join(PROJECTS_DIR, `${p.name}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(projectToYaml(p), { lineWidth: -1 }), 'utf-8');
}

export function loadProject(name: string): Project | undefined {
  ensureDirs();
  const filePath = path.join(PROJECTS_DIR, `${name}.yaml`);
  if (!fs.existsSync(filePath)) { return undefined; }
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return yamlToProject(raw);
}

export function listProjects(): Project[] {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_DIR)) { return []; }
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.yaml'))
    .map(f => loadProject(path.basename(f, '.yaml')))
    .filter((p): p is Project => !!p);
}

export function deleteProject(name: string): void {
  const filePath = path.join(PROJECTS_DIR, `${name}.yaml`);
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
}

/**
 * Group specs under their projects. Specs whose projectName is absent or points
 * to a non-existent project fall into a virtual Ungrouped group (not persisted).
 * The Ungrouped group is only present when it has at least one spec.
 */
export function groupSpecsByProject(specs: Spec[], projects: Project[]): ProjectGroup[] {
  const byName = new Map<string, ProjectGroup>();
  for (const p of projects) {
    byName.set(p.name, { project: p, specs: [] });
  }
  const ungrouped: Spec[] = [];
  for (const s of specs) {
    const g = s.projectName ? byName.get(s.projectName) : undefined;
    if (g) { g.specs.push(s); } else { ungrouped.push(s); }
  }
  const groups: ProjectGroup[] = [...byName.values()];
  if (ungrouped.length > 0) {
    groups.push({
      project: { name: UNGROUPED_PROJECT, features: [], createdAt: '' },
      specs: ungrouped,
    });
  }
  return groups;
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（projectStore 4 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/projectStore.ts src/test/projectStore.test.ts
git commit -m "feat: add projectStore with CRUD and spec grouping"
```

---

### Task 4: specState.ts — 状态文件读写与容错

**Files:**
- Create: `src/specState.ts`
- Test: `src/test/specState.test.ts`

- [ ] **Step 1: 写失败测试** `src/test/specState.test.ts`

```typescript
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR } from '../config';
import { readSpecState, writeSpecState, stateFilePath } from '../specState';

describe('specState', () => {
  const name = 'test-state-spec';
  afterEach(() => {
    const f = stateFilePath(name);
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('missing file → idle', () => {
    expect(readSpecState(name).status).to.equal('idle');
  });

  it('writes then reads back status/message', () => {
    writeSpecState(name, 'waiting_confirm', 'need input');
    const s = readSpecState(name);
    expect(s.status).to.equal('waiting_confirm');
    expect(s.message).to.equal('need input');
    expect(typeof s.updatedAt).to.equal('string');
  });

  it('corrupt json → idle', () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFilePath(name), '{not json', 'utf-8');
    expect(readSpecState(name).status).to.equal('idle');
  });

  it('unknown status value → idle', () => {
    fs.writeFileSync(stateFilePath(name), JSON.stringify({ status: 'bogus', updatedAt: 'x' }), 'utf-8');
    expect(readSpecState(name).status).to.equal('idle');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../specState'`。

- [ ] **Step 3: 实现** `src/specState.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR, ensureDirs } from './config';
import { SpecState, SpecStatus } from './types';

const VALID: SpecStatus[] = ['working', 'waiting_confirm', 'done', 'idle'];

export function stateFilePath(specName: string): string {
  return path.join(STATE_DIR, `${specName}.json`);
}

/** Read a spec's AI state. Missing/corrupt/unknown → idle (never throws). */
export function readSpecState(specName: string): SpecState {
  const idle: SpecState = { status: 'idle', updatedAt: '' };
  const f = stateFilePath(specName);
  if (!fs.existsSync(f)) { return idle; }
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
    const status = raw['status'] as SpecStatus;
    if (!VALID.includes(status)) { return idle; }
    return {
      status,
      message: typeof raw['message'] === 'string' ? (raw['message'] as string) : undefined,
      updatedAt: typeof raw['updatedAt'] === 'string' ? (raw['updatedAt'] as string) : '',
    };
  } catch {
    return idle;
  }
}

/** Write a spec's AI state (dumb — used by the report-state script's TS twin and tests). */
export function writeSpecState(specName: string, status: SpecStatus, message?: string): void {
  ensureDirs();
  const state: SpecState = { status, message, updatedAt: new Date().toISOString() };
  fs.writeFileSync(stateFilePath(specName), JSON.stringify(state), 'utf-8');
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（specState 4 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/specState.ts src/test/specState.test.ts
git commit -m "feat: add specState read/write with fault tolerance"
```

---

### Task 5: gitOps.getChangeSummary — 聚合变动

**Files:**
- Modify: `src/gitOps.ts`（末尾追加）
- Test: `src/test/gitChangeSummary.test.ts`

**说明**：复用现有 `getWorktreeStatus`，新增按 spec 聚合的 `getChangeSummary`：返回总变动文件数 + 每个 repo 的变动文件列表（含状态码）。`--porcelain` 每行前 2 字符是状态码，其后是路径。

- [ ] **Step 1: 写失败测试** `src/test/gitChangeSummary.test.ts`

用临时 git 仓库造真实变动（不 mock git，保证解析正确）：
```typescript
import { expect } from 'chai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getChangeSummary } from '../gitOps';
import { Spec } from '../types';

describe('getChangeSummary', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-gcs-'));
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email t@t && git config user.name t', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hi');
    execSync('git add -A && git commit -q -m init', { cwd: tmp });
    // introduce changes: modify a.txt, add untracked b.txt
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'new');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function specWith(worktree: string): Spec {
    return { name: 'x', description: '', featureBranch: 'f', status: 'active', agentCommand: 'ducc',
      repos: [{ name: 'r1', originPath: worktree, worktreePath: worktree, branch: 'f' }], createdAt: '' };
  }

  it('aggregates changed file count across repos', () => {
    const sum = getChangeSummary(specWith(tmp));
    expect(sum.totalChanged).to.equal(2);
    expect(sum.repos[0].name).to.equal('r1');
    expect(sum.repos[0].files.map(f => f.path).sort()).to.deep.equal(['a.txt', 'b.txt']);
  });

  it('missing worktree contributes zero, no throw', () => {
    const sum = getChangeSummary(specWith(path.join(tmp, 'ghost')));
    expect(sum.totalChanged).to.equal(0);
    expect(sum.repos[0].files).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `getChangeSummary is not a function`。

- [ ] **Step 3: 实现** — 在 `src/gitOps.ts` 末尾追加

```typescript
export interface ChangedFile {
  path: string;
  code: string;   // 2-char porcelain status, e.g. " M", "??", "A "
}
export interface RepoChanges {
  name: string;
  worktreePath: string;
  files: ChangedFile[];
}
export interface ChangeSummary {
  totalChanged: number;
  repos: RepoChanges[];
}

/**
 * Aggregate uncommitted changes across all worktrees of a spec.
 * Runs `git status --porcelain` per repo; missing/failed repos contribute
 * an empty file list (never throws). Used by the dashboard card + Peek panel.
 */
export function getChangeSummary(spec: Spec): ChangeSummary {
  const repos: RepoChanges[] = [];
  let total = 0;
  for (const repo of spec.repos) {
    const files: ChangedFile[] = [];
    if (fs.existsSync(repo.worktreePath)) {
      try {
        const out = execSync('git status --porcelain', {
          cwd: repo.worktreePath, encoding: 'utf-8', timeout: 5000,
        });
        for (const line of out.split('\n')) {
          if (line.length < 4) { continue; }
          files.push({ code: line.slice(0, 2), path: line.slice(3).trim() });
        }
      } catch { /* leave files empty */ }
    }
    total += files.length;
    repos.push({ name: repo.name, worktreePath: repo.worktreePath, files });
  }
  return { totalChanged: total, repos };
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（getChangeSummary 2 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/gitOps.ts src/test/gitChangeSummary.test.ts
git commit -m "feat: add getChangeSummary to aggregate spec worktree changes"
```

---

### Task 6: hookInstaller.ts + report-state 脚本

**Files:**
- Create: `src/hookInstaller.ts`
- Create: `scripts/report-state.js`
- Test: `src/test/hookInstaller.test.ts`

**说明**：`buildHookSettings(specName, scriptPath)` 是纯函数生成 settings 对象，`installHooks(spec)` 写到 spec worktree 根的 `.claude/settings.json`。脚本 `scripts/report-state.js` 是无依赖 Node 脚本，`report-state <status> <spec>` → 写 `~/.tmux-agent/state/<spec>.json`。

- [ ] **Step 1: 写失败测试** `src/test/hookInstaller.test.ts`

```typescript
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildHookSettings, installHooks } from '../hookInstaller';
import { WORKTREES_DIR } from '../config';
import { Spec } from '../types';

describe('hookInstaller', () => {
  it('buildHookSettings registers Notification→waiting_confirm and Stop→done', () => {
    const s = buildHookSettings('login-flow', '/ext/scripts/report-state.js');
    const notif = s.hooks.Notification[0].hooks[0].command;
    const stop = s.hooks.Stop[0].hooks[0].command;
    expect(notif).to.contain('report-state.js');
    expect(notif).to.contain('waiting_confirm');
    expect(notif).to.contain('login-flow');
    expect(stop).to.contain('done');
    expect(stop).to.contain('login-flow');
  });

  it('installHooks writes .claude/settings.json under spec worktree root', () => {
    const name = 'test-hook-spec';
    const spec: Spec = { name, description: '', featureBranch: 'f', status: 'active', agentCommand: 'ducc', repos: [], createdAt: '' };
    const root = path.join(WORKTREES_DIR, name);
    fs.mkdirSync(root, { recursive: true });
    try {
      installHooks(spec, '/ext/scripts/report-state.js');
      const settingsPath = path.join(root, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).to.equal(true);
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(parsed.hooks.Stop[0].hooks[0].command).to.contain('done');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../hookInstaller'`。

- [ ] **Step 3: 实现** `src/hookInstaller.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { Spec } from './types';
import { getSpecWorktreeRoot } from './workspaceOps';

interface HookEntry { type: 'command'; command: string; }
interface HookMatcher { matcher: string; hooks: HookEntry[]; }
export interface HookSettings {
  hooks: { Notification: HookMatcher[]; Stop: HookMatcher[]; };
}

/** Pure: build the Claude Code settings object that reports AI state. */
export function buildHookSettings(specName: string, scriptPath: string): HookSettings {
  const cmd = (status: string) => `node "${scriptPath}" ${status} "${specName}"`;
  return {
    hooks: {
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('waiting_confirm') }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('done') }] }],
    },
  };
}

/**
 * Write .claude/settings.json into the spec's worktree root so ducc, when
 * started in that directory, reports its state only for this managed worktree.
 * Best-effort: failure must never block spec creation.
 */
export function installHooks(spec: Spec, scriptPath: string): void {
  const root = getSpecWorktreeRoot(spec.name);
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = buildHookSettings(spec.name, scriptPath);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}
```

- [ ] **Step 4: 实现脚本** `scripts/report-state.js`

```javascript
#!/usr/bin/env node
// Dumb state reporter invoked by Claude Code hooks inside a managed worktree.
// Usage: node report-state.js <status> <specName>
// Writes ~/.tmux-agent/state/<specName>.json = { status, updatedAt }.
const fs = require('fs');
const os = require('os');
const path = require('path');

const [, , status, specName] = process.argv;
if (!status || !specName) { process.exit(0); } // dumb: never fail the hook

const stateDir = path.join(os.homedir(), '.tmux-agent', 'state');
try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${specName}.json`),
    JSON.stringify({ status, updatedAt: new Date().toISOString() }),
    'utf-8',
  );
} catch {
  // best effort — a failed state write must not disrupt the agent
}
```

- [ ] **Step 5: 让脚本随扩展打包** — 确认 `.vscodeignore` 不排除 `scripts/`

Run: `test -f .vscodeignore && cat .vscodeignore || echo "no .vscodeignore"`
若存在且包含排除 `scripts` 的行则删除该行；不存在则无需处理（vsce 默认打包非忽略文件）。

- [ ] **Step 6: 运行测试**

Run: `npm test`
Expected: PASS（hookInstaller 2 用例）。

- [ ] **Step 7: Commit**

```bash
git add src/hookInstaller.ts scripts/report-state.js src/test/hookInstaller.test.ts
git commit -m "feat: add hookInstaller and report-state script for AI status"
```

---

### Task 7: notifier.ts — 去重逻辑（纯）+ 三渠道分发

**Files:**
- Create: `src/notifier.ts`
- Test: `src/test/notifier.test.ts`

**说明**：把可测的纯逻辑 `shouldNotify(prev, next)` 独立出来——仅当新状态是 `waiting_confirm` 或 `done`、且与上次已通知的状态不同才提醒（去重）。副作用部分（系统通知、webhook、vscode 弹窗）放在 `notify()`，测试只覆盖纯逻辑。

- [ ] **Step 1: 写失败测试** `src/test/notifier.test.ts`

```typescript
import { expect } from 'chai';
import { shouldNotify } from '../notifier';

describe('notifier.shouldNotify', () => {
  it('notifies on transition into waiting_confirm', () => {
    expect(shouldNotify('working', 'waiting_confirm')).to.equal(true);
  });
  it('notifies on transition into done', () => {
    expect(shouldNotify('working', 'done')).to.equal(true);
  });
  it('does not notify for working', () => {
    expect(shouldNotify('idle', 'working')).to.equal(false);
  });
  it('does not notify for idle', () => {
    expect(shouldNotify('done', 'idle')).to.equal(false);
  });
  it('dedupes repeated same status', () => {
    expect(shouldNotify('waiting_confirm', 'waiting_confirm')).to.equal(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../notifier'`。

- [ ] **Step 3: 实现** `src/notifier.ts`

```typescript
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { SpecStatus } from './types';

const NOTIFY_STATUSES: SpecStatus[] = ['waiting_confirm', 'done'];

/**
 * Pure: decide whether a status transition warrants an intrusive notification.
 * Only waiting_confirm/done notify, and only when the status actually changed
 * (dedupe repeats).
 */
export function shouldNotify(prev: SpecStatus, next: SpecStatus): boolean {
  if (!NOTIFY_STATUSES.includes(next)) { return false; }
  return prev !== next;
}

function label(status: SpecStatus): string {
  return status === 'waiting_confirm' ? '等待你确认' : status === 'done' ? '任务完成' : status;
}

/** Fire system notification + optional webhook + VSCode toast, then jump on click. */
export function notify(specName: string, status: SpecStatus, message: string | undefined, onJump: () => void): void {
  const cfg = vscode.workspace.getConfiguration('tmuxAgent');
  const title = `ducc · ${specName}`;
  const body = `${label(status)}${message ? ' · ' + message : ''}`;

  if (cfg.get<boolean>('notify.system', true)) {
    sendSystemNotification(title, body, () => {
      // system notifiers can't reliably call back; VSCode toast handles the jump
    });
  }
  const webhook = cfg.get<string>('notify.webhookUrl', '');
  if (webhook) { postWebhook(webhook, { spec: specName, status, message, updatedAt: new Date().toISOString() }); }

  // VSCode toast with a Jump action — reliable in-app path.
  vscode.window.showInformationMessage(`${title}: ${body}`, '进入').then(choice => {
    if (choice === '进入') { onJump(); }
  });
}

function sendSystemNotification(title: string, body: string, _cb: () => void): void {
  const platform = process.platform;
  const done = (_e: unknown) => { /* fall back silently to the VSCode toast */ };
  if (platform === 'darwin') {
    execFile('terminal-notifier', ['-title', title, '-message', body, '-sound', 'default'], done);
  } else if (platform === 'linux') {
    execFile('notify-send', [title, body], done);
  } else if (platform === 'win32') {
    const ps = `New-BurntToastNotification -Text '${title}','${body}'`;
    execFile('powershell', ['-NoProfile', '-Command', ps], done);
  }
}

function postWebhook(url: string, payload: Record<string, unknown>): void {
  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    });
    req.on('error', () => { /* log-and-ignore */ });
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch { /* invalid URL — ignore */ }
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（notifier 5 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/notifier.ts src/test/notifier.test.ts
git commit -m "feat: add notifier with dedupe logic and 3-channel dispatch"
```

---

### Task 8: stateWatcher.ts — 监听 state 目录

**Files:**
- Create: `src/stateWatcher.ts`
- Test: `src/test/stateWatcher.test.ts`

**说明**：`StateWatcher` 用 `fs.watch(STATE_DIR)` 监听，去抖 100ms 后对变化的 spec 读新状态、与上次缓存对比，emit `onDidChangeState({ specName, prev, next })`。持久缓存放内存 Map。测试直接调用内部的 `handleChange` 而非依赖真实 fs.watch 时序，保证确定性。

- [ ] **Step 1: 写失败测试** `src/test/stateWatcher.test.ts`

```typescript
import { expect } from 'chai';
import { StateWatcher } from '../stateWatcher';
import { writeSpecState, stateFilePath } from '../specState';
import * as fs from 'fs';

describe('StateWatcher.handleChange', () => {
  const name = 'test-watch-spec';
  afterEach(() => {
    const f = stateFilePath(name);
    if (fs.existsSync(f)) { fs.unlinkSync(f); }
  });

  it('emits prev+next on status change', () => {
    const w = new StateWatcher();
    const events: Array<{ specName: string; prev: string; next: string }> = [];
    w.onDidChangeState(e => events.push(e));

    writeSpecState(name, 'waiting_confirm');
    w.handleChange(name);
    expect(events).to.have.length(1);
    expect(events[0].prev).to.equal('idle');
    expect(events[0].next).to.equal('waiting_confirm');
  });

  it('does not emit when status is unchanged', () => {
    const w = new StateWatcher();
    const events: unknown[] = [];
    w.onDidChangeState(() => events.push(1));
    writeSpecState(name, 'done');
    w.handleChange(name);
    w.handleChange(name); // second time: same status, no emit
    expect(events).to.have.length(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../stateWatcher'`。

- [ ] **Step 3: 实现** `src/stateWatcher.ts`

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR, ensureDirs } from './config';
import { readSpecState } from './specState';
import { SpecStatus } from './types';

export interface StateChange {
  specName: string;
  prev: SpecStatus;
  next: SpecStatus;
}

export class StateWatcher {
  private _emitter = new vscode.EventEmitter<StateChange>();
  readonly onDidChangeState = this._emitter.event;
  private _last = new Map<string, SpecStatus>();
  private _watcher: fs.FSWatcher | undefined;
  private _debounce = new Map<string, NodeJS.Timeout>();

  /** Begin watching STATE_DIR. Safe to call once at activation. */
  start(): void {
    ensureDirs();
    try {
      this._watcher = fs.watch(STATE_DIR, (_event, filename) => {
        if (!filename || !filename.toString().endsWith('.json')) { return; }
        const specName = path.basename(filename.toString(), '.json');
        const existing = this._debounce.get(specName);
        if (existing) { clearTimeout(existing); }
        this._debounce.set(specName, setTimeout(() => this.handleChange(specName), 100));
      });
    } catch {
      // STATE_DIR unavailable — watcher simply inactive
    }
  }

  /** Read current state for a spec, compare to cache, emit if changed. */
  handleChange(specName: string): void {
    const prev = this._last.get(specName) ?? 'idle';
    const next = readSpecState(specName).status;
    if (prev === next) { return; }
    this._last.set(specName, next);
    this._emitter.fire({ specName, prev, next });
  }

  dispose(): void {
    this._watcher?.close();
    for (const t of this._debounce.values()) { clearTimeout(t); }
    this._emitter.dispose();
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS（stateWatcher 2 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/stateWatcher.ts src/test/stateWatcher.test.ts
git commit -m "feat: add StateWatcher for state/ dir with change events"
```

---

### Task 9: terminalOps — Peek 回放与回复（capture-pane / send-keys）

**Files:**
- Modify: `src/terminalOps.ts`（末尾追加导出）
- Test: `src/test/peekCommands.test.ts`

**说明**：Peek 需要两个能力——读某 spec tmux 会话的终端回放尾部（`capture-pane -p`），和把一行文本发进会话（`send-keys ... Enter`）。纯逻辑 `buildCaptureArgs` / `buildSendKeysArgs` 可测；实际执行封装成 `capturePane` / `sendReply`，无会话/无 tmux 时返回降级结果。复用现有 `getTmuxSessionName`（当前是模块私有，需导出）。

- [ ] **Step 1: 导出 `getTmuxSessionName`** — 在 `src/terminalOps.ts` 把
```typescript
function getTmuxSessionName(specName: string): string {
```
改为
```typescript
export function getTmuxSessionName(specName: string): string {
```

- [ ] **Step 2: 写失败测试** `src/test/peekCommands.test.ts`

```typescript
import { expect } from 'chai';
import { buildCaptureArgs, buildSendKeysArgs } from '../terminalOps';

describe('peek tmux command builders', () => {
  it('capture args target session and print last N lines', () => {
    const args = buildCaptureArgs('ta-login-flow', 200);
    expect(args).to.deep.equal(['capture-pane', '-p', '-t', 'ta-login-flow', '-S', '-200']);
  });
  it('send-keys args send literal text then Enter', () => {
    const args = buildSendKeysArgs('ta-login-flow', 'yes');
    expect(args).to.deep.equal(['send-keys', '-t', 'ta-login-flow', 'yes', 'Enter']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test`
Expected: FAIL — `buildCaptureArgs is not a function`。

- [ ] **Step 4: 实现** — 在 `src/terminalOps.ts` 末尾追加

```typescript
/** Pure: tmux args to print the last `lines` rows of a session's pane. */
export function buildCaptureArgs(sessionName: string, lines: number): string[] {
  return ['capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`];
}

/** Pure: tmux args to send a literal line + Enter into a session. */
export function buildSendKeysArgs(sessionName: string, text: string): string[] {
  return ['send-keys', '-t', sessionName, text, 'Enter'];
}

/**
 * Capture the tail of a spec's tmux session pane for the Peek panel.
 * Returns undefined when tmux is unavailable or the session doesn't exist.
 */
export function capturePane(specName: string, lines = 200): string | undefined {
  if (!isTmuxAvailable()) { return undefined; }
  const session = getTmuxSessionName(specName);
  if (!tmuxSessionExists(session)) { return undefined; }
  try {
    return execFileSync('tmux', buildCaptureArgs(session, lines), { encoding: 'utf-8' });
  } catch {
    return undefined;
  }
}

/**
 * Send a reply line into a spec's tmux session (Peek reply / approve).
 * Returns false when tmux is unavailable or the session doesn't exist.
 */
export function sendReply(specName: string, text: string): boolean {
  if (!isTmuxAvailable()) { return false; }
  const session = getTmuxSessionName(specName);
  if (!tmuxSessionExists(session)) { return false; }
  try {
    execFileSync('tmux', buildSendKeysArgs(session, text));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `npm test`
Expected: PASS（peekCommands 2 用例）。

- [ ] **Step 6: Commit**

```bash
git add src/terminalOps.ts src/test/peekCommands.test.ts
git commit -m "feat: add capturePane/sendReply for Peek panel"
```

---

### Task 10: 项目分组 + 状态徽记进入侧边栏 TreeView

**Files:**
- Modify: `src/views/specTreeProvider.ts`（`AllSpecsTreeProvider`）
- Test: 无（纯 UI 渲染，靠手动验证 + 已测的 `groupSpecsByProject`）

**说明**：`AllSpecsTreeProvider` 根层从「平铺 spec」改为「项目节点 → spec 子节点」。新增 `ProjectTreeItem`。spec 节点标签前缀改为读 `readSpecState` 的徽记。`CurrentSpecTreeProvider` 不变。

- [ ] **Step 1: 新增 `ProjectTreeItem`** — 在 `RepoTreeItem` 类之后加

```typescript
import { readSpecState } from '../specState';
import { SpecStatus } from '../types';
import { ProjectGroup } from '../projectStore';

function statusBadge(status: SpecStatus): string {
  switch (status) {
    case 'working': return '●';
    case 'waiting_confirm': return '⚠';
    case 'done': return '✓';
    default: return '○';
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly group: ProjectGroup) {
    super(group.project.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${group.specs.length} features`;
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}
```

- [ ] **Step 2: 在 `SpecTreeItem` 构造里叠加状态徽记** — 把
```typescript
    const statusIcon = spec.status === 'active' ? '●' : spec.status === 'completed' ? '✓' : '○';
    const currentTag = isCurrent ? ' ← current' : '';
    this.label = `${statusIcon} ${spec.name}${currentTag}`;
```
替换为
```typescript
    const aiStatus = readSpecState(spec.name).status;
    const badge = statusBadge(aiStatus);
    const currentTag = isCurrent ? ' ← current' : '';
    this.label = `${badge} ${spec.name}${currentTag}`;
```
（`statusBadge` 在 Step 1 定义；确保 import 已加）

- [ ] **Step 3: 改 `AllSpecsTreeProvider.getChildren` 为两层**

把 `AllSpecsTreeProvider` 的 `getChildren` 整个替换为：
```typescript
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // Project node → its specs
    if (element instanceof ProjectTreeItem) {
      const activeSpecName = getActiveSpecName();
      return element.group.specs.map(spec =>
        new SpecTreeItem(spec, spec.name === activeSpecName, vscode.TreeItemCollapsibleState.Collapsed),
      );
    }
    // Spec node → its repos
    if (element instanceof SpecTreeItem) {
      return element.spec.repos.map(repo => new RepoTreeItem(repo, getWorktreeStatus(repo.worktreePath)));
    }
    if (element) { return []; }

    // Root: project groups
    const specs = listSpecs();
    if (specs.length === 0) {
      return [new vscode.TreeItem('No specs yet. Click (+) to create one.')];
    }
    const groups = groupSpecsByProject(specs, listProjects());
    return groups.map(g => new ProjectTreeItem(g));
  }
```

- [ ] **Step 4: 补 import** — `specTreeProvider.ts` 顶部加

```typescript
import { listProjects, groupSpecsByProject } from '../projectStore';
```

- [ ] **Step 5: 编译验证**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 6: 手动验证（F5 调试宿主）**

1. 起两个 spec，一个带 `projectName: user-auth`（可手动编辑 `~/.tmux-agent/specs/*.yaml` 加 `project_name: user-auth`），一个不带。
2. 侧边栏 All Specs 应显示：`user-auth` 项目节点 → 该 spec；`Ungrouped` 节点 → 无 projectName 的 spec。
3. 手动写 `~/.tmux-agent/state/<spec>.json` 为 `{"status":"waiting_confirm","updatedAt":"..."}`，刷新后该 spec 标签前应为 `⚠`。

- [ ] **Step 7: Commit**

```bash
git add src/views/specTreeProvider.ts
git commit -m "feat: group sidebar specs by project with AI status badges"
```

---

### Task 11: 创建表单选择项目 + 创建后注入 hook

**Files:**
- Modify: `src/views/specWebview.ts`（表单加 project 字段 + 下发已有项目列表）
- Modify: `src/commands/createSpec.ts`（写 projectName + 归组 + installHooks）
- Test: 无（UI + 集成，靠手动验证）

**说明**：`CreateSpecData` 加 `projectName?`。表单加一个"项目"下拉（已有项目 + `<新建>`）+ 新建时的文本框。`SpecWebviewProvider` 构造时接收已有项目名数组注入到 HTML。创建成功后：把 spec 的 `projectName` 存好；若选了/建了项目，更新该 `Project.features`；最后 `installHooks(spec, scriptPath)`。

- [ ] **Step 1: 扩展 `CreateSpecData`** — `src/views/specWebview.ts` 末尾接口加字段

```typescript
export interface CreateSpecData {
  name: string;
  description: string;
  featureBranch: string;
  agentCommand: string;
  projectName?: string;
  repos: Array<{ path: string; name: string }>;
}
```

- [ ] **Step 2: 构造函数接收已有项目名** — 把构造签名改为

```typescript
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly existingProjects: string[],
    private readonly onCreateSpec: (data: CreateSpecData) => void,
  ) {}
```

- [ ] **Step 3: 表单加项目选择 UI** — 在 "Description" form-group 之后插入

```html
  <div class="form-group">
    <label for="project">Project</label>
    <select id="project"></select>
    <input type="text" id="newProject" placeholder="New project name" style="display:none;margin-top:6px;" />
    <div class="hint">Group this feature under a project, or create a new one.</div>
  </div>
```

- [ ] **Step 4: 注入项目列表 + 交互脚本** — 在 `<script>` 内 `const repos = [];` 之后加

```javascript
    const existingProjects = __PROJECTS__;
    (function initProjects() {
      const sel = document.getElementById('project');
      const optNew = '<option value="__new__">➕ New project…</option>';
      const optNone = '<option value="">(Ungrouped)</option>';
      sel.innerHTML = optNone + existingProjects.map(p => '<option value="' + p + '">' + p + '</option>').join('') + optNew;
      sel.addEventListener('change', function() {
        document.getElementById('newProject').style.display = this.value === '__new__' ? 'block' : 'none';
      });
    })();
```
并在 `getCreateSpecHtml()` 返回前，把模板里的 `__PROJECTS__` 替换为真实数据。在方法体开头加：
```typescript
    const projectsJson = JSON.stringify(this.existingProjects);
```
把 HTML 模板里的 `__PROJECTS__` 写成 `${projectsJson}`（即模板串中直接内插）。

- [ ] **Step 5: 创建按钮带上 projectName** — 把 createBtn 的 postMessage data 改为

```javascript
      const projSel = document.getElementById('project').value;
      const projectName = projSel === '__new__'
        ? (document.getElementById('newProject').value.trim() || undefined)
        : (projSel || undefined);
      vscode.postMessage({
        type: 'createSpec',
        data: {
          name: name,
          description: document.getElementById('description').value.trim(),
          featureBranch: branch,
          agentCommand: document.getElementById('agent').value.trim() || 'ducc',
          projectName: projectName,
          repos: repos.map(r => ({ path: r.path, name: r.name })),
        }
      });
```

- [ ] **Step 6: createSpec.ts 传项目列表 + 写归属 + 注入 hook**

在 `src/commands/createSpec.ts` 顶部加 import：
```typescript
import { listProjects, saveProject, loadProject } from '../projectStore';
import { installHooks } from '../hookInstaller';
import { Project } from '../types';
import * as path from 'path';
```
把 `registerCreateSpecCommand` 里 `new SpecWebviewProvider(context.extensionUri, async (data) => {...})` 的构造改为传入项目列表，并记住 extensionPath 供 hook 脚本路径：
```typescript
    const webview = new SpecWebviewProvider(
      context.extensionUri,
      listProjects().map(p => p.name),
      async (data: CreateSpecData) => {
        try {
          await createSpecFromData(data, refreshViews, context.extensionPath);
          vscode.window.showInformationMessage(`Spec "${data.name}" created successfully!`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Failed to create spec: ${msg}`);
        }
      },
    );
```

- [ ] **Step 7: createSpecFromData 落 projectName、更新 Project、注入 hook**

把 `createSpecFromData` 签名改为：
```typescript
async function createSpecFromData(data: CreateSpecData, refreshViews: () => void, extensionPath: string): Promise<void> {
```
在构造 `spec` 对象里加 `projectName: data.projectName`（放在 `repos` 之后）。
在函数末尾 `refreshViews();`（最后一行）之前插入：
```typescript
  // Update the owning project's feature list (create the project if new).
  if (data.projectName) {
    const existing = loadProject(data.projectName);
    if (existing) {
      if (!existing.features.includes(spec.name)) { existing.features.push(spec.name); }
      saveProject(existing);
    } else {
      const p: Project = { name: data.projectName, features: [spec.name], createdAt: new Date().toISOString() };
      saveProject(p);
    }
  }

  // Inject the AI status-reporting hook into this managed worktree only.
  try {
    const scriptPath = path.join(extensionPath, 'scripts', 'report-state.js');
    installHooks(spec, scriptPath);
  } catch (e) {
    console.error('[tmux-agent] installHooks failed (non-fatal):', e);
  }
```

- [ ] **Step 8: 编译验证**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 9: 手动验证**

1. F5 起调试宿主，打开创建表单：项目下拉含 `(Ungrouped)` + 已有项目 + `➕ New project…`。
2. 选 `➕ New project…` 填 `demo`，创建 spec → `~/.tmux-agent/projects/demo.yaml` 生成且 `features` 含该 spec；spec YAML 有 `project_name: demo`。
3. spec worktree 根出现 `.claude/settings.json`，含 Notification/Stop hook 指向 `report-state.js`。

- [ ] **Step 10: Commit**

```bash
git add src/views/specWebview.ts src/commands/createSpec.ts
git commit -m "feat: choose/create project in spec form and install status hook"
```

---

### Task 12: 总控台 Webview（卡片墙 + Peek）

**Files:**
- Create: `src/views/dashboardWebview.ts`
- Test: 无（Webview UI，靠手动验证；数据来源函数已在前面测过）

**说明**：单例 `DashboardPanel`。扩展侧是 source of truth：`render()` 收集 `groupSpecsByProject` + 每 spec 的 `readSpecState` + `getChangeSummary`，`postMessage({type:'data', groups})` 给 Webview。Webview 回传消息：`enter`/`diff`/`commit`/`peek`/`reply`/`approve`/`refresh`。`peek` → 扩展调 `capturePane` + `getChangeSummary`，回 `postMessage({type:'peek', ...})`；`reply`/`approve` → `sendReply`。`enter` → 执行 `tmuxAgent.switchSpec`。

- [ ] **Step 1: 实现** `src/views/dashboardWebview.ts`

```typescript
import * as vscode from 'vscode';
import { listSpecs, loadSpec } from '../store';
import { listProjects, groupSpecsByProject } from '../projectStore';
import { readSpecState } from '../specState';
import { getChangeSummary } from '../gitOps';
import { capturePane, sendReply } from '../terminalOps';
import { getActiveSpecName } from '../state';

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(refreshViews: () => void): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.render();
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'tmuxAgentDashboard', 'Tmux Agent Dashboard', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    DashboardPanel.current = new DashboardPanel(panel, refreshViews);
    return DashboardPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, private readonly refreshViews: () => void) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  /** Push fresh state to the webview. Extension is the source of truth. */
  render(): void {
    const active = getActiveSpecName();
    const groups = groupSpecsByProject(listSpecs(), listProjects()).map(g => ({
      project: g.project.name,
      specs: g.specs.map(s => {
        const st = readSpecState(s.name);
        const sum = getChangeSummary(s);
        return {
          name: s.name, branch: s.featureBranch, repos: s.repos.length,
          changed: sum.totalChanged, status: st.status, message: st.message,
          updatedAt: st.updatedAt, current: s.name === active,
        };
      }),
    }));
    this.panel.webview.postMessage({ type: 'data', groups });
  }

  private async onMessage(m: { type: string; spec?: string; text?: string }): Promise<void> {
    switch (m.type) {
      case 'refresh': this.render(); break;
      case 'enter':
        if (m.spec) {
          const spec = loadSpec(m.spec);
          if (spec) { await vscode.commands.executeCommand('tmuxAgent.switchSpec', { spec }); }
        }
        break;
      case 'commit':
        await vscode.commands.executeCommand('tmuxAgent.commitSpec');
        break;
      case 'diff':
        if (m.spec) {
          const spec = loadSpec(m.spec);
          const sum = spec ? getChangeSummary(spec) : { totalChanged: 0, repos: [] };
          this.panel.webview.postMessage({ type: 'diff', spec: m.spec, summary: sum });
        }
        break;
      case 'peek':
        if (m.spec) {
          const spec = loadSpec(m.spec);
          const sum = spec ? getChangeSummary(spec) : { totalChanged: 0, repos: [] };
          const pane = capturePane(m.spec) ?? '（无可回放的终端会话）';
          this.panel.webview.postMessage({ type: 'peek', spec: m.spec, pane, summary: sum });
        }
        break;
      case 'reply':
        if (m.spec && typeof m.text === 'string') {
          const ok = sendReply(m.spec, m.text);
          this.panel.webview.postMessage({ type: 'replyResult', spec: m.spec, ok });
        }
        break;
      case 'approve':
        if (m.spec) {
          const ok = sendReply(m.spec, 'yes');
          this.panel.webview.postMessage({ type: 'replyResult', spec: m.spec, ok });
        }
        break;
    }
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }

  private html(): string {
    return DASHBOARD_HTML;
  }
}
```

- [ ] **Step 2: 加 Webview HTML/JS 常量** — 在同文件末尾追加 `DASHBOARD_HTML`

```typescript
const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  .toolbar { display:flex; gap:8px; margin-bottom:12px; }
  .project { margin-bottom:18px; }
  .project h2 { font-size:1em; margin:0 0 8px; opacity:.8; }
  .cards { display:flex; flex-wrap:wrap; gap:12px; }
  .card { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:10px; width:240px; }
  .card.current { outline:2px solid var(--vscode-focusBorder); }
  .badge { font-weight:700; margin-right:4px; }
  .working{color:#3794ff}.waiting_confirm{color:#e2c08d}.done{color:#89d185}.idle{color:#888}
  .meta { font-size:.85em; opacity:.8; margin:4px 0; }
  .row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  button { cursor:pointer; border:none; border-radius:3px; padding:4px 8px; font-size:.85em;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .files { margin-top:8px; font-size:.8em; }
  .file { font-family:monospace; }
  #peek { position:fixed; top:0; right:0; width:42%; height:100%; overflow:auto;
    background:var(--vscode-editorWidget-background); border-left:1px solid var(--vscode-panel-border);
    padding:12px; display:none; }
  pre { white-space:pre-wrap; font-size:.8em; }
</style></head><body>
  <div class="toolbar">
    <button onclick="send('refresh')">↻ Refresh</button>
  </div>
  <div id="root"></div>
  <div id="peek"></div>
<script>
  const vscode = acquireVsCodeApi();
  function send(type, spec, text){ vscode.postMessage({type, spec, text}); }
  function relTime(iso){ if(!iso) return ''; const s=(Date.now()-Date.parse(iso))/1000;
    if(isNaN(s)) return ''; if(s<60) return Math.floor(s)+'s前'; if(s<3600) return Math.floor(s/60)+'min前'; return Math.floor(s/3600)+'h前'; }
  const LABEL={working:'工作中',waiting_confirm:'等待你确认',done:'已完成',idle:'空闲'};

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') renderData(m.groups);
    if (m.type === 'peek') renderPeek(m);
    if (m.type === 'diff') alertDiff(m);
    if (m.type === 'replyResult') { if(!m.ok) alert('回复失败：会话不存在，请先「进入」重启'); else send('peek', m.spec); }
  });

  function renderData(groups){
    const root = document.getElementById('root');
    root.innerHTML = groups.map(g =>
      '<div class="project"><h2>▼ '+g.project+'</h2><div class="cards">'+
      g.specs.map(cardHtml).join('')+'</div></div>').join('');
  }
  function cardHtml(s){
    return '<div class="card'+(s.current?' current':'')+'">'+
      '<div><span class="badge '+s.status+'">'+badge(s.status)+'</span><strong>'+s.name+'</strong></div>'+
      '<div class="meta">'+s.branch+'</div>'+
      '<div class="meta">'+s.repos+' repos · '+s.changed+' changed</div>'+
      '<div class="meta '+s.status+'">'+badge(s.status)+' '+LABEL[s.status]+' '+relTime(s.updatedAt)+'</div>'+
      '<div class="row">'+
        '<button onclick="send(\\'enter\\',\\''+s.name+'\\')">进入</button>'+
        '<button onclick="send(\\'diff\\',\\''+s.name+'\\')">diff</button>'+
        '<button onclick="send(\\'commit\\',\\''+s.name+'\\')">提交</button>'+
        '<button onclick="send(\\'peek\\',\\''+s.name+'\\')">预览</button>'+
      '</div></div>';
  }
  function badge(st){ return st==='working'?'●':st==='waiting_confirm'?'⚠':st==='done'?'✓':'○'; }

  function fileList(summary){
    return summary.repos.map(r => r.files.map(f =>
      '<div class="file">'+f.code+' '+r.name+'/'+f.path+'</div>').join('')).join('') || '<div>无变动</div>';
  }
  function alertDiff(m){
    const peek=document.getElementById('peek');
    peek.style.display='block';
    peek.innerHTML='<h3>变动: '+m.spec+'</h3>'+fileList(m.summary)+
      '<div class="row"><button onclick="closePeek()">关闭</button></div>';
  }
  function renderPeek(m){
    const peek=document.getElementById('peek');
    peek.style.display='block';
    peek.innerHTML='<h3>PEEK: '+m.spec+' (只读)</h3>'+
      '<h4>AI 最近输出</h4><pre>'+escapeHtml(m.pane)+'</pre>'+
      '<h4>变动</h4>'+fileList(m.summary)+
      '<div class="row"><input id="replyBox" placeholder="输入确认/指令" style="flex:1"/>'+
      '<button onclick="doReply()">发送</button>'+
      '<button onclick="send(\\'approve\\',\\''+m.spec+'\\')">批准继续</button>'+
      '<button onclick="send(\\'enter\\',\\''+m.spec+'\\')">进入深度编辑</button>'+
      '<button onclick="closePeek()">关闭</button></div>';
    peek.dataset.spec = m.spec;
  }
  function doReply(){
    const spec=document.getElementById('peek').dataset.spec;
    const box=document.getElementById('replyBox');
    if(box.value.trim()) send('reply', spec, box.value.trim());
  }
  function closePeek(){ document.getElementById('peek').style.display='none'; }
  function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script></body></html>`;
```

- [ ] **Step 3: 编译验证**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 4: Commit**（命令注册在下个 Task，先提交面板类）

```bash
git add src/views/dashboardWebview.ts
git commit -m "feat: add dashboard webview with card wall and Peek panel"
```

---

### Task 13: 接线 — 命令注册、stateWatcher 启动、package.json

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`（命令 + 菜单 + 配置项）
- Test: 无（集成，靠手动端到端验证）

**说明**：注册 `tmuxAgent.openDashboard` 命令；activate 时启动 `StateWatcher`，其 `onDidChangeState` 回调里：`notify()`（若 `shouldNotify`）、刷新 dashboard（若开着）、刷新侧边栏。package.json 加命令、view/title 按钮、`tmuxAgent.notify.*` 配置。

- [ ] **Step 1: extension.ts 引入依赖** — 顶部 import 区追加

```typescript
import { DashboardPanel } from './views/dashboardWebview';
import { StateWatcher } from './stateWatcher';
import { shouldNotify, notify } from './notifier';
```

- [ ] **Step 2: 注册 dashboard 命令** — 在现有 `context.subscriptions.push(registerCreateSpecCommand(...), ...)` 块里追加一行

```typescript
    vscode.commands.registerCommand('tmuxAgent.openDashboard', () => {
      DashboardPanel.createOrShow(refreshViews);
    }),
```

- [ ] **Step 3: 启动 StateWatcher 并接线三渠道** — 在 `registerTerminalCloseHandler(context);` 之后插入

```typescript
  // --- AI status watcher: badge refresh + notifications ---
  const stateWatcher = new StateWatcher();
  context.subscriptions.push(stateWatcher);
  context.subscriptions.push(
    stateWatcher.onDidChangeState(({ specName, prev, next }) => {
      // Refresh sidebar badges and dashboard cards on every change.
      refreshViews();
      DashboardPanel.current?.render();
      // Intrusive notification only for waiting_confirm/done transitions.
      if (shouldNotify(prev, next)) {
        notify(specName, next, readSpecStateMessage(specName), () => {
          vscode.commands.executeCommand('tmuxAgent.switchSpec', { spec: loadSpec(specName) });
        });
      }
    }),
  );
  stateWatcher.start();
```

- [ ] **Step 4: 暴露 DashboardPanel.current + 加辅助**

在 `dashboardWebview.ts` 把 `private static current` 改为 `static current`（供 extension 引用）：
```typescript
  static current: DashboardPanel | undefined;
```
在 `extension.ts` 末尾（`deactivate` 之前）加辅助函数（避免在回调里重复 import specState）：
```typescript
import { readSpecState } from './specState';
function readSpecStateMessage(specName: string): string | undefined {
  return readSpecState(specName).message;
}
```
（把 `readSpecState` import 与其他 import 并列放到文件顶部；此处示意其用途。）

- [ ] **Step 5: package.json 加命令** — `contributes.commands` 数组追加

```json
      {
        "command": "tmuxAgent.openDashboard",
        "title": "Tmux Agent: Open Dashboard",
        "icon": "$(dashboard)"
      }
```

- [ ] **Step 6: package.json 加总控台按钮** — `contributes.menus."view/title"` 数组追加

```json
        {
          "command": "tmuxAgent.openDashboard",
          "when": "view == tmuxAgentAllSpecs",
          "group": "navigation"
        }
```

- [ ] **Step 7: package.json 加配置项** — `contributes` 下新增 `configuration`

```json
    "configuration": {
      "title": "Tmux Agent",
      "properties": {
        "tmuxAgent.notify.system": {
          "type": "boolean",
          "default": true,
          "description": "AI 需确认/完成时发送系统通知（含声音）"
        },
        "tmuxAgent.notify.webhookUrl": {
          "type": "string",
          "default": "",
          "description": "外部推送 webhook URL（留空则不推送）；POST { spec, status, message, updatedAt }"
        }
      }
    }
```

- [ ] **Step 8: 编译 + lint**

Run: `npm run compile && npm run lint`
Expected: 均无错误。

- [ ] **Step 9: 全量单测回归**

Run: `npm test`
Expected: 全部 PASS（sanity + config + store + projectStore + specState + gitChangeSummary + hookInstaller + notifier + stateWatcher + peekCommands）。

- [ ] **Step 10: 端到端手动验证（F5）**

1. 侧边栏 All Specs 顶部出现 dashboard 按钮 → 点开总控台。
2. 卡片墙按项目分组显示所有 feature，含 repos/changed/状态徽记。
3. 在某 worktree 手动跑 `node scripts/report-state.js waiting_confirm <spec>`：
   - 卡片变黄 ⚠、侧边栏徽记变 ⚠、弹出系统通知 + VSCode「进入」弹窗；点「进入」切到该 feature。
4. 卡片「预览」→ 右侧面板显示 tmux 回放 + 变动列表 + 回复框；输入文本发送→ 进入该 tmux 会话（`send-keys`）。
5. 卡片「进入」→ 原子切换 workspace，编辑器显示该 feature 代码。
6. 配置 `tmuxAgent.notify.webhookUrl` 指向本地 `nc -l` 或 webhook.site，触发状态变化验证收到 POST。

- [ ] **Step 11: Commit**

```bash
git add src/extension.ts src/views/dashboardWebview.ts package.json
git commit -m "feat: wire dashboard command + state watcher notifications"
```

---

### Task 14: 文档更新（遵循 CLAUDE.md 文档维护规则）

**Files:**
- Modify: `doc/architecture.md`、`doc/features.md`、`doc/design.md`、`doc/conventions.md`

**说明**：本次为 feature 类改动 + 新增多个 `src/` 文件 + 新数据流 + 新约定，按项目 CLAUDE.md 需更新多份文档。可 spawn background sub-agent 执行。

- [ ] **Step 1: architecture.md** — 项目结构树加新文件（projectStore/specState/notifier/stateWatcher/hookInstaller/dashboardWebview + scripts/report-state.js）；模块职责表加对应行；数据流图加 hook→state→watcher→dashboard/notifier 支路；存储布局加 `projects/`、`state/`。

- [ ] **Step 2: features.md** — 新增章节：总控台（卡片墙 + Peek）、项目分级、AI 状态提醒（三渠道）；创建 Spec 流程补"选择/新建项目 + 注入 hook"。

- [ ] **Step 3: design.md** — 加两层模型（项目→feature）、总控台交互流程、状态提醒机制。

- [ ] **Step 4: conventions.md** — 加 `state/<spec>.json` 格式约定、hook 注入约定（仅 worktree 作用域）、纯逻辑与 vscode 胶水分离的可测性约定。

- [ ] **Step 5: Commit**

```bash
git add doc/
git commit -m "docs: document dashboard, project tiers, and AI status notifications"
```

---

## Self-Review

**1. Spec coverage（逐节对照 spec）：**

| Spec 章节 | 对应 Task |
|-----------|-----------|
| §3 数据模型（Project/SpecState/projectName/存储布局） | Task 1, 2, 3, 4 |
| §3 向后兼容（Ungrouped 惰性归组） | Task 3（groupSpecsByProject）、Task 10 |
| §4 架构分层（各新增/改动模块） | Task 1–13 全覆盖 |
| §4 数据流 | Task 8, 13 |
| §5 总控台卡片墙（信息/按钮/单向数据流） | Task 12 |
| §5 Peek 预览面板（回放/diff/回复出口） | Task 9, 12 |
| §5 切换延迟（复用 switchWorkspaceFolders） | Task 12（enter→switchSpec，无新工程） |
| §6 Hook 注入（作用域/内容/语义映射） | Task 6, 11 |
| §7 提醒（三渠道/去重/跳转/可配置） | Task 7, 13 |
| §8 错误处理（各边界） | Task 4（状态容错）、5（缺失 worktree）、7（webhook 超时）、9（无会话降级） |
| §9 测试策略（Mocha + 单测 + 手动清单） | Task 0 + 各 Task 单测 + Task 13 手动 |
| §10 分阶段落地 | Task 顺序即阶段 1→5 |
| §11 文档更新 | Task 14 |

无遗漏。

**2. Placeholder scan：** 计划内除 Webview HTML 里 `__PROJECTS__`（Step 明确了替换为 `${projectsJson}`）外无占位符；每个代码步骤均给出完整代码。

**3. Type consistency 核对：**
- `SpecStatus` 四值 `working|waiting_confirm|done|idle` 在 types/specState/notifier/stateWatcher/tree/dashboard 一致。
- `groupSpecsByProject(specs, projects)` 签名在 Task 3 定义，Task 10/12 调用一致。
- `getChangeSummary(spec) → { totalChanged, repos:[{name,worktreePath,files:[{code,path}]}] }` 在 Task 5 定义，Task 12 dashboard 消费字段名一致。
- `installHooks(spec, scriptPath)`、`buildHookSettings(specName, scriptPath)` 命名在 Task 6/11 一致。
- `capturePane(specName, lines?)`、`sendReply(specName, text)`、`buildCaptureArgs`/`buildSendKeysArgs` 在 Task 9 定义，Task 12 调用一致。
- `readSpecState(specName) → SpecState`、`writeSpecState(specName, status, message?)` 在 Task 4 定义，各处一致。
- `DashboardPanel.createOrShow(refreshViews)` / `DashboardPanel.current` 在 Task 12/13 一致（Task 13 Step 4 将 `current` 由 private 改为可访问）。
- `shouldNotify(prev, next)` / `notify(specName, status, message, onJump)` 在 Task 7 定义，Task 13 调用一致。

一致，无签名漂移。







