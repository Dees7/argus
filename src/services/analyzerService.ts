import {
  Step,
  AnalysisResult,
  Finding,
  Severity,
  StepCost,
  StepDependency,
  ContextMetrics,
  SessionDetail,
} from '../types/models';
import { oncePerResponse } from '../types/usage';

export interface AnalysisOptions {
  /**
   * Report a compaction only where the transcript actually marks one
   * (`isCompactSummary`), instead of inferring it from a token drop. The
   * heuristic also fires on ordinary prompt-cache rotation — a step whose
   * prompt had to be rewritten into the cache looks exactly like a context
   * reset when measured as `input + cache_creation`.
   */
  realCompactsOnly?: boolean;
}

export interface AnalysisRule {
  name: string;
  analyze(steps: Step[], options?: AnalysisOptions): Finding[];
}

export class AnalyzerService {
  private rules: AnalysisRule[] = [];

  constructor() {
    // Register analysis rules
    this.rules = [
      new DuplicateReadRule(),
      new UnusedReadRule(),
      new RetryLoopRule(),
      new FailedToolRule(),
      new ContextPressureRule(),
      new CompactionDetectedRule(),
    ];
  }

  /**
   * Analyze a session and return findings
   */
  analyze(
    session: SessionDetail,
    options: AnalysisOptions = {},
    lang: string = 'en'
  ): AnalysisResult {
    const result: AnalysisResult = {
      findings: [],
      totalCost: session.totalCost,
      wastedCost: 0,
      efficiency: 100,
      stepCosts: [],
    };

    // Run each rule
    for (const rule of this.rules) {
      const findings = rule.analyze(session.steps, options);
      result.findings.push(...findings);
    }

    // Build dependencies
    result.dependencies = this.buildDependencies(session.steps);

    // Compute context metrics
    result.contextMetrics = this.computeContextMetrics(session.steps, result);

    // Calculate step costs
    for (const step of session.steps) {
      result.stepCosts.push({
        stepIndex: step.index,
        cost: step.cost,
      });
    }

    // Sum wasted cost
    for (const finding of result.findings) {
      result.wastedCost += finding.wastedCost;
    }

    // Calculate efficiency
    if (result.totalCost > 0) {
      result.efficiency = ((result.totalCost - result.wastedCost) / result.totalCost) * 100;
    }

    return result;
  }

  private buildDependencies(steps: Step[]): StepDependency[] {
    const dependencies: StepDependency[] = [];
    const fileOperations = new Map<string, { read: number[]; write: number[]; edit: number[] }>();

    // Collect all file operations
    for (const step of steps) {
      if (step.type !== 'tool_call' || !step.toolName) {
        continue;
      }

      let filePath: string | undefined;

      if (step.toolName === 'Read' && step.toolInput?.file_path) {
        filePath = step.toolInput.file_path;
        if (!filePath) continue;
        if (!fileOperations.has(filePath)) {
          fileOperations.set(filePath, { read: [], write: [], edit: [] });
        }
        fileOperations.get(filePath)!.read.push(step.index);
      } else if (step.toolName === 'Write' && step.toolInput?.file_path) {
        filePath = step.toolInput.file_path;
        if (!filePath) continue;
        if (!fileOperations.has(filePath)) {
          fileOperations.set(filePath, { read: [], write: [], edit: [] });
        }
        fileOperations.get(filePath)!.write.push(step.index);
      } else if (step.toolName === 'Edit' && step.toolInput?.file_path) {
        filePath = step.toolInput.file_path;
        if (!filePath) continue;
        if (!fileOperations.has(filePath)) {
          fileOperations.set(filePath, { read: [], write: [], edit: [] });
        }
        fileOperations.get(filePath)!.edit.push(step.index);
      }
    }

    // Build dependencies
    for (const [filePath, ops] of fileOperations) {
      // Read -> Edit/Write dependencies
      for (const readIdx of ops.read) {
        for (const editIdx of ops.edit) {
          if (editIdx > readIdx) {
            dependencies.push({
              fromStep: readIdx,
              toStep: editIdx,
              filePath,
              type: 'read-edit',
            });
          }
        }
        for (const writeIdx of ops.write) {
          if (writeIdx > readIdx) {
            dependencies.push({
              fromStep: readIdx,
              toStep: writeIdx,
              filePath,
              type: 'read-write',
            });
          }
        }
      }
    }

    return dependencies;
  }

  private computeContextMetrics(steps: Step[], result: AnalysisResult): ContextMetrics | undefined {
    const metrics: ContextMetrics = {
      peakInputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreation: 0,
      cacheHitRatio: 0,
      compactionCount: 0,
      avgTokensPerStep: 0,
      tokenBurnRate: 0,
      contextPressureZones: [],
      compactionPoints: [],
    };

    // One entry per API response rather than per step: `usage` repeats across
    // every step a response produced, so walking `steps` counts it twice.
    const responses = oncePerResponse(steps);

    for (const step of responses) {
      const usage = step.usage!;
      const inputTokens = usage.input_tokens + usage.cache_creation_input_tokens;

      metrics.totalInputTokens += usage.input_tokens;
      metrics.totalOutputTokens += usage.output_tokens;
      metrics.totalCacheRead += usage.cache_read_input_tokens;
      metrics.totalCacheCreation += usage.cache_creation_input_tokens;

      if (inputTokens > metrics.peakInputTokens) {
        metrics.peakInputTokens = inputTokens;
      }
    }

    if (responses.length === 0) {
      return undefined;
    }

    // Divided by the response count to match the numerator — per-response
    // totals over a per-step count would mix the two.
    metrics.avgTokensPerStep = Math.floor(
      (metrics.totalInputTokens + metrics.totalCacheCreation) / responses.length
    );

    const totalAll = metrics.totalInputTokens + metrics.totalCacheRead + metrics.totalCacheCreation;
    if (totalAll > 0) {
      metrics.cacheHitRatio = metrics.totalCacheRead / totalAll;
    }

    metrics.tokenBurnRate = metrics.totalOutputTokens / responses.length;

    // Extract pressure zones and compaction points from findings
    for (const finding of result.findings) {
      if (finding.rule === 'context_pressure') {
        metrics.contextPressureZones.push(...finding.steps);
      } else if (finding.rule === 'compaction_detected') {
        if (finding.steps.length > 0) {
          metrics.compactionPoints.push(finding.steps[0]);
          metrics.compactionCount++;
        }
      }
    }

    return metrics;
  }
}

// Analysis Rules

class DuplicateReadRule implements AnalysisRule {
  name = 'duplicate_read';

  analyze(steps: Step[]): Finding[] {
    const fileReads = new Map<string, { indices: number[]; cost: number }>();

    for (const step of steps) {
      if (step.type !== 'tool_call' || step.toolName !== 'Read') {
        continue;
      }

      const filePath = step.toolInput?.file_path;
      if (!filePath) {
        continue;
      }

      if (!fileReads.has(filePath)) {
        fileReads.set(filePath, { indices: [], cost: 0 });
      }

      const entry = fileReads.get(filePath)!;
      entry.indices.push(step.index);
      entry.cost += step.cost;
    }

    const findings: Finding[] = [];
    const duplicates: string[] = [];
    const allSteps: number[] = [];
    let totalWasted = 0;

    for (const [filePath, entry] of fileReads) {
      if (entry.indices.length >= 2) {
        duplicates.push(`${filePath} (${entry.indices.length}x)`);
        allSteps.push(...entry.indices);

        // First read is not wasted, subsequent ones are
        const firstCost = steps.find(s => s.index === entry.indices[0])?.cost || 0;
        totalWasted += entry.cost - firstCost;
      }
    }

    if (duplicates.length > 0) {
      findings.push({
        rule: 'duplicate_read',
        severity: 'warning',
        title: 'Duplicate File Reads',
        description: `The following files were read multiple times: ${duplicates.join(', ')}`,
        steps: allSteps,
        wastedCost: totalWasted,
        details: duplicates,
      });
    }

    return findings;
  }
}

class UnusedReadRule implements AnalysisRule {
  name = 'unused_read';

  analyze(steps: Step[]): Finding[] {
    const readSteps = steps.filter(s => s.type === 'tool_call' && s.toolName === 'Read');

    if (readSteps.length === 0) {
      return [];
    }

    // Simple heuristic: if a Read is followed immediately by another tool without any text/thinking, it might be unused
    const unusedReads: number[] = [];
    let wastedCost = 0;

    for (let i = 0; i < readSteps.length; i++) {
      const readStep = readSteps[i];
      const nextSteps = steps.slice(readStep.index + 1, readStep.index + 5);

      // If there's no text or thinking after this read, mark as potentially unused
      const hasFollowup = nextSteps.some(s => s.type === 'text' || s.type === 'thinking');

      if (!hasFollowup && nextSteps.some(s => s.type === 'tool_call')) {
        unusedReads.push(readStep.index);
        wastedCost += readStep.cost;
      }
    }

    if (unusedReads.length === 0) {
      return [];
    }

    return [
      {
        rule: 'unused_read',
        severity: 'info',
        title: 'Potentially Unused Reads',
        description: `Found ${unusedReads.length} file reads that may not have been used`,
        steps: unusedReads,
        wastedCost,
      },
    ];
  }
}

class RetryLoopRule implements AnalysisRule {
  name = 'retry_loop';

  analyze(steps: Step[]): Finding[] {
    const findings: Finding[] = [];

    // Look for patterns of repeated failed tool calls
    for (let i = 0; i < steps.length - 2; i++) {
      const step1 = steps[i];
      if (step1.type !== 'tool_call' || step1.toolSuccess !== false) {
        continue;
      }

      // Count consecutive failures of the same tool
      let failCount = 1;
      const failSteps = [step1.index];
      let totalCost = step1.cost;

      for (let j = i + 1; j < steps.length && j < i + 10; j++) {
        const stepJ = steps[j];
        if (stepJ.type === 'tool_call' && stepJ.toolName === step1.toolName && stepJ.toolSuccess === false) {
          failCount++;
          failSteps.push(stepJ.index);
          totalCost += stepJ.cost;
        }
      }

      if (failCount >= 3) {
        findings.push({
          rule: 'retry_loop',
          severity: 'error',
          title: 'Retry Loop Detected',
          description: `Tool "${step1.toolName}" failed ${failCount} times in a row`,
          steps: failSteps,
          wastedCost: totalCost,
          category: 'loop',
          toolName: step1.toolName,
        });

        i += failCount - 1; // Skip processed steps
      }
    }

    return findings;
  }
}

class FailedToolRule implements AnalysisRule {
  name = 'failed_tool';

  analyze(steps: Step[]): Finding[] {
    const failedSteps = steps.filter(s => s.type === 'tool_call' && s.toolSuccess === false);

    if (failedSteps.length === 0) {
      return [];
    }

    const wastedCost = failedSteps.reduce((sum, s) => sum + s.cost, 0);

    return [
      {
        rule: 'failed_tool',
        severity: 'warning',
        title: 'Failed Tool Calls',
        description: `Found ${failedSteps.length} failed tool calls`,
        steps: failedSteps.map(s => s.index),
        wastedCost,
      },
    ];
  }
}

class ContextPressureRule implements AnalysisRule {
  name = 'context_pressure';

  analyze(steps: Step[]): Finding[] {
    const WINDOW_SIZE = 5;
    const THRESHOLD = 50000;

    interface Entry {
      index: number;
      inputTokens: number;
    }

    const entries: Entry[] = [];
    for (const step of steps) {
      if (!step.usage) {
        continue;
      }
      entries.push({
        index: step.index,
        inputTokens: step.usage.input_tokens + step.usage.cache_creation_input_tokens,
      });
    }

    if (entries.length < WINDOW_SIZE) {
      return [];
    }

    // Sliding window average
    const pressureSet = new Set<number>();
    let peakAvg = 0;

    for (let i = 0; i <= entries.length - WINDOW_SIZE; i++) {
      let sum = 0;
      for (let j = i; j < i + WINDOW_SIZE; j++) {
        sum += entries[j].inputTokens;
      }
      const avg = sum / WINDOW_SIZE;

      if (avg > THRESHOLD) {
        for (let j = i; j < i + WINDOW_SIZE; j++) {
          pressureSet.add(entries[j].index);
        }
        if (avg > peakAvg) {
          peakAvg = avg;
        }
      }
    }

    if (pressureSet.size === 0) {
      return [];
    }

    const pressureSteps = Array.from(pressureSet).sort((a, b) => a - b);
    let confidence = (peakAvg - THRESHOLD) / THRESHOLD;
    if (confidence > 1.0) {
      confidence = 1.0;
    }

    return [
      {
        rule: 'context_pressure',
        severity: 'warning',
        title: `High Context Pressure (${pressureSteps.length} steps)`,
        description: `Detected sustained high input token usage averaging ${Math.round(peakAvg)} tokens (threshold: ${THRESHOLD})`,
        steps: pressureSteps,
        wastedCost: 0,
        confidence,
        category: 'context',
      },
    ];
  }
}

interface Compaction {
  stepIndex: number;
  dropTokens: number;
  dropPct: number;
}

class CompactionDetectedRule implements AnalysisRule {
  name = 'compaction_detected';

  analyze(steps: Step[], options?: AnalysisOptions): Finding[] {
    const compactions = options?.realCompactsOnly
      ? this.fromCompactMarkers(steps)
      : this.fromTokenDrops(steps);

    if (compactions.length === 0) {
      return [];
    }

    const findings: Finding[] = [];

    for (const compaction of compactions) {
      // Build set of files read before compaction
      const preFiles = new Set<string>();
      for (const step of steps) {
        if (step.index >= compaction.stepIndex) {
          break;
        }
        if (step.type === 'tool_call' && step.toolName === 'Read') {
          const filePath = step.toolInput?.file_path;
          if (filePath) {
            preFiles.add(filePath);
          }
        }
      }

      const rereadSteps: number[] = [];
      let rereadCost = 0;

      for (const step of steps) {
        if (step.index <= compaction.stepIndex) {
          continue;
        }
        if (step.type === 'tool_call' && step.toolName === 'Read') {
          const filePath = step.toolInput?.file_path;
          if (filePath && preFiles.has(filePath)) {
            rereadSteps.push(step.index);
            rereadCost += step.cost;
          }
        }
      }

      const allSteps = [compaction.stepIndex, ...rereadSteps];

      const dropText =
        compaction.dropTokens > 0
          ? `Detected ${compaction.dropTokens.toLocaleString()} token drop (${(compaction.dropPct * 100).toFixed(0)}%). `
          : '';

      findings.push({
        rule: 'compaction_detected',
        severity: 'info',
        // No step number in the title: `steps` here are session-local indices,
        // while the UI renders globalIndex (which differs once subagent steps
        // are interleaved). The affected-step link below carries the right one.
        title: 'Context Compaction',
        description: `${dropText}${rereadSteps.length} files re-read after compaction.`,
        steps: allSteps,
        wastedCost: rereadCost,
        // A transcript marker is fact, not inference.
        confidence: options?.realCompactsOnly ? 1.0 : 0.8,
        category: 'context',
      });
    }

    return findings;
  }

  /**
   * Compaction boundaries as recorded by Claude Code itself. The drop is
   * measured on the full prompt (`input + cache_creation + cache_read`),
   * because that is the number a compaction actually shrinks — the
   * `input + cache_creation` sum used by the heuristic below typically *grows*
   * across a real compaction, as the summary has to be written to cache.
   */
  private fromCompactMarkers(steps: Step[]): Compaction[] {
    const compactions: Compaction[] = [];
    let prevFull = -1;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      if (step.type === 'compact') {
        // The compact step carries no usage of its own — the shrunken context
        // first shows up on the next step that has any.
        const nextFull = this.fullContext(steps.slice(i + 1).find(s => s.usage));
        const drop = prevFull > 0 && nextFull > 0 ? prevFull - nextFull : 0;
        compactions.push({
          stepIndex: step.index,
          dropTokens: drop,
          dropPct: drop > 0 ? drop / prevFull : 0,
        });
        continue;
      }

      const full = this.fullContext(step);
      if (full > 0) {
        prevFull = full;
      }
    }

    return compactions;
  }

  /** Whole prompt the step was billed for, cached parts included. */
  private fullContext(step?: Step): number {
    if (!step?.usage) {
      return -1;
    }
    return (
      step.usage.input_tokens +
      step.usage.cache_creation_input_tokens +
      step.usage.cache_read_input_tokens
    );
  }

  /**
   * Heuristic fallback: a large drop in `input + cache_creation`. Catches
   * compactions in transcripts written before the marker existed, at the cost
   * of also firing on prompt-cache rotation.
   */
  private fromTokenDrops(steps: Step[]): Compaction[] {
    const DROP_RATIO = 0.30;
    const MIN_ABS_DROP = 20000;

    const compactions: Compaction[] = [];
    let prevInput = -1;

    for (const step of steps) {
      if (!step.usage) {
        continue;
      }

      const currInput = step.usage.input_tokens + step.usage.cache_creation_input_tokens;

      if (prevInput > 0 && currInput > 0) {
        const drop = prevInput - currInput;
        const pct = drop / prevInput;

        if (pct > DROP_RATIO && drop > MIN_ABS_DROP) {
          compactions.push({
            stepIndex: step.index,
            dropTokens: drop,
            dropPct: pct,
          });
        }
      }

      prevInput = currInput;
    }

    return compactions;
  }
}
