import test from 'node:test';
import assert from 'node:assert/strict';

import { copyTextToClipboard } from './clipboard';

/**
 * The app is normally reached over http://<lan-ip>:<port>, which is NOT a secure
 * context: `navigator.clipboard` is undefined there (verified in Chrome — the
 * LAN origin reports isSecureContext=false, typeof navigator.clipboard
 * "undefined"). Every copy affordance therefore depends on the execCommand
 * fallback below, and on this function reporting the truth about what happened.
 */

type GlobalStubs = { navigator?: unknown; document?: unknown };

/** Mirrors the DOM surface fallbackCopyToClipboard touches, and records it. */
function makeFakeDocument(execResult: boolean) {
  const state = {
    execCalls: 0,
    execCommand: '',
    copiedText: null as string | null,
    appended: 0,
    removed: 0,
  };

  const doc = {
    body: {
      appendChild() { state.appended += 1; },
      removeChild() { state.removed += 1; },
    },
    createElement() {
      return {
        style: {} as Record<string, string>,
        setAttribute() {},
        focus() {},
        select() {},
        get value() { return state.copiedText ?? ''; },
        set value(next: string) { state.copiedText = next; },
      };
    },
    execCommand(command: string) {
      state.execCalls += 1;
      state.execCommand = command;
      return execResult;
    },
  };

  return { doc, state };
}

async function withGlobals<T>(stubs: GlobalStubs, run: () => Promise<T>): Promise<T> {
  const target = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(stubs)) {
    saved.set(key, Object.getOwnPropertyDescriptor(target, key));
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }

  try {
    return await run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
  }
}

test('falls back to execCommand when the Clipboard API is absent (insecure context)', async () => {
  const { doc, state } = makeFakeDocument(true);

  const copied = await withGlobals({ navigator: { clipboard: undefined }, document: doc }, () =>
    copyTextToClipboard('/mnt/b/workdir/github/lovdex/README.md'));

  assert.equal(copied, true);
  assert.equal(state.execCalls, 1);
  assert.equal(state.execCommand, 'copy');
  // The exact text handed to the clipboard must be the path we asked for.
  assert.equal(state.copiedText, '/mnt/b/workdir/github/lovdex/README.md');
  // The scratch textarea must not be left in the DOM.
  assert.equal(state.appended, 1);
  assert.equal(state.removed, 1);
});

test('reports failure when the execCommand fallback also fails', async () => {
  const { doc, state } = makeFakeDocument(false);

  const copied = await withGlobals({ navigator: { clipboard: undefined }, document: doc }, () =>
    copyTextToClipboard('/tmp/x'));

  assert.equal(copied, false);
  assert.equal(state.execCalls, 1);
  assert.equal(state.appended, state.removed);
});

test('reports failure without throwing when there is no document at all', async () => {
  const copied = await withGlobals({ navigator: { clipboard: undefined } }, () =>
    copyTextToClipboard('/tmp/x'));

  assert.equal(copied, false);
});

test('uses the Clipboard API when the context is secure', async () => {
  const written: string[] = [];
  const clipboard = { writeText: async (text: string) => { written.push(text); } };

  const copied = await withGlobals({ navigator: { clipboard } }, () =>
    copyTextToClipboard('/tmp/secure'));

  assert.equal(copied, true);
  assert.deepEqual(written, ['/tmp/secure']);
});

test('treats empty input as nothing to copy', async () => {
  const { doc, state } = makeFakeDocument(true);

  const copied = await withGlobals({ navigator: { clipboard: undefined }, document: doc }, () =>
    copyTextToClipboard(''));

  assert.equal(copied, false);
  assert.equal(state.execCalls, 0);
});
