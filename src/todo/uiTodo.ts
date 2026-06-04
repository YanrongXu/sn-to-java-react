import { SnAppBundle, SnClientScript } from '../servicenow/types';

/**
 * Build a deterministic TODO checklist from extracted UI-facing artifacts so
 * teams can track manual migration work before/after code generation.
 */
export function buildUiTodoMarkdown(bundle: SnAppBundle): string {
  const lines: string[] = [];
  lines.push(`# UI migration TODO: ${bundle.application.name}`);
  lines.push('');
  lines.push(`Scope: \`${bundle.application.scope}\``);
  lines.push('');
  lines.push('## Discovered interface artifacts');
  lines.push(
    `- UI Pages: **${bundle.uiPages.length}**`
  );
  lines.push(
    `- Client Scripts: **${bundle.clientScripts.length}**`
  );
  lines.push(
    `- Scripted REST resources: **${bundle.restResources.length}**`
  );
  lines.push(
    `- Tables: **${bundle.tables.length}**`
  );
  lines.push('');

  lines.push('## UI pages');
  if (bundle.uiPages.length === 0) {
    lines.push('- No legacy UI Pages found.');
  } else {
    for (const p of sortByName(bundle.uiPages)) {
      lines.push(`- [ ] Migrate UI Page \`${p.name}\` to React route/component`);
    }
  }
  lines.push('');

  lines.push('## Client script migration');
  if (bundle.clientScripts.length === 0) {
    lines.push('- No client scripts found.');
  } else {
    for (const s of sortScripts(bundle.clientScripts)) {
      const field = s.field_name ? `, field: \`${s.field_name}\`` : '';
      lines.push(`- [ ] Port \`${s.name}\` (\`${s.type}\`) for table \`${s.table}\`${field}`);
    }
  }
  lines.push('');

  lines.push('## Frontend API integration');
  if (bundle.restResources.length === 0) {
    lines.push('- No Scripted REST resources found.');
  } else {
    for (const r of bundle.restResources.sort((a, b) => a.relative_path.localeCompare(b.relative_path))) {
      lines.push(`- [ ] Wire endpoint \`${r.http_method} ${r.relative_path}\` into frontend data layer`);
    }
  }
  lines.push('');

  lines.push('## Data UI coverage');
  if (bundle.tables.length === 0) {
    lines.push('- No scoped tables found.');
  } else {
    for (const t of bundle.tables.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- [ ] Validate list/detail/create/edit UX for table \`${t.name}\``);
    }
  }
  lines.push('');

  lines.push('## Security and validation follow-up');
  const scriptedAclCount = bundle.acls.filter(a => !!a.script || !!a.condition).length;
  lines.push(`- [ ] Review generated SecurityConfig rules for ${bundle.acls.length} ACL entries`);
  if (scriptedAclCount > 0) {
    lines.push(`- [ ] Port ${scriptedAclCount} ACL script/condition rules to custom AuthorizationManager`);
  }
  lines.push('- [ ] Confirm role mapping and endpoint authorization with business owners');
  lines.push('');

  lines.push('## Notes');
  lines.push('- Generated automatically from ServiceNow extraction (no LLM).');
  lines.push('- Keep this file as a living checklist during migration reviews.');
  lines.push('');

  return lines.join('\n');
}

export function mergeChecklistProgress(existingMarkdown: string | undefined, freshMarkdown: string): string {
  if (!existingMarkdown) return freshMarkdown;

  const checked = new Set<string>();
  for (const line of existingMarkdown.split(/\r?\n/)) {
    const m = line.match(/^- \[(x|X| )\] (.+)$/);
    if (m && m[1].toLowerCase() === 'x') {
      checked.add(m[2].trim());
    }
  }
  if (!checked.size) return freshMarkdown;

  return freshMarkdown
    .split(/\r?\n/)
    .map(line => {
      const m = line.match(/^- \[(x|X| )\] (.+)$/);
      if (!m) return line;
      const task = m[2].trim();
      return checked.has(task) ? `- [x] ${task}` : `- [ ] ${task}`;
    })
    .join('\n');
}

export function checklistStats(markdown: string): { total: number; done: number; percent: number } {
  let total = 0;
  let done = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^- \[(x|X| )\] (.+)$/);
    if (!m) continue;
    total += 1;
    if (m[1].toLowerCase() === 'x') done += 1;
  }
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, percent };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function sortScripts(items: SnClientScript[]): SnClientScript[] {
  return [...items].sort((a, b) => {
    const tableCmp = a.table.localeCompare(b.table);
    if (tableCmp !== 0) return tableCmp;
    const typeCmp = a.type.localeCompare(b.type);
    if (typeCmp !== 0) return typeCmp;
    return a.name.localeCompare(b.name);
  });
}
