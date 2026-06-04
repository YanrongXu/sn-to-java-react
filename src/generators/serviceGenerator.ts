import * as vscode from 'vscode';
import * as path from 'path';
import { readFileSync } from 'fs';
import { CopilotLLM } from '../llm/copilot';
import { ArtifactMapping, GeneratedFile, ScriptPatterns } from '../pipeline/types';
import { stripPrefix, toPascal } from '../util/naming';

/**
 * Service generator. Consumes a parsed Business Rule and the *patterns*
 * Stage 2 extracted from its script. The patterns are injected into the
 * prompt as a structured pre-analysis, which substantially raises the
 * quality of the LLM's output: instead of asking Copilot to re-discover
 * what GlideRecord operations the script uses, we hand it that information
 * and ask it to produce the Java equivalent.
 */
export class ServiceGenerator {
  private readonly mappingGuide: string;
  constructor(private readonly llm: CopilotLLM, private readonly basePackage: string, private readonly outRoot: string) {
    this.mappingGuide = loadPrompt('serviceFromBusinessRule.md');
  }

  async generate(mapping: ArtifactMapping, allTables: string[], token: vscode.CancellationToken): Promise<GeneratedFile[]> {
    if (mapping.source.kind !== 'businessRule') return [];
    const br = mapping.source.data;
    const patterns = mapping.source.parsed;
    const target = mapping.targets[0];

    const knownEntities = allTables.map(t => toPascal(stripPrefix(t))).join(', ');

    const prompt = `Convert this ServiceNow Business Rule into a Spring @Service class.

== Business Rule ==
name:   ${br.name}
table:  ${br.table}
when:   ${br.when}
events: ${eventList(br)}
order:  ${br.order}
filter: ${br.filter_condition || '(none)'}
cond:   ${br.condition || '(none)'}

== Pre-analysis from AST (Stage 2) ==
${renderPatterns(patterns)}

== Available JPA entities you may inject ==
${knownEntities}

== Mapping guide ==
${this.mappingGuide}

== Requirements ==
- Single class ${target.className} in package ${this.basePackage}.service.
- Constructor injection of the repositories you need (use only the ones implied by the patterns above).
- Translate each GlideRecord block listed above into the appropriate Spring Data call (derived method or JPQL via EntityManager).
- For every gs.* call listed above, follow the mapping guide; if uncertain, leave a // TODO(sn-convert): note.
- If abortAction is true, throw a new RuntimeException with a clear message (caller maps to HTTP 409).
- Output exactly one fenced Java block. No commentary.`;

    const code = await this.llm.completeCode({
      system:
        'You are a senior Spring Boot engineer porting ServiceNow Business Rules to idiomatic Java. ' +
        'You output exactly one fenced Java block. You always import what you use. You mark uncertain ' +
        'conversions with // TODO(sn-convert): comments.',
      user: prompt,
      language: 'java',
      token
    });

    const finalCode = ensurePackage(code, `${this.basePackage}.service`);
    return [
      {
        path: path.join(this.outRoot, 'service/src/main/java', this.basePackage.replace(/\./g, '/'), 'service', target.relativePath),
        content: finalCode,
        language: 'java',
        origin: br.sys_id,
        llmInvolved: true
      }
    ];
  }
}

function eventList(br: { action_insert?: boolean; action_update?: boolean; action_delete?: boolean; action_query?: boolean }) {
  return (
    [br.action_insert && 'insert', br.action_update && 'update', br.action_delete && 'delete', br.action_query && 'query']
      .filter(Boolean)
      .join(', ') || 'unspecified'
  );
}

/**
 * Renders the parsed patterns as a structured block for the LLM. Order matters
 * (most actionable first): GlideRecord usage, then gs.* calls, then current.*,
 * then Script-Includes used.
 */
export function renderPatterns(p: ScriptPatterns): string {
  const lines: string[] = [];

  if (p.glideRecords.length === 0) lines.push('GlideRecord uses: (none)');
  else {
    lines.push('GlideRecord uses:');
    for (const u of p.glideRecords) {
      const q = u.queries.length
        ? u.queries.map(qq => `${qq.field} ${qq.op} ${qq.value ?? ''}`.trim()).join('; ')
        : '(no filter)';
      const ops = u.operations.join(',') || '(none)';
      lines.push(`  - var=${u.variable} table=${u.table ?? '?'} ops=${ops} reads=[${u.reads.join(',')}] writes=[${u.writes.join(',')}] queries=[${q}]`);
    }
  }

  if (p.glideSystemCalls.length === 0) lines.push('gs.* calls: (none)');
  else {
    lines.push('gs.* calls:');
    for (const c of p.glideSystemCalls) {
      lines.push(`  - gs.${c.method}(${c.firstArgLiteral !== undefined ? JSON.stringify(c.firstArgLiteral) + (c.argCount > 1 ? ', …' : '') : '…'.repeat(c.argCount > 0 ? 1 : 0)})`);
    }
  }

  const cr = p.current;
  lines.push(`current.* reads:  [${cr.reads.join(', ')}]`);
  lines.push(`current.* writes: [${cr.writes.join(', ')}]`);
  if (cr.operationChecks.length) lines.push(`current.operation() checks: ${cr.operationChecks.length} (handle by method-name semantics, not runtime branching)`);

  if (p.scriptIncludes.length) {
    lines.push('Script-Includes referenced:');
    for (const s of p.scriptIncludes) lines.push(`  - ${s.apiName}${s.method ? '.' + s.method + '()' : ''}`);
  }

  if (p.abortAction) lines.push('setAbortAction(true) called → translate to thrown exception.');
  if (p.jsonOps.length) lines.push(`JSON ops: ${p.jsonOps.join(', ')} → use Jackson ObjectMapper.`);

  return lines.join('\n');
}

function ensurePackage(code: string, pkg: string): string {
  if (/^\s*package\s+/m.test(code)) return code;
  return `package ${pkg};\n\n${code}`;
}

function loadPrompt(name: string): string {
  try {
    return readFileSync(path.join(__dirname, '..', '..', 'prompts', name), 'utf8');
  } catch {
    return '';
  }
}
