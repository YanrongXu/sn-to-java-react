import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ServiceNowClient } from '../servicenow/client';
import { CopilotLLM } from '../llm/copilot';
import { ExtractorAgent } from './stage1Extractor';
import { ParserAgent } from './stage2Parser';
import { MapperAgent } from './stage3Mapper';
import { GeneratorAgent } from './stage4Generator';
import { ValidatorAgent } from './stage5Validator';
import { AssemblerAgent } from './stage6Assembler';

/**
 * The 6-stage pipeline. Each agent is constructed at run() time and given
 * only what it needs — no shared mutable state across stages.
 *
 *   1 Extractor → ExtractedBundle
 *   2 Parser    → ParsedBundle
 *   3 Mapper    → SemanticPlan
 *   4 Generator → GeneratedFile[]
 *   5 Validator → ValidationResult + files written to disk
 *   6 Assembler → AssembledProject (structural files, Liquibase, Security, report)
 */
export class Pipeline {
  constructor(
    private readonly client: ServiceNowClient,
    private readonly llm: CopilotLLM,
    private readonly out: vscode.OutputChannel
  ) {}

  async run(
    sysIdOrScope: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) {
    // Stage 1
    progress.report({ message: 'Stage 1/6: Extractor — pulling artifacts', increment: 5 });
    const extracted = await new ExtractorAgent(this.client, this.out).run(sysIdOrScope);
    if (token.isCancellationRequested) return;

    // Stage 2
    progress.report({ message: 'Stage 2/6: Parser — walking GlideScript AST', increment: 10 });
    const parsed = await new ParserAgent(this.out).run(extracted);
    if (token.isCancellationRequested) return;

    // Stage 3
    progress.report({ message: 'Stage 3/6: Mapper — building semantic plan', increment: 5 });
    const plan = new MapperAgent(this.out).run(parsed);
    if (token.isCancellationRequested) return;

    const outRoot = this.resolveOutputRoot(extracted.application.scope);
    await fs.mkdir(outRoot, { recursive: true });

    // Stage 4
    progress.report({ message: 'Stage 4/6: Generator — emitting code via Copilot', increment: 10 });
    const generated = await new GeneratorAgent(this.llm, outRoot, this.out).run(plan, parsed, progress, token);
    if (token.isCancellationRequested) return;

    // Stage 5 (writes Stage 4 files + JUnit stubs to disk, runs mvn)
    progress.report({ message: 'Stage 5/6: Validator — mvn compile + test stubs', increment: 30 });
    const { result: validation } = await new ValidatorAgent(outRoot, this.out).run(generated, [], token);
    if (token.isCancellationRequested) return;

    // Stage 6
    progress.report({ message: 'Stage 6/6: Assembler — POMs, Liquibase, Security, report', increment: 30 });
    const assembled = await new AssemblerAgent(outRoot, this.out).run({
      plan,
      extracted,
      generatedFiles: generated,
      validation,
      token
    });

    progress.report({ message: 'Done.', increment: 10 });
    const open = await vscode.window.showInformationMessage(
      `Pipeline complete. ${assembled.fileCount} files in ${assembled.rootDir}` +
        (validation.compiled === false ? ` — ⚠️ compile errors, see report` : ''),
      'Open Folder',
      'View Report'
    );
    if (open === 'Open Folder') {
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(assembled.rootDir), { forceNewWindow: true });
    } else if (open === 'View Report') {
      const doc = await vscode.workspace.openTextDocument(path.join(assembled.rootDir, 'CONVERSION_REPORT.md'));
      vscode.window.showTextDocument(doc);
    }
  }

  private resolveOutputRoot(scope: string): string {
    const configured = vscode.workspace.getConfiguration('snConvert').get<string>('outputDirectory');
    if (configured) return path.join(configured, scope);
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) return path.join(ws.uri.fsPath, `${scope}-converted`);
    return path.join(require('os').homedir(), `${scope}-converted`);
  }
}
