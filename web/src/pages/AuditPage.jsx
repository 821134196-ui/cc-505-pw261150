import { api, fmtTime } from '../lib/api.js';
import { useFetch } from '../lib/store.jsx';
import { Badge, Empty, Spinner, ErrorBox } from '../components/ui.jsx';

const ACTION_META = {
  'feedback.create': { label: '提交反馈', tone: 'tp' },
  'feedback.revoke': { label: '撤销反馈', tone: 'fp' },
  'version.create': { label: '创建版本', tone: 'di' },
  'version.activate': { label: '启用版本', tone: 'active' },
  'scan.run': { label: '运行扫描', tone: 'draft' },
};

export function AuditPage() {
  const state = useFetch(() => api.audit());
  const events = state.data?.events || [];

  return (
    <div className="card flush">
      <div className="card-head">
        <div className="grow">
          <h2>审计日志</h2>
          <div className="card-sub">所有标注、撤销与版本操作均留痕，可按实体追溯。</div>
        </div>
        <button className="btn sm" onClick={state.reload}>
          刷新
        </button>
      </div>
      {state.error && <div style={{ padding: 16 }}><ErrorBox error={state.error} onRetry={state.reload} /></div>}
      {state.loading && !state.data && <Spinner />}
      {!state.loading && events.length === 0 && <Empty title="暂无记录" />}
      {events.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const meta = ACTION_META[e.action] || { label: e.action, tone: '' };
                return (
                  <tr key={e.id}>
                    <td className="tabular small nowrap">{fmtTime(e.at, { seconds: true })}</td>
                    <td className="small">{e.actor}</td>
                    <td><Badge tone={meta.tone}>{meta.label}</Badge></td>
                    <td className="mono tiny">{e.entityId}</td>
                    <td className="small secondary" style={{ maxWidth: 420 }}>
                      {summarize(e)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function summarize(e) {
  const d = e.detail || {};
  switch (e.action) {
    case 'feedback.create':
      return `结论 ${d.verdict}，动作 ${d.action}，第 ${d.seq} 条`;
    case 'feedback.revoke':
      return `撤销 ${d.feedbackId}：${d.reason}`;
    case 'version.create':
      return `基于 ${d.baseVersionId} 生成 v${d.version}，${d.changeCount} 项规则变更`;
    case 'version.activate':
      return `替换 ${d.replaces}；保留历史告警 ${d.historicalAnomaliesPreserved} 条`;
    case 'scan.run':
      return `新产生 ${d.created} 条告警`;
    default:
      return JSON.stringify(d);
  }
}
