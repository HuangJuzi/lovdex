/**
 * Lane assignment for the History view commit graph (VSCode Git Graph style).
 *
 * Commits must arrive in graph order (children before their parents — the
 * backend guarantees this via `git log --all --topo-order`). Each commit is
 * assigned a lane; lines connect commits to their parents across rows.
 */

export type CommitGraphRow = {
  /** Lane the commit dot sits in. */
  nodeLane: number;
  /** Total lanes visible in this row — determines the strip width. */
  laneCount: number;
  /** A line arrives at the node from the row above (some child expects this commit). */
  hasTopContinuation: boolean;
  /** The node's own lane continues below toward its first parent. */
  hasParentContinuation: boolean;
  /** Extra top lanes that merge into the node (multiple children / branch tips joining). */
  inbound: number[];
  /** Bottom lanes branching out of the node toward its extra parents (merge commits). */
  outbound: number[];
  /** Lanes whose lines pass straight through this row untouched. */
  passThrough: number[];
  /** Every lane still active below this row — rails continue through expanded content. */
  bottomLanes: number[];
};

type GraphCommit = {
  hash: string;
  parents?: string[];
};

// Colors cycle per lane, VSCode Git Graph style. They are categorical (branch
// identity), so they map to the design system's --chart-* tokens rather than
// semantic success/destructive. Hue-matched to the original palette; the only
// approximations are lane 3 (green → chart-2 emerald) and lane 5 (yellow →
// chart-9 orange, since the chart palette has no yellow).
const GRAPH_CHART_INDICES = [1, 10, 6, 2, 8, 9, 3, 7, 4, 5] as const;

export const laneColor = (lane: number): string =>
  `hsl(var(--chart-${GRAPH_CHART_INDICES[lane % GRAPH_CHART_INDICES.length]}))`;

/** Semi-transparent lane tint (was a `${hex}22` alpha suffix, which breaks on var()). */
export const laneColorTint = (lane: number): string =>
  `hsl(var(--chart-${GRAPH_CHART_INDICES[lane % GRAPH_CHART_INDICES.length]}) / 0.13)`;

export function computeCommitGraph(commits: GraphCommit[]): CommitGraphRow[] {
  // Each slot holds the commit hash that lane is waiting to reach, or null
  // when the lane is free.
  const lanes: (string | null)[] = [];
  const rows: CommitGraphRow[] = [];

  const takeFirstFreeLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) {
      return free;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const activeBefore = new Set<number>();
    lanes.forEach((expected, index) => {
      if (expected !== null) {
        activeBefore.add(index);
      }
    });

    // Lanes whose next expected commit is this one.
    const waiting: number[] = [];
    lanes.forEach((expected, index) => {
      if (expected === commit.hash) {
        waiting.push(index);
      }
    });

    const hasTopContinuation = waiting.length > 0;
    const nodeLane = hasTopContinuation ? waiting[0] : takeFirstFreeLane();

    // Additional lanes converging on this commit merge into the node and free up.
    const inbound = waiting.slice(1);
    for (const lane of inbound) {
      lanes[lane] = null;
    }

    const parents = commit.parents ?? [];
    lanes[nodeLane] = parents.length > 0 ? parents[0] : null;

    // Extra parents (merge commits) either join a lane already heading to that
    // parent or open a new lane for it.
    const outbound: number[] = [];
    for (const parent of parents.slice(1)) {
      const existing = lanes.findIndex((expected) => expected === parent);
      if (existing !== -1 && existing !== nodeLane) {
        outbound.push(existing);
      } else {
        const lane = takeFirstFreeLane();
        lanes[lane] = parent;
        outbound.push(lane);
      }
    }

    const passThrough = [...activeBefore]
      .filter((lane) => lane !== nodeLane && !waiting.includes(lane))
      .sort((a, b) => a - b);

    const bottomLanes: number[] = [];
    lanes.forEach((expected, index) => {
      if (expected !== null) {
        bottomLanes.push(index);
      }
    });

    const laneCount = Math.max(lanes.length, nodeLane + 1);

    // Keep the lane array tight so later rows don't inherit phantom width.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    rows.push({
      nodeLane,
      laneCount,
      hasTopContinuation,
      hasParentContinuation: parents.length > 0,
      inbound,
      outbound,
      passThrough,
      bottomLanes,
    });
  }

  return rows;
}
