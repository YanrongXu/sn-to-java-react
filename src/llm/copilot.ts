import * as vscode from 'vscode';

/**
 * Single, narrow chokepoint for every LLM call in the extension.
 *
 * Routes all requests through the VS Code Language Model API
 * (`vscode.lm.selectChatModels`), which proxies to GitHub Copilot using
 * the developer's existing Copilot subscription. No API keys, no direct
 * network calls to model providers — this is what makes the extension
 * compliant with a Copilot-only AI policy.
 *
 * Design notes:
 *   - We do NOT cache a model handle across long gaps; Copilot can rotate
 *     available models, so we resolve per request and fall back gracefully.
 *   - All callers must pass a CancellationToken so the user can cancel
 *     long generations from the progress notification.
 *   - JSON-mode helpers strip code fences defensively (Copilot models often
 *     emit ```json ... ``` even when told not to).
 */
export class CopilotLLM {
  constructor(private readonly out: vscode.OutputChannel) {}

  async complete(opts: {
    system?: string;
    user: string;
    token: vscode.CancellationToken;
    preferredFamily?: string;
    /** If true, response is parsed as JSON; throws on parse failure. */
    json?: boolean;
  }): Promise<string> {
    const model = await this.selectModel(opts.preferredFamily);
    if (!model) {
      throw new Error(
        'No Copilot chat model is available. Ensure GitHub Copilot Chat is installed, signed in, and enabled in VS Code.'
      );
    }

    const messages: vscode.LanguageModelChatMessage[] = [];
    if (opts.system) {
      // Copilot's vscode.lm only exposes User/Assistant roles publicly;
      // we encode the system prompt as the first user turn with a guard prefix.
      messages.push(
        vscode.LanguageModelChatMessage.User(`[SYSTEM INSTRUCTIONS]\n${opts.system}\n[END SYSTEM]`)
      );
    }
    messages.push(vscode.LanguageModelChatMessage.User(opts.user));

    this.out.appendLine(
      `[LLM] model=${model.vendor}/${model.family} promptChars=${opts.user.length}`
    );

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, {}, opts.token);
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        throw new Error(`Copilot error (${err.code}): ${err.message}`);
      }
      throw err;
    }

    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
      if (opts.token.isCancellationRequested) break;
    }

    if (opts.json) {
      return this.extractJson(text);
    }
    return text;
  }

  /** Convenience: ask Copilot for a fenced code block and return just the code. */
  async completeCode(opts: {
    system?: string;
    user: string;
    language: string;
    token: vscode.CancellationToken;
  }): Promise<string> {
    const raw = await this.complete({ ...opts });
    return this.extractCodeBlock(raw, opts.language) ?? raw.trim();
  }

  private async selectModel(preferred?: string) {
    const want = preferred ?? vscode.workspace.getConfiguration('snConvert').get<string>('copilotModel') ?? 'gpt-4o';
    // Try preferred family first, then any Copilot model.
    const preferredMatch = await vscode.lm.selectChatModels({ vendor: 'copilot', family: want });
    if (preferredMatch.length) return preferredMatch[0];
    const anyCopilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (anyCopilot.length) {
      this.out.appendLine(`[LLM] preferred family "${want}" unavailable, using ${anyCopilot[0].family}`);
      return anyCopilot[0];
    }
    return undefined;
  }

  private extractCodeBlock(text: string, language: string): string | undefined {
    // Tolerant of ```java, ```jsx, ```tsx, etc.
    const fence = new RegExp('```(?:' + language + '\\w*)?\\s*\\n?([\\s\\S]*?)```', 'i');
    const m = text.match(fence);
    return m?.[1]?.trim();
  }

  private extractJson(text: string): string {
    let t = text.trim();
    // Strip fences if present.
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) t = fenced[1].trim();
    // Validate.
    try {
      JSON.parse(t);
    } catch (e) {
      throw new Error(`Copilot did not return valid JSON. Got:\n${text.slice(0, 500)}`);
    }
    return t;
  }
}
