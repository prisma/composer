---
name: multiline-commit-messages
description: >-
  Use single-quoted strings for multiline git commit messages in the Shell tool.
  Prevents heredoc escaping failures that produce garbled commit messages.
---

# Multiline commit messages

The Shell tool sends commands as a single string. Heredoc syntax (`<<'EOF'`) inside `$(cat ...)` is fragile and can fail silently — the literal `$(cat <<'EOF' ...` ends up as the commit message instead of the intended text.

## Rule

Prefer single-quoted strings with embedded newlines over `$(cat <<'EOF' ...)`:

```bash
git commit -s -m 'short summary line

Longer body paragraph explaining why the change exists.
Additional context if needed.'
```

## Why heredocs are fragile

The Shell tool passes the command as a single string argument. When you write:

```bash
git commit -m "$(cat <<'EOF'
message
EOF
)"
```

the `EOF` delimiter, newlines, and nested quoting can interact unpredictably, and the result is the raw `$(cat <<'EOF' ...` text appearing as the commit message.

Single-quoted strings with literal newlines are simple, portable, and always work. If the message itself must contain a single quote, close and reopen the quote (`'\''`) or fall back to a temp file passed via `-F`.

## Sign off

Every commit still needs its `Signed-off-by` trailer — see [git-staging](../../../.cursor/rules/git-staging.mdc). Pass `-s` on the same `git commit` invocation.
