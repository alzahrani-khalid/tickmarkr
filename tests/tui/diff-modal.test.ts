import { describe, expect, test } from "vitest";
import { renderDiffModal } from "../../src/tui/views/diff-modal.js";

describe("diff modal view", () => {
  test("renders the target path in the header and the diff body", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "--- /repo/.tickmarkr/config.yaml (current)\n+++ /repo/.tickmarkr/config.yaml (proposed)\n@@\n- deny: {}\n+ routing:\n+   deny:\n+     adapters:\n+       - grok\n",
      liveRun: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("Save overlay");
    expect(text).toContain("/repo/.tickmarkr/config.yaml");
    expect(text).toContain("grok");
    expect(text).toContain("t toggle target");
  });

  test("global target names the global path and labels the header accordingly", () => {
    const lines = renderDiffModal({
      target: "global",
      targetPath: "/home/user/.config/tickmarkr/config.yaml",
      diff: "",
      liveRun: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("global target");
    expect(text).toContain("/home/user/.config/tickmarkr/config.yaml");
  });

  test("renders the reload guard notice when liveRun is true", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "+ adapters:\n+   - grok",
      liveRun: true,
    });
    const text = lines.join("\n");
    expect(text).toContain("reload guard");
    expect(text).toContain("live run");
  });

  test("omits the reload guard notice when liveRun is false", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "",
      liveRun: false,
    });
    expect(lines.join("\n")).not.toContain("reload guard");
  });
});
