# context-cache

A Claude Code mod that puts a countdown chip in the prompt footer: how long the one-hour prompt cache stays warm since the conversation's last request. Send 🔥 on its own and it pings the cache to keep it warm for another hour. It does nothing else: short of a 🔥 it sends no model requests, and it adds no commands and keeps nothing on disk.

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
- **A 🔥 ping that reads the cache**, below.
- **A resumed or forked session** starts the clock at its last response, so it shows the time left, or `💀 Cold`, before any turn.
- **`/clear`** hides the chip until the next request.

The chip appears after the session's first request. Loading a new version of the mod (an update, then `/reload-plugins`) starts it over, so the chip hides until the next request.

## Keeping it warm with 🔥

Send 🔥 on its own, from the terminal, the desktop app or your phone through Remote Control, and the mod sends one ping in its place: the conversation's last request again, with the same model, system prompt and tools and a one-line prompt after it, so it reads the whole cache and keeps it for another hour. The 🔥 never enters the conversation, and Claude's one-word answer is not kept. A line in the 🔥's place says what the ping read:

- `🔥 Read 157k from the cache: warm for another hour`, and the chip restarts at `🌝 60m`.
- `🔥 Read 0 and wrote 157k: the cache had already gone`: it lapsed, or the model changed, before the clock said. The chip stays as it was.
- `🔥 The ping failed (529)`, `🔥 The ping was interrupted` or `🔥 Nothing to ping until the next message` (after a restart, a reload or `/clear`): nothing was read, and the chip stays as it was.

A ping counts as a read when it read the conversation and wrote less than a tenth of what it read, the rule [cache-tax](https://github.com/karanb192/cache-tax) scores its own pings by. A chip at `💀 Cold`, or not yet showing, is not pinged: the ping would pay to write the whole cache again, as your next message will. 🔥 among other words, or with an image attached, is an ordinary message.

A ping is a request, and it costs one: a cache read of the whole conversation, its own few tokens and the model's short answer, which a ping cannot cap. On a subscription it counts toward your usage like any other request.

## Limits

- It is a clock, not a check of the server's cache. It assumes a one-hour cache lifetime, and keeps one clock for the conversation whatever the model: after a switch to another model and back, it counts from the other model's request, although each model has a cache of its own. Included subscription usage has a one-hour main cache by default; other billing paths need [`promptCacheTtl`](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) set to `"1h"`, or the chip will overstate the time left.
- It draws in the terminal and in the desktop app. Claude Code raises its footer on those two surfaces only, so there is no chip in VS Code or on mobile.
- cache-tax keeps its own clock from the conversation's turns and does not see a 🔥 ping. With both installed, its guard may hold the first message after the original hour once as a cold send although the ping kept the cache; send it again.
- Its tests pass on Claude Code 2.1.307; before the 🔥 ping they passed on 2.1.287, 2.1.295, 2.1.299, 2.1.304 and 2.1.306, and the chip was tried live in a terminal on 2.1.299 and 2.1.306. The tests check what the mod draws on each surface and what a ping's readback does to the clock, not how the desktop app paints it or what the server's cache holds.

## Developing

```sh
claude plugin validate .
claude plugin test .
```

The engine writes the API's types into `.claude-plugin/types/` when it loads the mod from a folder; with them there, `tsc -p .` type-checks the hooks and the tests.
