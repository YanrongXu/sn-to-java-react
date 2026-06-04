import { parse } from '@babel/parser';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';
import {
  CurrentAccess,
  GlideRecordOp,
  GlideRecordUse,
  GsCall,
  ScriptIncludeUse,
  ScriptPatterns
} from '../pipeline/types';

// @babel/traverse ships as a CommonJS default export; this dance keeps it
// importable under TypeScript's esModuleInterop without `as any` everywhere.
const traverse: typeof traverseImport =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (traverseImport as any).default ?? traverseImport;

/**
 * Parses a single GlideScript and returns structured patterns.
 * Resilient by design: malformed scripts return whatever could be salvaged
 * plus a list of parse errors. The caller still passes the raw script to
 * the LLM as a safety net.
 */
export function parseGlideScript(source: string): { patterns: ScriptPatterns; errors: string[] } {
  const errors: string[] = [];

  const empty: ScriptPatterns = {
    glideRecords: [],
    glideSystemCalls: [],
    current: { reads: [], writes: [], operationChecks: [] },
    scriptIncludes: [],
    abortAction: false,
    jsonOps: [],
    externalCalls: []
  };

  if (!source || !source.trim()) return { patterns: empty, errors };

  let ast;
  try {
    ast = parse(source, {
      sourceType: 'script',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: []
    });
  } catch (err) {
    errors.push(`@babel/parser fatal: ${(err as Error).message}`);
    return { patterns: empty, errors };
  }
  for (const e of ast.errors ?? []) {
    errors.push(`parse: ${e.toString()}`);
  }

  // Variable name -> table this GlideRecord was constructed with.
  const grTables = new Map<string, string | null>();
  const grUses = new Map<string, GlideRecordUse>();
  const gsCalls: GsCall[] = [];
  const current: CurrentAccess = { reads: [], writes: [], operationChecks: [] };
  const scriptIncludes: ScriptIncludeUse[] = [];
  const jsonOps: ('parse' | 'stringify')[] = [];
  const externalCalls = new Set<string>();
  let abortAction = false;

  const ensureGr = (name: string): GlideRecordUse => {
    let u = grUses.get(name);
    if (!u) {
      u = {
        variable: name,
        table: grTables.get(name) ?? null,
        queries: [],
        reads: [],
        writes: [],
        operations: []
      };
      grUses.set(name, u);
    }
    return u;
  };

  traverse(ast, {
    // --- new GlideRecord('tbl') ---
    VariableDeclarator(path) {
      const init = path.node.init;
      if (
        init &&
        t.isNewExpression(init) &&
        t.isIdentifier(init.callee) &&
        init.callee.name === 'GlideRecord' &&
        t.isIdentifier(path.node.id)
      ) {
        const arg = init.arguments[0];
        const table = arg && t.isStringLiteral(arg) ? arg.value : null;
        grTables.set(path.node.id.name, table);
        ensureGr(path.node.id.name).table = table;
      }
      if (
        init &&
        t.isNewExpression(init) &&
        t.isIdentifier(init.callee) &&
        init.callee.name === 'GlideAggregate' &&
        t.isIdentifier(path.node.id)
      ) {
        const arg = init.arguments[0];
        const table = arg && t.isStringLiteral(arg) ? arg.value : null;
        // Track as a GlideRecord-style use; downstream code can flag aggregates.
        const u = ensureGr(path.node.id.name);
        u.table = table;
        u.operations.push('query');
      }
    },

    AssignmentExpression(path) {
      // var x; x = new GlideRecord('tbl')
      const { left, right } = path.node;
      if (
        t.isIdentifier(left) &&
        t.isNewExpression(right) &&
        t.isIdentifier(right.callee) &&
        right.callee.name === 'GlideRecord'
      ) {
        const arg = right.arguments[0];
        const table = arg && t.isStringLiteral(arg) ? arg.value : null;
        grTables.set(left.name, table);
        ensureGr(left.name).table = table;
      }
      // current.field = ...
      if (
        t.isMemberExpression(left) &&
        t.isIdentifier(left.object) &&
        left.object.name === 'current' &&
        t.isIdentifier(left.property)
      ) {
        current.writes.push(left.property.name);
      }
    },

    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return;
      const method = callee.property.name;

      // gs.<method>(...)
      if (t.isIdentifier(callee.object) && callee.object.name === 'gs') {
        gsCalls.push({
          method,
          argCount: args.length,
          firstArgLiteral: args[0] && t.isStringLiteral(args[0]) ? args[0].value : undefined
        });
        return;
      }

      // JSON.parse / JSON.stringify
      if (t.isIdentifier(callee.object) && callee.object.name === 'JSON') {
        if (method === 'parse') jsonOps.push('parse');
        if (method === 'stringify') jsonOps.push('stringify');
        return;
      }

      // current.<method>(...) — current.setValue / current.getValue / current.update / current.setAbortAction
      if (t.isIdentifier(callee.object) && callee.object.name === 'current') {
        if (method === 'setValue' && args[0] && t.isStringLiteral(args[0])) current.writes.push(args[0].value);
        else if (method === 'getValue' && args[0] && t.isStringLiteral(args[0])) current.reads.push(args[0].value);
        else if (method === 'operation') current.operationChecks.push('operation()');
        else if (method === 'setAbortAction' && args[0] && t.isBooleanLiteral(args[0]) && args[0].value)
          abortAction = true;
        return;
      }

      // grVar.<method>(...) where grVar was constructed with new GlideRecord(...)
      if (t.isIdentifier(callee.object) && grTables.has(callee.object.name)) {
        const u = ensureGr(callee.object.name);
        switch (method) {
          case 'addQuery':
          case 'addEncodedQuery': {
            if (method === 'addEncodedQuery') {
              if (args[0] && t.isStringLiteral(args[0])) {
                u.queries.push({ field: '<encoded>', op: '=', value: args[0].value });
              }
            } else if (args.length >= 2 && t.isStringLiteral(args[0])) {
              const field = args[0].value;
              if (args.length === 2) {
                u.queries.push({ field, op: '=', value: literal(args[1]) });
              } else if (args.length >= 3 && t.isStringLiteral(args[1])) {
                u.queries.push({ field, op: args[1].value, value: literal(args[2]) });
              }
            }
            break;
          }
          case 'query':         u.operations.push('query');         break;
          case 'next':          u.operations.push('next');          break;
          case 'get':           u.operations.push('get');           break;
          case 'insert':        u.operations.push('insert');        break;
          case 'update':        u.operations.push('update');        break;
          case 'deleteRecord':  u.operations.push('deleteRecord');  break;
          case 'deleteMultiple':u.operations.push('deleteMultiple');break;
          case 'getValue':
            if (args[0] && t.isStringLiteral(args[0])) u.reads.push(args[0].value);
            break;
          case 'setValue':
            if (args[0] && t.isStringLiteral(args[0])) u.writes.push(args[0].value);
            break;
          case 'getDisplayValue':
            if (args[0] && t.isStringLiteral(args[0])) u.reads.push(`${args[0].value} (display)`);
            break;
        }
        return;
      }

      // ServiceNow Script-Include style: new <ApiName>().method() / global.<ApiName>.method()
      if (
        t.isMemberExpression(callee.object) &&
        t.isIdentifier(callee.object.property) &&
        t.isIdentifier(callee.object.object) &&
        callee.object.object.name === 'global'
      ) {
        scriptIncludes.push({ apiName: `global.${callee.object.property.name}`, method });
        return;
      }
      if (t.isIdentifier(callee.object)) {
        // Could be an instance of a Script Include via `new OrderUtils().compute(...)`
        const parent = path.parentPath;
        if (parent && t.isNewExpression(path.parent)) {
          // handled by NewExpression below
        } else {
          externalCalls.add(`${callee.object.name}.${method}`);
        }
      }
    },

    NewExpression(path) {
      if (t.isIdentifier(path.node.callee)) {
        const name = path.node.callee.name;
        if (name !== 'GlideRecord' && name !== 'GlideAggregate' && name !== 'GlideDateTime' && name !== 'GlideDate') {
          // Treat capitalized constructors as potential Script-Includes
          if (/^[A-Z]/.test(name)) {
            scriptIncludes.push({ apiName: name });
          }
        }
      }
    },

    MemberExpression(path) {
      // Bare current.field reads (not part of a CallExpression, not an assignment)
      const { object, property, computed } = path.node;
      if (
        t.isIdentifier(object) &&
        object.name === 'current' &&
        t.isIdentifier(property) &&
        !computed
      ) {
        const parent = path.parent;
        const isCall = t.isCallExpression(parent) && parent.callee === path.node;
        const isAssign = t.isAssignmentExpression(parent) && parent.left === path.node;
        if (!isCall && !isAssign) current.reads.push(property.name);
      }
    }
  });

  return {
    patterns: {
      glideRecords: [...grUses.values()],
      glideSystemCalls: gsCalls,
      current,
      scriptIncludes,
      abortAction,
      jsonOps,
      externalCalls: [...externalCalls]
    },
    errors
  };
}

function literal(node: t.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNullLiteral(node)) return 'null';
  if (t.isIdentifier(node)) return node.name;
  return undefined;
}
