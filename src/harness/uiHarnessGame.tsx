/**
 * Default game UI harness bootstrap (see ui-harness.html).
 *
 * Boots the REAL `<App/>` with the `devHarness` seam engaged: no OSRS cache
 * download, no WebGL, no landing intro. Everything else —
 * every hook, the engine, the providers, the chrome, the overlays — is the
 * production code path, so an agent can drive and screenshot the real UI in
 * about a second. Docs: docs/testing/ui-harness.md.
 */
import '../polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import '../App.css';
import { installInputModality } from '../util/inputModality';
import { log } from '../util/Logger';
import { seedHarnessColosseumStartWave } from './ui/harnessColosseumFixture';
import { installHarnessEnvironment } from './ui/harnessEnvironment';
import { parseHarnessOptions } from './ui/harnessOptions';
import { UiHarnessApp } from './ui/UiHarnessApp';

document.addEventListener('dragstart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());
installInputModality();

const options = parseHarnessOptions(window.location.search);

installHarnessEnvironment(options.open);
seedHarnessColosseumStartWave(options);

log.init();

const REQUIRED_FONTS = [
  'RuneScape Plain 11',
  'RuneScape Plain 12',
  'RuneScape Bold 12',
  'RuneScape Quill 8',
  'RuneScape Small',
];

Promise.all(REQUIRED_FONTS.map((name) => document.fonts.load(`16px "${name}"`).catch(() => {}))).then(() => {
  createRoot(document.getElementById('harness-root')!).render(
    <StrictMode>
      <UiHarnessApp options={options} />
    </StrictMode>,
  );
});
