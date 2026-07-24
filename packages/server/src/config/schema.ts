

//







import { z } from 'zod';


const opt = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);

const port = z.int().min(1).max(65535);
const positiveInt = z.int().positive();
const positiveNumber = z.number().positive();

const serverSchema = z.object({
  port: opt(port),
  host: opt(z.string()),
  cors: opt(
    z.object({
      origins: opt(z.array(z.string())),
    }),
  ),
});

const dashboardSchema = z.object({
  port: opt(port),
  host: opt(z.string()),
});

const databaseSchema = z.object({
  path: opt(z.string()),
});

const authSchema = z.object({
  enabled: opt(z.boolean()),
  admin_token: opt(z.string()),
  initial_keys: opt(
    z.array(
      z.object({
        name: opt(z.string()),
        key: opt(z.string()),
      }),
    ),
  ),
});

const sdkOptionsSchema = z.object({
  max_turns: opt(positiveInt),
  permission_mode: opt(z.string()),
  allowed_tools: opt(z.array(z.string())),
  disallowed_tools: opt(z.array(z.string())),
  max_budget_usd: opt(positiveNumber),
  session_ttl_ms: opt(positiveInt),
  enable_session_reuse: opt(z.boolean()),
  persist_session: opt(z.boolean()),
}).strict();

const channelOptionsSchema = z.object({
  endpoint_url: opt(z.string()),
  api_key: opt(z.string()),
  poll_interval_ms: opt(positiveInt),
  result_timeout_ms: opt(positiveInt),
  response_schema: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? undefined),
  isolation: opt(z.enum(['external', 'one-job-per-worker', 'shared-session'])),
  managed: opt(z.boolean()),
  auto_start: opt(z.boolean()),
  bridge_port: opt(positiveInt),
  bridge_command: opt(z.string()),
}).strict();

const appServerOptionsSchema = z.object({
  transport: opt(z.enum(['stdio', 'websocket'])),
  websocket_url: opt(z.string()),
  session_ttl_ms: opt(positiveInt),
  enable_session_reuse: opt(z.boolean()),
  max_turns: opt(positiveInt),
  auto_restart: opt(z.boolean()),
  max_restart_count: opt(positiveInt),
}).strict();

const cliOptionsSchema = z.object({
  ephemeral: opt(z.boolean()),
  enable_session_reuse: opt(z.boolean()),
  session_ttl_ms: opt(positiveInt),
}).strict();

export const providerSchema = z.object({
  enabled: opt(z.boolean()),
  cli_path: opt(z.string()),
  default_model: opt(z.string()),
  max_concurrent: opt(positiveInt),
  timeout_ms: opt(positiveInt),
  extra_args: opt(z.array(z.string())),
  working_dir: opt(z.string()),
  mode: opt(z.enum(['cli', 'sdk', 'app-server', 'channel-worker'])),
  sdk_options: opt(sdkOptionsSchema),
  channel_options: opt(channelOptionsSchema),
  app_server_options: opt(appServerOptionsSchema),
  cli_options: opt(cliOptionsSchema),
}).strict();

const rateLimitsSchema = z.object({
  global: opt(
    z.object({
      rpm: opt(positiveInt),
      rpd: opt(positiveInt),
    }),
  ),
  per_provider: opt(z.record(z.string(), opt(z.object({ rpm: opt(positiveInt) })))),
});

const cacheSchema = z.object({
  enabled: opt(z.boolean()),
  ttl_seconds: opt(positiveInt),
  max_entries: opt(positiveInt),
});

const responsesSchema = z.object({
  retention_ttl_ms: opt(positiveInt),
  max_entries: opt(positiveInt),
});

const validationSchema = z.object({
  max_message_count: opt(positiveInt),
  max_message_length: opt(positiveInt),
  max_prompt_length: opt(positiveInt),
  max_response_length: opt(positiveInt),
  body_limit_bytes: opt(positiveInt),
});

const modelMappingSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  actual_model: opt(z.string()),

  reasoning_effort: opt(z.string()),

  provider_overrides: z.unknown().optional(),
});

export const rawConfigSchema = z.object({
  server: opt(serverSchema),
  dashboard: opt(dashboardSchema),
  database: opt(databaseSchema),
  auth: opt(authSchema),
  providers: opt(z.record(z.string(), opt(providerSchema))),
  rate_limits: opt(rateLimitsSchema),
  cache: opt(cacheSchema),
  responses: opt(responsesSchema),
  validation: opt(validationSchema),
  model_mappings: opt(z.array(modelMappingSchema)),
});

export type RawProviderConfig = z.infer<typeof providerSchema>;
