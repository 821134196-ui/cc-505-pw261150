import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from './lib/api.js';
import { useApp, useFetch } from './lib/store.jsx';
import { Icon } from './components/Icon.jsx';
import { Toasts } from './components/ui.jsx';

const NAV = [
  { to: '/', label: '概览', icon: 'pulse', end: true, title: '反馈闭环概览', crumb: 'Signal Loop' },
  { to: '/anomalies', label: '异常队列', icon: 'list', title: '异常队列与标注', crumb: '反馈闭环' },
  { to: '/versions', label: '版本与回测', icon: 'layers', title: '版本与回测', crumb: '规则演进' },
  { to: '/concurrency', label: '并发验证', icon: 'activity', title: '并发标记与撤销验证', crumb: '质量保障' },
  { to: '/audit', label: '审计日志', icon: 'history', title: '审计日志', crumb: '合规' },
];

export function AppShell() {
  const { actor, setActor, analysts, theme, setTheme } = useApp();
  const location = useLocation();
  const metrics = useFetch(() => api.metrics());
  const current = NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))) || NAV[0];

  useEffect(() => {
    const handler = () => metrics.reload();
    window.addEventListener('signal-loop:refresh', handler);
    return () => window.removeEventListener('signal-loop:refresh', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">S</div>
          <div className="brand-text">
            <div className="brand-name">Signal Loop</div>
            <div className="brand-sub">异常反馈闭环</div>
          </div>
        </div>

        <div className="nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon name={n.icon} aria-hidden="true" />
              <span className="nav-label">{n.label}</span>
              {n.to === '/anomalies' && metrics.data?.unreviewed > 0 && (
                <span className="nav-badge" title="待复核异常">{metrics.data.unreviewed}</span>
              )}
              {n.to === '/versions' && metrics.data?.activeVersion && (
                <span className="nav-badge" title="当前生效版本">v{metrics.data.activeVersion.version}</span>
              )}
            </NavLink>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="actor-box">
            <label htmlFor="actor-select">当前分析人员</label>
            <select id="actor-select" value={actor} onChange={(e) => setActor(e.target.value)}>
              {analysts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="crumb">{current.crumb}</span>
            <h1>{current.title}</h1>
          </div>
          <div className="topbar-actions">
            <span className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="user" size={13} /> {actor}
            </span>
            <button
              className="btn ghost sm"
              onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')}
              title={`主题：${theme === 'auto' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}`}
              aria-label="切换主题"
            >
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} />
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  );
}
