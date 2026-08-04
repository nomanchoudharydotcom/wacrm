"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { playNotificationSound } from "@/lib/notification-sound";
import type { TeamMessage } from "@/types";

/**
 * App-wide desktop notification + sound for incoming internal team-chat
 * messages — same UX as the WhatsApp-side notifications
 * (use-message-desktop-notifications.ts), same underlying chime, kept
 * as its own hook because the source table, suppression rule (route +
 * channel, not route + conversation) and self-message exclusion are
 * all different enough that folding it into the WhatsApp hook would
 * make that one harder to reason about for no real gain.
 *
 * Subscribes with no `filter` — RLS (team_messages_select) already
 * restricts the realtime stream to the caller's own account, same
 * trust boundary the WhatsApp notification hook relies on for
 * `messages`.
 */
export function useTeamChatDesktopNotifications() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeChannelIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeChannelIdRef.current =
      pathname === "/team-chat" ? searchParams.get("channel") : null;
  }, [pathname, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data }) => {
      currentUserIdRef.current = data.user?.id ?? null;
    });

    const channel = supabase
      .channel("desktop-team-chat-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "team_messages" },
        (payload) => {
          const msg = payload.new as TeamMessage;

          // Never notify the author about their own message.
          if (msg.sender_user_id === currentUserIdRef.current) return;
          // Already looking at this exact channel — no interruption.
          if (activeChannelIdRef.current === msg.channel_id) return;

          playNotificationSound();

          if (
            typeof window === "undefined" ||
            !("Notification" in window) ||
            Notification.permission !== "granted"
          ) {
            return;
          }

          void (async () => {
            let title = "New team message";
            try {
              const [{ data: channelRow }, { data: senderProfile }] =
                await Promise.all([
                  supabase
                    .from("team_channels")
                    .select("name")
                    .eq("id", msg.channel_id)
                    .single(),
                  supabase
                    .from("profiles")
                    .select("full_name")
                    .eq("user_id", msg.sender_user_id)
                    .maybeSingle(),
                ]);

              const channelName = channelRow?.name;
              const senderName = senderProfile?.full_name;
              if (channelName && senderName) {
                title = `#${channelName} — ${senderName}`;
              } else if (channelName) {
                title = `#${channelName}`;
              }
            } catch {
              // Fall back to the generic title below.
            }

            const body = msg.content_text.trim()
              ? msg.content_text.length > 120
                ? `${msg.content_text.slice(0, 117)}…`
                : msg.content_text
              : "New message";

            try {
              const notification = new Notification(title, {
                body,
                tag: `team-chat-${msg.channel_id}`,
                silent: true,
              });
              notification.onclick = () => {
                window.focus();
                notification.close();
              };
            } catch {
              // Some browser contexts don't support the Notification
              // constructor directly — safe to ignore.
            }
          })();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
