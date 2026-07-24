


export interface ColorPair {
  bar: string;
  dot: string;
  text: string;
}


const MODEL_PALETTE: ColorPair[] = [
  { bar: 'bg-blue-500/70',    dot: 'bg-blue-400',    text: 'text-blue-500 dark:text-blue-300' },
  { bar: 'bg-emerald-500/70', dot: 'bg-emerald-400', text: 'text-emerald-500 dark:text-emerald-300' },
  { bar: 'bg-purple-500/70',  dot: 'bg-purple-400',  text: 'text-purple-500 dark:text-purple-300' },
  { bar: 'bg-amber-500/70',   dot: 'bg-amber-400',   text: 'text-amber-500 dark:text-amber-300' },
  { bar: 'bg-pink-500/70',    dot: 'bg-pink-400',    text: 'text-pink-500 dark:text-pink-300' },
  { bar: 'bg-cyan-500/70',    dot: 'bg-cyan-400',    text: 'text-cyan-500 dark:text-cyan-300' },
  { bar: 'bg-orange-500/70',  dot: 'bg-orange-400',  text: 'text-orange-500 dark:text-orange-300' },
  { bar: 'bg-indigo-500/70',  dot: 'bg-indigo-400',  text: 'text-indigo-500 dark:text-indigo-300' },
  { bar: 'bg-rose-500/70',    dot: 'bg-rose-400',    text: 'text-rose-500 dark:text-rose-300' },
  { bar: 'bg-teal-500/70',    dot: 'bg-teal-400',    text: 'text-teal-500 dark:text-teal-300' },
  { bar: 'bg-violet-500/70',  dot: 'bg-violet-400',  text: 'text-violet-500 dark:text-violet-300' },
  { bar: 'bg-lime-500/70',    dot: 'bg-lime-400',    text: 'text-lime-500 dark:text-lime-300' },
  { bar: 'bg-fuchsia-500/70', dot: 'bg-fuchsia-400', text: 'text-fuchsia-500 dark:text-fuchsia-300' },
  { bar: 'bg-sky-500/70',     dot: 'bg-sky-400',     text: 'text-sky-500 dark:text-sky-300' },
  { bar: 'bg-yellow-500/70',  dot: 'bg-yellow-400',  text: 'text-yellow-600 dark:text-yellow-300' },
  { bar: 'bg-red-500/70',     dot: 'bg-red-400',     text: 'text-red-500 dark:text-red-300' },
  { bar: 'bg-green-500/70',   dot: 'bg-green-400',   text: 'text-green-500 dark:text-green-300' },
  { bar: 'bg-slate-500/70',   dot: 'bg-slate-400',   text: 'text-slate-500 dark:text-slate-300' },
];


export const MUTED_COLOR: ColorPair = {
  bar: 'bg-gray-300/60 dark:bg-gray-700/60',
  dot: 'bg-gray-400 dark:bg-gray-600',
  text: 'text-gray-500 dark:text-gray-500',
};

export function buildColorMap(sortedModels: string[], topN = 12): Map<string, ColorPair> {
  const map = new Map<string, ColorPair>();
  sortedModels.forEach((name, i) => {
    if (i < topN && i < MODEL_PALETTE.length) {
      map.set(name, MODEL_PALETTE[i]);
    } else {
      map.set(name, MUTED_COLOR);
    }
  });
  return map;
}


export const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-green-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-yellow-400',
};


export const REQUEST_STATUS_STYLE: Record<string, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  timeout: 'text-yellow-400',
  cancelled: 'text-gray-400',
};
