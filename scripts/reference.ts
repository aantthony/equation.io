/**
 * The language reference (docs/reference/, read by lib/reference.ts) and the
 * files generated from it that are checked in, so the site, the MCP server
 * and the Apple app serve them as they are:
 *
 * - web/public/llms.txt, the single-file reference;
 * - apple/Equation/Sources/Instructions.swift, the Apple app's instructions
 *   (lib/assistant-instructions.ts), so the app and its eval runner compile
 *   the same text the voice prototype uses.
 *
 * Rewrite both after editing the reference or the instructions:
 *
 *   pnpm reference
 *
 * lib/reference.test.ts fails while either is out of date. The site's docs
 * pages and the app's assistant.json are generated at build time instead
 * (vite.config.ts, apple/vite.config.ts).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { swiftInstructions } from '../lib/assistant-instructions.ts';
import { type Reference, kindNames, llmsTxt, parseReference } from '../lib/reference.ts';

export const REFERENCE_DIR = new URL('../docs/reference/', import.meta.url);
export const LLMS_TXT = new URL('../web/public/llms.txt', import.meta.url);
export const SWIFT_INSTRUCTIONS = new URL('../apple/Equation/Sources/Instructions.swift', import.meta.url);

/** Every page of docs/reference, by its path there. */
export function referenceFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(REFERENCE_DIR, { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('.md'))
      .map(path => [path.split('\\').join('/'), readFileSync(new URL(path, REFERENCE_DIR), 'utf8')]),
  );
}

export function readReference(): Reference {
  return parseReference(referenceFiles());
}

if (import.meta.main) {
  writeFileSync(LLMS_TXT, llmsTxt(readReference()));
  writeFileSync(SWIFT_INSTRUCTIONS, swiftInstructions(kindNames(readReference())));
  console.log('Wrote web/public/llms.txt and apple/Equation/Sources/Instructions.swift');
}
