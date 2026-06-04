import * as vscode from 'vscode';
import type { PipelineProgressHooks } from '../pipeline/orchestrator';

type RunStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';
type StageStatus = 'pending' | 'running' | 'done' | 'error';

interface StageState {
  id: number;
  label: string;
  status: StageStatus;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

interface PipelineState {
  runId: number;
  target?: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  stages: StageState[];
  logs: string[];
}

export interface ProgressStageDef {
  id: number;
  label: string;
}

export interface TaskProgressReporter {
  start(target: string): void;
  log(message: string): void;
  stageStart(stage: number, detail: string): void;
  stageDone(stage: number, detail: string): void;
  stageError(stage: number, detail: string): void;
  success(summary: string): void;
  cancelled(): void;
  failed(message: string): void;
}

const DEFAULT_STAGES: ReadonlyArray<ProgressStageDef> = [
  { id: 1, label: 'Extractor' },
  { id: 2, label: 'Parser' },
  { id: 3, label: 'Mapper' },
  { id: 4, label: 'Generator' },
  { id: 5, label: 'Validator' },
  { id: 6, label: 'Assembler' }
];

export class PipelineProgressView {
  private static current: PipelineProgressView | undefined;
  private state: PipelineState = this.newIdleState();
  private readonly panel: vscode.WebviewPanel;

  static createOrShow(extensionUri: vscode.Uri): PipelineProgressView {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (PipelineProgressView.current) {
      PipelineProgressView.current.panel.reveal(column);
      return PipelineProgressView.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'snConvert.pipelineProgress',
      'ServiceNow Conversion Progress',
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    const view = new PipelineProgressView(panel);
    PipelineProgressView.current = view;
    return view;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      if (PipelineProgressView.current === this) {
        PipelineProgressView.current = undefined;
      }
    });
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.postState();
  }

  createHooks(): PipelineProgressHooks {
    return {
      onRunStart: target => this.startRun(target, DEFAULT_STAGES),
      onRunCancelled: () => this.finishCancelled(),
      onRunComplete: summary => this.finishSuccess(summary),
      onLog: msg => this.appendLog(msg, true),
      onStageStart: (stage, label, detail) => this.updateStage(stage, label, 'running', detail),
      onStageDone: (stage, label, detail) => this.updateStage(stage, label, 'done', detail),
      onStageError: (stage, label, error) => this.updateStage(stage, label, 'error', error)
    };
  }

  createTaskReporter(stages: ReadonlyArray<ProgressStageDef>): TaskProgressReporter {
    const defs = stages.length ? [...stages] : [...DEFAULT_STAGES];
    const stageLabel = (id: number): string => defs.find(s => s.id === id)?.label ?? `Stage ${id}`;
    return {
      start: target => this.startRun(target, defs),
      log: message => this.appendLog(message, true),
      stageStart: (stage, detail) => this.updateStage(stage, stageLabel(stage), 'running', detail),
      stageDone: (stage, detail) => this.updateStage(stage, stageLabel(stage), 'done', detail),
      stageError: (stage, detail) => this.updateStage(stage, stageLabel(stage), 'error', detail),
      success: summary => this.finishSuccess(summary),
      cancelled: () => this.finishCancelled(),
      failed: message => this.markFailed(message)
    };
  }

  markFailed(message: string): void {
    this.state.status = 'error';
    this.state.endedAt = Date.now();
    this.state.summary = message;
    this.appendLog(`[error] ${message}`);
    this.postState();
  }

  private startRun(target: string, stages: ReadonlyArray<ProgressStageDef>): void {
    this.state = {
      runId: this.state.runId + 1,
      target,
      status: 'running',
      startedAt: Date.now(),
      stages: stages.map(s => ({ id: s.id, label: s.label, status: 'pending' as StageStatus })),
      logs: []
    };
    this.appendLog(`[run] started for ${target}`);
    this.postState();
  }

  private finishSuccess(summary: string): void {
    this.state.status = 'success';
    this.state.endedAt = Date.now();
    this.state.summary = summary;
    this.appendLog(`[run] completed: ${summary}`);
    this.postState();
  }

  private finishCancelled(): void {
    this.state.status = 'cancelled';
    this.state.endedAt = Date.now();
    this.state.summary = 'Cancelled by user';
    this.appendLog('[run] cancelled by user');
    this.postState();
  }

  private updateStage(stage: number, label: string, status: StageStatus, detail: string): void {
    const item = this.state.stages.find(s => s.id === stage);
    if (!item) return;
    item.label = label || item.label;
    item.status = status;
    item.detail = detail;
    if (status === 'running') {
      item.startedAt = item.startedAt ?? Date.now();
      item.endedAt = undefined;
    } else if (status === 'done' || status === 'error') {
      item.endedAt = Date.now();
      item.startedAt = item.startedAt ?? item.endedAt;
    }
    this.appendLog(`[stage ${stage}] ${item.label}: ${detail}`);
    this.postState();
  }

  private appendLog(msg: string, post = false): void {
    const ts = new Date().toLocaleTimeString();
    this.state.logs.push(`${ts} ${msg}`);
    if (this.state.logs.length > 250) {
      this.state.logs = this.state.logs.slice(-250);
    }
    if (post) this.postState();
  }

  private postState(): void {
    this.panel.webview.postMessage({ type: 'state', payload: this.state });
  }

  private newIdleState(): PipelineState {
    return {
      runId: 0,
      status: 'idle',
      stages: DEFAULT_STAGES.map(s => ({ id: s.id, label: s.label, status: 'pending' as StageStatus })),
      logs: []
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Conversion Progress</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); margin: 0; padding: 14px; color: var(--vscode-foreground); }
    .top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--vscode-panel-border); }
    .status-running { color: #f0b429; }
    .status-success { color: #2ea043; }
    .status-error { color: #f85149; }
    .status-cancelled { color: #8b949e; }
    .status-idle { color: #8b949e; }
    .stages { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 12px; }
    .stage { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; }
    .stage h4 { margin: 0 0 4px; font-size: 13px; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }
    .dot-pending { background: #8b949e; }
    .dot-running { background: #f0b429; }
    .dot-done { background: #2ea043; }
    .dot-error { background: #f85149; }
    .logs { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; }
    .logs pre { margin: 0; font-size: 12px; line-height: 1.4; white-space: pre-wrap; max-height: 230px; overflow: auto; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    const app = document.getElementById('app');
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const msToSec = (ms) => ms ? (ms / 1000).toFixed(1) + 's' : '-';
    const runClass = (s) => 'status-' + s;
    const dotClass = (s) => 'dot-' + s;

    function render(state) {
      const start = state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : '-';
      const duration = state.startedAt && state.endedAt ? msToSec(state.endedAt - state.startedAt) : '-';
      const stageHtml = state.stages.map((st) => {
        const elapsed = st.startedAt ? msToSec((st.endedAt ?? Date.now()) - st.startedAt) : '-';
        return '<div class="stage">' +
          '<h4><span class="dot ' + dotClass(st.status) + '"></span>' + esc(st.id + '. ' + st.label) + '</h4>' +
          '<div class="muted">status: ' + esc(st.status) + ' | elapsed: ' + esc(elapsed) + '</div>' +
          '<div class="muted">' + esc(st.detail || '') + '</div>' +
        '</div>';
      }).join('');

      const logs = state.logs.length ? state.logs.join('\\n') : 'No logs yet.';
      app.innerHTML =
        '<div class="top">' +
          '<div><strong>Run #' + esc(state.runId) + '</strong> ' + (state.target ? '<span class="muted">(' + esc(state.target) + ')</span>' : '') + '</div>' +
          '<span class="badge ' + runClass(state.status) + '">' + esc(state.status) + '</span>' +
        '</div>' +
        '<div class="muted">started: ' + esc(start) + ' | duration: ' + esc(duration) + (state.summary ? ' | ' + esc(state.summary) : '') + '</div>' +
        '<div class="stages">' + stageHtml + '</div>' +
        '<div class="logs"><pre>' + esc(logs) + '</pre></div>';
    }

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'state') render(event.data.payload);
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
