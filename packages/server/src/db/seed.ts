import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig } from '@agent-proxy/shared';
import { getDatabase } from './client.js';
import { apiKeys, modelMappings } from './schema.js';
import { hashApiKey, getKeyPrefix } from '../middleware/auth.js';

export async function seedDatabase(config: AppConfig): Promise<void> {
  const db = getDatabase();


  for (const keyConfig of config.auth.initialKeys) {
    if (!keyConfig.key) continue;

    const keyHash = hashApiKey(keyConfig.key);
    const existing = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(apiKeys).values({
        id: nanoid(),
        keyHash,
        keyPrefix: getKeyPrefix(keyConfig.key),
        name: keyConfig.name,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
  }






  const existingMappings = await db
    .select({ alias: modelMappings.alias })
    .from(modelMappings);
  const existingAliases = new Set(existingMappings.map((m) => m.alias));

  for (const mapping of config.modelMappings) {
    if (existingAliases.has(mapping.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: mapping.alias,
      provider: mapping.provider,
      actualModel: mapping.actual_model,
      displayName: mapping.alias,
      reasoningEffort: mapping.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}
