import * as vscode from 'vscode';
import { ServiceNowClient } from './servicenow/client';
import { Pipeline } from './pipeline/orchestrator';
import { CopilotLLM } from './llm/copilot';
import { connectCommand, getCredentials } from './util/credentials';
import { registerChatParticipant } from './chat';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ServiceNow Converter');
  context.subscriptions.push(output);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('snConvert.connect', () => connectCommand(context, output))
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
      const pipeline = new Pipeline(client, llm, output);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ServiceNow → Java/React (6-stage pipeline)',
          cancellable: true
        },
        (progress, token) => pipeline.run(sysIdOrScope, progress, token)
      );
    })
  );

  // --- Chat participant: @servicenow ---
  registerChatParticipant(context, output);
}

export function deactivate() {}
