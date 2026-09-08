export type ErrorCategory =
  | "not_running_inside_herdr"
  | "agent_label_exists"
  | "pane_not_ready"
  | "target_not_found"
  | "target_ambiguous"
  | "rollback_failure"
  | "agent_busy"
  | "invalid_request"
  | "internal_failure";

export interface ErrorCause {
  category: ErrorCategory;
  message: string;
  operation?: string;
}

export interface StructuredError {
  category: ErrorCategory;
  message: string;
  operation: string;
  ids?: Record<string, string | undefined>;
  rollbackOccurred: boolean;
  retryAttempted: boolean;
  nextAction?: string;
  primary?: ErrorCause;
  cleanup?: ErrorCause;
  details?: Record<string, unknown>;
}

export class OperationError extends Error {
  readonly detail: StructuredError;

  constructor(detail: StructuredError) {
    super(detail.message);
    this.detail = detail;
  }
}

export function markRetryAttempted(error: unknown): void {
  if (error instanceof OperationError) error.detail.retryAttempted = true;
}

export function fail(
  category: ErrorCategory,
  message: string,
  operation: string,
  options: Partial<
    Omit<StructuredError, "category" | "message" | "operation">
  > = {},
): never {
  throw new OperationError({
    category,
    message,
    operation,
    rollbackOccurred: false,
    retryAttempted: false,
    ...options,
  });
}
