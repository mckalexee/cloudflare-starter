# How to work

This guide is for a coding agent that changes this project. It describes how to take a request
from an idea to a pull request: investigate, plan, review the plan, play it back, implement, and
deliver. The phases exist because a plan that's written and checked before any code catches
mistakes while they're cheap to fix.

## When the phases apply

A change that one sentence describes fully and that touches a few files goes straight to
[Implement](#5-implement): a typo, a copy change, one small bug. Everything else goes through
every phase, in order. When you're unsure which kind a change is, use the phases.

## The main thread directs

The main thread is the conversation with the person. Its job is to hold the goal, the plan, and
the decisions, and to keep the work on track from the first question to the pull request.

- **Delegate the work that fills context.** If your harness has subagents, give them the reading
  across many files, the research, the implementation, and the reviews. A subagent is a fresh
  agent with its own context that you brief and that reports back. Keep the conclusions, not the
  file contents, so that your own context stays free for decisions.
- **Check work against the plan.** Before you delegate a task or accept its result, compare it
  with three short lists in the plan: the goal, what the person decided, and what's out of scope.
  Work that serves none of them doesn't go in.
- **Stay simple.** Prefer what the project already has over anything new: its bindings, its
  helpers, its checklists in `AGENTS.md`. Add a dependency, a service, or an abstraction only
  when the goal needs it.
- **Treat reports as claims.** A subagent's report is something to verify, not a fact. Read the
  diff and run the checks yourself before you build on it.

If your harness has no subagents, run the same phases yourself, in order. For each review, read
the plan or the diff again from the start, as someone who hasn't seen your reasoning.

## 1. Investigate

Investigate until you're 95% sure that the person would read your description of the result and
say "yes, that's it".

- **Sort each open question into fact or intent.** A fact is something that the code, the
  installed packages, the documentation, a command, or the accounts can tell you. Research facts
  yourself, and never ask the person for one. Intent is what the person wants and prefers. Ask
  the person about intent, and never guess it.
- **Ask one question at a time.** Use your structured question tool when you have one. Offer
  options, and mark the one that you recommend and why. Without such a tool, ask the one question
  in a message and wait for the answer. Never bury a question in a status update.
- **Test whether you're done.** Write the playback from [Play back](#4-play-back). Every sentence
  that you had to guess is a question that you haven't asked yet.
- **Write down what you learn.** Put the goal, each decision, and each open point in the plan
  file as you go. A session that's compacted or restarted then loses nothing.

## 2. Plan

Write the plan to `.plans/<topic>.md` before you write any code. Git ignores `.plans/`, so the
plan is a working file that subagents can read and that never reaches a commit. The pull request
description carries what a reader of the change needs.

The plan holds:

- **Goal.** What the person gets, in two or three sentences.
- **Decided with the person.** Each choice that the person made, in their words where you can.
- **Out of scope.** What you won't build, so that nobody adds it later.
- **Approach.** How the change works and which files it touches. Verify each claim about the
  code or a library against the version that this project uses.
- **Tasks.** Units that one subagent can finish without a decision from you. Each task names its
  files and the check that proves it.
- **Verification.** How you'll show that the whole change works, beyond `pnpm verify`.

## 3. Review the plan

A review finds what the plan missed. It can also do harm: a reviewer can report a problem that
doesn't exist, and a plan that absorbs every finding grows and drifts away from what the person
asked for. So the reviewers find, and the main thread decides.

**Set up the review.**

- Give each reviewer the goal and the path of the plan file. Don't give your reasoning, and
  don't say what you hope to hear. A reviewer that starts from your conclusion confirms it.
- Give each reviewer one lens. Use two or three reviewers, sized to the plan:
  - **Does it work here?** Each step, against this code and the installed versions.
  - **Who can see or change what?** Sign-in, per-user data, secrets, and what a Preview does to
    production data.
  - **Is it the right size?** What the goal needs that the plan lacks, and what the plan has
    that the goal doesn't need.
- Ask for findings with evidence: a file and line, the output of a command, or a link to
  documentation, plus what breaks. Reviewers report. They don't rewrite the plan.
- Tell each reviewer what's fixed: the list of what the person decided isn't open for review,
  and a missing feature isn't a finding.

<!-- @starter:web -->

For a plan that adds or changes a page, the second lens includes this question: on a private
site, which pages can someone open without signing in, in production and on a Preview?

<!-- @starter:end -->

**Decide on each finding.** Check the evidence yourself: open the file, run the command, read
the page. Then choose one of three outcomes.

| The finding                                              | What you do                                        |
| -------------------------------------------------------- | -------------------------------------------------- |
| Holds, and the result would be wrong, unsafe, or lacking | Change the plan.                                   |
| Doesn't hold, or is a preference                         | Drop it, and note the reason in one line.          |
| Touches what the person decided, or changes what's built | Ask the person. Don't change the plan on your own. |

- A finding isn't true because a reviewer said it, or because two reviewers said it.
- Run one round. Run a second round only when the approach changed, and only on the part that
  changed. Repeated reviews make a plan longer, not better.
- Record the outcome in the plan file: the findings that you accepted and the ones that you
  dropped, one line each.

## 4. Play back

Before you implement, tell the person in a few plain sentences:

- What you'll build.
- The choices in the plan that affect them, and why you made each one.
- What you're leaving out.

Then ask one question: is this right? On a yes, implement. On a no, go back to the phase that
the answer changes, and play the plan back again when it's ready. Keep the technical detail in
the plan file, and offer its path.

## 5. Implement

**Brief each task so that it stands alone.** Give one task to one fresh subagent. The subagent
knows only what the brief says, so the brief has:

- The goal, in a sentence.
- The path of the plan file, and which task this is.
- The files to change, and the rules to follow: `AGENTS.md` and the guides that it links.
- The check that proves the task, which always includes `pnpm verify`.
- What's out of scope.
- What to report: what changed, the output of the checks, and anything that the plan didn't
  expect.

A subagent that hits an open question returns it to you. It doesn't guess, and it never asks the
person.

**Keep the tasks apart.** Run tasks that touch the same files one after another. Run tasks in
parallel only when each has its own working copy, such as a Git worktree, and its own dev server
port: `pnpm dev --port <n>`.

**Verify each result.** When a task comes back, read the summary of its diff, read the parts
that carry risk in full, and run `pnpm verify` yourself. Then mark the task in the plan. A
report that says "done" isn't evidence.

**Keep your own edits small.** Make a small fix directly. For anything larger, write a brief for
a fresh subagent, and name the files, so that it starts with a small context.

**When the code contradicts the plan, stop.** Change the plan first, then continue. If the
change affects what the person gets, ask them before you go on.

**Review the result before the pull request.** Give fresh reviewers the plan and the diff. One
checks that the diff does what the plan says and nothing more. One looks for defects. Treat
their findings as in [Review the plan](#3-review-the-plan): evidence first, and you decide.

<!-- @starter:web -->

For a page, look at it in a browser when your harness has one, signed in and signed out.

<!-- @starter:end -->

## 6. Deliver

1. Run `pnpm verify` until it passes, then commit and push the branch.
2. Open a pull request. Describe what changed and why, for someone who hasn't read the plan.
3. Wait until the pull request's checks pass. The Preview workflow deploys a Preview and
   comments its URL.
4. Give the person the pull request and the Preview URL, and say what to look at.

Merging deploys to production, so the merge is the person's to make. Don't merge unless they
ask you to.

If `AGENTS.md` has a **What to build** section and the work changed what it says, update the
section, or delete it once it stops helping.
