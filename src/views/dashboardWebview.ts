import * as vscode from 'vscode';
import { listSpecs, loadSpec } from '../store';
import { listProjects, groupSpecsByProject } from '../projectStore';
import { readSpecState } from '../specState';
import { getChangeSummary } from '../gitOps';
import { capturePane, sendReply } from '../terminalOps';
import { getActiveSpecName } from '../state';

export class DashboardPanel {
  static current: DashboardPanel | undefined;
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
    this.panel.webview.onDidReceiveMessage((m: { type: string; spec?: string; text?: string }) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }
  /** Push fresh state to the webview. Extension is the source of truth. */
  render(): void {
    try {
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
    } catch (e) {
      // Surface extension-side failures into the panel instead of leaving it
      // stuck on the loading placeholder.
      const message = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      this.panel.webview.postMessage({ type: 'error', message });
    }
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
    // A CSP with a per-load nonce is required for the inline <script> to run
    // in a VSCode webview. Without it, modern VSCode blocks the inline script,
    // the webview never calls send('refresh'), and the panel stays stuck on the
    // static "加载中…" placeholder.
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return DASHBOARD_HTML
      .replace('<head><meta charset="UTF-8">',
        `<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace('<script>', `<script nonce="${nonce}">`);
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html, body { background: var(--vscode-editor-background, #1e1e1e); }
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
    <button onclick="send('refresh')">&#8635; Refresh</button>
  </div>
  <div id="root">加载中…</div>
  <div id="peek"></div>
<script>
  const vscode = acquireVsCodeApi();
  function send(type, spec, text){ vscode.postMessage({type, spec, text}); }
  function relTime(iso){ if(!iso) return ''; const s=(Date.now()-Date.parse(iso))/1000;
    if(isNaN(s)) return ''; if(s<60) return Math.floor(s)+'s前'; if(s<3600) return Math.floor(s/60)+'min前'; return Math.floor(s/3600)+'h前'; }
  const LABEL={working:'工作中',waiting_confirm:'等待你确认',done:'已完成',idle:'空闲'};

  window.addEventListener('message', function(e){
    const m = e.data;
    try {
      if (m.type === 'data') renderData(m.groups);
      if (m.type === 'error') { document.getElementById('root').textContent = '扩展端出错: ' + m.message; }
      if (m.type === 'peek') renderPeek(m);
      if (m.type === 'diff') alertDiff(m);
      if (m.type === 'replyResult') { if(!m.ok) alert('回复失败：会话不存在，请先「进入」重启'); else send('peek', m.spec); }
    } catch (err) {
      document.getElementById('root').textContent = '渲染出错: ' + (err && err.message ? err.message : err);
    }
  });

  function renderData(groups){
    const root = document.getElementById('root');
    if (!groups || !groups.length) { root.textContent = '暂无项目/feature。点击侧边栏 (+) 创建。'; return; }
    root.innerHTML = groups.map(function(g){ return '<div class="project"><h2>▼ ' + escapeHtml(g.project) + '</h2><div class="cards">' + g.specs.map(cardHtml).join('') + '</div></div>'; }).join('');
  }
  function cardHtml(s){
    return '<div class="card' + (s.current ? ' current' : '') + '">' +
      '<div><span class="badge ' + s.status + '">' + badge(s.status) + '</span><strong>' + escapeHtml(s.name) + '</strong></div>' +
      '<div class="meta">' + escapeHtml(s.branch) + '</div>' +
      '<div class="meta">' + s.repos + ' repos · ' + s.changed + ' changed</div>' +
      '<div class="meta ' + s.status + '">' + badge(s.status) + ' ' + LABEL[s.status] + ' ' + relTime(s.updatedAt) + '</div>' +
      '<div class="row">' +
        '<button onclick="send(\'enter\',\'' + jsStr(s.name) + '\')">进入</button>' +
        '<button onclick="send(\'diff\',\'' + jsStr(s.name) + '\')">diff</button>' +
        '<button onclick="send(\'commit\',\'' + jsStr(s.name) + '\')">提交</button>' +
        '<button onclick="send(\'peek\',\'' + jsStr(s.name) + '\')">预览</button>' +
      '</div></div>';
  }
  function badge(st){ return st==='working'?'●':st==='waiting_confirm'?'⚠':st==='done'?'✓':'○'; }

  function fileList(summary){
    return summary.repos.map(function(r){ return r.files.map(function(f){ return '<div class="file">' + escapeHtml(f.code) + ' ' + escapeHtml(r.name) + '/' + escapeHtml(f.path) + '</div>'; }).join(''); }).join('') || '<div>无变动</div>';
  }
  function alertDiff(m){
    const peek=document.getElementById('peek');
    peek.style.display='block';
    peek.innerHTML='<h3>变动: ' + escapeHtml(m.spec) + '</h3>' + fileList(m.summary) +
      '<div class="row"><button onclick="closePeek()">关闭</button></div>';
  }
  function renderPeek(m){
    const peek=document.getElementById('peek');
    peek.style.display='block';
    peek.innerHTML='<h3>PEEK: ' + escapeHtml(m.spec) + ' (只读)</h3>' +
      '<h4>AI 最近输出</h4><pre>' + escapeHtml(m.pane) + '</pre>' +
      '<h4>变动</h4>' + fileList(m.summary) +
      '<div class="row"><input id="replyBox" placeholder="输入确认/指令" style="flex:1"/>' +
      '<button onclick="doReply()">发送</button>' +
      '<button onclick="send(\'approve\',\'' + jsStr(m.spec) + '\')">批准继续</button>' +
      '<button onclick="send(\'enter\',\'' + jsStr(m.spec) + '\')">进入深度编辑</button>' +
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
  // Escape a value for safe embedding inside a single-quoted JS string in an onclick attribute.
  function jsStr(s){ return escapeHtml((s||'').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")); }

  // Request initial data once the script has loaded. The extension may have
  // already posted a 'data' message before this listener existed (constructor
  // races the webview boot), so pull explicitly instead of relying on that push.
  send('refresh');
</script></body></html>`;
