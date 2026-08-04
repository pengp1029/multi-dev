import * as vscode from 'vscode';
import { Spec, RepoEntry, SpecStatus } from '../types';
import { listSpecs, loadSpec } from '../store';
import { getActiveSpecName } from '../state';
import { getWorktreeStatus, WorktreeStatus } from '../gitOps';
import { listProjects, groupSpecsByProject, ProjectGroup } from '../projectStore';
import { readSpecState } from '../specState';

// --- Helpers ---

function statusBadge(status: SpecStatus): string {
  switch (status) {
    case 'working': return '●';
    case 'waiting_confirm': return '⚠';
    case 'done': return '✓';
    default: return '○';
  }
}

/**
 * Colored status icon for the tree. TreeItem labels cannot be colored, so the
 * AI status color is carried by a ThemeIcon + ThemeColor (codicon id + theme
 * color id) instead of a bare unicode char in the label.
 */
function statusIcon(status: SpecStatus): vscode.ThemeIcon {
  switch (status) {
    case 'working': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    case 'waiting_confirm': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'done': return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    default: return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
  }
}

// --- Tree item types ---

export class SpecTreeItem extends vscode.TreeItem {
  constructor(
    public readonly spec: Spec,
    public readonly isCurrent: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(spec.name, collapsibleState);

    const aiStatus = readSpecState(spec.name).status;
    const currentTag = isCurrent ? ' ← current' : '';
    this.label = `${spec.name}${currentTag}`;
    this.iconPath = statusIcon(aiStatus);
    this.description = `${statusBadge(aiStatus)} ${spec.featureBranch} · ${spec.repos.length} repos`;
    this.tooltip = `${spec.name}\n${spec.description}\nBranch: ${spec.featureBranch}\nStatus: ${spec.status}\nRepos: ${spec.repos.length}`;

    if (isCurrent) {
      this.contextValue = 'specActive';
    } else if (spec.status === 'active') {
      this.contextValue = 'specInactive';
    } else {
      this.contextValue = 'spec';
    }
  }
}

export class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly repo: RepoEntry,
    public readonly status: WorktreeStatus,
  ) {
    super(repo.name, vscode.TreeItemCollapsibleState.None);

    const changeInfo = status.clean
      ? '✓ clean'
      : `${status.total} changes`;
    this.description = `${repo.branch} · ${changeInfo}`;
    this.tooltip = `${repo.name}\nOrigin: ${repo.originPath}\nWorktree: ${repo.worktreePath}\nBranch: ${repo.branch}\nStaged: ${status.staged} | Modified: ${status.modified} | Untracked: ${status.untracked}`;
    this.contextValue = 'repo';

    // Click to open the worktree folder
    this.command = {
      command: 'revealInExplorer',
      title: 'Reveal in Explorer',
      arguments: [vscode.Uri.file(repo.worktreePath)],
    };
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

// --- Current Spec TreeView ---

export class CurrentSpecTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      // Children of a spec → repos
      if (element instanceof SpecTreeItem) {
        return element.spec.repos.map(repo => {
          const status = getWorktreeStatus(repo.worktreePath);
          return new RepoTreeItem(repo, status);
        });
      }
      return [];
    }

    // Root level: show current spec
    const activeSpecName = getActiveSpecName();
    if (!activeSpecName) {
      return [new vscode.TreeItem('No active spec. Create one with (+) above.')];
    }

    const spec = loadSpec(activeSpecName);
    if (!spec) {
      return [new vscode.TreeItem(`Spec "${activeSpecName}" not found.`)];
    }

    return [new SpecTreeItem(spec, true, vscode.TreeItemCollapsibleState.Expanded)];
  }
}

// --- All Specs TreeView ---

export class AllSpecsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

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
      return element.spec.repos.map(repo => {
        const status = getWorktreeStatus(repo.worktreePath);
        return new RepoTreeItem(repo, status);
      });
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
}
