# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Sending while the agent is working

`Enter` still sends immediately and steers the running turn: the agent folds the message into the
work it is already doing, in the same turn.

`Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows and Linux) queues the message instead. A
queued follow-up waits until the thread is genuinely idle — no turn running, no error, nothing
waiting on you — and is then sent on its own. The **Queue** button next to Stop does the same thing,
and the shortcut is rebindable under **Settings** → **Keybindings** as `composer.queueFollowUp`.

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
