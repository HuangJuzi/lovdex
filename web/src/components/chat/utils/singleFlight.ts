export type SingleFlight = <T>(task: () => Promise<T>) => Promise<T | null>;

/**
 * Runs `task` at most once at a time.
 *
 * A second call while a run is in flight resolves to `null` immediately instead
 * of joining the first run. That distinction matters for "send the first
 * message of a new chat": a duplicate click must be dropped, not replayed after
 * the session is established (which would post the same message into the new
 * conversation a second time).
 *
 * The gate re-opens in `finally`, so a failed run never poisons later attempts.
 */
export function createSingleFlight(): SingleFlight {
  let inFlight = false;

  return async <T>(task: () => Promise<T>): Promise<T | null> => {
    if (inFlight) {
      return null;
    }

    inFlight = true;
    try {
      return await task();
    } finally {
      inFlight = false;
    }
  };
}
