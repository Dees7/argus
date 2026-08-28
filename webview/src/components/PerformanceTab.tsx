import { useMemo } from 'react';
import { Step, isSystemStep } from '../types/session';
import { computeStepDurations } from '../utils/stepDurations';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import './PerformanceTab.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

interface Props {
  /**
   * The main session as it sits in the flattened timeline — harness events
   * included. They are never measured or listed, but they end the gaps they
   * sit in, so a tool call is not credited with the time the harness spent
   * retrying after it.
   */
  steps: Step[];
  onGoToStep: (globalIndex: number) => void;
}

const PerformanceTab = ({ steps, onGoToStep }: Props) => {
  const performanceData = useMemo(() => {
    // What the model did. A harness event took time but is not an operation,
    // so it stays out of the ranking and out of the breakdown — it only ever
    // acts as a boundary, below.
    const operations = steps.filter(step => !isSystemStep(step));
    // A pause ending in the user typing is the human's time, not the model's,
    // and left in it owns every top spot. Those steps come back with no
    // duration at all rather than a wrong one.
    const durations = computeStepDurations(operations, steps, {
      clampNegative: true,
      dropBeforeUserPrompt: true,
      chronologicalBoundaries: true,
    });

    const stepsWithDuration = operations.map(step => ({
      ...step,
      duration: durations.get(step.globalIndex ?? -1) ?? 0,
    }));

    // Find slowest steps
    const sorted = [...stepsWithDuration]
      .filter(s => s.duration > 0)
      .sort((a, b) => b.duration - a.duration);
    const slowest = sorted.slice(0, 10);

    // Duration by tool type
    const durationByType: Record<string, number> = {};
    stepsWithDuration.forEach(step => {
      const key = step.toolName || step.type;
      durationByType[key] = (durationByType[key] || 0) + step.duration;
    });

    const totalDuration = Object.values(durationByType).reduce((sum, d) => sum + d, 0);

    return {
      stepsWithDuration,
      slowest,
      durationByType,
      totalDuration,
      // Steps the total is actually spread over. Dividing by every step instead
      // would count the ones we deliberately left unmeasured as instant.
      measuredCount: durations.size,
    };
  }, [steps]);

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = (ms / 1000).toFixed(1);
    return `${sec}s`;
  };

  // Chart data for slowest operations
  const chartData = {
    labels: performanceData.slowest.map(s => `#${s.globalIndex} ${s.toolName || s.type}`),
    datasets: [
      {
        label: 'Duration (ms)',
        data: performanceData.slowest.map(s => s.duration),
        backgroundColor: 'rgba(86, 156, 214, 0.8)',
        borderColor: 'rgba(86, 156, 214, 1)',
        borderWidth: 1,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      title: {
        display: true,
        text: 'Top 10 Slowest Operations',
        color: getComputedStyle(document.documentElement).getPropertyValue('--text-bright').trim() || '#CCCCCC',
        font: { size: 14 },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#999999' },
        grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)' },
      },
      x: {
        ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#999999', font: { size: 10 } },
        grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)' },
      },
    },
    onClick: (_event: any, elements: any[]) => {
      if (elements.length > 0) {
        const index = elements[0].index;
        const step = performanceData.slowest[index];
        if (step.globalIndex !== undefined) onGoToStep(step.globalIndex);
      }
    },
  };

  return (
    <div className="performance-tab">
      <div className="perf-summary">
        <div className="perf-card">
          {/* Not the length of the session: the waits for the user are left
              out, so this is the time the run was actually working. */}
          <div className="perf-label">Active Duration</div>
          <div className="perf-value">{formatDuration(performanceData.totalDuration)}</div>
        </div>
        <div className="perf-card">
          <div className="perf-label">Slowest Step</div>
          <div className="perf-value">
            {performanceData.slowest[0] ? formatDuration(performanceData.slowest[0].duration) : '-'}
          </div>
          <div className="perf-sub">
            {performanceData.slowest[0] && `#${performanceData.slowest[0].globalIndex}`}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-label">Avg Duration</div>
          <div className="perf-value">
            {performanceData.measuredCount > 0
              ? formatDuration(performanceData.totalDuration / performanceData.measuredCount)
              : '-'}
          </div>
        </div>
      </div>

      <div className="chart-section">
        <div className="chart-container">
          <Bar data={chartData} options={chartOptions} />
        </div>
      </div>

      <div className="duration-breakdown">
        <h3>Duration by Tool Type</h3>
        <div className="duration-table">
          {Object.entries(performanceData.durationByType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, duration]) => (
              <div key={type} className="duration-row">
                <div className="duration-row-header">
                  <span className="duration-type">{type}</span>
                  <span className="duration-value">{formatDuration(duration)}</span>
                </div>
                <div className="duration-bar-container">
                  <div
                    className="duration-bar"
                    style={{
                      width: `${(duration / performanceData.totalDuration) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
        </div>
      </div>

      <div className="slowest-steps-section">
        <h3>Slowest Steps Detail</h3>
        <div className="slowest-steps-list">
          {performanceData.slowest.map(step => (
            <div
              key={step.globalIndex}
              className="slowest-step-item"
              onClick={() => step.globalIndex !== undefined && onGoToStep(step.globalIndex)}
            >
              <div className="slowest-step-header">
                <span className="slowest-step-index">#{step.globalIndex}</span>
                <span className="slowest-step-type">{step.toolName || step.type}</span>
                <span className="slowest-step-duration">{formatDuration(step.duration)}</span>
              </div>
              {step.toolInput?.file_path && (
                <div className="slowest-step-detail">{step.toolInput.file_path}</div>
              )}
              {step.toolInput?.command && (
                <div className="slowest-step-detail">
                  {step.toolInput.command.substring(0, 80)}
                  {step.toolInput.command.length > 80 && '...'}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PerformanceTab;
