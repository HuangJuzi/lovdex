import { open } from 'node:fs/promises';

import type { RemoteFsClient } from '@/modules/remote-agents/remote-fs.service.js';

/**
 * 4MiB per chunk. Base64 inflates that to ~5.33MiB, comfortably under the ws
 * `maxPayload` default (100MiB) on BOTH ends, so no `maxPayload` tuning is
 * needed. The main side only ever holds one chunk buffer at a time.
 */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export type PushFileToRemoteDeps = {
  fsClient: RemoteFsClient;
  hostId: string;
};

/**
 * Stream one local file to a remote host over the chunked-upload RPCs.
 *
 * Reads the source in `UPLOAD_CHUNK_BYTES` slices so memory stays flat
 * regardless of file size; the lite appends each chunk to a `.part` file and
 * commits it with a rename on `end`. There is no resume: a failure mid-stream
 * propagates, and the lite drops the partial `.part` (ws close or idle timer).
 */
export async function pushFileToRemote(
  deps: PushFileToRemoteDeps,
  localPath: string,
  remotePath: string,
): Promise<{ size: number }> {
  const { fsClient, hostId } = deps;
  const { uploadId } = await fsClient.uploadBegin(hostId, remotePath);

  const handle = await open(localPath, 'r');
  try {
    const buf = Buffer.alloc(UPLOAD_CHUNK_BYTES);
    let index = 0;
    let total = 0;
    // A zero-byte file must still send one chunk so the lite's session machine
    // (begin → chunk* → end) stays uniform.
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, UPLOAD_CHUNK_BYTES, null);
      if (bytesRead === 0 && index > 0) break;
      const slice = bytesRead === UPLOAD_CHUNK_BYTES ? buf : buf.subarray(0, bytesRead);
      await fsClient.uploadChunk(hostId, uploadId, index, slice.toString('base64'));
      index += 1;
      total += bytesRead;
      if (bytesRead === 0) break; // zero-byte file: one pass, then done
    }
    await fsClient.uploadEnd(hostId, uploadId);
    return { size: total };
  } finally {
    await handle.close();
  }
}
