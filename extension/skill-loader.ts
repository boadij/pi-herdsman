import { readFile } from "node:fs/promises";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL = "load_skill";
const DESCRIPTION = "Load a skill by its exact name.";
const READERS = new Set(["read", "bash"]);

export function registerSkillLoader(pi: ExtensionAPI): void {
  let current: { sessionId: string; skills: Map<string, Skill> } | undefined;

  pi.on("before_agent_start", (event, ctx) => {
    current = {
      sessionId: ctx.sessionManager.getSessionId(),
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
    defaultActive: false,
    annotations: { readOnlyHint: true },
    parameters: Type.Object(
      { name: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    prepareLoadout({ declared }) {
      // Pi supplies the active set before any hook hides declarations, so
      // this also detects native readers hidden by Code Mode.
      if (
        !current?.skills.size ||
        declared.some(({ name }) => READERS.has(name))
      ) {
        return { hiddenDeclarations: [TOOL] };
      }
      const catalog = [...current.skills.values()].map(
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
      const skill = current?.skills.get(name);
      if (
        !skill ||
        current?.sessionId !== ctx.sessionManager.getSessionId() ||
        !active.includes(TOOL) ||
        active.some((tool) => READERS.has(tool))
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
