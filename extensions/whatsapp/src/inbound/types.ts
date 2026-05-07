import type { AnyMessageContent, MiscMessageGenerationOptions } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import type { PollInput } from "openclaw/plugin-sdk/poll-runtime";
import type { WhatsAppIdentity, WhatsAppReplyContext, WhatsAppSelfIdentity } from "../identity.js";
import type { WhatsAppSendResult } from "./send-result.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type ActiveWebSendOptions = {
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

/**
 * Result of a LID/PhoneNumber lookup.
 * Mirrors WPPConnect's getPnLidEntry API.
 */
export type PnLidEntryResult = {
  /** The LID (Linked ID) for the contact */
  lid: string;
  /** The phone number in E.164 format (e.g. "+1234567890") */
  phoneNumber: string | null;
  /** Cached contact info if available */
  contact?: {
    /** Display name (pushName) */
    name?: string | null;
    /** Profile picture URL if available */
    profilePictureUrl?: string | null;
    /** Whether the contact is a business account */
    isBusiness?: boolean;
    /** Contact's WA ID */
    waId?: string;
  };
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<WhatsAppSendResult>;
  sendPoll: (to: string, poll: PollInput) => Promise<WhatsAppSendResult>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<WhatsAppSendResult>;
  sendComposingTo: (to: string) => Promise<void>;
  /**
   * Lookup LID/PhoneNumber mapping and contact information.
   * Accepts a phone number JID (e.g. "123456@s.whatsapp.net") or LID (e.g. "123@lid").
   * Returns the corresponding LID, phone number, and cached contact info.
   */
  lookupPnLidEntry: (phoneOrLid: string) => Promise<PnLidEntryResult | null>;
  close?: () => Promise<void>;
};

export type WhatsAppStructuredContactContext = {
  kind: "contact" | "contacts";
  total: number;
  contacts: Array<{
    name?: string;
    phones?: string[];
  }>;
};

export type WebInboundMessage = {
  id?: string;
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  /** Set by the real inbound monitor after access-control / pairing checks pass. */
  accessControlPassed?: boolean;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyTo?: WhatsAppReplyContext;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentions?: string[];
  mentionedJids?: string[];
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  sendMedia: (
    payload: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WhatsAppSendResult>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  untrustedStructuredContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
  wasMentioned?: boolean;
  isBatched?: boolean;
};
