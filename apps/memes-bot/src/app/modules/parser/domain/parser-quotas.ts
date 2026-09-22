/**
 * Дедуп кандидатов внутри батча: одинаковое медиа (fileUniqueId или хеш)
 * считается дублем — остаётся лучший по score, остальные отбрасываются.
 */
export function dedupBatch(
  candidates: ReadonlyArray<{ id: number; score: number; fileKey: string | null }>
): number[] {
  const byKey = new Map<string, { id: number; score: number }>();
  for (const candidate of candidates) {
    if (!candidate.fileKey) {
      byKey.set(`id:${candidate.id}`, { id: candidate.id, score: candidate.score });
      continue;
    }
    const existing = byKey.get(candidate.fileKey);
    if (!existing || candidate.score > existing.score) {
      byKey.set(candidate.fileKey, { id: candidate.id, score: candidate.score });
    }
  }
  return [...byKey.values()].map((v) => v.id);
}
