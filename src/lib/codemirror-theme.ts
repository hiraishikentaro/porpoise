import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

/*
 * Porpoise の CodeMirror テーマ (GitHub Primer ベース)。
 * SQL トークンの色割り当ては design_system/Design System Dark.html セクション 02 に準拠:
 *   keyword  = pink   (#bc8cff / #8250df)
 *   function = accent (#2f81f7 / #0969da)
 *   string   = green  (#3fb950 / #1a7f37)
 *   number   = orange (#ffa657 / #bc4c00)
 *   comment  = muted  (#656d76 / #848d97)
 *   ident    = cyan   (#39c5cf / #1b7c83)
 */

export const primerDark = createTheme({
  theme: "dark",
  settings: {
    background: "#161b22",
    foreground: "#e6edf3",
    caret: "#2f81f7",
    selection: "rgba(47, 129, 247, 0.28)",
    selectionMatch: "rgba(47, 129, 247, 0.18)",
    lineHighlight: "rgba(240, 246, 252, 0.04)",
    gutterBackground: "#161b22",
    gutterForeground: "#656d76",
    gutterActiveForeground: "#e6edf3",
    gutterBorder: "rgba(240, 246, 252, 0.08)",
    fontFamily: "var(--font-mono)",
  },
  styles: [
    { tag: t.comment, color: "#656d76", fontStyle: "italic" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#bc8cff" },
    { tag: [t.string, t.special(t.string)], color: "#3fb950" },
    { tag: [t.number, t.bool, t.null], color: "#ffa657" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#2f81f7" },
    { tag: [t.variableName, t.propertyName, t.name], color: "#39c5cf" },
    { tag: t.typeName, color: "#ffa657" },
    { tag: t.operator, color: "#e6edf3" },
    { tag: t.punctuation, color: "#7d8590" },
    { tag: [t.bracket, t.paren, t.brace], color: "#e6edf3" },
    { tag: t.invalid, color: "#f85149" },
  ],
});

export const primerLight = createTheme({
  theme: "light",
  settings: {
    background: "#f6f8fa",
    foreground: "#0d1117",
    caret: "#0969da",
    selection: "rgba(9, 105, 218, 0.24)",
    selectionMatch: "rgba(9, 105, 218, 0.16)",
    lineHighlight: "rgba(31, 35, 40, 0.04)",
    gutterBackground: "#f6f8fa",
    gutterForeground: "#848d97",
    gutterActiveForeground: "#0d1117",
    gutterBorder: "rgba(31, 35, 40, 0.12)",
    fontFamily: "var(--font-mono)",
  },
  styles: [
    { tag: t.comment, color: "#848d97", fontStyle: "italic" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#8250df" },
    { tag: [t.string, t.special(t.string)], color: "#1a7f37" },
    { tag: [t.number, t.bool, t.null], color: "#bc4c00" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#0969da" },
    { tag: [t.variableName, t.propertyName, t.name], color: "#1b7c83" },
    { tag: t.typeName, color: "#bc4c00" },
    { tag: t.operator, color: "#0d1117" },
    { tag: t.punctuation, color: "#656d76" },
    { tag: [t.bracket, t.paren, t.brace], color: "#0d1117" },
    { tag: t.invalid, color: "#cf222e" },
  ],
});
