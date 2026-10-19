import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { sendIncomingCallPush } from "../services/callPush.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ringingLifetimeMs = 60_000;
const maxCallParticipants = 8;
const missedCallPrefix = "__flexbar_missed_call__";

function sendCallError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  if (error instanceof Error && error.message.includes("Missing required environment variable")) {
    response.status(503).json({ error: "Calls are not configured yet. Please contact your administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that call request. Please try again." });
}

function getUser(request: Request, response: Response) {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to make or receive calls." });
    return null;
  }
  return user;
}

interface CallIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function getMeteredAppName() {
  const appName = process.env.METERED_APP_NAME?.trim();
  if (!appName) return null;
  if (!/^[a-z0-9-]+$/i.test(appName)) {
    throw new Error("METERED_APP_NAME must be the app name from the Metered dashboard, without a URL.");
  }
  return appName;
}

function getMeteredIceServers(value: unknown): CallIceServer[] {
  const payload = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "iceServers" in value
      ? value.iceServers
      : null;
  if (!Array.isArray(payload)) {
    throw new Error("Metered returned an invalid TURN server response.");
  }

  const iceServers: CallIceServer[] = [];
  for (const server of payload) {
    if (typeof server !== "object" || server === null || !("urls" in server)) continue;
    const rawUrls: unknown = server.urls;
    const urlCandidates: unknown[] = typeof rawUrls === "string" ? [rawUrls] : Array.isArray(rawUrls) ? rawUrls : [];
    const urls = urlCandidates
      .filter((url): url is string => typeof url === "string" && /^(turns?|stun):/i.test(url));
    if (!urls.length) continue;
    const hasRelayUrl = urls.some((url) => /^turns?:/i.test(url));
    const username = "username" in server && typeof server.username === "string" ? server.username : undefined;
    const credential = "credential" in server && typeof server.credential === "string" ? server.credential : undefined;
    if (hasRelayUrl && (!username || !credential)) {
      throw new Error("Metered returned a TURN server without valid credentials.");
    }
    iceServers.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }
  if (!iceServers.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)))) {
    throw new Error("Metered did not return a usable TURN relay.");
  }
  return iceServers;
}

async function getIceServers() {
  const meteredAppName = getMeteredAppName();
  const meteredApiKey = process.env.METERED_API_KEY?.trim();
  if (meteredAppName || meteredApiKey) {
    if (!meteredAppName || !meteredApiKey) {
      throw new Error("Both METERED_APP_NAME and METERED_API_KEY must be configured.");
    }
    const endpoint = new URL(`https://${meteredAppName}.metered.live/api/v1/turn/credentials`);
    endpoint.searchParams.set("apiKey", meteredApiKey);
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("Metered TURN credentials request failed.", { status: response.status });
      throw new Error("Metered TURN credentials could not be loaded.");
    }
    const meteredServers = getMeteredIceServers(await response.json());
    return {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }, ...meteredServers],
      turnConfigured: true,
    };
  }

  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  const turnUrls = process.env.TURN_URLS?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
  const relayUrls = turnUrls.filter((url) => /^turns?:/i.test(url));
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  const turnConfigured = relayUrls.length > 0 && Boolean(username && credential);
  if (relayUrls.length && username && credential) {
    iceServers.push({
      urls: relayUrls,
      username,
      credential,
    });
  }
  return {
    iceServers,
    turnConfigured,
  };
}

async function recordCallHistory(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  call: { id: string; created_by: string; media_mode: string },
  recipientId: string,
  event: { type: "missed" } | { type: "declined" } | { type: "ended"; durationSeconds: number },
) {
  const directKey = [call.created_by, recipientId].sort((left, right) => left.localeCompare(right)).join(":");
  let { data: conversation, error: conversationError } = await admin.from("chat_conversations")
    .select("id")
    .eq("direct_key", directKey)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) {
    const created = await admin.from("chat_conversations")
      .insert({ direct_key: directKey, created_by: call.created_by })
      .select("id")
      .single();
    if (created.error?.code === "23505") {
      const existing = await admin.from("chat_conversations").select("id").eq("direct_key", directKey).single();
      conversation = existing.data;
      conversationError = existing.error;
    } else {
      conversation = created.data;
      conversationError = created.error;
    }
  }
  if (conversationError || !conversation) {
    throw conversationError ?? new Error("Could not create the direct conversation for a missed call.");
  }
  const { error: participantsError } = await admin.from("chat_conversation_participants").upsert(
    [
      { conversation_id: conversation.id, user_id: call.created_by },
      { conversation_id: conversation.id, user_id: recipientId },
    ],
    { onConflict: "conversation_id,user_id", ignoreDuplicates: true },
  );
  if (participantsError) throw participantsError;

  const body = event.type === "missed"
    ? `${missedCallPrefix}:${call.media_mode}:${call.id}`
    : event.type === "declined"
      ? `__flexbar_call_declined__:${call.media_mode}:${call.id}`
      : `__flexbar_call_ended__:${call.media_mode}:${call.id}:${event.durationSeconds}`;
  const { data: existingMessage, error: messageLookupError } = await admin.from("chat_messages")
    .select("id")
    .eq("conversation_id", conversation.id)
    .eq("body", body)
    .maybeSingle();
  if (messageLookupError) throw messageLookupError;
  if (existingMessage) return;

  const senderId = event.type === "declined" ? recipientId : call.created_by;
  const { data: sender, error: senderError } = await admin.from("profiles")
    .select("display_name")
    .eq("id", senderId)
    .maybeSingle();
  if (senderError) throw senderError;
  const { error: messageError } = await admin.from("chat_messages").insert({
    conversation_id: conversation.id,
    sender_id: senderId,
    sender_name: sender?.display_name ?? "Team member",
    body,
  });
  if (messageError) throw messageError;
}

async function recordEndedCallHistory(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  call: { id: string; created_by: string; media_mode: string },
  endedAt: string,
) {
  const { data: participants, error } = await admin.from("call_room_participants")
    .select("user_id, joined_at, left_at")
    .eq("room_id", call.id)
    .not("joined_at", "is", null)
    .neq("user_id", call.created_by);
  if (error) throw error;

  for (const participant of participants ?? []) {
    if (!participant.joined_at) continue;
    const participantEndedAt = participant.left_at ?? endedAt;
    const durationSeconds = Math.max(
      0,
      Math.floor((Date.parse(participantEndedAt) - Date.parse(participant.joined_at)) / 1000),
    );
    await recordCallHistory(admin, call, participant.user_id, { type: "ended", durationSeconds });
  }
}

async function expireCallInvitation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  call: { id: string; created_by: string; company_id: string; media_mode: string; status: string },
  recipientId: string,
) {
  if (call.status === "ringing") {
    const { data: endedRoom, error: endError } = await admin.from("call_rooms")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", call.id)
      .eq("company_id", call.company_id)
      .eq("status", "ringing")
      .select("id")
      .maybeSingle();
    if (endError) throw endError;
    if (!endedRoom) return;

    const { data: invitees, error: inviteesError } = await admin.from("call_room_participants")
      .select("user_id")
      .eq("room_id", call.id)
      .eq("status", "ringing")
      .neq("user_id", call.created_by);
    if (inviteesError) throw inviteesError;
    const { error: membershipError } = await admin.from("call_room_participants")
      .update({ status: "left", left_at: new Date().toISOString() })
      .eq("room_id", call.id)
      .in("status", ["ringing", "joined"]);
    if (membershipError) throw membershipError;
    for (const invitee of invitees ?? []) {
      await recordCallHistory(admin, call, invitee.user_id, { type: "missed" });
    }
    return;
  }

  const { data: expiredInvitation, error: invitationError } = await admin.from("call_room_participants")
    .update({ status: "left", left_at: new Date().toISOString() })
    .eq("room_id", call.id)
    .eq("user_id", recipientId)
    .eq("status", "ringing")
    .select("user_id")
    .maybeSingle();
  if (invitationError) throw invitationError;
  if (expiredInvitation) await recordCallHistory(admin, call, recipientId, { type: "missed" });
}

router.use(requireUser);

router.post("/signout", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  try {
    const admin = createSupabaseAdminClient();
    const leftAt = new Date().toISOString();
    const { data: ownedRooms, error: ownedRoomsError } = await admin.from("call_rooms")
      .update({ status: "ended", ended_at: leftAt })
      .eq("company_id", user.companyId)
      .eq("created_by", user.id)
      .in("status", ["active", "ringing"])
      .select("id, created_by, media_mode");
    if (ownedRoomsError) {
      sendCallError(response, ownedRoomsError, "Could not end calls started by the signing-out user.");
      return;
    }
    const ownedRoomIds = (ownedRooms ?? []).map((room) => room.id);
    if (ownedRoomIds.length) {
      const { error } = await admin.from("call_room_participants")
        .update({ status: "left", left_at: leftAt })
        .in("room_id", ownedRoomIds)
        .in("status", ["ringing", "joined"]);
      if (error) {
        sendCallError(response, error, "Could not close call memberships for calls started by the signing-out user.");
        return;
      }
      for (const room of ownedRooms ?? []) {
        try {
          await recordEndedCallHistory(admin, room, leftAt);
        } catch (historyError: unknown) {
          console.error("Could not record a call ended during sign-out in chat history.", historyError);
        }
      }
    }

    const { data: memberships, error: membershipsError } = await admin.from("call_room_participants")
      .select("room_id")
      .eq("user_id", user.id)
      .in("status", ["ringing", "joined"]);
    if (membershipsError) {
      sendCallError(response, membershipsError, "Could not find call memberships for the signing-out user.");
      return;
    }
    const candidateRoomIds = [...new Set((memberships ?? [])
      .map((membership) => membership.room_id)
      .filter((roomId) => !ownedRoomIds.includes(roomId)))];
    if (candidateRoomIds.length) {
      const { data: otherRooms, error: otherRoomsError } = await admin.from("call_rooms")
        .select("id, created_by, media_mode")
        .eq("company_id", user.companyId)
        .in("id", candidateRoomIds)
        .in("status", ["active", "ringing"]);
      if (otherRoomsError) {
        sendCallError(response, otherRoomsError, "Could not verify other active call rooms.");
        return;
      }
      const otherRoomIds = (otherRooms ?? []).map((room) => room.id);
      if (otherRoomIds.length) {
        const { error } = await admin.from("call_room_participants")
          .update({ status: "left", left_at: leftAt })
          .eq("user_id", user.id)
          .in("room_id", otherRoomIds)
          .in("status", ["ringing", "joined"]);
        if (error) {
          sendCallError(response, error, "Could not leave calls joined by the signing-out user.");
          return;
        }
        for (const roomId of otherRoomIds) {
          const { data: remainingMembers, error: remainingMembersError } = await admin.from("call_room_participants")
            .select("user_id")
            .eq("room_id", roomId)
            .eq("status", "joined")
            .limit(1);
          if (remainingMembersError) {
            sendCallError(response, remainingMembersError, "Could not verify remaining call participants.");
            return;
          }
          if (!remainingMembers?.length) {
            const endedAt = new Date().toISOString();
            const { error } = await admin.from("call_rooms")
              .update({ status: "ended", ended_at: endedAt })
              .eq("id", roomId)
              .eq("company_id", user.companyId)
              .in("status", ["active", "ringing"]);
            if (error) {
              sendCallError(response, error, "Could not end an empty call room.");
              return;
            }
            const endedRoom = otherRooms?.find((room) => room.id === roomId);
            if (endedRoom) {
              try {
                await recordEndedCallHistory(admin, endedRoom, endedAt);
              } catch (historyError: unknown) {
                console.error("Could not record a call ended during sign-out in chat history.", historyError);
              }
            }
          }
        }
      }
    }
    response.status(200).json({ ok: true });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not end call sessions during sign-out.");
  }
});

router.post("/", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const participantIds: unknown = request.body?.participantIds;
  const mediaMode: unknown = request.body?.mediaMode;
  if (
    !Array.isArray(participantIds)
    || participantIds.length < 1
    || participantIds.length > 7
    || participantIds.some((id) => typeof id !== "string" || !uuidPattern.test(id) || id === user.id)
    || new Set(participantIds).size !== participantIds.length
    || (mediaMode !== "audio" && mediaMode !== "video")
  ) {
    response.status(400).json({ error: "Choose one to seven colleagues and select audio or video calling." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: profiles, error: profilesError } = await admin.from("profiles")
      .select("id, is_active, is_archived")
      .in("id", participantIds)
      .eq("company_id", user.companyId);
    if (profilesError) {
      sendCallError(response, profilesError, "Could not verify call participants.");
      return;
    }
    if ((profiles ?? []).length !== participantIds.length || profiles?.some((profile) => !profile.is_active || profile.is_archived)) {
      response.status(400).json({ error: "One or more selected colleagues are no longer active in your company." });
      return;
    }

    const ringingCutoff = new Date(Date.now() - ringingLifetimeMs).toISOString();
    const { data: expiredRooms, error: expiredRoomsError } = await admin.from("call_rooms")
      .select("id, created_by, company_id, media_mode, status")
      .eq("company_id", user.companyId)
      .eq("created_by", user.id)
      .eq("status", "ringing")
      .lt("created_at", ringingCutoff);
    if (expiredRoomsError) {
      sendCallError(response, expiredRoomsError, "Could not check for expired calls before starting a new call.");
      return;
    }
    for (const room of expiredRooms ?? []) {
      await expireCallInvitation(admin, room, user.id);
    }

    const leftAt = new Date().toISOString();
    const { data: previousRooms, error: previousRoomsError } = await admin.from("call_rooms")
      .update({ status: "ended", ended_at: leftAt })
      .eq("company_id", user.companyId)
      .eq("created_by", user.id)
      .in("status", ["active", "ringing"])
      .select("id, created_by, media_mode");
    if (previousRoomsError) {
      sendCallError(response, previousRoomsError, "Could not close a previous call before starting a new call.");
      return;
    }
    const previousRoomIds = (previousRooms ?? []).map((room) => room.id);
    if (previousRoomIds.length) {
      const { error } = await admin.from("call_room_participants")
        .update({ status: "left", left_at: leftAt })
        .in("room_id", previousRoomIds)
        .in("status", ["ringing", "joined"]);
      if (error) {
        sendCallError(response, error, "Could not close participants in a previous call.");
        return;
      }
      for (const previousRoom of previousRooms ?? []) {
        try {
          await recordEndedCallHistory(admin, previousRoom, leftAt);
        } catch (historyError: unknown) {
          console.error("Could not record a previous call in chat history.", historyError);
        }
      }
    }
    const [activeCallResult, ringingCallResult] = await Promise.all([
      admin.from("call_rooms").select("id").eq("created_by", user.id).eq("status", "active").limit(1).maybeSingle(),
      admin.from("call_rooms").select("id").eq("created_by", user.id).eq("status", "ringing").gte("created_at", ringingCutoff).limit(1).maybeSingle(),
    ]);
    const existingCallError = activeCallResult.error ?? ringingCallResult.error;
    if (existingCallError) {
      sendCallError(response, existingCallError, "Could not check for an existing call.");
      return;
    }
    if (activeCallResult.data || ringingCallResult.data) {
      response.status(409).json({ error: "End your current call before starting another." });
      return;
    }
    const { data: room, error: roomError } = await admin.from("call_rooms")
      .insert({ company_id: user.companyId, created_by: user.id, media_mode: mediaMode })
      .select("id")
      .single();
    if (roomError) {
      sendCallError(response, roomError, "Could not create a call room.");
      return;
    }
    const callerJoinedAt = new Date().toISOString();
    const { error: participantsError } = await admin.from("call_room_participants").insert([
      { room_id: room.id, user_id: user.id, status: "joined", joined_at: callerJoinedAt },
      ...participantIds.map((userId: string) => ({ room_id: room.id, user_id: userId, status: "ringing" })),
    ]);
    if (participantsError) {
      const { error: cleanupError } = await admin.from("call_rooms").delete().eq("id", room.id);
      if (cleanupError) console.error("Could not clean up a call room after invitation failure.", cleanupError);
      sendCallError(response, participantsError, "Could not invite call participants.");
      return;
    }
    await sendIncomingCallPush(admin, user.companyId, participantIds as string[], {
      callId: room.id,
      callerName: user.displayName ?? "Team member",
      mediaMode,
    }).catch((error: unknown) => console.error("Could not queue call notifications.", error));
    response.status(201).json({ callId: room.id });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not initialize call creation.");
  }
});

router.post("/:callId/invitations", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const callId = request.params.callId;
  const participantIds: unknown = request.body?.participantIds;
  if (
    !callId
    || !uuidPattern.test(callId)
    || !Array.isArray(participantIds)
    || participantIds.length < 1
    || participantIds.length > maxCallParticipants - 1
    || participantIds.some((id) => typeof id !== "string" || !uuidPattern.test(id) || id === user.id)
    || new Set(participantIds).size !== participantIds.length
  ) {
    response.status(400).json({ error: "Choose one or more colleagues to add to this call." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const [{ data: room, error: roomError }, { data: memberships, error: membershipsError }] = await Promise.all([
      admin.from("call_rooms")
        .select("id, created_by, company_id, media_mode, created_at, status")
        .eq("id", callId)
        .eq("company_id", user.companyId)
        .maybeSingle(),
      admin.from("call_room_participants")
        .select("user_id, status")
        .eq("room_id", callId),
    ]);
    if (roomError || membershipsError) {
      sendCallError(response, roomError ?? membershipsError, "Could not verify the call before inviting colleagues.");
      return;
    }
    if (!room || !["ringing", "active"].includes(room.status)) {
      response.status(410).json({ error: "This call has ended." });
      return;
    }
    if (room.status === "ringing" && Date.now() - Date.parse(room.created_at) >= ringingLifetimeMs) {
      await expireCallInvitation(admin, room, user.id);
      response.status(410).json({ error: "This call invitation has expired." });
      return;
    }
    const callerMembership = memberships?.find((participant) => participant.user_id === user.id);
    if (callerMembership?.status !== "joined") {
      response.status(403).json({ error: "Only someone currently in the call can invite colleagues." });
      return;
    }
    const activeMemberships = (memberships ?? []).filter((participant) =>
      participant.status === "joined" || participant.status === "ringing");
    const activeUserIds = new Set(activeMemberships.map((participant) => participant.user_id));
    if (participantIds.some((id) => activeUserIds.has(id))) {
      response.status(409).json({ error: "One or more selected colleagues are already in this call or have an invitation." });
      return;
    }
    const previousUserIds = new Set((memberships ?? []).map((participant) => participant.user_id));
    if (participantIds.some((id) => previousUserIds.has(id))) {
      response.status(409).json({ error: "One or more selected colleagues have already participated in this call." });
      return;
    }
    const availableSlots = maxCallParticipants - activeMemberships.length;
    if (participantIds.length > availableSlots) {
      response.status(400).json({ error: `This call has room for ${availableSlots} more ${availableSlots === 1 ? "person" : "people"}.` });
      return;
    }

    const { data: profiles, error: profilesError } = await admin.from("profiles")
      .select("id, display_name, role, avatar_path, is_active, is_archived")
      .in("id", participantIds)
      .eq("company_id", user.companyId);
    if (profilesError) {
      sendCallError(response, profilesError, "Could not verify the colleagues selected for this call.");
      return;
    }
    if ((profiles ?? []).length !== participantIds.length || profiles?.some((profile) => !profile.is_active || profile.is_archived)) {
      response.status(400).json({ error: "One or more selected colleagues are no longer active in your company." });
      return;
    }

    const invitedAt = new Date().toISOString();
    const { error: invitationError } = await admin.from("call_room_participants")
      .insert(participantIds.map((userId: string) => ({
        room_id: callId,
        user_id: userId,
        status: "ringing",
        invited_at: invitedAt,
      })));
    if (invitationError) {
      if ("code" in invitationError && invitationError.code === "23505") {
        response.status(409).json({ error: "A selected colleague has already joined or been invited to this call." });
        return;
      }
      sendCallError(response, invitationError, "Could not add the selected colleagues to the call.");
      return;
    }

    await sendIncomingCallPush(admin, user.companyId, participantIds as string[], {
      callId,
      callerName: user.displayName ?? "Team member",
      mediaMode: room.media_mode === "video" ? "video" : "audio",
    }).catch((error: unknown) => console.error("Could not queue call notifications.", error));

    response.status(201).json({
      invited: (profiles ?? []).map((profile) => ({
        id: profile.id,
        name: profile.display_name ?? "Team member",
        role: profile.role,
        avatarPath: profile.avatar_path,
        status: "ringing" as const,
      })),
    });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not add colleagues to the call.");
  }
});

router.get("/invitations", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data: invitations, error } = await admin.from("call_room_participants")
      .select("room_id, invited_at")
      .eq("user_id", user.id)
      .eq("status", "ringing")
      .order("invited_at", { ascending: false })
      .limit(10);
    if (error) {
      sendCallError(response, error, "Could not load incoming calls.");
      return;
    }
    const roomIds = [...new Set((invitations ?? []).map((invite) => invite.room_id))];
    if (!roomIds.length) {
      response.status(200).json({ invitations: [] });
      return;
    }
    const { data: rooms, error: roomsError } = await admin.from("call_rooms")
      .select("id, created_by, company_id, media_mode, status")
      .in("id", roomIds)
      .eq("company_id", user.companyId)
      .in("status", ["ringing", "active"]);
    if (roomsError) {
      sendCallError(response, roomsError, "Could not load incoming call details.");
      return;
    }
    const roomById = new Map((rooms ?? []).map((room) => [room.id, room]));
    for (const invitation of invitations ?? []) {
      const room = roomById.get(invitation.room_id);
      if (room && Date.now() - Date.parse(invitation.invited_at) >= ringingLifetimeMs) {
        await expireCallInvitation(admin, room, user.id);
      }
    }
    const currentInvitations = (invitations ?? []).filter((invitation) =>
      Date.now() - Date.parse(invitation.invited_at) < ringingLifetimeMs);
    const activeRoomIds = [...new Set(currentInvitations.map((invitation) => invitation.room_id))];
    const activeRooms = (rooms ?? []).filter((room) => activeRoomIds.includes(room.id));
    const callerIds = [...new Set(activeRooms.map((room) => room.created_by))];
    const { data: callers, error: callersError } = callerIds.length
      ? await admin.from("profiles").select("id, display_name, role, avatar_path, department_id").in("id", callerIds)
      : { data: [], error: null };
    if (callersError) {
      sendCallError(response, callersError, "Could not load call initiator details.");
      return;
    }
    const departmentIds = [...new Set((callers ?? []).flatMap((caller) => caller.department_id ? [caller.department_id] : []))];
    const { data: departments, error: departmentsError } = departmentIds.length
      ? await admin.from("departments").select("id, name").in("id", departmentIds)
      : { data: [], error: null };
    if (departmentsError) {
      sendCallError(response, departmentsError, "Could not load caller department details.");
      return;
    }
    const departmentNames = new Map((departments ?? []).map((department) => [department.id, department.name]));
    const callerProfiles = new Map((callers ?? []).map((profile) => [profile.id, profile]));
    response.status(200).json({
      invitations: currentInvitations.flatMap((invitation) => {
        const room = roomById.get(invitation.room_id);
        const caller = room ? callerProfiles.get(room.created_by) : undefined;
        if (!room || !caller) return [];
        return [{
          id: room.id,
          callerName: caller.display_name?.trim() || "Caller",
          callerDepartment: caller.department_id ? departmentNames.get(caller.department_id) ?? "Department" : "Unassigned department",
          callerAvatarPath: caller.avatar_path,
          mediaMode: room.media_mode,
          createdAt: invitation.invited_at,
        }];
      }),
    });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not initialize incoming calls.");
  }
});

router.get("/:callId", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const callId = request.params.callId;
  if (!callId || !uuidPattern.test(callId)) {
    response.status(400).json({ error: "Choose a valid call." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: membership, error: membershipError } = await admin.from("call_room_participants")
      .select("status")
      .eq("room_id", callId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) {
      sendCallError(response, membershipError, "Could not verify call access.");
      return;
    }
    if (!membership) {
      response.status(403).json({ error: "You are not invited to this call." });
      return;
    }
    const { data: room, error: roomError } = await admin.from("call_rooms")
      .select("id, created_by, company_id, media_mode, status, created_at")
      .eq("id", callId)
      .eq("company_id", user.companyId)
      .maybeSingle();
    if (roomError) {
      sendCallError(response, roomError, "Could not load the call.");
      return;
    }
    if (!room || room.status === "ended" || (room.status === "ringing" && Date.now() - Date.parse(room.created_at) >= ringingLifetimeMs)) {
      if (room?.status === "ringing" && Date.now() - Date.parse(room.created_at) >= ringingLifetimeMs) {
        await expireCallInvitation(admin, room, user.id);
      }
      response.status(410).json({ error: "This call has ended or its invitation expired." });
      return;
    }
    if (membership.status === "left") {
      response.status(403).json({ error: "You are not invited to this call." });
      return;
    }
    const { data: memberships, error: membershipsError } = await admin.from("call_room_participants")
      .select("user_id, status")
      .eq("room_id", callId)
      .in("status", ["joined", "ringing"]);
    if (membershipsError) {
      sendCallError(response, membershipsError, "Could not load the call participants.");
      return;
    }
    const ids = [...new Set((memberships ?? []).map((item) => item.user_id))];
    const { data: profiles, error: profilesError } = await admin.from("profiles")
      .select("id, display_name, role, avatar_path")
      .in("id", ids)
      .eq("company_id", user.companyId);
    if (profilesError) {
      sendCallError(response, profilesError, "Could not load call participant profiles.");
      return;
    }
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    response.status(200).json({
      call: { id: room.id, mediaMode: room.media_mode, status: room.status, isCaller: room.created_by === user.id },
      user: { id: user.id, name: user.displayName ?? "Team member", role: user.role, avatarPath: user.avatarPath },
      participants: (memberships ?? []).flatMap((item) => {
        const profile = profileById.get(item.user_id);
        return profile ? [{
          id: profile.id,
          name: profile.display_name ?? "Team member",
          role: profile.role,
          avatarPath: profile.avatar_path,
          status: item.status,
        }] : [];
      }),
      ...await getIceServers(),
    });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not initialize the call room.");
  }
});

router.patch("/:callId/:action", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const { callId, action } = request.params;
  if (!callId || !uuidPattern.test(callId) || !["join", "decline", "leave", "end"].includes(action ?? "")) {
    response.status(400).json({ error: "Choose a valid call action." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: membership, error: membershipError } = await admin.from("call_room_participants")
      .select("status, invited_at")
      .eq("room_id", callId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) {
      sendCallError(response, membershipError, "Could not verify call participation.");
      return;
    }
    if (!membership || (membership.status === "left" && action !== "end")) {
      response.status(403).json({ error: "You are not invited to this call." });
      return;
    }
    const { data: room, error: roomError } = await admin.from("call_rooms")
      .select("id, created_by, status, created_at, media_mode")
      .eq("id", callId)
      .eq("company_id", user.companyId)
      .maybeSingle();
    if (roomError) {
      sendCallError(response, roomError, "Could not verify the call.");
      return;
    }
    if (!room) {
      response.status(404).json({ error: "This call could not be found." });
      return;
    }
    if (action === "end" || action === "leave") {
      const { data: activeParticipants, error: activeParticipantsError } = await admin.from("call_room_participants")
        .select("user_id")
        .eq("room_id", callId)
        .in("status", ["ringing", "joined"]);
      if (activeParticipantsError) {
        sendCallError(response, activeParticipantsError, "Could not check who is still in the call.");
        return;
      }
      if ((activeParticipants ?? []).length <= 2) {
        const endedAt = new Date().toISOString();
        const { error } = await admin.from("call_rooms")
          .update({ status: "ended", ended_at: endedAt })
          .eq("id", callId)
          .in("status", ["ringing", "active"]);
        if (error) {
          sendCallError(response, error, "Could not end the call.");
          return;
        }
        const { error: participantsError } = await admin.from("call_room_participants")
          .update({ status: "left", left_at: endedAt })
          .eq("room_id", callId)
          .in("status", ["ringing", "joined"]);
        if (participantsError) {
          sendCallError(response, participantsError, "Could not close the ended call's participants.");
          return;
        }
        try {
          await recordEndedCallHistory(admin, room, endedAt);
        } catch (historyError: unknown) {
          console.error("Could not record the ended call in chat history.", historyError);
        }
        response.status(200).json({ ok: true });
        return;
      }
    }
    if (action === "join" && membership.status === "ringing" && Date.now() - Date.parse(membership.invited_at) >= ringingLifetimeMs) {
      await expireCallInvitation(admin, {
        id: callId,
        created_by: room.created_by,
        company_id: user.companyId,
        media_mode: room.media_mode,
        status: room.status,
      }, user.id);
      response.status(410).json({ error: "This call invitation has expired." });
      return;
    }
    const status = action === "join" ? "joined" : "left";
    const participationUpdate = action === "join"
      ? { status, joined_at: new Date().toISOString(), left_at: null }
      : { status, left_at: new Date().toISOString() };
    const { data: updated, error: updateError } = await admin.from("call_room_participants")
      .update(participationUpdate)
      .eq("room_id", callId)
      .eq("user_id", user.id)
      .in("status", action === "join" ? ["ringing", "joined"] : ["ringing", "joined"])
      .select("room_id")
      .maybeSingle();
    if (updateError) {
      sendCallError(response, updateError, "Could not update call participation.");
      return;
    }
    if (!updated) {
      response.status(403).json({ error: "You are not invited to this call." });
      return;
    }
    if (action === "decline") {
      try {
        await recordCallHistory(admin, room, user.id, { type: "declined" });
      } catch (historyError: unknown) {
        console.error("Could not record the declined call in chat history.", historyError);
      }
    }
    if (action === "join") {
      const { error } = await admin.from("call_rooms").update({ status: "active" }).eq("id", callId).eq("status", "ringing");
      if (error) {
        sendCallError(response, error, "Could not activate the call.");
        return;
      }
    } else if (action === "decline" && room.status === "ringing") {
      const { data: remainingParticipants, error: invitationsError } = await admin.from("call_room_participants")
        .select("user_id")
        .eq("room_id", callId)
        .in("status", ["ringing", "joined"])
        .neq("user_id", room.created_by);
      if (invitationsError) {
        sendCallError(response, invitationsError, "Could not check remaining call invitations.");
        return;
      }
      if (!remainingParticipants?.length) {
        const endedAt = new Date().toISOString();
        const { error: endError } = await admin.from("call_rooms")
          .update({ status: "ended", ended_at: endedAt })
          .eq("id", callId)
          .eq("status", "ringing");
        if (endError) {
          sendCallError(response, endError, "Could not end the declined call.");
          return;
        }
        const { error: participantsError } = await admin.from("call_room_participants")
          .update({ status: "left", left_at: endedAt })
          .eq("room_id", callId)
          .in("status", ["ringing", "joined"]);
        if (participantsError) {
          sendCallError(response, participantsError, "Could not close participants in the declined call.");
          return;
        }
      }
    } else {
      const { data: activeMembers, error } = await admin.from("call_room_participants")
        .select("user_id")
        .eq("room_id", callId)
        .eq("status", "joined")
        .limit(1);
      if (error) {
        sendCallError(response, error, "Could not check remaining call participants.");
        return;
      }
      if (!activeMembers?.length) {
        const endedAt = new Date().toISOString();
        const { error: endError } = await admin.from("call_rooms")
          .update({ status: "ended", ended_at: endedAt })
          .eq("id", callId);
        if (endError) {
          sendCallError(response, endError, "Could not close the call after its final participant left.");
          return;
        }
        try {
          await recordEndedCallHistory(admin, room, endedAt);
        } catch (historyError: unknown) {
          console.error("Could not record the ended call in chat history.", historyError);
        }
      }
    }
    response.status(200).json({ ok: true });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not update the call.");
  }
});

export { router as callsRouter };
