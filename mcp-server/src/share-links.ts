/**
 * Turn common "share" links into direct-download URLs that Shopify's
 * fileCreate(originalSource) can fetch. Anything we can't transform is passed
 * through with a warning so the caller can explain it to the customer.
 */
export interface NormalizedLink {
  url: string;
  provider: 'dropbox' | 'google-drive' | 'onedrive' | 'direct' | 'unknown';
  changed: boolean;
  warnings: string[];
  /** Best-effort filename guess for display / alt text suggestions. */
  filenameGuess?: string;
}

export function normalizeShareLink(input: string): NormalizedLink {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: raw, provider: 'unknown', changed: false, warnings: ['This does not look like a valid web link (it must start with https://).'] };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { url: raw, provider: 'unknown', changed: false, warnings: ['Only http(s) links can be uploaded.'] };
  }
  const host = u.hostname.toLowerCase();
  const warnings: string[] = [];

  // Dropbox: /s/<id>/<name>?dl=0 or /scl/fi/<id>/<name>?rlkey=..&dl=0  → dl=1
  if (host === 'www.dropbox.com' || host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    if (host === 'dl.dropboxusercontent.com') {
      return { url: u.toString(), provider: 'dropbox', changed: false, warnings, filenameGuess: lastSegment(u) };
    }
    u.searchParams.delete('raw');
    u.searchParams.set('dl', '1');
    return { url: u.toString(), provider: 'dropbox', changed: u.toString() !== raw, warnings, filenameGuess: lastSegment(u) };
  }

  // Google Drive: /file/d/<id>/view, /open?id=<id>, /uc?id=<id>
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    let id: string | null = null;
    const m = /\/file\/d\/([^/]+)/.exec(u.pathname);
    if (m) id = m[1];
    if (!id) id = u.searchParams.get('id');
    if (id) {
      warnings.push('Google Drive links only work if the file is shared as "Anyone with the link can view". Very large files (>100MB) may fail because Google shows a virus-scan page instead of the file.');
      return { url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, provider: 'google-drive', changed: true, warnings };
    }
    if (u.pathname.startsWith('/drive/folders/')) {
      warnings.push('This is a link to a Google Drive folder, not a file. Please share the individual file.');
    } else {
      warnings.push('Could not find a file id in this Google Drive link. Please use the "Share → Copy link" option on the file itself.');
    }
    return { url: raw, provider: 'google-drive', changed: false, warnings };
  }
  if (host === 'drive.usercontent.google.com') {
    return { url: raw, provider: 'google-drive', changed: false, warnings };
  }

  // OneDrive / SharePoint short links: can't be reliably transformed.
  if (host === '1drv.ms' || host.endsWith('sharepoint.com') || host.endsWith('onedrive.live.com')) {
    if (!u.searchParams.has('download')) {
      u.searchParams.set('download', '1');
    }
    warnings.push('OneDrive links are not always downloadable by Shopify. If the upload fails, please download the file and share it via Dropbox or Google Drive instead.');
    return { url: u.toString(), provider: 'onedrive', changed: u.toString() !== raw, warnings, filenameGuess: lastSegment(u) };
  }

  return { url: u.toString(), provider: 'direct', changed: u.toString() !== raw, warnings, filenameGuess: lastSegment(u) };
}

function lastSegment(u: URL): string | undefined {
  const seg = u.pathname.split('/').filter(Boolean).pop();
  if (!seg) return undefined;
  try { return decodeURIComponent(seg); } catch { return seg; }
}
