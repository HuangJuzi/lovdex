import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import {
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

const QODER_SESSION_FALLBACK_TITLE = 'Untitled Qoder Session';

/**
 * Decodes a Qoder project directory name back into a filesystem path.
 *
 * Qoder stores one directory per working directory under `~/.qoder/projects/`,
 * encoding the cwd by replacing every `/` with `-` (e.g.
 * `/mnt/b/workdir/gitlab/backend` becomes `-mnt-b-workdir-gitlab-backend`).
 * That encoding is lossy for cwds that already contain literal `-` characters,
 * so this best-effort decode is only a fallback: the exact `cwd` is recovered
 * from the transcript's own `cwd` field whenever it is present.
 */
function decodeQoderProjectDir(encodedDir: string): string {
  return encodedDir.replace(/-/g, '/');
}

/**
 * Session indexer for Qoder JSONL transcript artifacts.
 */
export class QoderSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'qoder' as const;
  private readonly qoderProjectsRoot = path.join(os.homedir(), '.qoder', 'projects');

  /**
   * Returns true only for top-level session transcripts, i.e. files sitting
   * directly inside a `<encoded-cwd>/` directory (`projects/<encoded-cwd>/<uuid>.jsonl`).
   *
   * Qoder may also write per-session artifacts under a `<uuid>/` sibling
   * directory (e.g. `state.json`, and possibly subagent transcripts in the
   * future). The recursive scan reaches those too, so both entry points must
   * reject anything not at the exact session-file depth, mirroring how the
   * Claude synchronizer skips subagent/tool-result files.
   */
  private isTopLevelSessionFile(filePath: string): boolean {
    if (!filePath.endsWith('.jsonl')) {
      return false;
    }
    // Subagent transcripts (if Qoder ever writes them as `agent-*.jsonl`
    // siblings of the session file) are not standalone sessions; the sessions
    // facet reads them separately. Skip them defensively.
    if (path.basename(filePath).startsWith('agent-')) {
      return false;
    }
    // A top-level session is at projects/<encoded-cwd>/<uuid>.jsonl, i.e. its
    // relative depth from the projects root is exactly two segments. Using
    // path.relative keeps this robust against symlinked or non-canonical home
    // dirs (where a naive dirname equality against qoderProjectsRoot breaks).
    const relative = path.relative(this.qoderProjectsRoot, filePath);
    const segments = relative.split(path.sep).filter(Boolean);
    return segments.length === 2 && segments.every((seg) => seg !== '..');
  }

  /**
   * Scans ~/.qoder/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(
      this.qoderProjectsRoot,
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (!this.isTopLevelSessionFile(filePath)) {
        continue;
      }

      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) {
        processed += 1;
      }
    }

    return processed;
  }

  /**
   * Parses and upserts one Qoder session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!this.isTopLevelSessionFile(filePath)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Qoder JSONL session file.
   */
  private async processSessionFile(filePath: string): Promise<ParsedSession | null> {
    // Each `<uuid>.jsonl` file is one session keyed by its filename.
    const providerSessionId = path.basename(filePath, '.jsonl');
    if (!providerSessionId) {
      return null;
    }

    // The immediate parent directory name is the encoded working directory.
    const encodedDir = path.basename(path.dirname(filePath));
    let projectPath = decodeQoderProjectDir(encodedDir);

    // Prefer the exact cwd recorded in the transcript over the lossy decode,
    // and read the first user prompt so sessions without a stored title still
    // get a readable name.
    const metadata = await this.readSessionMetadata(filePath);
    if (metadata.cwd) {
      projectPath = metadata.cwd;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(providerSessionId)
      ?? sessionsDb.getSessionById(providerSessionId);
    const existingSessionName = existingSession?.custom_name;

    let sessionName: string | undefined;
    if (existingSessionName && existingSessionName !== QODER_SESSION_FALLBACK_TITLE) {
      sessionName = existingSessionName;
    } else {
      sessionName = metadata.firstUserText;
    }

    return {
      sessionId: providerSessionId,
      projectPath,
      sessionName: normalizeSessionName(sessionName, QODER_SESSION_FALLBACK_TITLE),
    };
  }

  private async readSessionMetadata(
    filePath: string
  ): Promise<{ cwd?: string; firstUserText?: string }> {
    const metadata: { cwd?: string; firstUserText?: string } = {};

    try {
      const fileStream = fs.createReadStream(filePath);
      const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of lineReader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (metadata.cwd === undefined && typeof data.cwd === 'string' && data.cwd.trim()) {
          metadata.cwd = data.cwd.trim();
        }

        if (metadata.firstUserText === undefined) {
          const message = data.message as Record<string, unknown> | undefined;
          if (message && message.role === 'user') {
            const content = message.content;
            if (typeof content === 'string' && content.trim()) {
              metadata.firstUserText = content.trim();
            } else if (Array.isArray(content)) {
              for (const part of content) {
                if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                  metadata.firstUserText = part.text.trim();
                  break;
                }
              }
            }
          }
        }

        if (metadata.cwd !== undefined && metadata.firstUserText !== undefined) {
          break;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return metadata;
  }
}
