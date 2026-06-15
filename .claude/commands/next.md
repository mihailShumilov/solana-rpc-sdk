---
description: Find the next red spec and propose an implementation plan
allowed-tools: Bash, Read, Grep
---
Run `npm test 2>&1 | tail -40` to see failing specs. Pick the next module by the
implementation order in the solana-resilience skill. Read its spec and src/ stub,
then propose a concise implementation plan. Do not write code yet.
