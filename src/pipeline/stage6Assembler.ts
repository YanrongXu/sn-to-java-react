import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  AssembledProject,
  ExtractedBundle,
  GeneratedFile,
  SemanticPlan,
  ValidationResult
} from './types';
import { buildStructuralFiles } from '../assemblers/projectAssembler';
import { buildLiquibase } from '../assemblers/liquibaseGenerator';
import { buildSecurityConfig } from '../assemblers/securityConfigAssembler';

/**
 * Stage 6 — Assembler.
 *
 * Produces the structural envelope that Stage 4 didn't (POMs, application.yml,
 * main class, frontend project), plus the cross-cutting concerns that need
 * to see the whole bundle at once:
 *   - Liquibase changelog tree, master file pointing to per-table changesets.
 *   - SecurityConfig aggregating every ACL into a single FilterChain.
 *
 * Writes the conversion report and returns the AssembledProject summary.
 */
export class AssemblerAgent {
  constructor(private readonly outRoot: string, private readonly out: vscode.OutputChannel) {}

  async run(args: {
    plan: SemanticPlan;
    extracted: ExtractedBundle;
    generatedFiles: GeneratedFile[];
    structuralFiles?: GeneratedFile[];
    validation: ValidationResult;
    token: vscode.CancellationToken;
  }): Promise<AssembledProject> {
    const { plan, extracted, generatedFiles, structuralFiles, validation } = args;

    // Structural files may already be prepared/written before validation so
    // Stage 5 can run mvn against a complete Maven project layout.
    const additions =
      structuralFiles ??
      [
        ...buildStructuralFiles(extracted.application, plan.basePackage, this.outRoot),
        ...buildLiquibase(extracted.tables, this.outRoot),
        buildSecurityConfig(extracted.acls, plan.basePackage, this.outRoot)
      ];

    // Write everything that's not already on disk. Stage 5 wrote generatedFiles
    // before running mvn; here we add the rest.
    for (const f of additions) {
      await fs.mkdir(path.dirname(f.path), { recursive: true });
      await fs.writeFile(f.path, f.content, 'utf8');
    }
    this.out.appendLine(`[stage6:assembler] wrote ${additions.length} structural files`);

    // 4. Conversion report
    const report = this.renderReport(plan, extracted, generatedFiles, additions, validation);
    const reportPath = path.join(this.outRoot, 'CONVERSION_REPORT.md');
    await fs.writeFile(reportPath, report, 'utf8');

    const total = generatedFiles.length + additions.length;
    return { rootDir: this.outRoot, fileCount: total, report };
  }

  private renderReport(
    plan: SemanticPlan,
    bundle: ExtractedBundle,
    generated: GeneratedFile[],
    structural: GeneratedFile[],
    v: ValidationResult
  ): string {
    const llmCount = generated.filter(f => f.llmInvolved).length;
    const lines: string[] = [];
    lines.push(`# Conversion report: ${bundle.application.name}`, ``);
    lines.push(`Scope: \`${bundle.application.scope}\`  `);
    lines.push(`Base package: \`${plan.basePackage}\``, ``);

    lines.push(`## Pipeline summary`);
    lines.push(`| Stage | Output |`);
    lines.push(`| --- | --- |`);
    lines.push(`| 1. Extractor | ${bundle.tables.length} tables, ${bundle.businessRules.length} BRs, ${bundle.scriptIncludes.length} SIs, ${bundle.clientScripts.length} client scripts, ${bundle.restResources.length} REST, ${bundle.acls.length} ACLs |`);
    lines.push(`| 2. Parser | ASTs walked for ${bundle.businessRules.length + bundle.scriptIncludes.length + bundle.clientScripts.length + bundle.restResources.length} scripts |`);
    lines.push(`| 3. Mapper | ${plan.mappings.length} mappings across ${plan.modules.length} modules |`);
    lines.push(`| 4. Generator | ${generated.length} files (${llmCount} involved Copilot) |`);
    lines.push(`| 5. Validator | compile=${v.compiled === null ? 'skipped' : v.compiled}, errors=${v.errors.length}, warnings=${v.warnings.length}, JUnit stubs=${v.testStubsGenerated} |`);
    lines.push(`| 6. Assembler | ${structural.length} structural files (POMs, app.yml, Liquibase, SecurityConfig) |`);
    lines.push(``);

    if (v.errors.length) {
      lines.push(`## Compile errors`);
      for (const e of v.errors.slice(0, 50)) {
        lines.push(`- \`${e.file ?? '?'}${e.line ? ':' + e.line : ''}\` — ${e.message}`);
      }
      if (v.errors.length > 50) lines.push(`- … (${v.errors.length - 50} more)`);
      lines.push(``);
    }

    if (v.warnings.length) {
      lines.push(`## Compile warnings (first 20)`);
      for (const w of v.warnings.slice(0, 20)) {
        lines.push(`- \`${w.file ?? '?'}${w.line ? ':' + w.line : ''}\` — ${w.message}`);
      }
      lines.push(``);
    }

    lines.push(`## Review checklist`);
    lines.push(`1. \`grep -rn "TODO(sn-convert)" backend frontend\` — every uncertain conversion is tagged.`);
    lines.push(`2. ACLs with **script conditions** — \`SecurityConfig.java\` lists these; port each as a custom \`AuthorizationManager\`.`);
    lines.push(`3. **Reference columns** in entities — currently \`String\` (foreign sys_id). Promote to \`@ManyToOne\` for intra-scope references.`);
    lines.push(`4. **Workflows / Flow Designer** are not converted by this pipeline.`);
    lines.push(`5. JUnit stubs are placeholders — every \`*Test\` class has a \`TODO(sn-convert)\` body.`);
    lines.push(``);
    lines.push(`## Runtime configuration`);
    lines.push(`**Dev (default):** H2 file DB under \`backend/data/\`, MSSQLServer compatibility mode.`);
    lines.push('```bash');
    lines.push(`cd backend && mvn -pl web spring-boot:run`);
    lines.push('```');
    lines.push(`**Prod (SQL Server):** activate \`prod\` and set JDBC env vars:`);
    lines.push('```bash');
    lines.push(`export SPRING_PROFILES_ACTIVE=prod`);
    lines.push(`export DATASOURCE_URL="jdbc:sqlserver://localhost:1433;databaseName=${bundle.application.scope};encrypt=true;trustServerCertificate=true"`);
    lines.push(`export DB_USER=app`);
    lines.push(`export DB_PASSWORD=app`);
    lines.push(`cd backend && mvn -pl web spring-boot:run`);
    lines.push('```');
    return lines.join('\n');
  }
}
