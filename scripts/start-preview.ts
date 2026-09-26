import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrate } from '../packages/db/src/migrate';
import type { IdentityDatabase } from '../packages/identity/src/database';
import { cleanupExpiredIdentityProofs } from '../packages/identity/src/security';
import { serviceConfiguration } from './run-service.mjs';

interface PreviewRuntime {
  signal: AbortSignal;
  migrate(): Promise<void>;
  cleanup(): Promise<number>;
  launchWeb(): ChildProcess;
  close(): Promise<void>;
  log(message: string): void;
  maintenanceIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

/** A sleeping free service cannot promise wall-clock cleanup; each wake cleans before serving. */
export async function supervisePreview(runtime: PreviewRuntime): Promise<number> {
  let web: ChildProcess | undefined;
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let maintenance = Promise.resolve();
  let closing = false;
  const stop = () => {
    closing = true;
    clearTimeout(maintenanceTimer);
    if (web && web.exitCode === null && web.signalCode === null) {
      web.kill('SIGTERM');
      shutdownTimer ??= setTimeout(() => web?.kill('SIGKILL'), runtime.shutdownTimeoutMs ?? 15_000);
      shutdownTimer.unref();
    }
  };
  const scheduleCleanup = () => {
    if (closing || runtime.signal.aborted) return;
    maintenanceTimer = setTimeout(() => {
      maintenance = Promise.resolve()
        .then(() => runtime.cleanup())
        .then(() => undefined)
        .catch(() => runtime.log('Preview proof cleanup interrupted; retrying on the next cycle.'))
        .finally(scheduleCleanup);
    }, runtime.maintenanceIntervalMs ?? 60_000);
    maintenanceTimer.unref();
  };
  runtime.signal.addEventListener('abort', stop, { once: true });
  try {
    if (runtime.signal.aborted) return 0;
    await runtime.migrate();
    if (runtime.signal.aborted) return 0;
    await runtime.cleanup();
    if (runtime.signal.aborted) return 0;
    web = runtime.launchWeb();
    const exited = new Promise<number>((resolveExit) => {
      web!.once('error', () => {
        runtime.log('Preview web process could not start.');
        resolveExit(1);
      });
      web!.once('exit', (code) => resolveExit(code ?? 1));
    });
    scheduleCleanup();
    runtime.log('Preview ready to start: accounts and manual splits; receipts and agent disabled.');
    const exitCode = await exited;
    // Unexpected successful termination still means the hosted web service is unavailable.
    return runtime.signal.aborted ? 0 : exitCode || 1;
  } finally {
    closing = true;
    clearTimeout(maintenanceTimer);
    clearTimeout(shutdownTimer);
    runtime.signal.removeEventListener('abort', stop);
    await maintenance;
    await runtime.close();
  }
}

export async function startPreview(signal: AbortSignal): Promise<number> {
  // Recheck/filter even when this script is invoked without the ordinary role launcher.
  const { environment } = serviceConfiguration('web-preview', process.env);
  const connectionString = environment.DATABASE_URL!;
  const db = new Kysely<IdentityDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        lock_timeout: 5_000,
        application_name: 'tallie-preview-maintenance',
      }),
    }),
  });
  const root = fileURLToPath(new URL('../', import.meta.url));
  return supervisePreview({
    signal,
    migrate: () =>
      migrate(connectionString, {
        connectionTimeoutMillis: 5_000,
        statementTimeoutMillis: 30_000,
        lockTimeoutMillis: 10_000,
      }),
    cleanup: () => cleanupExpiredIdentityProofs(db),
    close: () => db.destroy(),
    launchWeb: () =>
      spawn(
        process.execPath,
        [
          resolve(root, 'node_modules/next/dist/bin/next'),
          'start',
          '--hostname',
          environment.APP_HOST!,
        ],
        { cwd: resolve(root, 'apps/web'), env: environment, stdio: 'inherit' },
      ),
    log: (message) => console.info(message),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await startPreview(controller.signal);
  } catch {
    // Database URLs, provider credentials and raw driver errors never enter logs.
    console.error(
      'Preview startup failed. Check configuration, migration status and database access.',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
