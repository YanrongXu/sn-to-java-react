import * as vscode from 'vscode';
import {
  SnAcl,
  SnAppBundle,
  SnApplication,
  SnBusinessRule,
  SnClientScript,
  SnColumn,
  SnCredentials,
  SnScriptInclude,
  SnScriptedRestResource,
  SnTable,
  SnUIPage
} from './types';

/**
 * Reads scoped-application metadata directly from a ServiceNow instance
 * via the Table API. Basic auth for the scaffold; swap to OAuth in
 * SecretStorage when you wire this into production.
 *
 * All queries are read-only (GET). Nothing is mutated on the SN side.
 */
export class ServiceNowClient {
  private readonly authHeader: string;

  constructor(private readonly creds: SnCredentials, private readonly out: vscode.OutputChannel) {
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  // ---------- Public surface ----------

  async listScopedApplications(): Promise<SnApplication[]> {
    const rows = await this.queryTable<any>('sys_app', {
      sysparm_query: 'active=true^ORDERBYname',
      sysparm_fields: 'sys_id,name,scope,short_description,version'
    });
    return rows;
  }

  /** Resolve an application by either sys_id or scope string. */
  async resolveApplication(sysIdOrScope: string): Promise<SnApplication> {
    const isSysId = /^[a-f0-9]{32}$/i.test(sysIdOrScope);
    const query = isSysId ? `sys_id=${sysIdOrScope}` : `scope=${sysIdOrScope}`;
    const rows = await this.queryTable<SnApplication>('sys_app', {
      sysparm_query: query,
      sysparm_fields: 'sys_id,name,scope,short_description,version',
      sysparm_limit: '1'
    });
    if (!rows.length) throw new Error(`No scoped application found for "${sysIdOrScope}"`);
    return rows[0];
  }

  async fetchBundle(app: SnApplication): Promise<SnAppBundle> {
    this.out.appendLine(`[SN] fetching artifacts for scope=${app.scope}`);
    const [tables, businessRules, scriptIncludes, clientScripts, restResources, uiPages, acls] = await Promise.all([
      this.fetchTables(app.scope),
      this.fetchBusinessRules(app.scope),
      this.fetchScriptIncludes(app.scope),
      this.fetchClientScripts(app.scope),
      this.fetchScriptedRest(app.scope),
      this.fetchUiPages(app.scope),
      this.fetchAcls(app.scope)
    ]);
    return { application: app, tables, businessRules, scriptIncludes, clientScripts, restResources, uiPages, acls };
  }

  // ---------- Artifact-specific queries ----------

  private async fetchTables(scope: string): Promise<SnTable[]> {
    const tableRows = await this.queryTable<any>('sys_db_object', {
      sysparm_query: `sys_scope.scope=${scope}`,
      sysparm_fields: 'sys_id,name,label,super_class.name,is_extendable'
    });

    const tables: SnTable[] = [];
    for (const t of tableRows) {
      const columns = await this.fetchColumns(t.name);
      tables.push({
        sys_id: t.sys_id,
        name: t.name,
        label: t.label,
        super_class: t['super_class.name'] || undefined,
        is_extendable: t.is_extendable === 'true' || t.is_extendable === true,
        columns
      });
    }
    return tables;
  }

  private async fetchColumns(tableName: string): Promise<SnColumn[]> {
    const rows = await this.queryTable<any>('sys_dictionary', {
      sysparm_query: `name=${tableName}^elementISNOTEMPTY`,
      sysparm_fields: 'element,column_label,internal_type,max_length,mandatory,reference,default_value,read_only'
    });
    return rows.map(r => ({
      element: r.element,
      column_label: r.column_label,
      internal_type: typeof r.internal_type === 'object' ? r.internal_type.value : r.internal_type,
      max_length: r.max_length ? Number(r.max_length) : undefined,
      mandatory: r.mandatory === 'true',
      reference_table: typeof r.reference === 'object' ? r.reference.value : r.reference || undefined,
      default_value: r.default_value || undefined,
      read_only: r.read_only === 'true'
    }));
  }

  private async fetchBusinessRules(scope: string): Promise<SnBusinessRule[]> {
    const rows = await this.queryTable<any>('sys_script', {
      sysparm_query: `sys_scope.scope=${scope}^active=true`,
      sysparm_fields:
        'sys_id,name,collection,when,order,active,action_insert,action_update,action_delete,action_query,condition,filter_condition,script'
    });
    return rows.map(r => ({
      sys_id: r.sys_id,
      name: r.name,
      table: typeof r.collection === 'object' ? r.collection.value : r.collection,
      when: r.when as SnBusinessRule['when'],
      order: Number(r.order ?? 100),
      active: r.active === 'true',
      action_insert: r.action_insert === 'true',
      action_update: r.action_update === 'true',
      action_delete: r.action_delete === 'true',
      action_query: r.action_query === 'true',
      condition: r.condition || undefined,
      filter_condition: r.filter_condition || undefined,
      script: r.script || ''
    }));
  }

  private async fetchScriptIncludes(scope: string): Promise<SnScriptInclude[]> {
    const rows = await this.queryTable<any>('sys_script_include', {
      sysparm_query: `sys_scope.scope=${scope}^active=true`,
      sysparm_fields: 'sys_id,name,api_name,script,access,client_callable,description'
    });
    return rows.map(r => ({
      sys_id: r.sys_id,
      name: r.name,
      api_name: r.api_name,
      script: r.script,
      access: r.access,
      client_callable: r.client_callable === 'true',
      description: r.description
    }));
  }

  private async fetchClientScripts(scope: string): Promise<SnClientScript[]> {
    const rows = await this.queryTable<any>('sys_script_client', {
      sysparm_query: `sys_scope.scope=${scope}^active=true`,
      sysparm_fields: 'sys_id,name,table,type,field_name,script'
    });
    return rows.map(r => ({
      sys_id: r.sys_id,
      name: r.name,
      table: r.table,
      type: r.type as SnClientScript['type'],
      field_name: r.field_name || undefined,
      script: r.script
    }));
  }

  private async fetchScriptedRest(scope: string): Promise<SnScriptedRestResource[]> {
    const rows = await this.queryTable<any>('sys_ws_operation', {
      sysparm_query: `sys_scope.scope=${scope}^active=true`,
      sysparm_fields: 'sys_id,name,web_service_definition.api_id,http_method,relative_path,operation_script,requires_authentication'
    });
    return rows.map(r => ({
      sys_id: r.sys_id,
      name: r.name,
      api_id: r['web_service_definition.api_id'] || '',
      http_method: r.http_method,
      relative_path: r.relative_path,
      operation_script: r.operation_script,
      requires_authentication: r.requires_authentication === 'true'
    }));
  }

  private async fetchUiPages(scope: string): Promise<SnUIPage[]> {
    const rows = await this.queryTable<any>('sys_ui_page', {
      sysparm_query: `sys_scope.scope=${scope}`,
      sysparm_fields: 'sys_id,name,html,client_script,processing_script'
    });
    return rows;
  }

  private async fetchAcls(scope: string): Promise<SnAcl[]> {
    const rows = await this.queryTable<any>('sys_security_acl', {
      sysparm_query: `sys_scope.scope=${scope}^active=true`,
      sysparm_fields: 'sys_id,name,operation,script,condition'
    });
    const roleMap = await this.fetchAclRoles(rows.map(r => String(r.sys_id)).filter(Boolean));

    return rows.map(r => ({
      sys_id: r.sys_id,
      name: r.name,
      table: typeof r.name === 'string' ? r.name.split('.')[0] : '',
      operation: r.operation,
      roles: roleMap.get(String(r.sys_id)) ?? [],
      script: r.script,
      condition: r.condition
    }));
  }

  private async fetchAclRoles(aclIds: string[]): Promise<Map<string, string[]>> {
    if (!aclIds.length) return new Map();

    const aclToRoleIds = new Map<string, Set<string>>();
    const roleIds = new Set<string>();

    for (const chunk of this.chunk(aclIds, 80)) {
      const rows = await this.queryTable<any>('sys_security_acl_role', {
        sysparm_query: `sys_security_aclIN${chunk.join(',')}`,
        sysparm_fields: 'sys_security_acl,sys_user_role'
      });

      for (const row of rows) {
        const aclId = this.refValue(row.sys_security_acl);
        const roleId = this.refValue(row.sys_user_role);
        if (!aclId || !roleId) continue;
        const set = aclToRoleIds.get(aclId) ?? new Set<string>();
        set.add(roleId);
        aclToRoleIds.set(aclId, set);
        roleIds.add(roleId);
      }
    }

    if (!roleIds.size) return new Map();

    const roleNameById = new Map<string, string>();
    for (const chunk of this.chunk([...roleIds], 80)) {
      const roles = await this.queryTable<any>('sys_user_role', {
        sysparm_query: `sys_idIN${chunk.join(',')}`,
        sysparm_fields: 'sys_id,name'
      });
      for (const role of roles) {
        const id = String(role.sys_id ?? '');
        const name = String(role.name ?? '').trim();
        if (id && name) roleNameById.set(id, name);
      }
    }

    const result = new Map<string, string[]>();
    for (const [aclId, ids] of aclToRoleIds) {
      const names = [...ids]
        .map(id => roleNameById.get(id))
        .filter((name): name is string => !!name);
      result.set(aclId, [...new Set(names)].sort((a, b) => a.localeCompare(b)));
    }
    return result;
  }

  private refValue(v: unknown): string | undefined {
    if (!v) return undefined;
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'value' in v && typeof (v as { value?: unknown }).value === 'string') {
      return (v as { value: string }).value;
    }
    return undefined;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  // ---------- Plumbing ----------

  private async queryTable<T>(table: string, params: Record<string, string>): Promise<T[]> {
    const url = new URL(`${this.creds.instanceUrl.replace(/\/$/, '')}/api/now/table/${table}`);
    url.searchParams.set('sysparm_display_value', 'false');
    url.searchParams.set('sysparm_exclude_reference_link', 'false');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader, Accept: 'application/json' }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ServiceNow ${table} query failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { result: T[] };
    return json.result ?? [];
  }
}
