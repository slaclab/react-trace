import { describe, expect, it } from 'vitest';
import { FORBIDDEN, findHits } from './check-dist.mjs';

describe('FORBIDDEN', () => {
  it('lists the IBM and Google font hosts', () => {
    expect(FORBIDDEN).toEqual(['s81c.com', 'fonts.googleapis', 'fonts.gstatic']);
  });
});

describe('findHits', () => {
  it('flags a Google Fonts stylesheet URL', () => {
    const css = '@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans");';
    expect(findHits(css)).toEqual(['fonts.googleapis']);
  });

  it('flags a Google Fonts file URL', () => {
    const css = '@font-face{src:url(https://fonts.gstatic.com/s/ibmplexsans/v19/a.woff2)}';
    expect(findHits(css)).toEqual(['fonts.gstatic']);
  });

  it('flags the IBM font CDN', () => {
    const css =
      '@font-face{font-family:"IBM Plex Sans";src:url(https://1.www.s81c.com/common/carbon/plex/fonts/IBM-Plex-Sans/a.woff2)}';
    expect(findHits(css)).toEqual(['s81c.com']);
  });

  it('reports every host found in one text', () => {
    expect(findHits('fonts.gstatic.com s81c.com')).toEqual(['s81c.com', 'fonts.gstatic']);
  });

  it('returns nothing for a self-hosted font rule', () => {
    const css = '@font-face{font-family:"IBM Plex Sans";src:url(./assets/ibm-plex-sans.woff2)}';
    expect(findHits(css)).toEqual([]);
  });

  it('returns nothing for an empty string', () => {
    expect(findHits('')).toEqual([]);
  });
});
