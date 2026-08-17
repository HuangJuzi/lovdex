const MAX_NAME_LENGTH = 50;

/**
 * Distill a short board/display name from a free-form task prompt.
 *
 * The create-task form's primary input is the prompt (what actually gets sent
 * to the agent). When the user leaves the optional name blank we derive one
 * locally — no model call — by taking the first non-empty line, collapsing its
 * internal whitespace, and truncating to a card-friendly length. Blank input
 * yields an empty string; the caller decides the fallback.
 */
export function deriveTaskName(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  const glyphs = [...collapsed];
  if (glyphs.length <= MAX_NAME_LENGTH) return collapsed;
  return `${glyphs.slice(0, MAX_NAME_LENGTH).join('').trimEnd()}…`;
}
