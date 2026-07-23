import type { ReactNode } from 'react';

interface ProviderBadgeProps {
  provider: string;
  size?: 'sm' | 'md';

  showLabel?: boolean;

  className?: string;
}



interface ProviderStyle {

  chip: string;

  accent: string;

  icon: ReactNode;
  label: string;
}

const ICON_PATHS: Record<string, ReactNode> = {

  claude: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z" />
  ),

  codex: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
  ),
  agy: (
    <>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 17V8m-3 3l3-3 3 3" />
    </>
  ),
  grok: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l14 14M19 5L5 19M9 5h10v10" />
  ),
};

const STYLE_MAP: Record<string, ProviderStyle> = {
  claude: {
    chip: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-300/60 dark:border-blue-500/30',
    accent: 'bg-blue-500',
    icon: ICON_PATHS.claude,
    label: 'Claude',
  },
  codex: {
    chip: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-500/30',
    accent: 'bg-emerald-500',
    icon: ICON_PATHS.codex,
    label: 'Codex',
  },
  agy: {
    chip: 'bg-cyan-100 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-300/60 dark:border-cyan-500/30',
    accent: 'bg-cyan-500',
    icon: ICON_PATHS.agy,
    label: 'Antigravity',
  },
  grok: {
    chip: 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-300/60 dark:border-violet-500/30',
    accent: 'bg-violet-500',
    icon: ICON_PATHS.grok,
    label: 'Grok',
  },
};


const FALLBACK_STYLES: ProviderStyle[] = [
  { chip: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-300/60 dark:border-rose-500/30', accent: 'bg-rose-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-pink-100 dark:bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-300/60 dark:border-pink-500/30', accent: 'bg-pink-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-fuchsia-100 dark:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-300/60 dark:border-fuchsia-500/30', accent: 'bg-fuchsia-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-300/60 dark:border-orange-500/30', accent: 'bg-orange-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-teal-100 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-300/60 dark:border-teal-500/30', accent: 'bg-teal-500', icon: ICON_PATHS.claude, label: '' },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function getProviderStyle(provider: string): ProviderStyle {
  const known = STYLE_MAP[provider];
  if (known) return known;
  const fb = FALLBACK_STYLES[hash(provider) % FALLBACK_STYLES.length];
  return { ...fb, label: provider };
}

export function ProviderBadge({
  provider,
  size = 'sm',
  showLabel = true,
  className = '',
}: ProviderBadgeProps) {
  const style = getProviderStyle(provider);
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${style.chip} ${padding} ${className}`}
      title={style.label || provider}
    >
      <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {style.icon}
      </svg>
      {showLabel && <span className="font-semibold tracking-wide">{style.label || provider}</span>}
    </span>
  );
}
