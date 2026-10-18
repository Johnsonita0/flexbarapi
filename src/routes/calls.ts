import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ringingLifetimeMs = 5 * 60_000;
const maxCallParticipants = 8;

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

function getIceServers() {
  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  const turnUrls = process.env.TURN_URLS?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return {
    iceServers,
    turnConfigured: turnUrls.length > 0 && Boolean(process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL),
  };
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
      .select("id");
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
        .select("id")
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
            const { error } = await admin.from("call_rooms")
              .update({ status: "ended", ended_at: leftAt })
              .eq("id", roomId)
              .eq("company_id", user.companyId)
              .in("status", ["active", "ringing"]);
            if (error) {
              sendCallError(response, error, "Could not end an empty call room.");
              return;
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

    const leftAt = new Date().toISOString();
    const { data: previousRooms, error: previousRoomsError } = await admin.from("call_rooms")
      .update({ status: "ended", ended_at: leftAt })
      .eq("company_id", user.companyId)
      .eq("created_by", user.id)
      .in("status", ["active", "ringing"])
      .select("id");
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
    }
    const ringingCutoff = new Date(Date.now() - ringingLifetimeMs).toISOString();
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
    const { error: participantsError } = await admin.from("call_room_participants").insert([
      { room_id: room.id, user_id: user.id, status: "joined", joined_at: new Date().toISOString() },
      ...participantIds.map((userId: string) => ({ room_id: room.id, user_id: userId, status: "ringing" })),
    ]);
    if (participantsError) {
      const { error: cleanupError } = await admin.from("call_rooms").delete().eq("id", room.id);
      if (cleanupError) console.error("Could not clean up a call room after invitation failure.", cleanupError);
      sendCallError(response, participantsError, "Could not invite call participants.");
      return;
    }
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
        .select("id, status, company_id")
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
      .select("id, created_by, media_mode, created_at, status")
      .in("id", roomIds)
      .eq("company_id", user.companyId)
      .in("status", ["ringing", "active"]);
    if (roomsError) {
      sendCallError(response, roomsError, "Could not load incoming call details.");
      return;
    }
    const callerIds = [...new Set((rooms ?? []).map((room) => room.created_by))];
    const { data: callers, error: callersError } = callerIds.length
      ? await admin.from("profiles").select("id, display_name").in("id", callerIds)
      : { data: [], error: null };
    if (callersError) {
      sendCallError(response, callersError, "Could not load call initiator details.");
      return;
    }
    const callerNames = new Map((callers ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    response.status(200).json({
      invitations: (rooms ?? [])
        .filter((room) => room.status === "active" || Date.now() - Date.parse(room.created_at) < ringingLifetimeMs)
        .map((room) => ({
          id: room.id,
          callerName: callerNames.get(room.created_by) ?? "Team member",
          mediaMode: room.media_mode,
          createdAt: room.created_at,
        })),
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
    if (!room || room.status === "ended" || (room.status === "ringing" && Date.now() - Date.parse(room.created_at) > ringingLifetimeMs)) {
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
      ...getIceServers(),
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
      .select("status")
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
      .select("id, created_by, status, created_at")
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
        response.status(200).json({ ok: true });
        return;
      }
    }
    if (action === "join" && room.status === "ringing" && Date.now() - Date.parse(room.created_at) > ringingLifetimeMs) {
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
        const { error: endError } = await admin.from("call_rooms")
          .update({ status: "ended", ended_at: new Date().toISOString() })
          .eq("id", callId);
        if (endError) {
          sendCallError(response, endError, "Could not close the call after its final participant left.");
          return;
        }
      }
    }
    response.status(200).json({ ok: true });
  } catch (error: unknown) {
    sendCallError(response, error, "Could not update the call.");
  }
});

export { router as callsRouter };
