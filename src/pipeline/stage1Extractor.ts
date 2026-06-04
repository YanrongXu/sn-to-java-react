import * as vscode from 'vscode';
import { ServiceNowClient } from '../servicenow/client';
import { ExtractedBundle } from './types';

/**
 * Stage 1 — Extractor.
 *
 * Calls the ServiceNow Table API to pull every artifact in the target
 * scoped application. Read-only. The output `ExtractedBundle` is the
 * single source of truth for downstream stages.
 */
export class ExtractorAgent {
  constructor(private readonly client: ServiceNowClient, private readonly out: vscode.OutputChannel) {}

  async run(sysIdOrScope: string): Promise<ExtractedBundle> {
    this.out.appendLine(`[stage1:extractor] resolving "${sysIdOrScope}"`);
    const application = await this.client.resolveApplication(sysIdOrScope);
    const bundle = await this.client.fetchBundle(application);
    this.out.appendLine(
      `[stage1:extractor] extracted: ` +
        `${bundle.tables.length} tables, ` +
        `${bundle.businessRules.length} business rules, ` +
        `${bundle.scriptIncludes.length} script includes, ` +
        `${bundle.clientScripts.length} client scripts, ` +
        `${bundle.restResources.length} scripted REST, ` +
        `${bundle.uiPages.length} UI pages, ` +
        `${bundle.acls.length} ACLs`
    );
    return {
      application,
      tables: bundle.tables,
      businessRules: bundle.businessRules,
      scriptIncludes: bundle.scriptIncludes,
      clientScripts: bundle.clientScripts,
      restResources: bundle.restResources,
      uiPages: bundle.uiPages,
      acls: bundle.acls
    };
  }
}
