import { ParseError, type OperatorDict } from './parser.ts';
import type { Token } from './tokenizer.ts';

/**
 * Executes a stream of RPN tokens, invoking the leaf() callback to create leaf AST nodes,
 * and the ops dictionary to create operator AST nodes.
 */
export function walk<T>(
  ops: OperatorDict<T>,
  leaf: (token: Token) => T,
  rpn: Iterable<Token>,
  push: (node: T) => void,
  pop: (n: number) => T[],
) {
  for (const tok of rpn) {
    if (tok.type === 'operator' || tok.type === 'parenclose') {
      const op = ops[tok.str];
      if (!op) throw new Error(`Unknown operator: ${tok.str} at ${tok.line}:${tok.loc[0]}.`);

      // Pop off op.n operands:
      const args = pop(op.n);
      if (args.length < op.n) throw new ParseError('Incomplete expression.', tok);

      // Push the result of applying the operator:
      const result = op.fn(...args);

      push(result);
    } else {
      push(leaf(tok));
    }
  }
}
