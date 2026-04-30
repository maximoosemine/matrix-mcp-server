import * as sdk from "matrix-js-sdk";
import { MatrixClient, EventType } from "matrix-js-sdk";
import fetch from "node-fetch";

/**
 * Represents a processed message that can be returned to MCP clients
 */
export type ProcessedMessage =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Processes a Matrix event and extracts relevant content.
 * Returns an array of content items (text messages return one item;
 * image messages return a sender label followed by the image).
 */
export async function processMessage(
  event: sdk.MatrixEvent,
  matrixClient: MatrixClient | null
): Promise<ProcessedMessage[] | null> {
  if (!matrixClient) {
    throw new Error("Matrix client is not initialized.");
  }

  const content = event.getContent();

  if (event.getType() === EventType.RoomMessage && content) {
    const sender = event.sender?.name || event.getSender() || "unknown";
    if (content.msgtype === "m.text") {
      return [
        {
          type: "text",
          text: JSON.stringify({ sender, message: String(content.body || "") }),
        },
      ];
    } else if (content.msgtype === "m.image" && content.url) {
      try {
        const httpUrl = String(matrixClient.mxcUrlToHttp(content.url) || "");
        const response = await fetch(httpUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString("base64");

        return [
          {
            type: "text",
            text: JSON.stringify({ sender, message: "[image]" }),
          },
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

  const filteredEvents = events.filter((event) => {
    const timestamp = event.getTs();
    return timestamp >= start && timestamp <= end;
  });

  const messageArrays = await Promise.all(
    filteredEvents.map((event) => processMessage(event, matrixClient))
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
