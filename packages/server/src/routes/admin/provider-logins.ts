import type { FastifyInstance } from 'fastify';
import {
  LOGIN_PROVIDERS,
  type LoginProvider,
  type ProviderLoginManager,
} from '../../services/provider-login-manager.js';

function isLoginProvider(value: string): value is LoginProvider {
  return (LOGIN_PROVIDERS as readonly string[]).includes(value);
}

export function registerProviderLoginRoutes(
  app: FastifyInstance,
  manager: ProviderLoginManager,
): void {
  app.get<{ Querystring: { refresh?: string } }>(
    '/admin/provider-logins',
    async (request, reply) => {
      return reply.send(await manager.getAll(request.query.refresh === '1'));
    },
  );

  app.post<{ Params: { provider: string } }>(
    '/admin/provider-logins/:provider/start',
    async (request, reply) => {
      const { provider } = request.params;
      if (!isLoginProvider(provider)) {
        return reply.status(404).send({
          error: { message: `Provider login is not supported for "${provider}".` },
        });
      }
      return reply.status(202).send(manager.start(provider));
    },
  );

  app.post<{ Params: { provider: string }; Body: { code?: unknown } }>(
    '/admin/provider-logins/:provider/code',
    async (request, reply) => {
      const { provider } = request.params;
      if (!isLoginProvider(provider)) {
        return reply.status(404).send({
          error: { message: `Provider login is not supported for "${provider}".` },
        });
      }
      if (typeof request.body?.code !== 'string') {
        return reply.status(400).send({
          error: { message: 'An authorization code is required.' },
        });
      }
      try {
        return reply.send(manager.submitCode(provider, request.body.code));
      } catch (error) {
        return reply.status(400).send({
          error: {
            message: error instanceof Error
              ? error.message
              : 'The authorization code could not be submitted.',
          },
        });
      }
    },
  );

  app.delete<{ Params: { provider: string } }>(
    '/admin/provider-logins/:provider',
    async (request, reply) => {
      const { provider } = request.params;
      if (!isLoginProvider(provider)) {
        return reply.status(404).send({
          error: { message: `Provider login is not supported for "${provider}".` },
        });
      }
      return reply.send(manager.cancel(provider));
    },
  );
}
