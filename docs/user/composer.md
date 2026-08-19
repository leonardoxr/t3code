# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Sending while the agent is working

**Settings** → **General** → **Follow-up behavior** decides what `Enter` does when a run is already
active:

- **Queue** — park the message and send it once the thread is genuinely idle.
- **Steer** (default) — send it into the running turn; the agent folds it into the work it is
  already doing, without starting a new turn.
- **Interrupt** — stop the run and send the message next.

`Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows and Linux) does the **opposite** for one
message, without changing the setting: it queues when your default sends immediately, and steers
when your default is Queue. The button beside Stop performs the same one-off action and always shows
which one it is, so the mode is visible without opening Settings. The shortcut is rebindable under
**Settings** → **Keybindings** as `composer.followUpOverride`.

## The follow-up queue

A queued follow-up waits until the thread is genuinely idle — no turn running, no error, nothing
waiting on you — and is then sent on its own.

Queued follow-ups appear above the composer with a count. Each one can be edited in place, removed,
dragged to reorder, or sent right away with the arrow button (which steers the running turn if one
is still going). A follow-up keeps the images, terminal and element context, model, and modes it was
queued with, so sending it later reproduces what you chose at the time.

The queue is part of the thread, not the draft: it survives reloading the page, reconnecting, and
restarting the server, and up to 20 follow-ups can wait per thread.

Two rules keep the queue from surprising you:

- **Stop pauses the queue.** Stopping the agent or stopping the session marks the waiting
  follow-ups **Paused** so nothing fires into the gap you just made. Sending one (or queueing
  something new) resumes the rest.
- **A failure blocks the queue.** If a follow-up cannot be sent, it stays in the queue marked
  **Failed** with the reason, and nothing behind it is sent until you retry or remove it.
