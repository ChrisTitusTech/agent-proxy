import { eq, and, asc } from 'drizzle-orm';
import { isReasoningEffort, type ProviderOverrides, type ReasoningEffort } from '@agent-proxy/shared';
import { getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

export interface ResolvedRoute {
  provider: string;
  actualModel: string;
  reasoningEffort?: ReasoningEffort;
  providerOverrides?: ProviderOverrides;

  includeReasoning?: boolean | null;

  extraBody?: Record<string, unknown>;
}


function parseProviderOverrides(raw: string | null | undefined): ProviderOverrides | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProviderOverrides;
    }
  } catch (e) {
    console.warn('[router] failed to parse provider_overrides:', (e as Error).message);
  }
  return undefined;
}


function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[router] failed to parse extra_body:', (e as Error).message);
  }
  return undefined;
}

export class ModelRouter {
  private registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }


  async resolve(modelAlias: string): Promise<ResolvedRoute[]> {
    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(and(
        eq(modelMappings.alias, modelAlias),
        eq(modelMappings.enabled, true),
      ))
      .orderBy(asc(modelMappings.priority));

    if (mappings.length === 0) {


      const inferredProvider = this.inferProvider(modelAlias);
      if (inferredProvider) {
        return [{ provider: inferredProvider, actualModel: modelAlias }];
      }
      return [];
    }


    return mappings
      .filter((m) => this.registry.has(m.provider))
      .map((m) => ({
        provider: m.provider,
        actualModel: m.actualModel,
        reasoningEffort: isReasoningEffort(m.reasoningEffort) ? m.reasoningEffort : undefined,
        providerOverrides: parseProviderOverrides(m.providerOverrides),
        includeReasoning: typeof m.includeReasoning === 'boolean' ? m.includeReasoning : null,
        extraBody: parseExtraBody(m.extraBody),
      }));
  }




  private inferProvider(model: string): string | null {
    const lower = model.toLowerCase();


    if (/^(claude|claude-|sonnet-|opus-|haiku-)/.test(lower)) {
      return 'claude';
    }

    if (/^(gpt-|o1-|o3-|o4-|codex-)/.test(lower)) {
      return 'codex';
    }
    // Antigravity exposes Google's Gemini models.
    if (/^gemini-/.test(lower)) {
      return 'agy';
    }

    if (/^(antigravity|agy)(-|$)/.test(lower)) {
      return 'agy';
    }

    if (/^grok(-|$)/.test(lower)) {
      return 'grok';
    }
    return null;
  }
}
