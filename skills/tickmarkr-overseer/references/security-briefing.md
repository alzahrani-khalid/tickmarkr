## Briefing a seat to audit a security-shaped check — phrasing matters

**Earned 2026-08-04.** A consult seat was asked to *"hunt one more forged pass"* on an authorization gate.
Its provider cut the session off mid-work — *"We take extra caution with cybersecurity requests"* — and the
report was never written. The seat had already found the real defect (a timezone-dependent clock) and that
finding was recovered only by reading its pane before closing it.

**The work is legitimate; the framing is what trips the filter.** Ask for completeness, not exploitation:

- ✗ "find a forged pass", "bypass this", "attack the gate", "how would you defeat it"
- ✓ **"enumerate every input this check depends on, and confirm each one is bound"**
- ✓ "which of these inputs can a caller still control?"
- ✓ "state what this check does NOT establish"

That phrasing produces the same findings — the timezone hole IS an unbound input — without asking a model to
generate an attack. **And read the pane before closing a seat that ended without its artifact:** a refusal
mid-work leaves real findings in the transcript and nowhere else, which is the one case where the pane, not
the report, is the deliverable.

