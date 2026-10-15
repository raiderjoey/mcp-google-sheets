# Worker source changes ship with tests

- Any change under `src/` comes with a matching change under `test/` that covers the new or changed behaviour.
- Before reporting a task done, `npm run typecheck && npm test` must pass. If either fails, say so and show the output.

This rule loads unconditionally. To scope a rule to a subtree, add YAML
frontmatter such as `paths: ["src/**"]`; it then loads only when a matching
file is read. That is deliberately not used here, because a fresh `src/` file
is often written before any `src/` file has been read.
