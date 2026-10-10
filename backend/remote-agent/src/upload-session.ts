import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { AllowlistedFs } from './fs.js';

/**
 * Chunked upload sessions on the lite side.
 *
 * Main pushes an arbitrarily large file as an ordered run of base64 chunks
 * (see `makeFsUploadChunkParamsSchema`). Each session appends to a private
 * `<target-dir>/.<name>.part-<uploadId>` file and, on `end`, `rename`s it onto
 * the target — same filesystem, so the final step is atomic and never
 * materializes the whole file in memory.
 *
 * Two properties matter for safety, because the peer that can write inside a
 * project may be running untrusted repository content:
 *  - the `.part` directory is vetted through the roots allowlist (the target
 *    being a root would otherwise put the part file one level OUTSIDE it);
 *  - the name is a random UUID opened with `'wx'` (O_CREAT|O_EXCL), so a
 *    symlink pre-planted at a guessable name makes `open` fail with EEXIST
 *    instead of being followed and truncating a file outside the sandbox.
 *
 * `idleMs` bounds how long a half-finished upload may pin a `.part` file: a
 * dropped connection is handled by `abortAll` on ws close, but a peer that
 * simply stops sending would otherwise leak the partial file forever.
 */

export type UploadSessions = {
  begin(targetPath: string): Promise<{ uploadId: string }>;
  chunk(uploadId: string, index: number, dataBase64: string): Promise<{ received: number }>;
  end(uploadId: string): Promise<{ success: true; size: number }>;
  /** Tear every session down (ws close / shutdown). */
  abortAll(): Promise<void>;
  /** Number of live sessions — for tests and diagnostics. */
  size(): number;
  /** TEST SEAM: the `.part` path for a live session, else null. */
  partPathForTest(uploadId: string): string | null;
};

type Session = {
  fd: fsp.FileHandle;
  targetPath: string;
  partPath: string;
  nextIndex: number;
  received: number;
  timer: NodeJS.Timeout | null;
};

/** Injected rename so tests can force an `end` failure deterministically. */
export type RenameFn = (from: string, to: string) => Promise<void>;

export function createUploadSessions(opts: {
  fs: AllowlistedFs;
  idleMs?: number;
  /** Override for tests; defaults to node:fs/promises rename. */
  rename?: RenameFn;
}): UploadSessions {
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  // A non-positive or non-finite idle would drop every session the moment it
  // is created (or never free it), so fail loudly at construction instead.
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new Error(`idleMs must be a positive finite number, got ${idleMs}`);
  }
  const rename = opts.rename ?? fsp.rename;
  const sessions = new Map<string, Session>();

  async function drop(uploadId: string): Promise<void> {
    const session = sessions.get(uploadId);
    if (!session) return;
    sessions.delete(uploadId);
    if (session.timer) clearTimeout(session.timer);
    try {
      await session.fd.close();
    } catch {
      /* already closed */
    }
    await fsp.unlink(session.partPath).catch(() => {});
  }

  function refreshTimer(session: Session, uploadId: string): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void drop(uploadId);
    }, idleMs);
    // A pending timer must not hold the process open on shutdown.
    session.timer.unref?.();
  }

  return {
    async begin(targetPath) {
      // Throws `path outside allowed root` before anything is created.
      const resolvedTarget = opts.fs.resolveWithin(targetPath);

      const targetStat = await fsp.lstat(resolvedTarget).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null; // will be created by the rename
        throw error;
      });
      // A rename onto a directory fails with EISDIR — and only after the
      // session is registered and its timer cleared, which used to orphan the
      // part file. Reject it up front instead.
      if (targetStat?.isDirectory()) throw new Error('cannot upload over a directory');
      // Never write THROUGH a symlink leaf: a symlinked TARGET would make the
      // final rename replace the link itself rather than the file the caller
      // named. Mirrors `write()`'s guard.
      if (targetStat?.isSymbolicLink()) throw new Error('path outside allowed root (symlink leaf)');

      // The part file lives in the target's directory so `end`'s rename stays
      // on ONE filesystem. That directory goes through the allowlist too, so
      // the ONLY path this module ever opens with caller input is vetted.
      // Belt-and-braces today — a root target is already refused above — but
      // it is what keeps a future relaxation of the directory guard safe.
      const partDir = opts.fs.resolveWithin(path.dirname(resolvedTarget));

      // Random name + O_EXCL: a peer that can write inside the project cannot
      // pre-plant a symlink at a guessable name and have `open` follow it —
      // `'wx'` fails with EEXIST on anything already present, symlink included.
      const uploadId = `up-${randomUUID()}`;
      const partPath = path.join(partDir, `.${path.basename(resolvedTarget)}.part-${uploadId}`);
      const fd = await fsp.open(partPath, 'wx');
      const session: Session = {
        fd,
        targetPath: resolvedTarget,
        partPath,
        nextIndex: 0,
        received: 0,
        timer: null,
      };
      sessions.set(uploadId, session);
      refreshTimer(session, uploadId);
      return { uploadId };
    },

    async chunk(uploadId, index, dataBase64) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`unknown upload session: ${uploadId}`);
      if (index !== session.nextIndex) {
        await drop(uploadId);
        throw new Error(`out of order chunk: expected ${session.nextIndex}, got ${index}`);
      }
      const buf = Buffer.from(dataBase64, 'base64');
      await session.fd.write(buf);
      session.nextIndex += 1;
      session.received += buf.length;
      refreshTimer(session, uploadId);
      return { received: session.received };
    },

    async end(uploadId) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`unknown upload session: ${uploadId}`);
      const { fd, targetPath, partPath, received } = session;
      sessions.delete(uploadId);
      if (session.timer) clearTimeout(session.timer);
      try {
        // fsync before the rename: a crash must not leave a renamed-but-empty
        // file that looks like a successful upload.
        await fd.sync();
        await fd.close();
        await rename(partPath, targetPath);
      } catch (error) {
        // The session is already de-registered and its timer cleared, so
        // nothing else will ever reap this part file — clean it up here.
        await fd.close().catch(() => {});
        await fsp.unlink(partPath).catch(() => {});
        throw error;
      }
      return { success: true, size: received };
    },

    async abortAll() {
      await Promise.all([...sessions.keys()].map((id) => drop(id)));
    },

    size() {
      return sessions.size;
    },

    partPathForTest(uploadId) {
      return sessions.get(uploadId)?.partPath ?? null;
    },
  };
}
