# patches/

Our changes to upstream cores, kept as patches so the `cores/<id>` submodules are never edited.
Currently only `patches/lichii/` is used by `node scripts/build-cores.mjs lichii`.

- Format: `git diff` output (a/ and b/ prefixes), one or more `*.patch` files, named `NNNN-short-name.patch`.
- Order: lexical by file name, so `0001-...` applies before `0002-...`. Each patch is `git apply --check`ed first; a failure names the patch and fails only the lichii core.
- Build: sources are copied to `bin/.build/lichii-patched` (without `.git`/`build`), patched there, and built in `bin/.build/lichii` (stable, so ccache and incremental builds work). An empty or missing folder means the plain `cores/lichii` build.
- Regenerate from the scratch copy: `git -C bin/.build/lichii-work diff > patches/lichii/NNNN-name.patch` (the scratch copy must be a git checkout at the same commit as `cores/lichii`).
- Env switches: `LICHII_SRC=/abs/path` (source other than `cores/lichii`), `LICHII_BUILD_TYPE=Release|RelWithDebInfo` (the latter builds in `bin/.build/lichii-relwithdebinfo`), `LICHII_BUILD_TAG` (default `uemulator-local`), `LICHII_BUILD_CLI=1` (also build and bundle `eden-cli`).

## rejected/
Patches that were built and measured, then dropped. Files in `patches/lichii/rejected/` are not applied (only `*.patch` directly in `patches/lichii/` are).
- `0006-oot-skip-heavy-dispatch.patch`: with OoT's "No sharpening" on, also skip the unused heavy dispatch (`d9ee412f00ce399a`). Replay, resolution x0.5: 35.1 ms median with the dispatch kept vs 36.7 ms skipped, so no gain; not worth the risk of a visual change.
- `0007-bench-screenshots.patch` (kept, applied) adds `EDEN_BENCH_SHOT_SECONDS` for screenshots at fixed replay times.
