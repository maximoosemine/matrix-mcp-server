import * as sdk from "matrix-js-sdk";
import { MatrixClient, EventType } from "matrix-js-sdk";
import fetch from "node-fetch";

/**
 * Represents a processed message that can be returned to MCP clients
 */
export type ProcessedMessage =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type Reaction = { sender: string; reaction: string };

/**
 * Scans all timeline events and builds a map of eventId -> reactions.
 * Must be called with the full event list before slicing for pagination.
 */
export function buildReactionsMap(events: sdk.MatrixEvent[]): Map<string, Reaction[]> {
  const map = new Map<string, Reaction[]>();

  for (const event of events) {
    if (event.getType() === "m.reaction") {
      const relatesTo = event.getContent()["m.relates_to"];
      if (relatesTo?.rel_type === "m.annotation" && relatesTo.event_id) {
        const list = map.get(relatesTo.event_id) ?? [];
        const sender = event.sender?.name || event.getSender() || "unknown";
        list.push({ sender, reaction: String(relatesTo.key || "") });
        map.set(relatesTo.event_id, list);
      }
    }
  }

  return map;
}

/**
 * Builds a map of eventId -> MatrixEvent for all room message events.
 * Used to resolve reply-to references.
 */
export function buildMessagesMap(events: sdk.MatrixEvent[]): Map<string, sdk.MatrixEvent> {
  const map = new Map<string, sdk.MatrixEvent>();

  for (const event of events) {
    if (event.getType() === EventType.RoomMessage) {
      const id = event.getId();
      if (id) map.set(id, event);
    }
  }

  return map;
}

/**
 * Strips the Matrix reply fallback quote from a message body.
 * Reply bodies prepend "> <sender> original line\n> ...\n\nActual reply"
 */
function stripReplyFallback(body: string): string {
  const parts = body.split("\n\n");
  if (parts.length > 1 && parts[0].startsWith("> ")) {
    return parts.slice(1).join("\n\n");
  }
  return body;
}

/**
 * Processes a Matrix event and extracts relevant content.
 * Returns an array of content items (text messages return one item;
 * image messages return a sender label followed by the image).
 */
export async function processMessage(
  event: sdk.MatrixEvent,
  matrixClient: MatrixClient | null,
  reactionsMap?: Map<string, Reaction[]>,
  messagesMap?: Map<string, sdk.MatrixEvent>
): Promise<ProcessedMessage[] | null> {
  if (!matrixClient) {
    throw new Error("Matrix client is not initialized.");
  }

  const content = event.getContent();

  if (event.getType() === EventType.RoomMessage && content) {
    const sender = event.sender?.name || event.getSender() || "unknown";
    const reactions = reactionsMap?.get(event.getId() ?? "") ?? [];

    // Resolve reply-to if present
    const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    let replyTo: { sender: string; message: string } | undefined;
    if (replyToEventId && messagesMap) {
      const replyToEvent = messagesMap.get(replyToEventId);
      if (replyToEvent) {
        const replyToContent = replyToEvent.getContent();
        replyTo = {
          sender: replyToEvent.sender?.name || replyToEvent.getSender() || "unknown",
          message: String(replyToContent.body || ""),
        };
      }
    }

    if (content.msgtype === "m.text") {
      // Strip the embedded fallback quote from reply bodies
      const messageBody = replyToEventId
        ? stripReplyFallback(String(content.body || ""))
        : String(content.body || "");

      const payload: Record<string, unknown> = { sender, message: messageBody, reactions };
      if (replyTo) payload.replyTo = replyTo;

      return [{ type: "text", text: JSON.stringify(payload) }];
    } else if (content.msgtype === "m.image" && content.url) {
      try {
        const httpUrl = String(matrixClient.mxcUrlToHttp(content.url) || "");
        const response = await fetch(httpUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString("base64");

        const payload: Record<string, unknown> = { sender, message: "[image]", reactions };
        if (replyTo) payload.replyTo = replyTo;

        return [
          { type: "text", text: JSON.stringify(payload) },
          {
            type: "image",
            data: base64Data,
            mimeType: String(content.info?.mimetype || "application/octet-stream"),
          },
        ];
      } catch (error: any) {
        console.error(`Failed to fetch image content: ${error.message}`);
        return null;
      }
    }
  }

  return null;
}

/**
 * Filters and processes messages within a date range
 */
export async function processMessagesByDate(
  events: sdk.MatrixEvent[],
  startDate: string,
  endDate: string,
  matrixClient: MatrixClient
): Promise<ProcessedMessage[]> {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();

  // Build lookup maps from all events before filtering
  const reactionsMap = buildReactionsMap(events);
  const messagesMap = buildMessagesMap(events);

  const filteredEvents = events.filter((event) => {
    const timestamp = event.getTs();
    return timestamp >= start && timestamp <= end;
  });

  const messageArrays = await Promise.all(
    filteredEvents.map((event) => processMessage(event, matrixClient, reactionsMap, messagesMap))
  );

  return messageArrays
    .filter((items): items is ProcessedMessage[] => items !== null)
    .flat();
}

/**
 * Counts messages by user in a room
 */
export function countMessagesByUser(
  events: sdk.MatrixEvent[],
  limit: number = 10
): Array<{ userId: string; count: number }> {
  const userMessageCounts: Record<string, number> = {};

  events
    .filter((event) => event.getType() === EventType.RoomMessage)
    .forEach((event) => {
      const sender = event.getSender();
      if (sender) {
        userMessageCounts[sender] = (userMessageCounts[sender] || 0) + 1;
      }
    });

  return Object.entries(userMessageCounts)
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, limit)
    .map(([userId, count]) => ({ userId, count }));
}
