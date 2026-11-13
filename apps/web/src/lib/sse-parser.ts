/**
 * Incremental Server-Sent Events parser for `fetch()` response bodies.
 *
 * `EventSource` only supports GET, and the chat endpoint is a POST, so the
 * stream is read by hand. This follows the WHATWG event-stream rules that
 * matter here: `\n`, `\r\n` and `\r` line endings (including a `\r\n` pair
 * split across two network chunks), `event:` / `data:` / `id:` fields, one
 * optional space after the colon, multi-line `data`, `:` comment lines, and
 * dispatch on a blank line. Unknown fields are ignored.
 */

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = "";
  private eventType = "";
  private dataLines: string[] = [];
  private lastEventId: string | null = null;

  /** Feeds one decoded chunk and returns every event it completed. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      // A lone trailing `\r` might be the first half of `\r\n`; wait for more.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;

      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.processLine(line);
      if (message !== null) messages.push(message);
    }

    return messages;
  }

  /**
   * Ends the stream. A trailing lone `\r` held back by `push` is a real line
   * ending once no `\n` can follow, so it is processed here (and may
   * complete one last event). Anything still unterminated after that is
   * discarded, as the spec requires.
   */
  end(): SseMessage[] {
    // `\r` + `\n` is one terminator, so this processes exactly that `\r`.
    const messages = this.buffer.endsWith("\r") ? this.push("\n") : [];
    this.buffer = "";
    this.eventType = "";
    this.dataLines = [];
    return messages;
  }

  private processLine(line: string): SseMessage | null {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventType = "";
        return null;
      }
      const message: SseMessage = {
        event: this.eventType === "" ? "message" : this.eventType,
        data: this.dataLines.join("\n"),
        id: this.lastEventId,
      };
      this.eventType = "";
      this.dataLines = [];
      return message;
    }

    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      default:
        break;
    }
    return null;
  }
}
