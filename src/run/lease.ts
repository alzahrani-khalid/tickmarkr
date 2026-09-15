import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// The process census and command admission deliberately use the same command-head classifier.
export function isRunnerCommand(command: string): boolean {
  // Inspect executable positions only: inference prompts and shell script bodies may name runners.
  let head = command.trim().replace(/['"]/g, "");
  for (;;) {
    const unwrapped = head
      .replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+/i, "")
      .replace(/^cd\s+[^;&|]+\s*&&\s*/, "")
      .replace(/^(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)+/, "");
    if (unwrapped === head) break;
    head = unwrapped;
  }
  const binary = "(?:\\S*/)?";
  const flags = "(?:\\s+(?:--?[\\w-]+(?:=[^\\s]+)?|--))*";
  const manager = `${binary}(?:npm|pnpm|yarn|bun)${flags}`;
  const jsRunner = `${binary}(?:vitest(?:\\.mjs)?|jest|mocha)(?:\\s|$)`;
  // Test scripts may be scoped (test:unit); runner binaries may be launched through a manager.
  // Keep each match anchored to that executable position so prompt/argument mentions stay out.
  return new RegExp(`^${manager}\\s+(?:run${flags}\\s+)?test[\\w:.-]*(?:\\s|$)`, "i").test(head)
    || new RegExp(`^${manager}\\s+(?:(?:exec|x|dlx)${flags}\\s+)?${jsRunner}`, "i").test(head)
    || new RegExp(`^${binary}npx${flags}\\s+${jsRunner}`, "i").test(head)
    || /^(?:\S*\/)?(?:go|make|cargo)\s+test(?:\s|$)/i.test(head)
    || /^(?:(?:\S*\/)?(?:node|npx)\s+)?(?:\S*\/)?(?:vitest(?:\.mjs)?|jest|mocha|pytest(?:\d+(?:\.\d+)*)?)(?:\s|$)/i.test(head)
    || /^(?:\S*\/)?python[\d.]*\s+-m\s+pytest(?:\s|$)/i.test(head);
}

export const COMMAND_LEASE_TOKEN_ENV = "TICKMARKR_LEASE_TOKEN";
export type CommandLease = <T>(command: string, run: (token?: string) => Promise<T>) => Promise<T>;
const context = new AsyncLocalStorage<CommandLease>();
const ownership = new AsyncLocalStorage<{ token: string; active: boolean }>();

/** Async descendants share the reservation; a shell's descendants inherit the same token. */
export function currentCommandLeaseToken(): string | undefined {
  const owner = ownership.getStore();
  return owner ? (owner.active ? owner.token : undefined) : process.env[COMMAND_LEASE_TOKEN_ENV] || undefined;
}

/** Never export a command's token through process.env: concurrent sibling commands must queue. */
export function commandLeaseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  const token = currentCommandLeaseToken();
  if (token) child[COMMAND_LEASE_TOKEN_ENV] = token;
  else delete child[COMMAND_LEASE_TOKEN_ENV];
  return child;
}

export const runWithCommandLease = <T>(lease: CommandLease, run: () => Promise<T>): Promise<T> =>
  context.run(lease, run);
export const withCommandLease = <T>(command: string, run: () => Promise<T>): Promise<T> => {
  const lease = context.getStore();
  if (!lease || !isRunnerCommand(command) || currentCommandLeaseToken()) return run();
  return lease(command, token => {
    const owner = { token: token ?? randomUUID(), active: true };
    return ownership.run(owner, async () => {
      try { return await run(); }
      finally { owner.active = false; } // A continuation after release must acquire a new lease.
    });
  });
};

/** Each reservation releases only itself, including an aborted waiter. */
export class CommandLeases {
  private readonly owners = new Set<symbol>();
  async run<T>(run: () => Promise<T>, waiting: (count: number) => void, pollMs: number, signal?: AbortSignal): Promise<T> {
    const owner = Symbol("command");
    this.owners.add(owner);
    try {
      let reported = false;
      while (this.owners.values().next().value !== owner) {
        signal?.throwIfAborted();
        if (!reported) { waiting(this.owners.size - 1); reported = true; }
        await new Promise((wake) => setTimeout(wake, pollMs));
      }
      signal?.throwIfAborted();
      return await run();
    } finally {
      this.owners.delete(owner);
    }
  }
}
