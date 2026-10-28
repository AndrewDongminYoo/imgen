# Offline Filesystem Secret Reader

## Scope

Use the independently reviewed filesystem SARIF reader and ten standard-library CLI regressions.
Keep decoded findings at file level when literal source positions are unavailable.
Retain detector IDs, omit secret values from messages and reject malformed input without partial clean output.
Use explicit `--no-verification --no-update`, the local parser and `direct_configs`.
Keep Pinact `4.1.1!` with both commands and preserve existing product inputs and scanner selection.
Add the exact reader test to the ordinary validation workflow.

## Acceptance

- Ten CLI regressions pass.
- Actual configured encoded/literal controls fail and the clean control passes.
- Full uncached no-fix Trunk passes.
- Application and dependency inputs remain unchanged; retained prior application evidence is clearly qualified.
- Affected knowledge and independent reviews have no unresolved blocker.

## Publication

Prior PR approval covers the completed cycle only.
Request fresh repository-specific push and PR approval after local verification.
