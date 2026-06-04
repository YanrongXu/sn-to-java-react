import * as vscode from 'vscode';
import { CopilotLLM } from '../llm/copilot';
import { GeneratedFile, ParsedBundle, SemanticPlan } from './types';
import { EntityGenerator } from '../generators/entityGenerator';
import { ServiceGenerator } from '../generators/serviceGenerator';
import { ControllerGenerator } from '../generators/controllerGenerator';
import { ScriptIncludeGenerator } from '../generators/scriptIncludeGenerator';
import { ReactGenerator } from '../generators/reactGenerator';

/**
 * Stage 4 — Generator.
 *
 * Walks the SemanticPlan and dispatches each mapping to the appropriate
 * per-artifact generator. Generators receive parsed AST patterns from
 * Stage 2 so their LLM prompts are grounded, not speculative.
 *
 * Generators return GeneratedFile records (path + content + language +
 * origin sys_id). Nothing is written to disk in this stage — Stage 5
 * writes to a working location to validate, Stage 6 finalises the output.
 */
export class GeneratorAgent {
  constructor(
    private readonly llm: CopilotLLM,
    private readonly outRoot: string,
    private readonly out: vscode.OutputChannel
  ) {}

  async run(
    plan: SemanticPlan,
    parsed: ParsedBundle,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];

    const entityGen   = new EntityGenerator(this.llm, plan.basePackage, this.outRoot);
    const serviceGen  = new ServiceGenerator(this.llm, plan.basePackage, this.outRoot);
    const controllerGen = new ControllerGenerator(this.llm, plan.basePackage, this.outRoot);
    const scriptIncGen  = new ScriptIncludeGenerator(this.llm, plan.basePackage, this.outRoot);
    const reactGen    = new ReactGenerator(this.llm, this.outRoot);

    const allTableNames = parsed.extracted.tables.map(t => t.name);
    const totalSteps = plan.mappings.length + 1; // +1 for React batch
    let done = 0;
    const tick = (label: string) => {
      done += 1;
      progress.report({ message: `Stage 4 generator (${done}/${totalSteps}): ${label}`, increment: 100 / totalSteps });
    };

    // We process mappings in a stable order: tables first (entities are
    // referenced everywhere), then services, then controllers, then includes.
    const orderKey = (kind: string): number =>
      kind === 'table' ? 0 :
      kind === 'businessRule' ? 1 :
      kind === 'scriptInclude' ? 2 :
      kind === 'scriptedRest' ? 3 :
      kind === 'acl' ? 4 :
      9;
    const ordered = [...plan.mappings].sort((a, b) => orderKey(a.source.kind) - orderKey(b.source.kind));

    for (const m of ordered) {
      if (token.isCancellationRequested) break;
      try {
        switch (m.source.kind) {
          case 'table': {
            const entityFiles = await entityGen.generate(m, token);
            files.push(...entityFiles);
            // CRUD controller — separate target on the same mapping.
            const controllerFiles = await controllerGen.generate(m, allTableNames, token);
            files.push(...controllerFiles);
            tick(`table ${m.source.data.name}`);
            break;
          }
          case 'businessRule': {
            const fs = await serviceGen.generate(m, allTableNames, token);
            files.push(...fs);
            tick(`business rule ${m.source.data.name}`);
            break;
          }
          case 'scriptInclude': {
            const fs = await scriptIncGen.generate(m, allTableNames, token);
            files.push(...fs);
            tick(`script include ${m.source.data.name}`);
            break;
          }
          case 'scriptedRest': {
            const fs = await controllerGen.generate(m, allTableNames, token);
            files.push(...fs);
            tick(`scripted REST ${m.source.data.name}`);
            break;
          }
          case 'acl': {
            // ACLs are aggregated in Stage 6 (Assembler) into SecurityConfig.
            // Nothing to emit per-ACL at Stage 4.
            tick(`acl ${m.source.data.name}`);
            break;
          }
        }
      } catch (e) {
        this.out.appendLine(`[stage4:generator] error on ${m.source.kind}: ${(e as Error).message}`);
      }
    }

    // React side: one batch operation rather than per-artifact, since pages
    // and types are produced as a coordinated set.
    if (!token.isCancellationRequested) {
      const reactFiles = await reactGen.generateForBundle(parsed.extracted, parsed.scripts, token);
      files.push(...reactFiles);
      tick('React pages');
    }

    this.out.appendLine(`[stage4:generator] produced ${files.length} files in memory`);
    return files;
  }
}
