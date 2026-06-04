import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotLLM } from '../llm/copilot';
import { ArtifactMapping, GeneratedFile } from '../pipeline/types';
import { pluralize, stripPrefix, toCamel, toPascal } from '../util/naming';
import { renderPatterns } from './serviceGenerator';

export class ControllerGenerator {
  constructor(private readonly llm: CopilotLLM, private readonly basePackage: string, private readonly outRoot: string) {}

  async generate(mapping: ArtifactMapping, allTables: string[], token: vscode.CancellationToken): Promise<GeneratedFile[]> {
    // CRUD controllers — deterministic, no LLM.
    if (mapping.source.kind === 'table') {
      const target = mapping.targets.find(t => t.kind === 'crudController');
      if (!target) return [];
      return [this.renderCrud(mapping.source.data.name, mapping.source.data.sys_id, target.className, target.relativePath)];
    }

    // Scripted REST — LLM-driven.
    if (mapping.source.kind === 'scriptedRest') {
      const r = mapping.source.data;
      const p = mapping.source.parsed;
      const target = mapping.targets[0];
      const known = allTables.map(t => toPascal(stripPrefix(t))).join(', ');

      const prompt = `Translate this ServiceNow Scripted REST operation into a Spring @RestController class.

== Operation ==
api_id:        ${r.api_id}
http_method:   ${r.http_method}
relative_path: ${r.relative_path}
auth required: ${r.requires_authentication ?? true}

== Pre-analysis from AST ==
${renderPatterns(p)}

== Available JPA entities ==
${known}

== Requirements ==
- Class ${target.className} in package ${this.basePackage}.web.controller.
- Use @${r.http_method.charAt(0)}${r.http_method.slice(1).toLowerCase()}Mapping("${r.relative_path}").
- Map request.body / pathParams / queryParams to @RequestBody / @PathVariable / @RequestParam.
- For every GlideRecord pattern above, use the appropriate Spring Data repository injected via constructor.
- Output exactly one fenced Java block.`;
      const code = await this.llm.completeCode({
        system: 'You are a senior Spring Boot engineer. You output only one fenced Java code block, no commentary.',
        user: prompt,
        language: 'java',
        token
      });
      const finalCode = /^\s*package\s+/m.test(code) ? code : `package ${this.basePackage}.web.controller;\n\n${code}`;
      return [
        {
          path: path.join(this.outRoot, 'web/src/main/java', this.basePackage.replace(/\./g, '/'), 'web', target.relativePath),
          content: finalCode,
          language: 'java',
          origin: r.sys_id,
          llmInvolved: true
        }
      ];
    }
    return [];
  }

  private renderCrud(tableName: string, sysId: string, className: string, relativePath: string): GeneratedFile {
    const entityName = toPascal(stripPrefix(tableName));
    const route = `/api/${pluralize(toCamel(stripPrefix(tableName)))}`;
    const content = `package ${this.basePackage}.web.controller;

import ${this.basePackage}.domain.entity.${entityName};
import ${this.basePackage}.domain.repository.${entityName}Repository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("${route}")
public class ${className} {

    private final ${entityName}Repository repository;

    public ${className}(${entityName}Repository repository) {
        this.repository = repository;
    }

    @GetMapping
    public List<${entityName}> list() { return repository.findAll(); }

    @GetMapping("/{sysId}")
    public ResponseEntity<${entityName}> get(@PathVariable String sysId) {
        return repository.findById(sysId).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ${entityName} create(@RequestBody ${entityName} body) { return repository.save(body); }

    @PutMapping("/{sysId}")
    public ResponseEntity<${entityName}> update(@PathVariable String sysId, @RequestBody ${entityName} body) {
        if (!repository.existsById(sysId)) return ResponseEntity.notFound().build();
        body.setSysId(sysId);
        return ResponseEntity.ok(repository.save(body));
    }

    @DeleteMapping("/{sysId}")
    public ResponseEntity<Void> delete(@PathVariable String sysId) {
        if (!repository.existsById(sysId)) return ResponseEntity.notFound().build();
        repository.deleteById(sysId);
        return ResponseEntity.noContent().build();
    }
}
`;
    return {
      path: path.join(this.outRoot, 'web/src/main/java', this.basePackage.replace(/\./g, '/'), 'web', relativePath),
      content,
      language: 'java',
      origin: sysId,
      llmInvolved: false
    };
  }
}
