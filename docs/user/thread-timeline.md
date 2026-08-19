# Thread timeline

## Images the agent looked at

When an agent opens an image — a screenshot you pointed it at, a diagram, a failing test artifact —
the timeline shows that image inline under the tool row instead of just its path. Tap or click it to
open the full-size viewer.

The image is loaded from the file on disk, not from the agent's response, so it costs nothing extra
on slow or remote connections and always reflects the current file. This works the same on web,
desktop, and mobile.

Two cases show the path alone with no picture: the file lives outside the project directory the
thread is working in, or it no longer exists. Writing or editing an image does not display it —
only reading one does.
