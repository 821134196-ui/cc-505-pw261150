/**
 * 纯检测/回测引擎。不依赖数据库，便于单元测试与并发安全的确定性重放。
 *
 * 规则字段：
 *   z_threshold            触发阈值（|z| >= 阈值）
 *   baseline_window_hours  基线窗口（用当前点之前多少个点估计均值/标准差）
 *   min_consecutive        连续多少个点超阈值才产生告警
 *   excluded_windows       [{ from, to, reason, feedbackId? }] 数据问题窗口：
 *                          既不参与基线估计，也不产生告警
 *
 * 观测字段：{ id, seriesId, ts(ISO), value }
 */

export const VERDICTS = ['true_positive', 'false_positive', 'data_issue'];
export const ACTIONS = ['no_action', 'mute', 'threshold_review', 'baseline_fix', 'data_pipeline_fix'];

export function normalizeWindows(windows) {
  if (Array.isArray(windows)) return windows;
  if (typeof windows === 'string') {
    try {
      const parsed = JSON.parse(windows);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function isExcluded(ts, windows) {
  const t = Date.parse(ts);
  return (windows || []).some((w) => {
    const from = Date.parse(w.from);
    const to = Date.parse(w.to);
    return t >= from && t <= to;
  });
}

export function meanStd(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, n };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n < 2) return { mean, std: 0, n };
  let sq = 0;
  for (const v of values) {
    const d = v - mean;
    sq += d * d;
  }
  // 样本标准差；样本过少时给出下限，避免除零导致 z 爆炸
  return { mean, std: Math.sqrt(sq / (n - 1)), n };
}

/**
 * 对单条序列按时间升序重放。返回每个观测的评分和最终告警。
 * 基线统计只用当前点之前的点（避免未来信息泄漏），并跳过数据问题窗口。
 */
export function replaySeries(observations, rule, seriesId) {
  const sorted = [...observations].sort((a, b) => a.ts.localeCompare(b.ts));
  const window = Math.max(1, rule.baseline_window_hours ?? 24);
  const threshold = rule.z_threshold ?? 3;
  const minConsecutive = Math.max(1, rule.min_consecutive ?? 1);
  const excluded = normalizeWindows(rule.excluded_windows);

  const MIN_BASELINE_SAMPLES = 3; // 基线样本不足时不评分，避免冷启动误报
  const scored = [];
  const detections = [];
  let consecutive = 0;
  let pending = [];

  for (const obs of sorted) {
    const excludedNow = isExcluded(obs.ts, excluded);

    // 基线：当前点之前至多 window 个未排除点
    const baseline = [];
    for (let i = scored.length - 1; i >= 0 && baseline.length < window; i -= 1) {
      if (!scored[i].excluded) baseline.push(scored[i].value);
    }

    const { mean, std } = meanStd(baseline);
    const safeStd = std > 1e-9 && baseline.length >= MIN_BASELINE_SAMPLES ? std : null;
    const z = safeStd == null ? 0 : (obs.value - mean) / safeStd;
    const exceeds = !excludedNow && safeStd != null && Math.abs(z) >= threshold;

    const entry = {
      id: obs.id,
      seriesId: seriesId ?? obs.seriesId,
      ts: obs.ts,
      value: obs.value,
      expected: Number(mean.toFixed(4)),
      z: Number(z.toFixed(4)),
      std: Number((std || 0).toFixed(4)),
      excluded: excludedNow,
      exceeds,
      fired: false,
    };

    if (exceeds) {
      consecutive += 1;
      pending.push(entry);
    } else {
      consecutive = 0;
      pending = [];
    }

    if (consecutive >= minConsecutive && pending.length >= minConsecutive) {
      const last = pending[pending.length - 1];
      if (!last.fired) {
        last.fired = true;
        last.runLength = consecutive;
        detections.push({
          observationId: last.id,
          seriesId: last.seriesId,
          ts: last.ts,
          value: last.value,
          expected: last.expected,
          z: last.z,
          severity: severityFor(last.z, threshold),
          threshold,
        });
      }
    }
    scored.push(entry);
  }

  return { scored, detections };
}

export function severityFor(z, threshold) {
  const ratio = Math.abs(z) / Math.max(threshold, 1e-9);
  if (ratio >= 2) return 'critical';
  if (ratio >= 1.4) return 'warning';
  return 'watch';
}

// 检测器阈值的安全上限：无论多少轮反馈，都不允许把阈值抬到该值以上，
// 否则“用反馈消误报”会把真实异常也一并压掉。
export const MAX_Z_THRESHOLD = 6;

/**
 * 基于分析人员有效反馈，推导下一版规则。
 * 只处理传入的有效反馈（已撤销的不参与）。
 *
 * 反馈：{ anomaly, feedback:{ verdict, action, evidence, note } }
 */
export function deriveRuleChanges(baseRules, labeled, feedbackById) {
  const bySeries = new Map();
  for (const rule of baseRules) {
    bySeries.set(rule.series_id, {
      series_id: rule.series_id,
      z_threshold: rule.z_threshold,
      baseline_window_hours: rule.baseline_window_hours,
      min_consecutive: rule.min_consecutive,
      excluded_windows: normalizeWindows(rule.excluded_windows),
    });
  }

  const changes = [];
  const perSeriesFeedback = new Map();
  for (const item of labeled) {
    if (!perSeriesFeedback.has(item.anomaly.series_id)) perSeriesFeedback.set(item.anomaly.series_id, []);
    perSeriesFeedback.get(item.anomaly.series_id).push(item);
  }

  for (const [seriesId, items] of perSeriesFeedback) {
    const rule = bySeries.get(seriesId);
    if (!rule) continue;

    const fps = items.filter((i) => i.feedback.verdict === 'false_positive');
    const dataIssues = items.filter((i) => i.feedback.verdict === 'data_issue');

    // 误报 -> 提高阈值，至少越过误报点的 z，封顶 1.5 倍，避免一处误报把检测器打死
    const raiseWatchers = fps.filter((i) => ['threshold_review', 'mute'].includes(i.feedback.action));
    if (raiseWatchers.length > 0) {
      const maxFpZ = Math.max(...raiseWatchers.map((i) => Math.abs(i.anomaly.score)));
      const proposed = Math.min(
        MAX_Z_THRESHOLD,
        rule.z_threshold * 1.5,
        Math.max(rule.z_threshold + 0.2, maxFpZ + 0.1),
      );
      const next = round2(proposed);
      if (next > rule.z_threshold) {
        changes.push({
          seriesId,
          field: 'z_threshold',
          from: rule.z_threshold,
          to: next,
          reason: `${raiseWatchers.length} 条误报（最大 |z|=${maxFpZ.toFixed(2)}），阈值上移`,
          feedbackIds: raiseWatchers.map((i) => i.feedback.id),
        });
        rule.z_threshold = next;
      }
    }

    // 数据问题 / 静音 -> 排除异常附近的窗口，既是规则阈值也是基线训练数据的修正
    const exclusions = [...fps, ...dataIssues].filter((i) =>
      ['mute', 'baseline_fix', 'data_pipeline_fix'].includes(i.feedback.action));
    for (const item of exclusions) {
      const ts = Date.parse(item.anomaly.ts);
      const from = new Date(ts - 60 * 60 * 1000).toISOString();
      const to = new Date(ts + 60 * 60 * 1000).toISOString();
      const overlaps = rule.excluded_windows.some((w) =>
        from <= w.to && to >= w.from);
      if (overlaps) continue;
      rule.excluded_windows.push({
        from,
        to,
        reason: `${item.feedback.verdict === 'data_issue' ? '数据问题' : '静音'}：${item.feedback.evidence}`,
        feedbackId: item.feedback.id,
      });
      changes.push({
        seriesId,
        field: 'excluded_windows',
        from: null,
        to: `${from} ~ ${to}`,
        reason: `排除 ${item.anomaly.ts} 附近窗口（${item.feedback.evidence}）`,
        feedbackIds: [item.feedback.id],
      });
    }

    // 多次数据问题指向基线被污染 -> 拉长基线窗口，让基线更稳健
    if (dataIssues.length >= 2) {
      const next = Math.min(336, rule.baseline_window_hours * 2);
      if (next > rule.baseline_window_hours) {
        changes.push({
          seriesId,
          field: 'baseline_window_hours',
          from: rule.baseline_window_hours,
          to: next,
          reason: `${dataIssues.length} 条数据问题，基线窗口加倍以稀释污染`,
          feedbackIds: dataIssues.map((i) => i.feedback.id),
        });
        rule.baseline_window_hours = next;
      }
    }
  }

  return { rules: [...bySeries.values()], changes };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function diffRules(baseRules, candidateRules) {
  const base = new Map(baseRules.map((r) => [r.series_id, r]));
  const cand = new Map(candidateRules.map((r) => [r.series_id, r]));
  const seriesIds = [...new Set([...base.keys(), ...cand.keys()])].sort();
  const result = [];
  for (const seriesId of seriesIds) {
    const a = base.get(seriesId);
    const b = cand.get(seriesId);
    if (!a || !b) {
      result.push({ seriesId, added: !a, removed: !b, fields: [] });
      continue;
    }
    const fields = [];
    for (const key of ['z_threshold', 'baseline_window_hours', 'min_consecutive']) {
      if (a[key] !== b[key]) fields.push({ field: key, from: a[key], to: b[key] });
    }
    const aWins = normalizeWindows(a.excluded_windows);
    const bWins = normalizeWindows(b.excluded_windows);
    if (JSON.stringify(aWins) !== JSON.stringify(bWins)) {
      fields.push({
        field: 'excluded_windows',
        from: aWins,
        to: bWins,
        added: bWins.filter((w) => !aWins.some((x) => x.from === w.from && x.to === w.to)),
        removed: aWins.filter((w) => !bWins.some((x) => x.from === w.from && x.to === w.to)),
      });
    }
    if (fields.length > 0) result.push({ seriesId, fields });
  }
  return result;
}

/**
 * 回测：在同一段历史观测上分别重放“基线版本”和“候选版本”，
 * 并用分析人员的有效反馈作为标签计算精确率/召回率。
 *
 * labels: Map<observationId, verdict>（仅统计已复核的告警）
 */
export function backtest({ observationsBySeries, baseRules, candidateRules, labels }) {
  const replayAll = (rules) => {
    const byId = new Map();
    const detectionById = new Map();
    for (const rule of rules) {
      const obs = observationsBySeries.get(rule.series_id) || [];
      const { scored, detections } = replaySeries(obs, rule, rule.series_id);
      for (const s of scored) byId.set(s.id, s);
      for (const d of detections) detectionById.set(d.observationId, d);
    }
    return { byId, detectionById };
  };

  const base = replayAll(baseRules);
  const cand = replayAll(candidateRules);

  // 只对“基线版本会告警”的点做口径对齐：告警集合评估。
  // 对每条序列，候选版本与基线版本都给出告警集合。
  const allSeries = new Set([...baseRules, ...candidateRules].map((r) => r.series_id));
  // 只统计本序列的标签，避免把其他序列的标签计成“漏报”
  const labelSeries = new Map();
  for (const [obsId] of labels) {
    const s = base.byId.get(obsId) || cand.byId.get(obsId);
    if (s) labelSeries.set(obsId, s.seriesId);
  }
  const perSeries = [];
  const totals = {
    base: { alerts: 0, reviewed: 0, tp: 0, fp: 0, dataIssue: 0, missed: 0 },
    cand: { alerts: 0, reviewed: 0, tp: 0, fp: 0, dataIssue: 0, missed: 0 },
  };

  for (const seriesId of allSeries) {
    const baseDet = [...base.detectionById.values()].filter((d) => d.seriesId === seriesId);
    const candDet = [...cand.detectionById.values()].filter((d) => d.seriesId === seriesId);
    const baseSet = new Set(baseDet.map((d) => d.observationId));
    const candSet = new Set(candDet.map((d) => d.observationId));
    // 真实正例 = 分析人员标为真实だが基线未告警的？不，仅用已告警的点做标签。
    const mine = [...labels.entries()].filter(([id]) => labelSeries.get(id) === seriesId);
    const tpLabels = mine.filter(([, v]) => v === 'true_positive');
    const fpLabels = mine.filter(([, v]) => v === 'false_positive');
    const diLabels = mine.filter(([, v]) => v === 'data_issue');

    const stats = (set) => {
      const tp = tpLabels.filter(([id]) => set.has(id)).length;
      const fp = fpLabels.filter(([id]) => set.has(id)).length;
      const dataIssue = diLabels.filter(([id]) => set.has(id)).length;
      const reviewed = tp + fp + dataIssue;
      const missed = tpLabels.filter(([id]) => !set.has(id)).length;
      return { alerts: set.size, reviewed, tp, fp, dataIssue, missed };
    };

    const b = stats(baseSet);
    const c = stats(candSet);
    for (const key of Object.keys(b)) {
      totals.base[key] += b[key];
      totals.cand[key] += c[key];
    }
    const onlyCand = [...candSet].filter((id) => !baseSet.has(id));
    const onlyBase = [...baseSet].filter((id) => !candSet.has(id));
    perSeries.push({
      seriesId,
      base: b,
      candidate: c,
      addedAlertIds: onlyCand,
      removedAlertIds: onlyBase,
      baseRule: baseRules.find((r) => r.series_id === seriesId) || null,
      candidateRule: candidateRules.find((r) => r.series_id === seriesId) || null,
      samples: buildSamples(baseDet, candDet, labels, 6),
    });
  }

  const summary = {
    base: withRates(totals.base),
    candidate: withRates(totals.cand),
    delta: {
      alerts: totals.cand.alerts - totals.base.alerts,
      tp: totals.cand.tp - totals.base.tp,
      fp: totals.cand.fp - totals.base.fp,
      dataIssue: totals.cand.dataIssue - totals.base.dataIssue,
      precision: round4(withRates(totals.cand).precision - withRates(totals.base).precision),
      recall: round4(withRates(totals.cand).recall - withRates(totals.base).recall),
      f1: round4(withRates(totals.cand).f1 - withRates(totals.base).f1),
    },
  };

  return { summary, perSeries };
}

function buildSamples(baseDet, candDet, labels, limit) {
  const baseById = new Map(baseDet.map((d) => [d.observationId, d]));
  const candById = new Map(candDet.map((d) => [d.observationId, d]));
  const ids = [...new Set([...baseById.keys(), ...candById.keys()])]
    .filter((id) => labels.has(id) || baseById.has(id) !== candById.has(id))
    .slice(0, limit);
  return ids.map((id) => ({
    observationId: id,
    ts: (baseById.get(id) || candById.get(id)).ts,
    label: labels.get(id) || null,
    base: baseById.get(id) || null,
    candidate: candById.get(id) || null,
  }));
}

export function withRates(s) {
  const denom = s.tp + s.fp;
  const precision = denom === 0 ? null : s.tp / denom;
  const recallDenom = s.tp + s.missed;
  const recall = recallDenom === 0 ? null : s.tp / recallDenom;
  const f1 = precision == null || recall == null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  return {
    ...s,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
  };
}

function round4(n) {
  return n == null ? null : Math.round(n * 10000) / 10000;
}
