import { ToolError, basenameFromUrl, pollUntil, type Sleep, sleep as defaultSleep } from '../util.js';
import { throwOnUserErrors, type ShopifyGraphQL, type UserError } from './client.js';

export type MediaKind = 'IMAGE' | 'VIDEO' | 'FILE';

export interface StoreFile {
  id: string;
  kind: MediaKind;
  status: string;
  alt: string | null;
  url: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  createdAt: string;
  /** What to put in a template setting to reference this file. */
  reference: string | null;
  referenceNote: string;
}

const FILE_FRAGMENT = /* GraphQL */ `
  __typename id alt fileStatus createdAt
  ... on MediaImage { mimeType image { url width height } }
  ... on GenericFile { url mimeType }
  ... on Video { filename duration originalSource { url width height mimeType } sources { url mimeType width height format } }
`;

/**
 * Reference formats used inside JSON templates:
 *  - image_picker settings: shopify://shop_images/<filename>
 *  - video settings:        shopify://files/videos/<filename>
 *  - generic files:         shopify://files/<filename>
 */
export function toReference(kind: MediaKind, filename: string | null): { reference: string | null; note: string } {
  if (!filename) return { reference: null, note: 'File has no filename yet (still processing?)' };
  if (kind === 'IMAGE') return { reference: `shopify://shop_images/${filename}`, note: 'Use this value for image_picker settings.' };
  if (kind === 'VIDEO') return { reference: `shopify://files/videos/${filename}`, note: 'Use this value for video settings (hosted video).' };
  return { reference: `shopify://files/${filename}`, note: 'Use this value where a file link is accepted.' };
}

type RawFile = {
  __typename: 'MediaImage' | 'GenericFile' | 'Video' | string;
  id: string; alt: string | null; fileStatus: string; createdAt: string; mimeType?: string | null;
  image?: { url: string; width: number | null; height: number | null } | null;
  url?: string | null; filename?: string | null;
  originalSource?: { url: string | null; width: number | null; height: number | null; mimeType: string | null } | null;
  sources?: Array<{ url: string; mimeType: string; width: number; height: number; format: string }> | null;
};

export function mapFile(raw: RawFile): StoreFile {
  const kind: MediaKind = raw.__typename === 'MediaImage' ? 'IMAGE' : raw.__typename === 'Video' ? 'VIDEO' : 'FILE';
  let url: string | null = null; let width: number | null = null; let height: number | null = null; let filename: string | null = null; let mime: string | null = raw.mimeType ?? null;
  if (kind === 'IMAGE') { url = raw.image?.url ?? null; width = raw.image?.width ?? null; height = raw.image?.height ?? null; filename = url ? basenameFromUrl(url) : null; }
  else if (kind === 'VIDEO') {
    const best = raw.sources?.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    url = best?.url ?? raw.originalSource?.url ?? null; width = raw.originalSource?.width ?? best?.width ?? null; height = raw.originalSource?.height ?? best?.height ?? null;
    filename = raw.filename ?? null; mime = raw.originalSource?.mimeType ?? best?.mimeType ?? null;
  } else { url = raw.url ?? null; filename = url ? basenameFromUrl(url) : null; }
  const ref = toReference(kind, filename);
  return { id: raw.id, kind, status: raw.fileStatus, alt: raw.alt, url, filename, width, height, mimeType: mime, createdAt: raw.createdAt, reference: ref.reference, referenceNote: ref.note };
}

export class FileService {
  constructor(private readonly gql: ShopifyGraphQL, private readonly fetchFn: typeof fetch = fetch, private readonly sleep: Sleep = defaultSleep) {}

  async search(opts: { term?: string; kind?: MediaKind; first?: number; after?: string | null }): Promise<{ files: StoreFile[]; hasNextPage: boolean; endCursor: string | null }> {
    const parts: string[] = [];
    if (opts.kind) parts.push(`media_type:${opts.kind === 'FILE' ? 'GENERIC_FILE' : opts.kind}`);
    if (opts.term?.trim()) parts.push(opts.term.trim().replace(/[:()]/g, ' '));
    const data = await this.gql.request<{ files: { nodes: RawFile[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      /* GraphQL */ `query Files($first: Int!, $after: String, $query: String) {
        files(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes { ${FILE_FRAGMENT} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: Math.min(100, opts.first ?? 25), after: opts.after ?? null, query: parts.join(' ') || null },
    );
    return { files: data.files.nodes.map(mapFile), hasNextPage: data.files.pageInfo.hasNextPage, endCursor: data.files.pageInfo.endCursor };
  }

  async getById(id: string): Promise<StoreFile | null> {
    const data = await this.gql.request<{ node: RawFile | null }>(/* GraphQL */ `query FileById($id: ID!) { node(id: $id) { ${FILE_FRAGMENT} } }`, { id });
    return data.node ? mapFile(data.node) : null;
  }

  /**
   * Create a file from an external URL and wait until Shopify reports READY.
   * Images and generic files are fetched by Shopify directly. Videos go through
   * a staged upload (Shopify does not fetch external video URLs), which means
   * the server downloads the file first — capped by maxBytes.
   */
  async createFromUrl(input: { url: string; alt: string; kind: MediaKind; filename?: string; maxBytes: number; timeoutMs?: number }): Promise<StoreFile> {
    let originalSource = input.url;
    let filename: string | undefined = input.filename ?? (basenameFromUrl(input.url) || undefined);
    if (input.kind === 'VIDEO') {
      const staged = await this.stageUpload(input.url, filename ?? 'video.mp4', input.maxBytes);
      originalSource = staged.resourceUrl;
      filename = staged.filename;
    }
    const data = await this.gql.request<{ fileCreate: { files: RawFile[] | null; userErrors: UserError[] } }>(
      /* GraphQL */ `mutation FileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { ${FILE_FRAGMENT} } userErrors { field message code } } }`,
      { files: [{ alt: input.alt, contentType: input.kind, originalSource, filename, duplicateResolutionMode: 'APPEND_UUID' }] },
    );
    throwOnUserErrors(data.fileCreate.userErrors, 'Uploading file');
    const created = data.fileCreate.files?.[0];
    if (!created) throw new ToolError('Shopify accepted the upload but returned no file.', 'Try again.', 'FILE_CREATE_EMPTY');

    const ready = await pollUntil<StoreFile | { failed: true; reason: string }>(async () => {
      const f = await this.getStatus(created.id);
      if (!f) return null;
      if (f.file.status === 'READY') return f.file;
      if (f.file.status === 'FAILED') return { failed: true, reason: f.errors.join('; ') || 'unknown reason' };
      return null;
    }, { timeoutMs: input.timeoutMs ?? 180_000, initialDelayMs: 1500, maxDelayMs: 8000, sleep: this.sleep });

    if (!ready) throw new ToolError('Shopify is still processing the file after several minutes.', 'Check Content → Files in the admin; it may finish shortly. Then search for it with search_files.', 'FILE_PROCESSING_TIMEOUT', { id: created.id });
    if ('failed' in ready) throw new ToolError(`Shopify could not process the file: ${ready.reason}.`, 'Check that the link downloads the actual file (not a preview page), and that the format is supported (JPG/PNG/WEBP/GIF for images, MP4/MOV for video).', 'FILE_PROCESSING_FAILED', { id: created.id });
    return ready;
  }

  private async getStatus(id: string): Promise<{ file: StoreFile; errors: string[] } | null> {
    const data = await this.gql.request<{ node: (RawFile & { fileErrors?: Array<{ code: string; message: string; details?: string | null }> }) | null }>(
      /* GraphQL */ `query FileStatus($id: ID!) { node(id: $id) { ${FILE_FRAGMENT} ... on File { fileErrors { code message details } } } }`,
      { id },
    );
    if (!data.node) return null;
    return { file: mapFile(data.node), errors: (data.node.fileErrors ?? []).map((e) => `${e.message}${e.details ? ` (${e.details})` : ''}`) };
  }

  private async stageUpload(url: string, filename: string, maxBytes: number): Promise<{ resourceUrl: string; filename: string }> {
    const res = await this.fetchFn(url, { redirect: 'follow' });
    if (!res.ok) throw new ToolError(`Could not download the video from the link (HTTP ${res.status}).`, 'Make sure the link is public and points directly at the file.', 'VIDEO_DOWNLOAD_FAILED');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new ToolError(`The video is too large to upload this way (${Math.round(len / 1e6)} MB).`, `Please upload it in the Shopify admin under Content → Files, then tell me its name. The limit is ${Math.round(maxBytes / 1e6)} MB.`, 'VIDEO_TOO_LARGE');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new ToolError('The video is too large to upload this way.', 'Please upload it in the Shopify admin under Content → Files.', 'VIDEO_TOO_LARGE');
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'video/mp4';
    const data = await this.gql.request<{ stagedUploadsCreate: { stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>; userErrors: UserError[] } }>(
      /* GraphQL */ `mutation Staged($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
      { input: [{ resource: 'VIDEO', filename, mimeType, fileSize: String(buf.byteLength), httpMethod: 'POST' }] },
    );
    throwOnUserErrors(data.stagedUploadsCreate.userErrors, 'Preparing video upload');
    const target = data.stagedUploadsCreate.stagedTargets[0];
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([buf], { type: mimeType }), filename);
    const up = await this.fetchFn(target.url, { method: 'POST', body: form });
    if (!up.ok) throw new ToolError(`Uploading the video to Shopify failed (HTTP ${up.status}).`, 'Try again, or upload it in the admin under Content → Files.', 'VIDEO_STAGED_UPLOAD_FAILED');
    return { resourceUrl: target.resourceUrl, filename };
  }
}
