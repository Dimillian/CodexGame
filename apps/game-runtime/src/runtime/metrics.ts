import type { RuntimeMetrics } from "./types";

export class MetricsTracker {
  private metrics: RuntimeMetrics = {
    turnsTotal: 0,
    invalidOutputCount: 0,
    actionAppliedCount: 0,
    actionRejectedCount: 0,
    queuedActions: 0
  };

  public onTurnCompleted(): void {
    this.metrics.turnsTotal += 1;
  }

  public onInvalidOutput(): void {
    this.metrics.invalidOutputCount += 1;
  }

  public onActionApplied(): void {
    this.metrics.actionAppliedCount += 1;
  }

  public onActionRejected(): void {
    this.metrics.actionRejectedCount += 1;
  }

  public setQueueDepth(depth: number): void {
    this.metrics.queuedActions = depth;
  }

  public snapshot(): RuntimeMetrics {
    return { ...this.metrics };
  }
}
