import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GeneratedFile, ValidationIssue, ValidationResult } from './types';
import { runMaven } from '../validators/mavenRunner';
import { buildJUnitStubs } from '../validators/junitStubber';

/**
 * Stage 5 — Validator.
 *
 * 1. Writes all in-memory GeneratedFiles to the working output directory.
 * 2. Generates JUnit 5 test stubs for every Java class.
 * 3. If enabled, runs `mvn compile` (and optionally checkstyle/spotbugs)
 *    and parses the output into structured ValidationIssues.
 *
 * Validator does NOT loop back to the generator on errors — that would
 * make the run nondeterministic. Errors and warnings flow into the
 * conversion report produced by Stage 6 so the developer can act on them.
 */
export class ValidatorAgent {
  constructor(
    private readonly outRoot: string,
    private readonly out: vscode.OutputChannel
  ) {}

  async run(
    files: GeneratedFile[],
    structuralFiles: GeneratedFile[],
    token: vscode.CancellationToken
  ): Promise<{ result: ValidationResult; allFiles: GeneratedFile[] }> {
    const started = Date.now();
    const cfg = vscode.workspace.getConfiguration('snConvert');

    // 1. JUnit stubs — derived from the Java files Stage 4 produced.
    const javaFiles = files.filter(f => f.language === 'java');
    const stubs = buildJUnitStubs(javaFiles);
    const allFiles = [...files, ...structuralFiles, ...stubs];

    // 2. Write everything to disk (Stage 6 will append a few more files later).
    for (const f of allFiles) {
      await fs.mkdir(path.dirname(f.path), { recursive: true });
      await fs.writeFile(f.path, f.content, 'utf8');
    }
    this.out.appendLine(`[stage5:validator] wrote ${allFiles.length} files (${stubs.length} JUnit stubs)`);

    // 3. Optional Maven validation.
    const result: ValidationResult = {
      ran: false,
      compiled: null,
      errors: [],
      warnings: [],
      testStubsGenerated: stubs.length,
      checkstyle: { ran: false, issueCount: 0 },
      spotbugs: { ran: false, issueCount: 0 },
      durationMs: 0
    };

    const wantMvn = cfg.get<boolean>('runMavenValidation') ?? true;
    if (wantMvn && !token.isCancellationRequested) {
      const wantCheckstyle = cfg.get<boolean>('runCheckstyle') ?? false;
      const wantSpotbugs   = cfg.get<boolean>('runSpotbugs')   ?? false;
      const goals = ['compile'];
      if (wantCheckstyle) goals.push('checkstyle:check');
      if (wantSpotbugs)   goals.push('com.github.spotbugs:spotbugs-maven-plugin:check');

      const mvnRoot = path.join(this.outRoot, 'backend');
      this.out.appendLine(`[stage5:validator] running mvn ${goals.join(' ')} in ${mvnRoot}`);
      const mvn = await runMaven({ cwd: mvnRoot, goals, out: this.out, token });
      result.ran = mvn.ran;
      result.compiled = mvn.success;
      const errs: ValidationIssue[] = mvn.issues.filter(i => i.severity === 'error');
      const warns: ValidationIssue[] = mvn.issues.filter(i => i.severity === 'warning');
      result.errors.push(...errs);
      result.warnings.push(...warns);
      result.checkstyle = { ran: wantCheckstyle, issueCount: mvn.issues.filter(i => i.source === 'checkstyle').length };
      result.spotbugs   = { ran: wantSpotbugs,   issueCount: mvn.issues.filter(i => i.source === 'spotbugs').length };
    } else {
      this.out.appendLine(`[stage5:validator] mvn validation disabled or cancelled`);
    }

    result.durationMs = Date.now() - started;
    this.out.appendLine(
      `[stage5:validator] done in ${result.durationMs}ms — compiled=${result.compiled} errors=${result.errors.length} warnings=${result.warnings.length}`
    );
    return { result, allFiles };
  }
}
