import { type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

/**
 * 軽量な MySQL 向け構文チェッカ。サーバ実行前に検知できる明らかなミスを拾う:
 *  - クォート ('/"/`) の閉じ忘れ
 *  - 括弧 ( / ) のアンバランス
 *  - ブロックコメント /* *\/ の閉じ忘れ
 *
 * フルパーサでは無く 1 パスのトークナイザなので誤検知は覚悟の上。
 * (SQL 文法全体を理解するのはサーバに任せる方針)
 */
function lintDoc(doc: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;
  let quoteStart = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let blockCommentStart = 0;
  type ParenFrame = { pos: number };
  const parenStack: ParenFrame[] = [];

  while (i < doc.length) {
    const ch = doc[i];
    const next = doc[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (ch === "\\" && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      blockCommentStart = i;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      quoteStart = i;
      i++;
      continue;
    }
    if (ch === "(") {
      parenStack.push({ pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      if (parenStack.length === 0) {
        out.push({
          from: i,
          to: i + 1,
          severity: "error",
          message: "Unmatched ')'",
        });
      } else {
        parenStack.pop();
      }
      i++;
      continue;
    }
    i++;
  }

  if (quote) {
    out.push({
      from: quoteStart,
      to: Math.min(quoteStart + 1, doc.length),
      severity: "error",
      message: `Unterminated ${quote === "`" ? "identifier quote" : "string literal"} (${quote})`,
    });
  }
  if (inBlockComment) {
    out.push({
      from: blockCommentStart,
      to: Math.min(blockCommentStart + 2, doc.length),
      severity: "error",
      message: "Unterminated block comment (missing */)",
    });
  }
  for (const frame of parenStack) {
    out.push({
      from: frame.pos,
      to: frame.pos + 1,
      severity: "error",
      message: "Unmatched '('",
    });
  }

  return out;
}

export function sqlLinter() {
  return linter((view: EditorView) => lintDoc(view.state.doc.toString()), {
    delay: 300,
  });
}
