import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtTime, fmtPct, fmtHour } from '../lib/api.js';
import { useFetch } from '../lib/store.jsx';
import { Icon } from '../components/Icon.jsx';
import { VerdictBar } from '../components/charts.jsx';
import { Badge, VerdictBadge, SeverityBadge, Spinner, ErrorBox, Empty } from '../components/ui.jsx';

export function DashboardPage() {
  const metrics = useFetch(() => api.metrics());
  const versions = useFetch(() => api.versions());
  const anomalies = useFetch(() => api.anomalies({ reviewState: 'unreviewed' }));
  const draft = versions.data?.versions.find((v) => v.status === 'draft');
  const active = versions.data?.versions.find((v) => v.status === 'active');
  const m = metrics.data;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ background: 'var(--surface-1)' }}>
        <div className="row spread" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div className="grow" style={{ minWidth: 260 }}>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>反馈闭环</h2>
            <p className="secondary" style={{ fontSize: 13 }}>
              分析人员把异常标为真实、误报或数据问题，并附上证据与处理动作。
              反馈汇总成新版本的检测规则，经回测后由你决定是否启用；历史告警始终保留原判断。
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link to="/anomalies" className="btn primary">
              <Icon name="list" size={14} /> 去标注异常
            </Link>
            <Link to="/versions" className="btn">
              <Icon name="layers" size={14} /> 查看版本
            </Link>
          </div>
        </div>
      </div>

      <div className="grid-metrics">
        <Stat label="异常总数" value={m?.anomalies} foot={`${m?.series ?? '—'} 条序列 · ${m?.observations ?? '—'} 个观测点`} />
        <Stat label="待复核" value={m?.unreviewed} foot="尚无有效反馈" tone={m?.unreviewed ? 'warning' : ''} />
        <Stat label="已标注" value={m?.reviewed} foot={`累计 ${m?.feedbackTotal ?? 0} 条反馈`} />
        <Stat label="已撤销反馈" value={m?.feedbackRevoked} foot="不参与版本派生" />
        <Stat label="生效版本" value={m?.activeVersion ? `v${m.activeVersion.version}` : '—'} foot={m?.activeVersion?.label} />
      </div>

      <div className="two-col">
        <div className="card">
          <div className="row spread" style={{ marginBottom: 12 }}>
            <div>
              <h2>反馈构成</h2>
              <div className="card-sub">同一异常的多次反馈已合并，按当前有效判断统计</div>
            </div>
            <span className="small muted">{m?.conflicted ?? 0} 条存在冲突</span>
          </div>
          {m ? <VerdictBar counts={m.byVerdict} /> : <Spinner />}

          <div className="divider" style={{ margin: '16px 0' }} />
          <div className="section-label" style={{ marginBottom: 8 }}>最新待复核</div>
          {anomalies.loading && !anomalies.data && <Spinner />}
          {anomalies.error && <ErrorBox error={anomalies.error} />}
          {anomalies.data?.anomalies.length === 0 && <Empty title="全部异常都已复核" hint="可去版本页把反馈应用到新规则。" />}
          <div className="stack" style={{ gap: 0 }}>
            {(anomalies.data?.anomalies || []).slice(0, 5).map((a) => (
              <Link
                key={a.id}
                to={`/anomalies?id=${encodeURIComponent(a.id)}`}
                className="row"
                style={{ padding: '9px 0', borderTop: '1px solid var(--border)', textDecoration: 'none', color: 'inherit', gap: 10 }}
              >
                <SeverityBadge severity={a.severity} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="small strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.seriesName}</div>
                  <div className="tiny muted tabular">{fmtTime(a.ts)}</div>
                </div>
                <span className="tabular small secondary">z {a.score.toFixed(1)}</span>
                <Icon name="chevron" size={14} className="muted" />
              </Link>
            ))}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>版本状态</h2>
            {versions.loading && !versions.data && <Spinner />}
            {active && (
              <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
                <div className="row spread">
                  <span className="small secondary">生效中</span>
                  <Link to={`/versions?v=${encodeURIComponent(active.id)}`} className="small">
                    v{active.version} · {active.label}
                  </Link>
                </div>
                <div className="row spread small secondary">
                  <span>启用时间</span>
                  <span className="tabular">{fmtTime(active.activatedAt)}</span>
                </div>
              </div>
            )}
            {draft ? (
              <div className="notice info" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div className="row" style={{ gap: 7 }}>
                  <Icon name="layers" size={14} />
                  <strong>草案 v{draft.version} 待启用</strong>
                </div>
                {draft.backtestSummary && (
                  <div className="small">
                    回测：精确率 {fmtPct(draft.backtestSummary.base.precision)} →{' '}
                    <strong>{fmtPct(draft.backtestSummary.candidate.precision)}</strong>，
                    告警 {draft.backtestSummary.base.alerts} → {draft.backtestSummary.candidate.alerts}
                  </div>
                )}
                <Link to={`/versions?v=${encodeURIComponent(draft.id)}`} className="btn sm primary" style={{ alignSelf: 'flex-start' }}>
                  查看差异与回测
                </Link>
              </div>
            ) : (
              <Empty title="没有待启用的草案" hint="在版本页从有效反馈派生新版本。" />
            )}
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 8 }}>闭环如何生效</h2>
            <ol className="small secondary" style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>标注：为异常选择判断、证据、动作；多次反馈自动合并。</li>
              <li>派生：只采纳未撤销的反馈，折算为阈值 / 排除窗口 / 基线窗口。</li>
              <li>回测：在历史上对比父版本，用反馈作为标签评估精确率与召回率。</li>
              <li>启用：新版本生效；历史告警保留原版本与原判断。</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, foot, tone = '' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone}`}>{value ?? '—'}</span>
      {foot && <span className="stat-foot">{foot}</span>}
    </div>
  );
}
