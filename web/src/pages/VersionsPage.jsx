import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ACTION_LABELS, fmtTime, fmtPct, fmtSigned } from '../lib/api.js';
import { useApp, useFetch } from '../lib/store.jsx';
import { Icon } from '../components/Icon.jsx';
import { Badge, Empty, Spinner, ErrorBox, Modal, Field, Delta, VerdictBadge } from '../components/ui.jsx';
import { BacktestBars } from '../components/charts.jsx';

const STATUS_LABEL = { active: '生效中', draft: '草案', retired: '已退役' };

export function VersionsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('v');
  const listState = useFetch(() => api.versions());
  const [creating, setCreating] = useState(false);
  const versions = listState.data?.versions || [];
  const active = versions.find((v) => v.status === 'active');

  const pick = (id) => setParams({ v: id });

  return (
    <div className="two-col" style={{ alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="row spread" style={{ marginBottom: 4 }}>
            <div>
              <h2>版本链</h2>
              <div className="card-sub">反馈只会写入新版本；启用时历史告警保持原判断与原版本归属。</div>
            </div>
            <button className="btn primary" onClick={() => setCreating(true)} disabled={!active}>
              <Icon name="plus" size={14} /> 从反馈派生新版本
            </button>
          </div>
        </div>

        {listState.error && <ErrorBox error={listState.error} onRetry={listState.reload} />}
        {listState.loading && !listState.data && <Spinner />}
        <div className="stack" style={{ gap: 10 }}>
          {versions.map((v) => {
            const summary = v.backtestSummary;
            return (
              <button
                key={v.id}
                onClick={() => pick(v.id)}
                className="card"
                style={{
                  textAlign: 'left', cursor: 'pointer', width: '100%',
                  borderColor: selected === v.id ? 'var(--accent)' : undefined,
                  boxShadow: selected === v.id ? '0 0 0 1px var(--accent)' : undefined,
                }}
                aria-pressed={selected === v.id}
              >
                <div className="row spread" style={{ marginBottom: 6 }}>
                  <div className="row" style={{ gap: 9 }}>
                    <span className="strong" style={{ fontSize: 15 }}>v{v.version}</span>
                    <Badge tone={v.status}>{STATUS_LABEL[v.status]}</Badge>
                  </div>
                  <span className="small muted tabular">{fmtTime(v.createdAt)}</span>
                </div>
                <div className="strong" style={{ fontSize: 13.5 }}>{v.label}</div>
                {v.notes && <div className="small secondary" style={{ marginTop: 2 }}>{v.notes}</div>}
                <div className="row wrap small muted" style={{ marginTop: 9, gap: 14 }}>
                  <span><Icon name="user" size={12} /> {v.createdBy}</span>
                  <span>{v.feedbackCount} 条反馈被采纳</span>
                  {v.activatedAt && <span>启用 {fmtTime(v.activatedAt)}</span>}
                  {summary && (
                    <span className="tabular">
                      精确率 {fmtPct(summary.candidate.precision)} · 告警 {summary.candidate.alerts}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        {selected
          ? <VersionDetail id={selected} onCreate={() => setCreating(true)} />
          : (
            <div className="card">
              <Empty
                title="选择一个版本查看差异与回测"
                hint="每个版本都会记录它采纳了哪些反馈、相对父版本改了哪些规则，以及在同一段历史上回测的结果。"
              />
            </div>
          )}
      </div>

      {creating && active && (
        <CreateVersionDialog
          baseVersion={active}
          onClose={() => setCreating(false)}
          onCreated={(v) => { setCreating(false); listState.reload(); pick(v.id); }}
        />
      )}
    </div>
  );
}

function VersionDetail({ id, onCreate }) {
  const state = useFetch(() => api.version(id), [id]);
  const v = state.data;
  const [activating, setActivating] = useState(false);

  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!v) return <div className="card"><Spinner /></div>;

  const latestBacktest = v.backtests?.[0];

  return (
    <div className="stack">
      <div className="card">
        <div className="row spread" style={{ marginBottom: 10 }}>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <h2>{versionHeading(v)}</h2>
              <Badge tone={v.status}>{STATUS_LABEL[v.status]}</Badge>
            </div>
            <div className="card-sub" style={{ marginTop: 3 }}>
              {v.createdBy} 创建于 {fmtTime(v.createdAt)}
              {v.parentVersion && ` · 父版本 v${v.parentVersion.version}`}
            </div>
          </div>
          {v.status === 'draft' && (
            <button className="btn primary" onClick={() => setActivating(true)}>
              <Icon name="check" size={14} /> 启用此版本
            </button>
          )}
        </div>
        {v.notes && <p className="small secondary">{v.notes}</p>}
        {v.status === 'active' && (
          <div className="notice success" style={{ marginTop: 10 }}>
            <Icon name="check" size={14} />
            <div>该版本自 {fmtTime(v.activatedAt)} 起生效，此后新产生的告警归属此版本。</div>
          </div>
        )}
      </div>

      {latestBacktest && (
        <div className="card">
          <div className="row spread" style={{ marginBottom: 4 }}>
            <h2>回测结果</h2>
            <span className="small muted tabular">{fmtTime(latestBacktest.createdAt)} · {latestBacktest.createdBy}</span>
          </div>
          <p className="card-sub" style={{ marginBottom: 14 }}>
            在同一段历史观测上分别重放父版本与候选版本，以分析人员的有效反馈为标签。
          </p>
          <div className="row wrap" style={{ gap: 10, marginBottom: 16 }}>
            <MetricPill label="精确率" base={latestBacktest.summary.base.precision}
              cand={latestBacktest.summary.candidate.precision} format={fmtPct} deltaFormat={fmtPp} />
            <MetricPill label="召回率" base={latestBacktest.summary.base.recall}
              cand={latestBacktest.summary.candidate.recall} format={fmtPct} deltaFormat={fmtPp} />
            <MetricPill label="F1" base={latestBacktest.summary.base.f1}
              cand={latestBacktest.summary.candidate.f1}
              format={(x) => (x == null ? '—' : x.toFixed(2))}
              deltaFormat={(v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`)} />
            <MetricPill label="告警数" base={latestBacktest.summary.base.alerts}
              cand={latestBacktest.summary.candidate.alerts} format={(x) => String(x)} invertGood />
            <MetricPill label="误报" base={latestBacktest.summary.base.fp}
              cand={latestBacktest.summary.candidate.fp} format={(x) => String(x)} invertGood />
          </div>
          <BacktestBars base={latestBacktest.summary.base} candidate={latestBacktest.summary.candidate} />
          <BacktestDetail detail={latestBacktest} versionId={v.id} />
        </div>
      )}

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>规则差异</h2>
        <p className="card-sub" style={{ marginBottom: 12 }}>
          {v.parentVersion ? `相对 v${v.parentVersion.version} 的变化` : '初始版本，无父版本'}
        </p>
        {v.diff.length === 0
          ? <div className="empty" style={{ padding: '18px 0' }}>与父版本规则一致。</div>
          : (
            <div className="stack" style={{ gap: 10 }}>
              {v.diff.map((d) => (
                <div key={d.seriesId} className="card" style={{ background: 'var(--surface-2)', padding: '12px 14px' }}>
                  <div className="strong small" style={{ marginBottom: 6 }}>{d.seriesId}</div>
                  <div className="stack" style={{ gap: 6 }}>
                    {d.fields.map((f) => <RuleDiff key={f.field} field={f} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>

      {v.evidence.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>采纳的反馈（{v.evidence.length}）</h2>
          <p className="card-sub" style={{ marginBottom: 10 }}>这些是驱动本版规则的原始依据，可追溯到具体异常。</p>
          <div className="stack" style={{ gap: 9 }}>
            {v.evidence.map((f) => (
              <div key={f.id} className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
                <VerdictBadge verdict={f.verdict} />
                <div className="grow">
                  <div className="small">{f.evidence.split('\n')[0]}</div>
                  <div className="tiny muted">{f.usedReason}</div>
                </div>
                <span className="tiny muted nowrap">{f.analyst}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card flush">
        <div className="card-head"><h2>当前规则（{v.rules.length} 条序列）</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>序列</th>
                <th style={{ textAlign: 'right' }}>阈值 |z|</th>
                <th style={{ textAlign: 'right' }}>基线窗口</th>
                <th style={{ textAlign: 'right' }}>连续点数</th>
                <th style={{ textAlign: 'right' }}>排除窗口</th>
              </tr>
            </thead>
            <tbody>
              {v.rules.map((r) => (
                <tr key={r.seriesId}>
                  <td className="mono">{r.seriesId}</td>
                  <td className="num tabular">{r.zThreshold}</td>
                  <td className="num tabular">{r.baselineWindowHours}h</td>
                  <td className="num tabular">{r.minConsecutive}</td>
                  <td className="num tabular">{r.excludedWindows.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {activating && (
        <ActivateDialog
          version={v}
          onClose={() => { setActivating(false); state.reload(); }}
          onDone={() => { state.reload(); }}
        />
      )}
    </div>
  );
}

/** 版本名若已自带 “v2 · ” 前缀则不重复拼接。 */
export function versionHeading(v) {
  const label = (v.label || '').trim();
  return new RegExp(`^v${v.version}\\b`).test(label) ? label : `v${v.version} · ${label}`;
}

function RuleDiff({ field }) {
  const common = { z_threshold: '阈值 |z|', baseline_window_hours: '基线窗口(h)', min_consecutive: '连续点数' };
  if (field.field === 'excluded_windows') {
    return (
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Badge tone="di">排除窗口</Badge>
        <div className="small">
          {(field.added || []).map((w, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <span className="mono tiny">{w.from.slice(5, 16)} → {w.to.slice(5, 16)}</span>
              <span className="muted">{w.reason}</span>
            </div>
          ))}
          {(field.removed || []).map((w, i) => (
            <div key={`r${i}`} className="muted" style={{ textDecoration: 'line-through' }}>
              {w.from.slice(5, 16)} → {w.to.slice(5, 16)}
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 8 }}>
      <Badge>{common[field.field] || field.field}</Badge>
      <span className="tabular small">
        <span className="muted">{field.from}</span>
        <Icon name="arrowRight" size={12} style={{ margin: '0 5px', verticalAlign: -1 }} />
        <strong>{field.to}</strong>
      </span>
    </div>
  );
}

function fmtPp(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;
}

function MetricPill({ label, base, cand, format, deltaFormat, invertGood = false }) {
  const delta = base == null || cand == null ? null : cand - base;
  return (
    <div className="stat" style={{ padding: '10px 13px', minWidth: 118 }}>
      <span className="stat-label">{label}</span>
      <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
        <span className="tabular" style={{ fontSize: 18, fontWeight: 640 }}>{format(cand)}</span>
        <span className="tiny muted">← {format(base)}</span>
      </div>
      {delta != null && Math.abs(delta) > 1e-9 && (
        <Delta value={delta} invertGood={invertGood} format={deltaFormat || ((v) => `${v > 0 ? '+' : ''}${v}`)} />
      )}
    </div>
  );
}

function BacktestDetail({ detail, versionId }) {
  const [open, setOpen] = useState(false);
  const series = detail.perSeries || detail.details || [];
  if (!series.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '收起分序列明细' : '查看分序列明细'}
      </button>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>序列</th>
                <th style={{ textAlign: 'right' }}>基线告警</th>
                <th style={{ textAlign: 'right' }}>候选告警</th>
                <th style={{ textAlign: 'right' }}>消除误报</th>
                <th style={{ textAlign: 'right' }}>新增告警</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.seriesId}>
                  <td className="mono">{s.seriesId}</td>
                  <td className="num tabular">{s.base.alerts}</td>
                  <td className="num tabular">{s.candidate.alerts}</td>
                  <td className="num tabular">{Math.max(0, s.base.fp - s.candidate.fp)}</td>
                  <td className="num tabular">{s.addedAlertIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivateDialog({ version, onClose, onDone }) {
  const { toast } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.activateVersion(version.id, { confirmRules: true });
      setResult(res);
      toast(`v${version.version} 已启用`, 'success', `历史告警 ${res.historicalAlertsPreserved} 条保留原判断`);
      // 保持弹窗展示成功结果；父组件刷新数据但不要卸载本弹窗
      window.dispatchEvent(new Event('signal-loop:refresh'));
      onDone?.({ keepOpen: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal title="版本已启用" onClose={onClose} labelledBy="activate-done"
        footer={<button className="btn primary" onClick={onClose}>完成</button>}>
        <div className="notice success">
          <Icon name="check" size={15} />
          <div>
            v{version.version} 已生效。{result.historicalAlertsPreserved} 条历史告警保留原版本与原判断，
            后续新告警将归属 v{version.version}。
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`启用 v${version.version}？`}
      subtitle="新规则只影响之后产生的告警"
      onClose={onClose}
      labelledBy="activate-title"
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={submit} disabled={busy || !confirm}>
            {busy ? '启用中…' : '确认启用'}
          </button>
        </>
      )}
    >
      <div className="stack" style={{ gap: 8 }}>
        {version.diff.map((d) => (
          <div key={d.seriesId} className="small">
            <span className="mono">{d.seriesId}</span>
            <span className="muted">：</span>
            {d.fields.map((f, i) => (
              <span key={f.field}>
                {i > 0 && '、'}
                {f.field === 'excluded_windows' ? '排除窗口变化' : `${f.field} ${f.from} → ${f.to}`}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="notice warn">
        <Icon name="alert" size={14} />
        <div>
          启用后 v{version.version} 成为唯一生效版本，旧版本转为“已退役”。
          历史告警的版本归属与已给出的判断不会被改写。
        </div>
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        我已核对上述规则差异与回测结果
      </label>
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}

function CreateVersionDialog({ baseVersion, onClose, onCreated }) {
  const { toast } = useApp();
  const [label, setLabel] = useState(`v${baseVersion.version + 1} · 按反馈校准`);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createVersion({ label, notes, baseVersionId: baseVersion.id });
      toast(`已创建 v${res.version.version}`, 'success', '回测已完成，可查看差异后启用');
      onCreated(res.version);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="从当前生效版本派生"
      subtitle={`基线 v${baseVersion.version} · ${baseVersion.label}`}
      onClose={onClose}
      labelledBy="create-version"
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={submit} disabled={busy || label.trim().length < 3}>
            {busy ? '生成中…' : '生成草案并回测'}
          </button>
        </>
      )}
    >
      <Field label="版本名称" htmlFor="ver-label">
        <input id="ver-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="说明（可选）" htmlFor="ver-notes">
        <textarea id="ver-notes" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="本版依据哪些反馈、预期改善什么……" rows={3} />
      </Field>
      <div className="notice info">
        <Icon name="info" size={14} />
        <div>
          草案只采纳<strong>当前有效</strong>的反馈（已撤销的不参与）。生成时会在同一段历史上回测，
          不会影响线上规则，直到你显式启用。
        </div>
      </div>
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}
