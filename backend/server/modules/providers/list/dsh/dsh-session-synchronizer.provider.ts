import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Session indexer for DeepSeek Harness.
 *
 * IMPORTANT — semantic difference from the other providers' synchronizers:
 * dsh persists sessions as checksummed Zstandard frames by default
 * (`session.vN.jsonl.zstd`), so this synchronizer deliberately does NOT parse
 * transcripts off disk during background scans. History IS served from disk —
 * by the sessions provider's `fetchHistory`, which decodes the zstd frames
 * with the built-in `node:zlib` (see `dsh-session-log.ts`) — but rows for
 * app-created sessions already exist from the gateway, and their
 * summary/jsonl_path are backfilled lazily on the first history read, so
 * there is no indexing work for a background scan to do. `synchronizeFile`
 * therefore never reads the file it is given.
 *
 * See docs/superpowers/specs/2026-10-08-deepseek-harness-provider-design.md §2.3
 * for why the on-disk format was not forced to `compression: none`.
 */
export class DshSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    // No disk scan: a background scan would either need to spawn a runtime or
    // decode zstd, both rejected by the design. dsh sessions are enumerated
    // over ACP by the runner, which upserts what it discovers itself.
    void since;
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    // Intentionally does not open `filePath` (zstd/unreadable by design).
    void filePath;
    return null;
  }
}
