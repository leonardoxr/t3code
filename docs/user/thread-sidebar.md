# Organizing threads

Pin a thread from its menu to keep it at the top of its project. On web and desktop a pinned thread
carries a pin marker in the sidebar and leads the project it belongs to; on mobile pinned threads
lead their group in the thread list.

On mobile, open a pinned thread's menu and choose **Move up** or **Move down** to arrange them. The
order is stored by the server and is used everywhere you connect, so an order arranged on your
phone is the order web and desktop display.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Unsent drafts

A new thread you typed into but never sent stays in a **Drafts** section at the top of the sidebar,
above your projects. Each row shows the project it targets and the first line of what you typed.
Click it to pick the work back up with its model, mode, branch, and worktree selections intact, or
hover the row and choose the **✕** to discard it.

Starting another new thread never overwrites a draft you have invested in: it opens a fresh one and
leaves yours in the list. A draft disappears from the list once you send it or discard it.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
