# MiniMax H3 gateway

Current complete installation and configuration: [docs/H3.md](../../docs/H3.md).

`fasth3_gateway.py` is the authoritative fixed-graph validator/dispatcher; `workflow_api.json` is its template. `test_fasth3_gateway.py` validates both current film-plan and legacy graph contracts without generating video. Current generation uses full INT8, Acc 8 steps, Euler, CFG 1, 1344×768 at 24 fps, with neither external LoRA nor Motion Context.
