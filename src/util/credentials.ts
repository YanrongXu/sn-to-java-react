import * as vscode from 'vscode';
import { SnCredentials } from '../servicenow/types';

const SECRET_KEY = 'snConvert.password';

export async function connectCommand(context: vscode.ExtensionContext, out: vscode.OutputChannel) {
  const config = vscode.workspace.getConfiguration('snConvert');
  const instanceUrl =
    (await vscode.window.showInputBox({
      prompt: 'ServiceNow instance URL',
      value: config.get<string>('instanceUrl') ?? '',
      placeHolder: 'https://acme.service-now.com',
      ignoreFocusOut: true
    })) ?? '';
  if (!instanceUrl) return;

  const username =
    (await vscode.window.showInputBox({
      prompt: 'ServiceNow username',
      value: config.get<string>('username') ?? '',
      ignoreFocusOut: true
    })) ?? '';
  if (!username) return;

  const password =
    (await vscode.window.showInputBox({
      prompt: 'ServiceNow password (stored in VS Code SecretStorage)',
      password: true,
      ignoreFocusOut: true
    })) ?? '';
  if (!password) return;

  await config.update('instanceUrl', instanceUrl, vscode.ConfigurationTarget.Global);
  await config.update('username', username, vscode.ConfigurationTarget.Global);
  await context.secrets.store(SECRET_KEY, password);

  out.appendLine(`[SN] connection saved for ${username}@${instanceUrl}`);
  vscode.window.showInformationMessage('ServiceNow connection saved.');
}

export async function getCredentials(context: vscode.ExtensionContext): Promise<SnCredentials | undefined> {
  const config = vscode.workspace.getConfiguration('snConvert');
  const instanceUrl = config.get<string>('instanceUrl');
  const username = config.get<string>('username');
  const password = await context.secrets.get(SECRET_KEY);
  if (!instanceUrl || !username || !password) return undefined;
  return { instanceUrl, username, password };
}
