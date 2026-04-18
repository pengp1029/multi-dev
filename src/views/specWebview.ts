import * as vscode from 'vscode';
import * as path from 'path';

export class SpecWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onCreateSpec: (data: CreateSpecData) => void,
  ) {}

  showCreateSpecForm(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'tmuxAgentCreateSpec',
      'Create Spec',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.getCreateSpecHtml();

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'createSpec':
          this.onCreateSpec(message.data as CreateSpecData);
          this.panel?.dispose();
          break;
        case 'browseRepo':
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Git Repository',
          });
          if (uris && uris.length > 0) {
            this.panel?.reveal();
            await this.panel?.webview.postMessage({
              type: 'repoPath',
              path: uris[0].fsPath,
              name: path.basename(uris[0].fsPath),
            });
          }
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private getCreateSpecHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Create Spec</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    max-width: 700px;
    margin: 0 auto;
  }
  h1 { font-size: 1.4em; margin-bottom: 20px; }
  .form-group { margin-bottom: 16px; }
  label {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
    font-size: 0.9em;
  }
  input, textarea, select {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.9em;
    box-sizing: border-box;
  }
  textarea { resize: vertical; min-height: 60px; }
  .repo-list {
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    padding: 8px;
    margin-top: 8px;
    min-height: 40px;
  }
  .repo-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    border-radius: 3px;
    margin-bottom: 4px;
  }
  .repo-item .remove {
    cursor: pointer;
    color: var(--vscode-errorForeground);
    border: none;
    background: none;
    font-size: 1.1em;
  }
  .btn-row { display: flex; gap: 8px; margin-top: 8px; }
  button {
    padding: 6px 14px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
</style>
</head>
<body>
  <h1>Create New Spec</h1>

  <div class="form-group">
    <label for="name">Spec Name</label>
    <input type="text" id="name" placeholder="e.g. user-auth" />
  </div>

  <div class="form-group">
    <label for="description">Description</label>
    <textarea id="description" placeholder="What is this spec about?"></textarea>
  </div>

  <div class="form-group">
    <label for="branch">Feature Branch</label>
    <input type="text" id="branch" placeholder="auto-filled: feat/<name>" />
    <div class="hint">Leave empty to auto-generate from spec name</div>
  </div>

  <div class="form-group">
    <label for="agent">Agent Command</label>
    <input type="text" id="agent" value="ducc" />
  </div>

  <div class="form-group">
    <label>Repositories</label>
    <div class="btn-row">
      <button class="btn-secondary" id="addRepoBtn">Browse...</button>
    </div>
    <div class="repo-list" id="repoList">
      <div class="hint" id="repoHint">No repos added yet. Click "Browse..." to add.</div>
    </div>
  </div>

  <div class="btn-row" style="margin-top: 24px;">
    <button class="btn-primary" id="createBtn">Create Spec</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const repos = [];

    document.getElementById('name').addEventListener('input', function() {
      const branchInput = document.getElementById('branch');
      if (!branchInput.dataset.manual) {
        branchInput.value = 'feat/' + this.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      }
    });

    document.getElementById('branch').addEventListener('input', function() {
      this.dataset.manual = 'true';
    });

    document.getElementById('addRepoBtn').addEventListener('click', function() {
      vscode.postMessage({ type: 'browseRepo' });
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type === 'repoPath') {
        repos.push({ path: msg.path, name: msg.name });
        renderRepos();
      }
    });

    function renderRepos() {
      const list = document.getElementById('repoList');
      const hint = document.getElementById('repoHint');
      if (repos.length === 0) {
        hint.style.display = 'block';
        list.innerHTML = '';
        list.appendChild(hint);
        return;
      }
      hint.style.display = 'none';
      list.innerHTML = repos.map((r, i) =>
        '<div class="repo-item">' +
          '<span><strong>' + r.name + '</strong> — ' + r.path + '</span>' +
          '<button class="remove" onclick="removeRepo(' + i + ')">✕</button>' +
        '</div>'
      ).join('');
    }

    window.removeRepo = function(idx) {
      repos.splice(idx, 1);
      renderRepos();
    };

    document.getElementById('createBtn').addEventListener('click', function() {
      const name = document.getElementById('name').value.trim();
      if (!name) {
        return;
      }
      if (repos.length === 0) {
        return;
      }
      const branch = document.getElementById('branch').value.trim() || ('feat/' + name);
      vscode.postMessage({
        type: 'createSpec',
        data: {
          name: name,
          description: document.getElementById('description').value.trim(),
          featureBranch: branch,
          agentCommand: document.getElementById('agent').value.trim() || 'ducc',
          repos: repos.map(r => ({ path: r.path, name: r.name })),
        }
      });
    });
  </script>
</body>
</html>`;
  }
}

export interface CreateSpecData {
  name: string;
  description: string;
  featureBranch: string;
  agentCommand: string;
  repos: Array<{ path: string; name: string }>;
}
