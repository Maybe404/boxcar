// The look of the JSON editors: the profile's, and the views beside it.
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-content": { fontFamily: "var(--mono)", padding: "12px 0", caretColor: "var(--line)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-3)", border: "none", paddingLeft: "12px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--line-soft) !important" },
  ".cm-cursor": { borderLeftColor: "var(--line)", borderLeftWidth: "2px" },
  ".cm-matchingBracket": { backgroundColor: "var(--line-soft)", outline: "none" },
  ".cm-foldGutter span": { color: "var(--text-3)" },
  ".cm-scroller": { lineHeight: "1.65" },
});

export const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--text)", fontWeight: "600" },
  { tag: tags.string, color: "var(--text-2)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--line)" },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: "var(--text-3)" },
  { tag: tags.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--danger)" },
]);
