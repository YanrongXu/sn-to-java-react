import * as vscode from 'vscode';
import { CopilotLLM } from './llm/copilot';

/**
 * `@servicenow` chat participant. Lets the developer interactively ask:
 *   - `@servicenow /explain` how an artifact would convert
 *   - `@servicenow /preview` the generated code for a single thing
 *   - free-form Q&A grounded in our conversion mapping guide
 *
 * The participant doesn't bypass the LLM chokepoint — it still uses
 * CopilotLLM under the hood, which calls vscode.lm.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, out: vscode.OutputChannel) {
  const participant = vscode.chat.createChatParticipant(
    'snConvert.chat',
    async (request, _chatContext, response, token) => {
      const llm = new CopilotLLM(out);
      const system = `You are an assistant for converting ServiceNow scoped applications to Java (Spring Boot, multi-module Maven, JPA/Hibernate) and React (Vite, TypeScript, React Query, React Router). You always describe the deterministic structural mapping first, then call out the parts that require human judgment. Be concise.`;

      const userPrompt =
        request.command === 'explain'
          ? `Explain how the following ServiceNow artifact would map to Java/React via our 6-stage pipeline (Extractor → Parser → Mapper → Generator → Validator → Assembler). Be specific about which module (api/domain/service/web) and which generator handles it.\n\n${request.prompt}`
          : request.command === 'preview'
          ? `Generate a preview of the Java or React code our converter would produce for:\n\n${request.prompt}\n\nReturn fenced code blocks. Note any TODO(sn-convert) hotspots.`
          : request.command === 'convert'
          ? `The user wants to run the full 6-stage conversion pipeline. Briefly explain the pipeline (Extractor pulls artifacts, Parser walks ASTs, Mapper plans Java targets, Generator emits code via Copilot, Validator runs mvn compile + JUnit stubs, Assembler writes POMs + Liquibase + Security). Then tell them to run "ServiceNow: Run Conversion Pipeline" and supply their scoped app sys_id or scope name.`
          : request.command === 'validate'
          ? `The user wants to re-run Stage 5 (Validator) on a previously generated project. Tell them: open the generated project root in VS Code, then run "ServiceNow: Run Conversion Pipeline" again — Stages 1-4 will reproduce the same files, Stage 5 will recompile and refresh the report. Mention that they can disable mvn validation via snConvert.runMavenValidation if Maven isn't on PATH.`
          : request.prompt;

      try {
        const text = await llm.complete({ system, user: userPrompt, token });
        response.markdown(text);
      } catch (err) {
        response.markdown(`**Error:** ${(err as Error).message}`);
      }
    }
  );
  context.subscriptions.push(participant);
}
