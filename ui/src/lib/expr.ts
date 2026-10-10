/**
 * A small Pratt parser for author-written expressions.
 *
 * Written in the style of the Go DQL parser in `internal/dataview/parser.go`,
 * so the two read the same way, and deliberately **without `Function()`**: a
 * capacity model or a plot curve in a shared page is author-supplied text, and
 * substituting it into a JS evaluator is the one thing that turns a markdown
 * file into an execution surface. `mathjs` would also do this, at ~160 KB; the
 * grammar an author needs is 200 lines.
 *
 * Supports numbers, identifiers, `+ - * / % ^`, unary minus, comparisons,
 * `and` / `or` / `not`, parentheses, and the named functions below.
 */

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export type Scope = Record<string, number | boolean>;

/**
 * Only the mathematical constants.
 *
 * Magnitude units (`k`, `m`, `Mi`) deliberately live in kiwi-calc's scope
 * instead: `y = m*x + b` is the most ordinary formula an author will ever
 * write, and a global `m = 1e6` would silently answer it with a million.
 */
export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  inf: Infinity,
  infinity: Infinity,
};

type Fn = (...args: number[]) => number;

export const FUNCTIONS: Record<string, { arity: number | [number, number]; fn: Fn }> = {
  abs: { arity: 1, fn: Math.abs },
  sign: { arity: 1, fn: Math.sign },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: [1, 2], fn: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) },
  log2: { arity: 1, fn: Math.log2 },
  log10: { arity: 1, fn: Math.log10 },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  atan2: { arity: 2, fn: Math.atan2 },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  trunc: { arity: 1, fn: Math.trunc },
  min: { arity: [1, 32], fn: (...a) => Math.min(...a) },
  max: { arity: [1, 32], fn: (...a) => Math.max(...a) },
  hypot: { arity: [1, 32], fn: (...a) => Math.hypot(...a) },
  pow: { arity: 2, fn: Math.pow },
  mod: { arity: 2, fn: (a, b) => a % b },
  // Useful in a capacity model: "how many shards at 40k writes each?"
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(Math.max(x, lo), hi) },
};

// ── Lexer ───────────────────────────────────────────────────────────────────

type TokenType = "number" | "name" | "op" | "(" | ")" | "," | "eof";

interface Token {
  type: TokenType;
  text: string;
  value?: number;
  pos: number;
}

const OPERATORS = [
  "<=", ">=", "==", "!=", "&&", "||",
  "+", "-", "*", "/", "%", "^", "<", ">", "=", "!",
];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      out.push({ type: ch, text: ch, pos: i });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!match) throw new ExprError(`bad number at position ${i}`);
      out.push({ type: "number", text: match[0], value: Number(match[0]), pos: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ type: "name", text: match[0], pos: i });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character ${JSON.stringify(ch)} at position ${i}`);
    out.push({ type: "op", text: op, pos: i });
    i += op.length;
  }
  out.push({ type: "eof", text: "", pos: src.length });
  return out;
}

// ── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | { kind: "num"; value: number }
  | { kind: "name"; name: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

/** Binding powers. Comparisons bind loosest, `^` tightest, as in maths. */
const BINDING: Record<string, number> = {
  or: 1,
  "||": 1,
  and: 2,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
  "^": 7,
};

/** `^` is right-associative: `2^3^2` is 512, not 64. */
const RIGHT_ASSOC = new Set(["^"]);

const KEYWORD_OPS: Record<string, string> = { and: "and", or: "or" };

class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[], private readonly src: string) {}

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private next(): Token {
    return this.tokens[this.at++]!;
  }

  private expect(type: TokenType, text?: string): Token {
    const token = this.peek();
    if (token.type !== type || (text !== undefined && token.text !== text)) {
      throw new ExprError(
        `expected ${text ?? type} at position ${token.pos} in ${JSON.stringify(this.src)}`,
      );
    }
    return this.next();
  }

  /** The operator at the cursor, folding `and`/`or` written as words. */
  private operator(): string | null {
    const token = this.peek();
    if (token.type === "op") return own(BINDING, token.text) !== undefined ? token.text : null;
    if (token.type === "name") {
      return own(KEYWORD_OPS, token.text.toLowerCase()) ?? null;
    }
    return null;
  }

  parse(): Node {
    const node = this.expression(0);
    this.expect("eof");
    return node;
  }

  expression(minBinding: number): Node {
    let left = this.prefix();
    for (;;) {
      const op = this.operator();
      if (op === null) break;
      const binding = own(BINDING, op)!;
      if (binding < minBinding) break;
      this.next();
      const nextMin = RIGHT_ASSOC.has(op) ? binding : binding + 1;
      left = { kind: "binary", op, left, right: this.expression(nextMin) };
    }
    return left;
  }

  private prefix(): Node {
    const token = this.next();
    switch (token.type) {
      case "number":
        return { kind: "num", value: token.value! };
      case "(": {
        const inner = this.expression(0);
        this.expect(")");
        return inner;
      }
      case "op":
        if (token.text === "-") return { kind: "unary", op: "-", operand: this.expression(6) };
        if (token.text === "+") return this.expression(6);
        if (token.text === "!") return { kind: "unary", op: "not", operand: this.expression(6) };
        throw new ExprError(`unexpected ${token.text} at position ${token.pos}`);
      case "name": {
        const lower = token.text.toLowerCase();
        if (lower === "not") return { kind: "unary", op: "not", operand: this.expression(6) };
        if (this.peek().type === "(") {
          this.next();
          const args: Node[] = [];
          if (this.peek().type !== ")") {
            args.push(this.expression(0));
            while (this.peek().type === ",") {
              this.next();
              args.push(this.expression(0));
            }
          }
          this.expect(")");
          return { kind: "call", name: lower, args };
        }
        return { kind: "name", name: token.text };
      }
      default:
        throw new ExprError(`unexpected ${token.text || "end of expression"} at position ${token.pos}`);
    }
  }
}

export function parseExpr(src: string): Node {
  if (src.trim() === "") throw new ExprError("empty expression");
  return new Parser(tokenize(src), src).parse();
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Own properties only. `scope["__proto__"]`, `scope["constructor"]` and
 * `scope["toString"]` all resolve through Object.prototype on a plain object
 * literal, which would let an expression name something the author never put
 * in scope and get an object back instead of a number.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function asNumber(name: string, value: number | boolean): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number") throw new ExprError(`"${name}" is not a number`);
  return value;
}

export function evalNode(node: Node, scope: Scope = {}): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "name": {
      const direct = own(scope, node.name);
      if (direct !== undefined) return asNumber(node.name, direct);
      const lower = node.name.toLowerCase();
      const loose = own(scope, lower);
      if (loose !== undefined) return asNumber(node.name, loose);
      const constant = own(CONSTANTS, lower);
      if (constant !== undefined) return constant;
      throw new ExprError(`unknown name "${node.name}"`);
    }
    case "unary": {
      const operand = evalNode(node.operand, scope);
      return node.op === "-" ? -operand : operand === 0 ? 1 : 0;
    }
    case "binary": {
      const a = evalNode(node.left, scope);
      // `and` / `or` short-circuit, so `n > 0 and 10 / n > 2` is safe.
      if (node.op === "and" || node.op === "&&") {
        return a === 0 ? 0 : evalNode(node.right, scope) === 0 ? 0 : 1;
      }
      if (node.op === "or" || node.op === "||") {
        return a !== 0 ? 1 : evalNode(node.right, scope) !== 0 ? 1 : 0;
      }
      const b = evalNode(node.right, scope);
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "^":
          return a ** b;
        case "<":
          return a < b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
        case "==":
          return a === b ? 1 : 0;
        case "!=":
          return a !== b ? 1 : 0;
        default:
          throw new ExprError(`unknown operator "${node.op}"`);
      }
    }
    case "call": {
      const spec = own(FUNCTIONS, node.name);
      if (!spec) throw new ExprError(`unknown function "${node.name}"`);
      const [lo, hi] = Array.isArray(spec.arity) ? spec.arity : [spec.arity, spec.arity];
      if (node.args.length < lo || node.args.length > hi) {
        const want = lo === hi ? `${lo}` : `${lo} to ${hi}`;
        throw new ExprError(`${node.name}() takes ${want} arguments, got ${node.args.length}`);
      }
      return spec.fn(...node.args.map((arg) => evalNode(arg, scope)));
    }
  }
}

/** Parse and evaluate in one go. Throws `ExprError` with the reason. */
export function evaluate(src: string, scope: Scope = {}): number {
  return evalNode(parseExpr(src), scope);
}

/** A reusable evaluator, for sampling a curve over hundreds of points. */
export function compile(src: string): (scope?: Scope) => number {
  const ast = parseExpr(src);
  return (scope: Scope = {}) => evalNode(ast, scope);
}

/** Names the expression reads and does not define — what to bind to inputs. */
export function freeNames(src: string): string[] {
  const seen = new Set<string>();
  const walk = (node: Node) => {
    switch (node.kind) {
      case "name":
        if (own(CONSTANTS, node.name.toLowerCase()) === undefined) seen.add(node.name);
        break;
      case "unary":
        walk(node.operand);
        break;
      case "binary":
        walk(node.left);
        walk(node.right);
        break;
      case "call":
        node.args.forEach(walk);
        break;
      case "num":
        break;
    }
  };
  walk(parseExpr(src));
  return [...seen];
}

/** True / false rather than 1 / 0, for a predicate used as a filter. */
export function evaluateBool(src: string, scope: Scope = {}): boolean {
  return evaluate(src, scope) !== 0;
}
