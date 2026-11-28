export const FLEXIBLE_LEAD_DEFINITION_NAME = "flexible-lead";
export const ORCHESTRATOR_LEAD_DEFINITION_NAME = "orchestrator-lead";
export const MANAGED_LEAD_DEFINITION_NAME = "managed-lead";
export const MANAGER_DEFINITION_NAME = "manager";
export const CHIEF_DEFINITION_NAME = "chief";
const reservedCategories = {
  [FLEXIBLE_LEAD_DEFINITION_NAME]: "lead",
  [ORCHESTRATOR_LEAD_DEFINITION_NAME]: "lead",
  [MANAGED_LEAD_DEFINITION_NAME]: "lead",
  [MANAGER_DEFINITION_NAME]: "manager",
  [CHIEF_DEFINITION_NAME]: "chief",
} as const;

export function reservedDefinitionCategory(name: string) {
  return Object.hasOwn(reservedCategories, name)
    ? reservedCategories[name as keyof typeof reservedCategories]
    : undefined;
}

// Reject ASCII controls explicitly; this pattern is also used in JSON schemas.
export const DEFINITION_NAME_PATTERN = new RegExp(
  String.raw`^(?!\.{1,2}$)(?!\s)[^\\/\u0000-\u001f\u007f]+(?<!\s)$`,
  "u",
);

export function isDefinitionName(name: unknown): name is string {
  return typeof name === "string" && DEFINITION_NAME_PATTERN.test(name);
}

export function isAssignedLeadDefinitionName(name: string): boolean {
  return (
    isDefinitionName(name) &&
    (reservedDefinitionCategory(name) === undefined || name === MANAGED_LEAD_DEFINITION_NAME)
  );
}
