# First session

Use an empty exercise folder. Install your harness plugin using the [installation guide](../how-to/install.md), then create a disposable Kata project:

```sh
scratch=$(mktemp -d)
export KATA_HOME="$scratch/store"
unset KATA_SERVER KATA_DAEMON KATA_AUTH_TOKEN KATA_REF KATA_TEAMMATE KATA_INBOX_USER KATA_SESSION_ID
mkdir "$scratch/workspace"
cd "$scratch/workspace"
git init -b main
kata init --project example
```

Set a Git identity if one is not already configured. Keep this environment in the terminal that launches the harness.

## Oh-my-pi

Start OMP 19.1.1 or later and pick Kata under `/settings` → Tools → Todos → Todo Backend; nothing else needs configuring. To see the default-project behavior, run it in a folder with no Kata project: the plan lands in the project registered for the folder, or in `KATA_DEFAULT_PROJECT` labeled with the folder name. Ask: “Use todo to plan two tasks: implement a small function, then test it. Before marking each task done, close its Kata issue with `kata close` and a substantive message and passing test or commit evidence. Let the plugin close the automatic parent.”

Use `/todo` to see omp's list. A `todo done` on a task whose Kata issue is still open is refused with the `kata close` command to run, so a task stays unfinished until Kata accepts its close. Once both children are closed, inspect `kata list --status all` and `kata show <parent-ref>`.

## Pi

Start pi with the package loaded. Ask: “Use todo to plan two tasks: implement a small function, then test it. Complete each task with a substantive message and passing test or commit evidence. Let the plugin close the automatic parent.” `/todo` is supplied by this plugin. If the assistant stops with actionable work remaining, a bounded hidden reminder can request continuation. Pi tracks the child pi processes it starts; it has no other subagent concept.

Inspect the closed children and automatic parent with `kata list --status all`. Explicit `KATA_REF` parents remain manually managed in every harness.

## Finish

Exit the harness, then run `kata daemon stop` with the same throwaway `KATA_HOME`. Keep or remove the exercise directory when you no longer need the records.
