// Service entry point. One build runs as three systemd units, told apart only
// by SERVICE_ROLE: `web` serves the HTTP API behind Caddy, `worker` runs the
// job ledger and round clock, `codex` drives the AI content worker.
import { Pool } from 'pg';

import {
  createCodexEngine,
  PostgresDirectorThreadStore,
} from './ai/codex.js';
import { createCodexStoryReviewer } from './ai/codex-story-review.js';
import { createStubEngine } from './ai/stub.js';
import { loadConfig, type Config } from './config.js';
import { H3GatewayClient } from './h3/gateway.js';
import {
  CONTENT_HANDLERS,
  MAINTENANCE_HANDLERS,
} from './jobs/handlers/index.js';
import { startWorker } from './jobs/scheduler.js';
import { buildApp } from './web/app.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // Nothing is up yet — not even a logger — so this goes straight to stderr,
  // where systemd hands it to journald.
  console.error(`[crowdmovie] ${(error as Error).message}`);
  process.exit(1);
}

async function startWeb(config: Config): Promise<void> {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const app = buildApp(config, pool);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      shutdown(signal).catch((error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
    });
  }

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error({ err: error }, 'failed to bind listener');
    process.exit(1);
  }
}

function startRoundWorker(config: Config): void {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  // The ordinary worker owns the PostgreSQL clock/recovery loop and hourly
  // housekeeping. Content and H3 handlers are claimed exclusively by the
  // Codex unit below, so an idle stub can never win a race and write fake
  // production content.
  const worker = startWorker({
    pool,
    config,
    engine: createStubEngine(),
    handlers: MAINTENANCE_HANDLERS,
  });
  console.log('[crowdmovie] workflow clock/recovery worker started');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`[crowdmovie] worker stopping on ${signal}`);
      worker
        .stop()
        .then(() => pool.end())
        .catch((error: unknown) => {
          console.error('[crowdmovie] worker shutdown failed', error);
          process.exit(1);
        });
    });
  }
}

function startCodexWorker(config: Config): void {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const reviewer = createCodexStoryReviewer(config);
  const engine = createCodexEngine(config, {
    directorThreads: new PostgresDirectorThreadStore(pool),
  });
  const h3 = new H3GatewayClient(
    config.H3_BASE_URL,
    fetch,
    config.H3_REQUEST_TIMEOUT_MS,
  );
  const worker = startWorker({
    pool,
    config,
    engine,
    reviewer,
    h3,
    handlers: CONTENT_HANDLERS,
  });
  console.log(
    `[crowdmovie] content controller started (story-review=${config.CODEX_MODEL}/high; final+episode=${config.CODEX_MODEL}/xhigh; score+director+subtitles=${config.QWEN_COPYRIGHT_FALLBACK_MODEL}/none@${config.QWEN_COPYRIGHT_FALLBACK_BASE_URL}; qwen-max-concurrency=${config.QWEN_MAX_CONCURRENCY}; H3=${config.H3_BASE_URL})`,
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`[crowdmovie] Codex controller stopping on ${signal}`);
      worker
        .stop()
        .then(() => pool.end())
        .catch((error: unknown) => {
          console.error('[crowdmovie] Codex controller shutdown failed', error);
          process.exit(1);
        });
    });
  }
}

switch (config.SERVICE_ROLE) {
  case 'web':
    await startWeb(config);
    break;
  case 'worker':
    startRoundWorker(config);
    break;
  case 'codex':
    startCodexWorker(config);
    break;
}
