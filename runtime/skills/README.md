# Duty Platform Skill Runtime

This directory vendors the two user-provided Skill archives so the duty platform can run without depending on a developer's `~/.codex/skills` directory.

- `full/sr-dev/`: the full warehouse Skill bundle, including Skill definitions, packs, contracts, semantic assets, and helper scripts.
- `standalone/sr_box/`: the standalone production SR Box client used by the web runtime and anomaly verifier.

The SR Box client is restricted by two layers:

1. The duty platform only exposes read-only SQL actions.
2. `sr_gateway_client.py` applies its own SQL guardrails before calling the production gateway.

SSO session files and API keys are never stored in this repository. Complete SSO once on the deployment host:

```bash
python3 runtime/skills/standalone/sr_box/scripts/sr_gateway_client.py sso login
```

The production gateway defaults to `https://data-map-dev.kuainiu.io`.
