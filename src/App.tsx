import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import {
  AUTH_MESSAGES, DANGER_RGB, NEUTRAL_RGB, PROVIDER_META, ProviderUsage, ProvidersResponse, Settings,
  barColor, fmtCountdown, loadSettings, pctTextColor, useSettingsSync,
} from './shared';
import './App.css';

export default function App() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [, tick] = useState(0);
  const notifiedRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const liveLandedRef = useRef(false);

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
    try {
      setData(await invoke<ProvidersResponse>('get_providers', { enabled }));
      liveLandedRef.current = true;
    }
    catch (e) { console.error(e); }
  }, [settings.enabled]);

  // Fill the popover from the Rust-side cache until the live fetch lands.
  //
  // get_providers only returns once the SLOWEST provider is done, so a cold
  // open sat on "Loading..." for that whole time. Each fetch_* writes its own
  // put_cache entry as it finishes, though, so reading the cache on a short
  // interval fills the rows in one by one instead of all at once at the end.
  // Costs one lock-and-clone per tick and no network.
  useEffect(() => {
    if (liveLandedRef.current) return;
    let cancelled = false;
    const enabled = Object.entries(settings.enabled).filter(([, v]) => v).map(([k]) => k);

    const pull = async () => {
      if (cancelled || liveLandedRef.current) return;
      try {
        const cached = await invoke<ProvidersResponse>('get_cached_providers', { enabled });
        if (!cancelled && !liveLandedRef.current && cached.providers.length > 0) setData(cached);
      } catch { /* cache read is best effort */ }
    };

    pull();
    const iv = setInterval(() => {
      if (liveLandedRef.current) { clearInterval(iv); return; }
      pull();
    }, 250);
    return () => { cancelled = true; clearInterval(iv); };
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
  const fh = p.five_hour;
  const wk = p.weekly;
  const fhPct = fh?.used_percent ?? 0;
  const wkPct = wk?.used_percent ?? 0;

  // Brand hue normally, warning hue once a limit is nearly spent, so the wash
  // never competes with the colour that carries the actual signal.
  const peak = Math.max(fhPct, wkPct);
  const rgb = p.auth_state !== 'ok' ? NEUTRAL_RGB
    : peak >= 90 ? DANGER_RGB
    : meta.rgb;

  const wash = {
    '--wash-a': `rgba(${rgb}, 0.16)`,
    '--wash-b': `rgba(${rgb}, 0.07)`,
    '--edge': `rgba(${rgb}, 0.28)`,
  } as React.CSSProperties;

  if (p.auth_state !== 'ok') {
    return (
      <div className="provider-card dimmed" style={wash}>
        <div className="provider-head">
          <span className="provider-icon" style={{ background: meta.tint }}>{meta.icon}</span>
          <span className="provider-name">{p.display_name}</span>
          <span className="provider-status">{AUTH_MESSAGES[p.auth_state] ?? p.auth_state}</span>
        </div>
        {p.auth_error && <div className="provider-detail">{p.auth_error}</div>}
      </div>
    );
  }

  const fhSecs = fh ? fh.resets_at_unix - nowSec : 0;

  return (
    <div className="provider-card" style={wash}>
      <div className="provider-head">
        <span className="provider-icon" style={{ background: meta.tint }}>{meta.icon}</span>
        <span className="provider-name">{p.display_name}</span>
        {p.plan_type && <span className="provider-plan">{p.plan_type}</span>}
        {fh && <span className="provider-pct" style={{ color: pctTextColor(fhPct) }}>{Math.round(fhPct)}%</span>}
      </div>
      {fh && (
        <div className="provider-window">
          <span className="window-label">5 hour</span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(fhPct, 100)}%`, background: barColor(fhPct) }} />
          </div>
          <span className="window-reset">{fhSecs > 0 ? fmtCountdown(fhSecs) : 'ready'}</span>
        </div>
      )}
      {wk && (
        <div className="provider-window">
          <span className="window-label">Weekly</span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(wkPct, 100)}%`, background: barColor(wkPct) }} />
          </div>
          <span className="window-reset">{fmtCountdown(wk.resets_at_unix - nowSec)}</span>
        </div>
      )}
      {p.extra && (
        <div className="provider-window">
          <span className="window-label">{p.extra_label ?? 'Other'}</span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(p.extra.used_percent, 100)}%`, background: barColor(p.extra.used_percent) }} />
          </div>
          <span className="window-reset">{fmtCountdown(p.extra.resets_at_unix - nowSec)}</span>
        </div>
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
