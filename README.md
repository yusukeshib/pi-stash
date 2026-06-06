# pi-stash

A personal stash of reusable prompt fragments for the [Pi coding agent](https://pi.dev).

Jot a prompt down whenever you think of it mid-task, then pop it into the editor
when you actually need it. Think of it as a stack-like scratchpad for prompts —
the ad-hoc, mutable companion to static prompt templates.

![pi-stash pop menu](./assets/demo.png)

## Install

```bash
pi install npm:pi-stash
```

## Commands

| Command | Action |
|---------|--------|
| `/stash <text>` | **Push** — save the given text onto the stash. |
| `/stash` | **Pop** — pick a saved entry, insert it into the editor, and remove it from the stash. Run repeatedly to stack several fragments together. |
| `/stash-clear` | Delete every stashed entry (with confirm). |

## How it works

`pi-stash` is not a set of predefined `/name` templates. It is a backlog you
build up by hand during real work:

1. While working, you think "I should also ask it to update the docs" — instead
   of derailing now, run `/stash update the docs and changelog`.
2. Later, when you're ready, run `/stash`, pick that entry, and it drops into
   the editor. The entry is popped (removed) so the stash stays current.
3. Pop multiple entries in a row to compose a larger prompt from fragments.

## Storage

Entries live in a single global JSON file, **shared across every Pi session on
the machine** (not per-project, not per-session):

```
~/.pi/agent/prompt-stash.json
```

Override the location with the `PI_STASH_PATH` environment variable:

```bash
export PI_STASH_PATH="$HOME/.config/pi/stash.json"
```

> Note: the store is read-modify-written on each command. If two sessions edit
> the stash at the exact same moment, the last write wins.

## License

MIT © yusukeshib
