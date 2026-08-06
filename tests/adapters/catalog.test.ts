import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import {
  SHIPPED_CLI_CATALOG,
  catalogEntries,
  discoverCliEntries,
  loadOperatorCliCatalog,
  parseOperatorCliCatalog,
  projectCliEntries,
  type CliEntry,
} from "../../src/adapters/catalog.js";
import {
  adaptersFromCliEntries, allAdapters, CANDIDATE_CLI_CATALOG, discoverChannels, parseHerdrCliNames,
} from "../../src/adapters/registry.js";
import type { AuthHealth } from "../../src/adapters/types.js";

const advisory = (id: string, binary = id): CliEntry => ({
  id,
  binary,
  identity: ".+",
  vendor: null,
});

const driven = (id: string, binary = id): CliEntry => ({
  id,
  binary,
  identity: `^${id} `,
  vendor: "fixture-vendor",
  drive: {
    headless: `${binary} run --model {model} --prompt-file {promptFile}`,
    interactive: `${binary} --model {model} --prompt-file {promptFile}`,
  },
});

const operatorYaml = (entry: CliEntry): string => `
clis:
  - id: ${entry.id}
    binary: ${entry.binary}
    identity: ${JSON.stringify(entry.identity)}
    vendor: ${entry.vendor === null ? "null" : entry.vendor}
`;

const discoverySources = (): Array<{ source: string; entries: CliEntry[]; id: string }> => {
  const catalog = advisory("catalog-fixture");
  const operator = advisory("operator-fixture");
  return [
    {
      source: "catalog entry",
      entries: catalogEntries({ shipped: [catalog], operatorYaml: null, herdrNames: [] }),
      id: catalog.id,
    },
    {
      source: "operator YAML",
      entries: catalogEntries({ shipped: [], operatorYaml: operatorYaml(operator), herdrNames: [] }),
      id: operator.id,
    },
    {
      source: "herdr nomination",
      entries: catalogEntries({ shipped: [], operatorYaml: null, herdrNames: ["herdr-fixture"] }),
      id: "herdr-fixture",
    },
  ];
};

describe("declarative CLI catalog", () => {
  test("test: no advisory-only entry is ever executed, proven member by member over the closed set of discovery sources — a catalog-entry fixture with no drive block, an operator-YAML fixture with no drive block, and a herdr-nominated-name fixture — each resolved for presence only, and each proven unexecuted by an injected exec tracker recording zero invocations rather than by the absence of a version string in a rendered row", () => {
    for (const { source, entries, id } of discoverySources()) {
      const execute = vi.fn();
      const resolveBinary = vi.fn((binary: string) => ({ resolved: `/fixture/bin/${binary}`, all: [`/fixture/bin/${binary}`] }));

      const discovered = discoverCliEntries(entries, { resolveBinary, execute });

      expect(discovered.present, source).toEqual([{ id, binary: id, path: `/fixture/bin/${id}`, routable: false }]);
      expect(resolveBinary, source).toHaveBeenCalledTimes(1);
      expect(execute, source).toHaveBeenCalledTimes(0);
    }
  });

  test("test: an entry with no drive block appears in NO discovered channel and in NO routing table, proven member by member over those same three discovery sources, so routability and presence are separately witnessed rather than inferred from one another", () => {
    for (const { source, entries, id } of discoverySources()) {
      const projected = projectCliEntries(entries);
      const catalogAdapters = adaptersFromCliEntries(entries);
      const adapters = allAdapters({ cliEntries: entries });
      const health: Record<string, AuthHealth> = {
        [id]: {
          installed: true,
          authed: true,
          models: ["fixture-model"],
          modelAuth: { "fixture-model": { authed: true, probedAt: "1970-01-01T00:00:00.000Z" } },
        },
      };

      expect(projected.routable, source).toEqual([]);
      expect(catalogAdapters.map((adapter) => adapter.id), source).not.toContain(id);
      expect(adapters.map((adapter) => adapter.id), source).not.toContain(id);
      expect(discoverChannels(DEFAULT_CONFIG, catalogAdapters, health), source).toEqual([]);
    }
  });

  test("test: both the routable and advisory projections derive from one array, proven by adding a single catalog entry and observing exactly one projection change with no second list edited", () => {
    const shipped = projectCliEntries(SHIPPED_CLI_CATALOG);
    expect(allAdapters({ cliEntries: SHIPPED_CLI_CATALOG }).map((adapter) => adapter.id)).toEqual(shipped.routable.map((entry) => entry.id));
    expect(CANDIDATE_CLI_CATALOG).toEqual(shipped.advisory.map((entry) => entry.binary));

    const entries: CliEntry[] = [advisory("advisory-base")];
    const beforeDrive = projectCliEntries(entries);
    entries.push(driven("driven-added"));
    const afterDrive = projectCliEntries(entries);

    expect(afterDrive.advisory).toEqual(beforeDrive.advisory);
    expect(afterDrive.routable.map((entry) => entry.id)).toEqual([
      ...beforeDrive.routable.map((entry) => entry.id),
      "driven-added",
    ]);

    const beforeAdvisory = projectCliEntries(entries);
    entries.push(advisory("advisory-added"));
    const afterAdvisory = projectCliEntries(entries);
    expect(afterAdvisory.routable).toEqual(beforeAdvisory.routable);
    expect(afterAdvisory.advisory.map((entry) => entry.id)).toEqual([
      ...beforeAdvisory.advisory.map((entry) => entry.id),
      "advisory-added",
    ]);

    const [adapter] = adaptersFromCliEntries([driven("driven-added")]);
    expect(adapter?.headlessCommand("/tmp/prompt file.md", "vendor/model")).toBe(
      "driven-added run --model 'vendor/model' --prompt-file '/tmp/prompt file.md'",
    );
  });

  test("test: two entries claiming one binary reject both for routing rather than resolving by registration order, and a herdr-nominated name failing the token pattern is rejected rather than passed to a shell", () => {
    const first = driven("first", "shared-bin");
    const second = driven("second", "shared-bin");
    const forward = projectCliEntries([first, second]);
    const reverse = projectCliEntries([second, first]);

    expect(forward.routable).toEqual([]);
    expect(reverse.routable).toEqual([]);
    expect(forward.conflicts).toEqual([{ binary: "shared-bin", ids: ["first", "second"] }]);
    expect(adaptersFromCliEntries([first, second])).toEqual([]);

    const entries = catalogEntries({
      shipped: [],
      operatorYaml: null,
      herdrNames: ["valid-name", "bad; touch /tmp/pwned", "also_bad"],
    });
    const resolveBinary = vi.fn((binary: string) => ({ resolved: `/fixture/bin/${binary}`, all: [`/fixture/bin/${binary}`] }));
    const execute = vi.fn();
    const discovered = discoverCliEntries(entries, { resolveBinary, execute });

    expect(entries.map((entry) => entry.id)).toEqual(["valid-name"]);
    expect(discovered.present.map((entry) => entry.id)).toEqual(["valid-name"]);
    expect(resolveBinary).toHaveBeenCalledTimes(1);
    expect(resolveBinary).toHaveBeenCalledWith("valid-name");
    expect(execute).not.toHaveBeenCalled();
  });

  test("operator YAML is zod-validated and the shipped candidate-name compatibility view is derived", () => {
    expect(parseOperatorCliCatalog(operatorYaml(advisory("yaml-fixture")))).toEqual([advisory("yaml-fixture")]);
    expect(() => parseOperatorCliCatalog(operatorYaml(advisory("bad_name")))).toThrow(/id/i);
    expect(() => parseOperatorCliCatalog(`
clis:
  - id: incomplete-drive
    binary: incomplete-drive
    identity: ".+"
    vendor: fixture-vendor
    drive:
      headless: "incomplete-drive {promptFile}"
      interactive: null
`)).toThrow(/headless.*\{model\}/i);
    expect(() => loadOperatorCliCatalog("repo-relative-clis.yaml")).toThrow(/absolute/i);
    expect(SHIPPED_CLI_CATALOG.some((entry) => entry.binary === "omp" && entry.drive === undefined)).toBe(true);
  });

  test("an operator YAML drive block creates a declarative adapter and Herdr help nominates tokens only", () => {
    const yaml = `
clis:
  - id: yaml-driven
    binary: yaml-driven
    identity: "^yaml-driven "
    vendor: fixture-vendor
    drive:
      headless: "yaml-driven run --model {model} --prompt-file {promptFile}"
      interactive: null
`;
    const entries = parseOperatorCliCatalog(yaml);
    const [adapter] = adaptersFromCliEntries(entries);

    expect(adapter?.id).toBe("yaml-driven");
    expect(adapter?.interactiveCommand("/tmp/prompt.md", "fixture/model")).toBeNull();
    expect(allAdapters({ operatorYaml: yaml }).map((candidate) => candidate.id)).toContain("yaml-driven");
    expect(parseHerdrCliNames("[possible values: valid-one, bad_name, valid-two, x;no]")).toEqual([
      "valid-one",
      "valid-two",
    ]);
  });
});
