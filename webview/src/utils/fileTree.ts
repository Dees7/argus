import { FileEvent } from './fileActivity';

export type NodeStatus = 'dim' | 'read' | 'written' | 'deleted';
export type NodeKind = 'file' | 'dir' | 'root';

export interface TreeNode {
  name: string;
  /** Path relative to the tree anchor; '' for the root. Identity for diffing. */
  path: string;
  /** Absolute path — what the tooltip and the preview panel show. */
  abs: string;
  type: NodeKind;
  status: NodeStatus;
  revealedAt: number;
  readCount: number;
  writeCount: number;
  /** Step that created it during this session, or -1 if it predates it. */
  createdAt: number;
  /** Step that removed it, or -1 if it is still there. */
  deletedAt: number;
  agentTouched: boolean;
  /** Only ever named by a shell command — the path is a heuristic guess. */
  shellOnly: boolean;
  /** The session's working directory. */
  isCwd: boolean;
  /** Last body the transcript carries — the only way to read a deleted file. */
  content?: string;
  children?: TreeNode[];
}

export const hasActivity = (n: TreeNode): boolean =>
  n.readCount > 0 || n.writeCount > 0 || n.createdAt >= 0 || n.deletedAt >= 0;

const statusOf = (n: TreeNode): NodeStatus => {
  if (n.deletedAt >= 0) return 'deleted';
  if (n.writeCount > 0) return 'written';
  if (n.readCount > 0) return 'read';
  return 'dim';
};

/**
 * Fold `a → b → c` chains of untouched single-child folders into one `a/b/c`
 * card. A tree anchored above the cwd (a session that edited `~/.claude` or
 * `/tmp`) otherwise spends four levels of canvas walking down to the first
 * interesting directory.
 */
export const collapseChains = (node: TreeNode): TreeNode => {
  if (!node.children || node.children.length === 0) return node;
  node.children = node.children.map((child) => {
    let cur = child;
    const parts = [child.name];
    while (
      cur.type === 'dir' &&
      !cur.isCwd &&
      !hasActivity(cur) &&
      cur.children &&
      cur.children.length === 1 &&
      cur.children[0].type === 'dir' &&
      !cur.children[0].isCwd
    ) {
      cur = cur.children[0];
      parts.push(cur.name);
    }
    const merged = cur === child ? child : { ...cur, name: parts.join('/') };
    return collapseChains(merged);
  });
  return node;
};

export interface BuildTreeParams {
  events: FileEvent[];
  /** Directory the tree is rooted at — see `commonAncestor`. */
  anchor: string;
  /** Absolute working directory, or '' when the session never reported one. */
  cwd: string;
  /** Top-level entries of the cwd, seeded only when `showAllFolders` is on. */
  topLevelEntries: Array<{ name: string; type: 'file' | 'dir' }>;
  showAllFolders: boolean;
  /** Events at or after this step are still in the future. */
  currentStep: number;
}

export interface BuiltTree {
  root: TreeNode;
  /** Path of the last node an applied event touched — the camera follows it. */
  lastRevealedPath: string;
  lastAppliedStep: number;
}

/**
 * The file tree as of `currentStep`: only what the session actually touched,
 * plus the folders leading to it. Untouched project folders are not part of
 * the story a session tells and are left out unless asked for — they used to
 * fill the canvas while the files that were edited had no node at all.
 */
export const buildFileTree = ({
  events,
  anchor,
  cwd,
  topLevelEntries,
  showAllFolders,
  currentStep,
}: BuildTreeParams): BuiltTree => {
  // '/' is a real anchor (a session that touched both `/Users/…` and `/tmp`),
  // so it must survive the trailing-slash trim that every other path gets.
  const anchorNorm = anchor === '/' ? '/' : anchor.replace(/\/+$/, '');
  const relOf = (abs: string): string => {
    if (abs === anchorNorm) return '';
    if (anchorNorm && anchorNorm !== '/' && abs.startsWith(anchorNorm + '/')) {
      return abs.slice(anchorNorm.length + 1);
    }
    if (anchorNorm === '/') return abs.replace(/^\//, '');
    return '';
  };
  const rootName =
    !anchorNorm || anchorNorm === '/'
      ? '/'
      : anchorNorm.split('/').filter(Boolean).pop() || anchorNorm;

  const newNode = (name: string, path: string, type: NodeKind): TreeNode => ({
    name,
    path,
    abs: path ? `${anchorNorm === '/' ? '' : anchorNorm}/${path}` : anchorNorm,
    type,
    status: 'dim',
    revealedAt: -1,
    readCount: 0,
    writeCount: 0,
    createdAt: -1,
    deletedAt: -1,
    agentTouched: false,
    shellOnly: true,
    isCwd: false,
    children: type === 'file' ? undefined : [],
  });

  const rootNode = newNode(rootName, '', 'root');
  rootNode.isCwd = !!cwd && anchorNorm === cwd;
  const map = new Map<string, TreeNode>();
  map.set('', rootNode);

  /** Node for a path, creating the folders above it on the way down. */
  const ensure = (rel: string, type: NodeKind, revealedAt: number): TreeNode | null => {
    const segments = rel.split('/').filter(Boolean);
    let node: TreeNode = rootNode;
    let acc = '';
    for (let i = 0; i < segments.length; i++) {
      const parentPath = acc;
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      const isLast = i === segments.length - 1;
      let existing = map.get(acc);
      if (!existing) {
        const parent = map.get(parentPath);
        if (!parent) return null;
        if (!parent.children) parent.children = [];
        existing = newNode(segments[i], acc, isLast ? type : 'dir');
        existing.revealedAt = revealedAt;
        parent.children.push(existing);
        map.set(acc, existing);
      } else if (!isLast || type === 'dir') {
        // A path first seen as a file turned out to hold children.
        if (existing.type === 'file') {
          existing.type = 'dir';
          existing.children = existing.children ?? [];
        }
      }
      node = existing;
    }
    return node;
  };

  // The cwd is always on the map, even when the session never touched anything
  // inside it — "the project is here, the work happened over there" is worth
  // seeing rather than hiding.
  const cwdRel = cwd ? relOf(cwd) : '';
  if (cwdRel) {
    const cwdNode = ensure(cwdRel, 'dir', -1);
    if (cwdNode) cwdNode.isCwd = true;
  }

  if (showAllFolders) {
    for (const entry of topLevelEntries) {
      if (entry.type !== 'dir') continue;
      ensure(cwdRel ? `${cwdRel}/${entry.name}` : entry.name, 'dir', -1);
    }
  }

  let lastRevealedPath = '';
  let lastAppliedStep = -1;
  for (const ev of events) {
    if (ev.stepIndex >= currentStep) break;
    const rel = relOf(ev.path);
    if (!rel) continue;
    const node = ensure(rel, ev.isDir ? 'dir' : 'file', ev.stepIndex);
    if (!node) continue;

    if (ev.kind === 'read') {
      node.readCount += 1;
    } else if (ev.kind === 'delete') {
      // `rm -r` takes the whole subtree with it; a file written back
      // afterwards clears its own flag when that event comes around.
      const markDeleted = (n: TreeNode) => {
        n.deletedAt = ev.stepIndex;
        n.children?.forEach(markDeleted);
      };
      markDeleted(node);
    } else {
      node.writeCount += 1;
      // A file written after it was removed is back.
      node.deletedAt = -1;
      if (ev.kind === 'create' && node.createdAt < 0) node.createdAt = ev.stepIndex;
      if (ev.content) node.content = ev.content;
    }
    if (node.revealedAt < 0) node.revealedAt = ev.stepIndex;
    if (ev.agentId) node.agentTouched = true;
    if (ev.source === 'tool') node.shellOnly = false;
    lastRevealedPath = node.path;
    lastAppliedStep = ev.stepIndex;
  }

  for (const node of map.values()) node.status = statusOf(node);

  const sortChildren = (n: TreeNode) => {
    n.children?.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children?.forEach(sortChildren);
  };
  sortChildren(rootNode);

  return { root: collapseChains(rootNode), lastRevealedPath, lastAppliedStep };
};
