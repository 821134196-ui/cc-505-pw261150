import { randomUUID } from 'node:crypto';
import { tx, nowIso, audit, count } from './db.js';
import {
  VERDICTS, ACTIONS, replaySeries, deriveRuleChanges, diffRules, backtest, severityFor,
  normalizeWindows,
} from './engine.js';

export class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const VERDICT_LABELS = {
  true_positive: '真实异常',
  false_positive: '误报',
  data_issue: '数据问题',
};

/* ------------------------------------------------------------------ */
/* 反馈聚合：同一异常的最新有效反馈即当前判断；全部反馈保留可撤销        */
/* ------------------------------------------------------------------ */

export function listFeedbackForAnomaly(db, anomalyId, { includeRevoked = true } = {}) {
  const rows = db.prepare(
    `SELECT * FROM feedback WHERE anomaly_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY seq ASC`,
  ).all(anomalyId);
  return rows.map(feedbackDto);
}

export function activeFeedbackRows(db, anomalyId) {
  return db.prepare(
    'SELECT * FROM feedback WHERE anomaly_id = ? AND revoked_at IS NULL ORDER BY seq ASC',
  ).all(anomalyId);
}

/**
 * 合并规则：同一异常的多条有效反馈按 seq 归并为一条“当前判断”。
 * - 只有一条：直接采用。
 * - 多条：以最新一条的 verdict 为准；evidence 去重拼接；action 取最新；
 *   合并记录中保留 contributingIds，任何一条被撤销都会重新计算。
 */
export function aggregateFeedback(rows) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const latest = sorted[sorted.length - 1];
  const evidence = [];
  const seen = new Set();
  for (const r of sorted) {
    const key = r.evidence.trim();
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push(key);
    }
  }
  const actions = [];
  for (const r of sorted) if (!actions.includes(r.action)) actions.push(r.action);
  return {
    id: latest.id,
    verdict: latest.verdict,
    verdictLabel: VERDICT_LABELS[latest.verdict],
    action: latest.action,
    actions,
    note: latest.note,
    evidence: evidence.join('\n'),
    analyst: latest.analyst,
    createdAt: latest.created_at,
    updatedAt: latest.created_at,
    contributingIds: sorted.map((r) => r.id),
    contributors: [...new Set(sorted.map((r) => r.analyst))],
    revisions: sorted.length,
    conflicted: new Set(sorted.map((r) => r.verdict)).size > 1,
  };
}

function feedbackDto(row) {
  return {
    id: row.id,
    anomalyId: row.anomaly_id,
    verdict: row.verdict,
    verdictLabel: VERDICT_LABELS[row.verdict],
    evidence: row.evidence,
    action: row.action,
    note: row.note,
    analyst: row.analyst,
    createdAt: row.created_at,
    seq: row.seq,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    active: row.revoked_at == null,
  };
}

/* ------------------------------------------------------------------ */
/* 异常                                                                */
/* ------------------------------------------------------------------ */

export function anomalyDto(db, row, { revisions = 0, application = null } = {}) {
  const active = activeFeedbackRows(db, row.id);
  const aggregate = aggregateFeedback(active);
  return {
    id: row.id,
    observationId: row.observation_id,
    seriesId: row.series_id,
    ts: row.ts,
    detector: row.detector,
    score: row.score,
    value: row.value,
    expected: row.expected,
    severity: row.severity,
    configVersionId: row.config_version_id,
    thresholdAtDetection: row.threshold_at_detection,
    detectedAt: row.detected_at,
    revision: row.revision,
    legacyVerdict: row.current_verdict,
    verdict: aggregate ? aggregate.verdict : null,
    verdictLabel: aggregate ? aggregate.verdictLabel : null,
    hasFeedback: active.length > 0,
    feedbackCount: active.length,
    conflicted: aggregate?.conflicted ?? false,
    aggregate,
    application,
    revisions,
  };
}

export function listAnomalies(db, query = {}) {
  const clauses = [];
  const params = [];
  if (query.seriesId) { clauses.push('a.series_id = ?'); params.push(query.seriesId); }
  if (query.versionId) { clauses.push('a.config_version_id = ?'); params.push(query.versionId); }
  if (query.severity) { clauses.push('a.severity = ?'); params.push(query.severity); }
  if (query.search) {
    clauses.push('(s.name LIKE ? OR a.id LIKE ? OR a.series_id LIKE ?)');
    const q = `%${query.search}%`;
    params.push(q, q, q);
  }
  if (query.reviewState === 'unreviewed') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL)`);
  } else if (query.reviewState === 'reviewed') {
    clauses.push(`EXISTS (SELECT 1 FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL)`);
  }
  if (query.reviewState === 'conflicted') {
    clauses.push(`(SELECT COUNT(DISTINCT f.verdict) FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL) > 1`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT a.*, s.name AS series_name FROM anomalies a
     JOIN series s ON s.id = a.series_id
     ${where}
     ORDER BY a.ts DESC, a.id ASC
     LIMIT 500`,
  ).all(...params);
  return rows.map((row) => ({
    ...anomalyDto(db, row),
    seriesName: row.series_name,
  }));
}

export function getAnomaly(db, id) {
  const row = db.prepare(
    `SELECT a.*, s.name AS series_name FROM anomalies a
     JOIN series s ON s.id = a.series_id WHERE a.id = ?`,
  ).get(id);
  if (!row) throw new ApiError(404, '异常不存在', 'ANOMALY_NOT_FOUND');
  const timeline = listFeedbackForAnomaly(db, id);
  const revisions = db.prepare(
    `SELECT v.version, v.id AS version_id, v.status, v.label, vf.reason
     FROM version_feedback vf JOIN config_versions v ON v.id = vf.version_id
     WHERE vf.feedback_id IN (${timeline.map(() => '?').join(',') || "''"})
     ORDER BY v.version ASC`,
  ).all(...timeline.map((f) => f.id));
  const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.observation_id);
  return {
    ...anomalyDto(db, row, { revisions }),
    seriesName: row.series_name,
    timeline,
    usedByVersions: revisions,
    context: obs ? {
      neighbors: db.prepare(
        `SELECT id, ts, value, expected, z FROM observations
         WHERE series_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
      ).all(row.series_id,
        new Date(Date.parse(row.ts) - 6 * 3600 * 1000).toISOString(),
        new Date(Date.parse(row.ts) + 6 * 3600 * 1000).toISOString()),
    } : null,
  };
}

/* ------------------------------------------------------------------ */
/* 提交 / 撤销反馈（乐观并发 + 幂等）                                   */
/* ------------------------------------------------------------------ */

export function createFeedback(db, anomalyId, body, { actor }) {
  const {
    verdict, evidence, action, note = null,
    expectedRevision, requestId, supersedeConflicts = false,
  } = body || {};

  if (!VERDICTS.includes(verdict)) {
    throw new ApiError(422, `verdict 必须是 ${VERDICTS.join(' / ')}`, 'INVALID_VERDICT');
  }
  if (!ACTIONS.includes(action)) {
    throw new ApiError(422, `action 必须是 ${ACTIONS.join(' / ')}`, 'INVALID_ACTION');
  }
  if (typeof evidence !== 'string' || evidence.trim().length < 3) {
    throw new ApiError(422, '必须提供至少 3 个字符的证据说明', 'EVIDENCE_REQUIRED');
  }
  if (evidence.length > 4000) {
    throw new ApiError(422, '证据说明过长（最多 4000 字符）', 'EVIDENCE_TOO_LONG');
  }

  return tx(db, () => {
    if (requestId) {
      const prior = db.prepare('SELECT * FROM feedback WHERE request_id = ?').get(requestId);
      if (prior) {
        return { feedback: feedbackDto(prior), anomaly: getAnomaly(db, anomalyId), replayed: true };
      }
    }

    const anomaly = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
    if (!anomaly) throw new ApiError(404, '异常不存在', 'ANOMALY_NOT_FOUND');

    if (expectedRevision != null && anomaly.revision !== expectedRevision) {
      throw new ApiError(409, '该异常已被其他人更新，请刷新后重试', 'REVISION_CONFLICT', {
        expectedRevision,
        currentRevision: anomaly.revision,
        current: anomalyDto(db, anomaly),
      });
    }

    // 不同判断并存时默认拒绝，除非显式确认（保留双方反馈，标记 conflicted）
    const active = activeFeedbackRows(db, anomalyId);
    const different = active.filter((f) => f.verdict !== verdict);
    if (different.length > 0 && !supersedeConflicts) {
      throw new ApiError(409, '已有不同结论的反馈；请确认是否追加（将保留双方记录并标记冲突）', 'VERDICT_CONFLICT', {
        currentVerdicts: [...new Set(active.map((f) => f.verdict))],
        existing: active.map(feedbackDto),
      });
    }

    const seq = count(db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM feedback WHERE anomaly_id = ?', anomalyId);
    const id = `fb_${randomUUID().slice(0, 8)}`;
    const at = nowIso();
    db.prepare(
      `INSERT INTO feedback
        (id, anomaly_id, verdict, evidence, action, note, analyst, created_at, seq, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, anomalyId, verdict, evidence.trim(), action, note, actor, at, seq, requestId ?? null);

    db.prepare('UPDATE anomalies SET revision = revision + 1 WHERE id = ?').run(anomalyId);

    audit(db, {
      actor,
      action: 'feedback.create',
      entityType: 'anomaly',
      entityId: anomalyId,
      detail: { feedbackId: id, verdict, action, seq },
    });

    return { feedback: feedbackDto(db.prepare('SELECT * FROM feedback WHERE id = ?').get(id)), anomaly: getAnomaly(db, anomalyId) };
  });
}

export function revokeFeedback(db, feedbackId, body, { actor }) {
  const reason = (body?.reason || '').trim();
  if (reason.length < 3) {
    throw new ApiError(422, '撤销必须说明原因（至少 3 个字符）', 'REASON_REQUIRED');
  }

  return tx(db, () => {
    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId);
    if (!row) throw new ApiError(404, '反馈不存在', 'FEEDBACK_NOT_FOUND');
    if (row.revoked_at) {
      return { feedback: feedbackDto(row), anomaly: getAnomaly(db, row.anomaly_id), replayed: true };
    }

    const at = nowIso();
    // 条件更新：并发撤销多次只有一个能生效
    const res = db.prepare(
      `UPDATE feedback SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(at, actor, reason, feedbackId);
    if (res.changes !== 1) {
      const current = db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId);
      return { feedback: feedbackDto(current), anomaly: getAnomaly(db, row.anomaly_id), replayed: true };
    }

    db.prepare('UPDATE anomalies SET revision = revision + 1 WHERE id = ?').run(row.anomaly_id);

    // 重新计算聚合后的当前判断，写回异常快照
    const remaining = activeFeedbackRows(db, row.anomaly_id);
    const aggregate = aggregateFeedback(remaining);
    db.prepare(
      'UPDATE anomalies SET current_verdict = ?, verdict_updated_at = ? WHERE id = ?',
    ).run(aggregate ? aggregate.verdict : null, aggregate ? at : null, row.anomaly_id);

    audit(db, {
      actor,
      action: 'feedback.revoke',
      entityType: 'anomaly',
      entityId: row.anomaly_id,
      detail: { feedbackId, reason },
    });

    return {
      feedback: feedbackDto(db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId)),
      anomaly: getAnomaly(db, row.anomaly_id),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 版本                                                                */
/* ------------------------------------------------------------------ */

export function listSeries(db) {
  return db.prepare('SELECT * FROM series ORDER BY id').all().map((s) => ({
    id: s.id, name: s.name, unit: s.unit, detector: s.detector, description: s.description,
  }));
}

export function versionDto(db, row) {
  const rules = db.prepare('SELECT * FROM config_rules WHERE version_id = ? ORDER BY series_id').all(row.id);
  return {
    id: row.id,
    version: row.version,
    label: row.label,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    parentVersionId: row.parent_version_id,
    activatedAt: row.activated_at,
    backtestId: row.backtest_id,
    revision: row.revision,
    rules: rules.map((r) => ({
      seriesId: r.series_id,
      zThreshold: r.z_threshold,
      baselineWindowHours: r.baseline_window_hours,
      minConsecutive: r.min_consecutive,
      excludedWindows: JSON.parse(r.excluded_windows || '[]'),
    })),
    feedbackCount: count(db, 'SELECT COUNT(*) AS n FROM version_feedback WHERE version_id = ?', row.id),
  };
}

export function listVersions(db) {
  const rows = db.prepare('SELECT * FROM config_versions ORDER BY version DESC').all();
  return rows.map((row) => {
    const dto = versionDto(db, row);
    const bt = row.backtest_id
      ? db.prepare('SELECT summary FROM backtests WHERE id = ?').get(row.backtest_id)
      : null;
    return { ...dto, backtestSummary: bt ? JSON.parse(bt.summary) : null };
  });
}

export function getVersion(db, id) {
  const row = db.prepare('SELECT * FROM config_versions WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, '版本不存在', 'VERSION_NOT_FOUND');
  const dto = versionDto(db, row);
  const backtests = db.prepare(
    'SELECT id, created_at, created_by, summary, details, baseline_version_id FROM backtests WHERE version_id = ? ORDER BY created_at DESC',
  ).all(id).map((b) => ({
    id: b.id,
    createdAt: b.created_at,
    createdBy: b.created_by,
    baselineVersionId: b.baseline_version_id,
    summary: JSON.parse(b.summary),
    perSeries: JSON.parse(b.details),
  }));
  const parent = row.parent_version_id
    ? db.prepare('SELECT * FROM config_versions WHERE id = ?').get(row.parent_version_id)
    : null;
  const diff = parent
    ? diffRules(
      db.prepare('SELECT * FROM config_rules WHERE version_id = ?').all(parent.id),
      db.prepare('SELECT * FROM config_rules WHERE version_id = ?').all(id),
    )
    : [];
  const evidence = db.prepare(
    `SELECT vf.reason, f.* FROM version_feedback vf
     JOIN feedback f ON f.id = vf.feedback_id WHERE vf.version_id = ? ORDER BY f.seq`,
  ).all(id).map((r) => ({ ...feedbackDto(r), usedReason: r.reason }));
  return { ...dto, backtests, diff, parentVersion: parent ? { id: parent.id, version: parent.version, label: parent.label } : null, evidence };
}

function ruleRows(db, versionId) {
  return db.prepare('SELECT * FROM config_rules WHERE version_id = ? ORDER BY series_id').all(versionId);
}

export function activeVersion(db) {
  const row = db.prepare("SELECT * FROM config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").get();
  if (!row) throw new ApiError(500, '没有生效中的版本', 'NO_ACTIVE_VERSION');
  return row;
}

/** 收集所有“有效”反馈（未撤销）及其异常，供版本派生与回测标签使用。 */
export function labeledFeedback(db) {
  const rows = db.prepare(
    `SELECT f.*, a.id AS a_id, a.series_id, a.ts AS a_ts, a.score, a.observation_id, a.severity, a.value, a.expected
     FROM feedback f JOIN anomalies a ON a.id = f.anomaly_id
     WHERE f.revoked_at IS NULL
     ORDER BY f.anomaly_id, f.seq`,
  ).all();
  const byAnomaly = new Map();
  for (const r of rows) {
    if (!byAnomaly.has(r.a_id)) byAnomaly.set(r.a_id, []);
    byAnomaly.get(r.a_id).push(r);
  }
  const labeled = [];
  const feedbackById = new Map();
  for (const [anomalyId, list] of byAnomaly) {
    const agg = aggregateFeedback(list);
    const first = list[0];
    const anomaly = {
      id: anomalyId,
      series_id: first.series_id,
      ts: first.a_ts,
      score: first.score,
      observation_id: first.observation_id,
      severity: first.severity,
      value: first.value,
      expected: first.expected,
    };
    labeled.push({ anomaly, feedback: agg, raw: list });
    for (const r of list) feedbackById.set(r.id, { anomaly, feedback: aggregateFeedback([r]) });
  }
  return { labeled, feedbackById };
}

export function observationsBySeries(db) {
  const rows = db.prepare('SELECT id, series_id, ts, value FROM observations ORDER BY series_id, ts').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.series_id)) map.set(r.series_id, []);
    map.get(r.series_id).push({ id: r.id, seriesId: r.series_id, ts: r.ts, value: r.value });
  }
  return map;
}

export function labelMap(db) {
  const { labeled } = labeledFeedback(db);
  const map = new Map();
  for (const item of labeled) map.set(item.anomaly.observation_id, item.feedback.verdict);
  return map;
}

export function runBacktest(db, candidateRules, baseVersionId) {
  const baseRules = ruleRows(db, baseVersionId);
  const labels = labelMap(db);
  return backtest({
    observationsBySeries: observationsBySeries(db),
    baseRules,
    candidateRules,
    labels,
  });
}

export function createDraftVersion(db, body, { actor }) {
  const {
    label, notes = '', baseVersionId, includeFeedback = true,
    excludedFeedbackIds = [], ruleOverrides = [], requestId,
  } = body || {};

  if (!label || String(label).trim().length < 3) {
    throw new ApiError(422, '版本名称至少 3 个字符', 'LABEL_REQUIRED');
  }

  return tx(db, () => {
    // 版本创建本身是幂等的（每次都生成新版本），requestId 仅用于客户端重试去重，
    // 这里不缓存结果，避免把一次重试误认为已成功。
    void requestId;

    const base = baseVersionId
      ? db.prepare('SELECT * FROM config_versions WHERE id = ?').get(baseVersionId)
      : activeVersion(db);
    if (!base) throw new ApiError(404, '基线版本不存在', 'VERSION_NOT_FOUND');

    const baseRules = ruleRows(db, base.id);
    const { labeled, feedbackById } = labeledFeedback(db);
    const included = includeFeedback
      ? labeled.filter((item) => !item.feedback.contributingIds.some((id) => excludedFeedbackIds.includes(id)))
      : [];

    const { rules: derived, changes } = includeFeedback
      ? deriveRuleChanges(baseRules, included, feedbackById)
      : { rules: baseRules.map((r) => ({ ...r, excluded_windows: normalizeWindows(r.excluded_windows) })), changes: [] };

    // 手工覆盖（可选），例如分析人员直接指定阈值
    for (const ov of ruleOverrides) {
      const target = derived.find((r) => r.series_id === ov.seriesId);
      if (!target) throw new ApiError(422, `覆盖引用了未知序列 ${ov.seriesId}`, 'UNKNOWN_SERIES');
      for (const key of ['z_threshold', 'baseline_window_hours', 'min_consecutive']) {
        if (ov[key] != null) target[key] = Number(ov[key]);
      }
    }

    const nextVersion = count(db, 'SELECT COALESCE(MAX(version), 0) + 1 AS n FROM config_versions');
    const id = `cfg_v${nextVersion}_${randomUUID().slice(0, 6)}`;
    const at = nowIso();

    db.prepare(
      `INSERT INTO config_versions (id, version, label, status, notes, created_by, created_at, parent_version_id, revision)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 0)`,
    ).run(id, nextVersion, String(label).trim(), notes, actor, at, base.id);

    const ins = db.prepare(
      `INSERT INTO config_rules (version_id, series_id, z_threshold, baseline_window_hours, min_consecutive, excluded_windows)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of derived) {
      ins.run(id, r.series_id, r.z_threshold, r.baseline_window_hours, r.min_consecutive, JSON.stringify(r.excluded_windows));
    }

    const linkFeedback = db.prepare(
      'INSERT OR IGNORE INTO version_feedback (version_id, feedback_id, reason) VALUES (?, ?, ?)',
    );
    for (const change of changes) {
      for (const fbId of change.feedbackIds) {
        linkFeedback.run(id, fbId, `${change.seriesId}: ${change.reason}`);
      }
    }

    const bt = runBacktest(db, ruleRows(db, id), base.id);
    const btId = `bt_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO backtests (id, version_id, baseline_version_id, version_revision, created_at, created_by, summary, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(btId, id, base.id, 0, at, actor, JSON.stringify(bt.summary), JSON.stringify(bt.perSeries));
    db.prepare('UPDATE config_versions SET backtest_id = ? WHERE id = ?').run(btId, id);

    audit(db, {
      actor,
      action: 'version.create',
      entityType: 'version',
      entityId: id,
      detail: { version: nextVersion, baseVersionId: base.id, changeCount: changes.length, backtestId: btId },
    });

    return { version: getVersion(db, id), changes };
  });
}

export function activateVersion(db, versionId, body, { actor }) {
  const confirm = body?.confirmRules === true;
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM config_versions WHERE id = ?').get(versionId);
    if (!row) throw new ApiError(404, '版本不存在', 'VERSION_NOT_FOUND');
    if (row.status === 'active') return { version: getVersion(db, versionId), alreadyActive: true };
    if (row.status === 'retired') throw new ApiError(409, '已退役版本不能重新启用，请从当前版本派生新版本', 'VERSION_RETIRED');
    if (!confirm) throw new ApiError(422, '启用前需确认规则差异', 'CONFIRM_REQUIRED');

    const active = activeVersion(db);
    const at = nowIso();
    db.prepare("UPDATE config_versions SET status = 'retired', revision = revision + 1 WHERE id = ?").run(active.id);
    db.prepare("UPDATE config_versions SET status = 'active', activated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(at, versionId);

    // 关键约束：历史告警保留原判断与原始版本，不回溯改写
    const rewritten = db.prepare('SELECT COUNT(*) AS n FROM anomalies WHERE config_version_id = ?').get(active.id).n;

    audit(db, {
      actor,
      action: 'version.activate',
      entityType: 'version',
      entityId: versionId,
      detail: { replaces: active.id, historicalAnomaliesPreserved: rewritten },
    });

    return {
      version: getVersion(db, versionId),
      previousVersionId: active.id,
      historicalAlertsPreserved: rewritten,
    };
  });
}

/**
 * 用生效版本的规则检测新观测。检测到的新告警带上产生它的版本号，
 * 因此历史告警的版本归属不会随版本切换而改变。
 */
export function scanObservations(db, { actor = 'system', dryRun = false } = {}) {
  const version = activeVersion(db);
  const rules = ruleRows(db, version.id);
  const pending = db.prepare('SELECT * FROM observations WHERE processed = 0 ORDER BY series_id, ts').all();
  if (pending.length === 0) return { versionId: version.id, created: 0, dryRun };
  if (dryRun) {
    return { versionId: version.id, wouldProcess: pending.length, dryRun };
  }

  return tx(db, () => {
    const pendingSet = new Set(pending.map((o) => o.id));
    const bySeries = new Map();
    for (const o of pending) {
      if (!bySeries.has(o.series_id)) bySeries.set(o.series_id, []);
      bySeries.get(o.series_id).push(o);
    }
    let created = 0;
    const createdIds = [];
    for (const rule of rules) {
      const batch = bySeries.get(rule.series_id) || [];
      if (batch.length === 0) continue;
      const context = db.prepare(
        `SELECT id, series_id, ts, value FROM observations
         WHERE series_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
      ).all(rule.series_id, batch[0].ts, rule.baseline_window_hours).reverse();
      const all = [...context, ...batch].map((o) => ({
        id: o.id, seriesId: o.series_id, ts: o.ts, value: o.value,
      }));
      const { detections } = replaySeries(all, {
        z_threshold: rule.z_threshold,
        baseline_window_hours: rule.baseline_window_hours,
        min_consecutive: rule.min_consecutive,
        excluded_windows: JSON.parse(rule.excluded_windows || '[]'),
      }, rule.series_id);
      for (const det of detections) {
        if (!pendingSet.has(det.observationId)) continue;
        const id = `an_${det.observationId.replace(/^ob_/, '')}`;
        db.prepare(
          `INSERT INTO anomalies
            (id, observation_id, series_id, ts, detector, score, value, expected, severity,
             config_version_id, threshold_at_detection, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(observation_id) DO NOTHING`,
        ).run(id, det.observationId, det.seriesId, det.ts, version.label, det.z, det.value,
          det.expected, det.severity, version.id, rule.z_threshold, nowIso());
        created += 1;
        createdIds.push(id);
      }
    }
    db.prepare('UPDATE observations SET processed = 1 WHERE processed = 0').run();
    audit(db, { actor, action: 'scan.run', entityType: 'version', entityId: version.id, detail: { created } });
    return { versionId: version.id, created, createdIds };
  });
}

export function listAudit(db, limit = 100) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
    id: r.id, at: r.at, actor: r.actor, action: r.action,
    entityType: r.entity_type, entityId: r.entity_id, detail: JSON.parse(r.detail || '{}'),
  }));
}

export function metrics(db) {
  const total = count(db, 'SELECT COUNT(*) AS n FROM anomalies');
  const reviewed = count(db, `SELECT COUNT(*) AS n FROM anomalies a WHERE EXISTS
    (SELECT 1 FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL)`);
  const conflicted = count(db, `SELECT COUNT(*) AS n FROM anomalies a WHERE
    (SELECT COUNT(DISTINCT f.verdict) FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL) > 1`);
  const byVerdict = db.prepare(
    `WITH agg AS (
       SELECT a.id, (SELECT f.verdict FROM feedback f WHERE f.anomaly_id = a.id AND f.revoked_at IS NULL
                     ORDER BY f.seq DESC LIMIT 1) AS verdict
       FROM anomalies a)
     SELECT verdict, COUNT(*) AS n FROM agg WHERE verdict IS NOT NULL GROUP BY verdict`,
  ).all();
  const version = db.prepare("SELECT * FROM config_versions WHERE status = 'active'").get();
  return {
    anomalies: total,
    reviewed,
    unreviewed: total - reviewed,
    conflicted,
    byVerdict: Object.fromEntries(byVerdict.map((r) => [r.verdict, r.n])),
    activeVersion: version ? { id: version.id, version: version.version, label: version.label, activatedAt: version.activated_at } : null,
    series: count(db, 'SELECT COUNT(*) AS n FROM series'),
    observations: count(db, 'SELECT COUNT(*) AS n FROM observations'),
    feedbackTotal: count(db, 'SELECT COUNT(*) AS n FROM feedback'),
    feedbackRevoked: count(db, 'SELECT COUNT(*) AS n FROM feedback WHERE revoked_at IS NOT NULL'),
  };
}

export { severityFor, VERDICT_LABELS };
