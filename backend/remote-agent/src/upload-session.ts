import { promises as fsp } from 'node:fs';

import type { AllowlistedFs } from './fs.js';

/**
 * Chunked upload sessions on the lite side.
 *
 * Main pushes an arbitrarily large file as an ordered run of base64 chunks
 * (see `makeFsUploadChunkParamsSchema`). Each session appends to a sibling
 * `<target>.part` file and, on `end`, `rename`s it onto the target — same
 * filesystem, so the final step is atomic and never materializes the whole
 * file in memory.
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
  timer: NodeJS.Timeout;
};

export function createUploadSessions(opts: {
  fs: AllowlistedFs;
  idleMs?: number;
}): UploadSessions {
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  const sessions = new Map<string, Session>();
  let counter = 0;

  async function drop(uploadId: string): Promise<void> {
    const session = sessions.get(uploadId);
    if (!session) return;
    sessions.delete(uploadId);
    clearTimeout(session.timer);
    try {
      await session.fd.close();
    } catch {
      /* already closed */
    }
    await fsp.unlink(session.partPath).catch(() => {});
  }

  function touch(uploadId: string): void {
    const session = sessions.get(uploadId);
    if (!session) return;
    clearTimeout(session.timer);
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
      // Never write THROUGH a dangling symlink leaf: the `.part` is a sibling
      // of the target, but a symlinked TARGET would make the final rename land
      // outside the roots. Mirrors `write()`'s guard.
      try {
        const leaf = await fsp.lstat(resolvedTarget);
        if (leaf.isSymbolicLink()) throw new Error('path outside allowed root (symlink leaf)');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const uploadId = `up-${process.pid}-${++counter}`;
      const partPath = `${resolvedTarget}.part-${uploadId}`;
      const fd = await fsp.open(partPath, 'w');
      const session: Session = {
        fd,
        targetPath: resolvedTarget,
        partPath,
        nextIndex: 0,
        received: 0,
        timer: setTimeout(() => {}, 0),
      };
      sessions.set(uploadId, session);
      touch(uploadId);
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
      touch(uploadId);
      return { received: session.received };
    },

    async end(uploadId) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`unknown upload session: ${uploadId}`);
      const { fd, targetPath, partPath, received } = session;
      sessions.delete(uploadId);
      clearTimeout(session.timer);
      // fsync before the rename: a crash must not leave a renamed-but-empty file
      // that looks like a successful upload.
      await fd.sync();
      await fd.close();
      await fsp.rename(partPath, targetPath);
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
