"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { TeamMessage } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface TeamMessageEvent {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: TeamMessage;
  old: Partial<TeamMessage>;
}

interface UseTeamChatRealtimeOptions {
  /** Which channel's messages to stream. Pass null/undefined to stay
   *  idle (e.g. before the channel list has loaded). */
  channelId: string | null | undefined;
  onMessageEvent: (event: TeamMessageEvent) => void;
}

/**
 * Realtime subscription for one team-chat channel's messages.
 *
 * Deliberately its own hook rather than a generic "subscribe to any
 * table" helper (mirrors `use-realtime.ts`'s reasoning) — team chat
 * has its own table, its own channel-scoped filter, and its own
 * lifecycle (resubscribes whenever the viewed channel changes).
 *
 * One Postgres-changes subscription per mounted instance, filtered
 * server-side to `channel_id=eq.<channelId>` so the client never
 * receives — and RLS never has to filter — messages from channels
 * the user isn't currently looking at.
 */
export function useTeamChatRealtime({
  channelId,
  onMessageEvent,
}: UseTeamChatRealtimeOptions) {
  const [isConnected, setIsConnected] = useState(false);

  // Latest callback in a ref so a parent re-render (fresh closure)
  // doesn't force a resubscribe — only assigned inside an effect so
  // the mutation happens post-render, same rule as use-realtime.ts.
  const onMessageRef = useRef(onMessageEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
  });

  useEffect(() => {
    if (!channelId) {
      setIsConnected(false);
      return;
    }

    const supabase = createClient();

    const realtimeChannel: RealtimeChannel = supabase
      .channel(`team-chat:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "team_messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          onMessageRef.current({
            eventType: payload.eventType as TeamMessageEvent["eventType"],
            new: payload.new as TeamMessage,
            old: payload.old as Partial<TeamMessage>,
          });
        },
      )
      .subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(realtimeChannel);
      setIsConnected(false);
    };
    // channelId is the only thing that should ever trigger a
    // resubscribe — the callback itself flows through the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  return { isConnected };
}
