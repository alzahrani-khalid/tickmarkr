import { CLAUDE_TRUST_DIALOG, CLAUDE_TRUST_OPTION_ROWS } from "../adapters/claude-code.js";
import type { CapturedTrustDialog } from "../adapters/types.js";
import { HcError } from "../drivers/hc-client.js";
import { HcUnavailableError } from "../drivers/herdr-app.js";

// Queue rows 340 and 342 (D-2180): the ONE trust answer behind all three production auto-answer boundaries — the
// daemon's worker wait, the interactive seed's startup wait and a gate seat's pane startup. The caller has matched the
// adapter's declared fingerprint (matchesTrustDialog, unchanged allowlist) on the slot's rendered frame and spent its
// once-only latch; this decides which keys that match buys and reports what actually happened.
//
// Every adapter keeps its single declared key — except Claude Code, whose captured 2.1.318 dialog has its cursor on
// "No, exit": a bare Enter exits the seat. For CLAUDE_TRUST_DIALOG's fingerprint only, the answer is a verified
// selection: Down, a re-read of the SAME owned rendered frame, and Enter only when the bottom-anchored captured rows
// prove "Yes" is selected. Nothing here retries a sequence: an unreadable or changed frame or the caller's deadline ends
// it refused, and a failed submit ends it refused or unconfirmed — never answered. Key names are logical (`Down`, `Enter`); each driver maps them to its own verb or
// refuses one it has none for (Orca has no Down), and a refusal is a page, never a fallback Enter.

// Only "answered" is an accepted trust. Both other outcomes keep the caller's once-only latch spent (never retried) and
// page the operator; neither is ever narrated as an accepted trust.
export type TrustAnswer =
  /** The submit key was sent and its send resolved. */
  | { outcome: "answered" }
  /** The submit key was dispatched and the transport then failed: it may or may not have landed. */
  | { outcome: "unconfirmed"; reason: string }
  /** The submit key was never sent: refused before it, or the driver refused to address the terminal at all. */
  | { outcome: "refused"; reason: string };

export interface TrustAnswerOpts {
  dialog: CapturedTrustDialog;
  /** The rendered frame the caller matched. */
  frame: string;
  /** The same read that produced `frame` (Slot.readScreen when the driver has one); a throw is an unreadable frame. */
  read: () => Promise<string>;
  sendKey: (key: string) => Promise<void>;
  /** The caller's existing startup deadline (epoch ms): read-only settling after Down never outlives it. */
  deadline: number;
  pollMs?: number;
}

const SETTLE_POLL_MS = 200;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
const refused = (reason: string): TrustAnswer => ({ outcome: "refused", reason });

// The submit key's send is the sequence's last act, classified on the DISPATCH BOUNDARY (review parks 978/1159): did the
// failing send start the process that writes the key? The Herdr app driver keys a terminal only by running `hc keys`,
// after its preflight (core status, terminal get, ownership) passed, and every hc failure names the call that failed
// (HcError.family). So any failure but `hc keys`'s own — a nonzero status or get, the preflight's HcUnavailableError —
// happened before dispatch: nothing reached the terminal, refused. A failure of `hc keys` itself, or of any driver whose
// send has no earlier failure point (classic herdr's `pane send-keys`), follows a dispatch: unconfirmed.
const beforeDispatch = (e: unknown): boolean => (e instanceof HcError ? e.family !== "keys" : e instanceof HcUnavailableError);

async function submit(o: TrustAnswerOpts): Promise<TrustAnswer> {
  try { await o.sendKey(o.dialog.key); return { outcome: "answered" }; }
  catch (e) {
    const reason = `${o.dialog.key} not delivered: ${message(e)}`;
    return beforeDispatch(e) ? refused(reason) : { outcome: "unconfirmed", reason };
  }
}

const isClaudeTrust = (dialog: CapturedTrustDialog): boolean =>
  CLAUDE_TRUST_DIALOG.kind !== "none" && dialog.fingerprint === CLAUDE_TRUST_DIALOG.fingerprint;

// The caret's padding is the ONE normalised byte (the editor pads its caret with U+00A0); the indent before it, the
// option text, the footer and the separators are compared exactly.
const caretPadding = (row: string): string => row.replace(/^( *)❯ /, "$1❯ ");
const blank = (line: string): boolean => line.trim() === "";

/**
 * Bottom-anchored: after the LAST line carrying the exact fingerprint, the frame's final non-blank block is exactly the
 * two captured option rows (in captured order, `selected` marked), one empty separator and the captured footer as the
 * last non-blank line, preceded by an empty separator, with no other `❯` between the question and those rows. A later
 * modal (the stacked MCP frame) or question prose alone (no option block) never satisfies it; neither does a substring.
 */
export function claudeTrustSelection(frame: string, selected: "no" | "yes"): boolean {
  if (CLAUDE_TRUST_DIALOG.kind === "none") return false;
  const lines = frame.split("\n");
  let question = -1;
  for (let i = lines.length - 1; i >= 0 && question < 0; i--) if (lines[i]!.includes(CLAUDE_TRUST_DIALOG.fingerprint)) question = i;
  if (question < 0) return false;
  let end = lines.length - 1;
  while (end > question && blank(lines[end]!)) end--;
  const first = end - 3; // [no row, yes row, "", footer]
  if (first - 1 <= question) return false;
  const rows = selected === "no" ? CLAUDE_TRUST_OPTION_ROWS.noSelected : CLAUDE_TRUST_OPTION_ROWS.yesSelected;
  return lines[end] === CLAUDE_TRUST_OPTION_ROWS.footer && lines[end - 1] === "" && lines[first - 1] === ""
    && caretPadding(lines[first]!) === rows[0] && caretPadding(lines[first + 1]!) === rows[1]
    && !lines.slice(question + 1, first).some((line) => line.includes("❯"));
}

/** Never throws: every send and read failure becomes an explicit outcome. */
export async function answerTrustDialog(o: TrustAnswerOpts): Promise<TrustAnswer> {
  if (!isClaudeTrust(o.dialog)) return submit(o); // every other adapter: its existing single declared key, sent once
  // Cursor already on Yes (uncaptured), unknown order, an older frame or a stacked modal: no speculative key at all.
  if (!claudeTrustSelection(o.frame, "no")) return refused("trust selection not the captured No-then-Yes frame");
  if (Date.now() >= o.deadline) return refused("startup deadline expired before Down");
  try { await o.sendKey("Down"); }
  catch (e) { return refused(`Down not delivered: ${message(e)}`); }
  for (;;) {
    let after: string;
    try { after = await o.read(); }
    catch (e) { return refused(`read-back unreadable: ${message(e)}`); }
    if (Date.now() >= o.deadline) return refused("startup deadline expired before Yes was proven");
    if (claudeTrustSelection(after, "yes")) break;
    // Only the ORIGINAL frame, still unchanged, may settle; anything else is a changed modal.
    if (after !== o.frame) return refused("read-back did not prove Yes selected");
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(o.pollMs ?? SETTLE_POLL_MS, o.deadline - Date.now()))));
  }
  return submit(o);
}
