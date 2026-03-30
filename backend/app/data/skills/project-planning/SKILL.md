---
name: project-planning
description: Parse a PRD, requirements document, or feature description into a structured task list with dependencies and priorities. Trigger when the user wants to plan a project, break down requirements, create a task list from a document, or says things like "plan this project", "break this down into tasks", "create tasks from this PRD".
---

# Project Planning — PRD to Structured Tasks

Transform requirements documents, PRDs, feature descriptions, or high-level goals into an actionable, dependency-aware task list using the enhanced todo system.

## How It Works

1. **Analyze** the input document or description
2. **Decompose** into discrete, implementable tasks
3. **Establish dependencies** between tasks (what must be done before what)
4. **Assign priorities** based on criticality and blocking relationships
5. **Create** the structured task list using the `todo` tool

## Instructions

When the user provides a requirements document, PRD, or feature description:

### Step 1: Read and Understand
- Read the full document carefully
- Identify the core features, components, and requirements
- Note any explicit ordering or phasing requirements
- Identify technical dependencies (e.g., "database schema must exist before API endpoints")

### Step 2: Decompose into Tasks
Break down the requirements into **5-20 tasks** (adjust based on project size):
- Each task should be completable in a single focused session
- Tasks should be specific and actionable (not vague)
- Include both implementation tasks and verification tasks (tests, review)
- Foundation tasks (setup, infrastructure, schema) come first

### Step 3: Establish Dependencies
For each task, identify which other tasks must be completed first:
- Database/schema tasks before API tasks
- API tasks before frontend tasks
- Core features before optional features
- Shared utilities before consumers
- Ensure no circular dependencies exist

### Step 4: Assign Priorities
- **2 (critical)**: Blocking foundation tasks, security requirements, core functionality
- **1 (high)**: Important features, integration points, testing
- **0 (normal)**: Nice-to-have features, polish, documentation

### Step 5: Create Task List
Use the `todo` tool with `scope: "project"` to create the structured list:

```json
{
  "todos": [
    {
      "id": "task-1",
      "content": "Set up database schema for user authentication",
      "status": "pending",
      "priority": 2,
      "dependencies": []
    },
    {
      "id": "task-2",
      "content": "Implement user registration API endpoint",
      "status": "pending",
      "priority": 1,
      "dependencies": ["task-1"]
    },
    {
      "id": "task-3",
      "content": "Create registration form UI",
      "status": "pending",
      "priority": 1,
      "dependencies": ["task-2"]
    }
  ],
  "scope": "project"
}
```

## Output Format

After creating the task list, provide a brief summary:

1. **Total tasks**: Number of tasks created
2. **Critical path**: The longest dependency chain
3. **Ready to start**: Tasks with no dependencies (can begin immediately)
4. **Suggested first task**: Which task to tackle first and why

## Rules

- Always use `scope: "project"` so tasks persist across sessions
- Always assign unique IDs (use descriptive names like "task-auth-schema" or "task-api-users")
- Dependencies must reference existing task IDs (no dangling references)
- No circular dependencies allowed
- Keep task descriptions concise but clear (one sentence)
- Every task should be verifiable — you can tell when it's "done"
- When in doubt about granularity, prefer more granular tasks over fewer large ones
