import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx } from '../lib/db.js';
import { seedWithDraft } from '../seed.js';
import { createApp } from '../index.js';
import { createDraftVersion, activateVersion, scanObservations, getAnomaly } from '../lib/service.js';

function freshEnv() {
  const db = openDb(':memory:');
  const info = seedWithDraft(db);
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { db, info, server, base };
}

async function revisionOf(base, id) {
  const res = await fetch(`${base}/api/anomalies/${id}`);
  return (await res.json()).revision;
}

async function call(base, method, path, { body, actor = '测试员' } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-analyst': encodeURIComponent(actor),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function withEnv(fn) {
  return async () => {
    const env = freshEnv();
    try {
      await fn(env);
    } finally {
      env.server.close();
      env.db.close();
    }
  };
}

const fb = (anomalyId, over = {}) => ({
  verdict: 'false_positive',
  evidence: '缓存预热导致的抖动',
  action: 'threshold_review',
  expectedRevision: 0,
  ...over,
});

test('反馈：创建后异常带出聚合判断，且版本号递增', withEnv(async ({ base, info }) => {
  const id = info.ids.latencyFp;
  const before = await call(base, 'GET', `/api/anomalies/${id}`);
  assert.equal(before.json.revision, 2, '种子数据有两次反馈');

  const res = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, { evidence: '补充证据：部署窗口对照', expectedRevision: before.json.revision }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.anomaly.revision, before.json.revision + 1);
  assert.equal(res.json.anomaly.feedbackCount, 3);
  assert.equal(res.json.anomaly.verdict, 'false_positive');
  assert.match(res.json.anomaly.aggregate.evidence, /部署窗口对照/);
}));

test('反馈：证据必填且校验 verdict/action', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const bad = await call(base, 'POST', `/api/anomalies/${id}/feedback`, { body: fb(id, { evidence: ' ' }) });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'EVIDENCE_REQUIRED');

  const badVerdict = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, { verdict: 'maybe', expectedRevision: await revisionOf(base, id) }),
  });
  assert.equal(badVerdict.status, 422);
}));

test('并发：同一 revision 的两次提交只有一个成功', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const rev = await revisionOf(base, id);
  const [a, b] = await Promise.all([
    call(base, 'POST', `/api/anomalies/${id}/feedback`, {
      body: fb(id, { verdict: 'true_positive', evidence: '并发证据 A', expectedRevision: rev }), actor: '甲',
    }),
    call(base, 'POST', `/api/anomalies/${id}/feedback`, {
      body: fb(id, { verdict: 'true_positive', evidence: '并发证据 B', expectedRevision: rev }), actor: '乙',
    }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], '必须恰好一个成功、一个冲突');
  const conflict = a.status === 409 ? a : b;
  assert.equal(conflict.json.error.code, 'REVISION_CONFLICT');
  assert.equal(conflict.json.error.details.currentRevision, rev + 1);
}));

test('并发：不同 revision 的串行提交都成功', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const rev = await revisionOf(base, id);
  const first = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, { verdict: 'true_positive', evidence: '第一次', expectedRevision: rev }), actor: '甲',
  });
  assert.equal(first.status, 201);
  const second = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, { verdict: 'true_positive', evidence: '第二次', expectedRevision: rev + 1 }), actor: '乙',
  });
  assert.equal(second.status, 201);
  // 种子中该异常已有 1 条有效反馈（另有 1 条已撤销，不计入），再加 2 条
  assert.equal(second.json.anomaly.feedbackCount, 3);
  const active = second.json.anomaly.timeline.filter((f) => f.active);
  assert.deepEqual(active.map((f) => f.evidence), ['支付网关 5xx 突增，确认真实故障。', '第一次', '第二次']);
}));

test('幂等：相同 requestId 重复提交不产生第二条', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const body = fb(id, {
    verdict: 'true_positive', evidence: '网络重试',
    expectedRevision: await revisionOf(base, id), requestId: 'req-123',
  });
  const first = await call(base, 'POST', `/api/anomalies/${id}/feedback`, { body });
  const second = await call(base, 'POST', `/api/anomalies/${id}/feedback`, { body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(first.json.feedback.id, second.json.feedback.id);
}));

test('冲突：不同结论需显式确认，确认后保留双方并标记 conflicted', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const rev = await revisionOf(base, id);
  const conflict = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, { verdict: 'false_positive', evidence: '其实是历史波动', expectedRevision: rev }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'VERDICT_CONFLICT');
  assert.equal(conflict.json.error.details.currentVerdicts[0], 'true_positive');

  const confirmed = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, {
      verdict: 'false_positive', evidence: '其实是历史波动', expectedRevision: rev, supersedeConflicts: true,
    }),
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.json.anomaly.conflicted, true);
  assert.equal(confirmed.json.anomaly.feedbackCount, 2);
  assert.equal(confirmed.json.anomaly.verdict, 'false_positive', '以最新反馈为准');
}));

test('撤销：撤销最新反馈后回退到上一条有效结论', withEnv(async ({ base, info }) => {
  const id = info.ids.paymentTp;
  const created = await call(base, 'POST', `/api/anomalies/${id}/feedback`, {
    body: fb(id, {
      verdict: 'false_positive', evidence: '先判误报',
      expectedRevision: await revisionOf(base, id), supersedeConflicts: true,
    }),
  });
  assert.equal(created.json.anomaly.verdict, 'false_positive');

  const revoked = await call(base, 'POST', `/api/feedback/${created.json.feedback.id}/revoke`, {
    body: { reason: '复核后确认为真实故障' },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.anomaly.verdict, 'true_positive', '回退到种子里的真实异常结论');
  assert.equal(revoked.json.anomaly.conflicted, false);
}));

test('撤销：必须给原因，重复撤销幂等', withEnv(async ({ base, info }) => {
  const id = info.ids.latencyFp;
  const detail = await call(base, 'GET', `/api/anomalies/${id}`);
  const fbId = detail.json.timeline[0].id;

  const noReason = await call(base, 'POST', `/api/feedback/${fbId}/revoke`, { body: { reason: '' } });
  assert.equal(noReason.status, 422);

  const first = await call(base, 'POST', `/api/feedback/${fbId}/revoke`, { body: { reason: '重复标注' } });
  const second = await call(base, 'POST', `/api/feedback/${fbId}/revoke`, { body: { reason: '重复标注' } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.feedback.revokedAt, first.json.feedback.revokedAt);
}));

test('并发撤销：同一反馈只能被撤销一次，其余请求幂等返回', withEnv(async ({ base, info }) => {
  const id = info.ids.signupTp;
  const detail = await call(base, 'GET', `/api/anomalies/${id}`);
  const fbId = detail.json.timeline[0].id;
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => call(base, 'POST', `/api/feedback/${fbId}/revoke`, {
      body: { reason: `并发撤销 ${i}` }, actor: `并发${i}`,
    })),
  );
  assert.ok(results.every((r) => r.status === 200));
  const at = new Set(results.map((r) => r.json.feedback.revokedAt));
  assert.equal(at.size, 1, '撤销时间戳唯一，说明只落库一次');
  const revokedBy = new Set(results.map((r) => r.json.feedback.revokedBy));
  assert.equal(revokedBy.size, 1, '只有第一个撤销者被记录');
}));

test('版本：草案只由有效反馈派生，撤销后重新派生会回退', withEnv(async ({ db, info, base }) => {
  const v1 = db.prepare("SELECT * FROM config_versions WHERE version = 1").get();
  const draft1 = createDraftVersion(db, { label: '草案 A', baseVersionId: v1.id }, { actor: '甲' });
  const r1 = draft1.version.rules.find((r) => r.seriesId === 'checkout_latency');
  assert.ok(r1.zThreshold > 3.2, '误报抬高阈值');

  // 撤销 latencyFp 的两条误报反馈
  const detail = await call(base, 'GET', `/api/anomalies/${info.ids.latencyFp}`);
  for (const f of detail.json.timeline.filter((x) => x.active)) {
    await call(base, 'POST', `/api/feedback/${f.id}/revoke`, { body: { reason: '标错序列' } });
  }
  const draft2 = createDraftVersion(db, { label: '草案 B', baseVersionId: v1.id }, { actor: '甲' });
  const r2 = draft2.version.rules.find((r) => r.seriesId === 'checkout_latency');
  assert.ok(r2.zThreshold < r1.zThreshold, '撤销后阈值回落');
  assert.notEqual(draft1.version.id, draft2.version.id, '每次生成新版本');
}));

test('版本：草案包含回测且记录来源反馈', withEnv(async ({ db, info }) => {
  const v1 = db.prepare("SELECT * FROM config_versions WHERE version = 1").get();
  const draft = createDraftVersion(db, { label: '草案 C', baseVersionId: v1.id }, { actor: '甲' });
  assert.ok(draft.version.backtests.length >= 1);
  const summary = draft.version.backtests[0].summary;
  assert.ok(summary.candidate.precision >= summary.base.precision, '候选版本精确率不应下降');
  assert.ok(draft.version.evidence.length > 0, '应记录被采纳的反馈');
  assert.ok(draft.version.feedbackCount > 0);
  assert.ok(draft.version.diff.length > 0, '应含相对父版本的差异');
}));

test('版本：启用需确认，历史告警版本归属不变', withEnv(async ({ db, info }) => {
  const v1 = db.prepare("SELECT * FROM config_versions WHERE version = 1").get();
  const draft = createDraftVersion(db, { label: '草案 D', baseVersionId: v1.id }, { actor: '甲' });

  const noConfirm = await (async () => {
    try {
      activateVersion(db, draft.version.id, {}, { actor: '甲' });
      return null;
    } catch (e) { return e; }
  })();
  assert.equal(noConfirm.code, 'CONFIRM_REQUIRED');

  const before = db.prepare('SELECT id, config_version_id FROM anomalies ORDER BY id').all();
  const result = activateVersion(db, draft.version.id, { confirmRules: true }, { actor: '甲' });
  assert.equal(result.previousVersionId, v1.id);
  const after = db.prepare('SELECT id, config_version_id FROM anomalies ORDER BY id').all();
  assert.deepEqual(after, before, '启用新版本不得改写历史告警的版本归属');
  assert.equal(db.prepare("SELECT status FROM config_versions WHERE id = ?").get(v1.id).status, 'retired');
}));

test('扫描：新告警归属于生效版本，且只处理未处理观测', withEnv(async ({ db, info }) => {
  const v1 = db.prepare("SELECT * FROM config_versions WHERE version = 1").get();
  const draft = createDraftVersion(db, { label: '草案 E', baseVersionId: v1.id }, { actor: '甲' });
  activateVersion(db, draft.version.id, { confirmRules: true }, { actor: '甲' });

  const result = scanObservations(db, { actor: '系统' });
  assert.ok(result.created > 0, '预留的“未来”窗口应产生新告警');
  const newAlerts = db.prepare('SELECT * FROM anomalies WHERE config_version_id = ?').all(draft.version.id);
  assert.equal(newAlerts.length, result.created);
  const oldAlerts = db.prepare('SELECT * FROM anomalies WHERE config_version_id = ?').all(v1.id);
  assert.ok(oldAlerts.length > 0);
  assert.equal(scanObservations(db, {}).created, 0, '重复扫描不产生新告警');
}));

test('版本差异：GET /versions/:id 返回 diff 与证据', withEnv(async ({ base }) => {
  const list = await call(base, 'GET', '/api/versions');
  const draft = list.json.versions.find((v) => v.status === 'draft');
  assert.ok(draft, '种子应包含 v2 草案');
  const detail = await call(base, 'GET', `/api/versions/${draft.id}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.json.diff));
  assert.ok(detail.json.diff.some((d) => d.fields.length > 0));
  assert.ok(detail.json.backtests.length >= 1);
  assert.ok(detail.json.evidence.length > 0);
}));

test('列表筛选：未复核/已复核/冲突', withEnv(async ({ base }) => {
  const unreviewed = await call(base, 'GET', '/api/anomalies?reviewState=unreviewed');
  assert.ok(unreviewed.json.anomalies.every((a) => !a.hasFeedback));
  const conflicted = await call(base, 'GET', '/api/anomalies?reviewState=conflicted');
  assert.ok(conflicted.json.anomalies.length >= 1);
  assert.ok(conflicted.json.anomalies.every((a) => a.conflicted));
}));

test('异常详情：时间线保留撤销历史', withEnv(async ({ base, info }) => {
  const detail = await call(base, 'GET', `/api/anomalies/${info.ids.paymentTp}`);
  const revoked = detail.json.timeline.filter((f) => !f.active);
  assert.equal(revoked.length, 1, '种子里有一条已撤销反馈');
  assert.ok(revoked[0].revokeReason);
  assert.ok(detail.json.timeline.length >= 2);
}));
