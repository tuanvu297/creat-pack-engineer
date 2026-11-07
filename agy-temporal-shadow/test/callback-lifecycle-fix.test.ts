// Unit tests for the 2026-11-02 callback/qualification lifecycle fix.
// Evidence class: UNIT (stub pool, no database). The behaviours
// pinned here come from live failures observed on the staging
// runtime during run-20261102-restore3 (2026-11-02):
//   - the callback driver expired 8 minutes after container boot
//     (AGY_CALLBACK_DRIVER_TIMEBOX_MS=480000) while the owner
//     window had hours left, stranding a recorded callback in
//     PENDING until an operator restarted the service by hand;
//   - shutdown ended the pool while driver/controller timers were
//     still live, producing pool-after-end errors;
//   - a completed qualification run (G2) blocked every later grant
//     until an operator deleted its 17 evidence rows by hand.
// Integration coverage for the controller's SQL paths lives in
// test/callback-lifecycle.integration.test.ts (requires
// AGY_TEST_DATABASE_URL; skipped otherwise).
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerCallbackDriver, parseCallbackDriverConfig } from "../src/platform/worker-callback-driver.js";
import { assessPriorRun, type PriorRunFacts } from "../src/platform/qualification-controller.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_QUALIFICATION' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pool that answers every query with an empty result and hands
// out stub clients — enough for a driver tick to walk its blocked /
// recover / reconcile / dispatch phases and find nothing to do.
const emptyPool: any = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
};
const operator: any = { subject: 'op', role: 'operator', scopes: [scope] };
const noopTransport: any = async () => ({ accepted: true });
const noopLookup: any = async () => ({ found: false });

function makeDriver(cfg: Record<string, unknown>, logs: any[], pool: any = emptyPool) {
  return createWorkerCallbackDriver(pool, {
    config: { enabled: true, scope, missionId: 'GL_QUALIFICATION', runId: 'run-x', intervalMs: 25, limit: 1, ...cfg } as any,
    operator, transport: noopTransport, lookup: noopLookup,
    log: (event: string, detail?: Record<string, unknown>) => { logs.push({ event, ...(detail ?? {}) }); },
  });
}

test("driver: delivery gate survives past the old startup timebox (restore3 regression)", async () => {
  const logs: any[] = [];
  const drv = makeDriver({ expiresAtMs: Date.now() + 60_000, timeboxMs: 40 }, logs);
  assert.equal(drv.start(), 'RUNNING');
  await sleep(160); // > 4x the configured timebox; old code expired the driver at start+timebox
  assert.equal(drv.state(), 'RUNNING', 'driver must not expire at startedAt + timeboxMs');
  assert.ok(!logs.some((l) => l.event === 'CALLBACK_DRIVER_EXPIRED'), 'no EXPIRED before the owner deadline');
  drv.stop();
});

test("driver: a restart inside the window re-derives the same absolute deadline", async () => {
  const expiresAtMs = Date.now() + 60_000;
  const logsA: any[] = [];
  const a = makeDriver({ expiresAtMs, timeboxMs: 40 }, logsA);
  assert.equal(a.start(), 'RUNNING');
  a.stop(); // container death / redeploy
  await sleep(80); // later than a-start + timebox
  const logsB: any[] = [];
  const b = makeDriver({ expiresAtMs, timeboxMs: 40 }, logsB);
  assert.equal(b.start(), 'RUNNING', 'restarted driver lives until the owner expiry, not its own start + timebox');
  await sleep(60);
  assert.equal(b.state(), 'RUNNING');
  b.stop();
});

test("driver: an already-expired owner window still starts EXPIRED (stale grant)", async () => {
  const logs: any[] = [];
  const drv = makeDriver({ expiresAtMs: Date.now() - 1000, timeboxMs: 3_600_000 }, logs);
  assert.equal(drv.start(), 'EXPIRED');
  assert.ok(logs.some((l) => l.event === 'CALLBACK_DRIVER_EXPIRED'));
});

test("driver: timeboxMs=0 no longer expires the driver at start (config kept for compatibility)", async () => {
  const logs: any[] = [];
  const drv = makeDriver({ expiresAtMs: Date.now() + 60_000, timeboxMs: 0 }, logs);
  assert.equal(drv.start(), 'RUNNING');
  drv.stop();
});

test("driver: pool ended during shutdown stops the driver quietly (no per-tick error spam)", async () => {
  const endedPool: any = {
    query: async () => { throw new Error('Cannot use a pool after calling end on the pool'); },
    connect: async () => { throw new Error('Cannot use a pool after calling end on the pool'); },
  };
  const logs: any[] = [];
  const drv = makeDriver({ expiresAtMs: Date.now() + 60_000, timeboxMs: 3_600_000 }, logs, endedPool);
  assert.equal(drv.start(), 'RUNNING');
  await sleep(120);
  assert.equal(drv.state(), 'STOPPED');
  assert.ok(logs.some((l) => l.event === 'CALLBACK_DRIVER_POOL_ENDED'), 'pool end is reported once, as a stop');
  assert.ok(!logs.some((l) => l.event === 'CALLBACK_DRIVER_PASS_ERROR'), 'no pass-error spam against the dead pool');
  drv.stop();
});

test("driver config: AGY_CALLBACK_DRIVER_TIMEBOX_MS is still parsed (compatibility)", () => {
  const { config } = parseCallbackDriverConfig({
    AGY_CALLBACK_DRIVER_ENABLED: 'true',
    AGY_CALLBACK_DRIVER_SCOPE: 'gl:legacy-workspace:GL_QUALIFICATION',
    AGY_CALLBACK_DRIVER_MISSION: 'GL_QUALIFICATION',
    AGY_CALLBACK_DRIVER_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    AGY_CALLBACK_DRIVER_RUN_ID: 'run-x',
    AGY_CALLBACK_DRIVER_TIMEBOX_MS: '480000',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.timeboxMs, 480000);
});

// ------------------------------------------------------------------
// assessPriorRun — the settled-history gate for qualification grants
// ------------------------------------------------------------------
const NOW = Date.parse('2026-11-02T12:00:00Z');
const facts = (over: Partial<PriorRunFacts>): PriorRunFacts => ({
  markerPhase: 'GRANTED',
  markerExpiresAtMs: NOW - 60_000, // expired an hour ago
  jobPresent: true,
  taskStatuses: ['QA'],
  liveLease: false,
  callbackStatuses: ['DELIVERED'],
  ...over,
});

test("prior run: settled + expired + callback delivered is ARCHIVABLE (the G2/restore3 shape)", () => {
  assert.equal(assessPriorRun(facts({}), NOW), 'ARCHIVABLE');
});

test("prior run: unexpired marker is never archivable (live grant is not weakened)", () => {
  assert.equal(assessPriorRun(facts({ markerExpiresAtMs: NOW + 60_000 }), NOW), 'PREVIOUS_RUN_GRANT_PRESENT');
  assert.equal(assessPriorRun(facts({ markerExpiresAtMs: NOW }), NOW), 'PREVIOUS_RUN_GRANT_PRESENT');
});

test("prior run: GRANTED marker without its job is an inconsistency, not history", () => {
  assert.equal(assessPriorRun(facts({ jobPresent: false }), NOW), 'PREVIOUS_RUN_JOB_MISSING');
});

test("prior run: PREPARING marker without a job (died before phase B) is archivable once expired", () => {
  assert.equal(assessPriorRun(facts({ markerPhase: 'PREPARING', jobPresent: false, taskStatuses: [], callbackStatuses: [] }), NOW), 'ARCHIVABLE');
});

test("prior run: live work or a live lease keeps the run unsettled", () => {
  assert.equal(assessPriorRun(facts({ taskStatuses: ['RUNNING'] }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
  assert.equal(assessPriorRun(facts({ taskStatuses: ['CLAIMED'] }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
  assert.equal(assessPriorRun(facts({ liveLease: true }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
});

test("prior run: an undelivered callback keeps the run unsettled (evidence is never buried)", () => {
  assert.equal(assessPriorRun(facts({ callbackStatuses: ['PENDING'] }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
  assert.equal(assessPriorRun(facts({ callbackStatuses: ['BLOCKED'] }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
  assert.equal(assessPriorRun(facts({ callbackStatuses: ['DELIVERED', 'SENDING'] }), NOW), 'PREVIOUS_RUN_NOT_SETTLED');
});

test("prior run: expired QUEUED task with no callback is settled (it can never be claimed after the deadline)", () => {
  assert.equal(assessPriorRun(facts({ taskStatuses: ['QUEUED'], callbackStatuses: [] }), NOW), 'ARCHIVABLE');
  assert.equal(assessPriorRun(facts({ taskStatuses: ['FAILED'], callbackStatuses: [] }), NOW), 'ARCHIVABLE');
});
