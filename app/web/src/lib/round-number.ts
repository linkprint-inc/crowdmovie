/** Public rounds count released scenes; internal attempt indexes remain stable. */
export function nextRoundNumber(scenes: readonly { sceneIndex: number }[], archive: readonly { sceneIndex?: number | null }[] = []): number {
  return Math.max(0, ...scenes.map(s => s.sceneIndex), ...archive.map(r => r.sceneIndex ?? 0)) + 1;
}

export function publicRoundNumber(round: { status?: string; sceneIndex?: number | null }, next: number): number | null {
  if (round.sceneIndex != null) return round.sceneIndex;
  if (!round.status || round.status.endsWith("_failed") || round.status === "published") return null;
  return next;
}
