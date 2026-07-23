import { translations } from './translations';

export function translate(
  key: string,
  params?: Record<string, string | number>,
): string {
  let value = translations[key] ?? key;

  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }

  return value;
}

export function useTranslation() {
  return { t: translate };
}
