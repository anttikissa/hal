I wrote two coding agents

They are in ../.hal9001 and ../.hal9002 

Read those both - I've analyzed those, read machine-findings.md and human-findings.md from both.

I want you to combine the strengths of those projects and make me a new coding agent in this directory from scratch.

Suggest what to implement now, what to implement later. Write a plan.md first.

Interrogate me for what I want first. I think .hal9001 is a better starting
point as it has more functionality, but here's an opportunity to reorganize it.

Must haves:
- must support Claude Code using OAuth token 
- must support Codex 5.3 using OAuth token
- Minimal and lean architecture
- A minimal amount of tests that I can run manually
- CLI tool should work and support session structure roughly like .hal9001 does

Some files you can just copy over, like ason (it's battle tested)

Others - rewrite from scratch to fit the new architecture.

Oh - can you switch the code style from spaces to tabs (width 4)? My IDE likes that.

You can pick up access tokens from ./.hal9001/.env and copy them over to this
project (but I'd prefer gitignored config.ason or something instead of .env) -
they should work.

