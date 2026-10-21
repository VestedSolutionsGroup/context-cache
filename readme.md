# context-cache

A Claude Code mod that puts a countdown chip in the prompt footer: how long the one-hour prompt cache stays warm since the conversation's last request. It does nothing else. It sends no model requests, adds no commands and keeps nothing on disk.

```
plan · 🌗 30m
```

## Install

From a shell:

```sh
claude plugin marketplace add VestedSolutionsGroup/context-cache
claude plugin install context-cache@vsg
```

Or at the prompt of a terminal session, in one step:

```
/plugin install context-cache --marketplace VestedSolutionsGroup/context-cache
```

Then restart Claude Code, or run `/reload-plugins` in an open session.

A plugin installed from a terminal at the user scope also loads in the sessions the desktop app starts for its Code tab.

## What it shows

In the terminal and the desktop app the chip sits in the prompt footer, after Claude Code's mode labels, as a moon phase and the minutes left:

- `🌝 60m`, then `🌖`, `🌗`, `🌘` and `🌚` at the nearest quarter of the hour left
- seconds, such as `🌚 0:42`, in the last minute
- `💀 Cold` once the hour lapses

The label stays dim until the last fifth of the hour, when it takes the theme's warning color. Under a nonempty `NO_COLOR` it uses monochrome ring glyphs instead (`●`, `◕`, `◑`, `◔`, `○` and `◌`) and turns bold rather than colored. `NO_COLOR` is read once, when the session starts.

It redraws at each 30-second step of the ring and each second of the last minute.

## When the clock restarts

- **Each request of the main conversation that gets a response.** The clock starts when the request goes out, not when the turn ends, so a long turn does not overstate the time left. A request that fails before any response (no connection, API errors until the retries run out) leaves the clock as it was, and so does a subagent's request. A response you interrupt with Esc still counts.
- **Each compaction** of the main conversation, `/compact` or automatic, so the chip shows `🌝 60m` straight after it rather than waiting for the next turn. Only a compaction that sends its own summary request counts: one that a hook skips or answers, a summary the engine only computes ahead of time, and a compaction that installs such a summary later change nothing.
- **A resumed or forked session** starts the clock at its last response, so it shows the time left, or `💀 Cold`, before any turn.
- **`/clear`** hides the chip until the next request.

The chip appears after the session's first request. Loading a new version of the mod (an update, then `/reload-plugins`) starts it over, so the chip hides until the next request.

## Limits

- It is a clock, not a check of the server's cache. It assumes a one-hour cache lifetime, and keeps one clock for the conversation whatever the model: after a switch to another model and back, it counts from the other model's request, although each model has a cache of its own. Included subscription usage has a one-hour main cache by default; other billing paths need [`promptCacheTtl`](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) set to `"1h"`, or the chip will overstate the time left.
- It draws in the terminal and in the desktop app. Claude Code raises its footer on those two surfaces only, so there is no chip in VS Code or on mobile.
- Its tests pass on Claude Code 2.1.287, 2.1.295, 2.1.299, 2.1.304 and 2.1.306, and it was tried live in a terminal on 2.1.299 and 2.1.306. The tests check what the mod draws on each surface, not how the desktop app paints it.

## Developing

```sh
claude plugin validate .
claude plugin test .
```

The engine writes the API's types into `.claude-plugin/types/` when it loads the mod from a folder; with them there, `tsc -p .` type-checks the hooks and the tests.
