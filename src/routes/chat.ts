import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendChatError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  if (error instanceof Error && error.message.includes("Missing required environment variable")) {
    response.status(503).json({ error: "Messaging is not configured yet. Please contact your administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that messaging request. Please try again." });
}

function directKey(userIds: string[]) {
  return userIds.sort((left, right) => left.localeCompare(right)).join(":");
}

function getUser(request: Request, response: Response) {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to use staff messaging." });
    return null;
  }
  return user;
}

async function isParticipant(admin: ReturnType<typeof createSupabaseAdminClient>, conversationId: string, userId: string) {
  const { data, error } = await admin.from("chat_conversation_participants")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

router.use(requireUser);

router.get("/people", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data: people, error } = await admin.from("profiles")
      .select("id, display_name, role, department_id")
      .eq("is_active", true)
      .eq("is_archived", false)
      .neq("id", user.id)
      .order("display_name");
    if (error) {
      sendChatError(response, error, "Could not load the staff messaging directory.");
      return;
    }
    const departmentIds = [...new Set((people ?? []).flatMap((person) => person.department_id ? [person.department_id] : []))];
    const { data: departments, error: departmentError } = departmentIds.length
      ? await admin.from("departments").select("id, name").in("id", departmentIds)
      : { data: [], error: null };
    if (departmentError) {
      sendChatError(response, departmentError, "Could not load staff department names.");
      return;
    }
    const departmentNames = new Map((departments ?? []).map((department) => [department.id, department.name]));
    response.status(200).json({
      people: (people ?? []).map((person) => ({
        id: person.id,
        name: person.display_name ?? "Team member",
        role: person.role,
        departmentName: person.department_id ? departmentNames.get(person.department_id) ?? "Department" : "Unassigned",
      })),
    });
  } catch (error: unknown) {
    sendChatError(response, error, "Could not initialize the staff messaging directory.");
  }
});

router.get("/conversations", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data: ownParticipants, error: ownError } = await admin.from("chat_conversation_participants")
      .select("conversation_id, last_read_at")
      .eq("user_id", user.id);
    if (ownError) {
      sendChatError(response, ownError, "Could not load the user's conversations.");
      return;
    }
    const conversationIds = (ownParticipants ?? []).map((item) => item.conversation_id);
    if (!conversationIds.length) {
      response.status(200).json({ conversations: [] });
      return;
    }
    const [
      { data: conversations, error: conversationsError },
      { data: participants, error: participantsError },
      { data: messages, error: messagesError },
      { data: unreadMessages, error: unreadError },
    ] = await Promise.all([
      admin.from("chat_conversations").select("id, created_at").in("id", conversationIds),
      admin.from("chat_conversation_participants").select("conversation_id, user_id").in("conversation_id", conversationIds),
      admin.from("chat_messages").select("id, conversation_id, sender_id, body, created_at").in("conversation_id", conversationIds).order("created_at", { ascending: false }).limit(500),
      admin.from("chat_messages").select("conversation_id").in("conversation_id", conversationIds).neq("sender_id", user.id).is("read_at", null).limit(1000),
    ]);
    const failure = conversationsError ?? participantsError ?? messagesError ?? unreadError;
    if (failure) {
      sendChatError(response, failure, "Could not load conversation summaries.");
      return;
    }
    const otherUserIds = [...new Set((participants ?? []).map((participant) => participant.user_id).filter((id) => id !== user.id))];
    const { data: profiles, error: profilesError } = otherUserIds.length
      ? await admin.from("profiles").select("id, display_name, role").in("id", otherUserIds)
      : { data: [], error: null };
    if (profilesError) {
      sendChatError(response, profilesError, "Could not load conversation participants.");
      return;
    }
    const participantById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    const ownReadAt = new Map((ownParticipants ?? []).map((participant) => [participant.conversation_id, participant.last_read_at]));
    const unreadCountByConversation = new Map<string, number>();
    for (const message of unreadMessages ?? []) unreadCountByConversation.set(message.conversation_id, (unreadCountByConversation.get(message.conversation_id) ?? 0) + 1);
    const latestMessageByConversation = new Map<string, NonNullable<typeof messages>[number]>();
    for (const message of messages ?? []) {
      if (!latestMessageByConversation.has(message.conversation_id)) latestMessageByConversation.set(message.conversation_id, message);
    }
    const rows = (conversations ?? []).map((conversation) => {
      const peerLink = (participants ?? []).find((participant) => participant.conversation_id === conversation.id && participant.user_id !== user.id);
      const peer = peerLink ? participantById.get(peerLink.user_id) : undefined;
      const latest = latestMessageByConversation.get(conversation.id);
      return {
        id: conversation.id,
        peer: { id: peerLink?.user_id ?? "", name: peer?.display_name ?? "Team member", role: peer?.role ?? "staff" },
        lastMessage: latest?.body ?? "",
        lastMessageAt: latest?.created_at ?? conversation.created_at,
        lastMessageFromMe: latest?.sender_id === user.id,
        unreadCount: unreadCountByConversation.get(conversation.id) ?? 0,
        lastReadAt: ownReadAt.get(conversation.id) ?? null,
      };
    }).sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
    response.status(200).json({ conversations: rows });
  } catch (error: unknown) {
    sendChatError(response, error, "Could not initialize conversations.");
  }
});

router.post("/conversations", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const peerId = request.body?.userId;
  if (typeof peerId !== "string" || !uuidPattern.test(peerId) || peerId === user.id) {
    response.status(400).json({ error: "Choose a valid colleague to start a conversation." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: people, error: peopleError } = await admin.from("profiles")
      .select("id, is_active, is_archived")
      .in("id", [user.id, peerId]);
    if (peopleError) {
      sendChatError(response, peopleError, "Could not verify conversation participants.");
      return;
    }
    const requesterProfile = (people ?? []).find((profile) => profile.id === user.id);
    const peerProfile = (people ?? []).find((profile) => profile.id === peerId);
    if (!requesterProfile?.is_active || requesterProfile.is_archived || !peerProfile?.is_active || peerProfile.is_archived) {
      response.status(404).json({ error: "That active staff account could not be found." });
      return;
    }
    const key = directKey([user.id, peerId]);
    let { data: conversation, error: conversationError } = await admin.from("chat_conversations")
      .select("id")
      .eq("direct_key", key)
      .maybeSingle();
    if (conversationError) {
      sendChatError(response, conversationError, "Could not check for an existing conversation.");
      return;
    }
    if (!conversation) {
      const created = await admin.from("chat_conversations")
        .insert({ direct_key: key, created_by: user.id })
        .select("id")
        .single();
      if (created.error?.code === "23505") {
        const existing = await admin.from("chat_conversations").select("id").eq("direct_key", key).single();
        conversation = existing.data;
        conversationError = existing.error;
      } else {
        conversation = created.data;
        conversationError = created.error;
      }
    }
    if (conversationError || !conversation) {
      sendChatError(response, conversationError ?? new Error("The conversation could not be created."), "Could not create conversation.");
      return;
    }
    const { error: participantError } = await admin.from("chat_conversation_participants").upsert(
      [{ conversation_id: conversation.id, user_id: user.id }, { conversation_id: conversation.id, user_id: peerId }],
      { onConflict: "conversation_id,user_id", ignoreDuplicates: true },
    );
    if (participantError) {
      sendChatError(response, participantError, "Could not save conversation participants.");
      return;
    }
    response.status(200).json({ conversationId: conversation.id });
  } catch (error: unknown) {
    sendChatError(response, error, "Could not initialize conversation creation.");
  }
});

router.get("/conversations/:conversationId/messages", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const { conversationId } = request.params;
  if (!conversationId || !uuidPattern.test(conversationId)) {
    response.status(400).json({ error: "Choose a valid conversation." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    if (!await isParticipant(admin, conversationId, user.id)) {
      response.status(403).json({ error: "You don't have access to this conversation." });
      return;
    }
    const { data: messages, error } = await admin.from("chat_messages")
      .select("id, sender_id, sender_name, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(300);
    if (error) {
      sendChatError(response, error, "Could not load conversation messages.");
      return;
    }
    const { error: readError } = await admin.from("chat_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .neq("sender_id", user.id)
      .is("read_at", null);
    if (readError) {
      sendChatError(response, readError, "Could not mark conversation messages as read.");
      return;
    }
    const { error: participantError } = await admin.from("chat_conversation_participants")
      .update({ last_read_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id);
    if (participantError) {
      sendChatError(response, participantError, "Could not update conversation read status.");
      return;
    }
    response.status(200).json({
      messages: (messages ?? []).map((message) => ({
        id: message.id,
        senderId: message.sender_id,
        senderName: message.sender_name,
        body: message.body,
        createdAt: message.created_at,
        fromMe: message.sender_id === user.id,
      })),
    });
  } catch (error: unknown) {
    sendChatError(response, error, "Could not initialize conversation message history.");
  }
});

router.post("/conversations/:conversationId/messages", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const { conversationId } = request.params;
  const body = request.body?.body;
  if (!conversationId || !uuidPattern.test(conversationId) || typeof body !== "string" || body.trim().length < 1 || body.trim().length > 4000) {
    response.status(400).json({ error: "Enter a message up to 4,000 characters." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    if (!await isParticipant(admin, conversationId, user.id)) {
      response.status(403).json({ error: "You don't have access to send messages in this conversation." });
      return;
    }
    const { data, error } = await admin.from("chat_messages")
      .insert({ conversation_id: conversationId, sender_id: user.id, sender_name: user.displayName ?? "Team member", body: body.trim() })
      .select("id, sender_id, sender_name, body, created_at")
      .single();
    if (error) {
      sendChatError(response, error, "Could not save chat message.");
      return;
    }
    response.status(201).json({
      message: {
        id: data.id,
        senderId: data.sender_id,
        senderName: data.sender_name,
        body: data.body,
        createdAt: data.created_at,
        fromMe: true,
      },
    });
  } catch (error: unknown) {
    sendChatError(response, error, "Could not initialize chat message creation.");
  }
});

export { router as chatRouter };
