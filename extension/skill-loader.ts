import { readFile } from "node:fs/promises";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL = "load_skill";
const DESCRIPTION = "Load a skill by its exact name.";
const READERS = new Set(["read", "bash"]);

export function registerSkillLoader(
  pi: ExtensionAPI,
  isChief: () => boolean = () => false,
  isSessionAuthorized: (sessionId: string) => boolean = () => true,
): void {
  let current: { sessionId: string; skills: Map<string, Skill> } | undefined;
  function nativeReaderAvailable(active: readonly string[]): boolean {
    return pi
      .getAllTools()
      .some(
        ({ name, sourceInfo }) =>
          READERS.has(name) &&
          sourceInfo.source === "builtin" &&
          active.includes(name),
      );
  }
  function inScope(skill: Skill): boolean {
    return !isChief() || skill.sourceInfo.scope === "user";
  }

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!isSessionAuthorized(sessionId)) {
      current = undefined;
      return;
    }
    current = {
      sessionId,
      skills: new Map(
        (event.systemPromptOptions?.skills ?? [])
          .filter((skill) => !skill.disableModelInvocation)
          .map((skill) => [skill.name, skill]),
      ),
    };
  });

  pi.registerTool({
    name: TOOL,
    label: "Load skill",
    description: DESCRIPTION,
    exposure: "model-only",
    defaultActive: true,
    annotations: { readOnlyHint: true },
    parameters: Type.Object(
      { name: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    prepareLoadout({ declared }) {
      if (!current || !isSessionAuthorized(current.sessionId))
        return { hiddenDeclarations: [TOOL] };
      // Pi supplies the active set before any hook hides declarations, so
      // this also detects native readers hidden by Code Mode.
      const eligible = [...current.skills.values()].filter(inScope);
      if (
        !eligible.length ||
        nativeReaderAvailable(declared.map(({ name }) => name))
      ) {
        return { hiddenDeclarations: [TOOL] };
      }
      const catalog = eligible.map(
        ({ name, description }) =>
          `- ${JSON.stringify(name)}: ${JSON.stringify(description)}`,
      );
      return {
        descriptions: {
          [TOOL]: `${DESCRIPTION}\n\nAvailable skills:\n${catalog.join("\n")}`,
        },
      };
    },
    async execute(_id, { name }, _signal, _update, ctx) {
      const active = pi.getActiveTools();
      const sessionId = ctx.sessionManager.getSessionId();
      const skill = current?.skills.get(name);
      if (
        !skill ||
        current?.sessionId !== sessionId ||
        !isSessionAuthorized(sessionId) ||
        !active.includes(TOOL) ||
        !inScope(skill) ||
        nativeReaderAvailable(active)
      ) {
        throw new Error("Skill unavailable in this session");
      }

      let content: string;
      try {
        content = await readFile(skill.filePath, "utf8");
      } catch {
        throw new Error("Skill file could not be read");
      }
      return {
        content: [
          {
            type: "text",
            text: `Skill: ${skill.name}\nDirectory: ${skill.baseDir}\n\n${content}`,
          },
        ],
        details: undefined,
      };
    },
  });
}
