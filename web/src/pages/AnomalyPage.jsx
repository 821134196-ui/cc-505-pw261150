import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ACTION_LABELS, fmtTime } from '../lib/api.js';
import { useFetch } from '../lib/store.jsx';
import { Icon } from '../components/Icon.jsx';
import { Badge, VerdictBadge, SeverityBadge, Drawer, Empty, Spinner, ErrorBox } from '../components/ui.jsx';
import { SeriesChart } from '../components/charts.jsx';
import { FeedbackComposer, FeedbackTimeline, RevokeDialog } from '../components/feedback.jsx';

export function AnomalyPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [filters, setFilters] = useState({
    search: '', seriesId: '', severity: '', reviewState: '',
  });

  const listState = useFetch(
    () => api.anomalies(filters),
    [filters.search, filters.seriesId, filters.severity, filters.reviewState],
  );
  const seriesState = useFetch(() => api.series());
  const metricsState = useFetch(() => api.metrics());

  const anomalies = listState.data?.anomalies || [];
  const metrics = metricsState.data;

  const open = (id) => setParams({ id }, { replace: false });
  const close = () => setParams({}, { replace: true });

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid-metrics">
        <StatTile label="待复核" value={metrics?.unreviewed} foot={`共 ${metrics?.anomalies ?? '—'} 条告警`} />
        <StatTile label="已标注" value={metrics?.reviewed} foot="含所有有效反馈" />
        <StatTile label="存在冲突" value={metrics?.conflicted} foot="同一异常结论不一致"
          tone={metrics?.conflicted ? 'critical' : ''} />
        <StatTile label="真实 / 误报 / 数据" foot="以当前有效判断计"
          value={metrics ? `${metrics.byVerdict.true_positive || 0} / ${metrics.byVerdict.false_positive || 0} / ${metrics.byVerdict.data_issue || 0}` : '—'} />
        <StatTile
          label="生效版本"
          value={metrics?.activeVersion ? `v${metrics.activeVersion.version}` : '—'}
          foot={metrics?.activeVersion?.label}
        />
      </div>

      <div className="card flush">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 className="grow">异常队列</h2>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="row" style={{ position: 'relative' }}>
              <Icon name="search" size={14} style={{ position: 'absolute', left: 9, color: 'var(--text-muted)' }} />
              <input
                type="search"
                aria-label="搜索异常"
                placeholder="搜索序列或异常 ID"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                style={{ paddingLeft: 29, width: 190 }}
              />
            </div>
            <select
              aria-label="按序列筛选"
              value={filters.seriesId}
              onChange={(e) => setFilters((f) => ({ ...f, seriesId: e.target.value }))}
              style={{ width: 170 }}
            >
              <option value="">全部序列</option>
              {(seriesState.data?.series || []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <select
              aria-label="按严重程度筛选"
              value={filters.severity}
              onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
              style={{ width: 120 }}
            >
              <option value="">全部级别</option>
              <option value="critical">严重</option>
              <option value="warning">警告</option>
              <option value="watch">观察</option>
            </select>
            <div className="segmented" role="group" aria-label="按复核状态筛选">
              {[
                ['', '全部'],
                ['unreviewed', '待复核'],
                ['reviewed', '已标注'],
                ['conflicted', '冲突'],
              ].map(([v, l]) => (
                <button key={v} type="button" aria-pressed={filters.reviewState === v}
                  onClick={() => setFilters((f) => ({ ...f, reviewState: v }))}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {listState.error && <div style={{ padding: 16 }}><ErrorBox error={listState.error} onRetry={listState.reload} /></div>}
        {listState.loading && !listState.data && <Spinner />}
        {!listState.loading && anomalies.length === 0 && !listState.error && (
          <Empty title="没有符合条件的异常" hint="调整筛选条件，或等待下一批检测结果。" />
        )}
        {anomalies.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>序列</th>
                  <th>级别</th>
                  <th style={{ textAlign: 'right' }}>偏离 z</th>
                  <th>判断</th>
                  <th>产生版本</th>
                  <th>反馈</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a) => (
                  <tr
                    key={a.id}
                    className={`clickable${selected === a.id ? ' selected' : ''}`}
                    onClick={() => open(a.id)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') open(a.id); }}
                    aria-label={`打开异常 ${a.id}`}
                  >
                    <td className="tabular nowrap">{fmtTime(a.ts)}</td>
                    <td>
                      <div className="strong">{a.seriesName}</div>
                      <div className="tiny muted mono">{a.seriesId}</div>
                    </td>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td className="num tabular strong">{a.score.toFixed(2)}</td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        <VerdictBadge verdict={a.verdict} />
                        {a.conflicted && <Badge tone="conflict" title="存在结论冲突">冲突</Badge>}
                      </div>
                    </td>
                    <td className="small secondary nowrap">v{a.configVersionId.replace(/^cfg_v/, '').split('_')[0]}</td>
                    <td className="small secondary tabular nowrap">
                      {a.feedbackCount > 0 ? `${a.feedbackCount} 条` : <span className="muted">待复核</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && <AnomalyDrawer id={selected} onClose={close} />}
    </div>
  );
}

function StatTile({ label, value, foot, tone = '' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone}`}>{value ?? '—'}</span>
      {foot && <span className="stat-foot">{foot}</span>}
    </div>
  );
}

export function AnomalyDrawer({ id, onClose }) {
  const state = useFetch(() => api.anomaly(id), [id]);
  const [revoking, setRevoking] = useState(null);
  const [showComposer, setShowComposer] = useState(false);
  const data = state.data;

  useEffect(() => {
    if (data) setShowComposer(!data.hasFeedback);
  }, [data?.id, data?.revision]);

  const onChanged = () => state.reload();

  return (
    <Drawer
      title={data ? data.seriesName : '异常详情'}
      subtitle={`异常 ${id}`}
      onClose={onClose}
      headerExtra={data && (
        <div className="row wrap" style={{ marginTop: 8, gap: 7 }}>
          <SeverityBadge severity={data.severity} />
          <VerdictBadge verdict={data.verdict} />
          {data.conflicted && <Badge tone="conflict">结论冲突</Badge>}
          <span className="small muted">作用于 v{data.configVersionId.replace(/^cfg_v/, '').split('_')[0]}</span>
        </div>
      )}
    >
      {state.error && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.loading && !data && <Spinner />}
      {data && (
        <>
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <dl className="kv">
              <dt>发生时间</dt><dd className="tabular">{fmtTime(data.ts, { seconds: true })}</dd>
              <dt>观测值 / 期望值</dt>
              <dd className="tabular">{fmtValue(data.value)} / {fmtValue(data.expected)}</dd>
              <dt>偏离分数（z）</dt>
              <dd className="tabular strong">{data.score.toFixed(2)}</dd>
              <dt>触发阈值</dt>
              <dd className="tabular">|z| ≥ {data.thresholdAtDetection}</dd>
              <dt>产生版本</dt>
              <dd>v{data.configVersionId.replace(/^cfg_v/, '').split('_')[0]}
                <span className="muted small"> · 检测于 {fmtTime(data.detectedAt)}</span></dd>
              <dt>当前 Revision</dt><dd className="tabular">r{data.revision}</dd>
            </dl>
            <div className="notice info" style={{ marginTop: 12 }}>
              <Icon name="shield" size={14} />
              <div>告警的版本归属与判断均不可变：新规则只对之后产生的告警生效，历史告警保留原判断。</div>
            </div>
          </div>

          {data.context?.neighbors?.length > 0 && (
            <div className="card">
              <div className="section-label" style={{ marginBottom: 8 }}>上下文</div>
              <SeriesChart context={data.context.neighbors} anomaly={data} />
            </div>
          )}

          <div className="card">
            <div className="row spread" style={{ marginBottom: 10 }}>
              <div className="section-label">反馈与合并结果</div>
              <button
                className="btn sm"
                onClick={() => setShowComposer((v) => !v)}
                aria-expanded={showComposer}
              >
                <Icon name={showComposer ? 'x' : 'plus'} size={13} />
                {showComposer ? '收起' : (data.hasFeedback ? '追加反馈' : '添加反馈')}
              </button>
            </div>

            {data.aggregate && data.aggregate.revisions > 1 && (
              <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12, padding: '12px 14px' }}>
                <div className="row spread" style={{ marginBottom: 6 }}>
                  <span className="small strong">合并后的当前判断</span>
                  <VerdictBadge verdict={data.aggregate.verdict} />
                </div>
                <div className="small secondary">
                  来自 {data.aggregate.contributors.length} 位分析人员的 {data.aggregate.revisions} 条有效反馈，
                  动作：{data.aggregate.actions.map((a) => ACTION_LABELS[a] || a).join('、')}
                </div>
              </div>
            )}

            <FeedbackTimeline
              feedback={data.timeline}
              aggregate={data.aggregate}
              onRevoke={(f) => setRevoking(f)}
            />

            {showComposer && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <FeedbackComposer anomaly={data} onSubmitted={() => { onChanged(); }} />
              </div>
            )}
          </div>

          {data.usedByVersions?.length > 0 && (
            <div className="card">
              <div className="section-label" style={{ marginBottom: 8 }}>被以下版本采纳</div>
              <div className="stack" style={{ gap: 6 }}>
                {data.usedByVersions.map((v) => (
                  <div key={v.version_id} className="row spread small" style={{ gap: 8 }}>
                    <span>v{v.version} · {v.label}</span>
                    <Badge tone={v.status}>{v.status === 'active' ? '生效中' : v.status === 'draft' ? '草案' : '已退役'}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {revoking && (
        <RevokeDialog
          feedback={revoking}
          anomaly={data}
          onClose={() => setRevoking(null)}
          onDone={() => { setRevoking(null); onChanged(); }}
        />
      )}
    </Drawer>
  );
}

function fmtValue(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return v.toFixed(2);
}
