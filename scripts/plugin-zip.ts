/**
 * Packs plugin/ into the ZIP the OpenAI Plugins dashboard uploads:
 * `pnpm plugin:zip`. The icon is copied from web/public/icon.svg so the
 * package can't drift from the site's. Writes dist/equation-io-<version>.zip.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin/plugin.json'), 'utf8'));

const stage = mkdtempSync(join(tmpdir(), 'equation-plugin-'));
try {
  cpSync(join(ROOT, 'plugin'), stage, { recursive: true });
  mkdirSync(join(stage, 'assets'), { recursive: true });
  cpSync(join(ROOT, 'web/public/icon.svg'), join(stage, 'assets/icon.svg'));
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', `${manifest.name}-${manifest.version}.zip`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-rqX', out, '.', '-x', '.*'], { cwd: stage, stdio: 'inherit' });
  console.log(out);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
