import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { isEnabled as isAutostartEnabled, enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import './App.css';

interface LimitBucket { used_percent: number; resets_at_unix: number; window_seconds: number; }
interface ProviderUsage {
  id: 'claude' | 'codex' | 'glm';
  display_name: string;
  short_label: string;
  five_hour: LimitBucket | null;
  weekly: LimitBucket | null;
  plan_type: string | null;
  auth_state: 'ok' | 'no_credentials' | 'auth_failed' | 'network_error' | 'not_implemented' | 'rate_limited';
  auth_error: string | null;
}
interface ProvidersResponse {
  providers: ProviderUsage[];
  last_updated: string;
  now_unix: number;
}
interface Settings {
  enabled: Record<string, boolean>;
  notificationsEnabled: boolean;
  alertPct: number;
  refreshSecs: number;
  /** which provider's countdown to display in the menubar, or null for icon-only */
  trayProvider: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  enabled: { claude: true, codex: true, glm: true },
  notificationsEnabled: true,
  alertPct: 80,
  refreshSecs: 60,
  trayProvider: null,
};

const ALERT_OPTIONS = [50, 75, 80, 90, 95];
const REFRESH_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem('ai-usage-settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...stored, enabled: { ...DEFAULT_SETTINGS.enabled, ...(stored.enabled || {}) } };
  } catch { return DEFAULT_SETTINGS; }
}

function fmtCountdown(secsRemaining: number): string {
  if (secsRemaining <= 0) return 'Ready';
  const h = Math.floor(secsRemaining / 3600);
  const m = Math.floor((secsRemaining % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function barColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--green)';
}

/** Neutral under 50%, then yellow → orange → red as it approaches 100%. */
function pctTextColor(pct: number): string {
  if (pct < 50) return 'rgba(255, 255, 255, 0.92)';
  const t = Math.min(1, (pct - 50) / 50);
  const hue = 50 - 50 * t; // 50° (yellow) → 0° (red)
  return `hsl(${hue}, 90%, 62%)`;
}

const PROVIDER_META: Record<string, { icon: string; tint: string }> = {
  claude: { icon: 'C', tint: '#d97706' },
  codex:  { icon: '○', tint: '#10a37f' },
  glm:    { icon: 'G', tint: '#4361ee' },
};

export default function App() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [draft, setDraft] = useState<Settings>(loadSettings);
  const [, tick] = useState(0);
  const [autostart, setAutostart] = useState(false);
  const notifiedRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    isAutostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = useCallback(async (v: boolean) => {
    try {
      if (v) await enableAutostart(); else await disableAutostart();
      setAutostart(v);
    } catch (e) { console.error(e); }
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
    const enabled = Object.entries(settings.enabled).filter(([_, v]) => v).map(([k]) => k);
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

  // ── Settings view ────────────────────────────────────────────────
  if (view === 'settings') {
    const providerList: { id: keyof typeof PROVIDER_META; name: string }[] = [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
      { id: 'glm', name: 'GLM' },
    ];
    return (
      <div className="app" ref={rootRef}>
        <div className="titlebar">
          <button className="back-btn" onClick={() => setView('main')}>‹ Back</button>
          <span className="titlebar-title">Settings</span>
          <button className="done-btn" onClick={() => {
            setSettings(draft);
            localStorage.setItem('ai-usage-settings', JSON.stringify(draft));
            setView('main');
          }}>Done</button>
        </div>

        <div className="section">
          <div className="section-label">Providers</div>
          {providerList.map(({ id, name }) => (
            <div key={id} className="row">
              <span className="row-icon" style={{ background: PROVIDER_META[id].tint }}>{PROVIDER_META[id].icon}</span>
              <span className="row-label">{name}</span>
              <Toggle
                value={draft.enabled[id] ?? false}
                onChange={v => setDraft(d => ({ ...d, enabled: { ...d.enabled, [id]: v } }))}
              />
            </div>
          ))}
        </div>

        <div className="section">
          <div className="section-label">Menu bar</div>
          <div className="row">
            <span className="row-label">Show countdown for</span>
            <Select
              value={draft.trayProvider ?? ''}
              onChange={v => setDraft(d => ({ ...d, trayProvider: v || null }))}
            >
              <option value="">Icon only</option>
              {providerList
                .filter(p => draft.enabled[p.id])
                .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
        </div>

        <div className="section">
          <div className="section-label">Notifications</div>
          <div className="row">
            <span className="row-label">Enable alerts</span>
            <Toggle value={draft.notificationsEnabled} onChange={v => setDraft(d => ({ ...d, notificationsEnabled: v }))} />
          </div>
          <div className="row">
            <span className="row-label">Alert at</span>
            <Select
              value={String(draft.alertPct)}
              onChange={v => setDraft(d => ({ ...d, alertPct: parseInt(v) }))}
              disabled={!draft.notificationsEnabled}
            >
              {ALERT_OPTIONS.map(p => <option key={p} value={p}>{p}% used</option>)}
            </Select>
          </div>
        </div>

        <div className="section">
          <div className="section-label">Refresh</div>
          <div className="row">
            <span className="row-label">Check every</span>
            <Select
              value={String(draft.refreshSecs)}
              onChange={v => setDraft(d => ({ ...d, refreshSecs: parseInt(v) }))}
            >
              {REFRESH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
        </div>

        <div className="section">
          <div className="section-label">General</div>
          <div className="row">
            <span className="row-label">Start at login</span>
            <Toggle value={autostart} onChange={toggleAutostart} />
          </div>
        </div>

        <div className="section">
          <button className="row danger-row" onClick={() => invoke('quit_app').catch(() => {})}>
            <span className="row-label danger">Quit AI Usage</span>
          </button>
        </div>
      </div>
    );
  }

  // ── Main view ────────────────────────────────────────────────────
  const visibleProviders = (data?.providers ?? []).filter(p => settings.enabled[p.id]);

  return (
    <div className="app" ref={rootRef}>
      <div className="titlebar">
        <span className="titlebar-title">AI Usage</span>
        <div className="titlebar-right">
          <button className="icon-btn" onClick={refresh} title="Refresh"><IconRefresh /></button>
          <button className="icon-btn" onClick={() => { setDraft(settings); setView('settings'); }} title="Settings"><IconGear /></button>
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
    const messages: Record<string, string> = {
      no_credentials: 'Not signed in',
      auth_failed: 'Token expired',
      network_error: 'Connection error',
      not_implemented: 'Coming soon',
      rate_limited: 'Rate limited',
    };
    return (
      <div className="provider-card dimmed">
        <div className="provider-head">
          <span className="provider-icon" style={{ background: meta.tint }}>{meta.icon}</span>
          <span className="provider-name">{p.display_name}</span>
          <span className="provider-status">{messages[p.auth_state] ?? p.auth_state}</span>
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

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      className={`toggle ${value ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onChange(!value)}
      aria-pressed={value}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function Select({ value, onChange, children, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <select
      className={`native-select ${disabled ? 'disabled' : ''}`}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}
