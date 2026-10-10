import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { cn } from "@kw/lib/cn";
import type { EditorSlashCommandConfig } from "@kw/lib/editorSlashCommands";
import { markdownEditorExtensions } from "./markdownLanguage";
import { markdownEditorTheme } from "./markdownEditorTheme";
import { customSlashCompletionSource, slashCompletionSource } from "./markdownSlashCommands";
import {
  wikiLinkCompletionSource,
  type WikiPage,
} from "./wikiLinkCompletion";
import { fenceCompletion, fencePreviewAt, type FencePreviewTarget } from "./fenceAssist";

export type MarkdownSourceEditorProps = {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  dark?: boolean;
  minHeight?: string;
  className?: string;
  onSaveShortcut?: () => void;
  pages?: WikiPage[];
  customSlashCommands?: EditorSlashCommandConfig[];
  loadSlashTemplate?: (templatePath: string) => Promise<string>;
  onSlashTemplateError?: (message: string) => void;
  /**
   * Fires with the widget fence the caret is in, or null. A source-mode pane
   * can render it live, so an author editing YAML can see the picture.
   */
  onFenceUnderCursor?: (fence: FencePreviewTarget | null) => void;
};

export function MarkdownSourceEditor({
  value,
  onChange,
  readOnly = false,
  dark = false,
  minHeight = "60vh",
  className,
  onSaveShortcut,
  pages = [],
  customSlashCommands = [],
  loadSlashTemplate,
  onSlashTemplateError,
  onFenceUnderCursor,
}: MarkdownSourceEditorProps) {
  const extensions = useMemo(() => {
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveShortcut?.();
          return true;
        },
      },
    ]);

    // Fence keys come before the slash menu: inside a widget body an author
    // wants `activeIndices`, not `/table`.
    const completionSources: CompletionSource[] = [fenceCompletion, slashCompletionSource];
    if (customSlashCommands.length > 0 && loadSlashTemplate && onSlashTemplateError) {
      completionSources.push(
        customSlashCompletionSource(customSlashCommands, loadSlashTemplate, onSlashTemplateError),
      );
    }
    if (pages.length > 0) {
      completionSources.push(wikiLinkCompletionSource(pages));
    }

    const exts: Extension[] = [
      history(),
      ...markdownEditorExtensions(),
      highlightSelectionMatches(),
      autocompletion({
        override: completionSources,
        activateOnTyping: true,
        closeOnBlur: true,
      }),
      EditorView.contentAttributes.of({
        "aria-label": "Markdown source editor",
        "aria-multiline": "true",
      }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      saveKeymap,
    ];

    if (onFenceUnderCursor) {
      exts.push(
        EditorView.updateListener.of((update) => {
          if (!update.docChanged && !update.selectionSet) return;
          const pos = update.state.selection.main.head;
          onFenceUnderCursor(fencePreviewAt(update.state, pos));
        }),
      );
    }
    return exts;
  }, [
    onSaveShortcut,
    pages,
    customSlashCommands,
    loadSlashTemplate,
    onSlashTemplateError,
    onFenceUnderCursor,
  ]);

  const theme = useMemo(() => markdownEditorTheme({ dark }), [dark]);

  return (
    <div className={cn("overflow-hidden rounded-md border bg-background shadow-sm", className)} data-testid="markdown-source-editor">
      <CodeMirror
        value={value}
        height="auto"
        minHeight={minHeight}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightSelectionMatches: false,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
          defaultKeymap: false,
          history: false,
          searchKeymap: false,
        }}
        editable={!readOnly}
        readOnly={readOnly}
        theme={theme}
        extensions={extensions}
        onChange={onChange}
      />
    </div>
  );
}
