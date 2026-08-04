"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { playNotificationSound } from "@/lib/notification-sound";

interface IncomingMessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  content_text?: string | null;
}

/**
 * App-wide desktop notification + sound for incoming customer WhatsApp
 * messages — mirrors the native WhatsApp desktop app experience.
 *
 * Deliberately independent from the inbox page's own realtime hook so it
 * keeps working (and stays simple) no matter which screen the user is on.
 * Suppressed only when the user is already looking at that exact
 * conversation in the inbox, so busy threads don't spam notifications.
 *
 * NOTE: this file previously existed only as a hand-patched file on the
 * production VPS (never committed to git) — recreated here so the repo
 * and the running server match.
 */
export function useMessageDesktopNotifications() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeConversationIdRef.current =
      pathname === "/inbox" ? searchParams.get("c") : null;
  }, [pathname, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("desktop-message-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new as IncomingMessageRow;
          if (msg.sender_type !== "customer") return;
          if (activeConversationIdRef.current === msg.conversation_id) return;

          playNotificationSound();

          if (
            typeof window === "undefined" ||
            !("Notification" in window) ||
            Notification.permission !== "granted"
          ) {
            return;
          }

          void (async () => {
            let title = "New WhatsApp message";
            try {
              const { data } = await supabase
                .from("conversations")
                .select("contact:contacts(name, phone)")
                .eq("id", msg.conversation_id)
                .single();

              const contact = Array.isArray(data?.contact)
                ? data?.contact[0]
                : data?.contact;
              if (contact?.name || contact?.phone) {
                title = contact.name || contact.phone;
              }
            } catch {
              // Fall back to the generic title below.
            }

            const body = msg.content_text?.trim()
              ? msg.content_text.length > 120
                ? `${msg.content_text.slice(0, 117)}…`
                : msg.content_text
              : "📎 New attachment";

            try {
              const notification = new Notification(title, {
                body,
                tag: msg.conversation_id,
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
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
