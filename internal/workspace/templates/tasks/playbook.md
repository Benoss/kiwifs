# Task Playbook

You are managing a task board. When connected via MCP, use these
operations to find work, track progress, and manage dependencies.

## Quick Start

1. Call `kiwi_context` to get this playbook + schema + task index
2. Call `kiwi_query` to see available tasks
3. Use the operations below to work through them

## Find Available Work

Query for tasks ready to be picked up, ordered by priority:

```
kiwi_query("TABLE _path, title, priority, effort, tags WHERE type = 'task' AND status = 'todo' AND _blocked = false SORT priority ASC")
```

To see all tasks across all statuses:

```
kiwi_query("TABLE _path, title, status, priority, effort, assignee WHERE type = 'task' SORT priority ASC, _updated DESC")
```

To find blocked tasks:

```
kiwi_query("TABLE _path, title, blocked-by WHERE type = 'task' AND status = 'blocked'")
```

To view an epic's sub-tasks:

```
kiwi_query("TABLE _path, title, status, effort WHERE parent = 'tasks/epic-slug.md' SORT priority ASC")
```

## Claim a Task

Before starting work, claim the task to prevent double-work:

```
kiwi_claim(path: "tasks/my-task.md", lease_duration: "30m")
```

This sets `claimed-by`, `claimed-at`, and `lease-expires` in the
frontmatter. Other agents will see the task is claimed and skip it.

## Work on a Task

1. `kiwi_read` the task file to understand requirements and acceptance criteria.
2. Set status to `in_progress`:
   ```
   kiwi_write("tasks/my-task.md", updated_content)
   ```
   Always include `X-Actor: your-agent-name` to track who made changes.
3. Do the work described in the task.
4. Check off acceptance criteria as you complete them.

## Complete a Task

1. Verify all acceptance criteria are met.
2. Set `status: review` if the task needs human approval, or
   `status: done` if it's self-verifiable.
3. Completing a task may automatically unblock dependent tasks —
   the system checks `blocked-by` references.

## Handle Blockers

When you can't proceed:

1. Set `status: blocked` in the task frontmatter.
2. Set `blocked-by` to the list of task paths that need to complete first:
   ```yaml
   status: blocked
   blocked-by:
     - tasks/prerequisite-task.md
   ```
3. Move on to the next available task.
4. When blockers are resolved, set `status: todo` to re-enter the queue.

## Create a New Task

```
kiwi_write("tasks/<slug>.md", content)
```

Use this frontmatter:

```yaml
---
type: task
title: "Short description of what to do"
category: feature
status: todo
priority: 2
effort: m
assignee: ""
tags: [area, topic]
---
```

Include acceptance criteria in the body. See SCHEMA.md for the full
field reference, priority scale, and effort scale.

### Create an Epic

For large work that decomposes into multiple tasks:

```yaml
---
type: task
title: "Epic: User Authentication"
category: epic
status: in_progress
priority: 1
tags: [auth, security]
---
```

Then create sub-tasks with `parent: tasks/epic-slug.md`.

## Bulk Operations

### Triage uncategorized tasks

```
kiwi_query("TABLE _path, title WHERE type = 'task' AND priority IS NULL")
```

Review each and set appropriate priority, category, and effort.

### Find stale in-progress tasks

```
kiwi_query("TABLE _path, title, claimed-by, claimed-at WHERE type = 'task' AND status = 'in_progress' SORT _updated ASC")
```

If a task has been in-progress for too long with no updates, check
if the claim has expired and re-assign.

### Check epic progress

```
kiwi_query("TABLE parent, count(_path) AS total, count(CASE WHEN status = 'done' THEN 1 END) AS completed WHERE parent IS NOT NULL GROUP BY parent")
```

### Archive completed tasks

Move done tasks to keep the board clean — one plan, one commit, links kept:

```
kiwi_refactor_plan(manifest: "moves: [{from: tasks/done-task.md, to: tasks/done/}]")
kiwi_refactor_apply(manifest: <same>, digest: <from the plan>)
```

## Maintain

Run periodically:

1. `kiwi_lint` with `path` — check individual files for structural issues.
2. Find tasks without effort estimates:
   ```
   kiwi_query("TABLE _path, title WHERE type = 'task' AND effort IS NULL AND status != 'done'")
   ```
3. Find `xl` tasks that should be split:
   ```
   kiwi_query("TABLE _path, title WHERE type = 'task' AND effort = 'xl' AND category != 'epic'")
   ```
4. Check for stale claims (expired leases).
5. Verify blocked tasks still have valid blockers.

**Best practice:** After every `kiwi_write`, call `kiwi_lint` on the same path.

## Quality Rules

- **Every task has `type: task`** in frontmatter — required for Kanban and DQL.
- **Set `X-Actor` on every write** — track who made changes.
- **Claim before starting** — prevents double-work in multi-agent setups.
- **Include acceptance criteria** — agents need clear "definition of done."
- **Use `blocked-by` for dependencies** — don't leave implicit blockers.
- **When done, mark `done`** — this may unblock downstream tasks.
- **Estimate effort** — every task should have an `effort` size.
- **Categorize work** — use `category` to distinguish features from bugs from chores.
- **Respect the DoD** — review the Definition of Done before marking complete.
- **Split `xl` tasks** — if effort is `xl`, decompose into an epic with sub-tasks.
