// VIS-10: every pane-establishing dispatch must seed and seal the new shell before its first launch.
// Parse call structure instead of searching an arbitrary character window after the create call: text
// proximity cannot prove ordering and passed when an unsealed command preceded a nearby seal.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../src/drivers/herdr.ts", import.meta.url)), "utf8");

interface PlacementDispatch { create: string; firstLaunch?: string }

function placementDispatches(source: string): PlacementDispatch[] {
  const file = ts.createSourceFile("herdr.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dispatches: PlacementDispatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.body) {
      const commands: Array<{ at: number; text: string }> = [];
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)
            && ts.isPropertyAccessExpression(child.expression)
            && child.expression.expression.kind === ts.SyntaxKind.ThisKeyword
            && child.expression.name.text === "herdr"
            && child.arguments[0]) {
          commands.push({ at: child.getStart(file), text: child.arguments[0].getText(file) });
        }
        ts.forEachChild(child, collect);
      };
      collect(node.body);
      for (const command of commands.filter(({ text }) => /`(?:tab create|pane split)\b/.test(text))) {
        dispatches.push({
          create: command.text,
          firstLaunch: commands.find(({ at, text }) => at > command.at && /`pane run\b/.test(text))?.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return dispatches;
}

const sealedBeforeLaunch = (source: string): boolean => {
  const dispatches = placementDispatches(source);
  return dispatches.length > 0 && dispatches.every(({ create, firstLaunch }) =>
    (!/`tab create\b/.test(create) || /--workspace\b/.test(create))
    && firstLaunch !== undefined
    && /HERDR_WORKSPACE_ID[\s\S]*herdrSealShellPrefix\(\)/.test(firstLaunch));
};

describe("driver placement audit (VIS-10 structural guarantee)", () => {
  test("test: the placement audit asserts the sealed-launch property from the parsed dispatch structure so a launch whose seal follows the command within the old character window still fails the audit whereas the shipped window grep passes it", () => {
    expect(sealedBeforeLaunch(src)).toBe(true);

    const broken = `class Driver {
      async slot(pane: string, cmd: string) {
        await this.herdr(\`pane split \${pane}\`);
        await this.herdr(\`pane run \${pane} \${cmd}\`);
        await this.herdr(\`pane run \${pane} export HERDR_WORKSPACE_ID=x; \${herdrSealShellPrefix()}\`);
        return pane;
      }
    }`;
    const createAt = broken.indexOf("pane split");
    expect(broken.slice(createAt, createAt + 2_500)).toMatch(/HERDR_WORKSPACE_ID/); // old audit passes
    expect(sealedBeforeLaunch(broken)).toBe(false); // parsed first launch is still unsealed
  });
});
