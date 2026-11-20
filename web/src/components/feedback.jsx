import { useEffect, useMemo, useState } from 'react';
import { api, ACTION_LABELS, VERDICT_META, fmtTime, relativeTime, newRequestId, ApiError } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Icon } from './Icon.jsx';
import { Badge, VerdictBadge, SeverityBadge, Modal, Drawer, Field } from './ui.jsx';

const VERDICT_OPTIONS = [
  { value: 'true_positive', label: '真实异常', hint: '确认是真实业务/系统异常，需要处理' },
  { value: 'false_positive', label: '误报', hint: '检测器判错，实际无需处理' },
  { value: 'data_issue', label: '数据问题', hint: '数据本身错误（缺数、重复、埋点故障）' },
];

const ACTION_OPTIONS = Object.entries(ACTION_LABELS);

/* ------------------------------------------------------------------ */
/* 反馈表单：提交 / 追加 / 撤销                                         */
/* ------------------------------------------------------------------ */

export function FeedbackComposer({ anomaly, onSubmitted, compact = false }) {
  const { actor, toast } = useApp();
  const [verdict, setVerdict] = useState('true_positive');
  const [evidence, setEvidence] = useState('');
  const [action, setAction] = useState('no_action');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [requestId, setRequestId] = useState(() => newRequestId());

  const existing = anomaly?.verdict;
  const different = existing && existing !== verdict;

  useEffect(() => {
    if (!different) setConflict(null);
  }, [different]);

  const reset = () => {
    setEvidence('');
    setNote('');
    setError(null);
    setConflict(null);
    setRequestId(newRequestId());
  };

  const submit = async ({ supersedeConflicts = false } = {}) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const res = await api.submitFeedback(anomaly.id, {
        verdict,
        evidence,
        action,
        note: note.trim() || null,
        expectedRevision: anomaly.revision,
        requestId,
        supersedeConflicts,
      });
      toast(
        `已提交「${VERDICT_META[verdict].label}」`,
        'success',
        `${res.anomaly.feedbackCount} 条有效反馈已合并`,
      );
      reset();
      onSubmitted?.(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        setError({
          kind: 'revision',
          message: `该异常在你编辑期间被更新（当前版本 ${err.details?.currentRevision}）。你的反馈尚未提交。`,
        });
      } else if (err instanceof ApiError && err.code === 'VERDICT_CONFLICT') {
        setConflict({
          message: err.message,
          currentVerdicts: err.details?.currentVerdicts || [],
        });
      } else {
        setError({ kind: 'generic', message: err.message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <fieldset style={{ border: 'none', padding: 0, margin: 0 }} className="stack">
        <legend className="section-label" style={{ marginBottom: 7 }}>异常判断</legend>
        <div className="row wrap" style={{ gap: 7 }}>
          {VERDICT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className="btn"
              aria-pressed={verdict === o.value}
              onClick={() => setVerdict(o.value)}
              style={verdict === o.value ? {
                borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 620,
              } : undefined}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="small muted">
          {VERDICT_OPTIONS.find((o) => o.value === verdict)?.hint}
        </div>
      </fieldset>

      {different && (
        <div className="notice warn">
          <Icon name="alert" size={14} />
          <div>
            该异常当前已有结论「{VERDICT_META[existing]?.label}」。追加不同结论会保留双方记录，并将异常标记为
            <strong>存在结论冲突</strong>，以最新一条作为当前判断。
          </div>
        </div>
      )}

      <Field
        label="证据（必填）"
        hint="例如发布单号、监控截图链接、故障复盘条目、对照数据；请写清可核验的依据。"
        htmlFor="fb-evidence"
      >
        <textarea
          id="fb-evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="与 14:05 的发布单 chg-2041 时间吻合，回滚后恢复。"
          rows={compact ? 3 : 4}
          disabled={busy}
        />
      </Field>

      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <Field label="处理动作" hint="影响下一版规则的生成方式" htmlFor="fb-action">
          <select id="fb-action" value={action} onChange={(e) => setAction(e.target.value)} disabled={busy}>
            {ACTION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="备注（可选）" htmlFor="fb-note">
          <input id="fb-note" type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="补充说明" disabled={busy} />
        </Field>
      </div>

      {error && (
        <div className="notice danger" role="alert">
          <Icon name="alert" size={14} />
          <div className="grow">
            <div>{error.message}</div>
            {error.kind === 'revision' && (
              <div className="small" style={{ marginTop: 4 }}>
                可关闭并重新打开该异常以获取最新内容后再提交。
              </div>
            )}
          </div>
        </div>
      )}

      {conflict && (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={14} />
          <div className="grow stack" style={{ gap: 8 }}>
            <div>{conflict.message}</div>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn sm" disabled={busy} onClick={() => submit({ supersedeConflicts: true })}>
                确认追加并标记冲突
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setConflict(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      <div className="row spread">
        <span className="small muted">
          以 <strong style={{ color: 'var(--text-secondary)' }}>{actor}</strong> 身份提交 · 基于版本
          <span className="tabular"> r{anomaly.revision}</span>
        </span>
        <button
          type="button"
          className="btn primary"
          disabled={busy || evidence.trim().length < 3}
          onClick={() => submit()}
        >
          {busy ? '提交中…' : anomaly.hasFeedback ? '提交追加反馈' : '提交反馈'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 撤销确认                                                             */
/* ------------------------------------------------------------------ */

export function RevokeDialog({ feedback, anomaly, onClose, onDone }) {
  const { toast } = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.revokeFeedback(feedback.id, { reason });
      toast('反馈已撤销', 'success',
        res.anomaly.verdict
          ? `当前判断回退为「${VERDICT_META[res.anomaly.verdict]?.label}」`
          : '该异常已无有效反馈');
      onDone?.(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="撤销这条反馈？"
      subtitle={`${feedback.analyst} · ${fmtTime(feedback.createdAt, { seconds: true })}`}
      onClose={onClose}
      labelledBy="revoke-title"
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn danger" onClick={submit} disabled={busy || reason.trim().length < 3}>
            {busy ? '撤销中…' : '确认撤销'}
          </button>
        </>
      )}
    >
      <div className="notice info">
        <Icon name="info" size={14} />
        <div>
          撤销不会删除记录：该条反馈会标记为已撤销并保留在时间线中，相关版本若尚未启用将不再采纳它。
          {anomaly?.feedbackCount === 1 && ' 这是该异常最后一条有效反馈，撤销后将回到「未复核」。'}
        </div>
      </div>
      <div className="tl-evidence">{feedback.evidence}</div>
      <Field label="撤销原因（必填）" hint="审计日志会记录撤销人与原因。" htmlFor="revoke-reason">
        <textarea id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="误标了序列；复核后确认判断有误……" rows={3} disabled={busy} autoFocus />
      </Field>
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 反馈时间线                                                           */
/* ------------------------------------------------------------------ */

export function FeedbackTimeline({ feedback, aggregate, onRevoke }) {
  const active = feedback.filter((f) => f.active);
  const revoked = feedback.filter((f) => !f.active);

  if (feedback.length === 0) {
    return <div className="empty" style={{ padding: '22px 12px' }}>还没有反馈，先给出判断以校准检测规则。</div>;
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      {aggregate && aggregate.revisions > 1 && (
        <div className="notice info">
          <Icon name="layers" size={14} />
          <div>
            <strong>{aggregate.revisions} 条有效反馈已合并</strong>：按最新一条取结论，证据合并去重。
            {aggregate.conflicted && ' 合并结果存在结论冲突，请核对。'}
          </div>
        </div>
      )}
      <div className="timeline">
        {[...active].reverse().map((f, i) => (
          <div className="tl-item" key={f.id}>
            <div className="tl-rail"><span className="tl-dot" /></div>
            <div className="tl-body">
              <div className="tl-meta">
                <VerdictBadge verdict={f.verdict} />
                {i === 0 && <Badge tone="draft">当前判断</Badge>}
                {aggregate?.contributingIds?.[aggregate.contributingIds.length - 1] === f.id && active.length > 1
                  && <span className="tiny">（合并采用）</span>}
                {active.length === 1 && <span className="tiny muted">唯一有效反馈</span>}
                <span>{f.analyst}</span>
                <span>·</span>
                <time dateTime={f.createdAt} title={fmtTime(f.createdAt, { seconds: true })}>{relativeTime(f.createdAt)}</time>
                <span>·</span>
                <span>{ACTION_LABELS[f.action] || f.action}</span>
                <div className="grow" />
                <button
                  className="btn ghost sm"
                  onClick={() => onRevoke(f)}
                  title="撤销这条反馈"
                >
                  <Icon name="undo" size={13} /> 撤销
                </button>
              </div>
              <div className="tl-evidence">{f.evidence}</div>
              {f.note && <div className="tl-note">备注：{f.note}</div>}
            </div>
          </div>
        ))}
      </div>

      {revoked.length > 0 && (
        <details>
          <summary className="small secondary" style={{ cursor: 'pointer' }}>
            已撤销的反馈（{revoked.length}）
          </summary>
          <div className="timeline" style={{ marginTop: 8 }}>
            {revoked.map((f) => (
              <div className="tl-item tl-revoked" key={f.id}>
                <div className="tl-rail"><span className="tl-dot revoked" /></div>
                <div className="tl-body">
                  <div className="tl-meta">
                    <VerdictBadge verdict={f.verdict} />
                    <Badge className="revoked">已撤销</Badge>
                    <span>{f.analyst}</span>
                    <span>·</span>
                    <span>撤销人 {f.revokedBy}</span>
                    <span>·</span>
                    <time dateTime={f.revokedAt}>{fmtTime(f.revokedAt, { seconds: true })}</time>
                  </div>
                  <div className="tl-evidence">{f.evidence}</div>
                  <div className="tl-note">撤销原因：{f.revokeReason}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
