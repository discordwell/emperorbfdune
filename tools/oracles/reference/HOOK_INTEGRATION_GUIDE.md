# Hook Integration Guide (Original Game Runtime)

This guide maps the capture format to a C/C++ hook implementation (for projects like EmperorLauncher/patch DLLs).

## 1) Generate mission/checkpoint header

```bash
npm run oracle:reference:manifest
npm run oracle:reference:hook-header
```

Generated file:

- `tools/oracles/reference/tok_capture_manifest.generated.h`

It contains:

- `TOK_CAPTURE_MISSIONS[]`
- `TOK_CAPTURE_MISSION_COUNT`
- per-mission checkpoint arrays

## 2) Emit trace rows from hook

Emit one JSON line per captured checkpoint tick using prefix `TOKTRACE`.

Recommended row shape (compact, hash-first):

```text
TOKTRACE {"s":"ATP1D1FRFail","t":0,"mt":80,"fc":81,"fh":"...","ih":"...","oh":"...","ph":"...","rh":"...","eh":"...","dh":"..."}
```

Field notes:

- `s` / `t` required
- `mt` / `fc` should be included (especially for checkpoint-only capture)
- hash fields must be lowercase 64-char hex

## 3) Process captured logs

```bash
npm run oracle:reference:extract -- --input /path/to/game.log --output /path/to/capture_part1.jsonl --prefix TOKTRACE
npm run oracle:reference:merge -- --inputs /path/to/captures --output tools/oracles/reference/tok_capture_merged.jsonl
npm run oracle:reference:progress -- --input tools/oracles/reference/tok_capture_merged.jsonl --strict
npm run oracle:reference:validate -- --input tools/oracles/reference/tok_capture_merged.jsonl --require-all-missions --require-expected-max-tick --require-manifest-checkpoints
node tools/oracles/normalize-reference-jsonl.mjs --input tools/oracles/reference/tok_capture_merged.jsonl --output tools/oracles/reference/tok_mission_oracle.reference.v1.json
npm run oracle:reference:strict
```

## 4) Minimal pseudocode

```cpp
for (int i = 0; i < TOK_CAPTURE_MISSION_COUNT; ++i) {
  auto m = TOK_CAPTURE_MISSIONS[i];
  // load mission m.script_id
  for each tick in [0..m.max_tick] {
    step_game_tick();
    if (!is_checkpoint_tick(m, tick)) continue;
    // compute hash signals from runtime state
    print("TOKTRACE {...json row...}");
  }
}
```
