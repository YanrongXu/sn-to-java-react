/**
 * Minimal but representative ServiceNow artifact model.
 * Add fields here as you broaden conversion coverage.
 */

export interface SnCredentials {
  instanceUrl: string;
  username: string;
  password: string;
}

export interface SnApplication {
  sys_id: string;
  name: string;
  scope: string;
  short_description?: string;
  version?: string;
}

export interface SnTable {
  sys_id: string;
  name: string;            // e.g. x_acme_orders_order
  label: string;
  super_class?: string;    // table this extends, often "task" or empty
  is_extendable?: boolean;
  columns: SnColumn[];
}

export interface SnColumn {
  element: string;         // column name
  column_label: string;
  internal_type: string;   // string, integer, reference, glide_date_time, boolean, choice, etc.
  max_length?: number;
  mandatory?: boolean;
  reference_table?: string;
  default_value?: string;
  choice_list?: { label: string; value: string }[];
  read_only?: boolean;
}

export interface SnBusinessRule {
  sys_id: string;
  name: string;
  table: string;
  when: 'before' | 'after' | 'async' | 'display';
  order: number;
  active: boolean;
  action_insert?: boolean;
  action_update?: boolean;
  action_delete?: boolean;
  action_query?: boolean;
  condition?: string;
  filter_condition?: string;
  script: string;          // server-side JS
}

export interface SnScriptInclude {
  sys_id: string;
  name: string;
  api_name: string;
  script: string;
  access?: 'public' | 'package_private';
  client_callable?: boolean;
  description?: string;
}

export interface SnClientScript {
  sys_id: string;
  name: string;
  table: string;
  type: 'onLoad' | 'onChange' | 'onSubmit' | 'onCellEdit';
  field_name?: string;
  script: string;
}

export interface SnScriptedRestResource {
  sys_id: string;
  api_id: string;          // namespace/api_id
  name: string;
  http_method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  relative_path: string;
  operation_script: string;
  requires_authentication?: boolean;
}

export interface SnUIPage {
  sys_id: string;
  name: string;
  html: string;            // Jelly + HTML
  client_script?: string;
  processing_script?: string;
}

export interface SnAcl {
  sys_id: string;
  name: string;
  table: string;
  operation: 'read' | 'write' | 'create' | 'delete';
  roles: string[];
  script?: string;
  condition?: string;
}

export interface SnAppBundle {
  application: SnApplication;
  tables: SnTable[];
  businessRules: SnBusinessRule[];
  scriptIncludes: SnScriptInclude[];
  clientScripts: SnClientScript[];
  restResources: SnScriptedRestResource[];
  uiPages: SnUIPage[];
  acls: SnAcl[];
}
