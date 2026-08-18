import type { OrchestrationQueuedFollowUp, QueuedFollowUpId } from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CornerDownLeft, GripVertical, ImageIcon, PenLine, X } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQueuedFollowUpsProps {
  followUps: ReadonlyArray<OrchestrationQueuedFollowUp>;
  /** A turn is in flight, so "send now" means steering it. */
  isRunning: boolean;
  onEdit: (followUpId: QueuedFollowUpId, text: string) => void;
  onRemove: (followUpId: QueuedFollowUpId) => void;
  onReorder: (followUpId: QueuedFollowUpId, orderKey: string) => void;
  onPromote: (followUpId: QueuedFollowUpId) => void;
  className?: string;
}

const SNIPPET_MAX_CHARS = 140;

function followUpSnippet(followUp: OrchestrationQueuedFollowUp): string {
  const firstLine = followUp.text.trim().split("\n", 1)[0] ?? "";
  if (firstLine.length === 0) {
    return followUp.attachments.length > 0 ? "Image only" : "Empty follow-up";
  }
  return firstLine.length > SNIPPET_MAX_CHARS
    ? `${firstLine.slice(0, SNIPPET_MAX_CHARS)}…`
    : firstLine;
}

/**
 * One draggable queue row. The grip owns the drag listeners so clicking the
 * snippet still opens the inline editor.
 */
function SortableFollowUpRow(props: { id: string; failed: boolean; children: React.ReactNode }) {
  const sortable = useSortable({ id: props.id });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "group/queued-follow-up flex items-center gap-1.5 rounded-md border border-transparent px-1 py-1 hover:border-border/70 hover:bg-background/60",
        props.failed && "border-destructive/40",
        sortable.isDragging && "z-20 opacity-80",
      )}
    >
      <span
        {...(sortable.listeners ?? {})}
        aria-hidden
        className="shrink-0 cursor-grab text-icon-muted opacity-60 group-hover/queued-follow-up:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </span>
      {props.children}
    </li>
  );
}

export const ComposerQueuedFollowUps = memo(function ComposerQueuedFollowUps({
  followUps,
  isRunning,
  onEdit,
  onRemove,
  onReorder,
  onPromote,
  className,
}: ComposerQueuedFollowUpsProps) {
  const [editingId, setEditingId] = useState<QueuedFollowUpId | null>(null);
  const [editingText, setEditingText] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  if (followUps.length === 0) return null;

  const ordered = [...followUps].toSorted(
    (left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id),
  );
  const pausedCount = ordered.filter((followUp) => followUp.status === "paused").length;
  const failedCount = ordered.filter((followUp) => followUp.status === "failed").length;

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || overId === activeId) return;
    const fromIndex = ordered.findIndex((followUp) => followUp.id === activeId);
    const toIndex = ordered.findIndex((followUp) => followUp.id === overId);
    if (fromIndex === -1 || toIndex === -1) return;
    const withoutMoved = ordered.filter((followUp) => followUp.id !== activeId);
    const before = toIndex > fromIndex ? withoutMoved[toIndex] : withoutMoved[toIndex - 1];
    const after = toIndex > fromIndex ? withoutMoved[toIndex + 1] : withoutMoved[toIndex];
    // One fractional key for the moved item; neighbors are never rewritten.
    const orderKey = pinOrderKeyBetween(before?.orderKey ?? null, after?.orderKey ?? null);
    if (orderKey === null) return;
    const moved = ordered.find((followUp) => followUp.id === activeId);
    if (moved === undefined) return;
    onReorder(moved.id, orderKey);
  };

  const commitEdit = (followUp: OrchestrationQueuedFollowUp) => {
    const nextText = editingText;
    setEditingId(null);
    setEditingText("");
    if (nextText.trim().length === 0 || nextText === followUp.text) return;
    onEdit(followUp.id, nextText);
  };

  return (
    <section
      className={cn("rounded-lg border border-border/80 bg-muted/20", className)}
      aria-label="Queued follow-ups"
    >
      <header className="flex items-center gap-2 px-2.5 pt-2 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
          {ordered.length} queued
        </span>
        {pausedCount > 0 ? (
          <span className="rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning-foreground">
            Paused
          </span>
        ) : null}
        {failedCount > 0 ? (
          <span className="rounded-full bg-destructive/15 px-1.5 py-px text-[10px] font-medium text-destructive">
            Failed
          </span>
        ) : null}
        <span className="ml-auto truncate text-[10px] text-secondary-label">
          {pausedCount > 0
            ? "Stopped — send one to resume the queue"
            : failedCount > 0
              ? "Blocked until you retry or remove the failed follow-up"
              : "Sends automatically when the agent goes idle"}
        </span>
      </header>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={ordered.map((followUp) => followUp.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-1 px-1.5 pb-1.5">
            {ordered.map((followUp) => (
              <SortableFollowUpRow
                key={followUp.id}
                id={followUp.id}
                failed={followUp.status === "failed"}
              >
                {editingId === followUp.id ? (
                  <textarea
                    autoFocus
                    value={editingText}
                    aria-label="Edit queued follow-up"
                    className="min-h-8 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1 text-sm outline-none"
                    onChange={(event) => setEditingText(event.target.value)}
                    onBlur={() => commitEdit(followUp)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        commitEdit(followUp);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingId(null);
                        setEditingText("");
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => {
                      setEditingId(followUp.id);
                      setEditingText(followUp.text);
                    }}
                  >
                    {followUpSnippet(followUp)}
                  </button>
                )}
                {followUp.attachments.length > 0 ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-secondary-label">
                    <ImageIcon className="size-3" aria-hidden />
                    {followUp.attachments.length}
                  </span>
                ) : null}
                {followUp.status === "failed" && followUp.lastError !== null ? (
                  // Inline, not hover-only: this follow-up is blocking the whole
                  // queue, so the reason has to be readable without hovering.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="max-w-48 shrink-0 truncate text-[10px] font-medium text-destructive">
                          {followUp.lastError}
                        </span>
                      }
                    />
                    <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                      {followUp.lastError}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0"
                        aria-label={isRunning ? "Steer with this follow-up now" : "Send now"}
                        onClick={() => onPromote(followUp.id)}
                      >
                        <CornerDownLeft />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">
                    {isRunning ? "Steer the running turn with this" : "Send now"}
                  </TooltipPopup>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 opacity-0 transition-opacity group-hover/queued-follow-up:opacity-100"
                  aria-label="Edit queued follow-up"
                  onClick={() => {
                    setEditingId(followUp.id);
                    setEditingText(followUp.text);
                  }}
                >
                  <PenLine />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 opacity-0 transition-opacity group-hover/queued-follow-up:opacity-100"
                  aria-label="Remove queued follow-up"
                  onClick={() => onRemove(followUp.id)}
                >
                  <X />
                </Button>
              </SortableFollowUpRow>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
});
