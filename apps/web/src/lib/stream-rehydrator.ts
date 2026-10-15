import { PlaceholderTokenRegex } from "@aegis/shared";

/**
 * A single segment of a re-hydrated SSE stream. `text` segments are passed
 * through untouched; `entity` segments mark a `[CATEGORY_HEX4]` placeholder
 * token resolved against the caller's in-memory entity lookup map so the UI
 * can render the real value without the server ever having seen it.
 */
export interface StreamSegment {
  type: "text" | "entity";
  content: string;
  token?: string | undefined;
  originalValue?: string | undefined;
}

/** Maps a placeholder token (e.g. `[PER_89A1]`) to its decrypted real value. */
export type EntityLookupMap = ReadonlyMap<string, string>;

/**
 * Creates a `TransformStream` that re-hydrates an incoming text stream of
 * raw SSE token chunks into structured `StreamSegment`s, resolving any
 * `[CATEGORY_HEX4]` placeholder tokens against `entityLookupMap`.
 *
 * Placeholder tokens can be split arbitrarily across chunk boundaries (e.g.
 * `["Patient ", "[PER", "_89", "A1]", " is stable"]`), so unresolved text
 * ending in an open `[` with no matching `]` yet is held in an internal
 * lookahead buffer until either the token closes or the stream ends.
 */
export function createRehydrationTransformStream(
  entityLookupMap: EntityLookupMap,
): TransformStream<string, StreamSegment> {
  let buffer = "";

  function drain(
    controller: TransformStreamDefaultController<StreamSegment>,
    isFinal: boolean,
  ): void {
    let pendingText = "";

    for (;;) {
      const openIndex = buffer.indexOf("[");
      if (openIndex === -1) {
        pendingText += buffer;
        buffer = "";
        break;
      }

      pendingText += buffer.slice(0, openIndex);
      const fromBracket = buffer.slice(openIndex);
      const closeIndex = fromBracket.indexOf("]");

      if (closeIndex === -1) {
        if (isFinal) {
          // Stream ended mid-bracket: it was never a real token.
          pendingText += fromBracket;
          buffer = "";
        } else {
          // Not enough data yet to know if this is a token; hold it.
          buffer = fromBracket;
        }
        break;
      }

      const candidate = fromBracket.slice(0, closeIndex + 1);
      if (PlaceholderTokenRegex.test(candidate)) {
        if (pendingText.length > 0) {
          controller.enqueue({ type: "text", content: pendingText });
          pendingText = "";
        }
        controller.enqueue({
          type: "entity",
          content: candidate,
          token: candidate,
          originalValue: entityLookupMap.get(candidate),
        });
        buffer = fromBracket.slice(closeIndex + 1);
      } else {
        // The `[` doesn't start a valid token; treat it as a literal
        // character and keep scanning the remainder for the next one.
        pendingText += fromBracket[0];
        buffer = fromBracket.slice(1);
      }
    }

    if (pendingText.length > 0) {
      controller.enqueue({ type: "text", content: pendingText });
    }
  }

  return new TransformStream<string, StreamSegment>({
    transform(chunk, controller) {
      buffer += chunk;
      drain(controller, false);
    },
    flush(controller) {
      drain(controller, true);
    },
  });
}
