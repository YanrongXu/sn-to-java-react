import * as path from 'path';
import { GeneratedFile } from '../pipeline/types';
import { SnColumn, SnTable } from '../servicenow/types';

/**
 * Produces a Liquibase changelog tree:
 *   db/changelog/db.changelog-master.xml         — includes everything below in order
 *   db/changelog/changes/001-<table>-init.xml    — createTable per ServiceNow table
 *
 * Database-agnostic — no Oracle/Postgres-specific syntax. Liquibase
 * resolves driver-specific DDL at runtime.
 */
export function buildLiquibase(tables: SnTable[], outRoot: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const changelogRoot = path.join(outRoot, 'backend/web/src/main/resources/db/changelog');
  const changesDir = path.join(changelogRoot, 'changes');

  // Per-table changesets
  let i = 1;
  const includes: string[] = [];
  for (const t of tables) {
    const id = String(i).padStart(3, '0');
    const filename = `${id}-${slug(t.name)}-init.xml`;
    files.push({
      path: path.join(changesDir, filename),
      content: renderTableChangeset(t, `${id}-${slug(t.name)}-init`),
      language: 'xml',
      structural: true,
      llmInvolved: false
    });
    includes.push(`    <include file="changes/${filename}" relativeToChangelogFile="true"/>`);
    i++;
  }

  // Master
  files.push({
    path: path.join(changelogRoot, 'db.changelog-master.xml'),
    content: `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">

${includes.join('\n')}

</databaseChangeLog>
`,
    language: 'xml',
    structural: true,
    llmInvolved: false
  });

  return files;
}

function renderTableChangeset(t: SnTable, changeSetId: string): string {
  const cols = [
    {
      name: 'sys_id',
      type: 'VARCHAR(32)',
      constraints: '<constraints primaryKey="true" nullable="false"/>'
    },
    ...t.columns.map(c => ({
      name: c.element,
      type: liquibaseType(c),
      constraints: c.mandatory ? '<constraints nullable="false"/>' : ''
    }))
  ];

  const colXml = cols
    .map(
      c => `            <column name="${c.name}" type="${c.type}">${c.constraints ? '\n                ' + c.constraints + '\n            ' : ''}</column>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">

    <changeSet id="${changeSetId}" author="sn-convert">
        <createTable tableName="${t.name}">
${colXml}
        </createTable>
    </changeSet>

</databaseChangeLog>
`;
}

function liquibaseType(c: SnColumn): string {
  switch (c.internal_type) {
    case 'integer':
    case 'longint':         return 'BIGINT';
    case 'decimal':
    case 'currency':
    case 'price':
    case 'float':           return 'DECIMAL(18,4)';
    case 'boolean':         return 'BOOLEAN';
    case 'glide_date':      return 'DATE';
    case 'glide_date_time':
    case 'glide_time':
    case 'due_date':        return 'TIMESTAMP';
    case 'reference':       return 'VARCHAR(32)';
    default:                return `VARCHAR(${c.max_length ?? 255})`;
  }
}

function slug(s: string): string { return s.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(); }
