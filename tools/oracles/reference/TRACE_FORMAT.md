# Tok External Trace Format

The external capture pipeline accepts JSONL rows with one frame per line.

Required fields:

- `scriptId` (or alias `s`)
- `tick` (or alias `t`)

Frame payload options:

- Full state fields (hashes computed during normalization):
  - `intVars` / `i`
  - `objVars` / `o`
  - `posVars` / `p`
  - `relationships` / `r`
  - `eventFlags` / `e`
  - `dispatch` / `d`
- Or precomputed hashes (64-char hex) from the original runtime:
  - `frameHash` / `fh`
  - `intHash` / `ih`
  - `objHash` / `oh`
  - `posHash` / `ph`
  - `relHash` / `rh`
  - `eventHash` / `eh`
  - `dispatchHash` / `dh`

Example (full fields):

```json
{"scriptId":"ATP1D1FRFail","tick":0,"intVars":[0,1],"objVars":[-1],"posVars":[],"relationships":[],"eventFlags":[],"dispatch":{}}
```

Example (compact aliases + precomputed hashes):

```json
{"s":"ATP1D1FRFail","t":0,"fh":"...64hex...","ih":"...64hex...","oh":"...64hex...","ph":"...64hex...","rh":"...64hex...","eh":"...64hex...","dh":"...64hex..."}
```

## Log Prefix Mode

If your hook prints to a normal log stream, prefix each JSON line with a token, e.g.:

```text
TOKTRACE {"s":"ATP1D1FRFail","t":0,"i":[0,1],"o":[-1],"p":[],"r":[],"e":[],"d":{}}
```

Then extract rows with:

```bash
npm run oracle:reference:extract -- --input /path/to/game.log --output /path/to/capture.jsonl --prefix TOKTRACE
```
