// Direct Anthropic API calls for the intent experiments and the judge. Every call is
// appended to <eval dir>/data/ledger.jsonl with its cost.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./env.ts";

const PRICE: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const LEDGER = path.join(DATA, "ledger.jsonl");

export async function complete(
  model: string,
  system: string,
  user: string,
  maxTokens = 4000,
): Promise<{ text: string; cost: number; ms: number }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const price = PRICE[model];
  if (!price) throw new Error(`no price for ${model}`);
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 4) throw new Error(`${res.status} ${await res.text()}`);
      await Bun.sleep(5000 * (attempt + 1));
      continue;
    }
    const j = (await res.json()) as {
      usage: { input_tokens: number; output_tokens: number };
      content: Array<{ type: string; text?: string }>;
    };
    if (!res.ok) throw new Error(JSON.stringify(j));
    const cost = (j.usage.input_tokens * price[0] + j.usage.output_tokens * price[1]) / 1e6;
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ model, in: j.usage.input_tokens, out: j.usage.output_tokens, cost }) + "\n");
    const text = j.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return { text, cost, ms: Date.now() - t0 };
  }
}

export function parseJson<T>(text: string): T {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*\n(\{[\s\S]*?)```/);
  const body = m?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body) as T;
}
