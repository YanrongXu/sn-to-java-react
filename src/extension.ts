import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ServiceNowClient } from './servicenow/client';
import { Pipeline } from './pipeline/orchestrator';
import { CopilotLLM } from './llm/copilot';
import { connectCommand, getCredentials } from './util/credentials';
import { registerChatParticipant } from './chat';
import { PipelineProgressView } from './ui/pipelineProgressView';
import { buildUiTodoMarkdown, checklistStats, mergeChecklistProgress } from './todo/uiTodo';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ServiceNow Converter');
  context.subscriptions.push(output);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.connect', () => connectCommand(context, output))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.openProgressView', () => {
      PipelineProgressView.createOrShow(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.listApplications', async () => {
      const creds = await getCredentials(context);
      if (!creds) {
        vscode.window.showWarningMessage('Run "ServiceNow: Connect to Instance" first.');
        return;
      }
      const client = new ServiceNowClient(creds, output);
      const apps = await client.listScopedApplications();
      const picked = await vscode.window.showQuickPick(
        apps.map(a => ({ label: a.name, description: a.scope, detail: a.sys_id })),
        { placeHolder: 'Scoped applications on this instance' }
      );
      if (picked) {
        await vscode.env.clipboard.writeText(picked.detail!);
        vscode.window.showInformationMessage(`sys_id copied: ${picked.detail}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.generateUiTodo', async () => {
      const creds = await getCredentials(context);
      if (!creds) {
        vscode.window.showWarningMessage('Run "ServiceNow: Connect to Instance" first.');
        return;
      }

      const sysIdOrScope = await vscode.window.showInputBox({
        prompt: 'Scoped Application sys_id or scope name (e.g. x_acme_orders)',
        ignoreFocusOut: true
      });
      if (!sysIdOrScope) return;

      const client = new ServiceNowClient(creds, output);
      const progressView = PipelineProgressView.createOrShow(context.extensionUri);
      const reporter = progressView.createTaskReporter([
        { id: 1, label: 'Resolve App' },
        { id: 2, label: 'Extract UI Artifacts' },
        { id: 3, label: 'Build TODO Checklist' },
        { id: 4, label: 'Write and Open File' }
      ]);

      reporter.start(sysIdOrScope);
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ServiceNow UI scan → TODO checklist',
            cancellable: false
          },
          async progress => {
            reporter.stageStart(1, 'Resolving scoped application');
            progress.report({ message: 'Resolving application...', increment: 20 });
            const app = await client.resolveApplication(sysIdOrScope);
            reporter.stageDone(1, `${app.name} (${app.scope})`);

            reporter.stageStart(2, 'Fetching UI pages, client scripts, REST resources');
            progress.report({ message: 'Extracting UI artifacts...', increment: 50 });
            const bundle = await client.fetchBundle(app);
            reporter.stageDone(
              2,
              `UI Pages=${bundle.uiPages.length}, Client Scripts=${bundle.clientScripts.length}, REST=${bundle.restResources.length}`
            );

            reporter.stageStart(3, 'Generating TODO markdown and preserving checked items');
            progress.report({ message: 'Generating TODO markdown...', increment: 20 });
            const outPath = resolveTodoPath(bundle.application.scope);
            const fresh = buildUiTodoMarkdown(bundle);
            const existing = await readFileIfExists(outPath);
            const merged = mergeChecklistProgress(existing, fresh);
            const stats = checklistStats(merged);
            reporter.stageDone(3, `Checklist items: ${stats.done}/${stats.total} done (${stats.percent}%)`);

            reporter.stageStart(4, 'Saving checklist and opening editor');
            await fs.mkdir(path.dirname(outPath), { recursive: true });
            await fs.writeFile(outPath, merged, 'utf8');
            progress.report({ message: 'Opening checklist...', increment: 10 });
            const doc = await vscode.workspace.openTextDocument(outPath);
            await vscode.window.showTextDocument(doc);
            reporter.stageDone(4, `Saved to ${outPath}`);
            reporter.success(`Checklist progress: ${stats.done}/${stats.total} (${stats.percent}%)`);
            vscode.window.showInformationMessage(
              `UI TODO generated: ${outPath} (${stats.done}/${stats.total} completed)`
            );
          }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reporter.failed(message);
        vscode.window.showErrorMessage(`UI TODO generation failed: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.convertApplication', async () => {
      const creds = await getCredentials(context);
      if (!creds) {
        const choice = await vscode.window.showWarningMessage(
          'Not connected to a ServiceNow instance.',
          'Connect now'
        );
        if (choice === 'Connect now') {
          await vscode.commands.executeCommand('snConvert.connect');
        }
        return;
      }

      const sysIdOrScope = await vscode.window.showInputBox({
        prompt: 'Scoped Application sys_id or scope name (e.g. x_acme_orders)',
        ignoreFocusOut: true
      });
      if (!sysIdOrScope) return;

      const client = new ServiceNowClient(creds, output);
      const llm = new CopilotLLM(output);
      const progressView = PipelineProgressView.createOrShow(context.extensionUri);
      const pipeline = new Pipeline(client, llm, output, progressView.createHooks());

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ServiceNow → Java/React (6-stage pipeline)',
            cancellable: true
          },
          (progress, token) => pipeline.run(sysIdOrScope, progress, token)
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progressView.markFailed(message);
        vscode.window.showErrorMessage(`Conversion failed: ${message}`);
      }
    })
  );

  // --- Chat participant: @servicenow ---
  registerChatParticipant(context, output);
}

export function deactivate() {}

function resolveTodoPath(scope: string): string {
  const configured = vscode.workspace.getConfiguration('snConvert').get<string>('outputDirectory');
  if (configured) {
    return path.join(configured, scope, 'UI_TODO.md');
  }
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    return path.join(ws.uri.fsPath, `${scope}-UI_TODO.md`);
  }
  return path.join(require('os').homedir(), `${scope}-UI_TODO.md`);
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}
