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
import { buildStructuralFiles } from '../assemblers/projectAssembler';
import { buildLiquibase } from '../assemblers/liquibaseGenerator';
import { buildSecurityConfig } from '../assemblers/securityConfigAssembler';

export interface PipelineProgressHooks {
  onRunStart?(target: string): void;
  onRunComplete?(summary: string): void;
  onRunCancelled?(): void;
  onStageStart?(stage: number, label: string, detail: string): void;
  onStageDone?(stage: number, label: string, detail: string): void;
  onStageError?(stage: number, label: string, error: string): void;
  onLog?(message: string): void;
}

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
    private readonly out: vscode.OutputChannel,
    private readonly hooks?: PipelineProgressHooks
  ) {}

  async run(
    sysIdOrScope: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) {
    this.hooks?.onRunStart?.(sysIdOrScope);

    // Stage 1
    progress.report({ message: 'Stage 1/6: Extractor — pulling artifacts', increment: 5 });
    this.hooks?.onStageStart?.(1, 'Extractor', 'Pulling artifacts from ServiceNow');
    let extracted;
    try {
      extracted = await new ExtractorAgent(this.client, this.out).run(sysIdOrScope);
      this.hooks?.onStageDone?.(
        1,
        'Extractor',
        `Artifacts: ${extracted.tables.length} tables, ${extracted.businessRules.length} business rules`
      );
    } catch (err) {
      this.hooks?.onStageError?.(1, 'Extractor', asMessage(err));
      throw err;
    }
    if (token.isCancellationRequested) {
      this.hooks?.onRunCancelled?.();
      return;
    }

    // Stage 2
    progress.report({ message: 'Stage 2/6: Parser — walking GlideScript AST', increment: 10 });
    this.hooks?.onStageStart?.(2, 'Parser', 'Walking GlideScript AST');
    let parsed;
    try {
      parsed = await new ParserAgent(this.out).run(extracted);
      this.hooks?.onStageDone?.(2, 'Parser', `Parsed ${parsed.scripts.length} scripts`);
    } catch (err) {
      this.hooks?.onStageError?.(2, 'Parser', asMessage(err));
      throw err;
    }
    if (token.isCancellationRequested) {
      this.hooks?.onRunCancelled?.();
      return;
    }

    // Stage 3
    progress.report({ message: 'Stage 3/6: Mapper — building semantic plan', increment: 5 });
    this.hooks?.onStageStart?.(3, 'Mapper', 'Building semantic plan');
    let plan;
    try {
      plan = new MapperAgent(this.out).run(parsed);
      this.hooks?.onStageDone?.(3, 'Mapper', `Mapped ${plan.mappings.length} artifacts`);
    } catch (err) {
      this.hooks?.onStageError?.(3, 'Mapper', asMessage(err));
      throw err;
    }
    if (token.isCancellationRequested) {
      this.hooks?.onRunCancelled?.();
      return;
    }

    const outRoot = this.resolveOutputRoot(extracted.application.scope);
    await fs.mkdir(outRoot, { recursive: true });
    this.hooks?.onLog?.(`Output directory: ${outRoot}`);

    // Stage 4
    progress.report({ message: 'Stage 4/6: Generator — emitting code via Copilot', increment: 10 });
    this.hooks?.onStageStart?.(4, 'Generator', 'Emitting Java/React code via Copilot');
    let generated;
    try {
      generated = await new GeneratorAgent(this.llm, outRoot, this.out).run(plan, parsed, progress, token);
      this.hooks?.onStageDone?.(4, 'Generator', `Generated ${generated.length} files`);
    } catch (err) {
      this.hooks?.onStageError?.(4, 'Generator', asMessage(err));
      throw err;
    }
    if (token.isCancellationRequested) {
      this.hooks?.onRunCancelled?.();
      return;
    }

    // Pre-validation structural files (needed so mvn has pom.xml/module layout).
    const structuralFiles = [
      ...buildStructuralFiles(extracted.application, plan.basePackage, outRoot),
      ...buildLiquibase(extracted.tables, outRoot),
      buildSecurityConfig(extracted.acls, plan.basePackage, outRoot)
    ];

    // Stage 5 (writes Stage 4 + structural files + JUnit stubs to disk, runs mvn)
    progress.report({ message: 'Stage 5/6: Validator — mvn compile + test stubs', increment: 30 });
    this.hooks?.onStageStart?.(5, 'Validator', 'Writing files, generating tests, running mvn compile');
    let validation;
    try {
      validation = (await new ValidatorAgent(outRoot, this.out).run(generated, structuralFiles, token)).result;
      this.hooks?.onStageDone?.(
        5,
        'Validator',
        `compiled=${validation.compiled} errors=${validation.errors.length} warnings=${validation.warnings.length}`
      );
    } catch (err) {
      this.hooks?.onStageError?.(5, 'Validator', asMessage(err));
      throw err;
    }
    if (token.isCancellationRequested) {
      this.hooks?.onRunCancelled?.();
      return;
    }

    // Stage 6
    progress.report({ message: 'Stage 6/6: Assembler — POMs, Liquibase, Security, report', increment: 30 });
    this.hooks?.onStageStart?.(6, 'Assembler', 'Writing conversion report and final artifacts');
    let assembled;
    try {
      assembled = await new AssemblerAgent(outRoot, this.out).run({
        plan,
        extracted,
        generatedFiles: generated,
        structuralFiles,
        validation,
        token
      });
      this.hooks?.onStageDone?.(6, 'Assembler', `Assembled ${assembled.fileCount} files`);
    } catch (err) {
      this.hooks?.onStageError?.(6, 'Assembler', asMessage(err));
      throw err;
    }

    progress.report({ message: 'Done.', increment: 10 });
    this.hooks?.onRunComplete?.(`Output: ${assembled.rootDir}`);
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

function asMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
