import assert from 'node:assert/strict';
import test from 'node:test';

import { createBranchStore } from './branchStore';
import type { BranchSnapshot, BranchStoreScheduler } from './branchStore';

const MAIN: BranchSnapshot = { branch: 'main', notGitRepository: false };
const FEATURE: BranchSnapshot = { branch: 'feature/x', notGitRepository: false };

/** Scheduler the test drives by hand: no real timers, no real DOM. */
function createFakeScheduler({ visible = true } = {}) {
  const ticks: (() => void)[] = [];
  const resumes: (() => void)[] = [];
  let repeats = 0;
  let cancelled = 0;

  const scheduler: BranchStoreScheduler = {
    repeat(handler) {
      repeats += 1;
      ticks.push(handler);
      return ticks.length;
    },
    cancelRepeat() {
      cancelled += 1;
    },
    onResume(handler) {
      resumes.push(handler);
      return () => {
        resumes.splice(resumes.indexOf(handler), 1);
      };
    },
    isVisible: () => visible,
  };

  return {
    scheduler,
    tick: () => ticks.forEach((handler) => handler()),
    resume: () => resumes.forEach((handler) => handler()),
    countRepeats: () => repeats,
    countCancels: () => cancelled,
    activeResumes: () => resumes.length,
  };
}

/** Resolves fetch calls manually so the test controls response ordering. */
function createDeferredFetcher() {
  const calls: { projectId: string; resolve: (snapshot: BranchSnapshot | null) => void }[] = [];
  return {
    fetchBranch: (projectId: string) =>
      new Promise<BranchSnapshot | null>((resolve) => {
        calls.push({ projectId, resolve });
      }),
    calls,
    resolveLast: (snapshot: BranchSnapshot | null) => calls[calls.length - 1].resolve(snapshot),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('subscribe probes immediately and notifies listeners', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  const seen: BranchSnapshot[] = [];
  store.subscribe('p1', (snapshot) => seen.push(snapshot));

  assert.equal(fetcher.calls.length, 1, 'first subscriber probes at once, not after a tick');
  fetcher.resolveLast(MAIN);
  await flush();

  assert.deepEqual(seen, [MAIN]);
  assert.deepEqual(store.getSnapshot('p1'), MAIN);
});

test('one probe serves every subscriber of the same project', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  const first: BranchSnapshot[] = [];
  const second: BranchSnapshot[] = [];
  store.subscribe('p1', (snapshot) => first.push(snapshot));
  store.subscribe('p1', (snapshot) => second.push(snapshot));

  fake.tick();
  assert.equal(fetcher.calls.length, 1, 'a tick must not fan out into one request per subscriber');
  fetcher.resolveLast(FEATURE);
  await flush();

  assert.deepEqual(first, [FEATURE]);
  assert.deepEqual(second, [FEATURE]);
});

test('unchanged branch does not notify twice', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  let notifications = 0;
  store.subscribe('p1', () => (notifications += 1));
  fetcher.resolveLast(MAIN);
  await flush();

  fake.tick();
  fetcher.resolveLast(MAIN);
  await flush();

  assert.equal(notifications, 1);
});

test('a failed probe keeps the last known branch and does not notify', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  const seen: BranchSnapshot[] = [];
  store.subscribe('p1', (snapshot) => seen.push(snapshot));
  fetcher.resolveLast(MAIN);
  await flush();

  fake.tick();
  fetcher.resolveLast(null); // network / git failure
  await flush();

  assert.deepEqual(seen, [MAIN]);
  assert.deepEqual(store.getSnapshot('p1'), MAIN);
});

test('hidden tabs skip the tick and catch up on resume', async () => {
  const fake = createFakeScheduler({ visible: false });
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  store.subscribe('p1', () => {});
  assert.equal(fetcher.calls.length, 0, 'a hidden tab must not probe');

  fake.tick();
  assert.equal(fetcher.calls.length, 0);

  fake.resume(); // the fake keeps isVisible() false, so still nothing
  assert.equal(fetcher.calls.length, 0);
});

test('polling stops when the last subscriber leaves, and late results are dropped', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  const seen: BranchSnapshot[] = [];
  const unsubscribe = store.subscribe('p1', (snapshot) => seen.push(snapshot));
  unsubscribe();

  assert.equal(fake.countCancels(), 1);
  assert.equal(fake.activeResumes(), 0);
  assert.equal(fake.countRepeats(), 1);

  fetcher.resolveLast(MAIN); // in-flight response arrives after everyone left
  await flush();

  assert.deepEqual(seen, [], 'a late response must not reach a cancelled subscriber');
  assert.equal(store.getSnapshot('p1'), null);
});

test('subscribeChange treats the first result as the baseline only', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  // The header-style subscriber keeps the entry hot, so the baseline is known
  // before the heavy consumer shows up (same as opening the git tab later).
  store.subscribe('p1', () => {});
  fetcher.resolveLast(MAIN);
  await flush();

  const changes: BranchSnapshot[] = [];
  store.subscribeChange('p1', (snapshot) => changes.push(snapshot));
  assert.deepEqual(changes, [], 'subscribing itself is not a change');

  fake.tick();
  fetcher.resolveLast(FEATURE);
  await flush();
  assert.deepEqual(changes, [FEATURE]);
});

test('subscribeChange fires when the first result differs from the cached baseline', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  store.subscribe('p1', () => {});
  fetcher.resolveLast(MAIN);
  await flush();

  // Branch moved while the consumer was unmounted: its baseline is stale, so the
  // change must still reach it.
  const changes: BranchSnapshot[] = [];
  store.subscribeChange('p1', (snapshot) => changes.push(snapshot));

  fake.tick();
  fetcher.resolveLast(FEATURE);
  await flush();

  assert.deepEqual(changes, [FEATURE]);
});

test('notGitRepository transitions notify like a branch change', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  const changes: (string | null)[] = [];
  store.subscribe('p1', () => {});
  fetcher.resolveLast(MAIN);
  await flush();

  store.subscribeChange('p1', (snapshot) => changes.push(snapshot.notGitRepository ? 'not-git' : snapshot.branch));
  fake.tick();
  fetcher.resolveLast({ branch: '', notGitRepository: true });
  await flush();

  assert.deepEqual(changes, ['not-git']);
});

test('projects are tracked independently', async () => {
  const fake = createFakeScheduler();
  const fetcher = createDeferredFetcher();
  const store = createBranchStore({ fetchBranch: fetcher.fetchBranch, scheduler: fake.scheduler });

  store.subscribe('p1', () => {});
  store.subscribe('p2', () => {});

  assert.equal(fetcher.calls.length, 2);
  assert.deepEqual(
    fetcher.calls.map((call) => call.projectId).sort(),
    ['p1', 'p2'],
  );

  fetcher.calls[0].resolve(MAIN);
  await flush();
  assert.deepEqual(store.getSnapshot('p1'), MAIN);
  assert.equal(store.getSnapshot('p2'), null);
});
