/**
 * Live count of open `DialogContent`s, shared across the app.
 *
 * Used by the global inbox summary: it must not pop over a dialog the user is
 * already working in (e.g. the new-task form), because its full-screen overlay
 * hides that form and Escape closes both dialogs. The count is module-level so
 * every dialog — including ones rendered from a different subtree, such as the
 * sidebar's create-task modal — is visible to the summary trigger.
 */
type Listener = () => void;

let openModalCount = 0;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Marks one dialog as open and returns its idempotent release function.
 *
 * The release closure is guarded because React effects can be double-invoked
 * and their cleanup may run more than once; a raw decrement would under-count
 * and make future summaries think the UI is always free.
 */
export function acquireModal(): () => void {
  openModalCount++;
  emit();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (openModalCount > 0) {
      openModalCount--;
      emit();
    }
  };
}

export function getOpenModalCount(): number {
  return openModalCount;
}

export function subscribeModalPresence(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so each case starts from a known count. */
export function resetOpenModalCountForTests(): void {
  if (openModalCount !== 0) {
    openModalCount = 0;
    emit();
  }
}
