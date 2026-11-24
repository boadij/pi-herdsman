import { readFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  Skill,
  ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL = "load_skill";
const DESCRIPTION =
  "Load a relevant skill by its exact name. " +
  "Do not reload a skill whose instructions are already available " +
  "in your current context unless they need to be refreshed.";
const READERS = new Set(["read", "bash"]);

export function registerSkillLoader(
  pi: ExtensionAPI,
  isChief: () => boolean = () => false,
  isSessionAuthorized: (sessionId: string) => boolean = () => true,
): void {
  let current: { sessionId: string; skills: Map<string, Skill> } | undefined;
  let advertised = {
    description: DESCRIPTION,
    exposure: "model-only" as ToolExposure,
  };

  function nativeReaderAvailable(active: readonly string[]): boolean {
    return pi
      .getAllTools()
      .some(
        ({ name, sourceInfo }) =>
          READERS.has(name) &&
          sourceInfo?.source === "builtin" &&
          active.includes(name),
      );
  }

  function inScope(skill: Skill): boolean {
    return !isChief() || skill.sourceInfo.scope === "user";
  }

  function eligibleSkills(active: readonly string[]): Skill[] {
    if (
      !current ||
      !isSessionAuthorized(current.sessionId) ||
      !active.includes(TOOL) ||
      nativeReaderAvailable(active)
    ) {
      return [];
    }
    return [...current.skills.values()].filter(inScope);
  }

  function register(metadata: typeof advertised): void {
    pi.registerTool({
      name: TOOL,
      label: "Load skill",
      description: metadata.description,
      exposure: metadata.exposure,
      defaultActive: true,
      annotations: { readOnlyHint: true },
      parameters: Type.Object(
        { name: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      prepareLoadout(loadout) {
        const active = loadout.declared.map(({ name }) => name);
        if (
          loadout.getExposure(TOOL) !== "direct" ||
          !eligibleSkills(active).length
        ) {
          return { hiddenDeclarations: [TOOL] };
        }
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

  function refreshRegistration(): void {
    if (!pi.getAllTools().some(({ name }) => name === TOOL)) return;

    const active = pi.getActiveTools();
    const eligible = eligibleSkills(active);
    const catalog = eligible
      .map(
        ({ name, description }) =>
          `- ${JSON.stringify(name)}: ${JSON.stringify(description)}`,
      )
      .join("\n");
    const next = eligible.length
      ? {
          description: `${DESCRIPTION}\n\nAvailable skills:\n${catalog}`,
          exposure: "direct" as ToolExposure,
        }
      : { description: DESCRIPTION, exposure: "model-only" as ToolExposure };

    if (
      next.description === advertised.description &&
      next.exposure === advertised.exposure
    ) {
      return;
    }

    try {
      register(next);
    } finally {
      const after = pi.getActiveTools();
      if (
        after.length !== active.length ||
        after.some((name, i) => name !== active[i])
      ) {
        pi.setActiveTools(active);
      }
    }
    advertised = next;
  }

  register(advertised);

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!isSessionAuthorized(sessionId)) {
      current = undefined;
    } else {
      current = {
        sessionId,
        skills: new Map(
          (event.systemPromptOptions?.skills ?? [])
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => [skill.name, skill]),
        ),
      };
    }
    refreshRegistration();
  });

  // ponytail: refresh metadata at model boundaries; execution guards enforce current availability between refreshes.
  pi.on("turn_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      !current ||
      current.sessionId !== sessionId ||
      !isSessionAuthorized(sessionId)
    ) {
      current = undefined;
    }
    refreshRegistration();
  });
}
