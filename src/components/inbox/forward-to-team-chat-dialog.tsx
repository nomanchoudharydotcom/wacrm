"use client";

// ============================================================
// ForwardToTeamChatDialog
//
// Lets an agent share one customer message (text or media) into an
// internal team-chat channel. Channel list is fetched fresh on
// every open rather than cached at the Inbox level — this dialog
// is mounted per-message-thread and channels rarely change, so a
// stale list is a worse failure mode than one extra small fetch.
//
// Mirrors the controlled open/onOpenChange pattern from
// invite-member-dialog.tsx.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Hash, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TeamChannel } from "@/types";

interface ForwardToTeamChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
}

export function ForwardToTeamChatDialog({
  open,
  onOpenChange,
  messageId,
}: ForwardToTeamChatDialogProps) {
  const [channels, setChannels] = useState<TeamChannel[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChannels(null);
    setSelectedId(null);
    fetch("/api/team-chat/channels")
      .then((res) => res.json())
      .then((data) => {
        const list: TeamChannel[] = data.channels ?? [];
        setChannels(list);
        const fallback = list.find((c) => c.is_default) ?? list[0];
        setSelectedId(fallback?.id ?? null);
      })
      .catch(() => toast.error("Failed to load channels"));
  }, [open]);

  async function handleForward() {
    if (!selectedId) return;
    setSending(true);
    try {
      const res = await fetch("/api/team-chat/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: selectedId, message_id: messageId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to forward message");
      }
      const channelName = channels?.find((c) => c.id === selectedId)?.name ?? "channel";
      toast.success(`Shared to #${channelName}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to forward message");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Share to Team Chat</DialogTitle>
          <DialogDescription>
            Pick a channel to share this message with your team.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 space-y-1 overflow-y-auto py-1">
          {channels === null ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No team channels yet.
            </p>
          ) : (
            channels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors " +
                  (c.id === selectedId
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-foreground hover:bg-muted")
                }
              >
                <Hash className="h-4 w-4 flex-shrink-0 opacity-60" />
                <span className="truncate">{c.name}</span>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleForward} disabled={!selectedId || sending}>
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
