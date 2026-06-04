/**
 * Pipeline type contracts. Each stage takes the previous stage's output
 * type and returns its own, making the data flow grep-able and statically
 * checkable.
 *
 *  Stage 1 Extractor   : ()             -> ExtractedBundle
 *  Stage 2 Parser      : ExtractedBundle-> ParsedBundle
 *  Stage 3 Mapper      : ParsedBundle   -> SemanticPlan
 *  Stage 4 Generator   : SemanticPlan   -> GeneratedFile[]
 *  Stage 5 Validator   : GeneratedFile[]-> ValidationResult
 *  Stage 6 Assembler   : (everything)   -> AssembledProject
 */

import {
  SnAcl,
  SnApplication,
  SnBusinessRule,
  SnClientScript,
  SnScriptInclude,
  SnScriptedRestResource,
  SnTable,
  SnUIPage
} from '../servicenow/types';

// ---------------- Stage 1 output ----------------

export interface ExtractedBundle {
  application: SnApplication;
  tables: SnTable[];
  businessRules: SnBusinessRule[];
  scriptIncludes: SnScriptInclude[];
  clientScripts: SnClientScript[];
  restResources: SnScriptedRestResource[];
  uiPages: SnUIPage[];
  acls: SnAcl[];
}

// ---------------- Stage 2 output ----------------

export interface ParsedBundle {
  extracted: ExtractedBundle;
  scripts: ParsedScript[];
}

export type ScriptArtifactKind =
  | 'businessRule'
  | 'scriptInclude'
  | 'clientScript'
  | 'scriptedRest';

export interface ParsedScript {
  sys_id: string;
  artifactKind: ScriptArtifactKind;
  name: string;
  sourceTable?: string;
  patterns: ScriptPatterns;
  /** Babel parse errors, if any. The script is still passed through. */
  parseErrors: string[];
}

export interface ScriptPatterns {
  glideRecords: GlideRecordUse[];
  glideSystemCalls: GsCall[];
  current: CurrentAccess;
  scriptIncludes: ScriptIncludeUse[];
  abortAction: boolean;
  jsonOps: ('parse' | 'stringify')[];
  externalCalls: string[];
}

export interface GlideRecordUse {
  variable: string;
  table: string | null;            // null when constructed dynamically
  queries: { field: string; op: string; value?: string }[];
  reads: string[];                 // gr.getValue('x') / gr.x
  writes: string[];                // gr.setValue('x', ...)
  operations: GlideRecordOp[];
}

export type GlideRecordOp = 'query' | 'next' | 'get' | 'insert' | 'update' | 'deleteRecord' | 'deleteMultiple';

export interface GsCall {
  method: string;                  // e.g. 'info', 'hasRole', 'getUserID'
  argCount: number;
  firstArgLiteral?: string;        // when arg[0] is a string literal
}

export interface CurrentAccess {
  reads: string[];                 // current.field / current.getValue('field')
  writes: string[];                // current.setValue('field', ...) / current.field = ...
  operationChecks: string[];       // current.operation() === 'insert'
}

export interface ScriptIncludeUse {
  apiName: string;                 // e.g. 'OrderUtils' or 'global.OrderUtils'
  method?: string;
}

// ---------------- Stage 3 output ----------------

export interface SemanticPlan {
  basePackage: string;             // e.g. com.acme.converted.x_acme_orders
  modules: ModulePlan[];
  mappings: ArtifactMapping[];
}

export interface ModulePlan {
  name: ModuleName;
  purpose: string;
}

export type ModuleName = 'api' | 'domain' | 'service' | 'web';

export interface ArtifactMapping {
  source:
    | { kind: 'table';         data: SnTable }
    | { kind: 'businessRule';  data: SnBusinessRule;  parsed: ScriptPatterns }
    | { kind: 'scriptInclude'; data: SnScriptInclude; parsed: ScriptPatterns }
    | { kind: 'scriptedRest';  data: SnScriptedRestResource; parsed: ScriptPatterns }
    | { kind: 'clientScript';  data: SnClientScript;  parsed: ScriptPatterns }
    | { kind: 'acl';           data: SnAcl };
  targets: GenerationTarget[];
}

export interface GenerationTarget {
  module: ModuleName;
  relativePath: string;            // e.g. "entity/Order.java"
  className: string;
  kind: TargetKind;
  notes?: string;                  // why this mapping was chosen
}

export type TargetKind =
  | 'entity'
  | 'repository'
  | 'dto'
  | 'service'
  | 'utility'
  | 'controller'
  | 'crudController'
  | 'securityRule';

// ---------------- Stage 4 output ----------------

export interface GeneratedFile {
  /** Absolute filesystem path. */
  path: string;
  content: string;
  language: 'java' | 'tsx' | 'ts' | 'xml' | 'yaml' | 'properties' | 'markdown' | 'json' | 'html';
  /** sys_id of the originating ServiceNow artifact, if any. */
  origin?: string;
  /** Marker: was an LLM call involved producing this file? */
  llmInvolved: boolean;
  /** True iff this file is a structural template (POMs, app.yml, etc.) — Stage 6 adds these. */
  structural?: boolean;
}

// ---------------- Stage 5 output ----------------

export interface ValidationResult {
  ran: boolean;
  compiled: boolean | null;        // null when mvn was not run
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  testStubsGenerated: number;
  checkstyle: { ran: boolean; issueCount: number };
  spotbugs:   { ran: boolean; issueCount: number };
  durationMs: number;
}

export interface ValidationIssue {
  source: 'mvn' | 'checkstyle' | 'spotbugs';
  severity: 'error' | 'warning';
  file?: string;
  line?: number;
  message: string;
}

// ---------------- Stage 6 output ----------------

export interface AssembledProject {
  rootDir: string;
  fileCount: number;
  report: string;                  // markdown
}
