import { parseArgs } from "node:util";
import { discoverFixtures, resolveFixturesRoot, seedFixture } from "../../eval/fixtures.js";

export async function evalCommand(argv: string[], cwd = process.cwd()): Promise<string | { out: string; code: number }> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const root = resolveFixturesRoot(positionals[0], cwd);
  const { valid, invalid } = discoverFixtures(root);

  const lines: string[] = [`tickmarkr eval — discovered ${valid.length} fixture${valid.length === 1 ? "" : "s"}`];
  for (const f of valid) lines.push(`  ${f.id}`);

  if (invalid.length) {
    lines.push("", "invalid fixtures:");
    for (const i of invalid) lines.push(`  ${i.id} — ${i.reason}`);
  }

  for (const f of valid) {
    const seeded = await seedFixture(f);
    try {
      lines.push(`  seeded ${f.id}`);
    } finally {
      await seeded.cleanup();
    }
  }

  const out = lines.join("\n");
  return invalid.length ? { out, code: 1 } : out;
}
