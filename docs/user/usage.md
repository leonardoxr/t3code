# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

## Plan quota

Two rings sit in the sidebar footer, one for Claude and one for Codex, showing how much of each
plan's rolling quota is already spent. They turn red past 90%. Hover a ring for every window the
plan has — the five-hour and weekly limits, plus any model-specific ones — with the percentage used
and when each one resets. Clicking a ring opens this page.

The figures come from the `claude` and `codex` CLIs your environments already host, so they cover
everything charged to the plan, including turns you ran outside T3 Code. Reading them costs no plan
quota, so the rings keep working after a limit is reached. A ring only appears once its provider
reports a figure: sign in to that CLI, or stay on an API key, and there is nothing to gauge.

## History

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
