// Rewards design language — CodeMirror 6 theme factory.
//
// Every value is a CSS var()/color-mix() reference into the design tokens
// (see theme.css), so switching light/dark restyles the editor with no
// rebuild and no JS-side color plumbing. The only token-aware bit is the
// `{ dark }` flag, which tells CodeMirror how to blend its own defaults.
//
// Deps: @codemirror/view, @codemirror/language, @lezer/highlight (all ship
// with the `codemirror` package). Works with plain CodeMirror or the
// @uiw/react-codemirror wrapper.
//
// Usage:
//   import { editorTheme } from "./codemirror-theme";
//   <CodeMirror extensions={[...languageFor(name), ...editorTheme({ dark })]} ... />
//   // or without the wrapper: new EditorView({ extensions: editorTheme(), ... })

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export interface EditorThemeOptions {
  /** Set when the current design theme is dark — improves CM's built-in
   * blending (selection contrast, panel defaults). Read it from the same
   * place you set `<html data-theme>`. */
  dark?: boolean;
}

/** The full extension set: chrome theme + syntax highlighting. */
export function editorTheme({ dark = false }: EditorThemeOptions = {}) {
  return [editorChrome({ dark }), syntaxHighlighting(rewardsHighlight)];
}

// Chrome — surfaces, gutters, cursor, selection, tooltips, placeholders.
function editorChrome({ dark }: { dark: boolean }) {
  return EditorView.theme(
    {
      // The editor shares the WINDOW surface (paper), and gutters below use
      // paper too — gutter and code must read as one uniform plane. Put it
      // inside a `rounded-lg border border-line overflow-hidden` wrapper (or
      // flush in the pane).
      "&": {
        backgroundColor: "var(--color-paper)",
        color: "var(--color-ink)",
        fontSize: "12px",
      },
      "&.cm-focused": { outline: "none" },

      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
        scrollbarWidth: "thin",
      },

      // Breathing room: air above/below the code, wider gap after the gutter.
      ".cm-content": {
        caretColor: "var(--color-accent)",
        padding: "8px 0 12px 0",
      },
      ".cm-line": { padding: "0 12px 0 12px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },

      // Selection = sky at 35%, matching ::selection and the terminal.
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in srgb, var(--color-sky) 35%, transparent)" },

      // Gutters sit on paper, numbers stay mute; the active line lights ink-2.
      ".cm-gutters": {
        backgroundColor: "var(--color-paper)",
        color: "var(--color-mute)",
        border: "none",
        borderRight: "1px solid var(--color-line-soft)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--color-sunken) 55%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--color-ink-2)",
        fontWeight: "500",
      },

      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--color-sky) 25%, transparent)",
        outline: "none",
        color: "inherit",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in srgb, var(--color-sky) 18%, transparent)",
      },

      ".cm-tooltip": {
        backgroundColor: "var(--color-panel)",
        border: "1px solid var(--color-line)",
        borderRadius: "6px",
        overflow: "hidden",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        maxHeight: "14em",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--color-sunken)",
        color: "var(--color-ink)",
      },

      ".cm-placeholder": { color: "var(--color-mute)" },

      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--color-sky) 30%, transparent)",
        outline: "none",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--color-sky) 55%, transparent)",
      },

      ".cm-foldPlaceholder": {
        backgroundColor: "var(--color-sunken)",
        border: "1px solid var(--color-line-soft)",
        color: "var(--color-mute)",
        borderRadius: "3px",
        padding: "0 5px",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-paper)",
        color: "var(--color-ink)",
        borderTop: "1px solid var(--color-line)",
        borderBottom: "1px solid var(--color-line)",
      },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        font: "inherit",
        fontSize: "12px",
      },
    },
    { dark },
  );
}

// Syntax — mapped onto the token ramp so highlighting stays on-language:
// keywords/links blue (accent), strings green (good), comments mute italic,
// numbers/atoms the warn gold, functions/types cyan (accent-2), invalid bad.
const rewardsHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--color-accent)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--color-good)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--color-mute)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "var(--color-warn)" },
  { tag: [t.regexp, t.escape], color: "var(--color-accent-2)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--color-accent-2)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--color-accent-2)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--color-ink)", fontWeight: "500" },
  { tag: [t.variableName, t.propertyName], color: "var(--color-ink)" },
  { tag: [t.self, t.standard(t.variableName)], color: "var(--color-ink-2)", fontStyle: "italic" },
  { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: "var(--color-ink-3)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--color-ink-3)" },
  { tag: [t.tagName], color: "var(--color-accent)" },
  { tag: [t.attributeName], color: "var(--color-ink-2)" },
  { tag: [t.attributeValue], color: "var(--color-good)" },
  { tag: [t.annotation, t.meta], color: "var(--color-mute)" },

  // Markdown
  { tag: t.heading, color: "var(--color-ink)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600", color: "var(--color-ink-2)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--color-accent)", textDecoration: "none" },
  { tag: t.url, color: "var(--color-mute)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--color-ink-2)" },
  { tag: t.quote, color: "var(--color-ink-3)" },
  { tag: t.list, color: "var(--color-mute)" },

  { tag: t.invalid, color: "var(--color-bad)", textDecoration: "underline" },
]);
