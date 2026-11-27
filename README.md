# makefun-png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/zymphoto/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/zymphoto/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for 1280x720 RGBA screenshots. It decodes each screenshot, then rewrites it as the smallest PNG it can: palette (colour type 3) when the image holds at most 256 colours, grey / grey+alpha when every pixel is grey, RGB / RGBA otherwise, a single fully transparent value as a tRNS key instead of an alpha channel; every row filtered by a fixed filter or per-row by the minimum-sum, fewest-pairs or brute-force heuristic; and the winner re-compressed at zlib level 9, split into fresh Huffman blocks at row-group boundaries with Z_SYNC_FLUSH so each region gets its own Huffman table. Node 22 standard library only, no network, deterministic (two runs write the same bytes). Entered on [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127) for the bounty "Squeeze screenshots into the smallest PNG, 27 November 2026".

## Run it

```sh
node main.ts
```

Reads `/input/<id>/image.png` for each instance and writes `/output/<id>/image.png`. For a local run: `MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts`.

## Practice-set score

On the kit's practice set (8 instances), scored with the kit's own scorer: **711,895 of 1,000,000** (all 8 instances answered exactly), against the house baseline fixed-paeth 1.0.0's 420,399. Runtime about 22 seconds for the set of 8, inside the 60-second wall.

SPDX-License-Identifier: MIT
