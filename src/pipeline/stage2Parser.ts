import * as vscode from 'vscode';
import { parseGlideScript } from '../parser/glideScriptParser';
import { ExtractedBundle, ParsedBundle, ParsedScript } from './types';

/**
 * Stage 2 — Parser.
 *
 * Runs `@babel/parser` over every server-side and client-side script in
 * the bundle and extracts the GlideRecord / gs.* / current.* / Script-Include
 * patterns used. The resulting `ScriptPatterns` give Stage 3 a structural
 * basis for mapping, and Stage 4 grounded context for its LLM prompts —
 * the LLM no longer has to guess what the script is doing, only how to
 * idiomatically port it.
 */
export class ParserAgent {
  constructor(private readonly out: vscode.OutputChannel) {}

  async run(extracted: ExtractedBundle): Promise<ParsedBundle> {
    const scripts: ParsedScript[] = [];
    let totalErrors = 0;

    for (const br of extracted.businessRules) {
      const { patterns, errors } = parseGlideScript(br.script);
      totalErrors += errors.length;
      scripts.push({
        sys_id: br.sys_id,
        artifactKind: 'businessRule',
        name: br.name,
        sourceTable: br.table,
        patterns,
        parseErrors: errors
      });
    }

    for (const si of extracted.scriptIncludes) {
      const { patterns, errors } = parseGlideScript(si.script);
      totalErrors += errors.length;
      scripts.push({
        sys_id: si.sys_id,
        artifactKind: 'scriptInclude',
        name: si.name,
        patterns,
        parseErrors: errors
      });
    }

    for (const cs of extracted.clientScripts) {
      const { patterns, errors } = parseGlideScript(cs.script);
      totalErrors += errors.length;
      scripts.push({
        sys_id: cs.sys_id,
        artifactKind: 'clientScript',
        name: cs.name,
        sourceTable: cs.table,
        patterns,
        parseErrors: errors
      });
    }

    for (const r of extracted.restResources) {
      const { patterns, errors } = parseGlideScript(r.operation_script);
      totalErrors += errors.length;
      scripts.push({
        sys_id: r.sys_id,
        artifactKind: 'scriptedRest',
        name: r.name,
        patterns,
        parseErrors: errors
      });
    }

    this.out.appendLine(
      `[stage2:parser] parsed ${scripts.length} scripts, ${totalErrors} non-fatal parse errors`
    );

    // Summary log for visibility — useful for debugging which patterns the
    // downstream prompts will receive.
    const totalGr = scripts.reduce((a, s) => a + s.patterns.glideRecords.length, 0);
    const totalGs = scripts.reduce((a, s) => a + s.patterns.glideSystemCalls.length, 0);
    const totalSi = scripts.reduce((a, s) => a + s.patterns.scriptIncludes.length, 0);
    this.out.appendLine(
      `[stage2:parser] aggregate patterns: ${totalGr} GlideRecord uses, ${totalGs} gs.* calls, ${totalSi} Script-Include refs`
    );

    return { extracted, scripts };
  }
}
