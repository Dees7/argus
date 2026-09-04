// Single source of truth for token pricing, shared by the extension host and
// the webview. Deliberately dependency-free so both builds can import it.
//
// Transcripts record token counts and a model id, never a price — every figure
// Argus shows is computed here.

export interface CostUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // Cache writes are billed per TTL: 5-minute entries cost 1.25x the base input
  // rate, 1-hour entries 2x. Without this split the flat
  // `cache_creation_input_tokens` cannot be priced correctly.
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  // Fast mode runs the same model at premium pricing.
  speed?: string;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  // Fast mode (Opus-tier only) bills the same model at a premium rate.
  fastInputPerMillion?: number;
  fastOutputPerMillion?: number;
}

// Ratios applied to the model's base input rate. Identical across models.
export const CACHE_READ_RATIO = 0.1;
export const CACHE_WRITE_5M_RATIO = 1.25;
export const CACHE_WRITE_1H_RATIO = 2.0;

export const MODEL_PRICES: Record<string, ModelPricing> = {
  'claude-fable-5-1': { inputPerMillion: 10.0, outputPerMillion: 50.0 },
  'claude-mythos-5-1': { inputPerMillion: 10.0, outputPerMillion: 50.0 },
  'claude-fable-5': { inputPerMillion: 10.0, outputPerMillion: 50.0 },
  'claude-mythos-5': { inputPerMillion: 10.0, outputPerMillion: 50.0 },
  'claude-opus-5': {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    fastInputPerMillion: 10.0,
    fastOutputPerMillion: 50.0,
  },
  'claude-opus-4-8': {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    fastInputPerMillion: 10.0,
    fastOutputPerMillion: 50.0,
  },
  'claude-opus-4-7': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'claude-sonnet-5': { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
};

// Family rates for model ids released after this table was written. Priced as
// the cheapest current member of the family, so a new model is never billed as
// something from a different tier.
const FAMILY_FALLBACKS: Array<{ match: RegExp; pricing: ModelPricing }> = [
  { match: /fable|mythos/i, pricing: { inputPerMillion: 10.0, outputPerMillion: 50.0 } },
  { match: /opus/i, pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 } },
  { match: /sonnet/i, pricing: { inputPerMillion: 2.0, outputPerMillion: 10.0 } },
  { match: /haiku/i, pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0 } },
];

const UNKNOWN_MODEL_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
};

export interface ResolvedPricing extends ModelPricing {
  // True when the id was not matched exactly, so every cost derived from it is
  // an estimate. The UI marks such figures rather than presenting them as fact.
  isFallback: boolean;
}

export function getModelPricing(model: string): ResolvedPricing {
  const exact = MODEL_PRICES[model];
  if (exact) {
    return { ...exact, isFallback: false };
  }

  if (model) {
    const family = FAMILY_FALLBACKS.find(f => f.match.test(model));
    if (family) {
      return { ...family.pricing, isFallback: true };
    }
  }

  return { ...UNKNOWN_MODEL_PRICING, isFallback: true };
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Price one API response. Callers must invoke this once per `message.id` —
 * a response is written to the transcript as one event per content block, each
 * repeating the same usage, so pricing every event inflates the total.
 */
export function calculateCostBreakdown(
  usage: CostUsage | undefined,
  model: string
): CostBreakdown {
  if (!usage) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }

  const pricing = getModelPricing(model);
  const isFast = usage.speed === 'fast';
  const inRate =
    isFast && pricing.fastInputPerMillion !== undefined
      ? pricing.fastInputPerMillion
      : pricing.inputPerMillion;
  const outRate =
    isFast && pricing.fastOutputPerMillion !== undefined
      ? pricing.fastOutputPerMillion
      : pricing.outputPerMillion;

  // Prefer the per-TTL breakdown; fall back to the flat counter (older
  // transcripts omit `cache_creation`), treating it as 5-minute writes.
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const flatWrite =
    write5m + write1h === 0 ? usage.cache_creation_input_tokens ?? 0 : 0;

  const input = ((usage.input_tokens ?? 0) * inRate) / 1_000_000;
  const output = ((usage.output_tokens ?? 0) * outRate) / 1_000_000;
  const cacheRead =
    ((usage.cache_read_input_tokens ?? 0) * inRate * CACHE_READ_RATIO) / 1_000_000;
  const cacheWrite =
    ((write5m + flatWrite) * inRate * CACHE_WRITE_5M_RATIO +
      write1h * inRate * CACHE_WRITE_1H_RATIO) /
    1_000_000;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

export function calculateCost(usage: CostUsage | undefined, model: string): number {
  return calculateCostBreakdown(usage, model).total;
}
