// The model behind the scouts: OpenRouter, server side, with the key from the settings. One request in, one answer
// out, with what it cost. The key goes in the Authorization header and nowhere else: never in a log, an error or a
// stored row. Tests hand in their own provider (test/scout-helpers.ts); nothing here is ever faked in the engine.

export type ModelRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** a JSON schema the answer must follow (OpenRouter's structured output); the answer is still checked after */
  schema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
};

export type ModelAnswer = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** what the provider says it cost, in USD; null when it did not say */
  usd: number | null;
};

export interface ModelProvider {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelAnswer>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** what the failed call cost anyway (OpenRouter bills some failures), when known */
    readonly usage: Omit<ModelAnswer, "text"> | null = null,
  ) {
    super(message);
  }
}

/** OpenRouter's chat completions with usage accounting on. 30 seconds at most. */
export function openRouterProvider(key: string, fetchImpl: typeof fetch = fetch): ModelProvider {
  return {
    name: "openrouter",
    async complete(req) {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.2,
        usage: { include: true },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      };
      if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } };
      let res: Response;
      try {
        res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "PUSHD" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        throw new ModelError(`the model did not answer (${(e as Error).name})`);
      }
      if (!res.ok) throw new ModelError(`the model answered ${res.status}`, res.status);
      const j = (await res.json().catch(() => null)) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      } | null;
      if (!j) throw new ModelError("the model's answer was not JSON");
      return {
        text: j.choices?.[0]?.message?.content ?? "",
        model: typeof j.model === "string" ? j.model : req.model,
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
        usd: typeof j.usage?.cost === "number" ? j.usage.cost : null,
      };
    },
  };
}

/** A rough token count for the estimate before a call: about four characters a token, rounded up. */
export const roughTokens = (s: string) => Math.ceil(s.length / 3.5) + 8;
