# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in tickmarkr, **do not open a public GitHub issue**. Report it privately through GitHub only:

Use [GitHub's private vulnerability reporting feature](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on the [tickmarkr repository](https://github.com/alzahrani-khalid/tickmarkr).

## Security Scope

tickmarkr's trust model is intentionally asymmetric. The operator trusts the repository and its
source, the spec being compiled, tickmarkr configuration, installed agent CLIs, and the worker,
judge, review, and consult processes they start. Those processes are trusted to run, but tickmarkr
does not trust their textual success claims.

Worktrees provide change separation only: each task gets its own git worktree, branch, and diff. They
do not sandbox processes or contain the operator's machine. Workers run with the operator's OS
privileges and inherit the environment. CLI bypass/approve/force modes therefore apply with that
same authority; tickmarkr only strips its Herdr control-plane variables from worker children.

- **Trusted code**: Spec-provided command oracles, config `setup`, and configured gate commands are
  trusted code executed verbatim through the shell. Compiling and running a spec from elsewhere is
  running code from that source. These fields are executable by design.
- **Independent verification**: Tickmarkr distrusts worker, judge, and reviewer claims and verifies
  committed diffs from git. The scope gate derives changed paths from git and compares them with the
  declared scope; worker-declared deviations are only audit notes.
- **Shell boundary discipline**: Spec-derived branch/ref values are branch-safe-validated where
  applicable or `shq`-quoted at shell boundaries. This protects argument boundaries; it does not
  turn the trusted command fields above into data.

### What is guaranteed

**Merged-artifact integrity.** Fail-closed gates re-derive everything they verify from git. A merge
checks that the task branch still equals the gated commit, merges that gated hash rather than a
mutable branch name, and strictly re-verifies the integration tip with the configured gate commands.

### What is not guaranteed

- **The operator's machine during a run**: Workers, setup, and gate commands can act with the
  operator's privileges and access the environment, filesystem, network, and resources available to
  that OS user. A worktree is not a containment boundary.
- **The journal**: It is a local execution log for replay and reporting, not a tamper-evident audit
  trail. Anyone with filesystem access to the run directory can alter it.

If you believe a change introduces a security regression, report it privately as above.

## Supported Versions

The latest version of tickmarkr (published on npm) receives security updates. Older versions are not actively maintained.

## No Bug Bounty Program

tickmarkr does not offer monetary rewards for vulnerability reports. Reporters are credited in the relevant security advisory once a fix is published.
