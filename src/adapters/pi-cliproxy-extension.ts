// Queue row 392 R6 law 4 (D-2187 add.13, add.17 (5), add.21; cross-read M5, M8): the pi extension that carries a
// model proxy's non-anthropic ids. pi 1.5.0 loads `-e <path>` through its extension loader, which takes the
// module's DEFAULT export, refuses anything that is not a function, and awaits it with its extension API.
// The launch line (pi.ts) sets only the base URL and the proxy id in the environment; the credential is read
// here, at load, from the closed sources detection reads, so it never reaches argv or a stream.
import { apiRoot, gatewayCredential, type GatewaySeam } from "./cliproxy.js";
import { MODEL_ID_RE } from "./types.js";

export const CLIPROXY_PROVIDER = "cliproxy";
export const CLIPROXY_BASE_URL_ENV = "TICKMARKR_CLIPROXY_BASE_URL";
export const CLIPROXY_MODEL_ENV = "TICKMARKR_CLIPROXY_MODEL";
// A gateway with no credential still gets the request (a 401 reads as unauthorized); pi needs some key to
// make a registered model available, so this placeholder stands in. It has no `$` and no leading `!`.
const NO_CREDENTIAL = "tickmarkr-cliproxy-no-credential";

/** The slice of pi 1.5.0's ExtensionAPI this extension calls (registerProvider by name, legacy config form). */
export interface PiExtensionApi {
  registerProvider(name: string, config: PiProviderConfig): void;
}
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: {
    type: "chat";
    id: string;
    name: string;
    reasoning: boolean;
    input: "text"[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }[];
}

/** pi reads an apiKey string as a config value: a leading `!` runs a command and `$NAME` / `${NAME}` interpolate
 *  the environment, while `$$` and `$!` are its literal `$` and `!` (docs custom-provider.md, installed pi 1.5.0).
 *  Every `$` is doubled and a leading `!` becomes `$!`, so pi resolves exactly the credential: never runs or
 *  expands it. */
export function piLiteral(value: string): string {
  const escaped = value.split("$").join("$$");
  return escaped.startsWith("!") ? "$" + escaped : escaped;
}

/** The factory pi awaits. The second argument is never passed by pi: it lets a test supply a synthetic
 *  environment and Claude settings file in place of the process's own. */
export default function cliproxyExtension(pi: PiExtensionApi, seam: Pick<GatewaySeam, "env" | "settingsPath"> = {}): void {
  const env = seam.env ?? process.env;
  const baseUrl = env[CLIPROXY_BASE_URL_ENV];
  const model = env[CLIPROXY_MODEL_ENV];
  // No confirmed gateway record (an empty base URL) or no proxy id: refuse to load, so pi cannot reach any
  // other endpoint and the launch fails closed. The message names no value.
  if (!baseUrl || !model || !MODEL_ID_RE.test(model)) {
    throw new Error(`tickmarkr cliproxy extension: ${CLIPROXY_BASE_URL_ENV} and ${CLIPROXY_MODEL_ENV} must name a confirmed gateway and a proxy id`);
  }
  // The credential the Claude CLI sends to its gateway: ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY, from the
  // environment when it names the base URL, else from the Claude settings env — the same read detection makes.
  const credential = gatewayCredential({}, { env: seam.env, settingsPath: seam.settingsPath });
  // ponytail: one fixed window for every proxied id; per-model limits from the listing if a turn ever overflows
  pi.registerProvider(CLIPROXY_PROVIDER, {
    name: "CLIProxy (tickmarkr)",
    baseUrl: apiRoot(baseUrl),
    apiKey: piLiteral(credential ?? NO_CREDENTIAL),
    api: "openai-completions",
    // The BARE proxy id: pi selects `cliproxy/<id>` and sends model.id on the wire.
    models: [{ type: "chat", id: model, name: model, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
  });
}
