import * as vscode from 'vscode';

/**
 * A plan as the user saw it at one ExitPlanMode step, opened in a regular
 * editor with the user's comments pinned to their lines.
 *
 * The plan file on disk is rewritten on every round of planning, so after the
 * agent revises the plan it no longer holds the text the comments were left
 * on. The snapshot is served from memory under its own scheme instead — a
 * read-only document the editor treats like any other markdown file — and the
 * comments go on it through VS Code's own comment threads, the same widget a
 * pull-request review uses. The lines each comment is about get a background
 * of their own too, so they stand out while the thread is folded.
 */

const SCHEME = 'argus-plan';

export interface PlanSnapshotComment {
  quote: string;
  text: string;
  /** 1-based, inclusive; absent when the quote was not found in the plan. */
  lines?: { start: number; end: number };
}

export class PlanSnapshots implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly threads = new Map<string, vscode.CommentThread[]>();
  private readonly ranges = new Map<string, vscode.Range[]>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  private readonly controller = vscode.comments.createCommentController('argus.planComments', 'Plan comments');
  private readonly lineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      this.controller,
      this.lineDecoration,
      this.changed,
      // Decorations belong to an editor, not a document: a snapshot shown
      // again after its tab was switched away needs them put back.
      vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => this.decorate(e)))
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /**
   * Open one step's plan. The same step opened twice lands on the same
   * document, its threads replaced rather than stacked.
   */
  async open(plan: string, fileName: string, label: string, comments: PlanSnapshotComment[]): Promise<void> {
    const base = fileName.replace(/\.md$/i, '');
    // The label goes into the file name so the tab says which round it is;
    // the query keeps two sessions' plans of the same name apart.
    const name = label ? `${base} (${label}).md` : `${base}.md`;
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${name}`, query: hash(plan) });
    const key = uri.toString();

    this.contents.set(key, plan);
    this.changed.fire(uri);

    const lineCount = plan.split('\n').length;
    const rangeOf = (c: PlanSnapshotComment): vscode.Range => {
      if (!c.lines) return new vscode.Range(0, 0, 0, 0);
      const start = Math.min(Math.max(c.lines.start - 1, 0), lineCount - 1);
      const end = Math.min(Math.max(c.lines.end - 1, start), lineCount - 1);
      return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
    };

    this.threads.get(key)?.forEach(t => t.dispose());
    const threads = comments.map((c, i) => {
      const body = new vscode.MarkdownString();
      if (c.quote) body.appendMarkdown(`> ${escapeMd(c.quote)}\n\n`);
      if (c.quote && !c.lines) body.appendMarkdown(`_Passage not found in the plan._\n\n`);
      body.appendText(c.text);
      const thread = this.controller.createCommentThread(uri, rangeOf(c), [
        { body, mode: vscode.CommentMode.Preview, author: { name: 'User' } },
      ]);
      thread.label = `#${i + 1}`;
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return thread;
    });
    this.threads.set(key, threads);
    this.ranges.set(key, comments.filter(c => c.lines).map(rangeOf));

    const doc = await vscode.workspace.openTextDocument(uri);
    const first = comments.find(c => c.lines);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      selection: first ? new vscode.Range(first.lines!.start - 1, 0, first.lines!.start - 1, 0) : undefined,
    });
    this.decorate(editor);
  }

  private decorate(editor: vscode.TextEditor): void {
    const ranges = this.ranges.get(editor.document.uri.toString());
    if (ranges) editor.setDecorations(this.lineDecoration, ranges);
  }

  dispose(): void {
    this.threads.forEach(list => list.forEach(t => t.dispose()));
    this.disposables.forEach(d => d.dispose());
  }
}

const escapeMd = (s: string): string => s.replace(/\s+/g, ' ').replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');

/** Short stable id of a plan's text — FNV-1a, enough to tell snapshots apart. */
const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};
