import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

// ── Types ────────────────────────────────────────────────────────────

export interface LimitBucket { used_percent: number; resets_at_unix: number; window_seconds: number; }

export interface ProviderUsage {
  id: 'claude' | 'codex' | 'glm';
  display_name: string;
  short_label: string;
  five_hour: LimitBucket | null;
  weekly: LimitBucket | null;
  plan_type: string | null;
  auth_state: 'ok' | 'no_credentials' | 'auth_failed' | 'network_error' | 'not_implemented' | 'rate_limited';
  auth_error: string | null;
  accepts_key: boolean;
}

export interface ProvidersResponse {
  providers: ProviderUsage[];
  last_updated: string;
  now_unix: number;
}

export interface Settings {
  enabled: Record<string, boolean>;
  notificationsEnabled: boolean;
  alertPct: number;
  refreshSecs: number;
  /** which provider's countdown to display in the menubar, or null for icon-only */
  trayProvider: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: { claude: true, codex: true, glm: true },
  notificationsEnabled: true,
  alertPct: 80,
  refreshSecs: 60,
  trayProvider: null,
};

export const ALERT_OPTIONS = [50, 75, 80, 90, 95];

export const REFRESH_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

export const PROVIDERS: { id: string; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'glm', name: 'GLM' },
];

export const PROVIDER_META: Record<string, { icon: string; tint: string }> = {
  claude: { icon: 'C', tint: '#d97706' },
  codex:  { icon: '○', tint: '#10a37f' },
  glm:    { icon: 'G', tint: '#4361ee' },
};

/** How each provider is authenticated, shown so setup is self-explanatory. */
export const PROVIDER_AUTH: Record<string, string> = {
  claude: 'Reads the credential Claude Code already stored. Run `claude` once to sign in.',
  codex: 'Reads ~/.codex/auth.json. Run `codex` once to sign in.',
  glm: 'Needs a Z.ai API key from z.ai/manage-apikey/apikey-list.',
};

// ── Settings storage ─────────────────────────────────────────────────

const STORAGE_KEY = 'ai-usage-settings';
const CHANGED_EVENT = 'settings-changed';

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...stored, enabled: { ...DEFAULT_SETTINGS.enabled, ...(stored.enabled || {}) } };
  } catch { return DEFAULT_SETTINGS; }
}

/** Persist and tell the other window, which holds its own copy in React state. */
export function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  emit(CHANGED_EVENT).catch(() => {});
}

/** Re-read settings whenever the other window saves. */
export function useSettingsSync(onChange: (s: Settings) => void) {
  useEffect(() => {
    const un = listen(CHANGED_EVENT, () => onChange(loadSettings()));
    return () => { un.then(f => f()).catch(() => {}); };
  }, [onChange]);
}

// ── Formatting ───────────────────────────────────────────────────────

export function fmtCountdown(secsRemaining: number): string {
  if (secsRemaining <= 0) return 'Ready';
  const h = Math.floor(secsRemaining / 3600);
  const m = Math.floor((secsRemaining % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export function barColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--green)';
}

/** Neutral under 50%, then yellow → orange → red as it approaches 100%. */
export function pctTextColor(pct: number): string {
  if (pct < 50) return 'rgba(255, 255, 255, 0.92)';
  const t = Math.min(1, (pct - 50) / 50);
  const hue = 50 - 50 * t; // 50° (yellow) → 0° (red)
  return `hsl(${hue}, 90%, 62%)`;
}

export const AUTH_MESSAGES: Record<string, string> = {
  no_credentials: 'Not signed in',
  auth_failed: 'Token expired',
  network_error: 'Connection error',
  not_implemented: 'Coming soon',
  rate_limited: 'Rate limited',
};

// ── Controls ─────────────────────────────────────────────────────────

export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
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

export function Select({ value, onChange, children, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
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

/**
 * Write-only: a stored key is never read back into the frontend, the backend
 * only reports whether one exists.
 */
export function ApiKeyRow({ provider, onSaved }: { provider: string; onSaved: () => void }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>('has_provider_key', { provider }).then(setStored).catch(() => setStored(false));
  }, [provider]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await invoke('set_provider_key', { provider, key: value });
      setValue(''); setStored(true); onSaved();
    } catch (e) { setError(String(e)); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await invoke('clear_provider_key', { provider });
      setStored(false); onSaved();
    } catch (e) { setError(String(e)); }
    setBusy(false);
  };

  if (stored === null) return null;

  return (
    <div className="key-row">
      {stored ? (
        <>
          <span className="key-status">API key saved</span>
          <button className="key-btn" onClick={remove} disabled={busy}>Remove</button>
        </>
      ) : (
        <>
          <input
            className="key-input"
            type="password"
            placeholder="Paste API key"
            value={value}
            spellCheck={false}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && value.trim() && !busy) save(); }}
          />
          <button className="key-btn" onClick={save} disabled={busy || !value.trim()}>Save</button>
        </>
      )}
      {error && <div className="key-error">{error}</div>}
    </div>
  );
}
