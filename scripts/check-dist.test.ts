import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN,
  facesWithoutSwap,
  findFontFaces,
  findHits,
  findWoffFiles,
} from './check-dist.mjs';

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

// Minified the way vite emits it: no spaces, no trailing semicolon.
const SWAP_FACE =
  '@font-face{font-display:swap;font-family:IBM Plex Sans;font-style:normal;font-weight:400;src:url(./assets/IBMPlexSans-Regular-Latin1.woff2) format("woff2")}';
const AUTO_FACE =
  '@font-face{font-family:IBM Plex Sans;font-style:normal;font-weight:400;src:url(./assets/IBMPlexSans-Regular-Latin1.woff2) format("woff2")}';

describe('findFontFaces', () => {
  it('returns every @font-face block in minified CSS', () => {
    expect(findFontFaces(`.a{color:red}${SWAP_FACE}${AUTO_FACE}.b{margin:0}`)).toEqual([
      SWAP_FACE,
      AUTO_FACE,
    ]);
  });

  it('returns nothing for CSS without fonts', () => {
    expect(findFontFaces('.a{color:red}')).toEqual([]);
  });
});

describe('facesWithoutSwap', () => {
  it('flags a face that leaves font-display unset', () => {
    expect(facesWithoutSwap(AUTO_FACE)).toEqual([AUTO_FACE]);
  });

  it('flags a face that blocks text with font-display: block', () => {
    const blocking = SWAP_FACE.replace('font-display:swap', 'font-display:block');
    expect(facesWithoutSwap(blocking)).toEqual([blocking]);
  });

  it('accepts a face with font-display: swap, minified or not', () => {
    expect(facesWithoutSwap(SWAP_FACE)).toEqual([]);
    expect(facesWithoutSwap(SWAP_FACE.replace('font-display:swap', 'font-display: swap'))).toEqual(
      []
    );
  });
});

describe('findWoffFiles', () => {
  it('flags .woff fonts and keeps .woff2', () => {
    expect(
      findWoffFiles([
        'assets/IBMPlexSans-Regular-Latin1.woff2',
        'assets/IBMPlexSans-Regular.woff',
        'assets/IBMPlexMono-Italic.WOFF',
        'assets/index.css',
      ])
    ).toEqual(['assets/IBMPlexSans-Regular.woff', 'assets/IBMPlexMono-Italic.WOFF']);
  });

  it('returns nothing for a woff2-only build', () => {
    expect(findWoffFiles(['index.html', 'assets/IBMPlexSans-Light-Pi.woff2'])).toEqual([]);
  });
});
