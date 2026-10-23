import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TurnFilesEntry } from "./track-turn-files";

/** A file-exploration state shared by concrete steps across archived branches. */
export interface ExplorationState {
  files: string[];
  /** Assistant message entry IDs, resolvable with sessionManager.getEntry(id). */
  candidates: { stepId: string; multiplicity: number }[];
}

function turnFiles(entry: SessionEntry): TurnFilesEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== "swe-replay-turn-files") return;
  const data = entry.data as Partial<TurnFilesEntry> | undefined;
  if (
    typeof data?.rootEntryId !== "string" ||
    typeof data.messageEntryId !== "string" ||
    !Array.isArray(data.files) ||
    !data.files.every((file) => typeof file === "string")
  ) return;
  return data as TurnFilesEntry;
}

/**
 * Roll up completed steps from all session branches belonging to one replay run.
 * A step is identified by its assistant message, not its end-of-turn snapshot.
 * Walk that message's ancestors to find the latest snapshot BEFORE the step:
 * its own snapshot already includes its tool accesses and must not be used.
 *
 * Callers may supply eligible step IDs from passing trajectories. Filtering
 * precedes grouping but leaves all ancestors available for state reconstruction.
 */
export function rollUpExplorationStates(
  entries: readonly SessionEntry[],
  rootEntryId: string,
  eligibleSteps: ReadonlyMap<string, number>,
): ExplorationState[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const states = new Map<string, ExplorationState>();
  const seenSteps = new Set<string>();

  for (const entry of entries) {
    const snapshot = turnFiles(entry);
    if (!snapshot || snapshot.rootEntryId !== rootEntryId) continue;

    const step = byId.get(snapshot.messageEntryId);
    if (!step || step.type !== "message" || step.message.role !== "assistant") continue;

    const multiplicity = eligibleSteps.get(step.id);
    if (multiplicity === undefined) continue;

    if (seenSteps.has(step.id)) continue;
    seenSteps.add(step.id);

    let ancestorId = step.parentId;
    let files: string[] | undefined;

    while (ancestorId && ancestorId !== rootEntryId) {
      const ancestor = byId.get(ancestorId);
      if (!ancestor) break;

      // Do not include a nested/different replay run in this run's archive.
      if (ancestor.type === "custom" && ancestor.customType === "swe-replay-root") break;

      const previous = turnFiles(ancestor);
      if (files === undefined && previous?.rootEntryId === rootEntryId) {
        files = previous.files;
      }

      ancestorId = ancestor.parentId;
    }
    if (ancestorId !== rootEntryId || !files?.length) continue;

    const normalizedFiles = [...new Set(files)].sort();
    const key = JSON.stringify(normalizedFiles);
    let state = states.get(key);
    if (!state) {
      state = { files: normalizedFiles, candidates: [] };
      states.set(key, state);
    }
    state.candidates.push({ stepId: step.id, multiplicity });
  }

  return [...states.values()];
}
