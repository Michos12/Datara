import type { HealthResponse, ReadinessResponse } from '@ci/contracts';
import { Router } from 'express';

export interface HealthChecks {
  database(): Promise<boolean>;
  migrations(): Promise<boolean>;
  analytics(): Promise<boolean>;
}

const CHECK_TIMEOUT_MS = 2000;

async function probe(check: () => Promise<boolean>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
    });
    return (await Promise.race([check(), timeout])) ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(checks: HealthChecks, version: string): Router {
  const router = Router();

  /** Liveness: the process is up and serving HTTP. */
  router.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', service: 'api', version };
    res.json(body);
  });

  /** Readiness: database reachable and migrated. Analytics is reported but not required. */
  router.get('/ready', async (_req, res) => {
    const [database, migrations, analytics] = await Promise.all([
      probe(() => checks.database()),
      probe(() => checks.migrations()),
      probe(() => checks.analytics()),
    ]);
    const ready = database === 'up' && migrations === 'up';
    const body: ReadinessResponse = {
      status: ready ? 'ready' : 'not_ready',
      checks: { database, migrations, analytics },
    };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
