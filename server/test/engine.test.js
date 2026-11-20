import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replaySeries, deriveRuleChanges, diffRules, backtest, MAX_Z_THRESHOLD,
} from '../lib/engine.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (h) => new Date(T0 + h * HOUR).toISOString();

function series(values, prefix = 'ob') {
  return values.map((value, i) => ({ id: `${prefix}_${String(i).padStart(3, '0')}`, seriesId: 's1', ts: at(i), value }));
}

test('replaySeries 在基线样本不足时不评分', () => {
  const { detections } = replaySeries(series([1, 2, 100]), {
    z_threshold: 3, baseline_window_hours: 24, min_consecutive: 1,
  }, 's1');
  assert.equal(detections.length, 0, '前 3 个点不应产生告警');
});

test('replaySeries 检出显著偏离并给出方向正确的 z', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  values.push(160); // 强正向偏离
  values.push(40);  // 强负向偏离
  const { detections } = replaySeries(series(values), {
    z_threshold: 3, baseline_window_hours: 24, min_consecutive: 1,
  }, 's1');
  assert.equal(detections.length, 2);
  assert.ok(detections[0].z > 3);
  assert.ok(detections[1].z < -3);
  assert.equal(detections[0].severity, 'critical');
});

test('replaySeries 遵守 min_consecutive', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  values.push(160); // 单个尖峰
  const rule = { z_threshold: 3, baseline_window_hours: 24, min_consecutive: 2 };
  assert.equal(replaySeries(series(values), rule, 's1').detections.length, 0, '单点不应触发连续 2 次规则');

  const values2 = [...Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)), 160, 165];
  const { detections } = replaySeries(series(values2), rule, 's1');
  assert.equal(detections.length, 1);
  assert.equal(detections[0].value, 165, '告警落在连续区间的最后一个点');
});

test('replaySeries 排除窗口既不产生告警也不进入基线', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const dirty = series([...values, 999, 999]);
  const windows = [{ from: at(40), to: at(41), reason: '缺口' }];
  const clean = replaySeries(dirty, { z_threshold: 3, baseline_window_hours: 24, min_consecutive: 1, excluded_windows: windows }, 's1');
  assert.equal(clean.detections.length, 0);
  assert.ok(clean.scored.slice(40).every((s) => s.excluded));
});

const baseRules = [{
  series_id: 's1', z_threshold: 3, baseline_window_hours: 24, min_consecutive: 1, excluded_windows: '[]',
}];

function labeled(anomaly, verdict, action = 'threshold_review', id = `fb_${Math.random()}`) {
  return { anomaly, feedback: { id, verdict, action, evidence: 'e' } };
}

test('deriveRuleChanges：误报上调阈值且受单次上限约束', () => {
  const { rules, changes } = deriveRuleChanges(baseRules, [
    labeled({ id: 'a1', series_id: 's1', ts: at(10), score: 3.6 }, 'false_positive'),
  ], new Map());
  assert.ok(rules[0].z_threshold > 3);
  assert.ok(rules[0].z_threshold <= 4.5, '单次反馈不能无限抬高阈值');
  assert.equal(changes.filter((c) => c.field === 'z_threshold').length, 1);
});

test('deriveRuleChanges：误报持续抬升，但每个版本相对基线不超过 1.5 倍', () => {
  let rules = baseRules;
  const steps = [];
  for (let i = 0; i < 5; i += 1) {
    const next = deriveRuleChanges(rules, [
      labeled({ id: `a${i}`, series_id: 's1', ts: at(10 + i * 2), score: 100 }, 'false_positive'),
    ], new Map()).rules;
    steps.push(next[0].z_threshold);
    rules = next;
  }
  assert.ok(steps[0] > 3, '第一次必须抬升');
  assert.equal(steps[0], 4.5, '单次反馈把阈值限制在 3*1.5');
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i] / steps[i - 1] <= 1.5 + 1e-9, '每步不超过上一版的 1.5 倍');
  }
  assert.ok(Math.max(...steps) <= MAX_Z_THRESHOLD, '无论多少轮都不能超过安全上限');
});

test('deriveRuleChanges：数据问题生成排除窗口且不重复', () => {
  const items = [
    labeled({ id: 'a1', series_id: 's1', ts: at(10), score: 9 }, 'data_issue', 'data_pipeline_fix'),
    labeled({ id: 'a2', series_id: 's1', ts: at(10), score: 9 }, 'data_issue', 'data_pipeline_fix'),
  ];
  const { rules, changes } = deriveRuleChanges(baseRules, items, new Map());
  assert.equal(rules[0].excluded_windows.length, 1, '重叠窗口应去重');
  assert.equal(rules[0].baseline_window_hours, 48, '两次数据问题后窗口加倍');
  assert.ok(changes.some((c) => c.field === 'baseline_window_hours'));
});

test('deriveRuleChanges：真实异常不改变规则', () => {
  const { changes } = deriveRuleChanges(baseRules, [
    labeled({ id: 'a1', series_id: 's1', ts: at(10), score: 5 }, 'true_positive', 'no_action'),
  ], new Map());
  assert.equal(changes.length, 0);
});

test('diffRules 报告阈值与排除窗口变化', () => {
  const cand = [{
    series_id: 's1', z_threshold: 3.5, baseline_window_hours: 24, min_consecutive: 1,
    excluded_windows: [{ from: at(1), to: at(2) }],
  }];
  const diff = diffRules(baseRules, cand);
  assert.equal(diff.length, 1);
  const fields = diff[0].fields.map((f) => f.field).sort();
  assert.deepEqual(fields, ['excluded_windows', 'z_threshold']);
});

test('backtest 只统计本序列标签且候选版本减少误报', () => {
  const obs = series(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)));
  const spikeIdx = 40;
  obs.push({ id: 'ob_spike', seriesId: 's1', ts: at(spikeIdx), value: 130 });
  const labels = new Map([['ob_spike', 'false_positive']]);
  const cand = [{ series_id: 's1', z_threshold: 50, baseline_window_hours: 24, min_consecutive: 1, excluded_windows: '[]' }];
  const result = backtest({
    observationsBySeries: new Map([['s1', obs]]),
    baseRules, candidateRules: cand, labels,
  });
  assert.equal(result.summary.base.alerts, 1);
  assert.equal(result.summary.base.fp, 1);
  assert.equal(result.summary.candidate.alerts, 0);
  assert.equal(result.summary.candidate.fp, 0);
  assert.equal(result.summary.candidate.missed, 0);
  assert.equal(result.summary.delta.alerts, -1);
});
