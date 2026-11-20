import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ANALYSTS, fmtTime, newRequestId, VERDICT_META } from '../lib/api.js';
import { useFetch } from '../lib/store.jsx';
import { Icon } from '../components/Icon.jsx';
import { Badge, Empty, Spinner, ErrorBox, Field } from '../components/ui.jsx';

/**
 * 并发标记与撤销的验证台：
 * 直接对同一 revision 发起 N 个并发请求，展示乐观锁的胜者与失败者，
 * 再对同一条反馈发起并发撤销，验证只有一次落库。
 */
export function ConcurrencyPage() {
  const listState = useFetch(() => api.anomalies({}));
  const all = listState.data?.anomalies || [];
  // 排除本身已有结论冲突的异常：对它们追加任何结论都会先触发 VERDICT_CONFLICT，
  // 会掩盖本页要验证的乐观锁行为。
  const anomalies = all.filter((a) => !a.conflicted);
  const conflictedCount = all.length - anomalies.length;
  const [targetId, setTargetId] = useState('');
  const target = anomalies.find((a) => a.id === targetId)
    || anomalies.find((a) => !a.hasFeedback)
    || anomalies[0];

  const [markRuns, setMarkRuns] = useState(null);
  const [revokeRuns, setRevokeRuns] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const runConcurrentMarks = async (n = 5) => {
    setTargetId(target.id); // 固定目标，避免列表刷新后选中项漂移
    setBusy('mark');
    setError(null);
    setRevokeRuns(null);
    try {
      const fresh = await api.anomaly(target.id);
      // 用该异常当前的结论，确保并发验证命中的是“同一 revision”，
      // 而不是因为结论不同先触发 VERDICT_CONFLICT。
      const verdict = fresh.verdict || 'true_positive';
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => {
          const actor = ANALYSTS[i % ANALYSTS.length];
          return fetch(`/api/anomalies/${encodeURIComponent(target.id)}/feedback`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-analyst': encodeURIComponent(actor),
            },
            body: JSON.stringify({
              verdict,
              action: 'no_action',
              evidence: `并发验证 #${i + 1}：同一 revision 下的平行提交`,
              expectedRevision: fresh.revision,
              requestId: newRequestId(),
            }),
          }).then(async (r) => ({
            actor,
            status: r.status,
            body: await r.json().catch(() => null),
          }));
        }),
      );
      setMarkRuns({
        anomalyId: fresh.id,
        seriesName: fresh.seriesName,
        revision: fresh.revision,
        verdict,
        results,
      });
      listState.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const runConcurrentRevokes = async () => {
    const winners = markRuns?.results.filter((r) => r.status === 201) || [];
    if (winners.length === 0) return;
    const feedbackId = winners[0].body.feedback.id;
    setBusy('revoke');
    setError(null);
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => {
          const actor = ANALYSTS[i % ANALYSTS.length];
          return fetch(`/api/feedback/${encodeURIComponent(feedbackId)}/revoke`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-analyst': encodeURIComponent(actor),
            },
            body: JSON.stringify({ reason: `并发撤销验证 #${i + 1}` }),
          }).then(async (r) => ({
            actor,
            status: r.status,
            body: await r.json().catch(() => null),
          }));
        }),
      );
      setRevokeRuns({ feedbackId, results });
      listState.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>并发标记与撤销验证</h2>
        <p className="secondary small" style={{ marginBottom: 14 }}>
          针对同一异常、同一 revision 并发提交多条反馈，验证乐观并发控制：恰好一个请求成功，
          其余返回 <code className="mono">409 REVISION_CONFLICT</code>；再并发撤销同一条反馈，
          验证撤销凭据只写入一次、其余请求幂等返回。
        </p>

        <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <Field label="目标异常" htmlFor="conc-target">
            <select
              id="conc-target"
              value={target?.id || ''}
              onChange={(e) => { setTargetId(e.target.value); setMarkRuns(null); setRevokeRuns(null); }}
              style={{ minWidth: 320 }}
            >
              {anomalies.map((a) => (
                <option key={a.id} value={a.id}>
                  {fmtTime(a.ts)} · {a.seriesName} · r{a.revision}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn primary" onClick={() => runConcurrentMarks(5)} disabled={busy || !target}>
            <Icon name="pulse" size={14} /> {busy === 'mark' ? '并发提交中…' : '发起 5 个并发标记'}
          </button>
          <button className="btn" onClick={runConcurrentRevokes}
            disabled={busy || !markRuns?.results.some((r) => r.status === 201)}>
            <Icon name="undo" size={14} /> {busy === 'revoke' ? '并发撤销中…' : '并发撤销胜出反馈'}
          </button>
        </div>
        {target && (
          <div className="small muted" style={{ marginTop: 8 }}>
            当前异常 revision r{target.revision}，已有 {target.feedbackCount} 条有效反馈
            {target.verdict ? `，当前判断「${VERDICT_META[target.verdict]?.label}」` : '，尚未复核'}。
            并发请求统一使用
            {target.verdict ? `「${VERDICT_META[target.verdict]?.label}」` : '「真实异常」'}
            结论，确保竞争只发生在同一 revision 上。
            {conflictedCount > 0 && ` 已从列表排除 ${conflictedCount} 条本身存在结论冲突的异常。`}
          </div>
        )}
        {error && <div className="notice danger" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {markRuns && (
        <div className="card">
          <div className="row spread" style={{ marginBottom: 10 }}>
            <h2>并发标记结果</h2>
            <div className="row" style={{ gap: 8 }}>
              <Badge tone="tp">{markRuns.results.filter((r) => r.status === 201).length} 成功</Badge>
              <Badge tone="fp">{markRuns.results.filter((r) => r.status === 409).length} 冲突</Badge>
            </div>
          </div>
          <p className="small muted" style={{ marginBottom: 10 }}>
            目标 {markRuns.seriesName}（{markRuns.anomalyId}），全部请求都基于 revision r{markRuns.revision}
            提交，结论均为「{VERDICT_META[markRuns.verdict]?.label}」。
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th><th>分析人员</th><th>状态</th><th>结果</th>
                </tr>
              </thead>
              <tbody>
                {markRuns.results.map((r, i) => (
                  <tr key={i}>
                    <td className="tabular">{i + 1}</td>
                    <td>{r.actor}</td>
                    <td>
                      {r.status === 201
                        ? <Badge tone="tp">201 已写入</Badge>
                        : <Badge tone="fp">{r.status} {r.body?.error?.code}</Badge>}
                    </td>
                    <td className="small secondary">
                      {r.status === 201
                        ? `反馈 ${r.body.feedback.id} 落库，异常 revision 变为 r${r.body.anomaly.revision}`
                        : r.status === 409 && r.body?.error?.code === 'REVISION_CONFLICT'
                          ? `乐观锁拒绝：期望 r${markRuns.revision}，实际 r${r.body.error.details?.currentRevision}`
                          : r.body?.error?.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="notice info" style={{ marginTop: 10 }}>
            <Icon name="shield" size={14} />
            <div>结论：{markRuns.results.filter((r) => r.status === 201).length === 1
              ? '恰好一个请求成功，其余被乐观锁拒绝——没有产生重复或丢失更新。'
              : '出现了非预期的成功数量，请检查服务端事务实现。'}</div>
          </div>
        </div>
      )}

      {revokeRuns && (
        <div className="card">
          <div className="row spread" style={{ marginBottom: 10 }}>
            <h2>并发撤销结果</h2>
            <Badge>{revokeRuns.feedbackId}</Badge>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>#</th><th>分析人员</th><th>状态</th><th>撤销时间</th><th>记录撤销人</th></tr>
              </thead>
              <tbody>
                {revokeRuns.results.map((r, i) => {
                  const fb = r.body?.feedback;
                  return (
                    <tr key={i}>
                      <td className="tabular">{i + 1}</td>
                      <td>{r.actor}</td>
                      <td><Badge tone="draft">{r.status}</Badge></td>
                      <td className="small tabular">{fb?.revokedAt ? fmtTime(fb.revokedAt, { seconds: true }) : '—'}</td>
                      <td className="small">{fb?.revokedBy || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(() => {
            const ats = new Set(revokeRuns.results.map((r) => r.body?.feedback?.revokedAt).filter(Boolean));
            const bys = new Set(revokeRuns.results.map((r) => r.body?.feedback?.revokedBy).filter(Boolean));
            const ok = ats.size === 1 && bys.size === 1;
            return (
              <div className={`notice ${ok ? 'success' : 'danger'}`} style={{ marginTop: 10 }}>
                <Icon name={ok ? 'check' : 'alert'} size={14} />
                <div>
                  {ok
                    ? `只有一次撤销真正落库（撤销人 ${[...bys][0]}，${fmtTime([...ats][0], { seconds: true })}），其余 ${revokeRuns.results.length - 1} 个请求幂等返回同一结果。`
                    : '撤销结果不一致，请检查条件更新逻辑。'}
                </div>
              </div>
            );
          })()}
          <div className="small muted" style={{ marginTop: 8 }}>
            撤销后该异常的有效反馈已重算，可在
            {' '}<Link to={`/anomalies?id=${encodeURIComponent(target?.id || '')}`}>异常详情</Link>{' '}
            中查看回退后的当前判断与完整时间线。
          </div>
        </div>
      )}

      {!markRuns && (
        <div className="card">
          <Empty title="尚未运行验证" hint="选择一条异常，点击“发起 5 个并发标记”。" />
        </div>
      )}

      {listState.error && <ErrorBox error={listState.error} onRetry={listState.reload} />}
      {listState.loading && !listState.data && <Spinner />}
    </div>
  );
}
