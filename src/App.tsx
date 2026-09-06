import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import {
  AUTH_MESSAGES, PROVIDER_META, ProviderUsage, ProvidersResponse, Settings,
  barColor, fmtCountdown, loadSettings, pctTextColor, useSettingsSync,
} from './shared';
import './App.css';

export default function App() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [, tick] = useState(0);
  const notifiedRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useSettingsSync(setSettings);

  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-resize window to fit content
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!rootRef.current) return;
        const h = rootRef.current.offsetHeight;
        if (h > 0) invoke('resize_window', { height: h }).catch(() => {});
      });
    };
    measure();
    let ro: ResizeObserver | null = null;
    if (rootRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(rootRef.current);
    }
    return () => { ro?.disconnect(); cancelAnimationFrame(raf); };
  });

  const refresh = useCallback(async () => {
    const enabled = Object.entries(settings.enabled).filter(([, v]) => v).map(([k]) => k);
    try { setData(await invoke<ProvidersResponse>('get_providers', { enabled })); }
    catch (e) { console.error(e); }
  }, [settings.enabled]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, settings.refreshSecs * 1000);
    return () => clearInterval(iv);
  }, [refresh, settings.refreshSecs]);

  const nowSec = Math.floor(Date.now() / 1000);

  // Tray provider — explicitly chosen by user; null = icon only
  const trayProv = settings.trayProvider
    ? data?.providers.find(p => p.id === settings.trayProvider && p.auth_state === 'ok' && p.five_hour)
    : null;

  // Update tray — title shows the chosen countdown, tooltip always lists every enabled provider's %
  useEffect(() => {
    const tooltip = (data?.providers ?? [])
      .filter(p => settings.enabled[p.id] && p.auth_state === 'ok' && p.five_hour)
      .map(p => `${p.short_label} ${Math.round(p.five_hour!.used_percent)}%`)
      .join(' · ') || 'AI Usage';

    if (!trayProv?.five_hour) {
      invoke('update_tray', { text: '', tooltip }).catch(() => {});
    } else {
      const secsRemaining = trayProv.five_hour.resets_at_unix - nowSec;
      invoke('update_tray', { text: fmtCountdown(secsRemaining), tooltip }).catch(() => {});
    }

    // Notifications
    if (settings.notificationsEnabled) {
      for (const p of data?.providers ?? []) {
        if (p.auth_state !== 'ok' || !p.five_hour) continue;
        const key = `${p.id}-${p.five_hour.resets_at_unix}-${settings.alertPct}`;
        if (p.five_hour.used_percent >= settings.alertPct && !notifiedRef.current.has(key)) {
          notifiedRef.current.add(key);
          (async () => {
            const ok = await isPermissionGranted() || (await requestPermission()) === 'granted';
            if (ok) sendNotification({
              title: `${p.display_name}: usage alert`,
              body: `${Math.round(p.five_hour!.used_percent)}% of 5-hour limit used`,
            });
          })();
        }
      }
    }
  });

  const visibleProviders = (data?.providers ?? []).filter(p => settings.enabled[p.id]);

  return (
    <div className="app" ref={rootRef}>
      <div className="titlebar">
        <span className="titlebar-title">AI Usage</span>
        <div className="titlebar-right">
          <button className="icon-btn" onClick={refresh} title="Refresh"><IconRefresh /></button>
          <button className="icon-btn" onClick={() => invoke('open_settings').catch(() => {})} title="Settings"><IconGear /></button>
        </div>
      </div>

      <div className="provider-list">
        {!data && <div className="empty-state">Loading…</div>}
        {data && visibleProviders.length === 0 && (
          <div className="empty-state">No providers enabled — open Settings.</div>
        )}
        {visibleProviders.map(p => (
          <ProviderRow key={p.id} provider={p} nowSec={nowSec} />
        ))}
      </div>

      <div className="footer">
        <span>{data ? `Updated ${data.last_updated}` : 'Loading…'}</span>
      </div>
    </div>
  );
}

function ProviderRow({ provider: p, nowSec }: { provider: ProviderUsage; nowSec: number }) {
  const meta = PROVIDER_META[p.id];

  if (p.auth_state !== 'ok') {
    return (
      <div className="provider-card dimmed">
        <div className="provider-head">
          <span className="provider-icon" style={{ background: meta.tint }}>{meta.icon}</span>
          <span className="provider-name">{p.display_name}</span>
          <span className="provider-status">{AUTH_MESSAGES[p.auth_state] ?? p.auth_state}</span>
        </div>
        {p.auth_error && <div className="provider-detail">{p.auth_error}</div>}
      </div>
    );
  }

  const fh = p.five_hour;
  const wk = p.weekly;
  const fhSecs = fh ? fh.resets_at_unix - nowSec : 0;
  const fhPct = fh?.used_percent ?? 0;
  const wkPct = wk?.used_percent ?? 0;

  return (
    <div className="provider-card">
      <div className="provider-head">
        <span className="provider-icon" style={{ background: meta.tint }}>{meta.icon}</span>
        <span className="provider-name">{p.display_name}</span>
        {p.plan_type && <span className="provider-plan">{p.plan_type}</span>}
        {fh && <span className="provider-pct" style={{ color: pctTextColor(fhPct) }}>{Math.round(fhPct)}%</span>}
      </div>
      {fh && (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(fhPct, 100)}%`, background: barColor(fhPct) }} />
          </div>
          <div className="provider-detail">
            <span>5-hour window</span>
            <span>{fhSecs > 0 ? `resets in ${fmtCountdown(fhSecs)}` : 'ready'}</span>
          </div>
        </>
      )}
      {wk && (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(wkPct, 100)}%`, background: barColor(wkPct) }} />
          </div>
          <div className="provider-detail">
            <span>Weekly · {Math.round(wkPct)}%</span>
            <span>resets in {fmtCountdown(wk.resets_at_unix - nowSec)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
