export function isImageUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    const hostname = url.hostname.toLowerCase();
    const isAzureBlobHost = hostname === 'blob.core.windows.net'
      || hostname.endsWith('.blob.core.windows.net');
    return /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(url.pathname) || isAzureBlobHost;
  } catch {
    return false;
  }
}
