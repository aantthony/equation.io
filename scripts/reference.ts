/**
 * The Apple app's language reference (docs/reference/, read by
 * lib/reference.ts) and the file generated from it that is checked in:
 * apple/Equation/Sources/Instructions.swift, the app's instructions
 * (lib/assistant-instructions.ts), which the app and its eval runner
 * compile. Rewrite it after editing the reference or the instructions:
 *
 *   pnpm reference
 *
 * lib/reference.test.ts fails while it is out of date. The app's
 * assistant.json is generated at build time instead
 * (apple/tools/app-data.ts). The site's own reference, web/public/llms.txt,
 * is written by hand and is not generated from here; run with `--llms`, this
 * prints the reference as one file in that layout (lib/reference.ts
 * llmsTxt), for the evals' --reference.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { CHARTED_GROUPS, swiftInstructions } from '../lib/assistant-instructions.ts';
import { type Reference, kindNames, llmsTxt, parseReference } from '../lib/reference.ts';

export const REFERENCE_DIR = new URL('../docs/reference/', import.meta.url);
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

if (import.meta.main && process.argv.includes('--llms')) {
  process.stdout.write(llmsTxt(readReference()));
} else if (import.meta.main) {
  writeFileSync(SWIFT_INSTRUCTIONS, swiftInstructions(kindNames(readReference(), CHARTED_GROUPS)));
  console.log('Wrote apple/Equation/Sources/Instructions.swift');
}
