import { describe, expect, it } from "bun:test";
import {
  ConversationsCursor,
  CursorError,
  MessagesCursor,
  decodeCursor,
  encodeCursor,
} from "../../src/lib/cursor";

const SAMPLE_UUID = "11111111-2222-4333-8444-555555555555";

describe("cursor encode/decode", () => {
  it("round-trips a MessagesCursor", () => {
    const original = { ts: "2026-05-28T12:34:56.000Z", id: SAMPLE_UUID };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor(encoded, MessagesCursor);
    expect(decoded).toEqual(original);
  });

  it("round-trips a ConversationsCursor", () => {
    const original = { ts: "2026-01-01T00:00:00.000Z", id: SAMPLE_UUID };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor(encoded, ConversationsCursor);
    expect(decoded).toEqual(original);
  });

  it("emits base64url (no +, /, or padding)", () => {
    const encoded = encodeCursor({ ts: "2026-05-28T12:34:56.000Z", id: SAMPLE_UUID });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("throws CURSOR_MALFORMED on non-base64url input", () => {
    expect(() => decodeCursor("!!!not base64!!!", MessagesCursor)).toThrow(CursorError);
    try {
      decodeCursor("@@@", MessagesCursor);
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).code).toBe("CURSOR_MALFORMED");
    }
  });

  it("throws CURSOR_MALFORMED on non-JSON payload", () => {
    const notJson = Buffer.from("hello world", "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    try {
      decodeCursor(notJson, MessagesCursor);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).code).toBe("CURSOR_MALFORMED");
    }
  });

  it("throws CURSOR_INVALID_SHAPE when fields don't match schema", () => {
    const wrongShape = encodeCursor({ ts: "not-a-date", id: "not-a-uuid" });
    try {
      decodeCursor(wrongShape, MessagesCursor);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).code).toBe("CURSOR_INVALID_SHAPE");
    }
  });
});
