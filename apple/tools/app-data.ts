/**
 * The data the Apple app bundles (apple/Equation/Data, a folder the app
 * copies whole):
 *
 * - examples.json: the examples menu (web/examples.ts) for the app's menu bar
 *   (Examples.swift), rows split the way the web menu splits them;
 * - assistant.json: what Ask's lookups answer from (lib/reference.ts
 *   AssistantData): the reference's kinds, forms, notes and shapes
 *   (docs/reference), with the menu's examples by what they draw and the
 *   functions they call;
 * - language.json: what those lookups read from the language itself, so the
 *   Swift port (apple/EquationCore EquationAssist) copies no table by hand.
 *
 *   pnpm app:data
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { KIND_MEANINGS, examplesIndex } from '../../lib/assistant-tools.ts';
import { type AssistantData, assistantData } from '../../lib/reference.ts';
import { splitStatements } from '../../lib/statements.ts';
import { builtinTable } from '../../lib/syntax-help.ts';
import { readReference } from '../../scripts/reference.ts';
import { EXAMPLES } from '../../web/examples.ts';

/** The examples menu: its categories, each example's rows and tags. */
export function examplesData() {
  return EXAMPLES.map(([name, items]) => ({
    name,
    examples: items.map(([label, rows, tags]) => ({
      label,
      rows: splitStatements(rows)
        .map(s => s.trim())
        .filter(Boolean),
      tags: tags.split(' ').filter(Boolean),
    })),
  }));
}

/** What the lookups answer from, as the evals' service builds it (apple/evals/episode.ts). */
export function lookupData(): AssistantData {
  const menu = examplesIndex(EXAMPLES.flatMap(([, items]) => items.map(([label, rows]) => [label, rows] as const)));
  return assistantData(readReference(), menu);
}

/**
 * What lib/assistant-tools.ts reads besides AssistantData:
 *
 * - `builtins`: the function table (lib/syntax-help.ts builtinTable), and its
 *   names in the order localeCompare sorts them here, which search_functions
 *   breaks ties by: collation is the platform's, so the order is recorded
 *   rather than made again;
 * - `kindMeanings`: KIND_MEANINGS, what each kind draws;
 * - `forms`: each kind's smallest form as rows, as kind_examples prints it,
 *   split here because splitting is the language's (lib/statements.ts).
 */
export function languageData(data: AssistantData) {
  const builtins = builtinTable();
  const kinds = data.groups.flatMap(g => g.kinds);
  return {
    builtins: { ...builtins, sorted: [...builtins.names].sort((a, b) => a.localeCompare(b)) },
    kindMeanings: Object.fromEntries(kinds.map(k => [k.kind, KIND_MEANINGS[k.kind]])),
    forms: Object.fromEntries(kinds.map(k => [k.kind, splitStatements(k.form).map(s => s.trim())])),
  };
}

if (import.meta.main) {
  const out = new URL('../Equation/Data/', import.meta.url);
  mkdirSync(out, { recursive: true });
  const assistant = lookupData();
  const files = { examples: examplesData(), assistant, language: languageData(assistant) };
  for (const [name, data] of Object.entries(files)) writeFileSync(new URL(`${name}.json`, out), JSON.stringify(data));
  console.log(`Wrote ${Object.keys(files).join('.json, ')}.json to apple/Equation/Data`);
}
