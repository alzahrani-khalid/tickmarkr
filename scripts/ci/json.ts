// v2.7.8 T1 — the CLOSED INPUT strict JSON reader (specs/v2.7.8-sharded-ci.spec.md preamble).
// JSON.parse silently keeps the LAST duplicate key, so a doctored document could rewrite a counter
// in place; this tokenizer rejects a key repeated within one object and every malformed document.
// Library law (SHARED CONVENTIONS): these readers never exit and never print verdicts — they throw
// the named errors below and their CLI callers map those to verdict=UNREADABLE.
export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonError";
  }
}

export class JsonSyntaxError extends JsonError {
  constructor(at: number, why: string) {
    super(`JSON syntax error at offset ${at}: ${why}`);
    this.name = "JsonSyntaxError";
  }
}

export class JsonDuplicateKeyError extends JsonError {
  constructor(key: string) {
    super(`JSON object repeats key ${JSON.stringify(key)}`);
    this.name = "JsonDuplicateKeyError";
  }
}

const MAX_DEPTH = 512;
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const hexValue = (ch: string): number => {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
};

class Scanner {
  private pos = 0;
  constructor(private readonly text: string) {}

  peek(): string | undefined {
    return this.text[this.pos];
  }

  /** Consume `ch` or throw naming the offset — every structural token goes through here. */
  expect(ch: string): void {
    if (this.text[this.pos] !== ch) throw new JsonSyntaxError(this.pos, `expected ${JSON.stringify(ch)}`);
    this.pos++;
  }

  skipWs(): void {
    for (let ch = this.text[this.pos]; ch === " " || ch === "\t" || ch === "\n" || ch === "\r"; ch = this.text[this.pos]) this.pos++;
  }

  /** Offset of the next unconsumed character — error messages cite it. */
  position(): number {
    return this.pos;
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.text.length;
  }

  parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new JsonSyntaxError(this.pos, `nesting deeper than ${MAX_DEPTH}`);
    this.skipWs();
    const ch = this.peek();
    if (ch === "{") return this.parseObject(depth);
    if (ch === "[") return this.parseArray(depth);
    if (ch === '"') return this.parseString();
    if (ch === "-" || isDigit(ch)) return this.parseNumber();
    for (const literal of ["true", "false", "null"] as const) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return literal === "true" ? true : literal === "false" ? false : null;
      }
    }
    throw new JsonSyntaxError(this.pos, `unexpected character ${JSON.stringify(ch ?? "end of document")}`);
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.expect("{");
    // Null-prototype record (CLOSED INPUT, prototype-sensitive dictionaries): assigning a
    // "__proto__" key on an Object.prototype-backed record rewrites the prototype instead of
    // recording data — dodging duplicate-key detection and hiding the key from Object.entries —
    // and inherited members would answer lookups for keys the document never wrote. On a record
    // with no prototype every JSON key, "__proto__" included, is ordinary own data.
    const out: Record<string, unknown> = Object.create(null);
    this.skipWs();
    if (this.peek() === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWs();
      const key = this.parseString();
      if (Object.hasOwn(out, key)) throw new JsonDuplicateKeyError(key);
      this.skipWs();
      this.expect(":");
      out[key] = this.parseValue(depth + 1);
      this.skipWs();
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "}") {
        this.pos++;
        return out;
      }
      throw new JsonSyntaxError(this.pos, `expected "," or "}" after object member`);
    }
  }

  private parseArray(depth: number): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    this.skipWs();
    if (this.peek() === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue(depth + 1));
      this.skipWs();
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "]") {
        this.pos++;
        return out;
      }
      throw new JsonSyntaxError(this.pos, `expected "," or "]" after array element`);
    }
  }

  parseString(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new JsonSyntaxError(this.pos, "unterminated string");
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch.charCodeAt(0) < 0x20) throw new JsonSyntaxError(this.pos, "raw control character in string");
      if (ch === "\\") {
        this.pos++;
        const esc = this.text[this.pos];
        if (esc === undefined) throw new JsonSyntaxError(this.pos, "unterminated escape");
        if (esc === "u") {
          this.pos++;
          let code = 0;
          for (let i = 0; i < 4; i++) {
            const digit = hexValue(this.text[this.pos]);
            if (digit < 0) throw new JsonSyntaxError(this.pos, "invalid \\u escape");
            code = code * 16 + digit;
            this.pos++;
          }
          out += String.fromCharCode(code);
          continue;
        }
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        const mapped = simple[esc];
        if (mapped === undefined) throw new JsonSyntaxError(this.pos, `invalid escape ${JSON.stringify(esc)}`);
        out += mapped;
        this.pos++;
        continue;
      }
      out += ch;
      this.pos++;
    }
  }

  parseNumber(): number {
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    if (this.peek() === "0") {
      this.pos++;
    } else if (isDigit(this.peek())) {
      while (isDigit(this.text[this.pos])) this.pos++;
    } else {
      throw new JsonSyntaxError(this.pos, "invalid number");
    }
    if (this.peek() === ".") {
      this.pos++;
      if (!isDigit(this.peek())) throw new JsonSyntaxError(this.pos, "digit required after decimal point");
      while (isDigit(this.text[this.pos])) this.pos++;
    }
    const exp = this.peek();
    if (exp === "e" || exp === "E") {
      this.pos++;
      const sign = this.peek();
      if (sign === "+" || sign === "-") this.pos++;
      if (!isDigit(this.peek())) throw new JsonSyntaxError(this.pos, "digit required in exponent");
      while (isDigit(this.text[this.pos])) this.pos++;
    }
    const text = this.text.slice(start, this.pos);
    const value = Number(text);
    if (!Number.isFinite(value)) throw new JsonSyntaxError(start, `number ${text} is not finite`);
    return value;
  }
}

/** Parse `text` rejecting malformed documents and any key repeated within one object. */
export function readJson(text: string): unknown {
  const scanner = new Scanner(text);
  const value = scanner.parseValue(0);
  if (!scanner.atEnd()) throw new JsonSyntaxError(scanner.position(), "trailing content after the top-level value");
  return value;
}

/**
 * The one canonical record guard for scripts/ci traversal of parsed JSON and config modules
 * (fields stay `unknown` — each reader validates what it consumes). Shared, never redefined.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const jsonLine = (value: unknown): string =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
