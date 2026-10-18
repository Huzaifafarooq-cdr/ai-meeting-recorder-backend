export function toSummary(rec) {
  return {
    id: rec._id.toString(),
    title: rec.title,
    titleSource: rec.titleSource,
    source: rec.source,
    status: rec.status,
    stage: rec.stage,
    stages: (rec.stages ?? []).map((s) => ({ key: s.key, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error })),
    error: rec.error?.code ? rec.error : null,
    retryInfo: rec.retryInfo?.attempt ? rec.retryInfo : null,
    warnings: rec.warnings ?? [],
    durationSec: rec.durationSec ?? 0,
    keywords: rec.keywords ?? [],
    speakers: rec.speakers ?? [],
    stats: rec.stats ?? null,
    hasAudio: Boolean(rec.audio?.key),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    completedAt: rec.completedAt,
  };
}

export function toDetail(rec) {
  return {
    ...toSummary(rec),
    language: rec.language,
    audio: rec.audio?.key ? { mimeType: rec.audio.mimeType, size: rec.audio.size } : null,
    summary: rec.summary?.overview ? rec.summary : null,
    actionItems: rec.actionItems ?? [],
    keyDecisions: rec.keyDecisions ?? [],
  };
}
