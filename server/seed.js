/**
 * 生成确定性演示数据。用法：node server/seed.js --reset
 * 产出：4 条序列 × 21 天小时级观测、v1 生效版本及其告警、
 * 一组已复核/冲突/已撤销的反馈，以及由这些反馈派生的 v2 草案与回测。
 */
import { openDb, tx, nowIso, count } from './lib/db.js';
import { replaySeries } from './lib/engine.js';
import { createFeedback, revokeFeedback, createDraftVersion } from './lib/service.js';

const RESET = process.argv.includes('--reset');
const HOUR = 3600 * 1000;
const START = Date.parse('2026-11-01T00:00:00.000Z');
const TOTAL_HOURS = 504; // 21 天
const PROCESSED_UNTIL = 480; // 前 20 天用于 v1 告警，最后一天留给“新数据扫描”

const SERIES = [
  {
    id: 'checkout_latency', name: '结算服务 P95 延迟', unit: 'ms', detector: 'robust-z',
    description: '核心结算链路的小时级 P95 延迟，阈值基于滚动基线。',
    rule: { z_threshold: 3.2, baseline_window_hours: 24, min_consecutive: 1 },
    base: (h) => 120 + 10 * Math.sin((h / 24) * 2 * Math.PI),
    noise: 4,
  },
  {
    id: 'payment_error_rate', name: '支付失败率', unit: '%', detector: 'robust-z',
    description: '支付网关失败率，数据问题常表现为整点为 0 的埋点缺口。',
    rule: { z_threshold: 3.0, baseline_window_hours: 24, min_consecutive: 1 },
    base: () => 1.2,
    noise: 0.15,
  },
  {
    id: 'signup_conversion', name: '注册转化率', unit: '%', detector: 'robust-z',
    description: '注册漏斗转化率，受营销活动影响较大。',
    rule: { z_threshold: 2.8, baseline_window_hours: 48, min_consecutive: 1 },
    base: (h) => 3.5 + 0.2 * Math.sin((h / 24) * 2 * Math.PI + 1),
    noise: 0.1,
  },
  {
    id: 'job_queue_depth', name: '任务队列积压', unit: '条', detector: 'robust-z',
    description: '异步任务队列深度，要求连续 2 个点超阈值才告警。',
    rule: { z_threshold: 3.5, baseline_window_hours: 24, min_consecutive: 2 },
    base: () => 800,
    noise: 60,
  },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(20261101);
function gaussian() {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 人为注入的事件。at 为小时偏移。
const EVENTS = [
  { series: 'checkout_latency', at: 120, delta: 52, label: 'tp' },
  { series: 'checkout_latency', at: 201, delta: 24, label: 'fp-threshold' },
  { series: 'checkout_latency', at: 470, delta: 46, label: 'conflict' },
  { series: 'payment_error_rate', at: 310, delta: 1.05, label: 'tp' },
  { series: 'payment_error_rate', at: 341, zeros: 5, label: 'data-issue-1' },
  { series: 'payment_error_rate', at: 389, zeros: 4, label: 'data-issue-2' },
  { series: 'signup_conversion', at: 430, delta: -0.62, label: 'tp' },
  { series: 'signup_conversion', at: 454, delta: 0.6, label: 'fp-threshold' },
  { series: 'job_queue_depth', at: 461, delta: 520, length: 2, label: 'unreviewed' },
  { series: 'job_queue_depth', at: 486, delta: 600, length: 2, label: 'future' },
  { series: 'checkout_latency', at: 492, delta: 44, label: 'future' },
];

function isoAt(hour) {
  return new Date(START + hour * HOUR).toISOString();
}

function buildObservations() {
  rand = mulberry32(20261101); // 每次生成都从固定种子开始，保证可复现
  const rows = [];
  for (const s of SERIES) {
    const values = [];
    for (let h = 0; h < TOTAL_HOURS; h += 1) {
      let v = s.base(h) + gaussian() * s.noise;
      const events = EVENTS.filter((e) => e.series === s.id);
      for (const e of events) {
        const len = e.length || 1;
        if (h >= e.at && h < e.at + len) {
          if (e.zeros) v = 0;
          else v += e.delta;
        }
      }
      values.push(Number(Math.max(0, v).toFixed(4)));
    }
    values.forEach((value, h) => {
      rows.push({
        id: `ob_${s.id}_${String(h).padStart(4, '0')}`,
        series_id: s.id,
        ts: isoAt(h),
        value,
        hour: h,
      });
    });
  }
  return rows;
}

export function seed(db) {
  const observations = buildObservations();
  const inserted = tx(db, () => {
    for (const s of SERIES) {
      db.prepare('INSERT INTO series (id, name, unit, detector, description) VALUES (?, ?, ?, ?, ?)')
        .run(s.id, s.name, s.unit, s.detector, s.description);
    }
    const ins = db.prepare(
      `INSERT INTO observations (id, series_id, ts, value, processed) VALUES (?, ?, ?, ?, 0)`,
    );
    for (const o of observations) ins.run(o.id, o.series_id, o.ts, o.value);

    // 生效版本 v1
    const v1id = 'cfg_v1';
    db.prepare(
      `INSERT INTO config_versions (id, version, label, status, notes, created_by, created_at, activated_at, revision)
       VALUES (?, 1, ?, 'active', ?, '系统初始化', ?, ?, 0)`,
    ).run(v1id, '基线 v1 · 默认规则', '上线时的默认阈值，未使用任何人工反馈。', isoAt(0), isoAt(0));
    for (const s of SERIES) {
      db.prepare(
        `INSERT INTO config_rules (version_id, series_id, z_threshold, baseline_window_hours, min_consecutive, excluded_windows)
         VALUES (?, ?, ?, ?, ?, '[]')`,
      ).run(v1id, s.id, s.rule.z_threshold, s.rule.baseline_window_hours, s.rule.min_consecutive);
    }
    return { v1id };
  });

  // 用 v1 规则在前 20 天检测（与线上 scan 一致：只用历史点做基线）
  const bySeries = new Map();
  for (const o of observations.filter((x) => x.hour < PROCESSED_UNTIL)) {
    if (!bySeries.has(o.series_id)) bySeries.set(o.series_id, []);
    bySeries.get(o.series_id).push({ id: o.id, seriesId: o.series_id, ts: o.ts, value: o.value });
  }

  const created = tx(db, () => {
    let n = 0;
    for (const s of SERIES) {
      const { detections } = replaySeries(bySeries.get(s.id), {
        ...s.rule, excluded_windows: [],
      }, s.id);
      for (const det of detections) {
        const id = `an_${det.observationId.replace(/^ob_/, '')}`;
        db.prepare(
          `INSERT INTO anomalies (id, observation_id, series_id, ts, detector, score, value, expected,
             severity, config_version_id, threshold_at_detection, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, det.observationId, det.seriesId, det.ts, s.detector, det.z, det.value,
          det.expected, det.severity, inserted.v1id, s.rule.z_threshold, det.ts);
        n += 1;
      }
    }
    db.prepare('UPDATE observations SET processed = 1 WHERE processed = 0 AND ts < ?').run(isoAt(PROCESSED_UNTIL));
    return n;
  });

  // ---- 反馈 ----
  const findAnomaly = (seriesId, hour, within = 6) => {
    const target = START + hour * HOUR;
    const rows = db.prepare('SELECT * FROM anomalies WHERE series_id = ?').all(seriesId);
    let best = null;
    for (const r of rows) {
      const diff = Math.abs(Date.parse(r.ts) - target) / HOUR;
      if (diff <= within && (!best || diff < best.diff)) best = { row: r, diff };
    }
    return best?.row?.id ?? null;
  };

  const fb = (anomalyId, spec) => {
    if (!anomalyId) return null;
    return createFeedback(db, anomalyId, spec, { actor: spec.analyst }).feedback.id;
  };

  const ids = {};
  const latencyTp = findAnomaly('checkout_latency', 120);
  const latencyFp = findAnomaly('checkout_latency', 201);
  const latencyConflict = findAnomaly('checkout_latency', 470);
  const paymentTp = findAnomaly('payment_error_rate', 310);
  const paymentDi1 = findAnomaly('payment_error_rate', 341, 4);
  const paymentDi2 = findAnomaly('payment_error_rate', 389, 4);
  const signupTp = findAnomaly('signup_conversion', 430);
  const signupFp = findAnomaly('signup_conversion', 451);

  ids.latencyTp = latencyTp;
  ids.latencyFp = latencyFp;
  ids.latencyConflict = latencyConflict;
  ids.paymentTp = paymentTp;
  ids.paymentDi1 = paymentDi1;
  ids.paymentDi2 = paymentDi2;
  ids.signupTp = signupTp;
  ids.signupFp = signupFp;

  fb(latencyTp, {
    analyst: '陈晓', verdict: 'true_positive', action: 'no_action',
    evidence: '与 14:05 的发布单 chg-2041 时间吻合，回滚后恢复。', note: '已通知值班处理。',
  });
  fb(paymentTp, {
    analyst: '陈晓', verdict: 'true_positive', action: 'no_action',
    evidence: '支付网关 5xx 突增，确认真实故障。',
  });
  // 已撤销的反馈：不参与任何版本派生
  const revokedId = fb(paymentTp, {
    analyst: '王芳', verdict: 'false_positive', action: 'threshold_review',
    evidence: '（误操作）初次判断为历史波动。', supersedeConflicts: true,
  });
  if (revokedId) {
    revokeFeedback(db, revokedId, { reason: '误操作：复核为真实故障，撤回该结论' }, { actor: '王芳' });
  }

  // 同一异常的多次反馈（同结论，合并证据）
  fb(latencyFp, {
    analyst: '李明', verdict: 'false_positive', action: 'threshold_review',
    evidence: '发布期间缓存预热造成的短暂抖动，已确认非故障。',
  });
  fb(latencyFp, {
    analyst: '王芳', verdict: 'false_positive', action: 'threshold_review',
    evidence: '对照部署窗口，同一分钟内多条延迟指标同步抬升，属预期行为。',
    note: '建议把该序列阈值上调 0.4 左右。',
  });

  fb(paymentDi1, {
    analyst: '李明', verdict: 'data_issue', action: 'data_pipeline_fix',
    evidence: '上游埋点缺数，整点为 0 并非真实失败率。',
  });
  fb(paymentDi2, {
    analyst: '周涛', verdict: 'data_issue', action: 'baseline_fix',
    evidence: '采集任务重跑导致 4 个小时写入 0 值，污染基线。',
  });

  fb(signupTp, {
    analyst: '陈晓', verdict: 'true_positive', action: 'no_action',
    evidence: '短信通道故障导致验证码未送达，已定位。',
  });
  fb(signupFp, {
    analyst: '周涛', verdict: 'false_positive', action: 'mute',
    evidence: '双十一预热流量结构变化，转化率短期偏离属预期。',
  });

  // 冲突反馈：两位分析人员结论不同，聚合后以最新一条为准并标记冲突
  fb(latencyConflict, {
    analyst: '李明', verdict: 'true_positive', action: 'no_action',
    evidence: '尾部延迟与数据库慢查询告警同时出现。',
  });
  fb(latencyConflict, {
    analyst: '王芳', verdict: 'data_issue', action: 'data_pipeline_fix',
    evidence: '同一时段的延迟来自压测流量，非线上真实请求。',
    supersedeConflicts: true,
  });

  return { v1id: inserted.v1id, anomalies: created, ids, observations: observations.length };
}

/** 完整引导：演示数据 + 由有效反馈派生的 v2 草案（含回测）。测试与 CLI 共用。 */
export function seedWithDraft(db) {
  const info = seed(db);
  const { version, changes } = createDraftVersion(db, {
    label: 'v2 · 按分析反馈校准',
    notes: '依据有效反馈：上调两条序列阈值、排除两段数据缺口、拉长支付失败率基线窗口。',
    baseVersionId: info.v1id,
  }, { actor: '陈晓' });
  return { ...info, draftVersion: version, changes };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  if (RESET) {
    tx(db, () => {
      for (const t of ['version_feedback', 'backtests', 'feedback', 'anomalies', 'observations',
        'config_rules', 'config_versions', 'series', 'audit_log']) {
        db.exec(`DELETE FROM ${t}`);
      }
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_log'");
    });
  }
  const existing = count(db, 'SELECT COUNT(*) AS n FROM series');
  if (existing === 0) {
    const result = seedWithDraft(db);
    console.log('已写入演示数据：', {
      anomalies: result.anomalies, observations: result.observations, draftVersion: result.draftVersion.id,
    });
    console.log(`已派生草案 v${result.draftVersion.version}（${result.draftVersion.id}），规则变更 ${result.changes.length} 项`);
    console.log('回测摘要：', JSON.stringify(result.draftVersion.backtests[0].summary, null, 2));
    console.log('提示：在“版本”页启用 v2 并运行扫描，可看到新告警归属 v2、历史告警仍归属 v1。');
  } else {
    console.log('数据库已有数据，跳过。使用 --reset 重置。');
  }
}
