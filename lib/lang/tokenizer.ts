export type PatternDict = {
  [type: string]: RegExp | ((val: string) => boolean);
};

export interface Token<TokenType = string> {
  type: TokenType;
  str: string;
  line: number;
  loc: [number, number];
  /** Marks a parenopen that is a function-call argument list (set by expr.ts). */
  call?: boolean;
}

export default function Tokenizer(patternDict: PatternDict) {
  const names = Object.keys(patternDict);
  const fns = names.map(k => {
    const val = patternDict[k];
    if (typeof val === 'object') return (s: string) => val.test(s);
    return val;
  });

  return function* write(string: string): Generator<Token, void, void> {
    let s = string[0];
    let si = 0;
    let t = fns.findIndex(p => p(s));
    let line = 1;

    for (let i = 1; i < string.length; i++) {
      const ds = string[i];
      const cds = s + ds;
      if (fns[t](cds)) {
        s = cds;
      } else {
        yield {
          type: names[t],
          str: s,
          line,
          loc: [si, i],
        };
        const nt = fns.findIndex(p => p(ds));
        t = nt;
        s = ds;
        si = i;
      }
    }

    if (s) {
      yield {
        type: names[t],
        str: s,
        line,
        loc: [si, string.length],
      };
    }
  };
}
