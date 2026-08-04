"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useTeamChatRealtime } from "@/hooks/use-team-chat-realtime";
import type { TeamChannel, TeamMessage, AccountMember } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Hash, Loader2, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// `useSearchParams` (the `?channel=<id>` deep link below) requires a
// Suspense boundary or the production build bails to CSR and errors
// out — same reasoning as inbox/page.tsx.
export default function TeamChatPage() {
  return (
    <Suspense fallback={null}>
      <TeamChatPageInner />
    </Suspense>
  );
}

function membersToMap(members: AccountMember[]): Record<string, AccountMember> {
  return Object.fromEntries(members.map((m) => [m.user_id, m]));
}

function TeamChatPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, canSendMessages } = useAuth();

  const [channels, setChannels] = useState<TeamChannel[] | null>(null);
  const [members, setMembers] = useState<Record<string, AccountMember>>({});
  const [messages, setMessages] = useState<TeamMessage[] | null>(null);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const activeChannelId = searchParams.get("channel");
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  // ---- load channels + members once ------------------------------
  useEffect(() => {
    (async () => {
      const [channelsRes, membersRes] = await Promise.all([
        fetch("/api/team-chat/channels"),
        fetch("/api/account/members"),
      ]);
      if (channelsRes.ok) {
        const { channels: list } = await channelsRes.json();
        setChannels(list);
        // Land on the default ("General") channel if the URL doesn't
        // already point at one — mirrors the inbox's deep-link default.
        if (!activeChannelId && list.length > 0) {
          const fallback = list.find((c: TeamChannel) => c.is_default) ?? list[0];
          router.replace(`/team-chat?channel=${fallback.id}`, { scroll: false });
        }
      } else {
        toast.error("Failed to load channels");
      }
      if (membersRes.ok) {
        const { members: list } = await membersRes.json();
        setMembers(membersToMap(list));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  // ---- load messages whenever the active channel changes ---------
  useEffect(() => {
    if (!activeChannelId) return;
    setMessages(null);
    fetch(`/api/team-chat/channels/${activeChannelId}/messages`)
      .then((res) => res.json())
      .then((data) => setMessages(data.messages ?? []))
      .catch(() => toast.error("Failed to load messages"));
  }, [activeChannelId]);

  // Auto-scroll to the newest message whenever the list changes.
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // ---- realtime ----------------------------------------------------
  const handleRealtimeEvent = useCallback(
    (event: { eventType: string; new: TeamMessage; old: Partial<TeamMessage> }) => {
      if (event.eventType === "INSERT") {
        setMessages((prev) => {
          if (!prev) return prev;
          // De-dupe: our own POST already appended this message
          // optimistically before the realtime echo arrives.
          if (prev.some((m) => m.id === event.new.id)) return prev;
          return [...prev, event.new];
        });
      } else if (event.eventType === "UPDATE") {
        setMessages((prev) =>
          prev?.map((m) => (m.id === event.new.id ? event.new : m)) ?? prev,
        );
      }
    },
    [],
  );
  useTeamChatRealtime({ channelId: activeChannelId, onMessageEvent: handleRealtimeEvent });

  // ---- actions ------------------------------------------------------
  const sendMessage = useCallback(async () => {
    const content_text = composerText.trim();
    if (!content_text || !activeChannelId || sending) return;

    setSending(true);
    setComposerText("");
    try {
      const res = await fetch(`/api/team-chat/channels/${activeChannelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to send message");
      }
      const { message } = await res.json();
      setMessages((prev) => (prev ? [...prev, message] : [message]));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send message");
      setComposerText(content_text); // give the draft back on failure
    } finally {
      setSending(false);
    }
  }, [composerText, activeChannelId, sending]);

  const startEdit = useCallback((msg: TeamMessage) => {
    setEditingId(msg.id);
    setEditingText(msg.content_text);
  }, []);

  const saveEdit = useCallback(async () => {
    const content_text = editingText.trim();
    if (!editingId || !content_text) return;
    try {
      const res = await fetch(`/api/team-chat/messages/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_text }),
      });
      if (!res.ok) throw new Error("Failed to edit message");
      const { message } = await res.json();
      setMessages((prev) => prev?.map((m) => (m.id === message.id ? message : m)) ?? prev);
      setEditingId(null);
    } catch {
      toast.error("Failed to edit message");
    }
  }, [editingId, editingText]);

  const deleteMessage = useCallback(async (id: string) => {
    if (!window.confirm("Delete this message?")) return;
    try {
      const res = await fetch(`/api/team-chat/messages/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete message");
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.id === id ? { ...m, deleted_at: new Date().toISOString() } : m,
          ) ?? prev,
      );
    } catch {
      toast.error("Failed to delete message");
    }
  }, []);

  const createChannel = useCallback(async () => {
    const name = newChannelName.trim();
    if (!name) return;
    setCreatingChannel(true);
    try {
      const res = await fetch("/api/team-chat/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create channel");
      }
      const { channel } = await res.json();
      setChannels((prev) => (prev ? [...prev, channel] : [channel]));
      setNewChannelName("");
      router.replace(`/team-chat?channel=${channel.id}`, { scroll: false });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setCreatingChannel(false);
    }
  }, [newChannelName, router]);

  const activeChannel = useMemo(
    () => channels?.find((c) => c.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: channel list */}
        <div
          className={cn(
            "flex h-full w-full flex-col border-r border-border lg:w-64 lg:flex-none",
            activeChannelId ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="flex items-center justify-between border-b border-border p-4">
            <h1 className="text-sm font-semibold text-foreground">Team Chat</h1>
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {channels === null ? (
                <div className="flex justify-center p-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => router.replace(`/team-chat?channel=${c.id}`, { scroll: false })}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      c.id === activeChannelId
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <Hash className="h-4 w-4 flex-shrink-0 opacity-60" />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))
              )}
            </div>
            {canSendMessages && (
              <div className="flex items-center gap-2 border-t border-border p-2">
                <input
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createChannel()}
                  placeholder="New channel name"
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                  maxLength={80}
                />
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 flex-shrink-0"
                  disabled={!newChannelName.trim() || creatingChannel}
                  onClick={createChannel}
                >
                  {creatingChannel ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right panel: messages + composer */}
        <div
          className={cn(
            "flex h-full flex-1 flex-col",
            activeChannelId ? "flex" : "hidden lg:flex",
          )}
        >
          {!activeChannel ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a channel to start chatting
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border p-4">
                <button
                  type="button"
                  onClick={() => router.replace("/team-chat", { scroll: false })}
                  className="mr-1 text-muted-foreground lg:hidden"
                  aria-label="Back to channels"
                >
                  <X className="h-4 w-4" />
                </button>
                <Hash className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  {activeChannel.name}
                </h2>
              </div>

              <ScrollArea className="flex-1 p-4">
                {messages === null ? (
                  <div className="flex justify-center p-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No messages yet — say hi to the team.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map((m) => {
                      const isOwn = m.sender_user_id === user?.id;
                      const sender = members[m.sender_user_id];
                      const isDeleted = !!m.deleted_at;
                      const isEditing = editingId === m.id;
                      return (
                        <div
                          key={m.id}
                          className={cn("group flex gap-2", isOwn && "flex-row-reverse")}
                        >
                          <Avatar size="sm" className="flex-shrink-0">
                            {sender?.avatar_url ? (
                              <AvatarImage src={sender.avatar_url} alt={sender.full_name || "Member"} />
                            ) : null}
                            <AvatarFallback>
                              {(sender?.full_name || "?").slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className={cn("flex max-w-[70%] flex-col", isOwn && "items-end")}>
                            <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                              <span className="font-medium">
                                {sender?.full_name || "Unknown"}
                              </span>
                              <span>
                                {formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}
                              </span>
                            </div>
                            {isEditing ? (
                              <div className="mt-1 flex w-full flex-col gap-1">
                                <Textarea
                                  value={editingText}
                                  onChange={(e) => setEditingText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      saveEdit();
                                    }
                                    if (e.key === "Escape") setEditingId(null);
                                  }}
                                  className="min-h-[60px] text-sm"
                                  autoFocus
                                />
                                <div className="flex gap-2">
                                  <Button size="sm" onClick={saveEdit}>
                                    Save
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div
                                className={cn(
                                  "mt-1 rounded-2xl px-3 py-2 text-sm",
                                  isDeleted
                                    ? "italic text-muted-foreground"
                                    : isOwn
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-muted text-foreground",
                                )}
                              >
                                {isDeleted ? "This message was deleted" : m.content_text}
                                {!isDeleted && m.edited_at && (
                                  <span className="ml-1 text-[10px] opacity-70">(edited)</span>
                                )}
                              </div>
                            )}
                            {isOwn && !isDeleted && !isEditing && (
                              <div className="mt-0.5 flex gap-2 px-1 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  type="button"
                                  onClick={() => startEdit(m)}
                                  className="text-muted-foreground hover:text-foreground"
                                  aria-label="Edit message"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteMessage(m.id)}
                                  className="text-muted-foreground hover:text-destructive"
                                  aria-label="Delete message"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div ref={scrollAnchorRef} />
                  </div>
                )}
              </ScrollArea>

              {canSendMessages ? (
                <div className="flex items-end gap-2 border-t border-border p-3">
                  <Textarea
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Type a message... (Shift+Enter for new line)"
                    className="min-h-[44px] flex-1 resize-none"
                  />
                  <Button
                    size="icon"
                    onClick={sendMessage}
                    disabled={!composerText.trim() || sending}
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ) : (
                <div className="border-t border-border p-3 text-center text-xs text-muted-foreground">
                  You have read-only access to Team Chat.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
