// Minimal 'vscode' stub so unit tests can import extension modules that
// reference the vscode API at module load (e.g. createOutputChannel).
// Only the members touched at import time / in tested paths need to exist.
class EventEmitter {
  constructor() { this._l = []; this.event = (listener) => { this._l.push(listener); return { dispose() {} }; }; }
  fire(e) { for (const l of this._l) { l(e); } }
  dispose() { this._l = []; }
}
module.exports = {
  EventEmitter,
  window: {
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
    createTerminal: () => ({ show() {}, sendText() {}, dispose() {}, name: 'stub' }),
    terminals: [],
    onDidCloseTerminal: () => ({ dispose() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage() { return { dispose() {} }; }, postMessage() {} }, reveal() {}, onDidDispose() { return { dispose() {} }; }, dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve(undefined) },
  ViewColumn: { One: 1, Two: 2 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (b, ...p) => ({ fsPath: [b && b.fsPath, ...p].join('/') }) },
};
