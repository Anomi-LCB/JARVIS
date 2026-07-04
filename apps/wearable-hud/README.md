# JARVIS Wearable HUD Adapter

This adapter is the glasses-facing surface for the JARVIS A-G runtime. It assumes the glasses are a constrained voice + monochrome green HUD device, while Core, Policy/Security, Bridge, PC Agent, Memory, and Verification remain on the local runtime.

The adapter is intentionally compact:

- Voice input is normalized into safe intent objects with transcript hashes and redacted previews.
- HUD output is limited to a small number of short monochrome lines.
- High-risk approvals are never silently approved on glasses; they route to PC confirmation.
- Raw bridge tokens, raw voice transcripts, and raw secret material are not stored in reports.
- Product-gate and release-dossier helpers make the adapter part of the same evidence chain as C/D mobile and bridge.

## Field kit

Generate the browser-ready package:

```bash
npm run wearable:field-kit
```

Launch it for glasses or a mirrored display:

```bash
node dist/wearable-hud-field-kit/field-server.mjs --host 0.0.0.0 --port 4176
```

The field client uses the browser Fetch API and Web Speech API when available. Korean-first labels are the default HUD mode. Tokens are held only in memory, HUD text is redacted and compacted, and Tier 3+ approvals trigger PC confirmation instead of direct wearable approval.
