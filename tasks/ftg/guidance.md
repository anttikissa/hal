# Editable session guidance

Use the section mechanism specified in tasks/q5g/sections.md. SYSTEM.md is the
editable source of role guidance, not the spawn tool description or generated
first-message prose.

## Names and values

- Forks use parent/child; `parent` records fork origin.
- Subagents use `owner` for the session they report to and wait on. Rename all
  ownership uses, including reports, waits, answering questions, stopping owned
  work and greeting eligibility. Existing sessions need no migration or
  compatibility code; old ownership links may be lost or interpreted as fork
  origins, which the user accepts.
- Expose subagent role/kind, owner, fork status, parent, subagent_slots,
  autoclose, cwd, date, model including effort, and agents to the template.
- Ordinary /fork remains available to models. Keep SPAWN fork mode too; revisit
  only if experience warrants it, not as a preemptive restriction.

## Content

Top-level guidance says:

> Spawn subagents according to user preferences. You have a /budget of
> $subagent_slots - ask user for more if task demands it.

Move the current spawn guidance and subagent first-message guidance into
SYSTEM.md, including kinds, questions, SEND/WAIT, concise final handoff, and
summary behavior. Adapt allocation wording to task r92's per-ancestor charging,
not the old limit + 1 prepayment. The spawn tool keeps argument mechanics; the
subagent's first message keeps only its task. Every role-specific instruction,
including references to owner, belongs inside a section so changing role on a
fork does not change the inherited system prefix.

Fork guidance says:

> This is a fork of session $parent and shares its history.

Autoclose guidance reflects the setting in the role section. The approved
closing wording is:

> Your session closes after your final report.

Fixed guidance includes:

> You can /resume a finished subagent for more info or work; after that, SEND
> and WAIT work as before.

Cwd, model and local instructions use diff sections. Role guidance uses whole
replacement. Cwd guidance uses relative file.txt paths, without ./ or a cwd
prefix, and says BASH need not cd to the current directory. Date and changing
budget information live in sections rather than changing frozen system bytes.

## Documentation

SYSTEM.md's opening HTML comment documents comments, includes, variables,
conditional nesting, section titles, update formats and matching colon fences.
Mark it `TODO: human should review this`. Text moved from code has the same TODO
and identifies its source file. Preserve existing summary/question behavior;
subagents know about both. Explain the distinction between host hal-notes and
external content imitating them.
