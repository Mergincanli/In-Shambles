/** Types for test-cost-reporter.mjs (the Vitest configs load it; D-032). */
import type { Reporter, TestSpecification, Vitest } from "vitest/node";

export interface TestBudget {
  /** The command the budget is for, e.g. "pnpm test". */
  readonly label: string;
  readonly wallSeconds: number;
  /** User + sys seconds; absent when the tier has only a wall budget. */
  readonly cpuSeconds?: number;
}

export interface CpuSeconds {
  readonly user: number;
  readonly sys: number;
}

export function childCpuFromProcStat(stat: string, clockTicks: number): CpuSeconds | null;
export function formatTestCost(
  budget: TestBudget,
  wallSeconds: number,
  cpu: CpuSeconds | null,
  narrowed?: boolean,
): string;
export class TestCostReporter implements Reporter {
  readonly budget: TestBudget;
  /** Whether this run was narrowed (file arguments, `-t`, `--project`), known once it started. */
  readonly narrowed: boolean;
  constructor(budget: TestBudget);
  onInit(vitest: Vitest): void;
  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): Promise<void>;
  onTestRunEnd(): void;
}
