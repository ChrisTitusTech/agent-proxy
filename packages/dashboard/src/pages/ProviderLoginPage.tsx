import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import {
  cancelProviderLogin,
  fetchProviderLogins,
  startProviderLogin,
  submitProviderLoginCode,
  type ProviderLoginStatus,
} from '../api/client';

const PROVIDER_LABELS: Record<ProviderLoginStatus['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
};

const STATE_STYLES: Record<ProviderLoginStatus['state'], string> = {
  checking: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  authenticated: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  unauthenticated: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  waiting: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  unavailable: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

export default function ProviderLoginPage() {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ProviderLoginStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [authorizationCodes, setAuthorizationCodes] = useState<Record<string, string>>({});

  const load = useCallback(async (force = false) => {
    try {
      setStatuses(await fetchProviderLogins(force));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => {
      void load(false);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const beginLogin = async (provider: ProviderLoginStatus['provider']) => {
    setAction(provider);
    setError(null);
    try {
      const next = await startProviderLogin(provider);
      setStatuses((current) => current.map((item) => (
        item.provider === provider ? next : item
      )));
      window.setTimeout(() => void load(false), 500);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setAction(null);
    }
  };

  const cancelLogin = async (provider: ProviderLoginStatus['provider']) => {
    setAction(provider);
    try {
      const next = await cancelProviderLogin(provider);
      setStatuses((current) => current.map((item) => (
        item.provider === provider ? next : item
      )));
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setAction(null);
    }
  };

  const submitCode = async (provider: ProviderLoginStatus['provider']) => {
    setAction(provider);
    setError(null);
    try {
      const next = await submitProviderLoginCode(
        provider,
        (authorizationCodes[provider] ?? '').trim(),
      );
      setAuthorizationCodes((current) => ({ ...current, [provider]: '' }));
      setStatuses((current) => current.map((item) => (
        item.provider === provider ? next : item
      )));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setAction(null);
    }
  };

  const copyCode = async (provider: string, code: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(code);
      setCopied(provider);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setError(t('providerLogin.copyFailed'));
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('providerLogin.title')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('providerLogin.description')}
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={loading}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
        >
          {t('common.refresh')}
        </button>
      </div>

      <div className="px-4 py-3 rounded-lg border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-300 text-sm">
        {t('providerLogin.securityNote')}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg border bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {statuses.map((item) => {
          const busy = action === item.provider || item.state === 'checking';
          return (
            <section
              key={item.provider}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {PROVIDER_LABELS[item.provider]}
                </h3>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATE_STYLES[item.state]}`}>
                  {t(`providerLogin.state.${item.state}`)}
                </span>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-gray-600 dark:text-gray-300">{item.message}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {t('providerLogin.lastChecked')}: {new Date(item.lastCheckedAt).toLocaleString()}
                </p>
              </div>

              {item.state === 'waiting' && item.verificationUri && (
                <div className="space-y-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 p-4">
                  <a
                    href={item.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
                  >
                    {t('providerLogin.openVerification')}
                  </a>
                  {item.userCode && (
                    <div className="flex items-center gap-2">
                      <code className="px-3 py-2 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-base font-semibold tracking-wider text-gray-900 dark:text-gray-100">
                        {item.userCode}
                      </code>
                      <button
                        onClick={() => void copyCode(item.provider, item.userCode!)}
                        className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        {copied === item.provider ? t('common.copied') : t('common.copy')}
                      </button>
                    </div>
                  )}
                  {item.requiresCodeInput && (
                    <div className="space-y-2">
                      <label
                        htmlFor={`${item.provider}-authorization-code`}
                        className="block text-xs text-blue-700 dark:text-blue-300"
                      >
                        {t('providerLogin.authorizationCode')}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id={`${item.provider}-authorization-code`}
                          type="password"
                          autoComplete="off"
                          value={authorizationCodes[item.provider] ?? ''}
                          onChange={(event) => setAuthorizationCodes((current) => ({
                            ...current,
                            [item.provider]: event.target.value,
                          }))}
                          placeholder={t('providerLogin.authorizationCodePlaceholder')}
                          className="min-w-0 flex-1 px-3 py-2 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-sm text-gray-900 dark:text-gray-100"
                        />
                        <button
                          onClick={() => void submitCode(item.provider)}
                          disabled={action === item.provider || !(authorizationCodes[item.provider] ?? '').trim()}
                          className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium"
                        >
                          {t('providerLogin.submitCode')}
                        </button>
                      </div>
                    </div>
                  )}
                  {item.expiresAt && (
                    <p className="text-xs text-blue-600 dark:text-blue-300">
                      {t('providerLogin.expires')}: {new Date(item.expiresAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void beginLogin(item.provider)}
                  disabled={busy || item.state === 'waiting' || item.state === 'unavailable'}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white"
                >
                  {item.authenticated
                    ? t('providerLogin.refreshLogin')
                    : t('providerLogin.startLogin')}
                </button>
                {item.state === 'waiting' && (
                  <button
                    onClick={() => void cancelLogin(item.provider)}
                    disabled={action === item.provider}
                    className="px-4 py-2 rounded-lg text-sm border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                  >
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {!loading && !error && statuses.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('providerLogin.noProviders')}
        </p>
      )}
    </div>
  );
}
