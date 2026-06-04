import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotLLM } from '../llm/copilot';
import { ExtractedBundle, GeneratedFile, ParsedScript } from '../pipeline/types';
import { pluralize, stripPrefix, toCamel, toKebab, toPascal } from '../util/naming';

/**
 * React generator. Produces a list page + detail page per table, plus
 * uses translated client scripts (Stage 2 parsed) as handler stubs.
 */
export class ReactGenerator {
  constructor(private readonly llm: CopilotLLM, private readonly outRoot: string) {}

  async generateForBundle(extracted: ExtractedBundle, parsedScripts: ParsedScript[], token: vscode.CancellationToken): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];
    const clientScriptsByTable = new Map<string, ParsedScript[]>();
    for (const s of parsedScripts) {
      if (s.artifactKind === 'clientScript' && s.sourceTable) {
        const arr = clientScriptsByTable.get(s.sourceTable) ?? [];
        arr.push(s);
        clientScriptsByTable.set(s.sourceTable, arr);
      }
    }

    for (const table of extracted.tables) {
      if (token.isCancellationRequested) break;
      const typeName = toPascal(stripPrefix(table.name));
      const route = toKebab(stripPrefix(table.name));
      const fieldList = table.columns.map(c => ({ key: c.element, label: c.column_label }));

      files.push(this.tsType(typeName, fieldList));
      files.push(this.listPage(typeName, route, fieldList));

      const scripts = clientScriptsByTable.get(table.name) ?? [];
      const extras = scripts.length ? await this.translateHandlers(typeName, scripts, token) : '';
      files.push(this.detailPage(typeName, route, fieldList, extras));
    }
    return files;
  }

  private tsType(typeName: string, fields: { key: string; label: string }[]): GeneratedFile {
    const content = `export interface ${typeName} {
  sysId: string;
${fields.map(f => `  ${toCamel(stripPrefix(f.key))}?: unknown;  // ${f.label}`).join('\n')}
}
`;
    return { path: path.join(this.outRoot, 'frontend/src/types', `${typeName}.ts`), content, language: 'ts', llmInvolved: false };
  }

  private listPage(typeName: string, route: string, fields: { key: string; label: string }[]): GeneratedFile {
    const cols = fields.slice(0, 5);
    const apiPath = `/${pluralize(toCamel(stripPrefix(route)))}`;
    const content = `import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ${typeName} } from '../types/${typeName}';

export default function ${typeName}List() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['${route}'],
    queryFn: () => api<${typeName}[]>('GET', '${apiPath}')
  });
  if (isLoading) return <p>Loading…</p>;
  if (error) return <p style={{ color: 'crimson' }}>Error: {(error as Error).message}</p>;
  return (
    <section>
      <h2>${typeName}</h2>
      <table cellPadding={6}>
        <thead><tr>${cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}<th></th></tr></thead>
        <tbody>
          {data?.map(row => (
            <tr key={row.sysId}>
${cols.map(c => `              <td>{String((row as any).${toCamel(stripPrefix(c.key))} ?? '')}</td>`).join('\n')}
              <td><Link to={\`/${route}/\${row.sysId}\`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
`;
    return { path: path.join(this.outRoot, 'frontend/src/pages', `${typeName}List.tsx`), content, language: 'tsx', llmInvolved: false };
  }

  private detailPage(typeName: string, route: string, fields: { key: string; label: string }[], extras: string): GeneratedFile {
    const apiPath = `/${pluralize(toCamel(stripPrefix(route)))}`;
    const inputs = fields.map(f => {
      const name = toCamel(stripPrefix(f.key));
      return `        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <span style={{ display: 'inline-block', width: 200 }}>${escapeHtml(f.label)}</span>
          <input value={String((form as any).${name} ?? '')} onChange={e => handleFieldChange('${name}', e.target.value)} />
        </label>`;
    }).join('\n');

    const content = `import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ${typeName} } from '../types/${typeName}';

export default function ${typeName}Detail() {
  const { sysId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = !sysId || sysId === 'new';

  const { data, isLoading } = useQuery({
    queryKey: ['${route}', sysId],
    queryFn: () => api<${typeName}>('GET', \`${apiPath}/\${sysId}\`),
    enabled: !isNew
  });

  const [form, setFormState] = useState<Partial<${typeName}>>({});
  const setForm = (patch: Partial<${typeName}>) => setFormState(prev => ({ ...prev, ...patch }));
  useEffect(() => { if (data) setFormState(data); }, [data]);

  const save = useMutation({
    mutationFn: () => isNew
      ? api<${typeName}>('POST', '${apiPath}', form)
      : api<${typeName}>('PUT', \`${apiPath}/\${sysId}\`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['${route}'] }); navigate('/${route}'); }
  });

  function handleFieldChange(field: string, value: unknown) { setForm({ [field]: value } as Partial<${typeName}>); }
  function handleSubmit(): boolean { return true; }
${extras}

  if (!isNew && isLoading) return <p>Loading…</p>;
  return (
    <section>
      <h2>${typeName} {isNew ? '(new)' : sysId}</h2>
${inputs}
      <div style={{ marginTop: '1rem' }}>
        <button onClick={() => { if (handleSubmit()) save.mutate(); }} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button style={{ marginLeft: '0.5rem' }} onClick={() => navigate('/${route}')}>Cancel</button>
      </div>
    </section>
  );
}
`;
    return { path: path.join(this.outRoot, 'frontend/src/pages', `${typeName}Detail.tsx`), content, language: 'tsx', llmInvolved: !!extras };
  }

  private async translateHandlers(typeName: string, scripts: ParsedScript[], token: vscode.CancellationToken): Promise<string> {
    const prompt = `Translate these ServiceNow client scripts for table ${typeName} into React hooks and handlers.

Mapping conventions:
- g_form.setValue('x', v)  -> setForm({ x: v })
- g_form.getValue('x')     -> form.x
- g_form.setVisible(...)   -> emit a useState for visibility; mark TODO(sn-convert) at the wiring point
- g_form.setMandatory(...) -> same
- g_form.addErrorMessage() -> alert() and return false in handleSubmit
- g_form.addInfoMessage()  -> alert(), TODO(sn-convert) to wire to toast
- onLoad   -> useEffect with [] deps
- onChange -> case branch inside handleFieldChange
- onSubmit -> return value from handleSubmit (false to cancel)

Scripts:
${scripts.map(s => `// ${s.name}\n${s.patterns.glideRecords.length ? '/* AST: contains GlideRecord usage — uncommon in client scripts; review carefully */' : ''}`).join('\n')}

Output exactly one fenced tsx block containing only the additional hooks and case logic to merge into handleFieldChange/handleSubmit. No imports, no JSX, no surrounding component.`;
    try {
      const code = await this.llm.completeCode({
        system: 'You output a single fenced tsx code block with hooks/handlers only. No imports, no JSX, no commentary.',
        user: prompt, language: 'tsx', token
      });
      return `\n  // --- translated from ServiceNow client scripts ---\n${indent(code, '  ')}\n  // --- end ---\n`;
    } catch (e) {
      return `\n  // TODO(sn-convert): client script translation failed: ${(e as Error).message}\n`;
    }
  }
}

function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function indent(s: string, prefix: string): string { return s.split('\n').map(l => prefix + l).join('\n'); }
