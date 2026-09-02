import type { ThemeService } from '../shopify/themes.js';
import { sameContent } from '../github/promote.js';
import { pollUntil, sleep as defaultSleep, type Sleep } from '../util.js';
import type { ThemeWriter, WriteResult } from './index.js';

export class ShopifyThemeWriter implements ThemeWriter {
  readonly mode = 'shopify' as const;
  constructor(private readonly themes: ThemeService, private readonly stagingThemeId: string, private readonly sleep: Sleep = defaultSleep) {}

  async writeStaging(files: Array<{ filename: string; content: string }>): Promise<WriteResult> {
    await this.themes.upsertFiles(this.stagingThemeId, files);
    // Read back to make sure Shopify stored what we sent.
    const ok = await pollUntil(async () => {
      for (const f of files) if (!sameContent(await this.themes.readFile(this.stagingThemeId, f.filename), f.content)) return null;
      return true;
    }, { timeoutMs: 20_000, initialDelayMs: 500, maxDelayMs: 3000, sleep: this.sleep });
    return { mode: this.mode, files: files.map((f) => f.filename), synced: !!ok, note: ok ? 'Saved to the Staging theme.' : 'Saved, but read-back did not match yet; the preview may take a moment.' };
  }

  async deleteStaging(filenames: string[]): Promise<WriteResult> {
    const deleted = await this.themes.deleteFiles(this.stagingThemeId, filenames);
    return { mode: this.mode, files: deleted, synced: true, note: 'Removed from the Staging theme.' };
  }
}
