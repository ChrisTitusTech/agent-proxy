import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import type { ValidationConfig } from '@agent-proxy/shared';

const VALIDATION_KEY = 'validation_config';

interface SettingsDeps {
  getValidation: () => ValidationConfig;
  setValidation: (config: ValidationConfig) => void;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {

  app.get('/admin/settings/validation', async (_request, reply) => {
    return reply.send(deps.getValidation());
  });


  app.put<{ Body: Partial<ValidationConfig> }>('/admin/settings/validation', async (request, reply) => {
    const current = deps.getValidation();
    const body = request.body;

    const updated: ValidationConfig = {
      maxMessageCount: body.maxMessageCount ?? current.maxMessageCount,
      maxMessageLength: body.maxMessageLength ?? current.maxMessageLength,
      maxPromptLength: body.maxPromptLength ?? current.maxPromptLength,
      maxResponseLength: body.maxResponseLength ?? current.maxResponseLength,

      bodyLimitBytes: current.bodyLimitBytes,
    };


    const db = getDatabase();
    const existing = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);
    if (existing.length > 0) {
      await db.update(settings).set({
        value: JSON.stringify(updated),
        updatedAt: new Date().toISOString(),
      }).where(eq(settings.key, VALIDATION_KEY));
    } else {
      await db.insert(settings).values({
        key: VALIDATION_KEY,
        value: JSON.stringify(updated),
        updatedAt: new Date().toISOString(),
      });
    }


    deps.setValidation(updated);

    return reply.send(updated);
  });
}


export async function loadValidationFromDb(): Promise<ValidationConfig | null> {
  try {
    const db = getDatabase();
    const result = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);
    if (result.length > 0) {
      return JSON.parse(result[0].value) as ValidationConfig;
    }
  } catch { }
  return null;
}
