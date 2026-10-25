# Project context

Hal asks whether to trust a project before using its instructions, skills,
or native plugins. The question appears in terminal and web and defaults
to continuing without project content. Approval includes future changes;
refusal still lets you work in the directory. Empty projects need no question.

The scope is the nearest Git root through the session's working directory.
Outside Git, only that directory applies. Personal instructions and skills
remain available regardless of the project decision.

`hal -p` never asks. `-d` trusts that project for the run without saving
the decision; `--no-trust` leaves project content out. Without either,
only a remembered decision applies. Each run names on stderr the project
files it reads or skips.

Place native plugins in `.agents/plugins/hal/*.ts`. They run in the host
with its full permissions, using the ordinary plugin API. Return cleanup
from setup to release resources. Applicable directories load after trust
and remain active while any open tab needs them. Closing or moving the last
tab removes hooks, stops the loader's watcher, and runs cleanup. Reopening
or restarting the host reloads plugins for remembered trusted open tabs.
`plugins.activateDirectory` and `plugins.deactivateDirectory` are hookable.
Project plugins are not copied through personal plugin sync.

Decisions are stored by canonical project root in
`state/project-trust.ason` under the Hal home. To forget a decision, stop
Hal, remove that project's entry from `projects`, and restart.

Reconciliation follows tab and cwd changes, host startup, and turn entry;
it adds no polling timer or separate reference counter. A newly created
plugin directory is discovered on the next turn or navigation. Files in
an active directory already use the plugin loader's watcher.
