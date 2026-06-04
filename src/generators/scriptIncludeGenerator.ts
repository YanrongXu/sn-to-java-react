import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotLLM } from '../llm/copilot';
import { ArtifactMapping, GeneratedFile } from '../pipeline/types';
import { renderPatterns } from './serviceGenerator';
import { stripPrefix, toPascal } from '../util/naming';

export class ScriptIncludeGenerator {
  constructor(private readonly llm: CopilotLLM, private readonly basePackage: string, private readonly outRoot: string) {}

  async generate(mapping: ArtifactMapping, allTables: string[], token: vscode.CancellationToken): Promise<GeneratedFile[]> {
    if (mapping.source.kind !== 'scriptInclude') return [];
    const si = mapping.source.data;
    const p = mapping.source.parsed;
    const target = mapping.targets[0];
    const known = allTables.map(t => toPascal(stripPrefix(t))).join(', ');

    const prompt = `Translate this ServiceNow Script Include into a Spring @Component utility class.

== Script Include ==
name:     ${si.name}
api_name: ${si.api_name}
description: ${si.description || '(none)'}

== Pre-analysis from AST ==
${renderPatterns(p)}

== Available JPA entities ==
${known}

== Requirements ==
- Class ${target.className} in package ${this.basePackage}.service.util.
- @Component, constructor injection for repositories you need.
- Preserve method signatures (translate JS function names to Java methods).
- For prototype-style classes (X.prototype.method = function…), preserve each prototype method as a Java method.
- Output exactly one fenced Java block.`;

    const code = await this.llm.completeCode({
      system: 'You are a senior Spring Boot engineer. You output one fenced Java block. You import what you use.',
      user: prompt,
      language: 'java',
      token
    });
    const finalCode = /^\s*package\s+/m.test(code) ? code : `package ${this.basePackage}.service.util;\n\n${code}`;
    return [
      {
        path: path.join(this.outRoot, 'service/src/main/java', this.basePackage.replace(/\./g, '/'), 'service', target.relativePath),
        content: finalCode,
        language: 'java',
        origin: si.sys_id,
        llmInvolved: true
      }
    ];
  }
}
