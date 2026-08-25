import { Step, AnalysisResult } from '../types/session';
import { calculateCostBreakdown } from '../../../src/types/pricing';
import { Pie, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import './CostTab.css';

ChartJS.register(ArcElement, Tooltip, Legend);

interface Props {
  steps: Step[];
  analysis?: AnalysisResult;
  sessionTotalCost: number;
  onGoToStep: (index: number) => void;
}

const CostTab = ({ steps, analysis, sessionTotalCost, onGoToStep }: Props) => {
  const totalCost = analysis?.totalCost ?? sessionTotalCost;

  // Calculate wasted cost if not in analysis
  let calculatedWastedCost = 0;
  if (analysis?.wastedCost) {
    calculatedWastedCost = analysis.wastedCost;
  } else {
    // Calculate wasted cost from duplicate reads and failed steps
    const fileReads = new Map<string, { cost: number; count: number }>();

    steps.forEach(step => {
      // Track duplicate file reads
      if (step.toolName === 'Read' && step.toolInput?.file_path) {
        const path = step.toolInput.file_path;
        if (!fileReads.has(path)) {
          fileReads.set(path, { cost: step.cost, count: 1 });
        } else {
          const data = fileReads.get(path)!;
          data.cost += step.cost;
          data.count += 1;
        }
      }

      // Track failed steps
      if (step.toolResult && typeof step.toolResult === 'string') {
        if (step.toolResult.includes('Error:') || step.toolResult.includes('Failed:') ||
            step.toolResult.includes('error:') || step.toolResult.includes('failed:')) {
          calculatedWastedCost += step.cost;
        }
      }
    });

    // Add cost of duplicate reads (keep first read, count rest as wasted)
    fileReads.forEach(data => {
      if (data.count > 1) {
        // Assume uniform cost per read, waste all but first
        const costPerRead = data.cost / data.count;
        calculatedWastedCost += costPerRead * (data.count - 1);
      }
    });
  }

  const wastedCost = calculatedWastedCost;
  const efficiency = analysis?.efficiency ?? (totalCost > 0 ? ((totalCost - wastedCost) / totalCost) * 100 : 100);

  // Cost by step type. `step.cost` is already priced per model by the parser
  // and charged once per API response, so it is summed as-is — recomputing it
  // here from `usage` would both re-guess the model and double-count the
  // siblings of a multi-block message.
  const costByType: Record<string, { count: number; cost: number; steps: number[] }> = {};
  steps.forEach(step => {
    const key = step.toolName || step.type;
    if (!costByType[key]) {
      costByType[key] = { count: 0, cost: 0, steps: [] };
    }
    costByType[key].count++;
    costByType[key].cost += step.cost || 0;
    costByType[key].steps.push(step.index);
  });

  const sortedTypes = Object.entries(costByType).sort((a, b) => b[1].cost - a[1].cost);
  const maxCost = sortedTypes[0]?.[1].cost || 1;

  // Token cost breakdown. Usage repeats across every step of one response, so
  // each message is counted once — the same rule the parser applies to cost.
  let inputCost = 0, outputCost = 0, cacheReadCost = 0, cacheCreateCost = 0;
  const countedMessages = new Set<string>();
  steps.forEach(step => {
    if (!step.usage) return;
    const key = step.messageId || `step-${step.index}`;
    if (countedMessages.has(key)) return;
    countedMessages.add(key);

    const b = calculateCostBreakdown(step.usage, step.model ?? '');
    inputCost += b.input;
    outputCost += b.output;
    cacheReadCost += b.cacheRead;
    cacheCreateCost += b.cacheWrite;
  });

  const hasEstimatedCosts = steps.some(s => s.costIsEstimate);

  // Pie chart data - Cost by Type
  const pieData = {
    labels: sortedTypes.slice(0, 8).map(([type]) => type),
    datasets: [
      {
        data: sortedTypes.slice(0, 8).map(([_, data]) => data.cost),
        backgroundColor: [
          'rgba(86, 156, 214, 0.8)',
          'rgba(78, 201, 176, 0.8)',
          'rgba(206, 145, 120, 0.8)',
          'rgba(156, 220, 254, 0.8)',
          'rgba(181, 206, 168, 0.8)',
          'rgba(220, 220, 170, 0.8)',
          'rgba(197, 134, 192, 0.8)',
          'rgba(86, 156, 214, 0.6)',
        ],
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(62, 62, 66, 1)',
        borderWidth: 1,
      },
    ],
  };

  const pieOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#CCCCCC',
          font: { size: 11 },
          padding: 10,
        },
      },
      tooltip: {
        callbacks: {
          label: (context: any) => {
            const value = context.parsed;
            const chartTotal = sortedTypes.slice(0, 8).reduce((sum, [_, data]) => sum + data.cost, 0);
            const percentage = ((value / chartTotal) * 100).toFixed(1);
            const totalPercentage = ((value / totalCost) * 100).toFixed(1);
            return `${context.label}: $${value.toFixed(4)} (${percentage}% of chart, ${totalPercentage}% of total)`;
          },
        },
      },
    },
  };

  // Token breakdown doughnut
  const tokenData = {
    labels: ['Input Tokens', 'Output Tokens', 'Cache Read', 'Cache Write'],
    datasets: [
      {
        data: [inputCost, outputCost, cacheReadCost, cacheCreateCost],
        backgroundColor: [
          'rgba(86, 156, 214, 0.8)',
          'rgba(139, 92, 246, 0.8)',
          'rgba(94, 234, 212, 0.8)',
          'rgba(251, 191, 36, 0.8)',
        ],
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(62, 62, 66, 1)',
        borderWidth: 1,
      },
    ],
  };

  const tokenOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#CCCCCC',
          font: { size: 11 },
          padding: 8,
        },
      },
      tooltip: {
        callbacks: {
          label: (context: any) => {
            const value = context.parsed;
            const tokenTotal = inputCost + outputCost + cacheReadCost + cacheCreateCost;
            const percentage = tokenTotal > 0 ? ((value / tokenTotal) * 100).toFixed(1) : '0.0';
            return `${context.label}: $${value.toFixed(4)} (${percentage}%)`;
          },
        },
      },
    },
  };

  return (
    <div className="cost-tab">
      <div className="cost-summary">
        <div className="cost-card total">
          <div className="cost-label">Total Cost</div>
          <div className="cost-value">
            {hasEstimatedCosts && <span className="cost-approx">≈</span>}
            ${totalCost.toFixed(4)}
          </div>
          {hasEstimatedCosts && (
            <div className="cost-note" title="Some steps ran on a model with no exact price in the table; those are priced at their model family's rate.">
              estimated — unrecognised model
            </div>
          )}
        </div>
        <div className="cost-card wasted">
          <div className="cost-label">Wasted Cost</div>
          <div className="cost-value">${wastedCost.toFixed(4)}</div>
        </div>
        <div className="cost-card efficiency">
          <div className="cost-label">Efficiency</div>
          <div className="cost-value">{efficiency.toFixed(1)}%</div>
        </div>
      </div>

      <div className="cost-charts">
        <div className="chart-container">
          <h3>Cost Distribution by Tool</h3>
          <div className="chart-wrapper">
            <Pie data={pieData} options={pieOptions} />
          </div>
        </div>
        <div className="chart-container">
          <h3>Cost Distribution by Token Type</h3>
          <div className="chart-wrapper">
            <Doughnut data={tokenData} options={tokenOptions} />
          </div>
        </div>
      </div>

      <div className="cost-breakdown">
        <h3>Detailed Cost by Tool/Type</h3>
        <div className="cost-table">
          {sortedTypes.map(([type, data]) => (
            <div key={type} className="cost-row">
              <div className="cost-row-header">
                <span className="cost-type">{type}</span>
                <div className="cost-stats">
                  <span className="cost-count">{data.count}x</span>
                  <span className="cost-amount">${data.cost.toFixed(4)}</span>
                </div>
              </div>
              <div className="cost-bar-container">
                <div
                  className="cost-bar"
                  style={{ width: `${(data.cost / maxCost) * 100}%` }}
                />
              </div>
              <div className="cost-row-steps">
                {data.steps.slice(0, 10).map(idx => (
                  <button key={idx} className="step-link" onClick={() => onGoToStep(idx)}>
                    #{idx}
                  </button>
                ))}
                {data.steps.length > 10 && <span>+{data.steps.length - 10} more</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CostTab;
