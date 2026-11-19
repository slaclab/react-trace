// The shared start of every page entry. Each entry imports this module first,
// so it runs before any app module is evaluated.
//
// Stylesheet order: Carbon (compiled from Sass, self-hosted IBM Plex), the
// shell's styles, the shell's host-contract sheet, then the app's own chrome,
// so chrome rules can still override the contract.
import './index.scss';
import '@slaclab/canopy-shell/styles.css';
import '@slaclab/canopy-shell/host-contract.css';
import './index.css';
import { applyHostSheetFallback } from '@slaclab/canopy-shell';
import { installBridge } from './embed/bridge';
import { isEmbedded } from './embed/embedded';
import { setupColorMode } from './state/colorMode';

// First: a host stylesheet that failed to load must not leave the page gated
// on host values it never delivered.
applyHostSheetFallback();

// Before the first render: read the stored (or, embedded, the host's) theme
// and paint <html> to match.
setupColorMode();

// Before the first render, so a host message sent on trace-ready is not lost.
if (isEmbedded()) installBridge();
