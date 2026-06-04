import * as vscode from 'vscode';
import {
  ArtifactMapping,
  GenerationTarget,
  ModulePlan,
  ParsedBundle,
  ScriptPatterns,
  SemanticPlan
} from './types';
import { sanitizePackage, stripPrefix, toPascal } from '../util/naming';

/**
 * Stage 3 — Mapper.
 *
 * Decides, for every artifact, *exactly* which Java classes will be
 * produced and in which Maven module. The output `SemanticPlan` is the
 * blueprint Stage 4 follows. By concentrating the routing decisions here:
 *   - Stage 4 generators stay dumb and reusable.
 *   - We can render a human-readable plan before generation, which
 *     helps with code review and debugging.
 *
 * No LLM. This is policy: where things go is deterministic, only
 * *what* the body of a method does is left to the LLM.
 */
export class MapperAgent {
  constructor(private readonly out: vscode.OutputChannel) {}

  run(parsed: ParsedBundle): SemanticPlan {
    const cfg = vscode.workspace.getConfiguration('snConvert');
    const root = cfg.get<string>('javaPackage') ?? 'com.acme.converted';
    const basePackage = `${root}.${sanitizePackage(parsed.extracted.application.scope)}`;

    const modules: ModulePlan[] = [
      { name: 'api',     purpose: 'DTOs and shared API contracts.' },
      { name: 'domain',  purpose: 'JPA entities and Spring Data repositories.' },
      { name: 'service', purpose: 'Business logic ported from Business Rules and Script Includes.' },
      { name: 'web',     purpose: 'Spring Boot bootstrap, REST controllers, Security configuration.' }
    ];

    const patternsBySysId = new Map<string, ScriptPatterns>(parsed.scripts.map(s => [s.sys_id, s.patterns]));
    const mappings: ArtifactMapping[] = [];

    // --- Tables → entity + repository + DTO + CRUD controller ---
    for (const table of parsed.extracted.tables) {
      const className = toPascal(stripPrefix(table.name));
      const targets: GenerationTarget[] = [
        { module: 'domain',  kind: 'entity',         className,                       relativePath: `entity/${className}.java` },
        { module: 'domain',  kind: 'repository',     className: `${className}Repository`, relativePath: `repository/${className}Repository.java` },
        { module: 'api',     kind: 'dto',            className: `${className}Dto`,    relativePath: `dto/${className}Dto.java` },
        { module: 'web',     kind: 'crudController', className: `${className}Controller`, relativePath: `controller/${className}Controller.java`,
          notes: 'Deterministic CRUD scaffold; refine after security review.' }
      ];
      mappings.push({ source: { kind: 'table', data: table }, targets });
    }

    // --- Business Rules → service method ---
    for (const br of parsed.extracted.businessRules) {
      const className = `${toPascal(safeIdent(br.name))}Service`;
      mappings.push({
        source: { kind: 'businessRule', data: br, parsed: patternsBySysId.get(br.sys_id) ?? emptyPatterns() },
        targets: [
          {
            module: 'service',
            kind: 'service',
            className,
            relativePath: `${className}.java`,
            notes: `Triggered ${br.when}; events: ${activeEvents(br)}`
          }
        ]
      });
    }

    // --- Script Includes → utility class ---
    for (const si of parsed.extracted.scriptIncludes) {
      const className = toPascal(safeIdent(si.api_name || si.name));
      mappings.push({
        source: { kind: 'scriptInclude', data: si, parsed: patternsBySysId.get(si.sys_id) ?? emptyPatterns() },
        targets: [
          {
            module: 'service',
            kind: 'utility',
            className,
            relativePath: `util/${className}.java`,
            notes: si.client_callable ? 'Was client_callable; consider exposing via controller.' : undefined
          }
        ]
      });
    }

    // --- Scripted REST → custom controller ---
    for (const r of parsed.extracted.restResources) {
      const className = `${toPascal(safeIdent(r.name))}Controller`;
      mappings.push({
        source: { kind: 'scriptedRest', data: r, parsed: patternsBySysId.get(r.sys_id) ?? emptyPatterns() },
        targets: [
          {
            module: 'web',
            kind: 'controller',
            className,
            relativePath: `controller/${className}.java`,
            notes: `${r.http_method} ${r.relative_path}`
          }
        ]
      });
    }

    // --- ACLs → SecurityFilterChain config rules (aggregated downstream) ---
    for (const acl of parsed.extracted.acls) {
      mappings.push({
        source: { kind: 'acl', data: acl },
        targets: [
          {
            module: 'web',
            kind: 'securityRule',
            className: 'SecurityConfig',
            relativePath: 'config/SecurityConfig.java',
            notes: `Contributes one authorization rule for ${acl.operation} on ${acl.table}`
          }
        ]
      });
    }

    // --- Client Scripts: deferred to Stage 4 React generator, not in Java plan ---
    // (the React side has its own routing; we don't crowd the Java plan with these)

    this.out.appendLine(
      `[stage3:mapper] plan: ${mappings.length} mappings across ${modules.length} modules`
    );

    return { basePackage, modules, mappings };
  }
}

function activeEvents(br: { action_insert?: boolean; action_update?: boolean; action_delete?: boolean; action_query?: boolean }) {
  return (
    [
      br.action_insert && 'insert',
      br.action_update && 'update',
      br.action_delete && 'delete',
      br.action_query && 'query'
    ]
      .filter(Boolean)
      .join(', ') || 'unspecified'
  );
}

function safeIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, '_');
}

function emptyPatterns(): ScriptPatterns {
  return {
    glideRecords: [],
    glideSystemCalls: [],
    current: { reads: [], writes: [], operationChecks: [] },
    scriptIncludes: [],
    abortAction: false,
    jsonOps: [],
    externalCalls: []
  };
}
