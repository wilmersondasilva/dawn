import { describe, expect, it } from 'vitest';
import { normalizeShareLink } from '../src/share-links.js';

describe('share link normalisation', () => {
  it('turns Dropbox share links into direct downloads', () => {
    const a = normalizeShareLink('https://www.dropbox.com/s/abc123/hero.jpg?dl=0');
    expect(a).toMatchObject({ provider: 'dropbox', url: 'https://www.dropbox.com/s/abc123/hero.jpg?dl=1', changed: true, filenameGuess: 'hero.jpg' });
    const b = normalizeShareLink('https://www.dropbox.com/scl/fi/xyz/team%20photo.png?rlkey=k&st=s&dl=0');
    expect(b.url).toBe('https://www.dropbox.com/scl/fi/xyz/team%20photo.png?rlkey=k&st=s&dl=1');
    expect(b.filenameGuess).toBe('team photo.png');
    const c = normalizeShareLink('https://www.dropbox.com/s/abc123/hero.jpg?raw=1');
    expect(c.url).toBe('https://www.dropbox.com/s/abc123/hero.jpg?dl=1');
  });

  it('turns Google Drive links into uc?export=download', () => {
    const a = normalizeShareLink('https://drive.google.com/file/d/1AbC_dEf-9/view?usp=sharing');
    expect(a).toMatchObject({ provider: 'google-drive', url: 'https://drive.google.com/uc?export=download&id=1AbC_dEf-9', changed: true });
    expect(a.warnings[0]).toMatch(/Anyone with the link/);
    expect(normalizeShareLink('https://drive.google.com/open?id=XYZ').url).toBe('https://drive.google.com/uc?export=download&id=XYZ');
    expect(normalizeShareLink('https://drive.google.com/drive/folders/abc').warnings[0]).toMatch(/folder/);
  });

  it('passes direct links through and flags junk', () => {
    expect(normalizeShareLink('https://cdn.example.com/a/b/banner.webp')).toMatchObject({ provider: 'direct', changed: false, filenameGuess: 'banner.webp', warnings: [] });
    expect(normalizeShareLink('not a link').provider).toBe('unknown');
    expect(normalizeShareLink('ftp://x/y.jpg').warnings[0]).toMatch(/Only http/);
    const od = normalizeShareLink('https://1drv.ms/i/s!abc');
    expect(od.provider).toBe('onedrive');
    expect(od.url).toContain('download=1');
  });
});
