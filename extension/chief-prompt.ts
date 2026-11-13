import { dirname, resolve } from "node:path";

export type ChiefPromptOptions = {
  contextFiles?: readonly { path?: string; content?: string }[];
};

export function chiefGlobalInstructions(
  options: ChiefPromptOptions | undefined,
  agentDir: string,
): Array<{ path: string; content: string }> {
  return (options?.contextFiles ?? []).filter(
    (file): file is { path: string; content: string } =>
      typeof file.path === "string" &&
      typeof file.content === "string" &&
      resolve(dirname(file.path)) === resolve(agentDir) &&
      file.content.length > 0,
  );
}

export function chiefSystemPrompt(
  options: ChiefPromptOptions | undefined,
  body: string,
  roleContract: string,
  agentDir: string,
): string {
  const globalInstructions = chiefGlobalInstructions(options, agentDir)
    .map(({ content }) => content)
    .join("\n\n");
  return [
    roleContract,
    body || undefined,
    globalInstructions
      ? `## global user instructions\n\n<global_instructions>\n${globalInstructions}\n</global_instructions>`
      : undefined,
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}
