import * as fs from 'fs';
import * as path from 'path';

/** One sub-agent transcript on disk. */
export interface SubagentTranscript {
  /** Canonical id: the file name without its `agent-` prefix. */
  agentId: string;
  filePath: string;
  /** `meta.json` written next to the transcript; may not exist. */
  metaPath: string;
  /** Set when a `Workflow` run spawned the agent — the `wf_…` directory. */
  workflowRunId?: string;
}

/** `<projectDir>/<sessionId>/subagents/` — where Claude Code writes agents. */
export function subagentsDirOf(projectDir: string, sessionId: string): string {
  return path.join(projectDir, sessionId, 'subagents');
}

/**
 * Every sub-agent transcript of a session. Agents spawned with `Agent`/`Task`
 * sit directly in `subagents/`; agents a `Workflow` script ran sit one level
 * down, in `subagents/workflows/<runId>/`, next to that run's `journal.jsonl`
 * (which is not a transcript and is skipped).
 */
export function listSubagentTranscripts(projectDir: string, sessionId: string): SubagentTranscript[] {
  const root = subagentsDirOf(projectDir, sessionId);
  const out: SubagentTranscript[] = [];

  const collect = (dir: string, workflowRunId?: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name === 'journal.jsonl') continue;
      // Filenames carry an `agent-` prefix that the JSONL contents and the
      // spawning tool's `toolUseResult.agentId` do not. Strip it so the
      // canonical id matches across all three sources.
      const agentId = e.name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      out.push({
        agentId,
        filePath: path.join(dir, e.name),
        metaPath: path.join(dir, `agent-${agentId}.meta.json`),
        workflowRunId,
      });
    }
  };

  collect(root);

  const workflowsDir = path.join(root, 'workflows');
  let runs: fs.Dirent[] = [];
  try {
    runs = fs.readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    // no workflow ever ran in this session
  }
  for (const run of runs) {
    if (run.isDirectory()) collect(path.join(workflowsDir, run.name), run.name);
  }

  return out;
}
