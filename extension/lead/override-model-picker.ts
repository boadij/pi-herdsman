import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { allowedOverrideModels, modelToken } from "../agent-model-overrides.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { collapseDisplayText } from "../presentation.ts";

export const overrideModelPickerTitle = "Allowed override models";

const inheritLabel = "Use Pi scoped models";

function sameSelection(
  selected: ReadonlySet<string>,
  models: readonly string[],
): boolean {
  return (
    selected.size === models.length && models.every((id) => selected.has(id))
  );
}

export async function pickOverrideModels(
  ctx: ExtensionContext,
  configured: readonly string[],
  selectMenu: (
    title: string,
    items: readonly SelectItem[],
  ) => Promise<string | undefined>,
): Promise<string[] | undefined> {
  await ctx.modelRegistry.refresh();
  if (ctx.signal?.aborted) return;

  const available = new Map(
    ctx.modelRegistry.getAvailable().map((model) => [modelToken(model), model]),
  );
  const ids = [...new Set([...available.keys(), ...configured])];
  // Preview the inherited policy independently of the current override gate.
  const inherited = allowedOverrideModels(ctx, {
    ...DEFAULT_CONFIG,
    allowAgentModelOverrides: true,
    allowedAgentModels: [],
  }).map(modelToken);
  let preserveInheritance = configured.length === 0;
  let selected = new Set(preserveInheritance ? inherited : configured);
  const usingInheritance = () =>
    preserveInheritance && sameSelection(selected, inherited);
  const selectionStatus = () =>
    usingInheritance()
      ? `Using Pi scoped models · ${selected.size} selected`
      : selected.size
        ? `Custom selection · ${selected.size} selected`
        : "No custom models selected. Pi scoped models will be used.";
  const restoreInheritance = () => {
    preserveInheritance = true;
    selected = new Set(inherited);
  };
  const save = () => {
    const models = usingInheritance() ? [] : [...selected];
    return sameSelection(new Set(models), configured) ? undefined : models;
  };
  const label = (id: string) => {
    const model = available.get(id);
    const token = collapseDisplayText(id) ?? "(unnamed model)";
    const name = collapseDisplayText(model?.name);
    const annotation = model
      ? name && name !== model.id
        ? ` (${name})`
        : ""
      : " (unavailable)";
    return `${selected.has(id) ? "[x]" : "[ ]"} ${token}${annotation}`;
  };
  const toggle = (id: string) => {
    if (!selected.delete(id)) selected.add(id);
  };

  if (ctx.mode !== "tui") {
    while (!ctx.signal?.aborted) {
      const choice = await selectMenu(
        `${overrideModelPickerTitle} · ${selectionStatus()}`,
        [
          { value: "save", label: "Save" },
          { value: "inherit", label: inheritLabel },
          { value: "cancel", label: "Cancel" },
          ...ids.map((id, index) => ({
            value: String(index),
            label: `${index + 1}. ${label(id)}`,
          })),
        ],
      );
      if (choice === "save") return save();
      if (choice === undefined || choice === "cancel") return;
      if (choice === "inherit") {
        restoreInheritance();
        continue;
      }
      const id = ids[Number(choice)];
      if (id === undefined) return;
      toggle(id);
    }
    return;
  }

  return ctx.ui.custom<string[] | undefined>((tui, theme, keys, done) => {
    const input = new Input();
    const body = new Container();
    const status = new Text();
    const frame = new Container();
    const hint = (key: Parameters<typeof keys.getKeys>[0]) =>
      keys.getKeys(key).join("/");
    frame.addChild(new Text(theme.fg("accent", overrideModelPickerTitle)));
    frame.addChild(input);
    frame.addChild(new Spacer(1));
    frame.addChild(body);
    frame.addChild(new Spacer(1));
    frame.addChild(status);
    frame.addChild(
      new Text(
        theme.fg(
          "dim",
          [
            "Type to filter",
            `${hint("tui.select.up")}/${hint("tui.select.down")} navigate`,
            `${hint("tui.select.confirm")} toggle or select`,
            `${hint("app.models.enableAll")} select all`,
            `${hint("app.models.clearAll")} clear`,
            `${hint("app.models.toggleProvider")} toggle provider`,
            `${hint("app.models.save")} save`,
            `${hint("tui.select.cancel")} cancel`,
          ].join(" · "),
        ),
      ),
    );

    let filtered = ids;
    let index = 0;
    const redraw = () => {
      body.clear();
      const rows = [...filtered, undefined];
      const start = Math.max(0, Math.min(index - 4, rows.length - 8));
      if (!filtered.length)
        body.addChild(new Text(theme.fg("dim", "No matching models")));
      for (const [offset, id] of rows.slice(start, start + 8).entries()) {
        const current = index === start + offset;
        const row = `${current ? "→" : " "} ${id === undefined ? inheritLabel : label(id)}`;
        body.addChild({
          render: (width) => [
            truncateToWidth(current ? theme.fg("accent", row) : row, width),
          ],
          invalidate() {},
        });
      }
      status.setText(selectionStatus());
    };
    redraw();

    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render: (width) => frame.render(width),
      invalidate: () => frame.invalidate(),
      handleInput(data) {
        const highlighted = filtered[index];
        if (keys.matches(data, "app.models.save")) return done(save());
        if (keys.matches(data, "tui.select.cancel")) return done(undefined);
        if (keys.matches(data, "app.models.enableAll")) {
          for (const id of filtered) if (available.has(id)) selected.add(id);
        } else if (keys.matches(data, "app.models.clearAll")) {
          for (const id of filtered) selected.delete(id);
        } else if (keys.matches(data, "app.models.toggleProvider")) {
          const provider =
            highlighted === undefined
              ? undefined
              : available.get(highlighted)?.provider;
          if (provider !== undefined) {
            const group = [...available]
              .filter(([, model]) => model.provider === provider)
              .map(([id]) => id);
            const clear = group.every((id) => selected.has(id));
            for (const id of group) {
              if (clear) selected.delete(id);
              else selected.add(id);
            }
          }
        } else if (keys.matches(data, "tui.select.confirm")) {
          if (highlighted === undefined) restoreInheritance();
          else toggle(highlighted);
        } else if (
          keys.matches(data, "tui.select.up") ||
          keys.matches(data, "tui.select.down")
        ) {
          const count = filtered.length + 1; // Include the inheritance row.
          const delta = keys.matches(data, "tui.select.up") ? -1 : 1;
          index = (index + delta + count) % count;
        } else {
          const previous = input.getValue();
          input.handleInput(data);
          const query = input.getValue().trim();
          if (input.getValue() !== previous) {
            filtered = query
              ? fuzzyFilter(
                  ids,
                  query,
                  (id) => `${id} ${available.get(id)?.name ?? ""}`,
                )
              : ids;
            index = 0;
          }
        }
        redraw();
        tui.requestRender();
      },
    };
  });
}
